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
const costingService = require('./services/costingService');
const { adjustStockTx } = require('./services/stockMutationService');

const router = express.Router();

// ─── Sub-routers ──────────────────────────────────────────────────────────────
router.use('/boms', bomRoutes);
router.use('/work-orders', workOrderRoutes);
router.use('/reports', inventoryReportsRoutes);

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ module: 'inventory', status: 'active', version: '2.0.0' });
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
    const [valuation, totalItems, lowStock, suppliers, openWOs, openPOs, bomCount, itemTypes] = await Promise.all([
      costingService.getStockValuation(supabase, cid),
      supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true).filter('current_stock', 'lte', 'min_stock'),
      supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['released', 'in_progress']),
      supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['sent', 'partial_receipt']),
      supabase.from('bom_headers').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('status', 'active'),
      supabase.from('inventory_items').select('item_type').eq('company_id', cid).eq('is_active', true)
    ]);

    const items = itemTypes.data || [];
    const rawMaterialCount = items.filter(item => item.item_type === 'raw_material').length;
    const finishedGoodsCount = items.filter(item => item.item_type === 'finished_good').length;
    const totalStockValue = valuation.reduce((sum, row) => sum + (parseFloat(row.totalValue) || 0), 0);

    res.json({
      total_items: totalItems.count || 0,
      total_stock_value: totalStockValue,
      low_stock_count: lowStock.count || 0,
      open_work_orders: openWOs.count || 0,
      purchase_orders_awaiting_receipt: openPOs.count || 0,
      finished_goods_count: finishedGoodsCount,
      raw_material_count: rawMaterialCount,
      active_boms: bomCount.count || 0,
      total_suppliers: suppliers.count || 0,
      valuation
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ═══ WAREHOUSES ══════════════════════════════════════════════════════════════

router.get('/warehouses', async (req, res) => {
  const { data, error } = await supabase
    .from('warehouses')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouses: data || [] });
});

router.post('/warehouses', async (req, res) => {
  const { name, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Warehouse name is required' });
  const { data, error } = await supabase
    .from('warehouses')
    .insert({ company_id: req.companyId, name, address: address || null, notes: notes || null, is_active: true })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'warehouse', data.id, { module: 'inventory' });
  res.status(201).json({ warehouse: data });
});

router.put('/warehouses/:id', async (req, res) => {
  const { name, address, notes, is_active } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (address !== undefined) updates.address = address;
  if (notes !== undefined) updates.notes = notes;
  if (is_active !== undefined) updates.is_active = is_active;
  const { data, error } = await supabase
    .from('warehouses')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ warehouse: data });
});

// ═══ STOCK ITEMS ═════════════════════════════════════════════════════════════

router.get('/items', async (req, res) => {
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
  if (low_stock === 'true') {
    results = results.filter(i => i.current_stock <= (i.min_stock || 0));
  }
  res.json({ items: results, total: results.length });
});

router.get('/items/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*, warehouses:warehouse_id(name)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: data });
});

router.post('/items', async (req, res) => {
  const {
    name, sku, description, category, unit,
    cost_price, sell_price, current_stock, min_stock, warehouse_id,
    // Manufacturing fields
    item_type, barcode, track_lots, track_serials,
    costing_method, lead_time_days
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
      lead_time_days: parseInt(lead_time_days) || 0
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'inventory_item', data.id, { module: 'inventory' });
  res.status(201).json({ item: data });
});

