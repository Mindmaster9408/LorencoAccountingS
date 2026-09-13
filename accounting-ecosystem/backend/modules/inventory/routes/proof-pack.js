'use strict';

/**
 * ============================================================================
 * Accountant Proof Pack — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/proof-pack
 *
 * ~25 separate report endpoints existed with no bundling — a caller had to
 * pull each one individually and stitch them together by hand every month.
 * This is a single endpoint returning one combined package for a date
 * range: stock valuation, count/variance history, transfer history, and
 * production variance/wastage/yield, plus this period's closed snapshot if
 * one exists (see routes/period-snapshots.js).
 *
 * GET /proof-pack?from=YYYY-MM-DD&to=YYYY-MM-DD&period_label=2026-08
 * ============================================================================
 */

const express = require('express');
const { requirePerm, PERM } = require('../permissions');
const {
  getStockValuationReport,
  getStockCountSessionsReport,
  getVarianceSummaryReport,
  getTransferHistoryReport,
} = require('../services/reportingService');

const router = express.Router();

router.get('/', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const supabase = req.supabase;
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = req.query.to   || now.toISOString().slice(0, 10);

  try {
    const [
      valuation,
      countSessions,
      varianceSummary,
      transfers,
      snapshotResult,
      productionVariances,
      wastage,
    ] = await Promise.all([
      getStockValuationReport(supabase, req.companyId, {}),
      getStockCountSessionsReport(supabase, req.companyId, { from_date: from, to_date: to }),
      getVarianceSummaryReport(supabase, req.companyId, { from_date: from, to_date: to }),
      getTransferHistoryReport(supabase, req.companyId, { from_date: from, to_date: to }),
      req.query.period_label
        ? supabase.from('inventory_period_snapshots').select('*').eq('company_id', req.companyId).eq('period_label', req.query.period_label).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('production_variances').select('*, work_orders:work_order_id(wo_number)')
        .eq('company_id', req.companyId).gte('created_at', from).lte('created_at', to + 'T23:59:59'),
      supabase.from('production_wastage').select('*, inventory_items:item_id(name, sku)')
        .eq('company_id', req.companyId).gte('created_at', from).lte('created_at', to + 'T23:59:59'),
    ]);

    res.json({
      generated_at:  new Date().toISOString(),
      period:        { from, to, period_label: req.query.period_label || null },
      closed_snapshot: snapshotResult.data || null,
      stock_valuation:  valuation.success ? valuation.report : null,
      stock_valuation_items: valuation.success ? valuation.items : [],
      stock_count_sessions:  countSessions.success ? countSessions.sessions : [],
      variance_summary:      varianceSummary.success ? varianceSummary : null,
      transfer_history:      transfers.success ? transfers.transfers : [],
      production_variances:  productionVariances.data || [],
      production_wastage:    wastage.data || [],
    });
  } catch (err) {
    console.error('[inventory proof-pack] error:', err.message);
    res.status(500).json({ error: 'Server error building proof pack' });
  }
});

module.exports = router;
