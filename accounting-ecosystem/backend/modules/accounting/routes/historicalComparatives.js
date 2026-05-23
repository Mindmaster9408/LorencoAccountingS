'use strict';

/**
 * Historical Comparatives Routes
 * ============================================================================
 * All routes are under /api/accounting/historical-comparatives
 *
 * All routes require:
 *   - authenticate middleware (ECO JWT → req.user)
 *   - Company context in req.user.companyId (set by authenticate)
 *
 * Permissions:
 *   historical.view   — list, read, report endpoints
 *   historical.create — create, save, bulk-save endpoints
 *   historical.finalize — validate, finalize endpoints
 * ============================================================================
 */

const express = require('express');
const { authenticate, hasPermission } = require('../middleware/auth');
const HistoricalComparativesService = require('../services/historicalComparativesService');

const router = express.Router();

// ── BATCH MANAGEMENT ─────────────────────────────────────────────────────────

/**
 * GET /api/accounting/historical-comparatives/batches
 * List batches for the authenticated company.
 * Optional query: ?status=draft|validated|finalized|archived
 */
router.get('/batches', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { status } = req.query;
    const batches = await HistoricalComparativesService.listBatches({
      companyId: req.user.companyId,
      status: status || null,
    });
    res.json({ batches });
  } catch (error) {
    console.error('[HistoricalComparatives] listBatches error:', error);
    res.status(500).json({ error: 'Failed to load batches.' });
  }
});

/**
 * POST /api/accounting/historical-comparatives/batches
 * Create a new draft batch.
 * Body: { description, sourceType, sourceName, financialYearStart, financialYearEnd, reportBasis }
 */
router.post('/batches', authenticate, hasPermission('historical.create'), async (req, res) => {
  try {
    const { description, sourceType, sourceName, financialYearStart,
      financialYearEnd, reportBasis } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'A batch description is required.' });
    }

    const batch = await HistoricalComparativesService.createBatch({
      companyId: req.user.companyId,
      userId: req.user.id,
      sourceType: sourceType || 'manual',
      sourceName: sourceName || null,
      description: description.trim(),
      financialYearStart: financialYearStart ? parseInt(financialYearStart) : null,
      financialYearEnd: financialYearEnd ? parseInt(financialYearEnd) : null,
      reportBasis: reportBasis || 'profit_loss',
    });

    res.status(201).json({ batch });
  } catch (error) {
    console.error('[HistoricalComparatives] createBatch error:', error);
    res.status(500).json({ error: 'Failed to create batch.' });
  }
});

// ── ACCOUNT SEARCH ────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/historical-comparatives/accounts/search?q=salary
 * Search the Chart of Accounts for the company.
 */
router.get('/accounts/search', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
    }

    const accounts = await HistoricalComparativesService.searchAccounts({
      companyId: req.user.companyId,
      query: q.trim(),
    });
    res.json({ accounts });
  } catch (error) {
    console.error('[HistoricalComparatives] searchAccounts error:', error);
    res.status(500).json({ error: 'Failed to search accounts.' });
  }
});

// ── COA SYNC ──────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/sync-accounts
 * Sync active postable COA accounts into a draft/validated batch.
 * Finalized batches are blocked.
 */
router.post('/batch/:batchId/sync-accounts', authenticate, hasPermission('historical.create'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const result = await HistoricalComparativesService.syncBatchAccountsFromCOA({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    if (error.message && error.message.includes('finalized')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] syncBatchAccountsFromCOA error:', error);
    res.status(500).json({ error: 'Failed to sync Chart of Accounts.' });
  }
});

/**
 * GET /api/accounting/historical-comparatives/batch/:batchId/accounts
 * Return the synced account list for a batch, with capture progress.
 * Includes parent (group) rows and postable (editable) rows.
 */
router.get('/batch/:batchId/accounts', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const result = await HistoricalComparativesService.getBatchAccountList({
      companyId: req.user.companyId,
      batchId,
    });
    res.json(result);
  } catch (error) {
    console.error('[HistoricalComparatives] getBatchAccountList error:', error);
    res.status(500).json({ error: 'Failed to load batch account list.' });
  }
});

// ── BATCH LINES ───────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/historical-comparatives/batch/:batchId/lines
 * Get all lines for a batch.
 */
