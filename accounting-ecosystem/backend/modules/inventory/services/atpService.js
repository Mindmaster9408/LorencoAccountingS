'use strict';

/**
 * atpService — Codebox 09 Available To Promise (ATP) Engine
 *
 * ATP answers:
 *   - How much of item X can be promised to a new customer right now?
 *   - How much will be available by a target date?
 *   - What is the future demand profile for this item?
 *
 * All calculations are read-only. No DB writes.
 * All functions are company-scoped.
 */

function parseQty(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
function parseDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; }

// ─── calculateAvailableToPromise ──────────────────────────────────────────────

/**
 * Current ATP for one item.
 *   ATP = current_stock − active_reservations (all sources)
 *
 * @returns {object} { success, item_id, current_stock, active_reserved, atp, demand_breakdown }
 */
async function calculateAvailableToPromise(supabase, companyId, itemId) {
  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, average_cost, min_stock')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (itemErr || !item) return { success: false, error: 'Item not found' };

  const { data: reservations } = await supabase
    .from('stock_reservations')
    .select('source_type, quantity_reserved, quantity_released, quantity_consumed')
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .in('reservation_status', ['active', 'partially_released']);

  const byType = {};
  let totalReserved = 0;

  for (const r of (reservations || [])) {
    const net = parseQty(r.quantity_reserved) - parseQty(r.quantity_released) - parseQty(r.quantity_consumed);
    if (net <= 0) continue;
    totalReserved += net;
    byType[r.source_type] = (byType[r.source_type] || 0) + net;
  }

  const currentStock = parseQty(item.current_stock);
  const atp = Math.max(0, currentStock - totalReserved);

  return {
    success:          true,
    item_id:          item.id,
    item_name:        item.name,
    sku:              item.sku,
    unit:             item.unit,
    current_stock:    currentStock,
    active_reserved:  totalReserved,
    atp,
    is_low:           atp <= parseQty(item.min_stock),
    demand_breakdown: {
      sales_order:    byType.sales_order    || 0,
      work_order:     byType.work_order     || 0,
      manual_hold:    byType.manual_hold    || 0,
      other_sources:  Object.entries(byType)
        .filter(([k]) => !['sales_order','work_order','manual_hold'].includes(k))
        .reduce((sum, [, v]) => sum + v, 0)
    }
  };
}

// ─── calculateFutureDemand ────────────────────────────────────────────────────

/**
 * Future demand from confirmed/allocated sales orders for an item.
 * Filtered to orders with required_date in [fromDate, toDate].
 */
async function calculateFutureDemand(supabase, companyId, itemId, fromDate, toDate) {
  let q = supabase
    .from('sales_order_lines')
    .select(`
      id, quantity_ordered, quantity_fulfilled, required_date,
      sales_orders:so_id (id, so_number, customer_name, so_status, required_date)
    `)
    .eq('company_id', companyId)
    .eq('item_id', itemId);

  const from = parseDate(fromDate);
  const to   = parseDate(toDate);
  if (from) q = q.gte('required_date', from.toISOString().split('T')[0]);
  if (to)   q = q.lte('required_date', to.toISOString().split('T')[0]);

  const { data, error } = await q;
  if (error) return { success: false, error: error.message };

  const lines = (data || []).filter(l => {
    const so = l.sales_orders;
    return so && !['cancelled', 'fulfilled'].includes(so.so_status);
  });

  const totalDemand   = lines.reduce((sum, l) => sum + parseQty(l.quantity_ordered), 0);
  const totalFulfilled = lines.reduce((sum, l) => sum + parseQty(l.quantity_fulfilled), 0);
  const outstanding   = totalDemand - totalFulfilled;

  return {
    success:          true,
    item_id:          itemId,
    total_demand:     totalDemand,
    total_fulfilled:  totalFulfilled,
    outstanding_demand: Math.max(0, outstanding),
    demand_lines:     lines.map(l => ({
      line_id:          l.id,
      so_id:            l.sales_orders?.id,
      so_number:        l.sales_orders?.so_number,
      customer_name:    l.sales_orders?.customer_name,
      so_status:        l.sales_orders?.so_status,
      required_date:    l.required_date || l.sales_orders?.required_date,
      quantity_ordered: parseQty(l.quantity_ordered),
      quantity_fulfilled: parseQty(l.quantity_fulfilled),
      outstanding:      Math.max(0, parseQty(l.quantity_ordered) - parseQty(l.quantity_fulfilled))
    }))
  };
}

// ─── calculateProjectedAvailability ──────────────────────────────────────────

