'use strict';

/**
 * ============================================================================
 * Paytime — bulk import of one month's variable inputs (Ruan 2026-11-22)
 * ============================================================================
 *   GET  /api/payroll/bulk-inputs/setup?columns=a,b,c   input items, suggested mapping, recent periods
 *   POST /api/payroll/bulk-inputs                        { period_key, rows, mapping, file_name, dry_run }
 *
 * Writes current inputs / overtime / short time exactly as the payslip screen does
 * (same permission PAYROLL.CREATE, same replacePeriodRows path). See services/bulkInputs.js.
 * ============================================================================
 */

const express = require('express');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePaytimeModule } = require('../services/paytimeAccess');
const { supabase } = require('../../../config/database');
const BulkInputs = require('../services/bulkInputs');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const MAX_ROWS = 2000;
const MAX_COLUMNS = 100;

router.get('/setup', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const masters = (await BulkInputs.loadMasters(supabase, req.companyId))
      .filter(m => m.is_active !== false && BulkInputs.inputSide(m));
    const columns = String(req.query.columns || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_COLUMNS);
    const suggestions = {};
    columns.forEach(c => { suggestions[c] = BulkInputs.suggestTarget(c, masters); });
    const { data: periods } = await supabase.from('payroll_periods').select('period_key, start_date, end_date')
      .eq('company_id', req.companyId).order('period_key', { ascending: false }).limit(12);
    res.json({ success: true,
      items: masters.map(m => ({ id: m.id, item_name: m.item_name, side: BulkInputs.inputSide(m), irp5_code: m.irp5_code })),
      suggestions, periods: periods || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const { period_key, rows, mapping, file_name, dry_run } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ success: false, error: 'rows are required' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ success: false, error: `At most ${MAX_ROWS} rows per import` });
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length > MAX_COLUMNS) {
      return res.status(400).json({ success: false, error: 'mapping must be an object (column → target)' });
    }
    const result = await BulkInputs.runBulkInputs(supabase, {
      companyId: req.companyId, periodKey: period_key, rows, mapping, dryRun: dry_run === true
    });
    if (!result.dry_run && (result.written || []).length) {
      await auditFromReq(req, 'CREATE', 'payroll_bulk_inputs', String(period_key), {
        file_name: file_name ? String(file_name).slice(0, 200) : null,
        period_key, employees: result.written.length, failed: (result.failed || []).length,
        entries: result.summary.entries, totals: result.totals,
        mapping
      });
    }
    res.json(Object.assign({ success: true }, result));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error' });
  }
});

module.exports = router;
