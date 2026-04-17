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
   * postJournal is a single UPDATE — already atomic by itself.  VAT period
   * assignment remains fire-and-forget (C4 — separate audit item).
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

    // Get journal lines
    const { data: lines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*')
      .eq('journal_id', journalId)
      .order('line_number');

    if (linesErr) throw new Error(linesErr.message);

    // Validate balance
    const balanceValidation = this.validateBalance(lines || []);
    if (!balanceValidation.valid) throw new Error(balanceValidation.message);

    // Update journal status (single UPDATE — atomic)
    const { error: updateErr } = await supabase
      .from('journals')
      .update({
        status: 'posted',
        posted_at: new Date().toISOString(),
        posted_by_user_id: postedByUserId
      })
      .eq('id', journalId);

    if (updateErr) throw new Error(updateErr.message);

    // Assign VAT period asynchronously — non-blocking; failure is logged, not thrown
    // NOTE: This remains fire-and-forget pending C4 fix. Do not change scope here.
    this.assignVatPeriod(journalId, companyId, journal.date).catch(err => {
      console.error(`[JournalService] assignVatPeriod failed for journal ${journalId}:`, err.message);
    });

    return journal;
  }

  /**
   * Assign the correct VAT period to a newly posted journal.
   *
   * Rules:
   * 1. If the journal has no VAT lines → skip (not VAT-relevant).
   * 2. Derive the period for the journal's date using company VAT settings.
   * 3. Find or create the vat_period record for that period.
   * 4. If the period is LOCKED → this is an out-of-period item:
   *      - Find the current open period (create if none exists)
   *      - Assign the journal to the CURRENT period
   *      - Set is_out_of_period = true, out_of_period_original_date = journal.date
   *      - Update current period's OOP counters
   * 5. If the period is open → assign normally, is_out_of_period = false.
   */
  static async assignVatPeriod(journalId, companyId, journalDate) {
    // Fetch journal lines with account detail to detect VAT lines
    const { data: lines } = await supabase
      .from('journal_lines')
      .select('*, accounts!account_id(code, name, reporting_group)')
      .eq('journal_id', journalId);

    if (!lines || lines.length === 0) return;

    // Flatten for isVatJournal / getVatAmountsFromLines
    const flatLines = lines.map(l => ({
      ...l,
      account_code:            l.accounts?.code,
      account_reporting_group: l.accounts?.reporting_group,
    }));

    if (!isVatJournal(flatLines)) return; // No VAT lines — skip

    // Get company VAT settings
    const { data: company } = await supabase
      .from('companies')
      .select('vat_period, vat_cycle_type, is_vat_registered')
      .eq('id', companyId)
      .single();

    if (!company || !company.is_vat_registered) return; // Not VAT registered — skip

    const filingFrequency = company.vat_period   || 'bi-monthly';
    const vatCycleType    = company.vat_cycle_type || 'even';

    // Derive the period this journal date belongs to
    const derivedPeriod = derivePeriodForDate(journalDate, filingFrequency, vatCycleType);

    // Find or create the vat_period record
    let vatPeriod = await this._findOrCreateVatPeriod(companyId, derivedPeriod, filingFrequency, vatCycleType);

    let targetPeriodId = vatPeriod.id;
    let isOutOfPeriod  = false;
    let originalDate   = null;

    if ((vatPeriod.status || '').toUpperCase() === 'LOCKED') {
      // Out-of-period: journal belongs to a locked period; bring into current open period
      isOutOfPeriod = true;
      originalDate  = journalDate;

      const today          = new Date().toISOString().split('T')[0];
      const currentDerived = derivePeriodForDate(today, filingFrequency, vatCycleType);
      const currentPeriod  = await this._findOrCreateVatPeriod(companyId, currentDerived, filingFrequency, vatCycleType);
      targetPeriodId = currentPeriod.id;

      // Update OOP counters on the current period
      const { inputVat, outputVat } = getVatAmountsFromLines(flatLines);
      await supabase.from('vat_periods').update({
        out_of_period_count:        (currentPeriod.out_of_period_count  || 0) + 1,
        out_of_period_total_input:  parseFloat(currentPeriod.out_of_period_total_input  || 0) + inputVat,
        out_of_period_total_output: parseFloat(currentPeriod.out_of_period_total_output || 0) + outputVat,
        updated_at: new Date().toISOString(),
      }).eq('id', targetPeriodId);
    }

    // Write VAT period assignment back to the journal
    await supabase.from('journals').update({
      vat_period_id:               targetPeriodId,
      is_out_of_period:            isOutOfPeriod,
      out_of_period_original_date: originalDate,
    }).eq('id', journalId);
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
