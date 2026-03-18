const { supabase } = require('../../../config/database');
const { derivePeriodForDate, isVatJournal, getVatAmountsFromLines } = require('./vatPeriodUtils');

/**
 * Journal Service
 * Handles double-entry bookkeeping logic
 */
class JournalService {
  /**
   * Validate that a journal balances (debits = credits)
   */
  static validateBalance(lines) {
    const totalDebits = lines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
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

    return {
      valid: true,
      totalDebits,
      totalCredits,
      difference: 0
    };
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

      const debit = parseFloat(line.debit || 0);
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
   * Create a draft journal
   */
  static async createDraftJournal({ companyId, date, reference, description, sourceType, createdByUserId, lines, metadata }) {
    // Validate lines
    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) {
      throw new Error(lineValidation.message);
    }

    // Validate balance
    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Check period lock
    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) {
      throw new Error('Cannot create journal in a locked period');
    }

    // Create journal header
    const { data: journal, error } = await supabase
      .from('journals')
      .insert({
        company_id: companyId,
        date,
        reference: reference || null,
        description,
        status: 'draft',
        source_type: sourceType || 'manual',
        created_by_user_id: createdByUserId || null,
        metadata: metadata || null
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Insert all lines at once
    const lineInserts = lines.map((line, i) => ({
      journal_id: journal.id,
      account_id: line.accountId,
      line_number: i + 1,
      description: line.description || null,
      debit: line.debit || 0,
      credit: line.credit || 0,
      segment_value_id: line.segmentValueId || null,
      metadata: line.metadata || null
    }));

    const { error: linesErr } = await supabase.from('journal_lines').insert(lineInserts);
    if (linesErr) throw new Error(linesErr.message);

    return journal;
  }

  /**
   * Update a draft journal's header and lines.
   * Only draft journals may be edited.
   */
  static async updateDraftJournal(journalId, companyId, { date, reference, description, lines, updatedByUserId }) {
    // Fetch and guard
    const { data: journal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', journalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !journal) {
      throw new Error('Journal not found');
    }

    if (journal.status !== 'draft') {
      throw new Error(`Cannot edit a journal with status: ${journal.status}. Only draft journals may be edited.`);
    }

    // Validate lines
    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) {
      throw new Error(lineValidation.message);
    }

    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Check period lock for the new date
    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) {
      throw new Error('Cannot move journal into a locked period');
    }

    // Update header
    const { error: updateErr } = await supabase
      .from('journals')
      .update({ date, reference: reference || null, description, updated_at: new Date().toISOString() })
      .eq('id', journalId);

    if (updateErr) throw new Error(updateErr.message);

    // Replace lines: delete all existing, re-insert
    const { error: deleteErr } = await supabase
      .from('journal_lines')
      .delete()
      .eq('journal_id', journalId);

    if (deleteErr) throw new Error(deleteErr.message);

    const lineInserts = lines.map((line, i) => ({
      journal_id: journalId,
      account_id: line.accountId,
      line_number: i + 1,
      description: line.description || null,
      debit: line.debit || 0,
      credit: line.credit || 0,
      segment_value_id: line.segmentValueId || null,
      metadata: line.metadata ? line.metadata : null
    }));

    const { error: insertErr } = await supabase.from('journal_lines').insert(lineInserts);
    if (insertErr) throw new Error(insertErr.message);