/**
 * Projects stock availability over a time horizon.
 *   Day-by-day: current_stock + expected PO inflows − expected SO demand
 *
 * @param {number} horizonDays — number of days to project forward (default 30)
 */
async function calculateProjectedAvailability(supabase, companyId, itemId, horizonDays = 30) {
  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + horizonDays);
  const horizonStr = horizon.toISOString().split('T')[0];
  const todayStr   = today.toISOString().split('T')[0];

  const { data: item } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, average_cost')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (!item) return { success: false, error: 'Item not found' };

  // Expected inflows from open POs
  const { data: poLines } = await supabase
    .from('purchase_order_lines')
    .select(`
      quantity_ordered, quantity_received, expected_date,
      purchase_orders:po_id (id, po_number, expected_date, status)
    `)
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .gte('expected_date', todayStr)
    .lte('expected_date', horizonStr);

  // Future SO demand
  const { data: soLines } = await supabase
    .from('sales_order_lines')
    .select(`
      quantity_ordered, quantity_fulfilled, required_date,
      sales_orders:so_id (so_status, required_date)
    `)
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .gte('required_date', todayStr)
    .lte('required_date', horizonStr);

  // Build day-by-day projection
  const events = [];
  for (const l of (poLines || [])) {
    const po = l.purchase_orders || {};
    if (['cancelled', 'closed'].includes(po.status)) continue;
    const inflow = parseQty(l.quantity_ordered) - parseQty(l.quantity_received);
    if (inflow <= 0) continue;
    events.push({ date: l.expected_date || po.expected_date, type: 'inflow', qty: inflow, source: `PO ${po.po_number}` });
  }
  for (const l of (soLines || [])) {
    const so = l.sales_orders || {};
    if (['cancelled', 'fulfilled'].includes(so.so_status)) continue;
    const demand = parseQty(l.quantity_ordered) - parseQty(l.quantity_fulfilled);
    if (demand <= 0) continue;
    events.push({ date: l.required_date || so.required_date, type: 'demand', qty: demand });
  }

  events.sort((a, b) => (a.date || '9999') > (b.date || '9999') ? 1 : -1);

  let projected = parseQty(item.current_stock);
  const timeline = [];
  let lastDate = null;
  for (const ev of events) {
    if (ev.date && ev.date !== lastDate) {
      lastDate = ev.date;
      timeline.push({ date: ev.date, events_before_this: [], projected_stock: projected });
    }
    const point = timeline[timeline.length - 1];
    point.events_before_this.push({ type: ev.type, qty: ev.qty, source: ev.source });
    if (ev.type === 'inflow')  projected += ev.qty;
    if (ev.type === 'demand')  projected = Math.max(0, projected - ev.qty);
    point.projected_stock = projected;
  }

  return {
    success:          true,
    item_id:          item.id,
    item_name:        item.name,
    current_stock:    parseQty(item.current_stock),
    final_projected:  projected,
    horizon_days:     horizonDays,
    will_go_negative: projected < 0,
    timeline
  };
}

// ─── getDemandDashboard ───────────────────────────────────────────────────────

/**
 * Company-level demand dashboard:
 * - Open SO counts and values
 * - Items with outstanding demand
 * - Items where demand exceeds ATP
 * - Demand segmentation by source type
 */
async function getDemandDashboard(supabase, companyId) {
  const [soResult, reservationResult] = await Promise.all([
    supabase
      .from('sales_orders')
      .select('id, so_status, total_amount')
      .eq('company_id', companyId)
      .not('so_status', 'in', '("fulfilled","cancelled")'),
    supabase
      .from('stock_reservations')
      .select('source_type, item_id, quantity_reserved, quantity_released, quantity_consumed')
      .eq('company_id', companyId)
      .in('reservation_status', ['active', 'partially_released'])
  ]);

  const openSOs = soResult.data || [];
  const reservations = reservationResult.data || [];

  // Aggregate by source type
  const byType = {};
  const itemDemand = {};
  for (const r of reservations) {
    const net = parseQty(r.quantity_reserved) - parseQty(r.quantity_released) - parseQty(r.quantity_consumed);
    if (net <= 0) continue;
    byType[r.source_type] = (byType[r.source_type] || 0) + net;
    itemDemand[r.item_id] = (itemDemand[r.item_id] || 0) + net;
  }

  const customerDemandQty = byType.sales_order || 0;
  const productionDemandQty = byType.work_order || 0;

  // Check items where customer demand exceeds stock
  const itemIds = Object.keys(itemDemand).map(Number);
  let atRiskCount = 0;
  if (itemIds.length > 0) {
    const { data: items } = await supabase
      .from('inventory_items')
      .select('id, current_stock')
      .eq('company_id', companyId)
      .in('id', itemIds);
    for (const item of (items || [])) {
      if ((itemDemand[item.id] || 0) > parseQty(item.current_stock)) atRiskCount++;
    }
  }

  return {
    success: true,
    summary: {
      generated_at:          new Date().toISOString(),
      open_sales_orders:     openSOs.length,
      open_so_value:         openSOs.reduce((s, o) => s + parseQty(o.total_amount), 0),
      draft_count:           openSOs.filter(o => o.so_status === 'draft').length,
      confirmed_count:       openSOs.filter(o => o.so_status === 'confirmed').length,
      allocated_count:       openSOs.filter(o => o.so_status === 'allocated').length,
      partially_fulfilled:   openSOs.filter(o => o.so_status === 'partially_fulfilled').length,
      customer_demand_qty:   customerDemandQty,
      production_demand_qty: productionDemandQty,
      at_risk_items:         atRiskCount
    },
    demand_by_source: byType
  };
}

