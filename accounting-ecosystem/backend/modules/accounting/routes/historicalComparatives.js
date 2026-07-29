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
const multer  = require('multer');
const XLSX    = require('xlsx');
const { authenticate, hasPermission } = require('../middleware/auth');
const HistoricalComparativesService = require('../services/historicalComparativesService');
const { supabase } = require('../../../config/database');

const router = express.Router();

// ─── Multer: memory storage, 15 MB limit, Excel/CSV only ────────────────────
// Same shape as legacy-gl.js's upload config — one file, parsed with `xlsx`
// (which transparently handles both CSV and Excel), never written to disk.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only Excel (.xlsx/.xls) and CSV files are accepted'));
  },
});

// Month-name → SA financial-year calendar month (1-12) lookup, case-insensitive.
// Accepts both full and abbreviated names so exports in any month order work.
const MONTH_NAME_TO_NUM = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// Parse a currency-ish cell into a signed float, or null if blank.
// Unlike legacy-gl's cleanAmount() (which always returns a positive value
// because debit/credit sign is caller-owned there), this preserves sign —
// historical comparative amounts are signed figures, not debit/credit pairs.
function parseSignedAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  let s = String(raw).trim();
  const isParenNeg = s.startsWith('(') && s.endsWith(')');
  if (isParenNeg) s = s.slice(1, -1);
  s = s.replace(/[^\d.\-]/g, '');
  const isTrailingMinus = s.endsWith('-');
  if (isTrailingMinus) s = s.slice(0, -1);
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return (isParenNeg || isTrailingMinus) ? -Math.abs(n) : n;
}

// Detect the header row and build a column map. Scans the first 10 rows for
// one containing BOTH an account-identity column (code or name) and a
// financial-year column — tolerates title/blank rows above the real header.
function detectCsvColumns(allRows) {
  const ACCOUNT_CODE_RE = /^(account[\s_-]?code|acc[\s_-]?code|code)$/i;
  const ACCOUNT_NAME_RE = /^(account[\s_-]?name|name)$/i;
  const ACCOUNT_TYPE_RE = /^(account[\s_-]?type|type)$/i;
  const FIN_YEAR_RE     = /^(financial[\s_-]?year|fy|year)$/i;

  const maxScan = Math.min(10, allRows.length);
  for (let i = 0; i < maxScan; i++) {
    const row = allRows[i];
    if (!row || row.length === 0) continue;

    const mapping = {};
    const monthCols = {}; // periodMonth (1-12) -> column index
    row.forEach((cell, idx) => {
      const h = String(cell || '').trim();
      if (!h) return;
      if (ACCOUNT_CODE_RE.test(h)) mapping.account_code = idx;
      else if (ACCOUNT_NAME_RE.test(h)) mapping.account_name = idx;
      else if (ACCOUNT_TYPE_RE.test(h)) mapping.account_type = idx;
      else if (FIN_YEAR_RE.test(h)) mapping.financial_year = idx;
      else {
        const m = MONTH_NAME_TO_NUM[h.toLowerCase()];
        if (m) monthCols[m] = idx;
      }
    });

    const hasAccountIdentity = mapping.account_code !== undefined || mapping.account_name !== undefined;
    if (hasAccountIdentity && mapping.financial_year !== undefined && Object.keys(monthCols).length > 0) {
      return { headerRowIdx: i, mapping, monthCols };
    }
  }
  return null;
}

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
    // Include error.message (not stack) so the frontend can show a useful detail.
    res.status(500).json({ error: 'Failed to search accounts.', detail: error.message });
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

// ── CSV BULK IMPORT ───────────────────────────────────────────────────────────

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/import-csv
 * Bulk-import monthly account balances from a CSV/Excel file.
 * One row = one account × one financial year, with up to 12 month columns
 * (matched by name, any order). Each valid row is saved via the existing
 * saveManualGrid() — same transactional upsert used by the manual grid UI.
 * multipart/form-data, field name 'file'.
 */
