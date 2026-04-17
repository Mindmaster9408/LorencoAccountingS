const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — used for atomic write transactions
const { derivePeriodForDate, isVatJournal, getVatAmountsFromLines } = require('./vatPeriodUtils');

/**
 * Journal Service
 * Handles double-entry bookkeeping logic
 *
 * ATOMICITY NOTE (2026-04-17):
 * All multi-step write operations (create, update-draft, reverse) now run
 * inside a PostgreSQL BEGIN/COMMIT/ROLLBACK transaction via the direct pg Pool
 * (accounting/config/database.js).  The Supabase JS client is retained for
 * read queries and the fire-and-forget VAT assignment; it cannot provide true
 * multi-statement transactions.
 *
 * This guarantees:
 *   - A journal header can NEVER exist without its matching lines.
 *   - A failed line insert rolls back the header insert in the same operation.
 *   - updateDraftJournal line-replacement (delete + re-insert) is atomic.
 *   - reverseJournal (new header + new lines + mark-original) is atomic.
 */

// ── Shared helper: insert journal lines inside an already-open pg client ──────
// Called from createDraftJournal and reverseJournal to avoid duplication.
// The caller is responsible for BEGIN/COMMIT/ROLLBACK.
async function _insertLinesOnClient(client, journalId, lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    await client.query(
      `INSERT INTO journal_lines
         (journal_id, account_id, line_number, description, debit, credit, segment_value_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        journalId,
        line.accountId || line.account_id,   // support both camelCase (service) and snake_case (reversal copy)
        i + 1,
        line.description || null,
        line.debit  || 0,
        line.credit || 0,
        line.segmentValueId || line.segment_value_id || null,
        line.metadata != null ? line.metadata : null,
      ]
    );
  }
}

class JournalService {
  /**
   * Validate that a journal balances (debits = credits)
   */
  static validateBalance(lines) {
    const totalDebits  = lines.reduce((sum, line) => sum + parseFloat(line.debit  || 0), 0);
    const totalCredits = lines.reduce((sum, line) => sum + parseFloat(line.credit || 0), 0);

    const difference = Math.abs(totalDebits - totalCredits);

    // Allow for rounding errors (0.01)
    if (difference > 0.01) {
      return {
        valid: false,
        totalDebits,
        totalCredits,
        difference,
        message: `Journal out of balance: Debits (${totalDebits.toFixed(2)}) != Credits (${totalCredits.toFixed(2)})`
      };
    }

    return { valid: true, totalDebits, totalCredits, difference: 0 };
  }

  /**
   * Validate journal lines
   */
  static validateLines(lines) {
    if (!lines || lines.length === 0) {
      return { valid: false, message: 'Journal must have at least one line' };
    }

    if (lines.length < 2) {
      return { valid: false, message: 'Journal must have at least two lines (double-entry)' };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line.accountId) {
        return { valid: false, message: `Line ${i + 1}: Account is required` };
      }

      const debit  = parseFloat(line.debit  || 0);
      const credit = parseFloat(line.credit || 0);

      if (debit < 0 || credit < 0) {
        return { valid: false, message: `Line ${i + 1}: Debit and credit must be non-negative` };
      }

      if (debit > 0 && credit > 0) {
        return { valid: false, message: `Line ${i + 1}: Cannot have both debit and credit` };
      }

      if (debit === 0 && credit === 0) {
        return { valid: false, message: `Line ${i + 1}: Must have either debit or credit` };
      }
    }

    return { valid: true };
  }

  /**
   * Check if a journal's VAT period is locked.
   * Used by routes that need to block VAT-affecting edits.
   *
   * @param {number|null} journalId
   * @returns {{ locked: boolean, periodKey: string|null }}
   */
  static async isVatPeriodLocked(journalId) {
    if (!journalId) return { locked: false, periodKey: null };

    const { data: journal } = await supabase
      .from('journals')
      .select('vat_period_id')
      .eq('id', journalId)
      .maybeSingle();

    if (!journal || !journal.vat_period_id) return { locked: false, periodKey: null };

    const { data: period } = await supabase
      .from('vat_periods')
      .select('id, period_key, status')
      .eq('id', journal.vat_period_id)
      .maybeSingle();

    if (!period) return { locked: false, periodKey: null };

    const locked = (period.status || '').toUpperCase() === 'LOCKED';
    return { locked, periodKey: period.period_key };
  }

  /**
   * Check if period is locked (accounting_periods — existing general lock)
   */
  static async isPeriodLocked(companyId, date) {
    const { data } = await supabase
      .from('accounting_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('from_date', date)
      .gte('to_date', date)
      .eq('is_locked', true)
      .limit(1);

    return data && data.length > 0;
  }

  /**
   * Create a draft journal — ATOMIC
   *
   * Uses a direct pg transaction to guarantee that either BOTH the journal
   * header and all its lines are written, or NEITHER is.  A crash or DB error
   * after the header insert but before the lines insert will be fully rolled
   * back — no orphaned journal headers can reach the database.
   */
  static async createDraftJournal({ companyId, date, reference, description, sourceType, createdByUserId, lines, metadata }) {
    // ── Validation (read-only — runs before the transaction) ──────────────────
    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) throw new Error(lineValidation.message);

    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) throw new Error(balanceValidation.message);

    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) throw new Error('Cannot create journal in a locked period');

    // ── Atomic write: header + lines inside one pg transaction ────────────────
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const headerResult = await client.query(
        `INSERT INTO journals
           (company_id, date, reference, description, status, source_type, created_by_user_id, metadata)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
         RETURNING *`,
        [
          companyId,
          date,
          reference || null,
          description,
          sourceType || 'manual',
          createdByUserId || null,
          metadata != null ? metadata : null,
        ]
      );

      const journal = headerResult.rows[0];

      // _insertLinesOnClient inserts every line; any failure throws and is caught below
      await _insertLinesOnClient(client, journal.id, lines);

      await client.query('COMMIT');
      return journal;

    } catch (err) {
      await client.query('ROLLBACK');
      // Re-throw with enough context for the caller to surface a meaningful error
      throw new Error(`Journal creation rolled back: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Update a draft journal's header and lines — ATOMIC
   *
   * The replace-lines operation (delete existing + insert new) runs in a single
   * pg transaction.  If the insert fails the delete is rolled back, so the
   * journal always retains a complete, consistent set of lines.
   * Only draft journals may be edited.
   */
  static async updateDraftJournal(journalId, companyId, { date, reference, description, lines, updatedByUserId }) { // eslint-disable-line no-unused-vars
    // ── Read + guard (supabase client — outside the transaction) ─────────────
    const { data: journal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', journalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !journal) throw new Error('Journal not found');

    if (journal.status !== 'draft') {
      throw new Error(`Cannot edit a journal with status: ${journal.status}. Only draft journals may be edited.`);
    }

    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) throw new Error(lineValidation.message);

    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) throw new Error(balanceValidation.message);

    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) throw new Error('Cannot move journal into a locked period');

    // ── Atomic write: header update + lines delete + lines re-insert ──────────
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Update header — include company_id in the WHERE clause for tenant safety
      await client.query(
        `UPDATE journals
            SET date=$1, reference=$2, description=$3, updated_at=NOW()
          WHERE id=$4 AND company_id=$5`,
        [date, reference || null, description, journalId, companyId]
      );

      // Delete all existing lines
      await client.query('DELETE FROM journal_lines WHERE journal_id=$1', [journalId]);

      // Re-insert all lines
      await _insertLinesOnClient(client, journalId, lines);

      await client.query('COMMIT');

    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Journal update rolled back: ${err.message}`);
    } finally {
      client.release();
    }

    // Return the merged object (route calls getJournalWithLines for the full record)
    return { ...journal, date, reference: reference || null, description };
  }

  /**
   * Post a journal (make it permanent in the ledger)
   *
   * VAT ASSIGNMENT — C4 FIX (2026-04-17):
   * VAT period is now resolved BEFORE the status update. If VAT resolution
   * fails for any reason the journal remains draft and the caller receives a
   * clear error. Once resolution succeeds, status + all VAT fields are written
   * in a SINGLE UPDATE — one SQL statement, no timing window between posting
   * and VAT assignment.
   *
   * Non-VAT journals (no VAT account lines, or company not VAT registered)
   * continue to post without any VAT assignment — that is intentional and
   * correct.
   */
  static async postJournal(journalId, companyId, postedByUserId) {
    // Get journal
    const { data: journal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', journalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !journal) throw new Error('Journal not found');

    if (journal.status !== 'draft') {
      throw new Error(`Cannot post journal with status: ${journal.status}`);
    }

    // Check period lock
    const isLocked = await this.isPeriodLocked(companyId, journal.date);
    if (isLocked) throw new Error('Cannot post journal in a locked period');

    // Fetch lines WITH account detail — used for both balance validation and VAT detection.
    // Combining into one query avoids a second DB round-trip inside _resolveVatPeriodForPost.
    const { data: lines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*, accounts!account_id(code, name, reporting_group)')
      .eq('journal_id', journalId)
      .order('line_number');

    if (linesErr) throw new Error(linesErr.message);

    // Validate balance (account detail fields are ignored by validateBalance)
    const balanceValidation = this.validateBalance(lines || []);
    if (!balanceValidation.valid) throw new Error(balanceValidation.message);

    // ── VAT period resolution — synchronous, fail-safe ───────────────────────
    // Runs BEFORE any status change. If this throws, the journal stays draft.
    // Returns null for non-VAT journals; returns { vatPeriodId, isOutOfPeriod,
    // originalDate } for VAT-relevant journals.
    const vatAssignment = await this._resolveVatPeriodForPost(
      companyId, journal.date, lines || []
    );

    // ── Single UPDATE: post status + VAT fields in one statement ─────────────
    // No timing window — VAT assignment cannot be missing from a posted journal.
    const updatePayload = {
      status:           'posted',
      posted_at:        new Date().toISOString(),
      posted_by_user_id: postedByUserId,
    };

    if (vatAssignment !== null) {
      updatePayload.vat_period_id               = vatAssignment.vatPeriodId;
      updatePayload.is_out_of_period            = vatAssignment.isOutOfPeriod;
      updatePayload.out_of_period_original_date = vatAssignment.originalDate;
    }

    const { error: updateErr } = await supabase
      .from('journals')
      .update(updatePayload)
      .eq('id', journalId);

    if (updateErr) throw new Error(updateErr.message);

    return { ...journal, ...updatePayload };
  }

  /**
   * Resolve the VAT period for a journal that is about to be posted.
   *
   * Called synchronously inside postJournal BEFORE the status update.
   * Throws on any failure — the caller must not catch and ignore.
   *
   * Returns null  → journal has no VAT lines, or company is not VAT-registered.
   *                  Posting proceeds without any vat_period_id.
   * Returns object → { vatPeriodId, isOutOfPeriod, originalDate }
   *                  These fields are included in the posting UPDATE.
   *
   * Out-of-period logic (unchanged from original assignVatPeriod):
   *   If the derived period is LOCKED, the journal is routed to the current
   *   open period with is_out_of_period=true and OOP counters incremented.
   *
   * @param {string|number} companyId
   * @param {string}        journalDate   YYYY-MM-DD
   * @param {Array}         lines         Journal lines WITH accounts join (from postJournal query)
   * @returns {Promise<null | { vatPeriodId, isOutOfPeriod: boolean, originalDate: string|null }>}
   */
  static async _resolveVatPeriodForPost(companyId, journalDate, lines) {
    // Flatten account join for the utility functions
    const flatLines = lines.map(l => ({
      ...l,
      account_code:            l.accounts?.code,
      account_reporting_group: l.accounts?.reporting_group,
    }));

    if (!isVatJournal(flatLines)) return null; // No VAT account lines — not VAT-relevant

    // Load company VAT settings — error out explicitly rather than defaulting silently
    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .select('vat_period, vat_cycle_type, is_vat_registered')
      .eq('id', companyId)
      .single();

    if (companyErr) {
      throw new Error(`VAT period assignment failed: could not load company settings (${companyErr.message})`);
    }
    if (!company) {
      throw new Error('VAT period assignment failed: company record not found');
    }
    if (!company.is_vat_registered) return null; // Not VAT-registered — skip

    const filingFrequency = company.vat_period    || 'bi-monthly';
    const vatCycleType    = company.vat_cycle_type || 'even';

    // Derive the correct period using the existing pure-function utilities (unchanged)
    const derivedPeriod = derivePeriodForDate(journalDate, filingFrequency, vatCycleType);

    // Find or create the vat_period row
    const vatPeriod = await this._findOrCreateVatPeriod(
      companyId, derivedPeriod, filingFrequency, vatCycleType
    );

    let vatPeriodId  = vatPeriod.id;
    let isOutOfPeriod = false;
    let originalDate  = null;

    if ((vatPeriod.status || '').toUpperCase() === 'LOCKED') {
      // Out-of-period: derived period is locked — route to current open period
      isOutOfPeriod = true;
      originalDate  = journalDate;

      const today          = new Date().toISOString().split('T')[0];
      const currentDerived = derivePeriodForDate(today, filingFrequency, vatCycleType);
      const currentPeriod  = await this._findOrCreateVatPeriod(
        companyId, currentDerived, filingFrequency, vatCycleType
      );
      vatPeriodId = currentPeriod.id;

      // Increment OOP counters on the current (target) period
      const { inputVat, outputVat } = getVatAmountsFromLines(flatLines);
      const { error: oopErr } = await supabase
        .from('vat_periods')
        .update({
          out_of_period_count:        (currentPeriod.out_of_period_count        || 0) + 1,
          out_of_period_total_input:  parseFloat(currentPeriod.out_of_period_total_input  || 0) + inputVat,
          out_of_period_total_output: parseFloat(currentPeriod.out_of_period_total_output || 0) + outputVat,
          updated_at: new Date().toISOString(),
        })
        .eq('id', vatPeriodId);

      if (oopErr) {
        throw new Error(`VAT period assignment failed: could not update out-of-period counters (${oopErr.message})`);
      }
    }

    return { vatPeriodId, isOutOfPeriod, originalDate };
  }

  /**
   * Assign the correct VAT period to an already-posted journal.
   *
   * NOTE: Under the normal post flow this is no longer called — postJournal
   * uses _resolveVatPeriodForPost directly so that VAT assignment happens
   * before the status update.
   *
   * This method is retained for manual re-assignment use cases (e.g. fixing
   * journals that were posted before the C4 fix was deployed, or admin
   * correction tooling).  Do not call it fire-and-forget.
   *
   * Rules: same as _resolveVatPeriodForPost — see that method for details.
   */
  static async assignVatPeriod(journalId, companyId, journalDate) {
    // Fetch lines with account detail (same enriched query as postJournal uses)
    const { data: lines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*, accounts!account_id(code, name, reporting_group)')
      .eq('journal_id', journalId);

    if (linesErr) throw new Error(linesErr.message);
    if (!lines || lines.length === 0) return; // No lines — nothing to assign

    // Delegate to the canonical resolution logic
    const result = await this._resolveVatPeriodForPost(companyId, journalDate, lines);
    if (result === null) return; // Not VAT-relevant

    // Write assignment back to the journal
    const { error: updateErr } = await supabase
      .from('journals')
      .update({
        vat_period_id:               result.vatPeriodId,
        is_out_of_period:            result.isOutOfPeriod,
        out_of_period_original_date: result.originalDate,
      })
      .eq('id', journalId);

    if (updateErr) throw new Error(updateErr.message);
  }

  /** Find an existing vat_period by key; create if missing (status = 'open'). */
  static async _findOrCreateVatPeriod(companyId, { periodKey, fromDate, toDate }, filingFrequency, vatCycleType) {
    const { data: existing } = await supabase
      .from('vat_periods')
      .select('*')
      .eq('company_id', companyId)
      .eq('period_key', periodKey)
      .single();

    if (existing) return existing;

    const { data: created, error } = await supabase
      .from('vat_periods')
      .insert({
        company_id:       companyId,
        period_key:       periodKey,
        from_date:        fromDate,
        to_date:          toDate,
        filing_frequency: filingFrequency,
        vat_cycle_type:   vatCycleType,
        status:           'open',
        out_of_period_count:        0,
        out_of_period_total_input:  0,
        out_of_period_total_output: 0,
      })
      .select()
      .single();

    if (error) throw new Error(`_findOrCreateVatPeriod: ${error.message}`);
    return created;
  }

  /**
   * Reverse a posted journal — ATOMIC
   *
   * The three writes (insert reversal header, insert reversal lines, mark
   * original as reversed) run in a single pg transaction.  A failure at any
   * point rolls back all three — no orphaned reversal headers, no original
   * journal incorrectly marked as reversed.
   */
  static async reverseJournal(originalJournalId, companyId, reversedByUserId, reason) {
    // ── Read + guard (supabase client — outside the transaction) ─────────────
    const { data: originalJournal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', originalJournalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !originalJournal) throw new Error('Journal not found');

    if (originalJournal.status !== 'posted') {
      throw new Error('Can only reverse posted journals');
    }

    if (originalJournal.reversed_by_journal_id) {
      throw new Error('Journal has already been reversed');
    }

    // Check period lock for reversal date (today)
    const today = new Date().toISOString().split('T')[0];
    const isLocked = await this.isPeriodLocked(companyId, today);
    if (isLocked) throw new Error('Cannot create reversal journal in a locked period');

    // Get original journal lines (read before transaction)
    const { data: originalLines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*')
      .eq('journal_id', originalJournalId)
      .order('line_number');

    if (linesErr) throw new Error(linesErr.message);

    // ── Atomic write: reversal header + reversal lines + mark original ────────
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Insert reversal journal header
      const reversalResult = await client.query(
        `INSERT INTO journals
           (company_id, date, reference, description, status, source_type,
            created_by_user_id, posted_by_user_id, posted_at,
            reversal_of_journal_id, metadata)
         VALUES ($1, $2, $3, $4, 'posted', $5, $6, $6, NOW(), $7, $8)
         RETURNING *`,
        [
          companyId,
          today,
          `REV-${originalJournal.reference || originalJournal.id}`,
          `Reversal of: ${originalJournal.description}. Reason: ${reason}`,
          originalJournal.source_type,
          reversedByUserId,
          originalJournalId,
          { reversalReason: reason },
        ]
      );
      const reversalJournal = reversalResult.rows[0];

      // Insert reversed lines — debit/credit swapped
      // Build lines array in the shape _insertLinesOnClient expects
      const reversedLines = (originalLines || []).map(l => ({
        accountId:      l.account_id,
        description:    `Reversal: ${l.description || ''}`,
        debit:          l.credit,   // swap
        credit:         l.debit,    // swap
        segmentValueId: l.segment_value_id || null,
        metadata:       null,
      }));

      await _insertLinesOnClient(client, reversalJournal.id, reversedLines);

      // Mark original journal as reversed — include company_id for tenant safety
      await client.query(
        `UPDATE journals
            SET status='reversed', reversed_by_journal_id=$1
          WHERE id=$2 AND company_id=$3`,
        [reversalJournal.id, originalJournalId, companyId]
      );

      await client.query('COMMIT');
      return reversalJournal;

    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Journal reversal rolled back: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get journal with lines
   */
  static async getJournalWithLines(journalId, companyId) {
    const { data: journal } = await supabase
      .from('journals')
      .select('*')
      .eq('id', journalId)
      .eq('company_id', companyId)
      .single();

    if (!journal) return null;

    const { data: lines } = await supabase
      .from('journal_lines')
      .select('*, accounts!account_id(code, name, type), coa_segment_values!segment_value_id(name)')
      .eq('journal_id', journalId)
      .order('line_number');

    // Flatten nested objects to match expected shape
    journal.lines = (lines || []).map(l => ({
      ...l,
      account_code:       l.accounts?.code,
      account_name:       l.accounts?.name,
      account_type:       l.accounts?.type,
      segment_value_name: l.coa_segment_values?.name
    }));

    return journal;
  }
}

module.exports = JournalService;
