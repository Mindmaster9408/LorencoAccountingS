/**
 * Inventory Reporting Service
 *
 * Centralises inventory report queries and aggregation logic so routes
 * remain thin and report behaviour is reusable across the module.
 *
 * All functions are company-scoped and receive a shared Supabase client.
 */

'use strict';

const costingService = require('./costingService');
const procurementService = require('./procurementService');
const reservationService = require('./reservationService');
const productionService = require('./productionService');
const atpService = require('./atpService');

function parseNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDate(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}

async function getStockValuationReport(supabase, companyId, options = {}) {
  const {
    category,
    item_type,
    min_value,
    low_stock,
    missing_cost,
    search
  } = options;

  const rows = await costingService.getStockValuation(supabase, companyId);
  const filtered = rows.filter(r => {
    if (category && r.category !== category) return false;
    if (item_type && r.itemType !== item_type) return false;
    if (min_value != null && !isNaN(min_value) && r.totalValue < parseFloat(min_value)) return false;
    if (low_stock === true && r.currentStock > r.minStock) return false;
    if (missing_cost === true && (r.hasCost && r.unitCost !== 0)) return false;
    if (search) {
      const term = String(search).toLowerCase();
      if (!((r.name || '').toLowerCase().includes(term) || (r.sku || '').toLowerCase().includes(term))) return false;
    }
    return true;
  });

  const summary = {
    generated_at: new Date().toISOString(),
    total_items: filtered.length,
    grand_total: filtered.reduce((sum, r) => sum + r.totalValue, 0),
    zero_cost_items: filtered.filter(r => r.unitCost === 0).length,
    raw_material_value: filtered.filter(r => r.itemType === 'raw_material').reduce((sum, r) => sum + r.totalValue, 0),
    finished_goods_value: filtered.filter(r => r.itemType === 'finished_good').reduce((sum, r) => sum + r.totalValue, 0),
    consumables_value: filtered.filter(r => r.itemType === 'consumable').reduce((sum, r) => sum + r.totalValue, 0),
    sub_assembly_value: filtered.filter(r => r.itemType === 'sub_assembly').reduce((sum, r) => sum + r.totalValue, 0),
    low_stock_count: filtered.filter(r => r.currentStock <= r.minStock).length,
    missing_cost_items: filtered.filter(r => !r.hasCost || r.unitCost === 0).length
  };

  return { success: true, report: summary, items: filtered };
}

async function getCostHistory(supabase, companyId, itemId, options = {}) {
  const id = parseNumber(itemId);
  if (!id) return { success: false, status: 400, error: 'Invalid item id' };

  const { from, to, limit = 200 } = options;
  const dateFrom = parseDate(from, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
  const dateTo = parseDate(to, new Date().toISOString());

  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, average_cost, cost_price, costing_method')
    .eq('id', id)
    .eq('company_id', companyId)
    .single();

  if (itemErr || !item) return { success: false, status: 404, error: 'Item not found' };

  const { data: history, error } = await supabase
    .from('item_cost_history')
    .select('*')
    .eq('company_id', companyId)
    .eq('item_id', id)
    .gte('changed_at', dateFrom)
    .lte('changed_at', dateTo)
    .order('changed_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (error) return { success: false, status: 500, error: error.message };

  return {
    success: true,
    item: {
      id: item.id,
      name: item.name,
      sku: item.sku,
      current_avg: parseFloat(item.average_cost) || parseFloat(item.cost_price) || 0,
      costing_method: item.costing_method || 'average'
    },
    history: history || []
  };
}

async function getValuationMovements(supabase, companyId, options = {}) {
  const { from, to, item_id, source_type, limit = 500 } = options;
  const dateFrom = parseDate(from);
  if (!dateFrom) return { success: false, status: 400, error: 'from date is required' };
  const dateTo = parseDate(to, new Date().toISOString());
  const maxRows = Math.min(parseNumber(limit, 500) || 500, 1000);

  let q = supabase
    .from('stock_valuation_movements')
    .select(`
      id, movement_type, qty, unit_cost, total_cost,
      running_avg_cost, running_qty,
      reference, source_type, source_id, movement_id,
      created_at, created_by,
      inventory_items:item_id (id, name, sku, category)
    `)
    .eq('company_id', companyId)
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo)
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (item_id) q = q.eq('item_id', parseNumber(item_id));
  if (source_type) q = q.eq('source_type', source_type);

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  const totalCost = rows.reduce((sum, r) => sum + (parseFloat(r.total_cost) || 0), 0);

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      date_from: dateFrom,
      date_to: dateTo,
      row_count: rows.length,
      total_cost_moved: totalCost
    },
    movements: rows
  };
}

