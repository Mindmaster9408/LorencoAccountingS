'use strict';

/**
 * Warehouse Transfers Routes — Codebox 08
 *
 * POST   /transfers              — create draft transfer
 * GET    /transfers              — list transfers (filterable)
 * GET    /transfers/:id          — get transfer with lines
 * PUT    /transfers/:id/approve  — approve
 * PUT    /transfers/:id/ship     — ship (in_transit) — creates OUT movements
 * PUT    /transfers/:id/receive  — receive — creates IN movements
 * PUT    /transfers/:id/cancel   — cancel (draft or approved only)
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const warehouseTransferService = require('../services/warehouseTransferService');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

// POST /transfers
router.post('/', requirePerm(PERM.TRANSFER_CREATE), async (req, res) => {
  const {
    from_warehouse_id, to_warehouse_id,
    from_location_id, to_location_id,
    notes, lines
  } = req.body;

  const result = await warehouseTransferService.createTransfer(supabase, req.companyId, {
    from_warehouse_id,
    to_warehouse_id,
    from_location_id,
    to_location_id,
    notes,
    requested_by: req.user.userId,
    lines: lines || []
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }

  await auditFromReq(req, 'CREATE', 'warehouse_transfer', result.transfer.id, {
    transfer_number: result.transfer.transfer_number,
    from_warehouse_id,
    to_warehouse_id
  });

  res.status(201).json({ transfer: result.transfer });
});

// GET /transfers
router.get('/', requirePerm(PERM.VIEW), async (req, res) => {
  const result = await warehouseTransferService.listTransfers(supabase, req.companyId, {
    status:            req.query.status,
    from_warehouse_id: req.query.from_warehouse_id,
    to_warehouse_id:   req.query.to_warehouse_id,
    limit:             req.query.limit
  });
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json({ transfers: result.transfers });
});

// GET /transfers/:id
router.get('/:id', requirePerm(PERM.VIEW), async (req, res) => {
  const result = await warehouseTransferService.getTransferById(
    supabase, req.companyId, parseInt(req.params.id)
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json({ transfer: result.transfer });
});

// PUT /transfers/:id/approve
router.put('/:id/approve', requirePerm(PERM.TRANSFER), async (req, res) => {
  const result = await warehouseTransferService.approveTransfer(
    supabase, req.companyId, parseInt(req.params.id), req.user.userId
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'UPDATE', 'warehouse_transfer', parseInt(req.params.id), { action: 'approved' });
  res.json({ success: true });
});

// PUT /transfers/:id/ship
router.put('/:id/ship', requirePerm(PERM.TRANSFER), async (req, res) => {
  const { lines } = req.body;
  const result = await warehouseTransferService.shipTransfer(
    supabase, req.companyId, parseInt(req.params.id), req.user.userId, lines
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error, errors: result.errors });
  await auditFromReq(req, 'UPDATE', 'warehouse_transfer', parseInt(req.params.id), { action: 'shipped', shipped: result.shipped });
  res.json({ success: true, shipped: result.shipped, errors: result.errors });
});

// PUT /transfers/:id/receive
router.put('/:id/receive', requirePerm(PERM.TRANSFER), async (req, res) => {
  const { lines } = req.body;
  const result = await warehouseTransferService.receiveTransfer(
    supabase, req.companyId, parseInt(req.params.id), req.user.userId, lines
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error, errors: result.errors });
  await auditFromReq(req, 'UPDATE', 'warehouse_transfer', parseInt(req.params.id), { action: 'received', received: result.received });
  res.json({ success: true, received: result.received, errors: result.errors });
});

// PUT /transfers/:id/cancel
router.put('/:id/cancel', requirePerm(PERM.TRANSFER), async (req, res) => {
  const result = await warehouseTransferService.cancelTransfer(
    supabase, req.companyId, parseInt(req.params.id)
  );
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  await auditFromReq(req, 'UPDATE', 'warehouse_transfer', parseInt(req.params.id), { action: 'cancelled' });
  res.json({ success: true });
});

module.exports = router;
