'use strict';

/**
 * Historical Comparatives Service
 * ============================================================================
 * Manages historical comparative financial data for the accounting module.
 *
 * KEY RULES (permanent, non-negotiable):
 *   1. Finalized batches are IMMUTABLE — no edits, ever.
 *   2. This module NEVER writes to journals, journal_lines, bank_transactions,
 *      vat tables, or any other live financial table.
 *   3. All data is company-scoped. company_id is always enforced server-side.
 *   4. Every write operation writes an audit record. Audit failure does not
 *      block the main operation.
 *   5. SA financial year default: March (month 3) → February (month 2).
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const db = require('../config/database');

// South African financial year month order (Mar = FY month 1, Feb = FY month 12)
const SA_FY_MONTH_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2];
const MONTH_NAMES = {
  1: 'January', 2: 'February', 3: 'March', 4: 'April',
  5: 'May', 6: 'June', 7: 'July', 8: 'August',
  9: 'September', 10: 'October', 11: 'November', 12: 'December'
};

class HistoricalComparativesService {

  // ── INTERNAL HELPERS ─────────────────────────────────────────────────────

  /**
   * Coerce any user-ID value to INTEGER (nullable).
   * The app's users table uses INTEGER PKs throughout (migrations 014, 019, 041).
   * JWT carries userId as a number but route params may arrive as string "1".
   */
  static _actorId(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = parseInt(id, 10);
    return isNaN(n) ? null : n;
  }

  // ── BATCH MANAGEMENT ─────────────────────────────────────────────────────

  /**
   * Create a new draft batch.
   * Returns the created batch record.
   */
  static async createBatch({ companyId, userId, sourceType, sourceName, description,
    financialYearStart, financialYearEnd, reportBasis = 'profit_loss' }) {
    const { data, error } = await supabase
      .from('historical_comparative_batches')
      .insert({
        company_id: companyId,
        created_by: this._actorId(userId),
        source_type: sourceType || 'manual',
        source_name: sourceName || null,
        description: description || null,
        financial_year_start: financialYearStart || null,
        financial_year_end: financialYearEnd || null,
        period_granularity: 'monthly',
        report_basis: reportBasis,
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;

    await this._writeAuditLog({
      companyId,
      batchId: data.id,
      lineId: null,
      action: 'BATCH_CREATED',
      oldValue: null,
      newValue: { id: data.id, status: 'draft', description },
      performedBy: userId,
    });

    return data;
  }

  /**
   * List all batches for a company. Returns most-recent-first.
   * Optionally filter by status.
   */
  static async listBatches({ companyId, status = null }) {
    let query = supabase
      .from('historical_comparative_batches')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Get a single batch by id, asserting company ownership.
   */
  static async getBatch({ companyId, batchId }) {
    const { data, error } = await supabase
      .from('historical_comparative_batches')
      .select('*')
      .eq('id', batchId)
      .eq('company_id', companyId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // not found
      throw error;
    }
    return data;
  }

  // ── ACCOUNT SEARCH ───────────────────────────────────────────────────────

  /**
   * Search the Chart of Accounts for active accounts (postable AND non-postable).
   * Parent/header accounts (is_postable = false) are returned but flagged so the
   * frontend can prevent direct capture against them.
   *
   * DEFENSIVE FALLBACK: Migration 044 adds the is_postable column to accounts.
   * If that migration has not yet been applied, Supabase returns error code 42703
   * (undefined_column). We detect this and retry without is_postable so the feature
   * degrades gracefully rather than throwing a 500.
   */
  static async searchAccounts({ companyId, query }) {
    const { data, error } = await supabase
      .from('accounts')
      .select('id, code, name, type, parent_id, is_postable')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`name.ilike.%${query}%,code.ilike.%${query}%`)
      .order('code', { ascending: true })
      .limit(50);

    // Graceful fallback when migration 044 (is_postable column) has not been applied yet.
    if (error) {
      if (error.code === '42703') {
        console.warn(
          '[HistoricalComparatives] searchAccounts: is_postable column missing on accounts table. ' +
          'Run migration 044 (044_coa_sub_accounts.sql) in Supabase SQL Editor. Falling back to query without is_postable.'
        );
        const { data: fallback, error: fallbackErr } = await supabase
          .from('accounts')
          .select('id, code, name, type, parent_id')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .or(`name.ilike.%${query}%,code.ilike.%${query}%`)
          .order('code', { ascending: true })
          .limit(50);
        if (fallbackErr) throw fallbackErr;
        return (fallback || []).map(a => ({
          account_id:       a.id,
          account_code:     a.code,
          account_name:     a.name,
          account_type:     a.type,
          parent_account_id: a.parent_id || null,
          is_postable:      true,
          has_children:     false,
        }));
      }
      throw error;
    }

    return (data || []).map(a => ({
      account_id:       a.id,
      account_code:     a.code,
      account_name:     a.name,
      account_type:     a.type,
      parent_account_id: a.parent_id || null,
      is_postable:      a.is_postable !== false,
      has_children:     false,
    }));
  }

  // ── COA SYNC ─────────────────────────────────────────────────────────────

  /**
   * Sync active COA accounts into a draft or validated batch.
   * For P&L batches: income + expense accounts.
   * For trial_balance / mixed batches: all active accounts.
   * Parent (non-postable) accounts are synced as group rows only.
   * Finalized batches are blocked — their account list is permanently locked.
   *
   * Returns { synced, added, updated, parentRows, captureRows, syncedAt }.
   */
  static async syncBatchAccountsFromCOA({ companyId, batchId, userId }) {
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.status === 'finalized') {
      throw new Error('This batch is finalized. Chart of Accounts changes no longer sync into finalized batches.');
    }

    // Determine which account types to include
    const isPLBatch = batch.report_basis === 'profit_loss';

    // Select accounts — note: is_postable, display_order, account_level are added by migration 044.
    // If that migration has not yet been applied we fall back to a reduced select so the sync
    // still populates the batch list (without postability meta).
    let coaAccounts;
    {
      let q = supabase
        .from('accounts')
        .select('id, code, name, type, parent_id, is_postable, sort_order, display_order, account_level')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true });
      if (isPLBatch) q = q.in('type', ['income', 'expense']);

      const { data, error: coaErr } = await q;
      if (coaErr) {
        if (coaErr.code === '42703') {
          console.warn(
            '[HistoricalComparatives] syncBatchAccountsFromCOA: migration 044 columns missing on accounts table. ' +
            'Run 044_coa_sub_accounts.sql. Falling back to reduced select.'
          );
          let qFallback = supabase
            .from('accounts')
            .select('id, code, name, type, parent_id, sort_order')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('code', { ascending: true });
          if (isPLBatch) qFallback = qFallback.in('type', ['income', 'expense']);
          const { data: fallback, error: fallbackErr } = await qFallback;
          if (fallbackErr) throw fallbackErr;
          coaAccounts = (fallback || []).map(a => ({ ...a, is_postable: true, display_order: a.sort_order || 0, account_level: 0 }));
        } else {
          throw coaErr;
        }
      } else {
        coaAccounts = data || [];
      }
    }

    if (!coaAccounts || coaAccounts.length === 0) {
      return { synced: 0, added: 0, updated: 0, parentRows: 0, captureRows: 0, syncedAt: new Date().toISOString() };
    }

    const now = new Date().toISOString();
    const rows = coaAccounts.map(a => ({
      batch_id:         batchId,
      company_id:       companyId,
      account_id:       a.id,
      account_code:     a.code,
      account_name:     a.name,
      account_type:     a.type,
      parent_account_id: a.parent_id || null,
      is_postable:      a.is_postable !== false,
      is_group_row:     a.is_postable === false,
      display_order:    a.display_order || a.sort_order || 0,
      synced_at:        now,
    }));

    // Upsert: update synced_at + name/code on conflict (account may have been renamed)
    const { data: upserted, error: upsertErr } = await supabase
      .from('historical_comparative_batch_accounts')
      .upsert(rows, {
        onConflict: 'batch_id,account_id',
        ignoreDuplicates: false,
      })
      .select('id, is_group_row');

    if (upsertErr) throw upsertErr;

    const parentRows  = (upserted || []).filter(r => r.is_group_row).length;
    const captureRows = (upserted || []).length - parentRows;

    await this._writeAuditLog({
      companyId, batchId, lineId: null,
      action: 'BATCH_UPDATED',
      oldValue: null,
      newValue: { coa_sync: true, total: (upserted || []).length, syncedAt: now },
      performedBy: userId,
    });

    return {
      synced:      (upserted || []).length,
      parentRows,
      captureRows,
      syncedAt:    now,
    };
  }

  /**
   * Return the account list for a batch, with captured value summary.
   * Each account row includes how many monthly lines have been entered.
   */
  static async getBatchAccountList({ companyId, batchId }) {
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');

    const { data: accounts, error: accErr } = await supabase
      .from('historical_comparative_batch_accounts')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .order('display_order', { ascending: true })
      .order('account_code', { ascending: true });

    if (accErr) throw accErr;
    if (!accounts || accounts.length === 0) return { accounts: [], batch };

    // Fetch line counts per account_id to show capture progress
    const { data: lines } = await supabase
      .from('historical_comparative_lines')
      .select('account_id')
      .eq('batch_id', batchId)
      .eq('company_id', companyId);

    const lineCountMap = {};
    for (const l of (lines || [])) {
      if (l.account_id) lineCountMap[l.account_id] = (lineCountMap[l.account_id] || 0) + 1;
    }

    const result = accounts.map(a => ({
      ...a,
      can_capture:   a.is_postable && !a.is_group_row,
      captured_lines: lineCountMap[a.account_id] || 0,
    }));

    return { accounts: result, batch };
  }

  // ── LINE CAPTURE ─────────────────────────────────────────────────────────

  /**
   * Get all lines for a batch, grouped by account for efficient rendering.
   * Returns an array of account groups, each with 12 monthly amounts.
   */
  static async getBatchLines({ companyId, batchId }) {
    const { data, error } = await supabase
      .from('historical_comparative_lines')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', companyId)
      .order('account_code', { ascending: true })
      .order('financial_year', { ascending: true })
      .order('period_month', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Save a single manual line (upsert by batch + account_id + year + month).
   * Blocks if the batch is finalized.
   */
  static async saveManualLine({ companyId, batchId, userId, accountId,
    accountCode, accountName, accountType, financialYear, periodMonth, amount,
    sourceReference, notes }) {

    // Finalization guard
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.is_finalized || batch.status === 'finalized') {
      await this._writeAuditLog({
        companyId, batchId, lineId: null,
        action: 'FINALIZED_EDIT_BLOCKED',
        oldValue: null,
        newValue: { accountCode, financialYear, periodMonth, amount },
        performedBy: userId,
      });
      throw new Error('This batch is finalized and cannot be edited.');
    }

    // Postability guard — parent/header accounts cannot receive historical capture lines
    if (accountId) {
      const { data: acct } = await supabase
        .from('accounts')
        .select('code, name, is_postable')
        .eq('id', accountId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (acct && acct.is_postable === false) {
        throw new Error(
          `Account ${acct.code} (${acct.name}) is a parent account and cannot be used for direct historical capture. Select a sub-account instead.`
        );
      }
    }

    // Build period dates
    const { periodStart, periodEnd } = this._buildPeriodDates(financialYear, periodMonth);

    // Check for existing line (for audit before/after)
    let existingLine = null;
    if (accountId) {
      const { data: existing } = await supabase
        .from('historical_comparative_lines')
        .select('*')
        .eq('batch_id', batchId)
        .eq('account_id', accountId)
        .eq('financial_year', financialYear)
        .eq('period_month', periodMonth)
        .maybeSingle();
      existingLine = existing;
    }

    const lineData = {
      batch_id: batchId,
      company_id: companyId,
      account_id: accountId || null,
      account_code: accountCode || null,
      account_name: accountName,
      account_type: accountType || null,
      financial_year: financialYear,
      period_month: periodMonth,
      period_start: periodStart,
      period_end: periodEnd,
      amount: amount,
      original_amount: existingLine ? existingLine.original_amount : amount,
      source_reference: sourceReference || null,
      capture_method: 'manual',
      entered_by: this._actorId(userId),
      entered_at: existingLine ? existingLine.entered_at : new Date().toISOString(),
      updated_by: this._actorId(userId),
      updated_at: new Date().toISOString(),
      is_finalized: false,
      notes: notes || null,
      // Immutable snapshots — preserve account name/code/type at time of capture
      account_code_snapshot: accountCode || null,
      account_name_snapshot: accountName || null,
      account_type_snapshot: accountType || null,
    };

    let savedLine;
    if (existingLine) {
      const { data, error } = await supabase
        .from('historical_comparative_lines')
        .update(lineData)
        .eq('id', existingLine.id)
        .select()
        .single();
      if (error) throw error;
      savedLine = data;
    } else {
      const { data, error } = await supabase
        .from('historical_comparative_lines')
        .insert(lineData)
        .select()
        .single();
      if (error) throw error;
      savedLine = data;
    }

    // Update batch updated_at
    await supabase
      .from('historical_comparative_batches')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', batchId);

    await this._writeAuditLog({
      companyId, batchId, lineId: savedLine.id,
      action: existingLine ? 'LINE_UPDATED' : 'LINE_CREATED',
      oldValue: existingLine ? { amount: existingLine.amount } : null,
      newValue: { amount, accountCode, financialYear, periodMonth },
      performedBy: userId,
    });

    return savedLine;
  }

  /**
   * Bulk-save a full account grid (12 months × 1 financial year).
   * cells: [{ periodMonth, amount }] — 12 entries expected.
   * Blocks if batch is finalized.
   *
   * PERFORMANCE: Uses bulk DB operations regardless of cell count.
   * Previous implementation called saveManualLine per cell (6 round-trips × 84 cells = 504 queries).
   * This implementation uses ~5 queries total for any number of cells.
   */
  static async saveManualGrid({ companyId, batchId, userId, accountId,
    accountCode, accountName, accountType, financialYear, cells }) {

    // 1. Get batch once — finalization guard
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.is_finalized || batch.status === 'finalized') {
      await this._writeAuditLog({
        companyId, batchId, lineId: null,
        action: 'FINALIZED_EDIT_BLOCKED',
        oldValue: null,
        newValue: { accountCode, financialYear, cellCount: cells.length },
        performedBy: userId,
      });
      throw new Error('This batch is finalized and cannot be edited.');
    }

    // 2. Postability guard — one query for the whole grid, not one per cell
    if (accountId) {
      const { data: acct } = await supabase
        .from('accounts')
        .select('code, name, is_postable')
        .eq('id', accountId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (acct && acct.is_postable === false) {
        throw new Error(
          `Account ${acct.code} (${acct.name}) is a parent account and cannot be used for direct historical capture. Select a sub-account instead.`
        );
      }
    }

    // 3. Fetch all existing lines for this account + batch + year in ONE query
    let existingQuery = supabase
      .from('historical_comparative_lines')
      .select('id, financial_year, period_month, amount, original_amount, entered_by, entered_at')
      .eq('batch_id', batchId)
      .eq('financial_year', financialYear);

    if (accountId) {
      existingQuery = existingQuery.eq('account_id', accountId);
    } else {
      existingQuery = existingQuery
        .eq('account_name', accountName)
        .eq('account_code', accountCode || '');
    }

    const { data: existingLines } = await existingQuery;
    const existingMap = {};
    if (existingLines) {
      for (const line of existingLines) {
        existingMap[`${line.period_month}`] = line;
      }
    }

    // 4. Build all row data locally — _buildPeriodDates is pure, no DB calls
    const now = new Date().toISOString();
    const actorId = this._actorId(userId);

    const toUpdate = [];
    const toInsert = [];

    for (const cell of cells) {
      const { periodStart, periodEnd } = this._buildPeriodDates(financialYear, cell.periodMonth);
      const existing = existingMap[`${cell.periodMonth}`];

      const row = {
        batch_id: batchId,
        company_id: companyId,
        account_id: accountId || null,
        account_code: accountCode || null,
        account_name: accountName,
        account_type: accountType || null,
        financial_year: financialYear,
        period_month: cell.periodMonth,
        period_start: periodStart,
        period_end: periodEnd,
        amount: cell.amount,
        original_amount: existing ? (existing.original_amount ?? cell.amount) : cell.amount,
        source_reference: null,
        capture_method: 'manual',
        entered_by: existing ? existing.entered_by : actorId,
        entered_at: existing ? existing.entered_at : now,
        updated_by: actorId,
        updated_at: now,
        is_finalized: false,
        notes: null,
        account_code_snapshot: accountCode || null,
        account_name_snapshot: accountName || null,
        account_type_snapshot: accountType || null,
      };

      if (existing) {
        toUpdate.push({ id: existing.id, ...row });
      } else {
        toInsert.push(row);
      }
    }

    // 5. Single batch update + single batch insert (max 2 queries for all cells)
    let savedLines = [];

    if (toUpdate.length > 0) {
      const { data, error } = await supabase
        .from('historical_comparative_lines')
        .upsert(toUpdate)
        .select('id');
      if (error) throw error;
      if (data) savedLines = savedLines.concat(data);
    }

    if (toInsert.length > 0) {
      const { data, error } = await supabase
        .from('historical_comparative_lines')
        .insert(toInsert)
        .select('id');
      if (error) throw error;
      if (data) savedLines = savedLines.concat(data);
    }

    // 6. Update batch updated_at once
    await supabase
      .from('historical_comparative_batches')
      .update({ updated_at: now })
      .eq('id', batchId);

    // 7. One audit log entry for the whole grid save
    await this._writeAuditLog({
      companyId, batchId, lineId: null,
      action: 'GRID_SAVED',
      oldValue: null,
      newValue: {
        accountCode, accountName, financialYear,
        updated: toUpdate.length, inserted: toInsert.length,
      },
      performedBy: userId,
    });

    return savedLines;
  }

  // ── RESCALE ──────────────────────────────────────────────────────────────

  /**
   * Divide all line amounts in a draft/validated batch by `divisor`.
   * Only permitted on non-finalized batches.
   * Used to recover from the parseCurrency ×100 bug where amounts were stored
   * 100× too large because the SA comma decimal separator was stripped.
   */
  static async rescaleBatchAmounts({ companyId, batchId, userId, divisor }) {
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.is_finalized || batch.status === 'finalized') {
      throw new Error('This batch is finalized and cannot be modified.');
    }

    // Fetch all lines for this batch
    const { data: lines, error: fetchErr } = await supabase
      .from('historical_comparative_lines')
      .select('id, amount, original_amount')
      .eq('batch_id', batchId)
      .eq('company_id', companyId);

    if (fetchErr) throw fetchErr;
    if (!lines || lines.length === 0) {
      return { updated: 0, divisor };
    }

    // Build rescaled rows — divide amount (and original_amount if it looks scaled too)
    const now = new Date().toISOString();
    const actorId = this._actorId(userId);
    const rescaled = lines.map(l => ({
      id: l.id,
      amount: parseFloat((l.amount / divisor).toFixed(2)),
      original_amount: l.original_amount !== null
        ? parseFloat((l.original_amount / divisor).toFixed(2))
        : null,
      updated_by: actorId,
      updated_at: now,
    }));

    // Batch upsert — uses primary key (id) to update each row
    const { error: upsertErr } = await supabase
      .from('historical_comparative_lines')
      .upsert(rescaled);

    if (upsertErr) throw upsertErr;

    await supabase
      .from('historical_comparative_batches')
      .update({ updated_at: now })
      .eq('id', batchId);

    await this._writeAuditLog({
      companyId, batchId, lineId: null,
      action: 'BATCH_RESCALED',
      oldValue: null,
      newValue: { divisor, linesAffected: rescaled.length },
      performedBy: userId,
    });

    return { updated: rescaled.length, divisor };
  }

  // ── VALIDATION & FINALIZATION ────────────────────────────────────────────

  /**
   * Validate a batch — checks for obvious data issues.
   * Sets status to 'validated' if no blocking errors found.
   * Returns { valid: boolean, errors: [], warnings: [] }.
   */
  static async validateBatch({ companyId, batchId, userId }) {
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.status === 'finalized') {
      throw new Error('Batch is already finalized.');
    }

    const lines = await this.getBatchLines({ companyId, batchId });

    const errors = [];
    const warnings = [];

    if (lines.length === 0) {
      errors.push('Batch contains no data lines. Add at least one line before validating.');
    }

    // Check for lines with zero amounts (warn, not error)
    const zeroLines = lines.filter(l => l.amount === 0);
    if (zeroLines.length > 0) {
      warnings.push(`${zeroLines.length} line(s) have a zero amount. Confirm this is intentional.`);
    }

    // Check for missing account names
    const unnamedLines = lines.filter(l => !l.account_name || l.account_name.trim() === '');
    if (unnamedLines.length > 0) {
      errors.push(`${unnamedLines.length} line(s) are missing an account name.`);
    }

    const valid = errors.length === 0;

    if (valid) {
      const { error } = await supabase
        .from('historical_comparative_batches')
        .update({ status: 'validated', updated_at: new Date().toISOString() })
        .eq('id', batchId)
        .eq('company_id', companyId);
      if (error) throw error;

      await this._writeAuditLog({
        companyId, batchId, lineId: null,
        action: 'BATCH_VALIDATED',
        oldValue: { status: batch.status },
        newValue: { status: 'validated', lineCount: lines.length },
        performedBy: userId,
      });
    }

    return { valid, errors, warnings };
  }

  /**
   * Finalize a batch — permanently locks it. No edits after this.
   * Sets is_finalized = true on all lines.
   * IMMUTABLE after this point. Create a new batch for corrections.
   */
  static async finalizeBatch({ companyId, batchId, userId }) {
    const batch = await this.getBatch({ companyId, batchId });
    if (!batch) throw new Error('Batch not found or access denied.');
    if (batch.status === 'finalized') {
      throw new Error('Batch is already finalized.');
    }
    if (batch.status === 'draft') {
      throw new Error('Batch must be validated before finalizing. Run validation first.');
    }

    const now = new Date().toISOString();

    // Mark all lines as finalized
    const { error: linesError } = await supabase
      .from('historical_comparative_lines')
      .update({ is_finalized: true, updated_at: now })
      .eq('batch_id', batchId)
      .eq('company_id', companyId);

    if (linesError) throw linesError;

    // Mark the batch as finalized
    const { data: finalizedBatch, error: batchError } = await supabase
      .from('historical_comparative_batches')
      .update({
        status: 'finalized',
        finalized_at: now,
        finalized_by: this._actorId(userId),
        updated_at: now,
      })
      .eq('id', batchId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (batchError) throw batchError;

    await this._writeAuditLog({
      companyId, batchId, lineId: null,
      action: 'BATCH_FINALIZED',
      oldValue: { status: batch.status },
      newValue: { status: 'finalized', finalized_at: now, finalized_by: userId },
      performedBy: userId,
    });

    return finalizedBatch;
  }

  // ── REPORTS ──────────────────────────────────────────────────────────────

  /**
   * Returns the SQL WHERE fragment for batch/line finalization status.
   * statusMode values:
   *   'finalized_only' — only lines/batches that are fully finalized (safe default)
   *   'draft_preview'  — all batches incl. draft and validated (read-only preview)
   *   'all'            — same as draft_preview (alias, for completeness)
   * The filter string is built from a controlled enum — safe string interpolation.
   */
  static _buildStatusFilter(statusMode) {
    if (statusMode === 'draft_preview' || statusMode === 'all') {
      return `AND b.status IN ('draft', 'validated', 'finalized')`;
    }
    return `AND l.is_finalized = true AND b.status = 'finalized'`;
  }

  /**
   * Builds the metadata block appended to every report response.
   * isDraftPreview = true triggers the warning banner in the UI.
   */
  static _buildReportMetadata(statusMode) {
    const isDraftPreview = statusMode !== 'finalized_only';
    return {
      statusMode,
      isDraftPreview,
      sourceWarning: isDraftPreview
        ? 'This report includes draft/unfinalized data. For internal preview only — not suitable for financial reporting or tax submissions.'
        : null,
    };
  }

  /**
   * Monthly P&L Comparative Report.
   * Returns lines for the company across the specified year range,
   * grouped by account, showing one column per month per year.
   *
   * statusMode: 'finalized_only' (default) | 'draft_preview' | 'all'
   * batchId:    optional UUID — narrows to a specific batch when set.
   * SECURITY: company_id always from caller param; batchId always parameterized.
   * IMMUTABILITY: read-only — never writes to any live ledger table.
   */
  static async getMonthlyPLReport({ companyId, financialYearStart, financialYearEnd, accountType = null, statusMode = 'finalized_only', batchId = null }) {
    const statusFilter = this._buildStatusFilter(statusMode);

    let params = [companyId, financialYearStart, financialYearEnd];
    let batchFilter = '';
    if (batchId) {
      params.push(batchId);
      batchFilter = `AND l.batch_id = $${params.length}`;
    }

    let accountTypeFilter = '';
    if (accountType) {
      params.push(accountType);
      accountTypeFilter = `AND l.account_type = $${params.length}`;
    }

    const sql = `
      SELECT
        l.account_id,
        l.account_code,
        l.account_name,
        l.account_type,
        l.financial_year,
        l.period_month,
        SUM(l.amount) AS total_amount
      FROM historical_comparative_lines l
      JOIN historical_comparative_batches b ON b.id = l.batch_id
      WHERE
        l.company_id = $1
        ${statusFilter}
        AND l.financial_year >= $2
        AND l.financial_year <= $3
        ${batchFilter}
        ${accountTypeFilter}
      GROUP BY
        l.account_id, l.account_code, l.account_name, l.account_type,
        l.financial_year, l.period_month
      ORDER BY
        l.account_code ASC,
        l.financial_year ASC,
        l.period_month ASC
    `;

    const result = await db.query(sql, params);
    const structure = this._buildPLReportStructure(result.rows, financialYearStart, financialYearEnd);
    return { ...structure, metadata: this._buildReportMetadata(statusMode) };
  }

  /**
   * TB-Style Comparative Report.
   * Returns annual totals per account grouped by account type (section totals included).
   * Useful for balance-sheet / trial-balance style review across years.
   *
   * statusMode: 'finalized_only' | 'draft_preview' | 'all'
   * batchId:    optional UUID — narrows to a specific batch.
   * SECURITY: company_id always from caller param; batchId always parameterized.
   * IMMUTABILITY: read-only — never writes to any live ledger table.
   */
  static async getTBStyleComparativeReport({ companyId, financialYearStart, financialYearEnd, statusMode = 'finalized_only', batchId = null }) {
    const statusFilter = this._buildStatusFilter(statusMode);
    const TYPE_ORDER = { Asset: 1, Liability: 2, Equity: 3, Income: 4, Expense: 5 };

    let params = [companyId, financialYearStart, financialYearEnd];
    let batchFilter = '';
    if (batchId) {
      params.push(batchId);
      batchFilter = `AND l.batch_id = $${params.length}`;
    }

    const sql = `
      SELECT
        l.account_id,
        l.account_code,
        l.account_name,
        l.account_type,
        l.financial_year,
        SUM(l.amount) AS year_total
      FROM historical_comparative_lines l
      JOIN historical_comparative_batches b ON b.id = l.batch_id
      WHERE
        l.company_id = $1
        ${statusFilter}
        AND l.financial_year >= $2
        AND l.financial_year <= $3
        ${batchFilter}
      GROUP BY
        l.account_id, l.account_code, l.account_name, l.account_type,
        l.financial_year
      ORDER BY
        l.account_type ASC,
        l.account_code ASC,
        l.financial_year ASC
    `;

    const result = await db.query(sql, params);

    const accountMap = {};
    for (const row of result.rows) {
      const key = row.account_id ? `id_${row.account_id}` : `code_${row.account_code}_${row.account_name}`;
      if (!accountMap[key]) {
        accountMap[key] = {
          account_id: row.account_id,
          account_code: row.account_code,
          account_name: row.account_name,
          account_type: row.account_type,
          years: {},
        };
      }
      accountMap[key].years[row.financial_year] = parseFloat(row.year_total);
    }

    const years = [];
    for (let y = financialYearStart; y <= financialYearEnd; y++) years.push(y);

    const sectionMap = {};
    for (const acc of Object.values(accountMap)) {
      const t = acc.account_type || 'Other';
      if (!sectionMap[t]) sectionMap[t] = { type: t, accounts: [], yearTotals: {} };
      sectionMap[t].accounts.push(acc);
      for (const y of years) {
        sectionMap[t].yearTotals[y] = (sectionMap[t].yearTotals[y] || 0) + (acc.years[y] || 0);
      }
    }

    const sections = Object.values(sectionMap)
      .sort((a, b) => (TYPE_ORDER[a.type] || 9) - (TYPE_ORDER[b.type] || 9));

    for (const sec of sections) {
      sec.accounts.sort((a, b) => {
        if (a.account_code && b.account_code) return a.account_code.localeCompare(b.account_code);
        return a.account_name.localeCompare(b.account_name);
      });
    }

    return { sections, years, metadata: this._buildReportMetadata(statusMode) };
  }

  /**
   * Multi-Year Comparative Report.
   * Returns annual totals per account across the year range, suitable for
   * year-over-year comparison. Frontend computes YoY % change columns.
   *
   * statusMode: 'finalized_only' | 'draft_preview' | 'all'
   * batchId:    optional UUID — narrows to a specific batch.
   * SECURITY: company_id always from caller param; batchId always parameterized.
   * IMMUTABILITY: read-only — never writes to any live ledger table.
   */
  static async getMultiYearComparativeReport({ companyId, financialYearStart, financialYearEnd, accountType = null, statusMode = 'finalized_only', batchId = null }) {
    const statusFilter = this._buildStatusFilter(statusMode);

    let params = [companyId, financialYearStart, financialYearEnd];
    let batchFilter = '';
    if (batchId) {
      params.push(batchId);
      batchFilter = `AND l.batch_id = $${params.length}`;
    }

    let accountTypeFilter = '';
    if (accountType) {
      params.push(accountType);
      accountTypeFilter = `AND l.account_type = $${params.length}`;
    }

    const sql = `
      SELECT
        l.account_id,
        l.account_code,
        l.account_name,
        l.account_type,
        l.financial_year,
        SUM(l.amount) AS year_total
      FROM historical_comparative_lines l
      JOIN historical_comparative_batches b ON b.id = l.batch_id
      WHERE
        l.company_id = $1
        ${statusFilter}
        AND l.financial_year >= $2
        AND l.financial_year <= $3
        ${batchFilter}
        ${accountTypeFilter}
      GROUP BY
        l.account_id, l.account_code, l.account_name, l.account_type,
        l.financial_year
      ORDER BY
        l.account_code ASC,
        l.financial_year ASC
    `;

    const result = await db.query(sql, params);

    const accountMap = {};
    for (const row of result.rows) {
      const key = row.account_id ? `id_${row.account_id}` : `code_${row.account_code}_${row.account_name}`;
      if (!accountMap[key]) {
        accountMap[key] = {
          account_id: row.account_id,
          account_code: row.account_code,
          account_name: row.account_name,
          account_type: row.account_type,
          years: {},
        };
      }
      accountMap[key].years[row.financial_year] = parseFloat(row.year_total);
    }

    const years = [];
    for (let y = financialYearStart; y <= financialYearEnd; y++) years.push(y);

    const accounts = Object.values(accountMap).sort((a, b) => {
      if (a.account_code && b.account_code) return a.account_code.localeCompare(b.account_code);
      return a.account_name.localeCompare(b.account_name);
    });

    return { accounts, years, metadata: this._buildReportMetadata(statusMode) };
  }

  /**
   * Account Trend Report.
   * Returns monthly figures for a specific account across multiple years.
   * Useful for trend analysis / graphing.
   */
  static async getAccountTrendReport({ companyId, accountId, financialYearStart, financialYearEnd }) {
    const sql = `
      SELECT
        l.account_id,
        l.account_code,
        l.account_name,
        l.account_type,
        l.financial_year,
        l.period_month,
        SUM(l.amount) AS total_amount
      FROM historical_comparative_lines l
      JOIN historical_comparative_batches b ON b.id = l.batch_id
      WHERE
        l.company_id = $1
        AND l.account_id = $2
        AND l.is_finalized = true
        AND b.status = 'finalized'
        AND l.financial_year >= $3
        AND l.financial_year <= $4
      GROUP BY
        l.account_id, l.account_code, l.account_name, l.account_type,
        l.financial_year, l.period_month
      ORDER BY
        l.financial_year ASC,
        l.period_month ASC
    `;

    const result = await db.query(sql, [companyId, accountId, financialYearStart, financialYearEnd]);
    return result.rows;
  }

  // ── DASHBOARD CHART TRENDS ────────────────────────────────────────────────

  /**
   * Dashboard trend data — returns Chart.js-compatible datasets.
   *
   * SECURITY RULES:
   *   - companyId is always sourced from the caller parameter — never from user input.
   *   - finalizedOnly defaults to true. Only routes that have verified the user role
   *     may set finalizedOnly = false to expose draft batches.
   *   - batchId and accountId are always parameterized in SQL — never interpolated.
   *
   * IMMUTABILITY RULE:
   *   This method is strictly read-only. It NEVER writes to:
   *   journals, journal_lines, bank_transactions, vat tables, or any live ledger table.
   *
   * @param {object}  opts
   * @param {number}  opts.companyId       — mandatory, enforced server-side
   * @param {string}  opts.metric          — revenue|expenses|gross_profit|net_profit|account_trend|annual_summary
   * @param {number}  opts.fromYear        — FY start inclusive
   * @param {number}  opts.toYear          — FY end inclusive
   * @param {string}  [opts.batchId]       — narrow to a specific batch UUID
   * @param {number}  [opts.accountId]     — required for account_trend metric
   * @param {string}  [opts.accountType]   — optional extra account_type filter
   * @param {boolean} [opts.finalizedOnly] — default true. Draft allowed only when caller verified role.
   */
  static async getDashboardTrends({
    companyId, metric, fromYear, toYear,
    batchId = null, accountId = null, accountType = null,
    finalizedOnly = true,
  }) {
    const VALID_METRICS = ['revenue', 'gross_profit', 'net_profit', 'expenses', 'account_trend', 'annual_summary'];
    if (!VALID_METRICS.includes(metric)) {
      throw new Error(`Invalid metric "${metric}". Must be one of: ${VALID_METRICS.join(', ')}`);
    }

    const fyStart = parseInt(fromYear);
    const fyEnd   = parseInt(toYear);
    if (!fyStart || !fyEnd || fyStart > fyEnd) {
      throw new Error('fromYear and toYear are required and fromYear must be <= toYear.');
    }

    // finalFilter is built from a boolean we control — safe string interpolation
    const finalFilter = finalizedOnly
      ? `AND l.is_finalized = true AND b.status = 'finalized'`
      : `AND b.status IN ('draft', 'validated', 'finalized')`;

    // All user-supplied IDs are parameterized — never interpolated
    const params = [companyId, fyStart, fyEnd];

    let batchFilter = '';
    if (batchId) {
      params.push(batchId);
      batchFilter = `AND l.batch_id = $${params.length}`;
    }

    let accountTypeFilter = '';
    if (accountType) {
      params.push(accountType);
      accountTypeFilter = `AND l.account_type = $${params.length}`;
    }

    let result;

    // ── ACCOUNT TREND ──────────────────────────────────────────────────────
    if (metric === 'account_trend') {
      if (!accountId) throw new Error('accountId is required for the account_trend metric.');
      params.push(parseInt(accountId));
      const sql = `
        SELECT
          l.financial_year,
          l.period_month,
          l.account_code,
          l.account_name,
          l.account_type,
          SUM(l.amount) AS total_amount
        FROM historical_comparative_lines l
        JOIN historical_comparative_batches b ON b.id = l.batch_id
        WHERE
          l.company_id = $1
          ${finalFilter}
          AND l.financial_year >= $2
          AND l.financial_year <= $3
          ${batchFilter}
          AND l.account_id = $${params.length}
        GROUP BY
          l.financial_year, l.period_month,
          l.account_code, l.account_name, l.account_type
        ORDER BY l.financial_year ASC, l.period_month ASC
      `;
      result = await db.query(sql, params);
      const chart = this._buildChartDataset({ metric, rows: result.rows, fyStart, fyEnd, finalizedOnly });
      chart.metadata.batches = await this._getBatchMetadata({ companyId, fyStart, fyEnd, batchId, finalizedOnly });
      return chart;
    }

    // ── ANNUAL SUMMARY ─────────────────────────────────────────────────────
    if (metric === 'annual_summary') {
      const sql = `
        SELECT
          l.financial_year,
          l.account_type,
          SUM(l.amount) AS total_amount
        FROM historical_comparative_lines l
        JOIN historical_comparative_batches b ON b.id = l.batch_id
        WHERE
          l.company_id = $1
          ${finalFilter}
          AND l.financial_year >= $2
          AND l.financial_year <= $3
          ${batchFilter}
          AND l.account_type IN ('Income', 'Expense')
        GROUP BY l.financial_year, l.account_type
        ORDER BY l.financial_year ASC
      `;
      result = await db.query(sql, params);
      const chart = this._buildAnnualSummaryDataset({ rows: result.rows, fyStart, fyEnd, finalizedOnly });
      chart.metadata.batches = await this._getBatchMetadata({ companyId, fyStart, fyEnd, batchId, finalizedOnly });
      return chart;
    }

    // ── REVENUE / EXPENSES / GROSS_PROFIT / NET_PROFIT ─────────────────────
    // NOTE: gross_profit and net_profit use the same Income-minus-Expense formula.
    // True gross profit (Income minus COGS only) would require a COGS sub_type tag
    // in the accounts table. Document this as a known simplification.
    const sql = `
      SELECT
        l.financial_year,
        l.period_month,
        l.account_type,
        SUM(l.amount) AS total_amount
      FROM historical_comparative_lines l
      JOIN historical_comparative_batches b ON b.id = l.batch_id
      WHERE
        l.company_id = $1
        ${finalFilter}
        AND l.financial_year >= $2
        AND l.financial_year <= $3
        ${batchFilter}
        AND l.account_type IN ('Income', 'Expense')
        ${accountTypeFilter}
      GROUP BY l.financial_year, l.period_month, l.account_type
      ORDER BY l.financial_year ASC, l.period_month ASC
    `;
    result = await db.query(sql, params);
    const chart = this._buildChartDataset({ metric, rows: result.rows, fyStart, fyEnd, finalizedOnly });
    chart.metadata.batches = await this._getBatchMetadata({ companyId, fyStart, fyEnd, batchId, finalizedOnly });
    return chart;
  }

  // ── INTERNAL HELPERS ─────────────────────────────────────────────────────

  /**
   * Build period start/end dates for a given financial year and calendar month.
   * SA financial year: year refers to the START year (e.g. 2023 = March 2023 – Feb 2024).
   * March 2023 → period_start: 2023-03-01, period_end: 2023-03-31
   * January 2024 (FY 2023) → period_start: 2024-01-01, period_end: 2024-01-31
   * February 2024 (FY 2023) → period_start: 2024-02-01, period_end: 2024-02-29
   */
  static _buildPeriodDates(financialYear, periodMonth) {
    // If month is Jan or Feb, it belongs to the NEXT calendar year from FY start
    const calendarYear = (periodMonth <= 2) ? financialYear + 1 : financialYear;
    const month = String(periodMonth).padStart(2, '0');
    const periodStart = `${calendarYear}-${month}-01`;
    // Last day of the month
    const lastDay = new Date(calendarYear, periodMonth, 0).getDate();
    const periodEnd = `${calendarYear}-${month}-${String(lastDay).padStart(2, '0')}`;
    return { periodStart, periodEnd };
  }

  /**
   * Group raw report rows into a structured object:
   * {
   *   accounts: [{
   *     account_id, account_code, account_name, account_type,
   *     years: {
   *       2022: { 3: amount, 4: amount, ..., 2: amount },
   *       2023: { ... }
   *     }
   *   }],
   *   years: [2022, 2023],
   *   monthOrder: [3,4,5,...,2]
   * }
   */
  static _buildPLReportStructure(rows, yearStart, yearEnd) {
    const accountMap = {};
    const yearsSet = new Set();

    for (const row of rows) {
      const key = row.account_id
        ? `id_${row.account_id}`
        : `code_${row.account_code}_${row.account_name}`;

      if (!accountMap[key]) {
        accountMap[key] = {
          account_id: row.account_id,
          account_code: row.account_code,
          account_name: row.account_name,
          account_type: row.account_type,
          years: {},
        };
      }

      const fy = row.financial_year;
      yearsSet.add(fy);
      if (!accountMap[key].years[fy]) {
        accountMap[key].years[fy] = {};
      }
      accountMap[key].years[fy][row.period_month] = parseFloat(row.total_amount);
    }

    const years = [];
    for (let y = yearStart; y <= yearEnd; y++) years.push(y);

    return {
      accounts: Object.values(accountMap).sort((a, b) => {
        if (a.account_code && b.account_code) return a.account_code.localeCompare(b.account_code);
        return a.account_name.localeCompare(b.account_name);
      }),
      years,
      monthOrder: SA_FY_MONTH_ORDER,
      monthNames: MONTH_NAMES,
    };
  }

  /**
   * Build Chart.js-compatible dataset from raw SQL rows.
   * Handles revenue, expenses, gross_profit, net_profit, and account_trend metrics.
   * Pure function — no DB access.
   */
  static _buildChartDataset({ metric, rows, fyStart, fyEnd, finalizedOnly }) {
    const years = [];
    for (let y = fyStart; y <= fyEnd; y++) years.push(y);

    const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTH_LABELS = SA_FY_MONTH_ORDER.map(m => MONTH_SHORT[m - 1]);

    if (metric === 'account_trend') {
      // Lookup: year -> month -> amount
      const lookup = {};
      for (const row of rows) {
        const fy = parseInt(row.financial_year);
        const m  = parseInt(row.period_month);
        if (!lookup[fy]) lookup[fy] = {};
        lookup[fy][m] = parseFloat(row.total_amount || 0);
      }

      const accountInfo = rows.length > 0 ? {
        account_code: rows[0].account_code,
        account_name: rows[0].account_name,
        account_type: rows[0].account_type,
      } : null;

      return {
        labels: MONTH_LABELS,
        datasets: years.map(y => ({
          label: `FY ${y}/${String(y + 1).slice(-2)}`,
          data: SA_FY_MONTH_ORDER.map(m => (lookup[y] && lookup[y][m] !== undefined ? lookup[y][m] : 0)),
        })),
        monthOrder: SA_FY_MONTH_ORDER,
        source: 'historical_comparatives',
        metadata: { financialYearStart: fyStart, financialYearEnd: fyEnd, metric, finalizedOnly, accountInfo },
      };
    }

    // Income/Expense-based metrics
    // Lookup: year -> month -> { Income: x, Expense: y }
    const lookup = {};
    for (const row of rows) {
      const fy  = parseInt(row.financial_year);
      const m   = parseInt(row.period_month);
      const amt = parseFloat(row.total_amount || 0);
      if (!lookup[fy]) lookup[fy] = {};
      if (!lookup[fy][m]) lookup[fy][m] = { Income: 0, Expense: 0 };
      if (row.account_type === 'Income' || row.account_type === 'Expense') {
        lookup[fy][m][row.account_type] += amt;
      }
    }

    return {
      labels: MONTH_LABELS,
      datasets: years.map(y => ({
        label: `FY ${y}/${String(y + 1).slice(-2)}`,
        data: SA_FY_MONTH_ORDER.map(m => {
          const cell = (lookup[y] && lookup[y][m]) ? lookup[y][m] : { Income: 0, Expense: 0 };
          switch (metric) {
            case 'revenue':      return cell.Income;
            case 'expenses':     return cell.Expense;
            case 'gross_profit':
            case 'net_profit':   return cell.Income - cell.Expense;
            default:             return 0;
          }
        }),
      })),
      monthOrder: SA_FY_MONTH_ORDER,
      source: 'historical_comparatives',
      metadata: { financialYearStart: fyStart, financialYearEnd: fyEnd, metric, finalizedOnly },
    };
  }

  /**
   * Build annual summary dataset — three series: Revenue, Expenses, Net Profit.
   * Labels are financial year strings (e.g. "FY 2022/23").
   * Pure function — no DB access.
   */
  static _buildAnnualSummaryDataset({ rows, fyStart, fyEnd, finalizedOnly }) {
    const years = [];
    for (let y = fyStart; y <= fyEnd; y++) years.push(y);

    const lookup = {};
    for (const row of rows) {
      const fy = parseInt(row.financial_year);
      if (!lookup[fy]) lookup[fy] = { Income: 0, Expense: 0 };
      if (row.account_type === 'Income' || row.account_type === 'Expense') {
        lookup[fy][row.account_type] += parseFloat(row.total_amount || 0);
      }
    }

    const revenue   = years.map(y => (lookup[y] ? lookup[y].Income  : 0));
    const expenses  = years.map(y => (lookup[y] ? lookup[y].Expense : 0));
    const netProfit = years.map((_, i) => revenue[i] - expenses[i]);

    return {
      labels: years.map(y => `FY ${y}/${String(y + 1).slice(-2)}`),
      datasets: [
        { label: 'Revenue',    data: revenue   },
        { label: 'Expenses',   data: expenses  },
        { label: 'Net Profit', data: netProfit },
      ],
      source: 'historical_comparatives',
      metadata: {
        financialYearStart: fyStart,
        financialYearEnd: fyEnd,
        metric: 'annual_summary',
        finalizedOnly,
      },
    };
  }

  /**
   * Fetch batch metadata for including in dashboard API responses.
   * Allows users to inspect which batches contributed to a chart.
   * Returns batches that overlap the requested year range.
   * Never throws — metadata is supplementary information only.
   */
  static async _getBatchMetadata({ companyId, fyStart, fyEnd, batchId, finalizedOnly }) {
    try {
      let query = supabase
        .from('historical_comparative_batches')
        .select('id, description, source_type, source_name, financial_year_start, financial_year_end, status, finalized_at, created_at')
        .eq('company_id', companyId)
        .lte('financial_year_start', fyEnd)
        .gte('financial_year_end', fyStart);

      if (finalizedOnly) {
        query = query.eq('status', 'finalized');
      } else {
        query = query.in('status', ['draft', 'validated', 'finalized']);
      }

      if (batchId) {
        query = query.eq('id', batchId);
      }

      const { data } = await query;
      return data || [];
    } catch {
      return []; // metadata failure must never surface as an error to the caller
    }
  }

  /**
   * Write an audit record for historical comparatives.
   * Never throws — audit failure must not break the main operation.
   */
  static async _writeAuditLog({ companyId, batchId, lineId, action, oldValue, newValue, performedBy }) {
    try {
      await supabase
        .from('historical_comparative_audit_log')
        .insert({
          company_id: companyId,
          batch_id: batchId || null,
          line_id: lineId || null,
          action,
          old_value: oldValue || null,
          new_value: newValue || null,
          performed_by: this._actorId(performedBy),
          performed_at: new Date().toISOString(),
        });
    } catch (err) {
      console.error('[HistoricalComparatives] Audit log write failed:', err.message);
      // Do not throw — audit log failure must not block the main operation
    }
  }
}

module.exports = HistoricalComparativesService;