async function getWorkOrderCostSummary(supabase, companyId, options = {}) {
  const { status, from, to, limit = 200 } = options;
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
    .eq('company_id', companyId)
    .order('updated_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (status && status !== 'all') q = q.eq('status', status);
  if (from) q = q.gte('created_at', parseDate(from));
  if (to) q = q.lte('created_at', parseDate(to));

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  const summary = {
    total_wos: rows.length,
    finalized_wos: rows.filter(r => r.status === 'finalized').length,
    open_wos: rows.filter(r => r.status === 'open').length,
    total_material: rows.reduce((sum, r) => sum + (parseFloat(r.material_cost) || 0), 0),
    total_labor: rows.reduce((sum, r) => sum + (parseFloat(r.labor_cost) || 0), 0),
    total_overhead: rows.reduce((sum, r) => sum + (parseFloat(r.overhead_cost) || 0), 0)
  };
  summary.grand_total = summary.total_material + summary.total_labor + summary.total_overhead;

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      ...summary
    },
    work_orders: rows
  };
}

async function getStockCountSessionsReport(supabase, companyId, options = {}) {
  const { status, from_date, to_date, limit = 100 } = options;

  let query = supabase
    .from('stock_count_sessions')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseNumber(limit, 100) || 100, 500));

  if (status) query = query.eq('status', status);
  if (from_date) query = query.gte('created_at', parseDate(from_date));
  if (to_date) query = query.lte('created_at', parseDate(to_date));

  const { data: sessions, error: sessErr } = await query;
  if (sessErr) return { success: false, status: 500, error: sessErr.message };

  const sessionRows = sessions || [];
  if (sessionRows.length === 0) {
    return {
      success: true,
      report: { generated_at: new Date().toISOString(), total_sessions: 0 },
      sessions: []
    };
  }

  const sessionIds = sessionRows.map(s => s.id);
  const { data: lines } = await supabase
    .from('stock_count_lines')
    .select('session_id, counted_quantity, variance_quantity, variance_value')
    .eq('company_id', companyId)
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

  const enriched = sessionRows.map(s => ({
    ...s,
    line_count: (lineMap[s.id] || {}).total || 0,
    counted_count: (lineMap[s.id] || {}).counted || 0,
    variant_count: (lineMap[s.id] || {}).variant_count || 0,
    total_variance_value: (lineMap[s.id] || {}).variance_value || 0
  }));

  const totalVarianceValue = enriched.reduce((sum, s) => sum + s.total_variance_value, 0);

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_sessions: enriched.length,
      total_variance_value: totalVarianceValue,
      applied_count: enriched.filter(s => s.status === 'applied').length,
      pending_count: enriched.filter(s => ['submitted', 'approved'].includes(s.status)).length
    },
    sessions: enriched
  };
}