// ─── getATPReport ─────────────────────────────────────────────────────────────

/**
 * ATP summary for all items with active demand.
 * Returns items sorted by ATP ascending (most constrained first).
 */
async function getATPReport(supabase, companyId) {
  const { data: reservations, error } = await supabase
    .from('stock_reservations')
    .select('item_id, source_type, quantity_reserved, quantity_released, quantity_consumed')
    .eq('company_id', companyId)
    .in('reservation_status', ['active', 'partially_released']);

  if (error) return { success: false, status: 500, error: error.message };

  const itemReserved = {};
  const itemByType   = {};
  for (const r of (reservations || [])) {
    const net = parseQty(r.quantity_reserved) - parseQty(r.quantity_released) - parseQty(r.quantity_consumed);
    if (net <= 0) continue;
    itemReserved[r.item_id] = (itemReserved[r.item_id] || 0) + net;
    if (!itemByType[r.item_id]) itemByType[r.item_id] = {};
    itemByType[r.item_id][r.source_type] = (itemByType[r.item_id][r.source_type] || 0) + net;
  }

  const itemIds = Object.keys(itemReserved).map(Number);
  if (!itemIds.length) return { success: true, report: { generated_at: new Date().toISOString(), item_count: 0 }, items: [] };

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, item_type, current_stock, average_cost, min_stock')
    .eq('company_id', companyId)
    .in('id', itemIds);

  const rows = (items || []).map(item => {
    const reserved = itemReserved[item.id] || 0;
    const stock    = parseQty(item.current_stock);
    const atp      = Math.max(0, stock - reserved);
    const byType   = itemByType[item.id] || {};
    return {
      item_id:          item.id,
      name:             item.name,
      sku:              item.sku,
      unit:             item.unit,
      item_type:        item.item_type,
      current_stock:    stock,
      active_reserved:  reserved,
      atp,
      sales_reserved:   byType.sales_order     || 0,
      wo_reserved:      byType.work_order       || 0,
      other_reserved:   reserved - (byType.sales_order || 0) - (byType.work_order || 0),
      is_low:           atp <= parseQty(item.min_stock),
      has_shortage:     atp <= 0 && reserved > 0
    };
  }).sort((a, b) => a.atp - b.atp);

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      item_count:   rows.length,
      shortage_count: rows.filter(r => r.has_shortage).length,
      low_count:    rows.filter(r => r.is_low).length
    },
    items: rows
  };
}

// ─── getFutureDemandReport ────────────────────────────────────────────────────

