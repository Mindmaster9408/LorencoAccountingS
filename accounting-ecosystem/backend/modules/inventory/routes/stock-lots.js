'use strict';

/**
 * ============================================================================
 * Stock Lots — Lot number + expiry tracking (Stockton Proof scoping, 2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/stock-lots
 *
 * Lot-level tracking (not full unit-level serialization — that's a
 * materially larger feature and wasn't what the gap audit called for): a
 * batch of received stock gets a lot number and an optional expiry date,
 * with a running quantity_remaining so FEFO-aware picking and expiry
 * reporting are both possible.
 *
 * Endpoints:
 *   GET  /stock-lots                 — list lots (filter: item_id, warehouse_id, expiring_before)
 *   POST /stock-lots                 — receive a new lot
 *   POST /stock-lots/:id/consume     — reduce quantity_remaining (sale/usage)
 *   GET  /stock-lots/expiring        — lots expiring within N days (default 30)
 * ============================================================================
 */

const express = require('express');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

router.get('/', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase = req.supabase;
  const { item_id, warehouse_id, include_empty } = req.query;

  let q = supabase
    .from('inventory_stock_lots')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', req.companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (item_id)      q = q.eq('item_id', parseInt(item_id));
  if (warehouse_id) q = q.eq('warehouse_id', parseInt(warehouse_id));
  if (include_empty !== 'true') q = q.gt('quantity_remaining', 0);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ lots: data || [], total: (data || []).length });
});

router.get('/expiring', requirePerm(PERM.VIEW), async (req, res) => {
  const supabase = req.supabase;
  const days = Math.max(1, parseInt(req.query.days) || 30);
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('inventory_stock_lots')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', req.companyId)
    .not('expiry_date', 'is', null)
    .lte('expiry_date', cutoff)
    .gt('quantity_remaining', 0)
    .order('expiry_date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ lots: data || [], days, cutoff });
});

router.post('/', requirePerm(PERM.RECEIVE), async (req, res) => {
  const supabase = req.supabase;
  const {
    item_id, warehouse_id, lot_number, expiry_date,
    quantity_received, unit_cost, supplier_id, po_reference,
  } = req.body;

  if (!item_id || !lot_number || quantity_received === undefined) {
    return res.status(400).json({ error: 'item_id, lot_number, and quantity_received are required' });
  }
  const qty = parseFloat(quantity_received);
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity_received must be a positive number' });

  const { data, error } = await supabase
    .from('inventory_stock_lots')
    .insert({
      company_id:         req.companyId,
      item_id:            parseInt(item_id),
      warehouse_id:       warehouse_id ? parseInt(warehouse_id) : null,
      lot_number:         String(lot_number).trim(),
      expiry_date:        expiry_date || null,
      quantity_received:  qty,
      quantity_remaining: qty,
      unit_cost:          unit_cost != null ? parseFloat(unit_cost) : null,
      supplier_id:        supplier_id ? parseInt(supplier_id) : null,
      po_reference:       po_reference || null,
      received_by:        req.user.userId,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Lot number "${lot_number}" already exists for this item.` });
    return res.status(500).json({ error: error.message });
  }

  await auditFromReq(req, 'CREATE', 'inventory_stock_lot', data.id, {
    module: 'inventory',
    metadata: { item_id: parseInt(item_id), lot_number, quantity_received: qty, expiry_date: expiry_date || null },
  });
  res.status(201).json({ lot: data });
});

// Reduces quantity_remaining on a specific lot — used when a caller wants
// FEFO-aware consumption (pick the earliest-expiring lot first) rather than
// generic stock decrement. Does NOT itself move stock_movements/current_stock
// — callers combine this with the existing adjustStockTx path; this only
// tracks which lot the consumed quantity came from.
router.post('/:id/consume', requirePerm(PERM.ADJUST), async (req, res) => {
  const supabase = req.supabase;
  const lotId = parseInt(req.params.id);
  const { quantity, reference } = req.body;
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });

  const { data: lot } = await supabase
    .from('inventory_stock_lots')
    .select('id, quantity_remaining, lot_number, item_id, qc_status')
    .eq('id', lotId)
    .eq('company_id', req.companyId)
    .single();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  // Quality control gate (Stockton Proof scoping, 2026-09-13): a lot awaiting
  // or failing QC cannot be consumed/shipped — this is the actual enforcement
  // point for the finished-production QC gate (see work-orders.js /:id/complete
  // and production-batches.js /batches/:id/qc-inspect).
  if (lot.qc_status !== 'passed') {
    return res.status(422).json({
      error: `This lot cannot be consumed — its QC status is "${lot.qc_status}".`,
      qc_status: lot.qc_status,
    });
  }
  if (qty > parseFloat(lot.quantity_remaining)) {
    return res.status(422).json({ error: 'Cannot consume more than the lot\'s remaining quantity', available: lot.quantity_remaining });
  }

  const { data, error } = await supabase
    .from('inventory_stock_lots')
    .update({
      quantity_remaining: parseFloat(lot.quantity_remaining) - qty,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lotId)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'inventory_stock_lot', lotId, {
    module: 'inventory',
    metadata: { action: 'consume', quantity: qty, reference: reference || null },
  });
  res.json({ lot: data });
});

module.exports = router;
