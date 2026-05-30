'use strict';

/**
 * Warehouse Locations Routes — Codebox 08
 *
 * GET  /warehouses/:id/locations         — list locations in a warehouse
 * POST /warehouses/:id/locations         — create a location
 * PUT  /warehouses/:id/locations/:locId  — update a location
 * GET  /warehouses/:id/stock             — per-location stock in a warehouse
 * GET  /warehouses/:id/availability      — available stock per warehouse (all warehouses)
 *
 * All routes are company-scoped via req.companyId.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const warehouseTransferService = require('../services/warehouseTransferService');
const { requirePerm, PERM } = require('../permissions'); // H01-003 fix

const router = express.Router({ mergeParams: true });

// GET /warehouses/:id/locations
router.get('/:warehouseId/locations', requirePerm(PERM.VIEW), async (req, res) => {
  const warehouseId = parseInt(req.params.warehouseId);

  // Verify warehouse belongs to company
  const { data: wh } = await supabase
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('company_id', req.companyId)
    .single();

  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

  const { data, error } = await supabase
    .from('warehouse_locations')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('warehouse_id', warehouseId)
    .order('location_code');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ locations: data || [] });
});

// POST /warehouses/:id/locations
router.post('/:warehouseId/locations', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const warehouseId = parseInt(req.params.warehouseId);
  const {
    location_code, location_name, location_type,
    max_capacity, capacity_unit, notes
  } = req.body;

  if (!location_code || !location_name) {
    return res.status(400).json({ error: 'location_code and location_name are required' });
  }

  const validTypes = ['shelf','bin','bulk','staging','quarantine','production','dispatch','other'];
  if (location_type && !validTypes.includes(location_type)) {
    return res.status(400).json({ error: `location_type must be one of: ${validTypes.join(', ')}` });
  }

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('company_id', req.companyId)
    .single();
  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('warehouse_locations')
    .insert({
      company_id:    req.companyId,
      warehouse_id:  warehouseId,
      location_code: location_code.toUpperCase().trim(),
      location_name: location_name.trim(),
      location_type: location_type || 'bin',
      max_capacity:  max_capacity ? parseFloat(max_capacity) : null,
      capacity_unit: capacity_unit || null,
      notes:         notes || null,
      is_active:     true,
      created_at:    now,
      updated_at:    now
    })
    .select()
    .single();

  if (error) {
    if (error.message?.includes('unique') || error.code === '23505') {
      return res.status(409).json({ error: 'Location code already exists in this warehouse' });
    }
    return res.status(500).json({ error: error.message });
  }

  await auditFromReq(req, 'CREATE', 'warehouse_location', data.id, {
    warehouse_id: warehouseId, location_code: data.location_code
  });

  res.status(201).json({ location: data });
});

// PUT /warehouses/:id/locations/:locId
router.put('/:warehouseId/locations/:locId', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const warehouseId = parseInt(req.params.warehouseId);
  const locationId  = parseInt(req.params.locId);
  const { location_name, location_type, max_capacity, capacity_unit, notes, is_active } = req.body;

  const { data: existing } = await supabase
    .from('warehouse_locations')
    .select('id')
    .eq('id', locationId)
    .eq('warehouse_id', warehouseId)
    .eq('company_id', req.companyId)
    .single();

  if (!existing) return res.status(404).json({ error: 'Location not found' });

  const updates = { updated_at: new Date().toISOString() };
  if (location_name  !== undefined) updates.location_name  = location_name;
  if (location_type  !== undefined) updates.location_type  = location_type;
  if (max_capacity   !== undefined) updates.max_capacity   = max_capacity ? parseFloat(max_capacity) : null;
  if (capacity_unit  !== undefined) updates.capacity_unit  = capacity_unit;
  if (notes          !== undefined) updates.notes          = notes;
  if (is_active      !== undefined) updates.is_active      = is_active;

  const { data, error } = await supabase
    .from('warehouse_locations')
    .update(updates)
    .eq('id', locationId)
    .eq('company_id', req.companyId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ location: data });
});

// GET /warehouses/:id/stock
router.get('/:warehouseId/stock', requirePerm(PERM.VIEW), async (req, res) => {
  const warehouseId = parseInt(req.params.warehouseId);

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('company_id', req.companyId)
    .single();

  if (!wh) return res.status(404).json({ error: 'Warehouse not found' });

  const result = await warehouseTransferService.getWarehouseStock(supabase, req.companyId, warehouseId);
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json({ stock: result.stock });
});

// GET /warehouses/availability  (no :id — returns all warehouses)
router.get('/availability', requirePerm(PERM.VIEW), async (req, res) => {
  const result = await warehouseTransferService.getWarehouseAvailability(supabase, req.companyId);
  if (!result.success) return res.status(500).json({ error: result.error });
  res.json({ warehouses: result.warehouses });
});

module.exports = router;
