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
 *   GET  /qc-pending               — batches awaiting QC inspection (Stockton Proof)
 *   POST /batches/:id/qc-inspect   — record a QC inspection result (Stockton Proof)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const productionService = require('../services/productionService');
const { requirePerm, PERM } = require('../permissions');
const { getLabourRate, getMachineRate, costForMinutes } = require('../services/rateService');

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


// ─── QC Pending List ──────────────────────────────────────────────────────────
router.get('/qc-pending', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const { data, error } = await supabase
    .from('production_batches')
    .select(`
      id, batch_number, produced_qty, completed_at, executed_by,
      work_orders:work_order_id (wo_number, inventory_items:item_id (name, sku, unit))
    `)
    .eq('company_id', req.companyId)
    .eq('qc_status', 'pending')
    .order('completed_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ batches: data || [], total: (data || []).length });
});

// ─── QC Inspection ────────────────────────────────────────────────────────────
// Quality control gate (Stockton Proof scoping, 2026-09-13, scope confirmed
// with Ruan): finished production only for v1, block-in-place rather than
// physical quarantine relocation, maker-checker enforced, lot/batch-level
// granularity. Body: { result, quantity_passed, quantity_rejected?,
// rejection_reason?, notes? }
router.post('/batches/:id/qc-inspect', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const batchId = parseInt(req.params.id);
  const { result, quantity_passed, quantity_rejected = 0, rejection_reason, notes } = req.body;

  const validResults = ['passed', 'failed', 'partial'];
  if (!validResults.includes(result)) {
    return res.status(400).json({ error: `result must be one of: ${validResults.join(', ')}` });
  }
  const qtyPassed   = parseFloat(quantity_passed);
  const qtyRejected = parseFloat(quantity_rejected) || 0;
  if (isNaN(qtyPassed) || qtyPassed < 0) return res.status(400).json({ error: 'quantity_passed must be >= 0' });
  if ((result === 'failed' || result === 'partial') && !rejection_reason) {
    return res.status(400).json({ error: 'rejection_reason is required when result is failed or partial' });
  }

  const { data: batch } = await supabase
    .from('production_batches')
    .select('id, executed_by, qc_status, linked_lot_id, produced_qty')
    .eq('id', batchId)
    .eq('company_id', req.companyId)
    .single();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.qc_status !== 'pending') {
    return res.status(400).json({ error: `This batch has already been inspected (status: ${batch.qc_status})` });
  }

  // Maker-checker (scope confirmed with Ruan, 2026-09-13): whoever ran the
  // batch may not also be the one who signs off its QC — same rule already
  // enforced for stock-count approval and BOM activation.
  if (batch.executed_by && batch.executed_by === req.user.userId) {
    return res.status(403).json({
      error: 'A different person must perform QC — the person who ran this batch cannot also inspect it.',
    });
  }

  const qtyInspected = qtyPassed + qtyRejected;

  const { error: qcErr } = await supabase.from('production_batch_qc_inspections').insert({
    company_id:         req.companyId,
    batch_id:           batchId,
    inspector_id:       req.user.userId,
    result,
    quantity_inspected: qtyInspected,
    quantity_passed:    qtyPassed,
    quantity_rejected:  qtyRejected,
    rejection_reason:   rejection_reason || null,
    notes:              notes || null,
  });
  if (qcErr) return res.status(500).json({ error: qcErr.message });

  const { data: updatedBatch, error: batchErr } = await supabase
    .from('production_batches')
    .update({ qc_status: result })
    .eq('id', batchId)
    .select()
    .single();
  if (batchErr) return res.status(500).json({ error: batchErr.message });

  // Reflect the outcome on the linked lot — passed quantity becomes
  // consumable (qc_status='passed'), rejected quantity is removed from
  // quantity_remaining so it can never be shipped/consumed via the lot.
  if (batch.linked_lot_id) {
    const lotQcStatus = result === 'passed' ? 'passed' : (result === 'partial' ? 'passed' : 'failed');
    const { data: lot } = await supabase.from('inventory_stock_lots').select('quantity_remaining').eq('id', batch.linked_lot_id).single();
    const remainingAfterRejection = lot ? Math.max(0, parseFloat(lot.quantity_remaining) - qtyRejected) : null;

    await supabase
      .from('inventory_stock_lots')
      .update({
        qc_status: lotQcStatus,
        ...(remainingAfterRejection != null ? { quantity_remaining: remainingAfterRejection } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', batch.linked_lot_id);
  }

  await auditFromReq(req, 'UPDATE', 'production_batch', batchId, {
    module: 'inventory',
    metadata: { action: 'qc_inspect', result, quantity_passed: qtyPassed, quantity_rejected: qtyRejected, inspector_id: req.user.userId, executed_by: batch.executed_by },
  });

  res.json({ batch: updatedBatch });
});

// ─── Add Labour Entry ─────────────────────────────────────────────────────────
router.post('/batches/:id/labour', requirePerm(PERM.PRODUCTION_MANAGE), async (req, res) => {
  const batchId = parseInt(req.params.id);
  const { duration_minutes, notes, role } = req.body;

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

  // Stockton Proof scoping (2026-09-12): labour cost is now actually
  // computed from inventory_labour_rates instead of hardcoded to 0. A
  // company with no rates configured still gets 0 — unchanged from before.
  const roleValue = role || 'general';
  const hourlyRate = await getLabourRate(supabase, req.companyId, roleValue);
  const labourCost = costForMinutes(hourlyRate, parseInt(duration_minutes));

  const { data, error } = await supabase
    .from('production_labour_entries')
    .insert({
      company_id:       req.companyId,
      batch_id:         batchId,
      work_order_id:    batch.work_order_id,
      duration_minutes: parseInt(duration_minutes),
      role:             roleValue,
      labour_cost:      labourCost,
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

  // Stockton Proof scoping (2026-09-12): same fix as the labour entry above
  // — actual cost from inventory_machine_rates instead of hardcoded 0.
  const hourlyRate = await getMachineRate(supabase, req.companyId, machine_id || null);
  const machineCost = costForMinutes(hourlyRate, parseInt(duration_minutes));

  const { data, error } = await supabase
    .from('production_machine_entries')
    .insert({
      company_id:       req.companyId,
      batch_id:         batchId,
      work_order_id:    batch.work_order_id,
      machine_id:       machine_id || null,
      duration_minutes: parseInt(duration_minutes),
      machine_cost:     machineCost,
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