router.post('/batch/:batchId/import-csv', authenticate, hasPermission('historical.create'),
  csvUpload.single('file'),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const companyId = req.user.companyId;

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const batch = await HistoricalComparativesService.getBatch({ companyId, batchId });
      if (!batch) return res.status(404).json({ error: 'Batch not found or access denied.' });
      if (batch.status === 'finalized') {
        return res.status(403).json({ error: 'This batch is finalized and cannot be edited.' });
      }

      let workbook;
      try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, raw: false });
      } catch (err) {
        return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
      }

      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ error: 'File contains no sheets.' });

      const allRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
      if (allRows.length < 2) {
        return res.status(400).json({ error: 'File must have at least one header row and one data row.' });
      }

      const detection = detectCsvColumns(allRows);
      if (!detection) {
        return res.status(422).json({
          error: 'Could not detect the required columns from this file.',
          hint: 'Expected an Account Code or Account Name column, a Financial Year column, and at least one month column (e.g. Mar, Apr, ... Feb).',
        });
      }

      const { headerRowIdx, mapping, monthCols } = detection;
      const dataRows = allRows.slice(headerRowIdx + 1);

      // Parse every data row into a candidate (account × FY) grid before any DB writes.
      const candidates = [];
      const rowErrors = [];
      let totalDataRows = 0;
      dataRows.forEach((row, i) => {
        if (!row || row.every(c => c === '' || c == null)) return; // blank row
        totalDataRows++;
        const rowNumber = headerRowIdx + i + 2; // 1-indexed, accounts for header row

        const accountCode = mapping.account_code !== undefined ? String(row[mapping.account_code] || '').trim() || null : null;
        const accountName = mapping.account_name !== undefined ? String(row[mapping.account_name] || '').trim() || null : null;
        const accountType = mapping.account_type !== undefined ? String(row[mapping.account_type] || '').trim() || null : null;
        const financialYear = parseInt(row[mapping.financial_year], 10);

        if (!accountCode && !accountName) {
          rowErrors.push({ row: rowNumber, message: 'No account code or account name — cannot identify the account.' });
          return;
        }
        if (!financialYear || isNaN(financialYear)) {
          rowErrors.push({ row: rowNumber, message: 'Missing or invalid financial year.' });
          return;
        }

        const cells = [];
        for (const [month, colIdx] of Object.entries(monthCols)) {
          const amount = parseSignedAmount(row[colIdx]);
          if (amount !== null) cells.push({ periodMonth: parseInt(month, 10), amount });
        }
        if (cells.length === 0) {
          rowErrors.push({ row: rowNumber, message: 'No month amounts found on this row — skipped.' });
          return;
        }

        candidates.push({
          rowNumber, accountCode, accountName: accountName || accountCode, accountType, financialYear, cells,
        });
      });

      // Bulk-resolve account codes against the Chart of Accounts in one query,
      // instead of a lookup per row.
      const codes = [...new Set(candidates.map(c => c.accountCode).filter(Boolean))];
      let codeToId = {};
      if (codes.length > 0) {
        const { data: matched, error: lookupErr } = await supabase
          .from('accounts')
          .select('id, code')
          .eq('company_id', companyId)
          .in('code', codes);
        if (lookupErr) throw lookupErr;
        for (const a of matched || []) codeToId[a.code] = a.id;
      }

      let imported = 0;
      const accountsMatched = new Set();
      const accountsUnmatched = new Set();

      for (const c of candidates) {
        const accountId = c.accountCode ? (codeToId[c.accountCode] || null) : null;
        if (c.accountCode) {
          (accountId ? accountsMatched : accountsUnmatched).add(c.accountCode);
        }
        try {
          await HistoricalComparativesService.saveManualGrid({
            companyId, batchId, userId: req.user.id,
            accountId, accountCode: c.accountCode, accountName: c.accountName,
            accountType: c.accountType, financialYear: c.financialYear, cells: c.cells,
          });
          imported++;
        } catch (err) {
          if (err.message && err.message.includes('finalized')) {
            return res.status(403).json({ error: err.message });
          }
          rowErrors.push({ row: c.rowNumber, message: err.message });
        }
      }

      res.json({
        imported,
        totalRows: totalDataRows,
        accountsMatched: [...accountsMatched],
        accountsUnmatched: [...accountsUnmatched],
        errors: rowErrors,
      });
    } catch (error) {
      console.error('[HistoricalComparatives] import-csv error:', error);
      res.status(500).json({ error: 'Failed to import file.', detail: error.message });
    }
  }
);

// ── RESCALE ───────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/historical-comparatives/batch/:batchId/rescale
 * Divide all line amounts for a draft/validated batch by a given divisor.
 * Used to fix amounts that were stored at 100× scale due to a parseCurrency bug.
 * Body: { divisor: 100 }
 * Only permitted on non-finalized batches.
 */
router.post('/batch/:batchId/rescale', authenticate, hasPermission('historical.create'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const { divisor } = req.body;

    const d = parseFloat(divisor);
    if (!d || d <= 0 || d > 1000) {
      return res.status(400).json({ error: 'divisor must be a positive number up to 1000.' });
    }

    const result = await HistoricalComparativesService.rescaleBatchAmounts({
      companyId: req.user.companyId,
      batchId,
      userId: req.user.id,
      divisor: d,
    });

    res.json(result);
  } catch (error) {
    if (error.message && error.message.includes('finalized')) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] rescaleBatchAmounts error:', error);
    res.status(500).json({ error: 'Failed to rescale batch amounts.' });
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
    if (error.statusCode === 422) {
      return res.status(422).json({ error: error.message });
    }
    if (error.message && (error.message.includes('finalized') || error.message.includes('validated'))) {
      return res.status(403).json({ error: error.message });
    }
    console.error('[HistoricalComparatives] finalizeBatch error:', error);
    res.status(500).json({ error: 'Failed to finalize batch.' });
  }
});