router.put('/items/:id', async (req, res) => {
  const allowed = [
    'name', 'sku', 'description', 'category', 'unit',
    'cost_price', 'sell_price', 'min_stock', 'warehouse_id', 'is_active',
    // Manufacturing fields
    'item_type', 'barcode', 'track_lots', 'track_serials', 'costing_method', 'lead_time_days'
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

router.delete('/items/:id', async (req, res) => {
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

router.get('/movements', async (req, res) => {
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

router.get('/items/:id/movements', async (req, res) => {
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

router.post('/movements', async (req, res) => {
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

router.post('/quick-receive', async (req, res) => {
  const { supplier_id, item_id, quantity, unit_cost, reference, notes, warehouse_id } = req.body;

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
    .select('id, name, sku, current_stock, average_cost, last_purchase_cost, cost_price')
    .eq('id', parseInt(item_id))
    .eq('company_id', req.companyId)
    .single();
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const result = await adjustStockTx(supabase, {
    companyId:    req.companyId,
    itemId:       parseInt(item_id),
    delta:        qty,
    movementType: 'in',
    warehouseId:  warehouse_id ? parseInt(warehouse_id) : null,
    reference,
    notes:        notes || `Quick receive from ${supplier.name}`,
    unitCost:     cost,
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
    metadata: { action: 'quick_receive', supplier_id: supplier.id, item_id: item.id, quantity: qty, unit_cost: cost }
  });

  res.status(201).json({
    success: true,
    supplier,
    item: updatedItem || item,
    movement: movement || null,
    new_stock: result.new_stock,
    new_avg_cost: result.new_avg_cost ?? updatedItem?.average_cost ?? null
  });
});

// ═══ SUPPLIERS ════════════════════════════════════════════════════════════════

router.get('/suppliers', async (req, res) => {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ suppliers: data || [] });
});

router.post('/suppliers', async (req, res) => {
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

router.put('/suppliers/:id', async (req, res) => {
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

// ═══ PURCHASE ORDERS ═════════════════════════════════════════════════════════

router.get('/purchase-orders', async (req, res) => {
  const { status } = req.query;
  let q = supabase
    .from('purchase_orders')
    .select('*, suppliers:supplier_id(name)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ purchase_orders: data || [] });
});

router.get('/purchase-orders/:id', async (req, res) => {
  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .select('*, suppliers:supplier_id(name, email, phone)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });

  const { data: lines, error: linesErr } = await supabase
    .from('purchase_order_items')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('po_id', po.id);
  if (linesErr) return res.status(500).json({ error: linesErr.message });

  res.json({ purchase_order: { ...po, lines: lines || [] } });
});

router.post('/purchase-orders', async (req, res) => {
  const { supplier_id, notes, expected_date, items } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required' });

  const total = Array.isArray(items) ? items.reduce((s, i) => s + (i.quantity * i.unit_price), 0) : 0;

  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .insert({
      company_id: req.companyId,
      supplier_id: parseInt(supplier_id),
      status: 'draft',
      total_amount: total,
      notes: notes || null,
      expected_date: expected_date || null,
      created_by: req.user.userId
    })
    .select().single();
  if (poErr) return res.status(500).json({ error: poErr.message });

  // Insert line items
  if (Array.isArray(items) && items.length > 0) {
    const lines = items.map(i => ({
      po_id: po.id,
      item_id: parseInt(i.item_id),
      quantity: parseFloat(i.quantity),
      unit_price: parseFloat(i.unit_price),
      received_qty: 0
    }));
    await supabase.from('purchase_order_items').insert(lines);
  }

  await auditFromReq(req, 'CREATE', 'purchase_order', po.id, { module: 'inventory' });
  res.status(201).json({ purchase_order: po });
});

router.put('/purchase-orders/:id', async (req, res) => {
  const allowed = ['status', 'notes', 'expected_date', 'total_amount'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('purchase_orders')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ purchase_order: data });
});

// ─── PO Receiving Flow ────────────────────────────────────────────────────────
// POST /purchase-orders/:id/receive
// Payload: { lines: [{ po_item_id, received_qty }], notes? }
// Atomically receives goods: updates received_qty on each line, creates stock-in
// movements via RPC, and updates PO status to partial_receipt or received.
router.post('/purchase-orders/:id/receive', async (req, res) => {
  const { lines, notes } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines array with at least one entry is required' });
  }

  // Verify PO belongs to this company and is in a receivable state
  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .select('id, status, supplier_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (poErr || !po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'Cannot receive against a cancelled purchase order' });
  if (po.status === 'received')  return res.status(400).json({ error: 'Purchase order is already fully received' });

  // Fetch all PO lines for this PO
  const poItemIds = lines.map(l => parseInt(l.po_item_id)).filter(id => !isNaN(id));
  const { data: poItems, error: itemsErr } = await supabase
    .from('purchase_order_items')
    .select('id, item_id, quantity, received_qty, unit_price')
    .eq('po_id', req.params.id)
    .in('id', poItemIds);

  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // Pre-validate all lines before applying any changes
  for (const line of lines) {
    const poItem = (poItems || []).find(i => i.id === parseInt(line.po_item_id));
    if (!poItem) {
      return res.status(400).json({ error: `PO line ${line.po_item_id} not found on this purchase order` });
    }
    const recQty = parseFloat(line.received_qty);
    if (isNaN(recQty) || recQty <= 0) {
      return res.status(400).json({ error: `received_qty must be > 0 for line ${line.po_item_id}` });
    }
    const totalWouldReceive = (parseFloat(poItem.received_qty) || 0) + recQty;
    if (totalWouldReceive > parseFloat(poItem.quantity)) {
      return res.status(400).json({
        error: `Over-receiving prevented on line ${line.po_item_id}. Ordered: ${poItem.quantity}, already received: ${poItem.received_qty}, trying to receive: ${recQty}`
      });
    }
  }

  // Apply all lines
  for (const line of lines) {
    const poItem = (poItems || []).find(i => i.id === parseInt(line.po_item_id));
    const recQty = parseFloat(line.received_qty);
    const newReceivedQty = (parseFloat(poItem.received_qty) || 0) + recQty;

    // Update received_qty on PO line
    const { error: lineUpdateErr } = await supabase
      .from('purchase_order_items')
      .update({ received_qty: newReceivedQty })
      .eq('id', poItem.id);
    if (lineUpdateErr) return res.status(500).json({ error: lineUpdateErr.message });

    // Atomic stock-in via service — unit_price from PO line feeds weighted average costing
    const rpcResult = await adjustStockTx(supabase, {
      companyId:    req.companyId,
      itemId:       poItem.item_id,
      delta:        recQty,
      movementType: 'in',
      warehouseId:  null,
      reference:    `PO-${req.params.id}`,
      notes:        notes || `Received from PO #${req.params.id}`,
      unitCost:     poItem.unit_price ? parseFloat(poItem.unit_price) : null,
      createdBy:    req.user.userId,
      sourceType:   'po_receive',
      sourceId:     String(req.params.id)
    });

    if (!rpcResult.success) {
      return res.status(500).json({ error: rpcResult.error || 'Stock update failed' });
    }
  }

  // Determine new PO status — re-fetch all lines to check completion
  const { data: allLines } = await supabase
    .from('purchase_order_items')
    .select('quantity, received_qty')
    .eq('po_id', req.params.id);

  const fullyReceived = (allLines || []).length > 0 &&
    (allLines || []).every(l => (parseFloat(l.received_qty) || 0) >= parseFloat(l.quantity));
  const newStatus = fullyReceived ? 'received' : 'partial_receipt';

  const { data: updatedPo, error: updateErr } = await supabase
    .from('purchase_orders')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await auditFromReq(req, 'UPDATE', 'purchase_order', req.params.id, {
    module: 'inventory',
    metadata: { action: 'receive', lines_count: lines.length, new_status: newStatus }
  });
  res.json({ purchase_order: updatedPo, status: newStatus });
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