async function getVarianceSummaryReport(supabase, companyId, options = {}) {
  const { from_date, to_date } = options;

  let sessionQuery = supabase
    .from('stock_count_sessions')
    .select('id, session_number, applied_at')
    .eq('company_id', companyId)
    .eq('status', 'applied');

  if (from_date) sessionQuery = sessionQuery.gte('applied_at', parseDate(from_date));
  if (to_date) sessionQuery = sessionQuery.lte('applied_at', parseDate(to_date));

  const { data: sessions, error: sessErr } = await sessionQuery;
  if (sessErr) return { success: false, status: 500, error: sessErr.message };

  const sessionRows = sessions || [];
  if (sessionRows.length === 0) {
    return {
      success: true,
      report: { generated_at: new Date().toISOString(), total_variance_value: 0 },
      by_reason: [],
      by_item_type: [],
      top_variance_items: []
    };
  }

  const sessionIds = sessionRows.map(s => s.id);
  const { data: lines, error: linesErr } = await supabase
    .from('stock_count_lines')
    .select('session_id, item_id, variance_quantity, variance_value, variance_reason, average_cost, inventory_items:item_id(name, sku, item_type)')
    .eq('company_id', companyId)
    .in('session_id', sessionIds)
    .not('variance_quantity', 'is', null);

  if (linesErr) return { success: false, status: 500, error: linesErr.message };

  const variantLines = (lines || []).filter(l => parseFloat(l.variance_quantity) !== 0);

  const byReason = {};
  const byItemType = {};
  const itemMap = {};

  for (const l of variantLines) {
    const reason = l.variance_reason || 'unspecified';
    if (!byReason[reason]) byReason[reason] = { reason, count: 0, total_variance_value: 0 };
    byReason[reason].count++;
    byReason[reason].total_variance_value += parseFloat(l.variance_value) || 0;

    const itemType = l.inventory_items?.item_type || 'unknown';
    if (!byItemType[itemType]) byItemType[itemType] = { item_type: itemType, count: 0, total_variance_value: 0 };
    byItemType[itemType].count++;
    byItemType[itemType].total_variance_value += parseFloat(l.variance_value) || 0;

    const key = l.item_id;
    if (!itemMap[key]) {
      itemMap[key] = {
        item_id: l.item_id,
        name: l.inventory_items?.name || 'Unknown',
        sku: l.inventory_items?.sku || null,
        item_type: l.inventory_items?.item_type || null,
        total_variance_value: 0,
        count: 0
      };
    }
    itemMap[key].count++;
    itemMap[key].total_variance_value += parseFloat(l.variance_value) || 0;
  }

  const topItems = Object.values(itemMap)
    .sort((a, b) => Math.abs(b.total_variance_value) - Math.abs(a.total_variance_value))
    .slice(0, 10);

  const totalVarianceValue = variantLines.reduce((sum, l) => sum + (parseFloat(l.variance_value) || 0), 0);

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      applied_sessions: sessionRows.length,
      total_variant_lines: variantLines.length,
      total_variance_value: totalVarianceValue
    },
    by_reason: Object.values(byReason).sort((a, b) => Math.abs(b.total_variance_value) - Math.abs(a.total_variance_value)),
    by_item_type: Object.values(byItemType),
    top_variance_items: topItems
  };
}

async function getOperationalDashboard(supabase, companyId) {
  const today = new Date().toISOString().slice(0, 10);

  const [itemCount, supplierCount, openWOs, openPOs, overduePOs, activeReservations, lowStockCount, valuation] = await Promise.all([
    supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['released', 'in_progress']),
    supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['approved', 'ordered', 'partial_receipt']),
    supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('company_id', companyId).not('status', 'in', '("cancelled","closed","fully_received")').lt('expected_date', today),
    supabase.from('stock_reservations').select('item_id, quantity_reserved, quantity_released, quantity_consumed').eq('company_id', companyId).in('reservation_status', ['active', 'partially_released']),
    supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true).filter('current_stock', 'lte', 'min_stock'),
    costingService.getStockValuation(supabase, companyId)
  ]);

  const reservationRows = activeReservations.data || [];
  const reservedByItem = {};
  let totalReservedValue = 0;
  for (const row of reservationRows) {
    const net = parseFloat(row.quantity_reserved || 0) - parseFloat(row.quantity_released || 0) - parseFloat(row.quantity_consumed || 0);
    if (net > 0) reservedByItem[row.item_id] = (reservedByItem[row.item_id] || 0) + net;
  }

  const reservedItemIds = Object.keys(reservedByItem).map(id => parseInt(id, 10)).filter(Boolean);
  if (reservedItemIds.length > 0) {
    const { data: reservedItems, error: reservedErr } = await supabase
      .from('inventory_items')
      .select('id, average_cost')
      .eq('company_id', companyId)
      .in('id', reservedItemIds);

    if (reservedErr) return { success: false, status: 500, error: reservedErr.message };

    for (const item of reservedItems || []) {
      totalReservedValue += (parseFloat(item.average_cost) || 0) * (reservedByItem[item.id] || 0);
    }
  }

  const lowStockItems = (valuation || [])
    .filter(i => i.currentStock <= i.minStock)
    .sort((a, b) => (a.currentStock - a.minStock) - (b.currentStock - b.minStock))
    .slice(0, 5);

  const shortageItems = (valuation || [])
    .map(item => {
      const reservedQty = reservedByItem[item.itemId] || 0;
      return {
        item_id: item.itemId,
        name: item.name,
        sku: item.sku,
        current_stock: item.currentStock,
        reserved_qty: reservedQty,
        shortage_qty: Math.max(0, reservedQty - item.currentStock)
      };
    })
    .filter(row => row.shortage_qty > 0)
    .sort((a, b) => b.shortage_qty - a.shortage_qty)
    .slice(0, 5);

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_items: itemCount.count || 0,
      total_suppliers: supplierCount.count || 0,
      open_work_orders: openWOs.count || 0,
      purchase_orders_awaiting_receipt: openPOs.count || 0,
      overdue_purchase_orders: overduePOs.count || 0,
      active_reservations: reservationRows.length,
      total_reserved_value: parseFloat(totalReservedValue.toFixed(4)),
      low_stock_count: lowStockCount.count || 0,
      shortage_item_count: shortageItems.length,
      total_stock_value: (valuation || []).reduce((sum, row) => sum + (parseFloat(row.totalValue) || 0), 0)
    },
    top_low_stock_items: lowStockItems,
    top_shortage_items: shortageItems
  };
}

