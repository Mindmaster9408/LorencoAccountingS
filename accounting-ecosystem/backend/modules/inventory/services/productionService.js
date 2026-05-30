/**
 * ============================================================================
 * Production Service — Codebox 06 Manufacturing Execution
 * ============================================================================
 * Handles all production batch logic:
 *  - Yield calculation
 *  - Variance calculation (material expected vs actual)
 *  - Production batch creation
 *  - Wastage recording
 *  - Dashboard summary stats
 *
 * Rules:
 *  - Never modify stock directly — callers handle adjustStockTx
 *  - All functions receive supabase client (no new connections created)
 *  - All queries include company_id (multi-tenant isolation)
 *  - Batch records are immutable after creation (INSERT only)
 *  - Variance records are INSERT only
 *  - Wastage records are INSERT only
 * ============================================================================
 */

'use strict';

// ─── Yield Calculation ────────────────────────────────────────────────────────

/**
 * Calculate yield percentage.
 * Returns null if expectedQty is 0 or not provided.
 *
 * @param {number} producedQty
 * @param {number} expectedQty
 * @returns {number|null}
 */
function calculateYieldPercent(producedQty, expectedQty) {
  if (!expectedQty || expectedQty <= 0) return null;
  if (!producedQty || producedQty < 0)  return 0;
  return (producedQty / expectedQty) * 100;
}

/**
 * Determine yield status label for display/alerting.
 *
 * @param {number|null} yieldPercent
 * @returns {'good'|'under'|'over'|'unknown'}
 */
function yieldStatus(yieldPercent) {
  if (yieldPercent === null || yieldPercent === undefined) return 'unknown';
  if (yieldPercent >= 98 && yieldPercent <= 102) return 'good';
  if (yieldPercent < 98)  return 'under';
  return 'over';
}


// ─── Material Variance Calculation ───────────────────────────────────────────

/**
 * Compute material variance records for a completed batch.
 * Compares work_order_materials.required_qty vs issued_qty.
 *
 * @param {Array}  materials       — array of work_order_materials rows (with item average_cost)
 * @param {number} batchId
 * @param {number} workOrderId
 * @param {number} companyId
 * @returns {Array} Array of production_variance insert objects
 */
function buildVarianceRecords(materials, batchId, workOrderId, companyId) {
  const records = [];
  for (const mat of materials) {
    const required  = parseFloat(mat.required_qty || 0);
    const actual    = parseFloat(mat.issued_qty   || 0);
    const variance  = actual - required;
    const unitCost  = parseFloat(mat.inventory_items?.average_cost || mat.inventory_items?.cost_price || 0);

    let direction;
    if (Math.abs(variance) < 0.0001) {
      direction = 'none';
    } else if (variance > 0) {
      direction = 'over';   // consumed more than expected
    } else {
      direction = 'under';  // consumed less than expected
    }

    records.push({
      company_id:          companyId,
      batch_id:            batchId,
      work_order_id:       workOrderId,
      item_id:             mat.item_id,
      required_qty:        required,
      actual_qty:          actual,
      variance_qty:        variance,
      variance_direction:  direction,
      unit_cost:           unitCost,
      variance_value:      parseFloat((variance * unitCost).toFixed(4)),
      created_at:          new Date().toISOString()
    });
  }
  return records;
}


// ─── Batch Number Generation ─────────────────────────────────────────────────

/**
 * Generate the next batch number for a work order.
 * Format: WO-{woNumber}-B{n}  e.g. WO-00001-B1, WO-00001-B2
 *
 * @param {object} supabase
 * @param {number} workOrderId
 * @param {string} woNumber
 * @returns {Promise<string>}
 */
async function nextBatchNumber(supabase, workOrderId, woNumber) {
  const { count } = await supabase
    .from('production_batches')
    .select('id', { count: 'exact', head: true })
    .eq('work_order_id', workOrderId);

  const batchNum = (count || 0) + 1;
  return `${woNumber}-B${batchNum}`;
}


// ─── Production Batch Creation ───────────────────────────────────────────────

/**
 * Create an immutable production batch record.
 * Called inside the WO complete endpoint AFTER adjustStockTx succeeds.
 *
 * @param {object} supabase
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.workOrderId
 * @param {string} params.woNumber
 * @param {number} params.producedQty
 * @param {number} params.expectedQty
 * @param {number} params.wastageQty
 * @param {number} params.totalMaterialCost
 * @param {number} params.unitCost
 * @param {number} params.movementId        — stock_movements.id from adjustStockTx
 * @param {number} params.executedBy        — user id
 * @param {string} params.notes
 * @param {string} params.operatorNotes
 * @returns {Promise<{success: boolean, batch?: object, error?: string}>}
 */