router.get('/batch/:batchId/lines', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const lines = await HistoricalComparativesService.getBatchLines({
      companyId: req.user.companyId,
      batchId,
    });
    res.json({ lines });
  } catch (error) {
    console.error('[HistoricalComparatives] getBatchLines error:', error);
    res.status(500).json({ error: 'Failed to load batch lines.' });
  }
});

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/manual-line
 * Save a single manual line.
 * Body: { accountId, accountCode, accountName, accountType, financialYear,
 *         periodMonth, amount, sourceReference, notes }
 */
router.post('/batch/:batchId/manual-line', authenticate, hasPermission('historical.create'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const {
      accountId, accountCode, accountName, accountType,
      financialYear, periodMonth, amount,
      sourceReference, notes
    } = req.body;

    if (!accountName || !accountName.trim()) {
      return res.status(400).json({ error: 'Account name is required.' });
    }
    if (!financialYear || !periodMonth) {
      return res.status(400).json({ error: 'Financial year and period month are required.' });
    }
    if (amount === undefined || amount === null || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'A valid amount is required.' });
    }
    if (periodMonth < 1 || periodMonth > 12) {
      return res.status(400).json({ error: 'Period month must be between 1 and 12.' });
    }

    const line = await HistoricalComparativesService.saveManualLine({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
      accountId: accountId ? parseInt(accountId) : null,
      accountCode: accountCode || null,
      accountName: accountName.trim(),
      accountType: accountType || null,
      financialYear: parseInt(financialYear),
      periodMonth: parseInt(periodMonth),
      amount: parseFloat(amount),
      sourceReference: sourceReference || null,
      notes: notes || null,
    });

    res.json({ line });
  } catch (error) {
    if (error.message && error.message.includes('finalized')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] saveManualLine error:', error);
    res.status(500).json({ error: 'Failed to save line.' });
  }
});

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/manual-grid
 * Bulk-save a full account grid (12 months × 1 year).
 * Body: { accountId, accountCode, accountName, accountType, financialYear,
 *         cells: [{ periodMonth, amount }] }
 */
router.post('/batch/:batchId/manual-grid', authenticate, hasPermission('historical.create'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const { accountId, accountCode, accountName, accountType, financialYear, cells } = req.body;

    if (!accountName || !accountName.trim()) {
      return res.status(400).json({ error: 'Account name is required.' });
    }
    if (!financialYear) {
      return res.status(400).json({ error: 'Financial year is required.' });
    }
    if (!Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: 'cells array is required and must not be empty.' });
    }

    // Validate all cells have valid periodMonth and amount
    for (const cell of cells) {
      if (!cell.periodMonth || cell.periodMonth < 1 || cell.periodMonth > 12) {
        return res.status(400).json({ error: `Invalid periodMonth: ${cell.periodMonth}` });
      }
      if (cell.amount === undefined || cell.amount === null || isNaN(parseFloat(cell.amount))) {
        return res.status(400).json({ error: `Invalid amount for month ${cell.periodMonth}` });
      }
    }

    const results = await HistoricalComparativesService.saveManualGrid({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
      accountId: accountId ? parseInt(accountId) : null,
      accountCode: accountCode || null,
      accountName: accountName.trim(),
      accountType: accountType || null,
      financialYear: parseInt(financialYear),
      cells: cells.map(c => ({
        periodMonth: parseInt(c.periodMonth),
        amount: parseFloat(c.amount),
      })),
    });

    res.json({ saved: results.length, lines: results });
  } catch (error) {
    if (error.message && error.message.includes('finalized')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] saveManualGrid error:', error);
    res.status(500).json({ error: 'Failed to save grid.' });
  }
});

// ── VALIDATION & FINALIZATION ─────────────────────────────────────────────────

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/validate
 * Run validation checks on a batch.
 */
