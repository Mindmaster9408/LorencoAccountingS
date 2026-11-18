'use strict';

/**
 * ============================================================================
 * Paytime — historical payslip import API (spec 12)
 * ============================================================================
 *   GET  /api/payroll/historical-import/setup          payroll items + suggested column mapping
 *   POST /api/payroll/historical-import                { rows, mapping, file_name, accept_mismatch, dry_run }
 *   GET  /api/payroll/historical-import/batches        imports of this company (newest first)
 *   POST /api/payroll/historical-import/batches/:id/undo   { reason }   (HI-05)
 *
 * Imported months become locked payroll_snapshots (source = 'screen_import'),
 * never recalculated. See services/historicalImport.js and
 * docs/paytime/HI_IMPORT_REBUILD_CHANGE_IMPACT_NOTE.md.
 * ============================================================================
 */

const express = require('express');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePaytimeModule } = require('../services/paytimeAccess');
const { supabase } = require('../../../config/database');
const HistoricalImport = require('../services/historicalImport');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const MAX_ROWS = 5000;

/** GET /setup?columns=a,b,c — items for the mapping dropdowns + suggested targets. */
router.get('/setup', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const masters = (await HistoricalImport.loadMasters(supabase, req.companyId)).filter(m => m.is_active !== false);
    const columns = String(req.query.columns || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);

    // Last batch's mapping is the default for the same column next time.
    let lastMapping = {};
    try {
      const batches = await HistoricalImport.listBatches(supabase, req.companyId);
      const withMap = batches.find(b => b.mapping && typeof b.mapping === 'object');
      if (withMap) lastMapping = withMap.mapping;
    } catch (_) { /* suggestion only */ }

    const suggestions = {};
    columns.forEach(c => {
      const prev = lastMapping[c];
      const prevValid = prev && (prev.target !== 'item' || masters.some(m => String(m.id) === String(prev.master_item_id)));
      suggestions[c] = Object.assign({ side: HistoricalImport.columnSide(c), label: HistoricalImport.columnLabel(c) },
        prevValid ? Object.assign({}, prev, { from: 'last_import' }) : HistoricalImport.suggestTarget(c, masters));
    });
    res.json({ success: true, items: masters, suggestions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

/** POST / — validate (dry_run: true) or import. */
router.post('/', requirePermission('PAYROLL.PROCESS'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const { rows, mapping, file_name, accept_mismatch, dry_run } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ success: false, error: 'rows are required' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ success: false, error: `At most ${MAX_ROWS} rows per import` });
    if (mapping != null && (typeof mapping !== 'object' || Array.isArray(mapping))) {
      return res.status(400).json({ success: false, error: 'mapping must be an object' });
    }

    const result = await HistoricalImport.runImport(supabase, {
      companyId: req.companyId,
      userId: req.user && req.user.userId,
      rows,
      mapping: mapping || {},
      fileName: file_name ? String(file_name).slice(0, 200) : null,
      acceptMismatch: accept_mismatch === true,
      dryRun: dry_run === true
    });

    if (!result.dry_run && result.summary.ok > 0) {
      await auditFromReq(req, 'CREATE', 'payroll_historical_import', result.batch_id, {
        file_name: file_name || null,
        imported: result.summary.ok,
        skipped: result.summary.skipped,
        errors: result.summary.errors,
        periods: result.summary.periods,
        totals: result.summary.totals,
        accept_mismatch: accept_mismatch === true
      });
    }
    res.json(Object.assign({ success: true }, result));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

/** GET /batches */
router.get('/batches', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const batches = await HistoricalImport.listBatches(supabase, req.companyId);
    res.json({ success: true, batches: batches.map(b => { const c = Object.assign({}, b); delete c.mapping; return c; }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

/** POST /batches/:id/undo { reason } */
router.post('/batches/:id/undo', requirePermission('PAYROLL.PROCESS'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const batchId = String(req.params.id || '');
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) return res.status(400).json({ success: false, error: 'Invalid import id' });
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'A reason is required to undo an import' });

    const result = await HistoricalImport.undoBatch(supabase, { companyId: req.companyId, userId: req.user && req.user.userId, batchId });
    if (result.notFound) return res.status(404).json({ success: false, error: 'Import not found, or already undone' });

    await auditFromReq(req, 'DELETE', 'payroll_historical_import', batchId, {
      action: 'undo_import',
      reason,
      reversed: result.reversed.length,
      blocked: result.blocked
    });
    res.json({ success: true, reversed: result.reversed.length, blocked: result.blocked });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

module.exports = router;
