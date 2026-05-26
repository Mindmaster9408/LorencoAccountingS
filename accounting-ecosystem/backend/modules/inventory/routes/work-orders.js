/**
 * ============================================================================
 * Work Order Routes — updated Codebox 06 (Manufacturing Execution)
 * ============================================================================
 * Endpoints:
 *   GET    /work-orders                    — list WOs (filterable by status)
 *   GET    /work-orders/:id                — single WO with materials
 *   POST   /work-orders                    — create WO
 *   PUT    /work-orders/:id                — update WO header
 *   POST   /work-orders/:id/release        — draft → released
 *   POST   /work-orders/:id/start         — released → in_progress
 *   POST   /work-orders/:id/pause         — in_progress → paused (NEW)
 *   POST   /work-orders/:id/resume        — paused → in_progress (NEW)
 *   POST   /work-orders/:id/complete      — in_progress|paused → completed (extended)
 *   POST   /work-orders/:id/close         — completed → closed (NEW)
 *   POST   /work-orders/:id/cancel        — draft|released|in_progress|paused → cancelled
 *   POST   /work-orders/:id/issue-materials — issue materials to in_progress WO
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const costingService = require('../services/costingService');
const { getIssueCostFromItemData } = costingService;
const { adjustStockTx } = require('../services/stockMutationService');
const reservationService = require('../services/reservationService');
const productionService = require('../services/productionService');

const router = express.Router();

// ─── Allowed status transitions ───────────────────────────────────────────────
const TRANSITIONS = {
  draft:       ['released', 'cancelled'],
  released:    ['in_progress', 'cancelled'],
  in_progress: ['paused', 'completed', 'cancelled'],
  paused:      ['in_progress', 'cancelled'],
  completed:   ['closed'],
  closed:      [],
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

// ─── Release (with material reservations) ────────────────────────────────────
// Creates a stock_reservation for every work_order_materials line.
// BLOCKS release if any material has insufficient available stock.
// Design decision: block-on-shortage — the pilot requires hard availability gates.
router.post('/:id/release', async (req, res) => {
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status, wo_number')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, 'released')) {
    return res.status(400).json({ error: `Cannot transition from '${wo.status}' to 'released'` });
  }

  // Fetch material requirements for this WO
  const { data: materials, error: matErr } = await supabase
    .from('work_order_materials')
    .select('id, item_id, required_qty, inventory_items:item_id(name, sku)')
    .eq('work_order_id', wo.id);
  if (matErr) return res.status(500).json({ error: matErr.message });

  // Attempt reservations for each material — collect shortages
  const reservationsMade = [];
  const shortages = [];

  if (materials && materials.length > 0) {
    for (const mat of materials) {
      const result = await reservationService.createReservation(supabase, {
        companyId:    req.companyId,
        itemId:       mat.item_id,
        warehouseId:  null,
        sourceType:   'work_order',
        sourceId:     wo.id,
        sourceLineId: mat.id,
        quantity:     parseFloat(mat.required_qty),
        reference:    wo.wo_number,
        reason:       `Material for work order ${wo.wo_number}`,
        createdBy:    req.user.userId
      });

      if (!result.success) {
        shortages.push({
          material_id:  mat.id,
          item_id:      mat.item_id,
          item_name:    mat.inventory_items?.name || 'Unknown',
          sku:          mat.inventory_items?.sku  || null,
          required_qty: mat.required_qty,
          available:    result.available   ?? 0,
          reserved:     result.reserved    ?? 0,
          shortage_qty: parseFloat(mat.required_qty) - (result.available ?? 0)
        });
      } else {
        reservationsMade.push(result.reservation_id);
      }
    }

    // If any shortage: compensate — release already-created reservations and block
    if (shortages.length > 0) {
      for (const resId of reservationsMade) {
        await reservationService.releaseReservation(supabase, resId, req.companyId, null, req.user.userId);
      }
      return res.status(422).json({
        error:     'Cannot release work order. Insufficient available stock for some materials.',
        shortages
      });
    }
  }

  // All reservations succeeded — transition WO to released
  const { data, error } = await supabase
    .from('work_orders')
    .update({ status: 'released', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { from_status: wo.status, to_status: 'released', reservations_created: reservationsMade.length }
  });
  res.json({ work_order: data, reservations_created: reservationsMade.length });
});

// ─── Start ────────────────────────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  const result = await transitionStatus(req, res, 'in_progress', {
    actual_start_date: new Date().toISOString().split('T')[0]
  });
  if (result) res.json({ work_order: result });
});

// ─── Complete (receive finished goods into stock + forensic batch recording) ──
// Extended in Codebox 06:
//   - Accepts wastage_qty, wastage_reason, wastage_notes, operator_notes
//   - Creates production_batches record (immutable)
//   - Creates production_wastage record if wastage_qty > 0 (immutable)
//   - Creates production_variances records for each material (immutable)
//   - Updates WO: actual_yield_percent, total_wastage_qty, batch_count
router.post('/:id/complete', async (req, res) => {
  const {
    quantity_produced,
    wastage_qty      = 0,
    wastage_reason   = 'unknown',
    wastage_notes    = null,
    operator_notes   = null
  } = req.body;

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status, item_id, wo_number, quantity_to_produce, quantity_produced, total_wastage_qty, batch_count')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, 'completed')) {
    return res.status(400).json({ error: `Cannot complete a WO in '${wo.status}' status` });
  }

  // PRE-COMPLETION SAFETY CHECK: all materials must be fully issued
  // A WO with no materials (no BOM) is allowed to complete without this check.
  const { data: materials, error: matErr } = await supabase
    .from('work_order_materials')
    .select('id, item_id, required_qty, issued_qty, inventory_items:item_id(name, average_cost, cost_price)')
    .eq('work_order_id', wo.id);
  if (matErr) return res.status(500).json({ error: matErr.message });

  if (materials && materials.length > 0) {
    const missingMaterials = materials.filter(
      m => parseFloat(m.issued_qty || 0) < parseFloat(m.required_qty || 0)
    );
    if (missingMaterials.length > 0) {
      return res.status(422).json({
        error: 'Cannot complete work order. Required materials have not been fully issued.',
        missing_materials: missingMaterials.map(m => ({
          material_id:  m.id,
          item_name:    m.inventory_items?.name || 'Unknown',
          required_qty: m.required_qty,
          issued_qty:   m.issued_qty,
          remaining:    parseFloat(m.required_qty) - parseFloat(m.issued_qty || 0)
        }))
      });
    }
  }

  const qtyProduced  = quantity_produced !== undefined
    ? parseFloat(quantity_produced)
    : wo.quantity_to_produce;
  if (qtyProduced <= 0) return res.status(400).json({ error: 'quantity_produced must be > 0' });

  const wastageQtyNum = Math.max(0, parseFloat(wastage_qty) || 0);

  // Finalize WO cost — computes unit_cost from accumulated material cost / qty_produced
  const { unitCost: woUnitCost, totalMaterialCost } = await costingService.finalizeWorkOrderCost(
    supabase, req.companyId, parseInt(req.params.id), qtyProduced
  );

  // Atomic stock-in for finished goods — cost basis from finalized WO cost
  const rpcResult = await adjustStockTx(supabase, {
    companyId:    req.companyId,
    itemId:       wo.item_id,
    delta:        qtyProduced,
    movementType: 'in',
    warehouseId:  null,
    reference:    `WO-${req.params.id}`,
    notes:        'Received from work order completion',
    unitCost:     woUnitCost || null,
    createdBy:    req.user.userId,
    sourceType:   'wo_complete',
    sourceId:     String(req.params.id)
  });

  if (!rpcResult.success) return res.status(500).json({ error: rpcResult.error || 'Stock update failed' });

  // ─── CODEBOX 06: Production Batch Recording ───────────────────────────────
  // Create immutable batch record (after stock-in confirmed)
  const yieldPct    = productionService.calculateYieldPercent(qtyProduced, wo.quantity_to_produce);
  const newBatchNum = (parseInt(wo.batch_count) || 0) + 1;

  const batchResult = await productionService.createProductionBatch(supabase, {
    companyId:         req.companyId,
    workOrderId:       wo.id,
    woNumber:          wo.wo_number,
    producedQty:       qtyProduced,
    expectedQty:       wo.quantity_to_produce,
    wastageQty:        wastageQtyNum,
    totalMaterialCost: totalMaterialCost || 0,
    unitCost:          woUnitCost || null,
    movementId:        rpcResult.movementId || null,
    executedBy:        req.user.userId,
    notes:             null,
    operatorNotes:     operator_notes || null
  });

  if (!batchResult.success) {
    // Non-fatal: stock already received, log but continue
    console.error('[WO complete] Failed to create production batch record:', batchResult.error);
  }

  const batchId = batchResult.batch?.id || null;

  // Wastage record (if any) — immutable
  if (wastageQtyNum > 0 && batchId) {
    const wastageResult = await productionService.insertWastageRecord(supabase, {
      companyId:      req.companyId,
      batchId,
      workOrderId:    wo.id,
      itemId:         null,           // finished-good output wastage — no specific input item
      wastageQty:     wastageQtyNum,
      wastageReason:  wastage_reason,
      estimatedValue: wastageQtyNum * (woUnitCost || 0),
      notes:          wastage_notes || null,
      createdBy:      req.user.userId
    });
    if (!wastageResult.success) {
      console.error('[WO complete] Failed to insert wastage record:', wastageResult.error);
    }
  }

  // Variance records — one per material line — immutable
  if (materials && materials.length > 0 && batchId) {
    const varianceRecords = productionService.buildVarianceRecords(
      materials, batchId, wo.id, req.companyId
    );
    const varResult = await productionService.insertVarianceRecords(supabase, varianceRecords);
    if (!varResult.success) {
      console.error('[WO complete] Failed to insert variance records:', varResult.error);
    }
  }
  // ─── END CODEBOX 06 ────────────────────────────────────────────────────────

  const { data, error } = await supabase
    .from('work_orders')
    .update({
      status:               'completed',
      quantity_produced:     qtyProduced,
      actual_end_date:       new Date().toISOString().split('T')[0],
      actual_yield_percent:  yieldPct !== null ? parseFloat(yieldPct.toFixed(4)) : null,
      total_wastage_qty:     (parseFloat(wo.total_wastage_qty) || 0) + wastageQtyNum,
      batch_count:           (parseInt(wo.batch_count) || 0) + 1,
      updated_at:            new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: {
      action:        'complete',
      qty_produced:  qtyProduced,
      wastage_qty:   wastageQtyNum,
      yield_percent: yieldPct,
      batch_id:      batchId
    }
  });
  res.json({ work_order: data, batch_id: batchId });
});

// ─── Pause (in_progress → paused) ────────────────────────────────────────────
// Preserves all active reservations. No stock change.
router.post('/:id/pause', async (req, res) => {
  const result = await transitionStatus(req, res, 'paused', {
    updated_at: new Date().toISOString()
  });
  if (result) res.json({ work_order: result });
});

// ─── Resume (paused → in_progress) ────────────────────────────────────────────
router.post('/:id/resume', async (req, res) => {
  const result = await transitionStatus(req, res, 'in_progress', {
    updated_at: new Date().toISOString()
  });
  if (result) res.json({ work_order: result });
});

// ─── Close (completed → closed) ──────────────────────────────────────────────
// Final archival state. No stock change.
router.post('/:id/close', async (req, res) => {
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, 'closed')) {
    return res.status(400).json({ error: `Cannot close a WO in '${wo.status}' status. Only completed WOs can be closed.` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('work_orders')
    .update({
      status:     'closed',
      closed_at:  now,
      closed_by:  req.user.userId,
      updated_at: now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { action: 'close', closed_by: req.user.userId }
  });
  res.json({ work_order: data });
});

// ─── Cancel (with reservation release) ──────────────────────────────────────
// Releases all active reservations created for this WO before cancelling.
router.post('/:id/cancel', async (req, res) => {
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!canTransition(wo.status, 'cancelled')) {
    return res.status(400).json({ error: `Cannot cancel a work order in '${wo.status}' status` });
  }

  // Release all active reservations held by this WO
  const { data: activeReservations } = await supabase
    .from('stock_reservations')
    .select('id')
    .eq('company_id', req.companyId)
    .eq('source_type', 'work_order')
    .eq('source_id', wo.id)
    .in('reservation_status', ['active', 'partially_released']);

  if (activeReservations && activeReservations.length > 0) {
    for (const r of activeReservations) {
      await reservationService.releaseReservation(supabase, r.id, req.companyId, null, req.user.userId);
    }
  }

  const { data, error } = await supabase
    .from('work_orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { from_status: wo.status, to_status: 'cancelled', reservations_released: (activeReservations || []).length }
  });
  res.json({ work_order: data, reservations_released: (activeReservations || []).length });
});

// ─── Issue Materials ──────────────────────────────────────────────────────────
// Records that materials have been physically taken from stock for this WO.
// All-or-nothing: ALL materials are pre-validated before ANY stock is changed.
// Returns 422 if any material has insufficient stock.
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

  // ─── PHASE 1: Pre-validate ALL issues before applying any changes (all-or-nothing)
  const resolvedIssues = [];
  for (const issue of issues) {
    const qty = parseFloat(issue.qty);
    if (!issue.material_id || isNaN(qty) || qty <= 0) {
      return res.status(422).json({ error: 'Each issue requires material_id and qty > 0' });
    }

    const { data: mat } = await supabase
      .from('work_order_materials')
      .select('id, item_id, required_qty, issued_qty')
      .eq('id', parseInt(issue.material_id))
      .eq('work_order_id', wo.id)
      .single();
    if (!mat) {
      return res.status(422).json({ error: `Material ${issue.material_id} not found on this work order` });
    }

    // Confirm available stock before committing; fetch all cost fields for costing dispatch
    const { data: itemRow } = await supabase
      .from('inventory_items')
      .select('current_stock, average_cost, last_purchase_cost, standard_cost, cost_price, costing_method, name')
      .eq('id', mat.item_id)
      .eq('company_id', req.companyId)
      .single();
    if (!itemRow) {
      return res.status(422).json({ error: `Inventory item for material ${issue.material_id} not found` });
    }
    if ((parseFloat(itemRow.current_stock) || 0) < qty) {
      return res.status(422).json({
        error:     `Insufficient stock for ${itemRow.name}`,
        available: itemRow.current_stock,
        requested: qty
      });
    }

    resolvedIssues.push({ mat, qty, itemRow });
  }

  // ─── PHASE 2: Apply all changes (all pre-validated; atomic RPC per item)
  for (const { mat, qty, itemRow } of resolvedIssues) {
    // Cost at time of issue — uses the item's costing_method (average, standard, last_cost, fifo)
    const { issueCost } = getIssueCostFromItemData(itemRow);

    const issueResult = await adjustStockTx(supabase, {
      companyId:    req.companyId,
      itemId:       mat.item_id,
      delta:        -qty,
      movementType: 'out',
      warehouseId:  null,
      reference:    `WO-${req.params.id}`,
      notes:        `Issued to work order ${req.params.id}`,
      unitCost:     issueCost,
      createdBy:    req.user.userId,
      sourceType:   'wo_issue',
      sourceId:     String(req.params.id)
    });

    if (!issueResult.success) {
      return res.status(422).json({
        error:     issueResult.error || 'Stock deduction failed',
        available: issueResult.available
      });
    }

    // Update issued_qty and freeze issue_unit_cost on the material line (Codebox 02)
    await supabase
      .from('work_order_materials')
      .update({
        issued_qty:      (parseFloat(mat.issued_qty) || 0) + qty,
        issue_unit_cost: issueCost  // captured at issue time; survives future cost changes
      })
      .eq('id', mat.id);

    // Accumulate material cost on the WO cost record
    if (issueCost) {
      await costingService.accumulateWorkOrderMaterialCost(
        supabase, req.companyId, parseInt(req.params.id), qty * issueCost
      );
    }

    // Consume the reservation for this material line (Codebox 04)
    // If no reservation exists (WO released before reservation system), skip gracefully.
    const { data: reservation } = await supabase
      .from('stock_reservations')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('source_type', 'work_order')
      .eq('source_id', parseInt(req.params.id))
      .eq('source_line_id', mat.id)
      .in('reservation_status', ['active', 'partially_released'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (reservation) {
      await reservationService.consumeReservation(supabase, reservation.id, req.companyId, qty, req.user.userId);
    }
  }

  await auditFromReq(req, 'UPDATE', 'work_order', wo.id, {
    module: 'inventory',
    metadata: { action: 'issue_materials', count: issues.length }
  });
  res.json({ success: true });
});

// ─── Work order cost summary ─────────────────────────────────────────────────
router.get('/:id/cost-summary', async (req, res) => {
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select('*, inventory_items:item_id(name, sku, unit, item_type), bom_headers:bom_id(name, version)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (woErr || !wo) return res.status(404).json({ error: 'Work order not found' });

  const { data: materials, error: matErr } = await supabase
    .from('work_order_materials')
    .select('*, inventory_items:item_id(name, sku, unit, current_stock, average_cost, last_purchase_cost, standard_cost, cost_price, costing_method)')
    .eq('work_order_id', wo.id)
    .order('id');

  if (matErr) return res.status(500).json({ error: matErr.message });

  // Fetch the authoritative accumulated cost totals from work_order_costs.
  // This is the source of truth for finalized WOs.
  const { data: wocRecord } = await supabase
    .from('work_order_costs')
    .select('material_cost, labor_cost, overhead_cost, unit_cost, completed_qty, status')
    .eq('work_order_id', wo.id)
    .eq('company_id', req.companyId)
    .single();

  const rows = (materials || []).map(material => {
    // Use issue_unit_cost (frozen at issue time) where available.
    // Falls back to current cost estimate (using costing_method dispatch) for
    // materials issued before Codebox 02 or not yet issued.
    const frozenCost = parseFloat(material.issue_unit_cost);
    const hasFrozenCost = Number.isFinite(frozenCost) && frozenCost >= 0;
    const { issueCost: currentCost } = getIssueCostFromItemData(material.inventory_items);
    const unitCost = hasFrozenCost ? frozenCost : currentCost;
    const issuedQty = parseFloat(material.issued_qty) || 0;
    const requiredQty = parseFloat(material.required_qty) || 0;
    const issuedCost = unitCost == null ? null : issuedQty * unitCost;
    return {
      id: material.id,
      item_id: material.item_id,
      item_name: material.inventory_items?.name || 'Unknown',
      sku: material.inventory_items?.sku || null,
      unit: material.inventory_items?.unit || null,
      current_stock: parseFloat(material.inventory_items?.current_stock) || 0,
      required_qty: requiredQty,
      issued_qty: issuedQty,
      issue_unit_cost: hasFrozenCost ? frozenCost : null,
      current_unit_cost: currentCost,
      unit_cost: unitCost,
      issued_cost: issuedCost,
      cost_basis: hasFrozenCost ? 'frozen_at_issue' : 'current_estimate',
      cost_missing: unitCost == null || issuedCost == null,
      remaining_qty: Math.max(0, requiredQty - issuedQty)
    };
  });

  // For the cost totals, prefer the accumulated work_order_costs record.
  // This is authoritative for finalized WOs (frozen at completion time).
  // For open WOs, fall back to summing the per-row issued_cost estimates.
  const accumulatedMaterialCost = parseFloat(wocRecord?.material_cost) || null;
  const estimatedMaterialCost   = rows.reduce((sum, row) => sum + (parseFloat(row.issued_cost) || 0), 0);
  const materialCost = accumulatedMaterialCost !== null ? accumulatedMaterialCost : estimatedMaterialCost;
  const quantityProduced = parseFloat(wo.quantity_produced) || 0;
  const unitCostFrozen   = wocRecord?.status === 'finalized' ? (parseFloat(wocRecord.unit_cost) || null) : null;
  const unitCost = unitCostFrozen !== null ? unitCostFrozen : (quantityProduced > 0 ? materialCost / quantityProduced : null);

  res.json({
    work_order: {
      id: wo.id,
      wo_number: wo.wo_number,
      status: wo.status,
      item: wo.inventory_items,
      bom: wo.bom_headers,
      quantity_to_produce: parseFloat(wo.quantity_to_produce) || 0,
      quantity_produced: quantityProduced,
      accumulated_material_cost: accumulatedMaterialCost,
      estimated_material_cost:   estimatedMaterialCost,
      material_cost: materialCost,
      unit_cost: unitCost,
      cost_basis: wocRecord?.status === 'finalized' ? 'finalized' : (accumulatedMaterialCost !== null ? 'accumulated' : 'estimated'),
      missing_cost: rows.some(row => row.cost_missing),
      materials: rows
    }
  });
});

module.exports = router;
