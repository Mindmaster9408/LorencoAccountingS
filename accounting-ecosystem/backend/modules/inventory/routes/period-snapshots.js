'use strict';

/**
 * ============================================================================
 * Inventory Period-End Snapshots — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/period-snapshots
 *
 * Closing a period computes the full stock valuation at that moment and
 * writes one immutable row (migration 169 adds DB triggers blocking any
 * UPDATE/DELETE — same pattern as pos_recon_snapshots and audit_log). This
 * is the "proof" that stock value at period-end was X, permanently — the
 * live valuation can keep moving afterward without ever being able to
 * rewrite what was reported for a closed period.
 *
 * Endpoints:
 *   GET  /period-snapshots           — list closed periods
 *   GET  /period-snapshots/:label    — one closed period's full detail
 *   POST /period-snapshots           — close a period (body: { period_label, period_start, period_end })
 * ============================================================================
 */

const express = require('express');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePerm, PERM } = require('../permissions');
const { getStockValuationReport } = require('../services/reportingService');

const router = express.Router();

router.get('/', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const supabase = req.supabase;
  const { data, error } = await supabase
    .from('inventory_period_snapshots')
    .select('id, period_label, period_start, period_end, total_stock_value, total_items_counted, open_work_orders, open_purchase_orders, closed_by_user_id, created_at')
    .eq('company_id', req.companyId)
    .order('period_end', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ snapshots: data || [] });
});

router.get('/:label', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const supabase = req.supabase;
  const { data, error } = await supabase
    .from('inventory_period_snapshots')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('period_label', req.params.label)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Period snapshot not found' });
  res.json({ snapshot: data });
});

router.post('/', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const supabase = req.supabase;
  const { period_label, period_start, period_end } = req.body;

  if (!period_label || !period_start || !period_end) {
    return res.status(400).json({ error: 'period_label, period_start, and period_end are required' });
  }

  const { data: existing } = await supabase
    .from('inventory_period_snapshots')
    .select('id')
    .eq('company_id', req.companyId)
    .eq('period_label', period_label)
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ error: `Period "${period_label}" is already closed and cannot be re-closed.` });
  }

  const valuation = await getStockValuationReport(supabase, req.companyId, {});
  if (!valuation.success) return res.status(500).json({ error: valuation.error });

  const [{ count: openWoCount }, { count: openPoCount }] = await Promise.all([
    supabase.from('work_orders').select('id', { count: 'exact', head: true })
      .eq('company_id', req.companyId).in('status', ['draft', 'released', 'in_progress', 'paused']),
    supabase.from('purchase_orders').select('id', { count: 'exact', head: true })
      .eq('company_id', req.companyId).in('status', ['draft', 'approved']),
  ]);

  const { data: snapshot, error } = await supabase
    .from('inventory_period_snapshots')
    .insert({
      company_id:           req.companyId,
      period_label,
      period_start,
      period_end,
      total_stock_value:    valuation.report.grand_total,
      total_items_counted:  valuation.report.total_items,
      open_work_orders:     openWoCount || 0,
      open_purchase_orders: openPoCount || 0,
      snapshot_data:        { report: valuation.report, items: valuation.items },
      closed_by_user_id:    req.user.userId,
    })
    .select('id, period_label, period_start, period_end, total_stock_value, total_items_counted, open_work_orders, open_purchase_orders, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CREATE', 'inventory_period_snapshot', snapshot.id, {
    module: 'inventory',
    metadata: { period_label, total_stock_value: snapshot.total_stock_value },
  });

  res.status(201).json({ snapshot });
});

module.exports = router;
