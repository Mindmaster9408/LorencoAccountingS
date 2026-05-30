'use strict';

/**
 * ============================================================================
 * Operational Health Service — Codebox 12 Pilot Lockdown
 * ============================================================================
 * Diagnostic engine for Lorenco Storehouse.
 *
 * Detects operational problems, configuration gaps, and risk conditions.
 * Returns structured findings with severity, affected entity counts, and
 * recommended actions. Zero stock mutations — read-only.
 *
 * Hard rules:
 *   - Read-only. Never modifies any data.
 *   - All queries scoped to companyId.
 *   - No external API calls.
 *   - Returns empty arrays on individual check failure (non-fatal).
 *   - Designed to be called on-demand, not on a schedule from this code.
 * ============================================================================
 */

// ─── Severity levels ─────────────────────────────────────────────────────────
const SEVERITY = {
  CRITICAL: 'critical',  // Data integrity risk, costing gap, or blocking issue
  WARNING:  'warning',   // Operational concern, may cause incorrect reports
  INFO:     'info'       // Configuration suggestion, best practice gap
};

// ─── Individual health checks ─────────────────────────────────────────────────

async function checkItemsMissingCost(supabase, companyId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, name, sku, current_stock, average_cost, cost_price')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .gt('current_stock', 0);

  if (error) return null;

  const affected = (data || []).filter(item => {
    const avg = parseFloat(item.average_cost);
    const cp  = parseFloat(item.cost_price);
    return (!Number.isFinite(avg) || avg === 0) && (!Number.isFinite(cp) || cp === 0);
  });

  if (!affected.length) return null;

  return {
    type:           'items_missing_cost',
    severity:       SEVERITY.CRITICAL,
    title:          'Items with Stock but No Cost',
    count:          affected.length,
    affected:       affected.slice(0, 5).map(i => ({ id: i.id, name: i.name, sku: i.sku, stock: i.current_stock })),
    recommendation: 'Receive stock for these items using Quick Receive or a Purchase Order to establish weighted average cost. Until then, stock valuation shows R0.',
    sean_hook:      'stock_valuation_gap'
  };
}

async function checkOverduePOs(supabase, companyId) {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, po_number, expected_date, status, suppliers:supplier_id(name)')
    .eq('company_id', companyId)
    .in('status', ['approved', 'ordered'])
    .lt('expected_date', today);

  if (error || !data?.length) return null;

  return {
    type:           'overdue_pos',
    severity:       SEVERITY.WARNING,
    title:          'Overdue Purchase Orders',
    count:          data.length,
    affected:       data.slice(0, 5).map(p => ({
      id:            p.id,
      po_number:     p.po_number,
      expected_date: p.expected_date,
      supplier:      p.suppliers?.name || 'Unknown'
    })),
    recommendation: 'Contact suppliers for these overdue orders or update the expected delivery date.',
    sean_hook:      'overdue_procurement'
  };
}

async function checkStuckWorkOrders(supabase, companyId) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('work_orders')
    .select('id, wo_number, updated_at, inventory_items:item_id(name)')
    .eq('company_id', companyId)
    .eq('status', 'in_progress')
    .lt('updated_at', cutoff);

  if (error || !data?.length) return null;

  return {
    type:           'wo_stuck',
    severity:       SEVERITY.WARNING,
    title:          'Work Orders Stuck In Progress',
    count:          data.length,
    affected:       data.slice(0, 5).map(w => ({
      id:        w.id,
      wo_number: w.wo_number,
      item:      w.inventory_items?.name || 'Unknown',
      since:     w.updated_at
    })),
    recommendation: 'Review these work orders. Complete or cancel them to release reserved materials.',
    sean_hook:      'production_blockage'
  };
}