async function getReservationReport(supabase, companyId, options = {}) {
  const { status, source_type, item_id, limit = 200 } = options;
  let q = supabase
    .from('stock_reservations')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (status) q = q.eq('reservation_status', status);
  if (source_type) q = q.eq('source_type', source_type);
  if (item_id) q = q.eq('item_id', parseNumber(item_id));

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const reservations = data || [];
  const summary = {
    generated_at: new Date().toISOString(),
    total_reservations: reservations.length,
    active: reservations.filter(r => r.reservation_status === 'active').length,
    partially_released: reservations.filter(r => r.reservation_status === 'partially_released').length,
    released: reservations.filter(r => r.reservation_status === 'released').length,
    consumed: reservations.filter(r => r.reservation_status === 'consumed').length
  };

  const items = {};
  for (const reservation of reservations) {
    const itemId = reservation.item_id;
    const netReserved = parseFloat(reservation.quantity_reserved || 0) - parseFloat(reservation.quantity_released || 0) - parseFloat(reservation.quantity_consumed || 0);
    if (!items[itemId]) {
      items[itemId] = {
        item_id: itemId,
        item_name: reservation.inventory_items?.name || null,
        sku: reservation.inventory_items?.sku || null,
        unit: reservation.inventory_items?.unit || null,
        total_reserved: 0,
        reservation_count: 0
      };
    }
    items[itemId].total_reserved += netReserved;
    items[itemId].reservation_count += 1;
  }

  return {
    success: true,
    report: summary,
    reservations,
    items: Object.values(items)
  };
}

async function getOvercommittedReport(supabase, companyId) {
  const shortageResult = await reservationService.getShortageReport(supabase, companyId);
  if (!shortageResult.success) return { success: false, status: 500, error: shortageResult.error };

  const overcommitted = shortageResult.shortages.filter(row => row.has_shortage);
  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_overcommitted_items: overcommitted.length,
      total_reserved_value: shortageResult.total_reserved_value
    },
    overcommitted_items: overcommitted
  };
}