async function createProductionBatch(supabase, {
  companyId, workOrderId, woNumber,
  producedQty, expectedQty, wastageQty,
  totalMaterialCost, unitCost,
  movementId, executedBy,
  notes, operatorNotes,
  // Codebox 10 — UOM output fields (all optional; null = not using UOM output costing)
  expectedOutputQty     = null,
  expectedOutputUnit    = null,
  actualOutputQty       = null,
  actualOutputUnit      = null,
  outputConversionFactor = null,
  costPerExpectedUnit   = null,
  costPerActualUnit     = null
}) {
  const yieldPct   = calculateYieldPercent(producedQty, expectedQty);
  const batchNum   = await nextBatchNumber(supabase, workOrderId, woNumber);
  const now        = new Date().toISOString();

  const { data, error } = await supabase
    .from('production_batches')
    .insert({
      company_id:             companyId,
      work_order_id:          workOrderId,
      batch_number:           batchNum,
      expected_qty:           expectedQty,
      produced_qty:           producedQty,
      wastage_qty:            wastageQty || 0,
      yield_percent:          yieldPct !== null ? parseFloat(yieldPct.toFixed(4)) : null,
      total_material_cost:    totalMaterialCost || 0,
      total_labour_cost:      0,
      total_machine_cost:     0,
      unit_cost:              unitCost || null,
      status:                 'completed',
      started_at:             now,
      completed_at:           now,
      executed_by:            executedBy || null,
      movement_id:            movementId || null,
      notes:                  notes      || null,
      operator_notes:         operatorNotes || null,
      created_at:             now,
      // Codebox 10 — bakery batch output costing
      expected_output_qty:    expectedOutputQty,
      expected_output_unit:   expectedOutputUnit,
      actual_output_qty:      actualOutputQty,
      actual_output_unit:     actualOutputUnit,
      output_conversion_factor: outputConversionFactor,
      cost_per_expected_unit: costPerExpectedUnit,
      cost_per_actual_unit:   costPerActualUnit
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, batch: data };
}


// ─── Wastage Records ─────────────────────────────────────────────────────────

/**
 * Insert one wastage record for a batch.
 * Returns success/error.
 *
 * @param {object} supabase
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.batchId
 * @param {number} params.workOrderId
 * @param {number|null} params.itemId        — null = finished-good output wastage
 * @param {number} params.wastageQty
 * @param {string} params.wastageReason
 * @param {number} params.estimatedValue
 * @param {string} params.notes
 * @param {number} params.createdBy
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function insertWastageRecord(supabase, {
  companyId, batchId, workOrderId,
  itemId, wastageQty, wastageReason, estimatedValue,
  notes, createdBy
}) {
  const ALLOWED_REASONS = [
    'spoilage', 'damage', 'trimming_loss', 'process_loss',
    'machine_error', 'operator_error', 'unknown', 'other'
  ];
  const reason = ALLOWED_REASONS.includes(wastageReason) ? wastageReason : 'unknown';

  const { error } = await supabase
    .from('production_wastage')
    .insert({
      company_id:      companyId,
      batch_id:        batchId,
      work_order_id:   workOrderId,
      item_id:         itemId   || null,
      wastage_qty:     parseFloat(wastageQty),
      wastage_reason:  reason,
      estimated_value: parseFloat(estimatedValue || 0),
      notes:           notes    || null,
      created_by:      createdBy || null,
      created_at:      new Date().toISOString()
    });

  if (error) return { success: false, error: error.message };
  return { success: true };
}


// ─── Variance Records ─────────────────────────────────────────────────────────

/**
 * Insert all variance records for a batch.
 *
 * @param {object} supabase
 * @param {Array}  records  — result of buildVarianceRecords()
 * @returns {Promise<{success: boolean, count: number, error?: string}>}
 */
async function insertVarianceRecords(supabase, records) {
  if (!records || records.length === 0) return { success: true, count: 0 };

  const { error } = await supabase
    .from('production_variances')
    .insert(records);

  if (error) return { success: false, count: 0, error: error.message };
  return { success: true, count: records.length };
}


// ─── Production Dashboard Stats ──────────────────────────────────────────────

/**
 * Fetch production summary stats for the dashboard.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @returns {Promise<object>}
 */
async function getProductionSummary(supabase, companyId) {
  const [batchesToday, batchesThisMonth, activeWOs, wastageThisMonth, totalBatches] = await Promise.all([
    // Batches completed today
    supabase
      .from('production_batches')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('completed_at', new Date().toISOString().split('T')[0]),

    // Batches completed this month
    supabase
      .from('production_batches')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('completed_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),

    // Active (in_progress + paused) WOs
    supabase
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['in_progress', 'paused']),

    // Wastage records this month
    supabase
      .from('production_wastage')
      .select('wastage_qty, estimated_value')
      .eq('company_id', companyId)
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),

    // Total production batches
    supabase
      .from('production_batches')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
  ]);

  const wastageRows  = wastageThisMonth.data || [];
  const totalWastageQty   = wastageRows.reduce((s, r) => s + (parseFloat(r.wastage_qty) || 0), 0);
  const totalWastageValue = wastageRows.reduce((s, r) => s + (parseFloat(r.estimated_value) || 0), 0);

  return {
    batches_today:       batchesToday.count       || 0,
    batches_this_month:  batchesThisMonth.count   || 0,
    active_work_orders:  activeWOs.count          || 0,
    total_batches:       totalBatches.count       || 0,
    wastage_qty_month:   parseFloat(totalWastageQty.toFixed(4)),
    wastage_value_month: parseFloat(totalWastageValue.toFixed(4))
  };
}


// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  calculateYieldPercent,
  yieldStatus,
  buildVarianceRecords,
  nextBatchNumber,
  createProductionBatch,
  insertWastageRecord,
  insertVarianceRecords,
  getProductionSummary
};
