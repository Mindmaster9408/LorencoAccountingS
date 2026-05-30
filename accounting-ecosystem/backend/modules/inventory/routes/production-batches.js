/**
 * ============================================================================
 * Production Batches Routes — Codebox 06 Manufacturing Execution
 * ============================================================================
 * Mounted at: /api/inventory/production
 *
 * Endpoints:
 *   GET  /batches                  — list batches (filter: work_order_id, limit)
 *   GET  /batches/:id              — single batch with wastage + variances
 *   GET  /summary                  — production dashboard stats
 *   GET  /yield-report             — yield by WO/batch
 *   GET  /wastage-report           — wastage by reason and item
 *   GET  /variance-report          — material variance detail
 *   POST /batches/:id/labour       — add labour entry to batch
 *   POST /batches/:id/machine      — add machine entry to batch
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const productionService = require('../services/productionService');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();


// ─── Production Dashboard Summary ────────────────────────────────────────────
router.get('/summary', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  try {
    const summary = await productionService.getProductionSummary(supabase, req.companyId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});


// ─── List Batches ─────────────────────────────────────────────────────────────
router.get('/batches', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const { work_order_id, limit = 100 } = req.query;

  let q = supabase
    .from('production_batches')
    .select(`
      *,
      work_orders:work_order_id (
        wo_number, status,
        inventory_items:item_id (name, sku, unit)
      )
    `)
    .eq('company_id', req.companyId)
    .order('completed_at', { ascending: false })
    .limit(parseInt(limit));

  if (work_order_id) q = q.eq('work_order_id', parseInt(work_order_id));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ batches: data || [] });
});


// ─── Get Single Batch ─────────────────────────────────────────────────────────
router.get('/batches/:id', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const batchId = parseInt(req.params.id);

  const { data: batch, error: bErr } = await supabase
    .from('production_batches')
    .select(`
      *,
      work_orders:work_order_id (
        wo_number, status, quantity_to_produce,
        inventory_items:item_id (name, sku, unit)
      )
    `)
    .eq('id', batchId)
    .eq('company_id', req.companyId)
    .single();

  if (bErr || !batch) return res.status(404).json({ error: 'Batch not found' });

  const [wastageRes, varianceRes, labourRes, machineRes] = await Promise.all([
    supabase
      .from('production_wastage')
      .select('*, inventory_items:item_id (name, sku)')
      .eq('batch_id', batchId)
      .eq('company_id', req.companyId)
      .order('created_at'),

    supabase
      .from('production_variances')
      .select('*, inventory_items:item_id (name, sku)')
      .eq('batch_id', batchId)
      .eq('company_id', req.companyId)
      .order('variance_direction', { ascending: false }),

    supabase
      .from('production_labour_entries')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', req.companyId),

    supabase
      .from('production_machine_entries')
      .select('*')
      .eq('batch_id', batchId)
      .eq('company_id', req.companyId)
  ]);

  res.json({
    batch: {
      ...batch,
      wastage:   wastageRes.data  || [],
      variances: varianceRes.data || [],
      labour:    labourRes.data   || [],
      machines:  machineRes.data  || []
    }
  });
});


// ─── Yield Report ─────────────────────────────────────────────────────────────
router.get('/yield-report', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const { from, to, limit = 200 } = req.query;

  let q = supabase
    .from('production_batches')
    .select(`
      id, batch_number, produced_qty, expected_qty, wastage_qty,
      yield_percent, completed_at, unit_cost,
      work_orders:work_order_id (
        wo_number,
        inventory_items:item_id (name, sku)
      )
    `)
    .eq('company_id', req.companyId)
    .order('completed_at', { ascending: false })
    .limit(parseInt(limit));

  if (from) q = q.gte('completed_at', from);
  if (to)   q = q.lte('completed_at', to + 'T23:59:59.999Z');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Compute aggregate stats
  const rows = data || [];
  const totalProduced  = rows.reduce((s, r) => s + (parseFloat(r.produced_qty) || 0), 0);
  const totalExpected  = rows.reduce((s, r) => s + (parseFloat(r.expected_qty) || 0), 0);
  const totalWastage   = rows.reduce((s, r) => s + (parseFloat(r.wastage_qty)  || 0), 0);
  const avgYield       = rows.length > 0
    ? rows.reduce((s, r) => s + (parseFloat(r.yield_percent) || 0), 0) / rows.length
    : null;

  const underYield = rows.filter(r => (parseFloat(r.yield_percent) || 0) < 98);
  const overYield  = rows.filter(r => (parseFloat(r.yield_percent) || 0) > 102);

  res.json({
    batches:         rows,
    total_produced:  parseFloat(totalProduced.toFixed(4)),
    total_expected:  parseFloat(totalExpected.toFixed(4)),
    total_wastage:   parseFloat(totalWastage.toFixed(4)),
    average_yield:   avgYield !== null ? parseFloat(avgYield.toFixed(2)) : null,
    under_yield_count: underYield.length,
    over_yield_count:  overYield.length
  });
});


// ─── Wastage Report ───────────────────────────────────────────────────────────
router.get('/wastage-report', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const { from, to, limit = 200 } = req.query;

  let q = supabase
    .from('production_wastage')
    .select(`
      *,
      inventory_items:item_id (name, sku),
      production_batches:batch_id (
        batch_number,
        work_orders:work_order_id (wo_number)
      )
    `)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (from) q = q.gte('created_at', from);
  if (to)   q = q.lte('created_at', to + 'T23:59:59.999Z');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const totalWastageQty   = rows.reduce((s, r) => s + (parseFloat(r.wastage_qty)   || 0), 0);
  const totalWastageValue = rows.reduce((s, r) => s + (parseFloat(r.estimated_value) || 0), 0);

  // Group by reason
  const byReason = {};
  for (const r of rows) {
    const reason = r.wastage_reason || 'unknown';
    if (!byReason[reason]) byReason[reason] = { count: 0, total_qty: 0, total_value: 0 };
    byReason[reason].count++;
    byReason[reason].total_qty   += parseFloat(r.wastage_qty)   || 0;
    byReason[reason].total_value += parseFloat(r.estimated_value) || 0;
  }

  res.json({
    wastage_records:  rows,
    total_qty:        parseFloat(totalWastageQty.toFixed(4)),
    total_value:      parseFloat(totalWastageValue.toFixed(4)),
    by_reason:        byReason
  });
});


// ─── Variance Report ──────────────────────────────────────────────────────────
router.get('/variance-report', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const { from, to, direction, limit = 200 } = req.query;

  let q = supabase
    .from('production_variances')
    .select(`
      *,
      inventory_items:item_id (name, sku, unit),
      production_batches:batch_id (
        batch_number,
        work_orders:work_order_id (wo_number)
      )
    `)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (from)      q = q.gte('created_at', from);
  if (to)        q = q.lte('created_at', to + 'T23:59:59.999Z');
  if (direction) q = q.eq('variance_direction', direction);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const totalVarianceValue = rows.reduce((s, r) => s + (parseFloat(r.variance_value) || 0), 0);
  const overCount  = rows.filter(r => r.variance_direction === 'over').length;
  const underCount = rows.filter(r => r.variance_direction === 'under').length;

  res.json({
    variances:            rows,
    total_variance_value: parseFloat(totalVarianceValue.toFixed(4)),
    over_count:           overCount,
    under_count:          underCount
  });
});


// ─── Add Labour Entry ─────────────────────────────────────────────────────────
router.post('/batches/:id/labour', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const batchId = parseInt(req.params.id);
  const { duration_minutes, notes } = req.body;

  if (!duration_minutes || parseInt(duration_minutes) < 0) {
    return res.status(400).json({ error: 'duration_minutes is required and must be >= 0' });
  }

  // Verify batch belongs to company
  const { data: batch } = await supabase
    .from('production_batches')
    .select('id, work_order_id')
    .eq('id', batchId)
    .eq('company_id', req.companyId)
    .single();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const { data, error } = await supabase
    .from('production_labour_entries')
    .insert({
      company_id:       req.companyId,
      batch_id:         batchId,
      work_order_id:    batch.work_order_id,
      duration_minutes: parseInt(duration_minutes),
      labour_cost:      0,
      notes:            notes || null,
      created_by:       req.user.userId,
      created_at:       new Date().toISOString()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'production_labour_entry', data.id, {
    module: 'inventory', metadata: { batch_id: batchId }
  });
  res.status(201).json({ labour_entry: data });
});


// ─── Add Machine Entry ────────────────────────────────────────────────────────
router.post('/batches/:id/machine', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const batchId = parseInt(req.params.id);
  const { duration_minutes, machine_id, notes } = req.body;

  if (!duration_minutes || parseInt(duration_minutes) < 0) {
    return res.status(400).json({ error: 'duration_minutes is required and must be >= 0' });
  }

  const { data: batch } = await supabase
    .from('production_batches')
    .select('id, work_order_id')
    .eq('id', batchId)
    .eq('company_id', req.companyId)
    .single();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const { data, error } = await supabase
    .from('production_machine_entries')
    .insert({
      company_id:       req.companyId,
      batch_id:         batchId,
      work_order_id:    batch.work_order_id,
      machine_id:       machine_id || null,
      duration_minutes: parseInt(duration_minutes),
      machine_cost:     0,
      notes:            notes || null,
      created_by:       req.user.userId,
      created_at:       new Date().toISOString()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'production_machine_entry', data.id, {
    module: 'inventory', metadata: { batch_id: batchId }
  });
  res.status(201).json({ machine_entry: data });
});


module.exports = router;