async function getFutureDemandReport(supabase, companyId, options = {}) {
  const { days = 30, status } = options;
  const today = new Date().toISOString().split('T')[0];
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + parseInt(days) || 30);
  const horizonStr = horizon.toISOString().split('T')[0];

  let q = supabase
    .from('sales_order_lines')
    .select(`
      id, quantity_ordered, quantity_allocated, quantity_fulfilled, required_date,
      inventory_items:item_id (id, name, sku, unit, item_type, current_stock),
      sales_orders:so_id (id, so_number, customer_name, so_status, required_date)
    `)
    .eq('company_id', companyId)
    .lte('required_date', horizonStr);

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const lines = (data || []).filter(l => {
    const so = l.sales_orders;
    if (!so) return false;
    if (['cancelled', 'fulfilled'].includes(so.so_status)) return false;
    if (status && so.so_status !== status) return false;
    return true;
  });

  const totalDemand = lines.reduce((s, l) => s + parseQty(l.quantity_ordered), 0);
  const totalAlloc  = lines.reduce((s, l) => s + parseQty(l.quantity_allocated), 0);

  return {
    success: true,
    report: {
      generated_at:      new Date().toISOString(),
      horizon_days:      parseInt(days) || 30,
      total_demand_lines: lines.length,
      total_demand_qty:  totalDemand,
      total_allocated:   totalAlloc,
      unallocated:       Math.max(0, totalDemand - totalAlloc)
    },
    demand_lines: lines.map(l => ({
      line_id:          l.id,
      so_number:        l.sales_orders?.so_number,
      customer_name:    l.sales_orders?.customer_name,
      so_status:        l.sales_orders?.so_status,
      item_name:        l.inventory_items?.name,
      sku:              l.inventory_items?.sku,
      unit:             l.inventory_items?.unit,
      item_type:        l.inventory_items?.item_type,
      required_date:    l.required_date || l.sales_orders?.required_date,
      quantity_ordered: parseQty(l.quantity_ordered),
      quantity_allocated: parseQty(l.quantity_allocated),
      quantity_fulfilled: parseQty(l.quantity_fulfilled),
      outstanding:      Math.max(0, parseQty(l.quantity_ordered) - parseQty(l.quantity_fulfilled))
    }))
  };
}

// ─── getDemandShortagesReport ─────────────────────────────────────────────────

/**
 * Shortages segmented by demand source type.
 * Shows which shortages are driven by customers vs production vs manual holds.
 */
async function getDemandShortagesReport(supabase, companyId) {
  const { data: reservations, error } = await supabase
    .from('stock_reservations')
    .select('item_id, source_type, quantity_reserved, quantity_released, quantity_consumed')
    .eq('company_id', companyId)
    .in('reservation_status', ['active', 'partially_released']);

  if (error) return { success: false, status: 500, error: error.message };

  // Per-item, per-source aggregation
  const itemSources = {};
  for (const r of (reservations || [])) {
    const net = parseQty(r.quantity_reserved) - parseQty(r.quantity_released) - parseQty(r.quantity_consumed);
    if (net <= 0) continue;
    if (!itemSources[r.item_id]) itemSources[r.item_id] = {};
    itemSources[r.item_id][r.source_type] = (itemSources[r.item_id][r.source_type] || 0) + net;
  }

  const itemIds = Object.keys(itemSources).map(Number);
  if (!itemIds.length) return { success: true, report: { generated_at: new Date().toISOString(), shortage_count: 0 }, shortages: [] };

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, item_type, current_stock, average_cost')
    .eq('company_id', companyId)
    .in('id', itemIds);

  const shortages = [];
  for (const item of (items || [])) {
    const sources = itemSources[item.id] || {};
    const totalReserved = Object.values(sources).reduce((s, v) => s + v, 0);
    const stock = parseQty(item.current_stock);
    const atp   = Math.max(0, stock - totalReserved);
    const shortageQty = Math.max(0, totalReserved - stock);

    if (shortageQty <= 0 && atp > 0) continue; // No shortage, skip

    shortages.push({
      item_id:          item.id,
      name:             item.name,
      sku:              item.sku,
      unit:             item.unit,
      item_type:        item.item_type,
      current_stock:    stock,
      total_reserved:   totalReserved,
      atp,
      shortage_qty:     shortageQty,
      has_shortage:     shortageQty > 0,
      shortage_value:   shortageQty * (parseQty(item.average_cost)),
      customer_demand:  sources.sales_order    || 0,
      production_demand:sources.work_order     || 0,
      manual_hold:      sources.manual_hold    || 0,
      other_demand:     totalReserved - (sources.sales_order || 0) - (sources.work_order || 0) - (sources.manual_hold || 0)
    });
  }

  shortages.sort((a, b) => b.shortage_qty - a.shortage_qty);

  return {
    success: true,
    report: {
      generated_at:    new Date().toISOString(),
      shortage_count:  shortages.filter(s => s.has_shortage).length,
      at_risk_count:   shortages.filter(s => !s.has_shortage).length,
      total_shortage_value: shortages.reduce((s, r) => s + r.shortage_value, 0)
    },
    shortages
  };
}

module.exports = {
  calculateAvailableToPromise,
  calculateFutureDemand,
  calculateProjectedAvailability,
  getDemandDashboard,
  getATPReport,
  getFutureDemandReport,
  getDemandShortagesReport
};
