/**
 * ============================================================================
 * Inventory Reports Routes — Phase 2A Costing
 * ============================================================================
 * Endpoints:
 *   GET /reports/stock-valuation         — current stock value per item
 *   GET /reports/cost-history/:itemId    — cost change history for one item
 *   GET /reports/valuation-movements     — forensic cost ledger (date range)
 *   GET /reports/work-order-cost-summary — WO cost breakdown
 *   GET /reports/stock-counts            — count session summary (Codebox 03)
 *   GET /reports/variance-summary        — variance aggregate by reason/type (Codebox 03)
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
    const { category, item_type, min_value, low_stock, missing_cost, search } = req.query;

    let rows = await costingService.getStockValuation(supabase, req.companyId);

    if (category) {
      rows = rows.filter(r => r.category === category);
    }
    if (item_type) {
      rows = rows.filter(r => r.itemType === item_type);
    }
    if (min_value) {
      const threshold = parseFloat(min_value);
      if (!isNaN(threshold)) rows = rows.filter(r => r.totalValue >= threshold);
    }
    if (low_stock === 'true') {
      rows = rows.filter(r => r.currentStock <= r.minStock);
    }
    if (missing_cost === 'true') {
      rows = rows.filter(r => !r.hasCost || r.unitCost === 0);
    }
    if (search) {
      const term = String(search).toLowerCase();
      rows = rows.filter(r =>
        (r.name || '').toLowerCase().includes(term) ||
        (r.sku || '').toLowerCase().includes(term)
      );
    }

    const grandTotal = rows.reduce((sum, r) => sum + r.totalValue, 0);
    const totalItems = rows.length;
    const zeroValueItems = rows.filter(r => r.unitCost === 0).length;
    const lowStockItems = rows.filter(r => r.currentStock <= r.minStock).length;
    const rawMaterialValue   = rows.filter(r => r.itemType === 'raw_material').reduce((sum, r) => sum + r.totalValue, 0);
    const finishedGoodsValue = rows.filter(r => r.itemType === 'finished_good').reduce((sum, r) => sum + r.totalValue, 0);
    const consumablesValue   = rows.filter(r => r.itemType === 'consumable').reduce((sum, r) => sum + r.totalValue, 0);
    const subAssemblyValue   = rows.filter(r => r.itemType === 'sub_assembly').reduce((sum, r) => sum + r.totalValue, 0);
    const missingCostItems   = rows.filter(r => !r.hasCost || r.unitCost === 0).length;

    res.json({
      report: {
        generated_at: new Date().toISOString(),
        total_items:  totalItems,
        grand_total:  grandTotal,
        zero_cost_items: zeroValueItems,
        raw_material_value:   rawMaterialValue,
        finished_goods_value: finishedGoodsValue,
        consumables_value:    consumablesValue,
        sub_assembly_value:   subAssemblyValue,
        low_stock_count: lowStockItems,
        missing_cost_items: missingCostItems
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

// ─── GET /reports/stock-counts ───────────────────────────────────────────────
// Stock count session summary report: list of sessions with line counts,
// variance totals, and applied status.
// Query params: status, from_date, to_date, limit
router.get('/stock-counts', async (req, res) => {
  try {
    const { status, from_date, to_date, limit = 100 } = req.query;

    let query = supabase
      .from('stock_count_sessions')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 100, 500));

    if (status)    query = query.eq('status', status);
    if (from_date) query = query.gte('created_at', from_date);
    if (to_date)   query = query.lte('created_at', to_date);

    const { data: sessions, error: sessErr } = await query;
    if (sessErr) return res.status(500).json({ error: sessErr.message });

    if (!sessions || sessions.length === 0) {
      return res.json({ report: { generated_at: new Date().toISOString(), total_sessions: 0 }, sessions: [] });
    }

    const sessionIds = sessions.map(s => s.id);

    // Fetch line-level variance totals per session
    const { data: lines } = await supabase
      .from('stock_count_lines')
      .select('session_id, counted_quantity, variance_quantity, variance_value')
      .eq('company_id', req.companyId)
      .in('session_id', sessionIds);

    const lineMap = {};
    for (const row of lines || []) {
      if (!lineMap[row.session_id]) {
        lineMap[row.session_id] = { total: 0, counted: 0, variance_value: 0, variant_count: 0 };
      }
      lineMap[row.session_id].total++;
      if (row.counted_quantity !== null) lineMap[row.session_id].counted++;
      if (row.variance_quantity !== null && row.variance_quantity !== 0) {
        lineMap[row.session_id].variant_count++;
        lineMap[row.session_id].variance_value += parseFloat(row.variance_value) || 0;
      }
    }

    const enriched = sessions.map(s => ({
      ...s,
      line_count:          (lineMap[s.id] || {}).total         || 0,
      counted_count:       (lineMap[s.id] || {}).counted       || 0,
      variant_count:       (lineMap[s.id] || {}).variant_count || 0,
      total_variance_value: (lineMap[s.id] || {}).variance_value || 0,
    }));

    const totalVarianceValue = enriched.reduce((sum, s) => sum + s.total_variance_value, 0);

    res.json({
      report: {
        generated_at:        new Date().toISOString(),
        total_sessions:      enriched.length,
        total_variance_value: totalVarianceValue,
        applied_count:       enriched.filter(s => s.status === 'applied').length,
        pending_count:       enriched.filter(s => ['submitted', 'approved'].includes(s.status)).length,
      },
      sessions: enriched,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /reports/variance-summary ───────────────────────────────────────────
// Aggregate variance by reason, item type, and date range.
// Applied sessions only (status='applied').
// Query params: from_date, to_date
router.get('/variance-summary', async (req, res) => {
  try {
    const { from_date, to_date } = req.query;

    // Get applied sessions in range
    let sessionQuery = supabase
      .from('stock_count_sessions')
      .select('id, session_number, applied_at')
      .eq('company_id', req.companyId)
      .eq('status', 'applied');

    if (from_date) sessionQuery = sessionQuery.gte('applied_at', from_date);
    if (to_date)   sessionQuery = sessionQuery.lte('applied_at', to_date);

    const { data: sessions, error: sessErr } = await sessionQuery;
    if (sessErr) return res.status(500).json({ error: sessErr.message });

    if (!sessions || sessions.length === 0) {
      return res.json({
        report:           { generated_at: new Date().toISOString(), total_variance_value: 0 },
        by_reason:        [],
        by_item_type:     [],
        top_variance_items: [],
      });
    }

    const sessionIds = sessions.map(s => s.id);

    // Fetch all lines with variance from these sessions
    const { data: lines, error: linesErr } = await supabase
      .from('stock_count_lines')
      .select('session_id, item_id, variance_quantity, variance_value, variance_reason, average_cost, inventory_items:item_id(name, sku, item_type)')
      .eq('company_id', req.companyId)
      .in('session_id', sessionIds)
      .not('variance_quantity', 'is', null);

    if (linesErr) return res.status(500).json({ error: linesErr.message });

    const variantLines = (lines || []).filter(l => parseFloat(l.variance_quantity) !== 0);

    // Aggregate by reason
    const byReason = {};
    for (const l of variantLines) {
      const reason = l.variance_reason || 'unspecified';
      if (!byReason[reason]) byReason[reason] = { reason, count: 0, total_variance_value: 0 };
      byReason[reason].count++;
      byReason[reason].total_variance_value += parseFloat(l.variance_value) || 0;
    }

    // Aggregate by item_type
    const byItemType = {};
    for (const l of variantLines) {
      const itemType = l.inventory_items?.item_type || 'unknown';
      if (!byItemType[itemType]) byItemType[itemType] = { item_type: itemType, count: 0, total_variance_value: 0 };
      byItemType[itemType].count++;
      byItemType[itemType].total_variance_value += parseFloat(l.variance_value) || 0;
    }

    // Top 10 items by absolute variance value
    const itemMap = {};
    for (const l of variantLines) {
      const key = l.item_id;
      if (!itemMap[key]) {
        itemMap[key] = {
          item_id:   l.item_id,
          name:      l.inventory_items?.name  || 'Unknown',
          sku:       l.inventory_items?.sku   || null,
          item_type: l.inventory_items?.item_type || null,
          total_variance_value: 0,
          count: 0,
        };
      }
      itemMap[key].count++;
      itemMap[key].total_variance_value += parseFloat(l.variance_value) || 0;
    }

    const topItems = Object.values(itemMap)
      .sort((a, b) => Math.abs(b.total_variance_value) - Math.abs(a.total_variance_value))
      .slice(0, 10);

    const totalVarianceValue = variantLines.reduce((sum, l) => sum + (parseFloat(l.variance_value) || 0), 0);

    res.json({
      report: {
        generated_at:        new Date().toISOString(),
        applied_sessions:    sessions.length,
        total_variant_lines: variantLines.length,
        total_variance_value: totalVarianceValue,
      },
      by_reason:          Object.values(byReason).sort((a, b) => Math.abs(b.total_variance_value) - Math.abs(a.total_variance_value)),
      by_item_type:       Object.values(byItemType),
      top_variance_items: topItems,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
