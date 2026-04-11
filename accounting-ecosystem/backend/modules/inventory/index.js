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

const router = express.Router();

// ─── Sub-routers ──────────────────────────────────────────────────────────────
router.use('/boms', bomRoutes);
router.use('/work-orders', workOrderRoutes);

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
  const { data: movement, error: mvErr } = await supabase
    .from('stock_movements')
    .insert({
      company_id: req.companyId,
      item_id: parseInt(item_id),
      warehouse_id: warehouse_id ? parseInt(warehouse_id) : null,
      type, quantity: qty,
      reference: reference || null,
      notes: notes || null,
      cost_price: cost_price ? parseFloat(cost_price) : null,
      created_by: req.user.userId
    })
    .select().single();
  if (mvErr) return res.status(500).json({ error: mvErr.message });

  // Update item stock level
  const delta = ['in', 'return'].includes(type) ? qty : (type === 'out' ? -qty : 0);
  if (delta !== 0) {
    const { data: item } = await supabase
      .from('inventory_items')
      .select('current_stock')
      .eq('id', item_id)
      .eq('company_id', req.companyId)
      .single();
    if (item) {
      const newStock = (item.current_stock || 0) + delta;
      await supabase
        .from('inventory_items')
        .update({ current_stock: newStock, updated_at: new Date().toISOString() })
        .eq('id', item_id)
        .eq('company_id', req.companyId);
    }
  }

  await auditFromReq(req, 'CREATE', 'stock_movement', movement.id, { module: 'inventory', metadata: { type, qty } });
  res.status(201).json({ movement });
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
  const { name, email, phone, address, contact_name, vat_number, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Supplier name is required' });
  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      company_id: req.companyId, name,
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
