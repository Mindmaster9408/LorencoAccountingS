'use strict';

/**
 * Opening Balance Service
 * ============================================================================
 * Handles the full lifecycle of opening balance / prior-year trial balance
 * imports:
 *
 *   draft → validated → finalized → archived
 *
 * CRITICAL RULES (non-negotiable):
 *   1. NO auto-reconciliation. If debits ≠ credits, block finalization.
 *   2. NO suspense posting. A TB that does not balance cannot be finalized.
 *   3. NO sign flipping. Amounts are stored exactly as entered (debit/credit).
 *   4. Finalized batch is immutable. No edits after status = 'finalized'.
 *   5. All queries and mutations are scoped to companyId server-side.
 *   6. Finalization creates exactly ONE posted journal (via JournalService).
 *   7. Postable-account check enforced on every account mapping.
 *   8. Period lock check enforced before finalization.
 *
 * JOURNAL CONVENTION (mirrors journalService.js):
 *   - Table: journals (SERIAL INTEGER id)
 *   - Lines: journal_lines with separate debit / credit DECIMAL(14,2) columns
 *   - Create via JournalService.createDraftJournal → JournalService.postJournal
 *   - source_type = 'opening' (matches journal_entries type check 'opening')
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const JournalService = require('./journalService');

class OpeningBalancesService {

  // ── Internal: write an audit log entry ───────────────────────────────────
  static async _writeAuditLog({ companyId, batchId, lineId = null, action, oldValue = null, newValue = null, performedBy }) {
    const { error } = await supabase
      .from('opening_balance_audit_log')
      .insert({
        company_id:   companyId,
        batch_id:     batchId,
        line_id:      lineId,
        action,
        old_value:    oldValue,
        new_value:    newValue,
        performed_by: performedBy,
        performed_at: new Date().toISOString(),
      });
    if (error) {
      // Audit log failure must not block the main operation; log to console only.
      console.error('[OpeningBalances] audit log write failed:', error.message);
    }
  }

  // ── Internal: recalculate and persist batch totals ────────────────────────
  // Called after any line create / update / delete to keep debit_total,
  // credit_total, and variance accurate in the batch header.
  static async _refreshBatchTotals(batchId, companyId) {
    const { data: lines, error } = await supabase
      .from('opening_balance_lines')
      .select('debit, credit, line_status')
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .neq('line_status', 'excluded');   // excluded lines do not count toward totals

    if (error) throw new Error(`Failed to recalculate batch totals: ${error.message}`);

    const debitTotal  = (lines || []).reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
    const creditTotal = (lines || []).reduce((s, l) => s + parseFloat(l.credit || 0), 0);
    const variance    = Math.round((debitTotal - creditTotal) * 100) / 100;

    const { error: upErr } = await supabase
      .from('opening_balance_batches')
      .update({
        debit_total:  Math.round(debitTotal  * 100) / 100,
        credit_total: Math.round(creditTotal * 100) / 100,
        variance,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', batchId)
      .eq('company_id', companyId);

    if (upErr) throw new Error(`Failed to persist batch totals: ${upErr.message}`);

    return { debitTotal, creditTotal, variance };
  }

  // ── Internal: assert batch exists, belongs to company, and has allowed status ─
  static async _getBatchOrThrow(batchId, companyId, allowedStatuses = null) {
    const { data: batch, error } = await supabase
      .from('opening_balance_batches')
      .select('*')
      .eq('id', batchId)
      .eq('company_id', companyId)
      .single();

    if (error || !batch) throw new Error('Batch not found.');

    if (allowedStatuses && !allowedStatuses.includes(batch.status)) {
      throw new Error(
        `This batch has status '${batch.status}' and cannot be modified. ` +
        `Only batches with status [${allowedStatuses.join(', ')}] may be changed.`
      );
    }

    return batch;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all batches for a company, newest first.
   * Optional status filter.
   */
  static async listBatches({ companyId, status = null }) {
    let query = supabase
      .from('opening_balance_batches')
      .select('id, source_type, source_name, effective_date, description, status, debit_total, credit_total, variance, finalized_at, finalized_by, journal_id, created_by, created_at, updated_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to load batches: ${error.message}`);
    return data || [];
  }

  /**
   * Get a single batch with its lines.
   */
  static async getBatch({ companyId, batchId }) {
    const batch = await this._getBatchOrThrow(batchId, companyId);
    return batch;
  }

  /**
   * Get all lines for a batch, ordered by source_row_number then created_at.
   */
  static async getBatchLines({ companyId, batchId }) {
    // Confirm batch belongs to company before returning lines
    await this._getBatchOrThrow(batchId, companyId);

    const { data, error } = await supabase
      .from('opening_balance_lines')
      .select('id, batch_id, source_account_code, source_account_name, mapped_account_id, mapped_account_code, mapped_account_name, debit, credit, line_status, source_row_number, notes, created_at, updated_at')
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .order('source_row_number', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to load batch lines: ${error.message}`);
    return data || [];
  }

  /**
   * Create a new draft batch.
   */
  static async createBatch({ companyId, userId, effectiveDate, sourceType, sourceName, description }) {
    if (!effectiveDate) throw new Error('Effective date is required.');
    if (!sourceName || !sourceName.trim()) throw new Error('Source name is required.');

    const validSourceTypes = ['manual', 'csv_import', 'xero', 'sage', 'pastel', 'quickbooks', 'other'];
    const resolvedSourceType = validSourceTypes.includes(sourceType) ? sourceType : 'manual';

    const { data: batch, error } = await supabase
      .from('opening_balance_batches')
      .insert({
        company_id:     companyId,
        created_by:     userId,
        source_type:    resolvedSourceType,
        source_name:    sourceName.trim(),
        effective_date: effectiveDate,
        description:    description ? description.trim() : null,
        status:         'draft',
        debit_total:    0,
        credit_total:   0,
        variance:       0,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create batch: ${error.message}`);

    await this._writeAuditLog({
      companyId,
      batchId:      batch.id,
      action:       'batch_created',
      newValue:     { source_name: batch.source_name, effective_date: batch.effective_date, source_type: batch.source_type },
      performedBy:  userId,
    });

    return batch;
  }

  /**
   * Save (create or update) a single line in a draft or validated batch.
   *
   * - lineId present → update existing line
   * - lineId absent  → create new line
   *
   * Only permitted when batch.status is 'draft' or 'validated'.
   * Batch status is reset to 'draft' whenever a line is changed (validation
   * must be re-run after any manual edit).
   *
   * debit and credit must not both be zero.
   * debit and credit must not both be non-zero.
   * Amounts must be non-negative.
   *
   * IMPORTANT: mappedAccountId is optional at line-save time (allows entry
   * before mapping). Use mapLine() to set the account mapping after saving.
   */
  static async saveManualLine({
    companyId, batchId, userId, lineId = null,
    sourceAccountCode, sourceAccountName,
    mappedAccountId = null,
    debit, credit, notes = null,
  }) {
    const batch = await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    // Amount validation
    const d = parseFloat(debit  || 0);
    const c = parseFloat(credit || 0);
    if (d < 0 || c < 0) throw new Error('Debit and credit amounts must be non-negative.');
    if (d > 0 && c > 0)  throw new Error('A line cannot have both a debit and a credit amount.');
    if (d === 0 && c === 0) throw new Error('A line must have either a debit or credit amount.');

    // If mapping provided, validate the account
    let mappedAccountCode = null;
    let mappedAccountName = null;
    let lineStatus = 'unmapped';

    if (mappedAccountId) {
      const acct = await this._validatePostableAccount(companyId, mappedAccountId);
      mappedAccountCode = acct.code;
      mappedAccountName = acct.name;
      lineStatus = 'mapped';
    }

    if (lineId) {
      // UPDATE existing line
      const { data: existing, error: fetchErr } = await supabase
        .from('opening_balance_lines')
        .select('*')
        .eq('id', lineId)
        .eq('batch_id', batchId)
        .eq('company_id', companyId)
        .single();
      if (fetchErr || !existing) throw new Error('Line not found.');

      const updateData = {
        source_account_code:  sourceAccountCode  || existing.source_account_code,
        source_account_name:  sourceAccountName  || existing.source_account_name,
        debit:                d,
        credit:               c,
        notes:                notes !== null ? notes : existing.notes,
        updated_at:           new Date().toISOString(),
      };

      // Only overwrite mapping if a new account was explicitly provided
      if (mappedAccountId) {
        updateData.mapped_account_id   = mappedAccountId;
        updateData.mapped_account_code = mappedAccountCode;
        updateData.mapped_account_name = mappedAccountName;
        updateData.line_status         = 'mapped';
      }

      const { data: updated, error: upErr } = await supabase
        .from('opening_balance_lines')
        .update(updateData)
        .eq('id', lineId)
        .eq('batch_id', batchId)
        .eq('company_id', companyId)
        .select()
        .single();
      if (upErr) throw new Error(`Failed to update line: ${upErr.message}`);

      await this._writeAuditLog({
        companyId, batchId, lineId, action: 'line_updated',
        oldValue: { debit: existing.debit, credit: existing.credit, source_account_code: existing.source_account_code },
        newValue: { debit: d, credit: c, source_account_code: updateData.source_account_code },
        performedBy: userId,
      });

      // Reset batch to draft since contents changed
      await this._resetBatchToDraft(batchId, companyId);
      await this._refreshBatchTotals(batchId, companyId);
      return updated;

    } else {
      // CREATE new line
      const { data: line, error: insErr } = await supabase
        .from('opening_balance_lines')
        .insert({
          batch_id:             batchId,
          company_id:           companyId,
          source_account_code:  sourceAccountCode || null,
          source_account_name:  sourceAccountName || null,
          mapped_account_id:    mappedAccountId  || null,
          mapped_account_code:  mappedAccountCode,
          mapped_account_name:  mappedAccountName,
          debit:                d,
          credit:               c,
          line_status:          lineStatus,
          notes:                notes || null,
        })
        .select()
        .single();
      if (insErr) throw new Error(`Failed to save line: ${insErr.message}`);

      await this._writeAuditLog({
        companyId, batchId, lineId: line.id, action: 'line_created',
        newValue: { debit: d, credit: c, source_account_code: sourceAccountCode },
        performedBy: userId,
      });

      // Reset batch to draft since contents changed
      await this._resetBatchToDraft(batchId, companyId);
      await this._refreshBatchTotals(batchId, companyId);
      return line;
    }
  }

  /**
   * Delete a line from a draft or validated batch.
   * Not permitted on finalized or archived batches.
   */
  static async deleteLine({ companyId, batchId, lineId, userId }) {
    await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    const { data: existing, error: fetchErr } = await supabase
      .from('opening_balance_lines')
      .select('source_account_code, debit, credit')
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .single();
    if (fetchErr || !existing) throw new Error('Line not found.');

    const { error: delErr } = await supabase
      .from('opening_balance_lines')
      .delete()
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId);
    if (delErr) throw new Error(`Failed to delete line: ${delErr.message}`);

    await this._writeAuditLog({
      companyId, batchId, action: 'line_deleted',
      oldValue: { source_account_code: existing.source_account_code, debit: existing.debit, credit: existing.credit },
      performedBy: userId,
    });

    await this._resetBatchToDraft(batchId, companyId);
    await this._refreshBatchTotals(batchId, companyId);
  }

  /**
   * Map a line to a COA account.
   * The account must belong to the same company and be postable (is_postable = true).
   * Only permitted when batch.status is 'draft' or 'validated'.
   */
  static async mapLine({ companyId, batchId, lineId, userId, mappedAccountId }) {
    await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    const { data: existing, error: fetchErr } = await supabase
      .from('opening_balance_lines')
      .select('*')
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .single();
    if (fetchErr || !existing) throw new Error('Line not found.');

    const acct = await this._validatePostableAccount(companyId, mappedAccountId);

    const { data: updated, error: upErr } = await supabase
      .from('opening_balance_lines')
      .update({
        mapped_account_id:   mappedAccountId,
        mapped_account_code: acct.code,
        mapped_account_name: acct.name,
        line_status:         'mapped',
        updated_at:          new Date().toISOString(),
      })
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .select()
      .single();
    if (upErr) throw new Error(`Failed to map line: ${upErr.message}`);

    await this._writeAuditLog({
      companyId, batchId, lineId, action: 'line_mapped',
      oldValue: { mapped_account_id: existing.mapped_account_id, mapped_account_code: existing.mapped_account_code },
      newValue: { mapped_account_id: mappedAccountId, mapped_account_code: acct.code, mapped_account_name: acct.name },
      performedBy: userId,
    });

    // Reset to draft so totals and unmapped count are rechecked
    await this._resetBatchToDraft(batchId, companyId);
    return updated;
  }

  /**
   * Remove the account mapping from a line (revert to unmapped).
   */
  static async unmapLine({ companyId, batchId, lineId, userId }) {
    await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    const { data: existing, error: fetchErr } = await supabase
      .from('opening_balance_lines')
      .select('mapped_account_id, mapped_account_code, line_status')
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .single();
    if (fetchErr || !existing) throw new Error('Line not found.');

    const { error: upErr } = await supabase
      .from('opening_balance_lines')
      .update({
        mapped_account_id:   null,
        mapped_account_code: null,
        mapped_account_name: null,
        line_status:         'unmapped',
        updated_at:          new Date().toISOString(),
      })
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId);
    if (upErr) throw new Error(`Failed to unmap line: ${upErr.message}`);

    await this._writeAuditLog({
      companyId, batchId, lineId, action: 'line_unmapped',
      oldValue: { mapped_account_id: existing.mapped_account_id, mapped_account_code: existing.mapped_account_code },
      performedBy: userId,
    });

    await this._resetBatchToDraft(batchId, companyId);
  }

  /**
   * Exclude a line from totals and journal creation.
   * Excluded lines are retained for audit but do not count toward balance
   * or appear in the finalization journal.
   */
  static async excludeLine({ companyId, batchId, lineId, userId, reason = null }) {
    await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    const { data: existing, error: fetchErr } = await supabase
      .from('opening_balance_lines')
      .select('line_status, source_account_code')
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .single();
    if (fetchErr || !existing) throw new Error('Line not found.');

    if (existing.line_status === 'excluded') return; // already excluded; no-op

    const { error: upErr } = await supabase
      .from('opening_balance_lines')
      .update({ line_status: 'excluded', updated_at: new Date().toISOString() })
      .eq('id', lineId)
      .eq('batch_id', batchId)
      .eq('company_id', companyId);
    if (upErr) throw new Error(`Failed to exclude line: ${upErr.message}`);

    await this._writeAuditLog({
      companyId, batchId, lineId, action: 'line_excluded',
      oldValue: { line_status: existing.line_status },
      reason,
      performedBy: userId,
    });

    await this._resetBatchToDraft(batchId, companyId);
    await this._refreshBatchTotals(batchId, companyId);
  }

  /**
   * Validate a batch.
   *
   * Checks:
   *   1. Batch has at least one active (non-excluded) line
   *   2. All active lines have a mapped account
   *   3. All mapped accounts are still postable (not deleted / reclassified)
   *   4. TB balances (debit_total == credit_total within 0.01 tolerance)
   *
   * Does NOT create or post any journal.
   * Marks batch status as 'validated' on success.
   * Returns { valid, debitTotal, creditTotal, variance, unmappedCount, errors, warnings }
   */
  static async validateBatch({ companyId, batchId, userId }) {
    const batch = await this._getBatchOrThrow(batchId, companyId, ['draft', 'validated']);

    const { data: lines, error: linesErr } = await supabase
      .from('opening_balance_lines')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', companyId);
    if (linesErr) throw new Error(`Failed to load lines for validation: ${linesErr.message}`);

    const activeLines = (lines || []).filter(l => l.line_status !== 'excluded');
    const errors = [];
    const warnings = [];

    if (activeLines.length === 0) {
      errors.push('The batch has no active lines. Add at least one debit and one credit line.');
    }

    // Check for unmapped lines
    const unmappedLines = activeLines.filter(l => l.line_status === 'unmapped' || !l.mapped_account_id);
    if (unmappedLines.length > 0) {
      errors.push(`${unmappedLines.length} line(s) are not mapped to a chart of accounts account.`);
    }

    // Check all mapped accounts still exist and are postable
    const mappedAccountIds = [...new Set(
      activeLines.filter(l => l.mapped_account_id).map(l => l.mapped_account_id)
    )];

    if (mappedAccountIds.length > 0) {
      const { data: accounts, error: acctErr } = await supabase
        .from('accounts')
        .select('id, code, name, is_postable, is_active')
        .eq('company_id', companyId)
        .in('id', mappedAccountIds);
      if (acctErr) throw new Error(`Account validation failed: ${acctErr.message}`);

      const accountMap = {};
      (accounts || []).forEach(a => { accountMap[a.id] = a; });

      for (const line of activeLines) {
        if (!line.mapped_account_id) continue;
        const acct = accountMap[line.mapped_account_id];
        if (!acct) {
          errors.push(`Line "${line.source_account_name || line.source_account_code || line.id}": mapped account no longer exists.`);
        } else if (!acct.is_active) {
          errors.push(`Line "${line.source_account_name || line.source_account_code}": mapped account ${acct.code} is inactive.`);
        } else if (acct.is_postable === false) {
          errors.push(`Line "${line.source_account_name || line.source_account_code}": mapped account ${acct.code} (${acct.name}) is a parent/header account and cannot receive postings. Select a sub-account.`);
        }
      }
    }

    // Calculate totals from lines (source of truth)
    const debitTotal  = activeLines.reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
    const creditTotal = activeLines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
    const variance    = Math.round((debitTotal - creditTotal) * 100) / 100;

    // Balance check — core rule: DO NOT auto-reconcile
    if (Math.abs(variance) > 0.01) {
      errors.push(
        `The trial balance does not balance. ` +
        `Debits: ${debitTotal.toFixed(2)}  Credits: ${creditTotal.toFixed(2)}  ` +
        `Variance: ${variance.toFixed(2)}. ` +
        `Correct the line amounts before finalizing.`
      );
    }

    const valid = errors.length === 0;

    if (valid) {
      // Mark batch as validated and persist refreshed totals
      const { error: upErr } = await supabase
        .from('opening_balance_batches')
        .update({
          status:       'validated',
          debit_total:  Math.round(debitTotal  * 100) / 100,
          credit_total: Math.round(creditTotal * 100) / 100,
          variance,
          updated_at:   new Date().toISOString(),
        })
        .eq('id', batchId)
        .eq('company_id', companyId);
      if (upErr) throw new Error(`Failed to update batch status: ${upErr.message}`);

      await this._writeAuditLog({
        companyId, batchId, action: 'batch_validated',
        newValue: { debit_total: debitTotal, credit_total: creditTotal, variance },
        performedBy: userId,
      });
    }

    return {
      valid,
      debitTotal:    Math.round(debitTotal  * 100) / 100,
      creditTotal:   Math.round(creditTotal * 100) / 100,
      variance,
      unmappedCount: unmappedLines.length,
      errors,
      warnings,
    };
  }

  /**
   * Finalize a validated batch.
   *
   * Requirements:
   *   - batch.status must be 'validated'
   *   - TB must balance (double-checked here)
   *   - effective_date must not fall in a locked accounting period
   *   - All active lines must be mapped to postable accounts
   *
   * Creates exactly ONE draft journal and immediately posts it via JournalService.
   * The journal id is stored on the batch. Batch status is set to 'finalized'.
   * A finalized batch is immutable — no further edits are permitted.
   */
  static async finalizeBatch({ companyId, batchId, userId }) {
    const batch = await this._getBatchOrThrow(batchId, companyId, ['validated']);

    // ── Re-validate (guard against race conditions) ───────────────────────────
    const validation = await this.validateBatch({ companyId, batchId, userId });
    if (!validation.valid) {
      throw new Error(
        `Cannot finalize: validation failed. Errors: ${validation.errors.join(' | ')}`
      );
    }

    // After validateBatch runs, re-fetch lines (validation may have updated batch)
    const { data: lines, error: linesErr } = await supabase
      .from('opening_balance_lines')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .neq('line_status', 'excluded');
    if (linesErr) throw new Error(`Failed to read lines: ${linesErr.message}`);

    // ── Period lock check ─────────────────────────────────────────────────────
    const isLocked = await JournalService.isPeriodLocked(companyId, batch.effective_date);
    if (isLocked) {
      throw new Error(
        `Cannot finalize: the effective date (${batch.effective_date}) falls within a locked accounting period.`
      );
    }

    // ── Build journal lines ───────────────────────────────────────────────────
    // Each opening_balance_line → one journal_line
    // debit/credit pass through directly — NO sign flipping, NO auto-balancing
    const journalLines = lines.map((l, i) => ({
      accountId:   l.mapped_account_id,
      description: l.source_account_name || l.source_account_code || `Opening balance line ${i + 1}`,
      debit:       parseFloat(l.debit  || 0),
      credit:      parseFloat(l.credit || 0),
    }));

    // ── Create draft journal (atomic: header + lines) ─────────────────────────
    const journal = await JournalService.createDraftJournal({
      companyId,
      date:             batch.effective_date,
      reference:        `OB-${batchId.substring(0, 8).toUpperCase()}`,
      description:      `Opening Balance Import — ${batch.source_name}`,
      sourceType:       'opening',
      createdByUserId:  userId,
      lines:            journalLines,
      metadata:         { opening_balance_batch_id: batchId, source_name: batch.source_name },
    });

    // ── Post the journal immediately ──────────────────────────────────────────
    await JournalService.postJournal(journal.id, companyId, userId);

    // ── Lock the batch ────────────────────────────────────────────────────────
    const { error: upErr } = await supabase
      .from('opening_balance_batches')
      .update({
        status:       'finalized',
        finalized_at: new Date().toISOString(),
        finalized_by: userId,
        journal_id:   journal.id,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', batchId)
      .eq('company_id', companyId);
    if (upErr) throw new Error(`Journal posted but batch lock failed: ${upErr.message}`);

    await this._writeAuditLog({
      companyId, batchId, action: 'batch_finalized',
      newValue: {
        journal_id: journal.id,
        debit_total: validation.debitTotal,
        credit_total: validation.creditTotal,
        effective_date: batch.effective_date,
      },
      performedBy: userId,
    });

    return {
      batchId,
      journalId:   journal.id,
      debitTotal:  validation.debitTotal,
      creditTotal: validation.creditTotal,
      lineCount:   journalLines.length,
    };
  }

  /**
   * Archive a finalized batch.
   * Does not delete any data. Sets status to 'archived'.
   */
  static async archiveBatch({ companyId, batchId, userId }) {
    await this._getBatchOrThrow(batchId, companyId, ['finalized']);

    const { error } = await supabase
      .from('opening_balance_batches')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', batchId)
      .eq('company_id', companyId);
    if (error) throw new Error(`Failed to archive batch: ${error.message}`);

    await this._writeAuditLog({
      companyId, batchId, action: 'batch_archived',
      performedBy: userId,
    });
  }

  /**
   * Search postable accounts for the account-mapping dropdown.
   * Returns up to 50 results matching the search term against code and name.
   */
  static async searchAccounts({ companyId, searchTerm }) {
    const term = (searchTerm || '').trim();
    if (!term) return [];

    const { data, error } = await supabase
      .from('accounts')
      .select('id, code, name, account_type, is_postable')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
      .order('code', { ascending: true })
      .limit(50);

    if (error) throw new Error(`Account search failed: ${error.message}`);
    return (data || []).map(a => ({
      account_id:   a.id,
      account_code: a.code,
      account_name: a.name,
      account_type: a.account_type,
      is_postable:  a.is_postable !== false, // treat null as postable for legacy accounts
    }));
  }

  // ── Internal: validate that an account is postable and belongs to company ──
  static async _validatePostableAccount(companyId, accountId) {
    const { data: acct, error } = await supabase
      .from('accounts')
      .select('id, code, name, is_postable, is_active')
      .eq('id', accountId)
      .eq('company_id', companyId)
      .single();

    if (error || !acct) throw new Error('Account not found or does not belong to this company.');
    if (!acct.is_active) throw new Error(`Account ${acct.code} is inactive and cannot be used.`);
    if (acct.is_postable === false) {
      throw new Error(
        `Account ${acct.code} (${acct.name}) is a parent/header account and cannot receive direct postings. ` +
        `Select a sub-account instead.`
      );
    }
    return acct;
  }

  // ── Internal: reset batch to draft ───────────────────────────────────────
  static async _resetBatchToDraft(batchId, companyId) {
    // Only reset if currently 'validated' — draft stays draft
    await supabase
      .from('opening_balance_batches')
      .update({ status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', batchId)
      .eq('company_id', companyId)
      .eq('status', 'validated');   // conditional: no-op if already draft
  }
}

module.exports = OpeningBalancesService;