async function getPurchaseOrderReport(supabase, companyId, options = {}) {
  const { status, from, to, limit = 200 } = options;
  let q = supabase
    .from('purchase_orders')
    .select(`
      id, po_number, po_date, expected_date, status,
      total_inc_vat, subtotal, tax_amount, currency_code,
      suppliers:supplier_id(id, name, email)
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (status) q = q.eq('status', status);
  if (from) {
    const fromDate = parseDate(from);
    if (fromDate) q = q.gte('po_date', fromDate);
  }
  if (to) {
    const toDate = parseDate(to);
    if (toDate) q = q.lte('po_date', toDate);
  }

  const { data: pos, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const poRows = pos || [];
  const poIds = poRows.map(po => po.id);
  const receiptMap = {};
  if (poIds.length > 0) {
    const { data: receipts, error: receiptErr } = await supabase
      .from('purchase_receipts')
      .select('po_id, total_value, total_qty')
      .eq('company_id', companyId)
      .in('po_id', poIds);

    if (receiptErr) return { success: false, status: 500, error: receiptErr.message };

    for (const receipt of receipts || []) {
      receiptMap[receipt.po_id] = receiptMap[receipt.po_id] || { total_received_value: 0, receipt_count: 0 };
      receiptMap[receipt.po_id].total_received_value += parseFloat(receipt.total_value || 0);
      receiptMap[receipt.po_id].receipt_count += 1;
    }
  }

  const enriched = poRows.map(po => {
    const receiptSummary = receiptMap[po.id] || { total_received_value: 0, receipt_count: 0 };
    const isOverdue = po.expected_date && !['cancelled', 'closed', 'fully_received'].includes(po.status)
      && new Date(po.expected_date) < new Date();
    return {
      ...po,
      total_received_value: receiptSummary.total_received_value,
      receipt_count: receiptSummary.receipt_count,
      is_overdue: isOverdue
    };
  });

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_purchase_orders: enriched.length,
      total_amount: enriched.reduce((sum, row) => sum + (parseFloat(row.total_inc_vat) || 0), 0),
      overdue_count: enriched.filter(row => row.is_overdue).length
    },
    purchase_orders: enriched
  };
}

async function getOverduePurchaseOrdersReport(supabase, companyId, options = {}) {
  const asOf = parseDate(options.as_of, new Date().toISOString()).slice(0, 10);
  let q = supabase
    .from('purchase_orders')
    .select(`
      id, po_number, po_date, expected_date, status, total_inc_vat,
      suppliers:supplier_id(id, name, email)
    `)
    .eq('company_id', companyId)
    .not('status', 'in', '("cancelled","closed","fully_received")')
    .lt('expected_date', asOf)
    .order('expected_date', { ascending: true });

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  return {
    success: true,
    overdue_pos: rows,
    count: rows.length
  };
}

async function getSupplierHistoryReport(supabase, companyId, options = {}) {
  const { item_id, supplier_id } = options;
  let q = supabase
    .from('supplier_item_history')
    .select(`
      id, supplier_id, item_id,
      last_purchase_cost, average_supplier_cost,
      last_purchase_date, lead_time_days,
      preferred_supplier, purchase_count,
      suppliers:supplier_id(id, name, email, is_active),
      inventory_items:item_id(id, name, sku, unit)
    `)
    .eq('company_id', companyId)
    .order('last_purchase_date', { ascending: false });

  if (item_id) q = q.eq('item_id', parseNumber(item_id));
  if (supplier_id) q = q.eq('supplier_id', parseNumber(supplier_id));

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  return {
    success: true,
    supplier_history: data || []
  };
}

async function getProcurementSuggestionsReport(supabase, companyId) {
  try {
    const [reorderRecs, shortageRecs] = await Promise.all([
      procurementService.generateReorderRecommendations(supabase, companyId),
      procurementService.generateShortageRecommendations(supabase, companyId)
    ]);

    const merged = {};
    for (const r of reorderRecs) {
      merged[r.item_id] = { ...r, sources: ['reorder'] };
    }
    for (const s of shortageRecs) {
      if (merged[s.item_id]) {
        merged[s.item_id] = {
          ...merged[s.item_id],
          ...s,
          recommended_qty: Math.max(merged[s.item_id].recommended_qty, s.recommended_qty),
          sources: [...(merged[s.item_id].sources || []), 'shortage']
        };
      } else {
        merged[s.item_id] = { ...s, sources: ['shortage'] };
      }
    }

    const suggestions = Object.values(merged);
    return {
      success: true,
      suggestions,
      summary: {
        generated_at: new Date().toISOString(),
        total: suggestions.length,
        reorder_count: reorderRecs.length,
        shortage_count: shortageRecs.length
      }
    };
  } catch (err) {
    return { success: false, status: 500, error: err.message };
  }
}

async function getProductionSummaryReport(supabase, companyId) {
  const summary = await productionService.getProductionSummary(supabase, companyId);
  return { success: true, summary: { generated_at: new Date().toISOString(), ...summary } };
}

async function getWastageReport(supabase, companyId, options = {}) {
  const { from, to, limit = 200 } = options;
  let q = supabase
    .from('production_wastage')
    .select(`
      *,
      inventory_items:item_id(name, sku, unit),
      production_batches:batch_id(batch_number, work_orders:work_order_id(wo_number))
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (from) {
    const fromIso = parseDate(from);
    if (fromIso) q = q.gte('created_at', fromIso);
  }
  if (to) {
    const toIso = parseDate(to);
    if (toIso) q = q.lte('created_at', toIso + 'T23:59:59.999Z');
  }

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  const totalWastageQty = rows.reduce((sum, row) => sum + (parseFloat(row.wastage_qty) || 0), 0);
  const totalWastageValue = rows.reduce((sum, row) => sum + (parseFloat(row.estimated_value) || 0), 0);

  const byReason = {};
  for (const row of rows) {
    const reason = row.wastage_reason || 'unknown';
    if (!byReason[reason]) {
      byReason[reason] = { reason, count: 0, total_qty: 0, total_value: 0 };
    }
    byReason[reason].count += 1;
    byReason[reason].total_qty += parseFloat(row.wastage_qty || 0);
    byReason[reason].total_value += parseFloat(row.estimated_value || 0);
  }

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_records: rows.length,
      total_qty: parseFloat(totalWastageQty.toFixed(4)),
      total_value: parseFloat(totalWastageValue.toFixed(4))
    },
    wastage_records: rows,
    by_reason: Object.values(byReason)
  };
}

