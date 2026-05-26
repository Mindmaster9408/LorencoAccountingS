/**
 * ============================================================================
 * Reservations Routes — Codebox 04
 * ============================================================================
 * Endpoints:
 *   GET    /reservations                         — list reservations (filterable)
 *   GET    /reservations/availability/:itemId    — available stock for an item
 *   GET    /reservations/reports/shortages       — items where reserved > available
 *   GET    /reservations/item/:itemId            — all reservations for one item
 *   GET    /reservations/source/:type/:sourceId  — all reservations for a WO/source
 *   POST   /reservations/manual-hold             — create a manual stock hold
 *   POST   /reservations/:id/release             — release a reservation (full/partial)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const reservationService = require('../services/reservationService');

const router = express.Router();

// ─── List reservations ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status, source_type, item_id, limit = 200 } = req.query;

  let q = supabase
    .from('stock_reservations')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (status)      q = q.eq('reservation_status', status);
  if (source_type) q = q.eq('source_type', source_type);
  if (item_id)     q = q.eq('item_id', parseInt(item_id));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ reservations: data || [], total: (data || []).length });
});

// ─── Available stock for a single item ───────────────────────────────────────
// NOTE: Must be declared before /:id to avoid route collision.
router.get('/availability/:itemId', async (req, res) => {
  const { warehouse_id } = req.query;
  const result = await reservationService.getAvailableStock(
    supabase,
    req.companyId,
    parseInt(req.params.itemId),
    warehouse_id ? parseInt(warehouse_id) : null
  );
  if (!result.success) {
    return res.status(result.error === 'Item not found' ? 404 : 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── Shortage report ──────────────────────────────────────────────────────────
// NOTE: Must be declared before /:id to avoid route collision.
router.get('/reports/shortages', async (req, res) => {
  const result = await reservationService.getShortageReport(supabase, req.companyId);
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json(result);
});

// ─── Reservations for one item ────────────────────────────────────────────────
router.get('/item/:itemId', async (req, res) => {
  const { status } = req.query;
  let q = supabase
    .from('stock_reservations')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('item_id', parseInt(req.params.itemId))
    .order('created_at', { ascending: false });

  if (status) q = q.eq('reservation_status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ reservations: data || [], total: (data || []).length });
});

// ─── Reservations for a source ────────────────────────────────────────────────
router.get('/source/:sourceType/:sourceId', async (req, res) => {
  const result = await reservationService.getReservationsForSource(
    supabase,
    req.companyId,
    req.params.sourceType,
    req.params.sourceId
  );
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json(result);
});

// ─── Create a manual hold ─────────────────────────────────────────────────────
router.post('/manual-hold', async (req, res) => {
  const { item_id, warehouse_id, quantity, reference, reason } = req.body;

  if (!item_id)   return res.status(400).json({ error: 'item_id is required' });
  if (!quantity)  return res.status(400).json({ error: 'quantity is required' });

  const result = await reservationService.createReservation(supabase, {
    companyId:   req.companyId,
    itemId:      parseInt(item_id),
    warehouseId: warehouse_id ? parseInt(warehouse_id) : null,
    sourceType:  'manual_hold',
    sourceId:    req.companyId,   // company_id as sourceId for manual holds
    quantity:    parseFloat(quantity),
    reference:   reference || null,
    reason:      reason || null,
    createdBy:   req.user.userId
  });

  if (!result.success) {
    return res.status(result.available !== undefined ? 422 : 500).json({
      error:     result.error,
      available: result.available,
      requested: result.requested
    });
  }
  res.status(201).json(result);
});

// ─── Release a reservation ────────────────────────────────────────────────────
router.post('/:id/release', async (req, res) => {
  const { quantity } = req.body;
  const result = await reservationService.releaseReservation(
    supabase,
    parseInt(req.params.id),
    req.companyId,
    quantity ? parseFloat(quantity) : null,
    req.user.userId
  );
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

module.exports = router;
