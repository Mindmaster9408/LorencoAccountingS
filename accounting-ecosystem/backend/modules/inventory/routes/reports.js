/**
 * ============================================================================
 * Inventory Reports Routes — Phase 2A Costing
 * ============================================================================
 * Endpoints:
 *   GET /reports/stock-valuation         — current stock value per item
 *   GET /reports/cost-history/:itemId    — cost change history for one item
 *   GET /reports/valuation-movements     — forensic cost ledger (date range)
 *   GET /reports/work-order-cost-summary — WO cost breakdown
 * ============================================================================
 * All endpoints are company-scoped via req.companyId.
 * All data sourced from Phase 2A tables — no recalculation from live sales.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const costingService = require('../services/costingService');

const router = express.Router();

// ─── GET /reports/stock-valuation ────────────────────────────────────────────
// Returns current stock value per item: qty × average_cost.
// Query params:
//   category  — filter by item category (optional)
//   min_value — hide items with total_value below threshold (optional)
router.get('/stock-valuation', async (req, res) => {
  try {
    const { category, min_value } = req.query;

    let rows = await costingService.getStockValuation(supabase, req.companyId);

    if (category) {
      rows = rows.filter(r => r.category === category);
    }
    if (min_value) {
      const threshold = parseFloat(min_value);
      if (!isNaN(threshold)) rows = rows.filter(r => r.totalValue >= threshold);
    }

    const grandTotal = rows.reduce((sum, r) => sum + r.totalValue, 0);
    const totalItems = rows.length;
    const zeroValueItems = rows.filter(r => r.unitCost === 0).length;

    res.json({
      report: {
        generated_at: new Date().toISOString(),
        total_items:  totalItems,
        grand_total:  grandTotal,
        zero_cost_items: zeroValueItems
      },
      items: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /reports/cost-history/:itemId ───────────────────────────────────────
// Returns audit trail of cost changes for a single item.
// Query params:
//   from  — ISO date string (optional, defaults to 90 days ago)
//   to    — ISO date string (optional, defaults to now)
//   limit — max rows (optional, default 200)
router.get('/cost-history/:itemId', async (req, res) => {
  const itemId = parseInt(req.params.itemId);
  if (isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  const { from, to, limit = 200 } = req.query;
  const dateFrom = from
    ? new Date(from).toISOString()
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const dateTo = to ? new Date(to).toISOString() : new Date().toISOString();

  // Verify item belongs to this company
  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, average_cost, cost_price, costing_method')
    .eq('id', itemId)
    .eq('company_id', req.companyId)
    .single();
  if (itemErr || !item) return res.status(404).json({ error: 'Item not found' });

  const { data: history, error } = await supabase
    .from('item_cost_history')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('item_id', itemId)
    .gte('changed_at', dateFrom)
    .lte('changed_at', dateTo)
    .order('changed_at', { ascending: false })
    .limit(parseInt(limit));

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    item: {
      id:            item.id,
      name:          item.name,
      sku:           item.sku,
      current_avg:   parseFloat(item.average_cost) || parseFloat(item.cost_price) || 0,
      costing_method: item.costing_method || 'average'
    },
    history: history || []
  });
});

// ─── GET /reports/valuation-movements ────────────────────────────────────────
// Returns the forensic valuation ledger for a date range.
// Query params:
//   from         — ISO date string (required)
//   to           — ISO date string (optional, defaults to now)
//   item_id      — filter to one item (optional)
//   source_type  — filter by source: po_receive | wo_issue | wo_complete | manual (optional)
//   limit        — max rows (default 500, max 1000)
router.get('/valuation-movements', async (req, res) => {
  const { from, to, item_id, source_type, limit = 500 } = req.query;

  if (!from) return res.status(400).json({ error: 'from date is required' });

  const dateFrom = new Date(from).toISOString();
  const dateTo   = to ? new Date(to).toISOString() : new Date().toISOString();
  const maxRows  = Math.min(parseInt(limit) || 500, 1000);

  let q = supabase
    .from('stock_valuation_movements')
    .select(`
      id, movement_type, qty, unit_cost, total_cost,
      running_avg_cost, running_qty,
      reference, source_type, source_id, movement_id,
      created_at, created_by,
      inventory_items:item_id (id, name, sku, category)
    `)
    .eq('company_id', req.companyId)
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo)
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (item_id) q = q.eq('item_id', parseInt(item_id));
  if (source_type) q = q.eq('source_type', source_type);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const totalCost = rows.reduce((sum, r) => sum + (parseFloat(r.total_cost) || 0), 0);

  res.json({
    report: {
      generated_at: new Date().toISOString(),
      date_from:    dateFrom,
      date_to:      dateTo,
      row_count:    rows.length,
      total_cost_moved: totalCost
    },
    movements: rows
  });
});

// ─── GET /reports/work-order-cost-summary ────────────────────────────────────
// Returns cost breakdown for work orders.
// Query params:
//   status  — open | finalized | all (default all)
//   from    — filter by WO created_at (optional)
//   to      — filter by WO created_at (optional)
//   limit   — max rows (default 200)
router.get('/work-order-cost-summary', async (req, res) => {
  const { status, from, to, limit = 200 } = req.query;

  let q = supabase
    .from('work_order_costs')
    .select(`
      id, material_cost, labor_cost, overhead_cost,
      completed_qty, unit_cost, status, finalized_at,
      created_at, updated_at,
      work_orders:work_order_id (
        id, reference_number, status,
        quantity_to_produce, quantity_produced,
        inventory_items:item_id (id, name, sku)
      )
    `)
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false })
    .limit(parseInt(limit) || 200);

  if (status && status !== 'all') q = q.eq('status', status);
  if (from) q = q.gte('created_at', new Date(from).toISOString());
  if (to)   q = q.lte('created_at', new Date(to).toISOString());

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const summary = {
    total_wos:       rows.length,
    finalized_wos:   rows.filter(r => r.status === 'finalized').length,
    open_wos:        rows.filter(r => r.status === 'open').length,
    total_material:  rows.reduce((s, r) => s + (parseFloat(r.material_cost) || 0), 0),
    total_labor:     rows.reduce((s, r) => s + (parseFloat(r.labor_cost) || 0), 0),
    total_overhead:  rows.reduce((s, r) => s + (parseFloat(r.overhead_cost) || 0), 0)
  };
  summary.grand_total = summary.total_material + summary.total_labor + summary.total_overhead;

  res.json({
    report: {
      generated_at: new Date().toISOString(),
      ...summary
    },
    work_orders: rows
  });
});

module.exports = router;