async function getYieldVarianceReport(supabase, companyId, options = {}) {
  const { from, to, direction, limit = 200 } = options;
  const batchQuery = supabase
    .from('production_batches')
    .select(`
      id, batch_number, produced_qty, expected_qty, wastage_qty,
      yield_percent, completed_at, unit_cost,
      work_orders:work_order_id(wo_number, inventory_items:item_id(name, sku))
    `)
    .eq('company_id', companyId)
    .order('completed_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  const varianceQuery = supabase
    .from('production_variances')
    .select(`
      id, variance_direction, variance_value, variance_qty, created_at,
      inventory_items:item_id(name, sku, unit),
      production_batches:batch_id(batch_number, work_orders:work_order_id(wo_number))
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(parseNumber(limit, 200));

  if (from) {
    const fromIso = parseDate(from);
    if (fromIso) {
      batchQuery.gte('completed_at', fromIso);
      varianceQuery.gte('created_at', fromIso);
    }
  }
  if (to) {
    const toIso = parseDate(to);
    if (toIso) {
      batchQuery.lte('completed_at', toIso + 'T23:59:59.999Z');
      varianceQuery.lte('created_at', toIso + 'T23:59:59.999Z');
    }
  }
  if (direction) varianceQuery.eq('variance_direction', direction);

  const [{ data: batchRows, error: batchErr }, { data: varianceRows, error: varianceErr }] = await Promise.all([
    batchQuery,
    varianceQuery
  ]);

  if (batchErr) return { success: false, status: 500, error: batchErr.message };
  if (varianceErr) return { success: false, status: 500, error: varianceErr.message };

  const batches = batchRows || [];
  const variances = varianceRows || [];
  const totalProduced = batches.reduce((sum, row) => sum + (parseFloat(row.produced_qty) || 0), 0);
  const totalExpected = batches.reduce((sum, row) => sum + (parseFloat(row.expected_qty) || 0), 0);
  const totalWastage = batches.reduce((sum, row) => sum + (parseFloat(row.wastage_qty) || 0), 0);
  const averageYield = batches.length > 0
    ? batches.reduce((sum, row) => sum + (parseFloat(row.yield_percent) || 0), 0) / batches.length
    : null;
  const overYieldCount = batches.filter(r => (parseFloat(r.yield_percent) || 0) > 102).length;
  const underYieldCount = batches.filter(r => (parseFloat(r.yield_percent) || 0) < 98).length;

  const totalVarianceValue = variances.reduce((sum, row) => sum + (parseFloat(row.variance_value) || 0), 0);
  const overVarianceCount = variances.filter(r => r.variance_direction === 'over').length;
  const underVarianceCount = variances.filter(r => r.variance_direction === 'under').length;

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      batch_count: batches.length,
      variance_count: variances.length,
      total_produced: parseFloat(totalProduced.toFixed(4)),
      total_expected: parseFloat(totalExpected.toFixed(4)),
      total_wastage: parseFloat(totalWastage.toFixed(4)),
      average_yield: averageYield !== null ? parseFloat(averageYield.toFixed(2)) : null,
      over_yield_count: overYieldCount,
      under_yield_count: underYieldCount,
      total_variance_value: parseFloat(totalVarianceValue.toFixed(4)),
      over_variance_count: overVarianceCount,
      under_variance_count: underVarianceCount
    },
    batches,
    variances
  };
}

async function getAlertsPanel(supabase, companyId) {
  const today = new Date().toISOString().slice(0, 10);
  const [lowStockItems, overduePOs, shortageResult, underYieldRows] = await Promise.all([
    costingService.getStockValuation(supabase, companyId),
    supabase
      .from('purchase_orders')
      .select(`
        id, po_number, expected_date, status, total_inc_vat,
        suppliers:supplier_id(id, name)
      `)
      .eq('company_id', companyId)
      .not('status', 'in', '("cancelled","closed","fully_received")')
      .lt('expected_date', today)
      .order('expected_date', { ascending: true }),
    reservationService.getShortageReport(supabase, companyId),
    supabase
      .from('production_batches')
      .select('id, batch_number, yield_percent, completed_at, work_orders:work_order_id(wo_number)')
      .eq('company_id', companyId)
      .order('completed_at', { ascending: false })
      .limit(100)
  ]);

  if (overduePOs.error) return { success: false, status: 500, error: overduePOs.error.message || String(overduePOs.error) };
  if (underYieldRows.error) return { success: false, status: 500, error: underYieldRows.error.message || String(underYieldRows.error) };
  if (!shortageResult.success) return { success: false, status: 500, error: shortageResult.error };

  const lowStockAlertItems = (lowStockItems || [])
    .filter(item => item.currentStock <= item.minStock)
    .sort((a, b) => (a.currentStock - a.minStock) - (b.currentStock - b.minStock))
    .slice(0, 5);

  const overdueRows = overduePOs.data || [];
  const underYield = (underYieldRows.data || []).filter(r => (parseFloat(r.yield_percent) || 0) < 98).slice(0, 5);
  const shortageAlerts = shortageResult.success ? shortageResult.shortages.slice(0, 5) : [];

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      low_stock_alerts: lowStockAlertItems.length,
      overdue_po_alerts: overdueRows.length,
      reservation_shortage_alerts: shortageAlerts.length,
      under_yield_batches: underYield.length
    },
    alerts: {
      low_stock_items: lowStockAlertItems,
      overdue_purchase_orders: overdueRows,
      reservation_shortages: shortageAlerts,
      under_yield_batches: underYield
    }
  };
}

async function getShortageReport(supabase, companyId) {
  return reservationService.getShortageReport(supabase, companyId);
}

// ─── CB-08 Warehouse Reports ───────────────────────────────────────────────────

async function getWarehouseStockReport(supabase, companyId, options = {}) {
  const { warehouse_id } = options;
  let q = supabase
    .from('inventory_stock_locations')
    .select(`
      warehouse_id, location_id, quantity_on_hand, quantity_reserved, updated_at,
      inventory_items:item_id (id, name, sku, unit, item_type, average_cost, min_stock),
      warehouses:warehouse_id (id, name, warehouse_code, warehouse_type),
      warehouse_locations:location_id (id, location_code, location_name, location_type)
    `)
    .eq('company_id', companyId)
    .order('updated_at', { ascending: false });

  if (warehouse_id) q = q.eq('warehouse_id', parseInt(warehouse_id));

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = (data || []).map(r => ({
    ...r,
    quantity_available: Math.max(0, (parseFloat(r.quantity_on_hand) || 0) - (parseFloat(r.quantity_reserved) || 0)),
    stock_value: (parseFloat(r.quantity_on_hand) || 0) * (parseFloat(r.inventory_items?.average_cost) || 0)
  }));

  const totalValue = rows.reduce((sum, r) => sum + r.stock_value, 0);
  const warehouseSet = new Set(rows.map(r => r.warehouse_id));

  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_rows: rows.length,
      warehouse_count: warehouseSet.size,
      total_value: parseFloat(totalValue.toFixed(4))
    },
    stock: rows
  };
}

async function getTransferHistoryReport(supabase, companyId, options = {}) {
  const { status, from_warehouse_id, to_warehouse_id, from_date, to_date, limit = 200 } = options;
  let q = supabase
    .from('warehouse_transfers')
    .select(`
      id, transfer_number, transfer_status, notes,
      shipped_at, received_at, approved_at, created_at,
      from_warehouses:from_warehouse_id (id, name, warehouse_code),
      to_warehouses:to_warehouse_id (id, name, warehouse_code),
      warehouse_transfer_lines (
        id, item_id, quantity_requested, quantity_shipped, quantity_received,
        inventory_items:item_id (id, name, sku, unit)
      )
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit) || 200, 500));

  if (status)           q = q.eq('transfer_status', status);
  if (from_warehouse_id) q = q.eq('from_warehouse_id', parseInt(from_warehouse_id));
  if (to_warehouse_id)   q = q.eq('to_warehouse_id', parseInt(to_warehouse_id));
  if (from_date) q = q.gte('created_at', from_date);
  if (to_date)   q = q.lte('created_at', to_date + 'T23:59:59.999Z');

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  return {
    success: true,
    report: {
      generated_at: new Date().toISOString(),
      total_transfers: rows.length,
      in_transit:  rows.filter(r => r.transfer_status === 'in_transit').length,
      received:    rows.filter(r => r.transfer_status === 'received').length,
      cancelled:   rows.filter(r => r.transfer_status === 'cancelled').length,
      draft:       rows.filter(r => r.transfer_status === 'draft').length
    },
    transfers: rows
  };
}