router.post('/batch/:batchId/validate', authenticate, hasPermission('historical.finalize'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const result = await HistoricalComparativesService.validateBatch({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    if (error.message && error.message.includes('finalized')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] validateBatch error:', error);
    res.status(500).json({ error: 'Failed to validate batch.' });
  }
});

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/finalize
 * Permanently lock a validated batch. IRREVERSIBLE.
 * Requires the batch to be in 'validated' status first.
 */
router.post('/batch/:batchId/finalize', authenticate, hasPermission('historical.finalize'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const batch = await HistoricalComparativesService.finalizeBatch({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
    });
    res.json({ batch });
  } catch (error) {
    if (error.message && (error.message.includes('finalized') || error.message.includes('validated'))) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] finalizeBatch error:', error);
    res.status(500).json({ error: 'Failed to finalize batch.' });
  }
});

// ── REPORTS ───────────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/historical-comparatives/reports/monthly-pl
 * Monthly comparative P&L report across multiple financial years.
 * Query: financialYearStart, financialYearEnd, accountType (optional)
 */
router.get('/reports/monthly-pl', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { financialYearStart, financialYearEnd, accountType } = req.query;

    if (!financialYearStart || !financialYearEnd) {
      return res.status(400).json({ error: 'financialYearStart and financialYearEnd are required.' });
    }

    const report = await HistoricalComparativesService.getMonthlyPLReport({
      companyId: req.user.companyId,
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
      accountType: accountType || null,
    });

    res.json(report);
  } catch (error) {
    console.error('[HistoricalComparatives] getMonthlyPLReport error:', error);
    res.status(500).json({ error: 'Failed to generate monthly P&L report.' });
  }
});

/**
 * GET /api/accounting/historical-comparatives/reports/account-trend
 * Trend data for a specific account across multiple years.
 * Query: accountId, financialYearStart, financialYearEnd
 */
router.get('/reports/account-trend', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { accountId, financialYearStart, financialYearEnd } = req.query;

    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required.' });
    }
    if (!financialYearStart || !financialYearEnd) {
      return res.status(400).json({ error: 'financialYearStart and financialYearEnd are required.' });
    }

    const data = await HistoricalComparativesService.getAccountTrendReport({
      companyId: req.user.companyId,
      accountId: parseInt(accountId),
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
    });

    res.json({ data });
  } catch (error) {
    console.error('[HistoricalComparatives] getAccountTrendReport error:', error);
    res.status(500).json({ error: 'Failed to generate account trend report.' });
  }
});

/**
 * GET /api/accounting/historical-comparatives/dashboard/trends
 * Returns Chart.js-compatible trend data for dashboard chart widgets.
 *
 * Query params:
 *   metric       (required) — revenue|expenses|gross_profit|net_profit|account_trend|annual_summary
 *   fromYear     (required) — FY start inclusive
 *   toYear       (required) — FY end inclusive
 *   batchId      (optional) — narrow to a specific batch
 *   accountId    (optional) — required when metric=account_trend
 *   accountType  (optional) — extra account_type filter
 *   includeDraft (optional) — 'true' only honoured for admin/accountant roles
 *
 * SECURITY: company_id is always sourced from req.user.companyId — never from query params.
 * DATA CONTRACT: This endpoint is strictly read-only. It never writes to any live ledger table.
 */
router.get('/dashboard/trends', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { metric, fromYear, toYear, batchId, accountId, accountType, includeDraft } = req.query;

    if (!metric) {
      return res.status(400).json({ error: 'metric is required.' });
    }
    if (!fromYear || !toYear) {
      return res.status(400).json({ error: 'fromYear and toYear are required.' });
    }

    // Draft access: only honoured for admin/accountant who explicitly request it
    const canAccessDraft = ['admin', 'accountant'].includes(req.user.role);
    const finalizedOnly  = !(canAccessDraft && (includeDraft === 'true' || includeDraft === '1'));

    const data = await HistoricalComparativesService.getDashboardTrends({
      companyId:    req.user.companyId,
      metric:       String(metric),
      fromYear:     parseInt(fromYear),
      toYear:       parseInt(toYear),
      batchId:      batchId   || null,
      accountId:    accountId ? parseInt(accountId) : null,
      accountType:  accountType || null,
      finalizedOnly,
    });

    res.json(data);
  } catch (error) {
    if (error.message && (
      error.message.startsWith('Invalid metric') ||
      error.message.includes('required') ||
      error.message.includes('must be')
    )) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] getDashboardTrends error:', error);
    res.status(500).json({ error: 'Failed to load dashboard trend data.' });
  }
});

module.exports = router;
