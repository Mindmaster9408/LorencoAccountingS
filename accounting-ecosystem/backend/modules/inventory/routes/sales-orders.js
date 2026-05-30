'use strict';

/**
 * Sales Orders Routes — Codebox 09
 *
 * POST   /sales-orders                          — create draft SO
 * GET    /sales-orders                          — list SOs
 * GET    /sales-orders/:id                      — get SO with lines + history
 * PUT    /sales-orders/:id/confirm              — draft → confirmed
 * PUT    /sales-orders/:id/allocate             — reserve stock for all lines
 * PUT    /sales-orders/:id/lines/:lineId/fulfill — fulfill a line (ship)
 * PUT    /sales-orders/:id/cancel               — cancel SO and release reservations
 * GET    /atp/:itemId                           — ATP for one item
 * GET    /atp/:itemId/projected                 — projected availability
 * GET    /demand-dashboard                      — demand summary
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const salesOrderService = require('../services/salesOrderService');
const atpService        = require('../services/atpService');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

// ─── Sales Order CRUD ─────────────────────────────────────────────────────────

router.post('/', requirePerm(PERM.SO_MANAGE), async (req, res) => {
  const {
    customer_name, customer_email, customer_phone, customer_ref,
    required_date, delivery_address, currency_code, notes, lines
  } = req.body;

  const result = await salesOrderService.createSalesOrder(supabase, req.companyId, {
    customer_name, customer_email, customer_phone, customer_ref,
    required_date, delivery_address, currency_code, notes,
    created_by: req.user.userId,
    lines: lines || []
  });

  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'CREATE', 'sales_order', result.sales_order.id, { so_number: result.sales_order.so_number });
  res.status(201).json({ sales_order: result.sales_order });
});

router.get('/', requirePerm(PERM.VIEW), async (req, res) => {
  const result = await salesOrderService.listSalesOrders(supabase, req.companyId, {
    status:    req.query.status,
    customer:  req.query.customer,
    from_date: req.query.from_date,
    to_date:   req.query.to_date,
    limit:     req.query.limit
  });
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json({ sales_orders: result.sales_orders });
});

router.get('/:id', requirePerm(PERM.VIEW), async (req, res) => {
  const result = await salesOrderService.getSalesOrder(supabase, req.companyId, parseInt(req.params.id));
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json({ sales_order: result.sales_order });
});

router.put('/:id/confirm', requirePerm(PERM.SO_MANAGE), async (req, res) => {
  const result = await salesOrderService.confirmSalesOrder(supabase, req.companyId, parseInt(req.params.id), req.user.userId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'UPDATE', 'sales_order', parseInt(req.params.id), { action: 'confirmed' });
  res.json({ success: true });
});

router.put('/:id/allocate', requirePerm(PERM.SO_MANAGE), async (req, res) => {
  const result = await salesOrderService.allocateSalesOrder(supabase, req.companyId, parseInt(req.params.id), req.user.userId);
  if (!result.success && !result.allocated?.length) {
    return res.status(result.status || 500).json({ error: result.error, errors: result.errors });
  }
  await auditFromReq(req, 'UPDATE', 'sales_order', parseInt(req.params.id), {
    action: 'allocated', so_status: result.so_status, lines_allocated: result.allocated?.length
  });
  res.json({ success: result.success, so_status: result.so_status, allocated: result.allocated, errors: result.errors });
});

router.put('/:id/lines/:lineId/fulfill', requirePerm(PERM.SO_MANAGE), async (req, res) => {
  const { quantity } = req.body;
  const result = await salesOrderService.fulfillSalesOrderLine(
    supabase, req.companyId, parseInt(req.params.id), parseInt(req.params.lineId),
    quantity, req.user.userId
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'UPDATE', 'sales_order', parseInt(req.params.id), {
    action: 'line_fulfilled', line_id: parseInt(req.params.lineId), qty: result.fulfilled_qty
  });
  res.json({ success: true, fulfilled_qty: result.fulfilled_qty, so_status: result.so_status });
});

router.put('/:id/cancel', requirePerm(PERM.SO_MANAGE), async (req, res) => {
  const result = await salesOrderService.cancelSalesOrder(supabase, req.companyId, parseInt(req.params.id), req.user.userId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'UPDATE', 'sales_order', parseInt(req.params.id), { action: 'cancelled' });
  res.json({ success: true, released_reservations: result.released_reservations });
});

// ─── ATP Endpoints ────────────────────────────────────────────────────────────

router.get('/atp/:itemId', async (req, res) => {
  const result = await atpService.calculateAvailableToPromise(
    supabase, req.companyId, parseInt(req.params.itemId)
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/atp/:itemId/projected', async (req, res) => {
  const result = await atpService.calculateProjectedAvailability(
    supabase, req.companyId, parseInt(req.params.itemId), parseInt(req.query.days) || 30
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/demand-dashboard', async (req, res) => {
  const result = await atpService.getDemandDashboard(supabase, req.companyId);
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json(result);
});

module.exports = router;
