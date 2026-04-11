/**
 * ============================================================================
 * Work Order Routes
 * ============================================================================
 * Endpoints:
 *   GET    /work-orders               — list work orders (filterable by status)
 *   GET    /work-orders/:id           — get single WO with materials
 *   POST   /work-orders               — create WO (auto-populate materials from BOM)
 *   PUT    /work-orders/:id           — update WO header fields
 *   POST   /work-orders/:id/release   — draft → released
 *   POST   /work-orders/:id/start     — released → in_progress
 *   POST   /work-orders/:id/complete  — in_progress → completed (receive finished goods)
 *   POST   /work-orders/:id/cancel    — draft|released|in_progress → cancelled
 *   POST   /work-orders/:id/issue-materials — record materials issued for in_progress WO
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

// ─── Allowed status transitions ───────────────────────────────────────────────
const TRANSITIONS = {
  draft:       ['released', 'cancelled'],
  released:    ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed:   [],
  cancelled:   []
};

function canTransition(from, to) {
  return TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}

// ─── Generate next WO number ──────────────────────────────────────────────────
async function nextWoNumber(companyId) {
  const prefix = 'WO-';
  const { data } = await supabase
    .from('work_orders')
    .select('wo_number')
    .eq('company_id', companyId)
    .like('wo_number', `${prefix}%`)
    .order('wo_number', { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return `${prefix}00001`;
  const last = parseInt((data[0].wo_number || '').replace(prefix, ''), 10) || 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

// ─── List Work Orders ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status, item_id, limit = 100 } = req.query;

  let q = supabase
    .from('work_orders')
    .select('*, inventory_items:item_id(name, sku, unit), bom_headers:bom_id(name, version)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (status) q = q.eq('status', status);
  if (item_id) q = q.eq('item_id', parseInt(item_id));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ work_orders: data || [] });
});

// ─── Get single WO with materials ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { data: wo, error: wErr } = await supabase
    .from('work_orders')
    .select('*, inventory_items:item_id(name, sku, unit), bom_headers:bom_id(name, version)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (wErr || !wo) return res.status(404).json({ error: 'Work order not found' });

  const { data: materials, error: mErr } = await supabase
    .from('work_order_materials')
    .select('*, inventory_items:item_id(name, sku, unit, current_stock)')
    .eq('work_order_id', wo.id);

  if (mErr) return res.status(500).json({ error: mErr.message });

  res.json({ work_order: { ...wo, materials: materials || [] } });
});

// ─── Create Work Order ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    item_id, bom_id, quantity_to_produce,
    planned_start_date, planned_end_date, notes
  } = req.body;

  if (!item_id)              return res.status(400).json({ error: 'item_id is required' });
  if (!quantity_to_produce)  return res.status(400).json({ error: 'quantity_to_produce is required' });

  const qty = parseFloat(quantity_to_produce);
  if (qty <= 0) return res.status(400).json({ error: 'quantity_to_produce must be > 0' });

  // Verify item belongs to company
  const { data: item } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('id', parseInt(item_id))
    .eq('company_id', req.companyId)
    .single();
  if (!item) return res.status(400).json({ error: 'Item not found' });

  // If bom_id provided, verify it belongs to company and matches item
  let bomLines = [];
  let bomOutputQty = 1;
  if (bom_id) {
    const { data: bom } = await supabase
      .from('bom_headers')
      .select('id, item_id, output_qty, status')
      .eq('id', parseInt(bom_id))
      .eq('company_id', req.companyId)
      .single();
    if (!bom) return res.status(400).json({ error: 'BOM not found' });
    if (bom.item_id !== parseInt(item_id)) {
      return res.status(400).json({ error: 'BOM does not match the selected item' });
    }
    bomOutputQty = bom.output_qty || 1;

    const { data: lines } = await supabase
      .from('bom_lines')
      .select('item_id, quantity, scrap_percent')
      .eq('bom_id', bom.id);
    bomLines = lines || [];
  }

  const wo_number = await nextWoNumber(req.companyId);

  const { data: wo, error: wErr } = await supabase
    .from('work_orders')
    .insert({
      company_id:           req.companyId,
      wo_number,
      item_id:              parseInt(item_id),
      bom_id:               bom_id ? parseInt(bom_id) : null,
      quantity_to_produce:  qty,
      quantity_produced:    0,
      status:               'draft',
      planned_start_date:   planned_start_date || null,
      planned_end_date:     planned_end_date || null,
      notes:                notes || null,
      created_by:           req.user.userId
    })
    .select().single();

  if (wErr) return res.status(500).json({ error: wErr.message });

  // Auto-populate material requirements from BOM lines
  if (bomLines.length > 0) {
    const multiplier = qty / bomOutputQty;
    const materialRows = bomLines.map(l => ({
      work_order_id: wo.id,
      item_id:       l.item_id,
      // required_qty accounts for per-line scrap allowance
      required_qty:  parseFloat(((l.quantity * multiplier) * (1 + (l.scrap_percent || 0) / 100)).toFixed(4)),
      issued_qty:    0
    }));
    await supabase.from('work_order_materials').insert(materialRows);
  }

  await auditFromReq(req, 'CREATE', 'work_order', wo.id, { module: 'inventory' });
  res.status(201).json({ work_order: wo });
});

// ─── Update WO header (draft only for most fields) ────────────────────────────
router.put('/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('work_orders')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Work order not found' });

  const allowed = ['planned_start_date', 'planned_end_date', 'notes'];
  // Only allow qty/bom changes on draft
  if (existing.status === 'draft') {
    allowed.push('quantity_to_produce', 'bom_id');
  }

  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  const { data, error } = await supabase
    .from('work_orders')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ work_order: data });
});

// ─── Status transition helper ─────────────────────────────────────────────────
async function transitionStatus(req, res, toStatus, extraUpdates = {}) {
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, toStatus)) {
    return res.status(400).json({ error: `Cannot transition from '${wo.status}' to '${toStatus}'` });
  }

  const updates = { status: toStatus, updated_at: new Date().toISOString(), ...extraUpdates };
  const { data, error } = await supabase
    .from('work_orders')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { from_status: wo.status, to_status: toStatus }
  });
  return data;
}

// ─── Release ──────────────────────────────────────────────────────────────────
router.post('/:id/release', async (req, res) => {
  const result = await transitionStatus(req, res, 'released');
  if (result) res.json({ work_order: result });
});

// ─── Start ────────────────────────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  const result = await transitionStatus(req, res, 'in_progress', {
    actual_start_date: new Date().toISOString().split('T')[0]
  });
  if (result) res.json({ work_order: result });
});

// ─── Complete (receive finished goods into stock) ─────────────────────────────
router.post('/:id/complete', async (req, res) => {
  const { quantity_produced } = req.body;

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status, item_id, quantity_to_produce, quantity_produced')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, 'completed')) {
    return res.status(400).json({ error: `Cannot complete a WO in '${wo.status}' status` });
  }

  const qtyProduced = quantity_produced !== undefined
    ? parseFloat(quantity_produced)
    : wo.quantity_to_produce;
  if (qtyProduced <= 0) return res.status(400).json({ error: 'quantity_produced must be > 0' });

  // Record a stock-in movement for the finished goods
  await supabase.from('stock_movements').insert({
    company_id:  req.companyId,
    item_id:     wo.item_id,
    type:        'in',
    quantity:    qtyProduced,
    reference:   `WO ${req.params.id}`,
    notes:       'Received from work order',
    created_by:  req.user.userId
  });

  // Update item current_stock
  const { data: itemRow } = await supabase
    .from('inventory_items')
    .select('current_stock')
    .eq('id', wo.item_id)
    .eq('company_id', req.companyId)
    .single();
  if (itemRow) {
    await supabase
      .from('inventory_items')
      .update({
        current_stock: (itemRow.current_stock || 0) + qtyProduced,
        updated_at: new Date().toISOString()
      })
      .eq('id', wo.item_id)
      .eq('company_id', req.companyId);
  }

  const { data, error } = await supabase
    .from('work_orders')
    .update({
      status:              'completed',
      quantity_produced:   qtyProduced,
      actual_end_date:     new Date().toISOString().split('T')[0],
      updated_at:          new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { action: 'complete', qty_produced: qtyProduced }
  });
  res.json({ work_order: data });
});

// ─── Cancel ───────────────────────────────────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  const result = await transitionStatus(req, res, 'cancelled');
  if (result) res.json({ work_order: result });
});

// ─── Issue Materials ──────────────────────────────────────────────────────────
// Records that materials have been physically taken from stock for this WO.
// Updates issued_qty on work_order_materials and deducts from inventory.
router.post('/:id/issue-materials', async (req, res) => {
  const { issues } = req.body; // Array of { material_id, qty }

  if (!Array.isArray(issues) || issues.length === 0) {
    return res.status(400).json({ error: 'issues array is required' });
  }

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (wo.status !== 'in_progress') {
    return res.status(400).json({ error: 'Can only issue materials to an in-progress work order' });
  }

  const errors = [];
  for (const issue of issues) {
    const qty = parseFloat(issue.qty);
    if (!issue.material_id || !qty || qty <= 0) {
      errors.push(`Invalid issue: material_id and qty > 0 required`);
      continue;
    }

    // Get the material record
    const { data: mat } = await supabase
      .from('work_order_materials')
      .select('id, item_id, required_qty, issued_qty')
      .eq('id', parseInt(issue.material_id))
      .eq('work_order_id', wo.id)
      .single();

    if (!mat) {
      errors.push(`Material ${issue.material_id} not found on this WO`);
      continue;
    }

    // Update issued qty
    await supabase
      .from('work_order_materials')
      .update({ issued_qty: (mat.issued_qty || 0) + qty })
      .eq('id', mat.id);

    // Deduct from inventory
    const { data: itemRow } = await supabase
      .from('inventory_items')
      .select('current_stock')
      .eq('id', mat.item_id)
      .eq('company_id', req.companyId)
      .single();
    if (itemRow) {
      await supabase
        .from('inventory_items')
        .update({
          current_stock: Math.max(0, (itemRow.current_stock || 0) - qty),
          updated_at: new Date().toISOString()
        })
        .eq('id', mat.item_id)
        .eq('company_id', req.companyId);
    }

    // Record movement
    await supabase.from('stock_movements').insert({
      company_id:  req.companyId,
      item_id:     mat.item_id,
      type:        'out',
      quantity:    qty,
      reference:   `WO ${req.params.id}`,
      notes:       'Issued to work order',
      created_by:  req.user.userId
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { action: 'issue_materials', count: issues.length }
  });
  res.json({ success: true });
});

module.exports = router;
