'use strict';

/**
 * ============================================================================
 * Labour / Machine Rates — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/rates
 * Lets a company configure the hourly rates production-batches.js needs to
 * turn tracked labour/machine time into an actual cost, instead of the
 * previous hardcoded 0.
 * ============================================================================
 */

const express = require('express');
const { auditFromReq } = require('../../../middleware/audit');
const { requirePerm, PERM } = require('../permissions');
const { DEFAULT_MACHINE_KEY } = require('../services/rateService');

const router = express.Router();

router.get('/labour', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const supabase = req.supabase;
  const { data, error } = await supabase
    .from('inventory_labour_rates')
    .select('*')
    .eq('company_id', req.companyId)
    .order('role');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rates: data || [] });
});

router.put('/labour/:role', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const supabase = req.supabase;
  const role = req.params.role;
  const { hourly_rate, is_default } = req.body;
  const rate = parseFloat(hourly_rate);
  if (isNaN(rate) || rate < 0) return res.status(400).json({ error: 'hourly_rate must be a positive number' });

  const { data, error } = await supabase
    .from('inventory_labour_rates')
    .upsert({
      company_id: req.companyId,
      role,
      hourly_rate: rate,
      is_default: !!is_default,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,role' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'inventory_labour_rate', data.id, { module: 'inventory', metadata: { role, hourly_rate: rate } });
  res.json({ rate: data });
});

router.get('/machine', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const supabase = req.supabase;
  const { data, error } = await supabase
    .from('inventory_machine_rates')
    .select('*')
    .eq('company_id', req.companyId)
    .order('machine_id');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rates: data || [] });
});

router.put('/machine/:machineId', requirePerm(PERM.CONFIGURE), async (req, res) => {
  const supabase = req.supabase;
  const machineId = req.params.machineId === 'default' ? DEFAULT_MACHINE_KEY : req.params.machineId;
  const { hourly_rate } = req.body;
  const rate = parseFloat(hourly_rate);
  if (isNaN(rate) || rate < 0) return res.status(400).json({ error: 'hourly_rate must be a positive number' });

  const { data, error } = await supabase
    .from('inventory_machine_rates')
    .upsert({
      company_id: req.companyId,
      machine_id: machineId,
      hourly_rate: rate,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,machine_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'inventory_machine_rate', data.id, { module: 'inventory', metadata: { machine_id: machineId, hourly_rate: rate } });
  res.json({ rate: data });
});

module.exports = router;