async function getWarehouseShortagesReport(supabase, companyId) {
  const { data: stockRows, error } = await supabase
    .from('inventory_stock_locations')
    .select(`
      warehouse_id, quantity_on_hand, quantity_reserved,
      inventory_items:item_id (id, name, sku, unit, min_stock, average_cost),
      warehouses:warehouse_id (id, name, warehouse_code)
    `)
    .eq('company_id', companyId);

  if (error) return { success: false, status: 500, error: error.message };

  const rows = (stockRows || []).map(r => {
    const onHand    = parseFloat(r.quantity_on_hand)   || 0;
    const reserved  = parseFloat(r.quantity_reserved)  || 0;
    const minStock  = parseFloat(r.inventory_items?.min_stock) || 0;
    const available = Math.max(0, onHand - reserved);
    const shortage  = Math.max(0, reserved - onHand);
    const isLow     = available <= minStock;
    return {
      warehouse:          r.warehouses,
      item:               r.inventory_items,
      quantity_on_hand:   onHand,
      quantity_reserved:  reserved,
      quantity_available: available,
      shortage_qty:       shortage,
      is_low_stock:       isLow,
      is_overcommitted:   shortage > 0
    };
  }).filter(r => r.is_low_stock || r.is_overcommitted);

  return {
    success: true,
    report: {
      generated_at:      new Date().toISOString(),
      shortage_count:    rows.filter(r => r.is_overcommitted).length,
      low_stock_count:   rows.filter(r => r.is_low_stock).length
    },
    warehouse_shortages: rows
  };
}

