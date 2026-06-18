/**
 * ============================================================================
 * Inventory & Storehouse Module — Lorenco Storehouse
 * ============================================================================
 * Routes for stock items, warehouses, movements, suppliers, purchase orders.
 * All routes require authentication + company context from JWT.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const bomRoutes = require('./routes/boms');
const workOrderRoutes = require('./routes/work-orders');
const inventoryReportsRoutes = require('./routes/reports');
const stockCountRoutes = require('./routes/stock-counts');
const reservationRoutes = require('./routes/reservations');
const purchaseOrderRoutes = require('./routes/purchase-orders');
const procurementRoutes = require('./routes/procurement');
const productionRoutes = require('./routes/production-batches');
const warehouseTransferRoutes = require('./routes/warehouse-transfers');
const warehouseLocationRoutes = require('./routes/warehouse-locations');
const salesOrderRoutes        = require('./routes/sales-orders');
const costingService = require('./services/costingService');
const { adjustStockTx } = require('./services/stockMutationService');
const reservationService = require('./services/reservationService');
const warehouseTransferService = require('./services/warehouseTransferService');
const {
  getItemUomProfile,
  convertToBaseUnit,
  computeCostPerBaseUnit,
  getEffectiveBaseUnit
} = require('./services/uomService');
const { requirePerm, PERM, getInventoryPermsForRole } = require('./permissions');
const { runHealthChecks, buildOnboardingChecklist } = require('./services/operationalHealthService');
const {
  getInsight,
  getInsightsForIssues,
  buildSeanContext,
  listInsightTypes
} = require('./services/inventoryInsightService');

const router = express.Router();

// Sub-routers use req.supabase rather than the global singleton imported above.
// Inject it here once so every sub-router downstream receives it without needing
// to import the DB module directly.
router.use((req, _res, next) => {
  req.supabase = supabase;
  next();
});

// ─── Sub-routers ──────────────────────────────────────────────
router.use('/boms', bomRoutes);
router.use('/work-orders', workOrderRoutes);
router.use('/reports', inventoryReportsRoutes);
router.use('/stock-counts', stockCountRoutes);
router.use('/reservations', reservationRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/procurement', procurementRoutes);
router.use('/production', productionRoutes);
router.use('/transfers', warehouseTransferRoutes);
router.use('/sales-orders', salesOrderRoutes);

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ module: 'inventory', status: 'active', version: '2.0.0' });
});

// ─── Permission profile (Codebox 11) ─────────────────────────────────────────
// Returns the calling user's inventory permission set.
// Frontend uses this to show/hide UI — backend still enforces each action.
router.get('/my-permissions', (req, res) => {
  const role = req.user?.role || 'cashier';
  const perms = getInventoryPermsForRole(role);
  res.json({ role, permissions: perms });
});

// ─── Operational Health Engine (Codebox 12) ───────────────────────────────────
// Read-only diagnostic endpoint. Returns issues grouped by severity.
// No mutations. Company-scoped. Safe to call on page load.
router.get('/health', requirePerm(PERM.VIEW), async (req, res) => {
  try {
    const result = await runHealthChecks(supabase, req.companyId);
    const insights = getInsightsForIssues(result.issues);
    res.json({
      severity: result.overallSeverity,
      issue_count: result.issues.length,
      issues:   result.issues,
      insights,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Onboarding Checklist (Codebox 12) ───────────────────────────────────────
// Returns company-scoped setup progress checklist.
router.get('/onboarding', requirePerm(PERM.VIEW), async (req, res) => {
  try {
    const steps = await buildOnboardingChecklist(supabase, req.companyId);
    const doneCount  = steps.filter(s => s.done).length;
    const requiredSteps = steps.filter(s => s.priority === 'required');
    const requiredDone  = requiredSteps.filter(s => s.done).length;
    res.json({
      steps,
      total:             steps.length,
      complete_count:    doneCount,
      required_complete: requiredDone === requiredSteps.length,
      ready_for_pilot:   requiredDone === requiredSteps.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Operational Insight (Codebox 12) ────────────────────────────────────────
// Returns a specific operational insight by type.
// Read-only. Safe for Sean AI to consume.
router.get('/insights/:type', requirePerm(PERM.VIEW), (req, res) => {
  const insight = getInsight(req.params.type);
  if (!insight) return res.status(404).json({ error: 'Insight type not found' });
  res.json({ insight });
});

router.get('/insights', requirePerm(PERM.VIEW), (req, res) => {
  res.json({ types: listInsightTypes() });
});

// ─── Sean AI Context Endpoint (Codebox 12) ────────────────────────────────────
// Read-only operational summary for Sean AI integration.
// Sean can fetch this to understand current state before giving guidance.
// HARD RULE: This endpoint never mutates data.
router.get('/sean-context', requirePerm(PERM.VIEW), async (req, res) => {
  try {
    const [healthResult, onboarding] = await Promise.all([
      runHealthChecks(supabase, req.companyId),
      buildOnboardingChecklist(supabase, req.companyId)
    ]);
    const seanContext = buildSeanContext(healthResult, onboarding);
    res.json(seanContext);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard Stats ─────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const cid = req.companyId;
  try {
    const [items, movements, suppliers, lowStock, openWOs, activeBoMs] = await Promise.all([
      supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('stock_movements').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true).filter('current_stock', 'lte', 'min_stock'),
      supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['released', 'in_progress']),
      supabase.from('bom_headers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('status', 'active'),
    ]);
    res.json({
      total_items:     items.count     || 0,
      total_movements: movements.count || 0,
      total_suppliers: suppliers.count || 0,
      low_stock_count: lowStock.count  || 0,
      open_work_orders: openWOs.count  || 0,
      active_boms:     activeBoMs.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/demo-dashboard', async (req, res) => {
  const cid = req.companyId;
  try {
    const [valuation, totalItems, suppliers, openWOs, openPOs, bomCount, itemTypes, activeReservations] = await Promise.all([
      costingService.getStockValuation(supabase, cid),
      supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['released', 'in_progress']),
      supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['approved', 'ordered', 'partial_receipt']),
      supabase.from('bom_headers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('status', 'active'),
      supabase.from('inventory_items').select('item_type').eq('company_id', cid).eq('is_active', true),
      supabase.from('stock_reservations').select('item_id, quantity_reserved, quantity_released, quantity_consumed').eq('company_id', cid).in('reservation_status', ['active', 'partially_released'])
    ]);

    const items = itemTypes.data || [];
    const rawMaterialCount   = items.filter(item => item.item_type === 'raw_material').length;
    const finishedGoodsCount = items.filter(item => item.item_type === 'finished_good').length;
    const totalStockValue    = valuation.reduce((sum, row) => sum + (parseFloat(row.totalValue) || 0), 0);

    // Compute reservation stats (Codebox 04)
    const reservationRows = activeReservations.data || [];
    const activeReservationCount = reservationRows.length;

    // Aggregate net reserved per item for available_stock based low-stock and shortage counts
    const reservedByItem = {};
    let totalReservedValue = 0;
    for (const r of reservationRows) {
      const net = parseFloat(r.quantity_reserved) - parseFloat(r.quantity_released) - parseFloat(r.quantity_consumed);
      if (net > 0) reservedByItem[r.item_id] = (reservedByItem[r.item_id] || 0) + net;
    }

    // Fetch all active items to compute available-based low stock + shortages
    const { data: allItems } = await supabase
      .from('inventory_items')
      .select('id, current_stock, average_cost, min_stock')
      .eq('company_id', cid)
      .eq('is_active', true);

    let lowStockCount     = 0;
    let shortageItemCount = 0;
    for (const item of (allItems || [])) {
      const onHand    = parseFloat(item.current_stock) || 0;
      const reserved  = reservedByItem[item.id] || 0;
      const available = Math.max(0, onHand - reserved);
      totalReservedValue += reserved * (parseFloat(item.average_cost) || 0);
      if (available <= (parseFloat(item.min_stock) || 0)) lowStockCount++;
      if (reserved > onHand) shortageItemCount++;
    }

    res.json({
      total_items:                       totalItems.count || 0,
      total_stock_value:                 totalStockValue,
      low_stock_count:                   lowStockCount,
      open_work_orders:                  openWOs.count || 0,
      purchase_orders_awaiting_receipt:  openPOs.count || 0,
      finished_goods_count:              finishedGoodsCount,
      raw_material_count:                rawMaterialCount,
      active_boms:                       bomCount.count || 0,
      total_suppliers:                   suppliers.count || 0,
      // Codebox 04 — Reservation stats
      active_reservations:               activeReservationCount,
      total_reserved_value:              totalReservedValue,
      shortage_item_count:               shortageItemCount,
      valuation
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ═══ WAREHOUSES (CB-08 extended) ═════════════════════════════════════════════

router.get('/warehouses', requirePerm(PERM.VIEW), async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  let q = supabase
    .from('warehouses')
    .select('*')
    .eq('company_id', req.companyId)
    .order('name');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouses: data || [] });
});

router.post('/warehouses', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const {
    name, warehouse_code, warehouse_type, is_default,
    address_line1, address_line2, city, postal_code,
    contact_name, contact_phone, contact_email, notes
  } = req.body;
  if (!name) return res.status(400).json({ error: 'Warehouse name is required' });

  const validTypes = ['main','production','quarantine','transit','retail','overflow','other'];
  if (warehouse_type && !validTypes.includes(warehouse_type)) {
    return res.status(400).json({ error: `warehouse_type must be one of: ${validTypes.join(', ')}` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('warehouses')
    .insert({
      company_id:    req.companyId,
      name,
      warehouse_code: warehouse_code ? warehouse_code.toUpperCase().trim() : null,
      warehouse_type: warehouse_type || 'main',
      is_default:    is_default === true || is_default === 'true',
      address_line1: address_line1 || null,
      address_line2: address_line2 || null,
      city:          city          || null,
      postal_code:   postal_code   || null,
      contact_name:  contact_name  || null,
      contact_phone: contact_phone || null,
      contact_email: contact_email || null,
      notes:         notes         || null,
      is_active:     true,
      created_at:    now,
      updated_at:    now
    })
    .select()
    .single();
  if (error) {
    if (error.message?.includes('unique') || error.code === '23505') {
      return res.status(409).json({ error: 'Warehouse code already exists for this company' });
    }
    return res.status(500).json({ error: error.message });
  }
  await auditFromReq(req, 'CREATE', 'warehouse', data.id, { module: 'inventory', name });
  res.status(201).json({ warehouse: data });
});

router.put('/warehouses/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const {
    name, warehouse_code, warehouse_type, is_default,
    address_line1, address_line2, city, postal_code,
    contact_name, contact_phone, contact_email, notes, is_active
  } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (name          !== undefined) updates.name          = name;
  if (warehouse_code !== undefined) updates.warehouse_code = warehouse_code ? warehouse_code.toUpperCase().trim() : null;
  if (warehouse_type !== undefined) updates.warehouse_type = warehouse_type;
  if (is_default     !== undefined) updates.is_default     = is_default;
  if (address_line1  !== undefined) updates.address_line1  = address_line1;
  if (address_line2  !== undefined) updates.address_line2  = address_line2;
  if (city           !== undefined) updates.city           = city;
  if (postal_code    !== undefined) updates.postal_code    = postal_code;
  if (contact_name   !== undefined) updates.contact_name   = contact_name;
  if (contact_phone  !== undefined) updates.contact_phone  = contact_phone;
  if (contact_email  !== undefined) updates.contact_email  = contact_email;
  if (notes          !== undefined) updates.notes          = notes;
  if (is_active      !== undefined) updates.is_active      = is_active;

  const { data, error } = await supabase
    .from('warehouses')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouse: data });
});

// GET /warehouses/:id/locations  (handled by warehouse-locations router)
// GET /warehouses/:id/stock      (handled by warehouse-locations router)
// GET /warehouses/availability   (handled by warehouse-locations router)
router.use('/warehouses', warehouseLocationRoutes);

// GET /warehouses/:id/availability — warehouse-level stock availability
router.get('/warehouses/:id/availability', async (req, res) => {
  const result = await warehouseTransferService.getWarehouseStock(
    supabase, req.companyId, parseInt(req.params.id)
  );
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json({ stock: result.stock });
});

// ═══ STOCK ITEMS ═════════════════════════════════════════════════════════════

router.get('/items', requirePerm(PERM.VIEW), async (req, res) => {
  const { search, category, warehouse_id, low_stock } = req.query;
  let q = supabase
    .from('inventory_items')
    .select('*, warehouses:warehouse_id(name)')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('name');

  if (category) q = q.eq('category', category);
  if (warehouse_id) q = q.eq('warehouse_id', parseInt(warehouse_id));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let results = data || [];
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(i =>
      (i.name && i.name.toLowerCase().includes(s)) ||
      (i.sku && i.sku.toLowerCase().includes(s))
    );
  }

  // Enrich with available_stock from active reservations (Codebox 04)
  if (results.length > 0) {
    const itemIds = results.map(i => i.id);
    const { data: reservations } = await supabase
      .from('stock_reservations')
      .select('item_id, quantity_reserved, quantity_released, quantity_consumed')
      .eq('company_id', req.companyId)
      .in('item_id', itemIds)
      .in('reservation_status', ['active', 'partially_released']);

    const reservedByItem = {};
    for (const r of (reservations || [])) {
      const net = parseFloat(r.quantity_reserved) - parseFloat(r.quantity_released) - parseFloat(r.quantity_consumed);
      reservedByItem[r.item_id] = (reservedByItem[r.item_id] || 0) + net;
    }
    results = results.map(item => ({
      ...item,
      reserved_qty:    reservedByItem[item.id] || 0,
      available_stock: Math.max(0, (parseFloat(item.current_stock) || 0) - (reservedByItem[item.id] || 0))
    }));
  }

  // Low stock filter uses available_stock (not current_stock) so that
  // committed-but-not-yet-issued stock counts against reorder threshold.
  if (low_stock === 'true') {
    results = results.filter(i => i.available_stock <= (i.min_stock || 0));
  }
  res.json({ items: results, total: results.length });
});

router.get('/items/:id', requirePerm(PERM.VIEW), async (req, res) => {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, warehouses:warehouse_id(name)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: data });
});

router.post('/items', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const {
    name, sku, description, category, unit,
    cost_price, sell_price, current_stock, min_stock, warehouse_id,
    // Manufacturing fields
    item_type, barcode, track_lots, track_serials,
    costing_method, lead_time_days,
    // Codebox 10 — UOM fields
    base_unit, default_purchase_unit, default_recipe_unit, default_output_unit
  } = req.body;
  if (!name) return res.status(400).json({ error: 'Item name is required' });

  const validItemTypes = ['raw_material', 'finished_good', 'sub_assembly', 'consumable', 'service'];
  if (item_type && !validItemTypes.includes(item_type)) {
    return res.status(400).json({ error: `item_type must be one of: ${validItemTypes.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      company_id:     req.companyId,
      name,
      sku:            sku || null,
      description:    description || null,
      category:       category || null,
      unit:           unit || 'unit',
      cost_price:     parseFloat(cost_price) || 0,
      sell_price:     parseFloat(sell_price) || 0,
      current_stock:  parseFloat(current_stock) || 0,
      min_stock:      parseFloat(min_stock) || 0,
      warehouse_id:   warehouse_id ? parseInt(warehouse_id) : null,
      is_active:      true,
      // Manufacturing fields
      item_type:      item_type || 'finished_good',
      barcode:        barcode || null,
      track_lots:     track_lots === true || track_lots === 'true',
      track_serials:  track_serials === true || track_serials === 'true',
      costing_method: costing_method || 'average',
      lead_time_days: parseInt(lead_time_days) || 0,
      // Codebox 10 — UOM
      base_unit:             base_unit             || null,
      default_purchase_unit: default_purchase_unit || null,
      default_recipe_unit:   default_recipe_unit   || null,
      default_output_unit:   default_output_unit   || null
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'inventory_item', data.id, { module: 'inventory' });
  res.status(201).json({ item: data });
});

router.put('/items/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const allowed = [
    'name', 'sku', 'description', 'category', 'unit',
    'cost_price', 'sell_price', 'min_stock', 'warehouse_id', 'is_active',
    // Manufacturing fields
    'item_type', 'barcode', 'track_lots', 'track_serials', 'costing_method', 'lead_time_days',
    // Codebox 10 — UOM fields
    'base_unit', 'default_purchase_unit', 'default_recipe_unit', 'default_output_unit'
  ];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('inventory_items')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ item: data });
});

router.delete('/items/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { error } = await supabase
    .from('inventory_items')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DELETE', 'inventory_item', req.params.id, { module: 'inventory' });
  res.json({ success: true });
});

// ═══ STOCK MOVEMENTS ═════════════════════════════════════════════════════════

router.get('/movements', requirePerm(PERM.VIEW), async (req, res) => {
  const { item_id, type, limit = 50 } = req.query;
  let q = supabase
    .from('stock_movements')
    .select('*, inventory_items:item_id(name, sku), warehouses:warehouse_id(name)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));
  if (item_id) q = q.eq('item_id', parseInt(item_id));
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ movements: data || [] });
});

router.get('/items/:id/movements', requirePerm(PERM.VIEW), async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (Number.isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, average_cost, last_purchase_cost, cost_price')
    .eq('id', itemId)
    .eq('company_id', req.companyId)
    .single();

  if (itemErr || !item) return res.status(404).json({ error: 'Item not found' });

  const [movementResult, valuationResult] = await Promise.all([
    supabase
      .from('stock_movements')
      .select('id, company_id, item_id, warehouse_id, movement_type, quantity, reference, notes, unit_cost, created_by, created_at, warehouses:warehouse_id(name)')
      .eq('company_id', req.companyId)
      .eq('item_id', itemId)
      .order('created_at', { ascending: false }),
    supabase
      .from('stock_valuation_movements')
      .select('id, movement_id, movement_type, qty, unit_cost, total_cost, running_avg_cost, running_qty, reference, source_type, source_id, created_by, created_at')
      .eq('company_id', req.companyId)
      .eq('item_id', itemId)
      .order('created_at', { ascending: false })
  ]);

  if (movementResult.error) return res.status(500).json({ error: movementResult.error.message });
  if (valuationResult.error) return res.status(500).json({ error: valuationResult.error.message });

  let history;
  const movementMap = new Map((movementResult.data || []).map(row => [row.id, row]));

  if (valuationResult.data && valuationResult.data.length > 0) {
    // Primary path: build history from stock_valuation_movements (richest data)
    history = valuationResult.data.map(row => {
      const movement = movementMap.get(row.movement_id) || null;
      return {
        date: row.created_at,
        movement_type: row.movement_type || movement?.movement_type || 'movement',
        quantity: parseFloat(row.qty) || parseFloat(movement?.quantity) || 0,
        reference: row.reference || movement?.reference || null,
        notes: movement?.notes || null,
        user_id: row.created_by || movement?.created_by || null,
        resulting_stock: parseFloat(row.running_qty) || null,
        unit_cost: parseFloat(row.unit_cost) || parseFloat(movement?.unit_cost) || 0,
        total_cost: parseFloat(row.total_cost) || 0,
        running_avg_cost: parseFloat(row.running_avg_cost) || null,
        source_type: row.source_type || null,
        source_id: row.source_id || null,
        warehouse: movement?.warehouses?.name || null
      };
    });
  } else {
    // Fallback path: build history directly from stock_movements
    // Used when stock_valuation_movements has no rows (e.g. after adjustStock bypass)
    // Sort ascending by created_at so running totals are computed correctly
    const sorted = [...(movementResult.data || [])].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );
    let runningQty = 0;
    history = sorted.map(row => {
      const qty = parseFloat(row.quantity) || 0;
      const mtype = row.movement_type || 'movement';
      if (mtype === 'in' || mtype === 'return') {
        runningQty += qty;
      } else if (mtype === 'out') {
        runningQty -= qty;
      }
      // 'adjustment' omitted — sign unknown without sign column
      const unitCost = parseFloat(row.unit_cost) || 0;
      return {
        date: row.created_at,
        movement_type: mtype,
        quantity: qty,
        reference: row.reference || null,
        notes: row.notes || null,
        user_id: row.created_by || null,
        resulting_stock: runningQty,
        unit_cost: unitCost,
        total_cost: qty * unitCost,
        running_avg_cost: null,
        source_type: null,
        source_id: null,
        warehouse: row.warehouses?.name || null
      };
    });
  }

  res.json({
    item: {
      id: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      current_stock: item.current_stock,
      average_cost: item.average_cost,
      last_purchase_cost: item.last_purchase_cost,
      cost_price: item.cost_price
    },
    movements: history
  });
});

router.post('/movements', requirePerm(PERM.ADJUST), async (req, res) => {
  const { item_id, warehouse_id, type, quantity, reference, notes, cost_price } = req.body;
  if (!item_id || !type || !quantity) {
    return res.status(400).json({ error: 'item_id, type, and quantity are required' });
  }
  const validTypes = ['in', 'out', 'transfer', 'adjustment', 'return'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  // Determine stock delta (positive = stock in, negative = stock out)
  // transfer and adjustment have delta 0 — they log a movement without stock update
  const delta = ['in', 'return'].includes(type) ? qty : (type === 'out' ? -qty : 0);

  if (delta !== 0) {
    const result = await adjustStockTx(supabase, {
      companyId:    req.companyId,
      itemId:       parseInt(item_id),
      delta,
      movementType: type,
      warehouseId:  warehouse_id ? parseInt(warehouse_id) : null,
      reference:    reference || null,
      notes:        notes || null,
      unitCost:     cost_price ? parseFloat(cost_price) : null,
      createdBy:    req.user.userId,
      sourceType:   'manual',
      sourceId:     null
    });

    if (!result.success) {
      const status = result.error === 'Insufficient stock' ? 422 : 400;
      return res.status(status).json({
        error:     result.error,
        available: result.available,
        requested: qty
      });
    }

    // Fetch the newly created movement for the response
    const { data: movement } = await supabase
      .from('stock_movements')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('item_id', parseInt(item_id))
      .eq('movement_type', type)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    await auditFromReq(req, 'CREATE', 'stock_movement', movement?.id, { module: 'inventory', metadata: { type, qty } });
    return res.status(201).json({ movement: movement || { item_id, type, quantity: qty } });
  }

  // For transfer / adjustment (delta = 0): insert movement record only, no stock change
  const { data: movement, error: mvErr } = await supabase
    .from('stock_movements')
    .insert({
      company_id:    req.companyId,
      item_id:       parseInt(item_id),
      warehouse_id:  warehouse_id ? parseInt(warehouse_id) : null,
      movement_type: type,
      quantity:      qty,
      reference:     reference || null,
      notes:         notes     || null,
      unit_cost:     cost_price ? parseFloat(cost_price) : null,
      created_by:    req.user.userId
    })
    .select().single();
  if (mvErr) return res.status(500).json({ error: mvErr.message });

  await auditFromReq(req, 'CREATE', 'stock_movement', movement.id, { module: 'inventory', metadata: { type, qty } });
  return res.status(201).json({ movement });
});

router.post('/quick-receive', requirePerm(PERM.RECEIVE), async (req, res) => {
  // Codebox 10: supports purchase_unit for pack-size receiving.
  // If purchase_unit is provided, converts qty to base_unit before stock mutation.
  const { supplier_id, item_id, quantity, unit_cost, reference, notes, warehouse_id, purchase_unit } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required' });
  if (!item_id) return res.status(400).json({ error: 'item_id is required' });
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  const qty = parseFloat(quantity);
  const cost = parseFloat(unit_cost);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'quantity must be greater than 0' });
  if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'unit_cost must be a valid number' });

  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name')
    .eq('id', parseInt(supplier_id))
    .eq('company_id', req.companyId)
    .single();
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

  const { data: item } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, base_unit, current_stock, average_cost, last_purchase_cost, cost_price')
    .eq('id', parseInt(item_id))
    .eq('company_id', req.companyId)
    .single();
  if (!item) return res.status(404).json({ error: 'Item not found' });

  // ── UOM conversion (Codebox 10) ─────────────────────────────────────
  let stockDelta = qty;
  let stockUnitCost = cost;
  let baseQty = qty;
  let conversionFactor = 1;
  const effectiveBaseUnit = getEffectiveBaseUnit(item);

  if (purchase_unit && purchase_unit !== effectiveBaseUnit) {
    try {
      const conv = await convertToBaseUnit(supabase, req.companyId, parseInt(item_id), qty, purchase_unit, item);
      baseQty = conv.baseQty;
      conversionFactor = conv.factor;
      stockDelta = baseQty;
      stockUnitCost = computeCostPerBaseUnit(cost, conversionFactor);
    } catch (convErr) {
      return res.status(400).json({ error: `UOM conversion failed: ${convErr.message}` });
    }
  }

  const result = await adjustStockTx(supabase, {
    companyId:    req.companyId,
    itemId:       parseInt(item_id),
    delta:        stockDelta,       // base qty
    movementType: 'in',
    warehouseId:  warehouse_id ? parseInt(warehouse_id) : null,
    reference,
    notes:        notes || `Quick receive from ${supplier.name}`,
    unitCost:     stockUnitCost,    // cost per base unit
    createdBy:    req.user.userId,
    sourceType:   'quick_receive',
    sourceId:     reference
  });

  if (!result.success) {
    const status = result.error === 'Insufficient stock' ? 422 : 400;
    return res.status(status).json({ error: result.error || 'Quick receive failed', available: result.available });
  }

  const { data: updatedItem } = await supabase
    .from('inventory_items')
    .select('id, name, sku, current_stock, average_cost, last_purchase_cost, cost_updated_at, cost_price')
    .eq('id', parseInt(item_id))
    .eq('company_id', req.companyId)
    .single();

  const { data: movement } = await supabase
    .from('stock_movements')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('item_id', parseInt(item_id))
    .eq('reference', reference)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  await auditFromReq(req, 'CREATE', 'stock_movement', movement?.id || null, {
    module: 'inventory',
    metadata: {
      action:           'quick_receive',
      supplier_id:      supplier.id,
      item_id:          item.id,
      purchase_qty:     qty,
      purchase_unit:    purchase_unit || effectiveBaseUnit,
      base_qty:         baseQty,
      unit_cost:        cost,
      unit_cost_base:   stockUnitCost,
      conversion_factor: conversionFactor
    }
  });

  res.status(201).json({
    success:            true,
    supplier,
    item:               updatedItem || item,
    movement:           movement || null,
    new_stock:          result.new_stock,
    new_avg_cost:       result.new_avg_cost ?? updatedItem?.average_cost ?? null,
    // UOM fields for display
    purchase_qty:       qty,
    purchase_unit:      purchase_unit || effectiveBaseUnit,
    base_qty:           baseQty,
    unit_cost_per_base: stockUnitCost,
    conversion_factor:  conversionFactor
  });
});

// ═══ SUPPLIERS ════════════════════════════════════════════════════════════════

router.get('/suppliers', requirePerm(PERM.VIEW), async (req, res) => {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ suppliers: data || [] });
});

router.post('/suppliers', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { name, supplier_code, email, phone, address, contact_name, vat_number, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Supplier name is required' });
  // Auto-generate supplier_code if not provided
  const code = supplier_code || 'SUP-' + Date.now().toString(36).toUpperCase();
  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      company_id: req.companyId, name, supplier_name: name, supplier_code: code,
      email: email || null, phone: phone || null,
      address: address || null, contact_name: contact_name || null,
      vat_number: vat_number || null, notes: notes || null, is_active: true
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'supplier', data.id, { module: 'inventory' });
  res.status(201).json({ supplier: data });
});

router.put('/suppliers/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const allowed = ['name', 'email', 'phone', 'address', 'contact_name', 'vat_number', 'notes', 'is_active'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('suppliers')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ supplier: data });
});

// ═══ PURCHASE ORDERS — delegated to routes/purchase-orders.js (Codebox 05) ════
// router.use('/purchase-orders', purchaseOrderRoutes) is mounted above.

// ═══ LEGACY QUICK-RECEIVE PLACEHOLDER (kept for backward compat) ════════════
// The /quick-receive route below remains inline as it is not PO-based.

// (inline legacy PO routes removed — handled by routes/purchase-orders.js via sub-router)

// ═══ UOM — UNIT OF MEASURE (CODEBOX 10) ══════════════════════════════════════

// GET /uom — list all UOM for company
router.get('/uom', requirePerm(PERM.VIEW), async (req, res) => {
  const { data, error } = await supabase
    .from('unit_of_measure')
    .select('*')
    .eq('company_id', req.companyId)
    .order('unit_code');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ units: data || [] });
});

// POST /uom — create a UOM for company
router.post('/uom', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const { unit_code, unit_name, unit_type, base_dimension } = req.body;
  if (!unit_code) return res.status(400).json({ error: 'unit_code is required' });
  if (!unit_name) return res.status(400).json({ error: 'unit_name is required' });
  const validTypes = ['weight','volume','count','package','production_output'];
  if (unit_type && !validTypes.includes(unit_type)) {
    return res.status(400).json({ error: `unit_type must be one of: ${validTypes.join(', ')}` });
  }
  const { data, error } = await supabase
    .from('unit_of_measure')
    .insert({
      company_id:     req.companyId,
      unit_code:      unit_code.trim(),
      unit_name:      unit_name.trim(),
      unit_type:      unit_type || 'count',
      base_dimension: base_dimension || null,
      is_active:      true
    })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Unit code already exists for this company' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ unit: data });
});

// PUT /uom/:id — update UOM
router.put('/uom/:id', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const allowed = ['unit_name', 'unit_type', 'base_dimension', 'is_active'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });
  const { data, error } = await supabase
    .from('unit_of_measure')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ unit: data });
});

// GET /items/:id/uom-profile — full UOM profile for an item
router.get('/items/:id/uom-profile', async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (Number.isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });
  try {
    const profile = await getItemUomProfile(supabase, req.companyId, itemId);
    res.json({ uom_profile: profile });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /items/:id/uom-conversions — list conversions for an item
router.get('/items/:id/uom-conversions', async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (Number.isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });
  const { data, error } = await supabase
    .from('item_uom_conversions')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('item_id', itemId)
    .order('from_unit');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ conversions: data || [] });
});

// POST /items/:id/uom-conversions — add a conversion for an item
router.post('/items/:id/uom-conversions', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (Number.isNaN(itemId)) return res.status(400).json({ error: 'Invalid item id' });

  const {
    from_unit, to_unit, conversion_factor, conversion_description,
    is_purchase_unit, is_recipe_unit, is_output_unit
  } = req.body;

  if (!from_unit)           return res.status(400).json({ error: 'from_unit is required' });
  if (!to_unit)             return res.status(400).json({ error: 'to_unit is required' });
  if (!conversion_factor)   return res.status(400).json({ error: 'conversion_factor is required' });

  const factor = parseFloat(conversion_factor);
  if (!Number.isFinite(factor) || factor <= 0) {
    return res.status(400).json({ error: 'conversion_factor must be a positive number' });
  }

  // Verify item belongs to this company
  const { data: item } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('id', itemId)
    .eq('company_id', req.companyId)
    .single();
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('item_uom_conversions')
    .insert({
      company_id:             req.companyId,
      item_id:                itemId,
      from_unit:              from_unit.trim(),
      to_unit:                to_unit.trim(),
      conversion_factor:      factor,
      conversion_description: conversion_description || null,
      is_purchase_unit:       is_purchase_unit === true || is_purchase_unit === 'true',
      is_recipe_unit:         is_recipe_unit   === true || is_recipe_unit   === 'true',
      is_output_unit:         is_output_unit   === true || is_output_unit   === 'true',
      is_active:              true,
      created_at:             now,
      updated_at:             now
    })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Conversion already exists for this unit pair' });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ conversion: data });
});

// PUT /items/:id/uom-conversions/:convId — update a conversion
router.put('/items/:id/uom-conversions/:convId', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const itemId = parseInt(req.params.id);
  const convId = parseInt(req.params.convId);
  if (Number.isNaN(itemId) || Number.isNaN(convId)) return res.status(400).json({ error: 'Invalid id' });

  const allowed = ['conversion_factor', 'conversion_description', 'is_purchase_unit', 'is_recipe_unit', 'is_output_unit', 'is_active'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (updates.conversion_factor !== undefined) {
    const factor = parseFloat(updates.conversion_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return res.status(400).json({ error: 'conversion_factor must be a positive number' });
    }
    updates.conversion_factor = factor;
  }

  const { data, error } = await supabase
    .from('item_uom_conversions')
    .update(updates)
    .eq('id', convId)
    .eq('item_id', itemId)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Conversion not found' });
  res.json({ conversion: data });
});

// DELETE /items/:id/uom-conversions/:convId — deactivate a conversion
router.delete('/items/:id/uom-conversions/:convId', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const itemId = parseInt(req.params.id);
  const convId = parseInt(req.params.convId);
  if (Number.isNaN(itemId) || Number.isNaN(convId)) return res.status(400).json({ error: 'Invalid id' });

  const { error } = await supabase
    .from('item_uom_conversions')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', convId)
    .eq('item_id', itemId)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ═══ CATEGORIES ══════════════════════════════════════════════════════════════

router.get('/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('category')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .not('category', 'is', null);
  if (error) return res.status(500).json({ error: error.message });
  const cats = [...new Set((data || []).map(r => r.category))].sort();
  res.json({ categories: cats });
});

module.exports = router;