    return { ...journal, date, reference: reference || null, description };
  }

  /**
   * Post a journal (make it permanent in the ledger)
   */
  static async postJournal(journalId, companyId, postedByUserId) {
    // Get journal
    const { data: journal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', journalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !journal) {
      throw new Error('Journal not found');
    }

    if (journal.status !== 'draft') {
      throw new Error(`Cannot post journal with status: ${journal.status}`);
    }

    // Check period lock
    const isLocked = await this.isPeriodLocked(companyId, journal.date);
    if (isLocked) {
      throw new Error('Cannot post journal in a locked period');
    }

    // Get journal lines
    const { data: lines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*')
      .eq('journal_id', journalId)
      .order('line_number');

    if (linesErr) throw new Error(linesErr.message);

    // Validate balance
    const balanceValidation = this.validateBalance(lines || []);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Update journal status
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

    const filingFrequency = company.vat_period  || 'bi-monthly';
    const vatCycleType    = company.vat_cycle_type || 'even';

    // Derive the period this journal date belongs to
    const derivedPeriod = derivePeriodForDate(journalDate, filingFrequency, vatCycleType);

    // Find or create the vat_period record
    let vatPeriod = await this._findOrCreateVatPeriod(companyId, derivedPeriod, filingFrequency, vatCycleType);

    let targetPeriodId      = vatPeriod.id;
    let isOutOfPeriod       = false;
    let originalDate        = null;

    if ((vatPeriod.status || '').toUpperCase() === 'LOCKED') {
      // Out-of-period: journal belongs to a locked period; bring into current open period
      isOutOfPeriod = true;
      originalDate  = journalDate;

      const today = new Date().toISOString().split('T')[0];
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
      vat_period_id:             targetPeriodId,
      is_out_of_period:          isOutOfPeriod,
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
   * Reverse a posted journal
   */
  static async reverseJournal(originalJournalId, companyId, reversedByUserId, reason) {
    // Get original journal
    const { data: originalJournal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', originalJournalId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !originalJournal) {
      throw new Error('Journal not found');
    }

    if (originalJournal.status !== 'posted') {
      throw new Error('Can only reverse posted journals');
    }

    if (originalJournal.reversed_by_journal_id) {
      throw new Error('Journal has already been reversed');
    }

    // Check period lock for reversal date (today)
    const today = new Date().toISOString().split('T')[0];
    const isLocked = await this.isPeriodLocked(companyId, today);
    if (isLocked) {
      throw new Error('Cannot create reversal journal in a locked period');
    }

    // Get original journal lines
    const { data: originalLines, error: linesErr } = await supabase
      .from('journal_lines')
      .select('*')
      .eq('journal_id', originalJournalId)
      .order('line_number');

    if (linesErr) throw new Error(linesErr.message);

    // Create reversal journal
    const { data: reversalJournal, error: reversalErr } = await supabase
      .from('journals')
      .insert({
        company_id: companyId,
        date: today,
        reference: `REV-${originalJournal.reference || originalJournal.id}`,
        description: `Reversal of: ${originalJournal.description}. Reason: ${reason}`,
        status: 'posted',
        source_type: originalJournal.source_type,
        created_by_user_id: reversedByUserId,
        posted_by_user_id: reversedByUserId,
        posted_at: new Date().toISOString(),
        reversal_of_journal_id: originalJournalId,
        metadata: { reversalReason: reason }
      })
      .select()
      .single();

    if (reversalErr) throw new Error(reversalErr.message);

    // Create reversed lines (swap debits and credits)
    const reversedLineInserts = (originalLines || []).map((originalLine, i) => ({
      journal_id: reversalJournal.id,
      account_id: originalLine.account_id,
      line_number: i + 1,
      description: `Reversal: ${originalLine.description || ''}`,
      debit: originalLine.credit,  // Swap
      credit: originalLine.debit   // Swap
    }));

    const { error: revLinesErr } = await supabase.from('journal_lines').insert(reversedLineInserts);
    if (revLinesErr) throw new Error(revLinesErr.message);

    // Mark original journal as reversed
    const { error: markErr } = await supabase
      .from('journals')
      .update({ status: 'reversed', reversed_by_journal_id: reversalJournal.id })
      .eq('id', originalJournalId);

    if (markErr) throw new Error(markErr.message);

    return reversalJournal;
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
      account_code: l.accounts?.code,
      account_name: l.accounts?.name,
      account_type: l.accounts?.type,
      segment_value_name: l.coa_segment_values?.name
    }));

    return journal;
  }
}

module.exports = JournalService;