// ─── CB-09 Demand Planning Reports ───────────────────────────────────────────

async function getOpenSalesOrdersReport(supabase, companyId, options = {}) {
  const { status, customer, from_date, to_date, limit = 200 } = options;
  let q = supabase
    .from('sales_orders')
    .select(`
      id, so_number, customer_name, customer_ref, so_status,
      required_date, total_amount, currency_code, created_at, updated_at,
      sales_order_lines (id, item_id, quantity_ordered, quantity_allocated, quantity_fulfilled, unit_price, line_total,
        inventory_items:item_id (id, name, sku, unit))
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit) || 200, 500));

  if (status)    q = q.eq('so_status', status);
  if (customer)  q = q.ilike('customer_name', `%${customer}%`);
  if (from_date) q = q.gte('created_at', from_date);
  if (to_date)   q = q.lte('created_at', to_date + 'T23:59:59.999Z');

  const { data, error } = await q;
  if (error) return { success: false, status: 500, error: error.message };

  const rows = data || [];
  return {
    success: true,
    report: {
      generated_at:        new Date().toISOString(),
      total_orders:        rows.length,
      draft_count:         rows.filter(o => o.so_status === 'draft').length,
      confirmed_count:     rows.filter(o => o.so_status === 'confirmed').length,
      allocated_count:     rows.filter(o => o.so_status === 'allocated').length,
      partially_fulfilled: rows.filter(o => o.so_status === 'partially_fulfilled').length,
      total_value:         rows.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0)
    },
    sales_orders: rows
  };
}

async function getATPReport(supabase, companyId) {
  return atpService.getATPReport(supabase, companyId);
}

async function getFutureDemandReport(supabase, companyId, options = {}) {
  return atpService.getFutureDemandReport(supabase, companyId, options);
}

async function getDemandShortagesReport(supabase, companyId) {
  return atpService.getDemandShortagesReport(supabase, companyId);
}

async function getDemandDashboardReport(supabase, companyId) {
  return atpService.getDemandDashboard(supabase, companyId);
}

module.exports = {
  getWarehouseStockReport,
  getTransferHistoryReport,
  getWarehouseShortagesReport,
  getOpenSalesOrdersReport,
  getATPReport,
  getFutureDemandReport,
  getDemandShortagesReport,
  getDemandDashboardReport,
  getStockValuationReport,
  getCostHistory,
  getValuationMovements,
  getWorkOrderCostSummary,
  getStockCountSessionsReport,
  getVarianceSummaryReport,
  getOperationalDashboard,
  getReservationReport,
  getShortageReport,
  getOvercommittedReport,
  getPurchaseOrderReport,
  getOverduePurchaseOrdersReport,
  getSupplierHistoryReport,
  getProcurementSuggestionsReport,
  getProductionSummaryReport,
  getWastageReport,
  getYieldVarianceReport,
  getAlertsPanel
};