// ── REPORTS ───────────────────────────────────────────────────────────────────

// Roles permitted to request draft/unfinalized data in report endpoints.
const DRAFT_REPORT_ROLES = ['business_owner', 'accountant', 'practice_manager', 'admin', 'super_admin'];

/**
 * GET /api/accounting/historical-comparatives/reports/monthly-pl
 * Monthly comparative P&L report across multiple financial years.
 * Query: financialYearStart, financialYearEnd, accountType (optional),
 *        statusMode (optional: finalized_only|draft_preview|all),
 *        batchId    (optional: UUID — narrows to a specific batch)
 *
 * SECURITY: statusMode other than 'finalized_only' requires DRAFT_REPORT_ROLES.
 * IMMUTABILITY: strictly read-only — no writes to any live ledger table.
 */
router.get('/reports/monthly-pl', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { financialYearStart, financialYearEnd, accountType, statusMode, batchId } = req.query;

    if (!financialYearStart || !financialYearEnd) {
      return res.status(400).json({ error: 'financialYearStart and financialYearEnd are required.' });
    }

    const VALID_MODES = ['finalized_only', 'draft_preview', 'all'];
    const resolvedMode = VALID_MODES.includes(statusMode) ? statusMode : 'finalized_only';

    if (resolvedMode !== 'finalized_only' && !DRAFT_REPORT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Draft preview access requires accountant or admin role.' });
    }

    const report = await HistoricalComparativesService.getMonthlyPLReport({
      companyId: req.user.companyId,
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
      accountType: accountType || null,
      statusMode: resolvedMode,
      batchId: batchId || null,
    });

    res.json(report);
  } catch (error) {
    console.error('[HistoricalComparatives] getMonthlyPLReport error:', error);
    res.status(500).json({ error: 'Failed to generate monthly P&L report.' });
  }
});

/**
 * GET /api/accounting/historical-comparatives/reports/tb-comparative
 * TB-style comparative report: annual totals per account, grouped by account type.
 * Query: financialYearStart, financialYearEnd,
 *        statusMode (optional: finalized_only|draft_preview|all),
 *        batchId    (optional: UUID)
 *
 * SECURITY: statusMode other than 'finalized_only' requires DRAFT_REPORT_ROLES.
 * IMMUTABILITY: strictly read-only.
 */
router.get('/reports/tb-comparative', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { financialYearStart, financialYearEnd, statusMode, batchId } = req.query;

    if (!financialYearStart || !financialYearEnd) {
      return res.status(400).json({ error: 'financialYearStart and financialYearEnd are required.' });
    }

    const VALID_MODES = ['finalized_only', 'draft_preview', 'all'];
    const resolvedMode = VALID_MODES.includes(statusMode) ? statusMode : 'finalized_only';

    if (resolvedMode !== 'finalized_only' && !DRAFT_REPORT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Draft preview access requires accountant or admin role.' });
    }

    const report = await HistoricalComparativesService.getTBStyleComparativeReport({
      companyId: req.user.companyId,
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
      statusMode: resolvedMode,
      batchId: batchId || null,
    });

    res.json(report);
  } catch (error) {
    console.error('[HistoricalComparatives] getTBStyleComparativeReport error:', error);
    res.status(500).json({ error: 'Failed to generate TB comparative report.' });
  }
});

/**
 * GET /api/accounting/historical-comparatives/reports/multi-year
 * Multi-year comparative: annual totals per account across year range.
 * Frontend adds YoY % change columns from the returned data.
 * Query: financialYearStart, financialYearEnd, accountType (optional),
 *        statusMode (optional: finalized_only|draft_preview|all),
 *        batchId    (optional: UUID)
 *
 * SECURITY: statusMode other than 'finalized_only' requires DRAFT_REPORT_ROLES.
 * IMMUTABILITY: strictly read-only.
 */
router.get('/reports/multi-year', authenticate, hasPermission('historical.view'), async (req, res) => {
  try {
    const { financialYearStart, financialYearEnd, accountType, statusMode, batchId } = req.query;

    if (!financialYearStart || !financialYearEnd) {
      return res.status(400).json({ error: 'financialYearStart and financialYearEnd are required.' });
    }

    const VALID_MODES = ['finalized_only', 'draft_preview', 'all'];
    const resolvedMode = VALID_MODES.includes(statusMode) ? statusMode : 'finalized_only';

    if (resolvedMode !== 'finalized_only' && !DRAFT_REPORT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Draft preview access requires accountant or admin role.' });
    }

    const report = await HistoricalComparativesService.getMultiYearComparativeReport({
      companyId: req.user.companyId,
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
      accountType: accountType || null,
      statusMode: resolvedMode,
      batchId: batchId || null,
    });

    res.json(report);
  } catch (error) {
    console.error('[HistoricalComparatives] getMultiYearComparativeReport error:', error);
    res.status(500).json({ error: 'Failed to generate multi-year comparative report.' });
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