async function checkOvercommittedItems(supabase, companyId) {
  const { data: items, error: iErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, current_stock')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .gt('current_stock', 0);

  if (iErr || !items?.length) return null;

  const { data: reservations } = await supabase
    .from('stock_reservations')
    .select('item_id, quantity_reserved, quantity_released, quantity_consumed')
    .eq('company_id', companyId)
    .in('reservation_status', ['active', 'partially_released']);

  const reservedMap = {};
  for (const r of (reservations || [])) {
    const net = parseFloat(r.quantity_reserved) - parseFloat(r.quantity_released || 0) - parseFloat(r.quantity_consumed || 0);
    if (net > 0) reservedMap[r.item_id] = (reservedMap[r.item_id] || 0) + net;
  }

  const affected = items.filter(item => {
    const net = reservedMap[item.id] || 0;
    return net > parseFloat(item.current_stock);
  }).map(item => ({
    id:        item.id,
    name:      item.name,
    sku:       item.sku,
    stock:     parseFloat(item.current_stock),
    reserved:  reservedMap[item.id] || 0,
    shortage:  (reservedMap[item.id] || 0) - parseFloat(item.current_stock)
  }));

  if (!affected.length) return null;

  return {
    type:           'overcommitted',
    severity:       SEVERITY.CRITICAL,
    title:          'Overcommitted Stock (Reserved Exceeds On-Hand)',
    count:          affected.length,
    affected:       affected.slice(0, 5),
    recommendation: 'Receive more stock or cancel/reduce reservations to prevent fulfillment failures.',
    sean_hook:      'stock_shortage'
  };
}

async function checkItemsWithoutWarehouse(supabase, companyId) {
  const { count, error } = await supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
    .is('warehouse_id', null);

  if (error || !count) return null;

  return {
    type:           'items_no_warehouse',
    severity:       SEVERITY.WARNING,
    title:          'Items Without Warehouse Assignment',
    count,
    affected:       [],
    recommendation: 'Assign a warehouse to each item so stock movements are location-tracked.',
    sean_hook:      'warehouse_gap'
  };
}

async function checkItemsWithoutBaseUnit(supabase, companyId) {
  const { count, error } = await supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
    .is('base_unit', null);

  if (error || !count) return null;

  return {
    type:           'items_no_base_unit',
    severity:       SEVERITY.INFO,
    title:          'Items Without Base Unit (UOM Not Configured)',
    count,
    affected:       [],
    recommendation: 'Set a base_unit on each item to enable pack-size receiving and recipe unit conversion.',
    sean_hook:      'uom_gap'
  };
}

async function checkUnapprovedCounts(supabase, companyId) {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('stock_count_sessions')
    .select('id, session_name, submitted_at')
    .eq('company_id', companyId)
    .eq('status', 'submitted')
    .lt('submitted_at', cutoff);

  if (error || !data?.length) return null;

  return {
    type:           'unapproved_counts',
    severity:       SEVERITY.WARNING,
    title:          'Stock Counts Awaiting Approval',
    count:          data.length,
    affected:       data.slice(0, 5).map(c => ({ id: c.id, name: c.session_name, since: c.submitted_at })),
    recommendation: 'Review and approve or reject these submitted counts. Pending counts block cycle-count accuracy.',
    sean_hook:      'count_backlog'
  };
}

async function checkMissingDefaultWarehouse(supabase, companyId) {
  const { count, error } = await supabase
    .from('warehouses')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
    .eq('is_default', true);

  if (error || count > 0) return null;

  return {
    type:           'no_default_warehouse',
    severity:       SEVERITY.INFO,
    title:          'No Default Warehouse Set',
    count:          1,
    affected:       [],
    recommendation: 'Mark one warehouse as the default so stock receiving flows have a pre-selected location.',
    sean_hook:      'config_gap'
  };
}

async function checkNoSuppliers(supabase, companyId) {
  const { count, error } = await supabase
    .from('suppliers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (error || count > 0) return null;

  return {
    type:           'no_suppliers',
    severity:       SEVERITY.INFO,
    title:          'No Suppliers Configured',
    count:          0,
    affected:       [],
    recommendation: 'Add at least one supplier to enable purchase orders and procurement tracking.',
    sean_hook:      'onboarding'
  };
}

async function checkHighWastageItems(supabase, companyId) {
  // Find production batches with yield < 90% in last 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('production_batches')
    .select('id, batch_number, yield_percent, work_order_id, work_orders:work_order_id(inventory_items:item_id(name))')
    .eq('company_id', companyId)
    .lt('completed_at', new Date().toISOString())
    .gte('completed_at', cutoff)
    .not('yield_percent', 'is', null)
    .lt('yield_percent', 90);

  if (error || !data?.length) return null;

  return {
    type:           'high_wastage',
    severity:       SEVERITY.WARNING,
    title:          'Production Batches with High Wastage (< 90% Yield)',
    count:          data.length,
    affected:       data.slice(0, 5).map(b => ({
      id:           b.id,
      batch:        b.batch_number,
      yield:        b.yield_percent,
      item:         b.work_orders?.inventory_items?.name || 'Unknown'
    })),
    recommendation: 'Review wastage reasons for these batches. Persistent low yield indicates a process or recipe issue.',
    sean_hook:      'yield_variance'
  };
}

// ─── Onboarding checklist ─────────────────────────────────────────────────────

async function buildOnboardingChecklist(supabase, companyId) {
  const checks = await Promise.all([
    supabase.from('warehouses').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('bom_headers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('unit_of_measure').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('warehouses').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_default', true),
    supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true).gt('current_stock', 0),
  ]);

  const [warehouses, suppliers, items, boms, uoms, defaultWh, stockedItems] = checks;

  return [
    {
      step:      1,
      title:     'Create at least one warehouse',
      done:      (warehouses.count || 0) > 0,
      action:    'Go to Warehouses tab → Add Warehouse',
      priority:  'required'
    },
    {
      step:      2,
      title:     'Set a default warehouse',
      done:      (defaultWh.count || 0) > 0,
      action:    'Go to Warehouses tab → Edit warehouse → Enable "Default"',
      priority:  'required'
    },
    {
      step:      3,
      title:     'Add at least one supplier',
      done:      (suppliers.count || 0) > 0,
      action:    'Go to Suppliers tab → Add Supplier',
      priority:  'required'
    },
    {
      step:      4,
      title:     'Create your first inventory items',
      done:      (items.count || 0) > 0,
      action:    'Go to Items tab → Add Item',
      priority:  'required'
    },
    {
      step:      5,
      title:     'Receive opening stock',
      done:      (stockedItems.count || 0) > 0,
      action:    'Go to Items tab → Receive Stock (quick receive) or create a Purchase Order',
      priority:  'required'
    },
    {
      step:      6,
      title:     'Configure base units for items (UOM)',
      done:      (uoms.count || 0) > 0,
      action:    'Click UOM button next to any item → Add conversions for pack sizes',
      priority:  'recommended'
    },
    {
      step:      7,
      title:     'Create Bills of Materials for manufactured items',
      done:      (boms.count || 0) > 0,
      action:    'Go to BOMs tab → Create BOM for each finished product',
      priority:  'optional'
    }
  ];
}

// ─── Main health run ──────────────────────────────────────────────────────────

async function runHealthChecks(supabase, companyId) {
  const checkFns = [
    checkItemsMissingCost,
    checkOverduePOs,
    checkStuckWorkOrders,
    checkOvercommittedItems,
    checkItemsWithoutWarehouse,
    checkItemsWithoutBaseUnit,
    checkUnapprovedCounts,
    checkMissingDefaultWarehouse,
    checkNoSuppliers,
    checkHighWastageItems
  ];

  const results = await Promise.allSettled(checkFns.map(fn => fn(supabase, companyId)));

  const issues = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  const hasCritical = issues.some(i => i.severity === SEVERITY.CRITICAL);
  const hasWarning  = issues.some(i => i.severity === SEVERITY.WARNING);
  const overallSeverity = hasCritical ? 'critical' : (hasWarning ? 'warning' : 'ok');

  return { overallSeverity, issues };
}

module.exports = { runHealthChecks, buildOnboardingChecklist };
