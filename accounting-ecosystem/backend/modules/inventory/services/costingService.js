/**
 * Inventory Costing Service — Phase 2A
 *
 * Centralises all costing logic for the inventory module.
 * All functions are pure (computation) or thin DB-wrappers (persistence).
 *
 * Rules:
 *  - Never call adjust_inventory_stock() from here — callers do that.
 *    This service handles costing concerns that sit ABOVE or ALONGSIDE the RPC.
 *  - weighted average is the default costing method.
 *  - All monetary values stored and returned as plain JavaScript numbers (float64).
 *    Callers are responsible for rounding for display.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { adjustStockTx } = require('./stockMutationService');

// Re-use the shared Supabase client passed in by callers rather than creating
// a new instance — avoids connection pool bloat.

// ─── Pure computation ─────────────────────────────────────────────────────────

/**
 * Compute the new weighted average cost after receiving stock.
 *
 * @param {number} currentQty   Current on-hand quantity before receipt
 * @param {number} currentAvg   Current weighted average cost per unit
 * @param {number} incomingQty  Quantity being received
 * @param {number} incomingCost Cost per unit of incoming stock
 * @returns {number} New weighted average cost per unit
 */
function computeWeightedAverage(currentQty, currentAvg, incomingQty, incomingCost) {
  if (typeof incomingCost !== 'number' || isNaN(incomingCost)) return currentAvg;
  if (typeof incomingQty !== 'number' || incomingQty <= 0) return currentAvg;

  if (currentQty <= 0) return incomingCost;

  const totalValue = (currentQty * currentAvg) + (incomingQty * incomingCost);
  const totalQty   = currentQty + incomingQty;
  return totalValue / totalQty;
}

/**
 * Compute the unit cost of a finished work order.
 * Returns null if completedQty is 0 or missing.
 *
 * @param {number} totalMaterialCost
 * @param {number} totalLaborCost
 * @param {number} totalOverheadCost
 * @param {number} completedQty
 * @returns {number|null}
 */
function computeWorkOrderUnitCost(totalMaterialCost, totalLaborCost, totalOverheadCost, completedQty) {
  if (!completedQty || completedQty <= 0) return null;
  const totalCost = (totalMaterialCost || 0) + (totalLaborCost || 0) + (totalOverheadCost || 0);
  return totalCost / completedQty;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch the current average_cost for an item.
 * Returns 0 if item not found.
 *
 * @param {object} supabase  Supabase client
 * @param {number} companyId
 * @param {number} itemId
 * @returns {Promise<number>}
 */
async function getItemAverageCost(supabase, companyId, itemId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('average_cost, cost_price')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (error || !data) return 0;
  return parseFloat(data.average_cost) || parseFloat(data.cost_price) || 0;
}

/**
 * Fetch cost and quantity fields needed for a weighted average calculation.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @returns {Promise<{currentQty: number, currentAvg: number}|null>}
 */
async function getItemCostingState(supabase, companyId, itemId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('current_stock, average_cost, cost_price, costing_method')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (error || !data) return null;

  return {
    currentQty:    parseFloat(data.current_stock) || 0,
    currentAvg:    parseFloat(data.average_cost)  || parseFloat(data.cost_price) || 0,
    costingMethod: data.costing_method || 'average'
  };
}

// ─── Work order cost accumulation ────────────────────────────────────────────

/**
 * Ensure a work_order_costs row exists for this WO, then add materialCostDelta
 * to the running material_cost total.
 * Called each time materials are issued to a WO.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} workOrderId
 * @param {number} materialCostDelta  Cost of the batch of materials just issued
 * @returns {Promise<{success: boolean, totalMaterialCost: number, error?: string}>}
 */
async function accumulateWorkOrderMaterialCost(supabase, companyId, workOrderId, materialCostDelta) {
  if (!materialCostDelta || materialCostDelta <= 0) {
    return { success: true, totalMaterialCost: 0 };
  }

  // Upsert: create the row if it doesn't exist, increment if it does.
  // Supabase does not support SQL-level upsert with increment in one call,
  // so we do a safe read-then-upsert within a short window.
  const { data: existing } = await supabase
    .from('work_order_costs')
    .select('id, material_cost')
    .eq('work_order_id', workOrderId)
    .eq('company_id', companyId)
    .single();

  if (existing) {
    const newTotal = (parseFloat(existing.material_cost) || 0) + materialCostDelta;
    const { error } = await supabase
      .from('work_order_costs')
      .update({ material_cost: newTotal, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) return { success: false, error: error.message };
    return { success: true, totalMaterialCost: newTotal };
  } else {
    const { data: inserted, error } = await supabase
      .from('work_order_costs')
      .insert({
        company_id:    companyId,
        work_order_id: workOrderId,
        material_cost: materialCostDelta,
        labor_cost:    0,
        overhead_cost: 0,
        status:        'open',
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString()
      })
      .select('material_cost')
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, totalMaterialCost: parseFloat(inserted.material_cost) };
  }
}

/**
 * Finalize the work_order_costs row when a WO is completed.
 * Computes unit_cost = (material + labor + overhead) / completedQty.
 * Sets status = 'finalized'.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} workOrderId
 * @param {number} completedQty
 * @returns {Promise<{success: boolean, unitCost: number|null, totalCost: number, error?: string}>}
 */
async function finalizeWorkOrderCost(supabase, companyId, workOrderId, completedQty) {
  const { data: woc } = await supabase
    .from('work_order_costs')
    .select('id, material_cost, labor_cost, overhead_cost')
    .eq('work_order_id', workOrderId)
    .eq('company_id', companyId)
    .single();

  const materialCost  = parseFloat(woc?.material_cost)  || 0;
  const laborCost     = parseFloat(woc?.labor_cost)     || 0;
  const overheadCost  = parseFloat(woc?.overhead_cost)  || 0;
  const totalCost     = materialCost + laborCost + overheadCost;
  const unitCost      = computeWorkOrderUnitCost(materialCost, laborCost, overheadCost, completedQty);

  if (woc) {
    const { error } = await supabase
      .from('work_order_costs')
      .update({
        completed_qty: completedQty,
        unit_cost:     unitCost,
        status:        'finalized',
        finalized_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString()
      })
      .eq('id', woc.id);

    if (error) return { success: false, unitCost: null, totalCost, error: error.message };
  } else {
    // WO completed with no material issues tracked — create a finalized zero-cost row
    const { error } = await supabase
      .from('work_order_costs')
      .insert({
        company_id:    companyId,
        work_order_id: workOrderId,
        material_cost: 0,
        labor_cost:    0,
        overhead_cost: 0,
        completed_qty: completedQty,
        unit_cost:     0,
        status:        'finalized',
        finalized_at:  new Date().toISOString(),
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString()
      });

    if (error) return { success: false, unitCost: 0, totalCost: 0, error: error.message };
  }

  return { success: true, unitCost: unitCost || 0, totalCost };
}

// ─── Stock valuation report helpers ──────────────────────────────────────────

/**
 * Compute total stock value for all active items in a company.
 * Value = current_stock × average_cost (falls back to cost_price if average_cost = 0).
 *
 * @param {object} supabase
 * @param {number} companyId
 * @returns {Promise<Array<{itemId, name, sku, qty, unitCost, totalValue, costingMethod}>>}
 */
async function getStockValuation(supabase, companyId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, name, sku, category, item_type, unit, current_stock, min_stock, average_cost, last_purchase_cost, cost_price, cost_updated_at, costing_method')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('name');

  if (error) throw new Error(error.message);

  return (data || []).map(item => {
    const qty = parseFloat(item.current_stock) || 0;
    const averageCost = parseFloat(item.average_cost);
    const lastPurchaseCost = parseFloat(item.last_purchase_cost);
    const fallbackCost = parseFloat(item.cost_price);
    const unitCost = Number.isFinite(averageCost)
      ? averageCost
      : (Number.isFinite(lastPurchaseCost) ? lastPurchaseCost : (Number.isFinite(fallbackCost) ? fallbackCost : 0));
    const hasCost = Number.isFinite(averageCost) || Number.isFinite(lastPurchaseCost) || Number.isFinite(fallbackCost);
    return {
      itemId:        item.id,
      name:          item.name,
      sku:           item.sku,
      category:      item.category,
      itemType:      item.item_type,
      unit:          item.unit,
      qty,
      unitCost,
      totalValue:    qty * unitCost,
      currentStock:  qty,
      averageCost:   Number.isFinite(averageCost) ? averageCost : null,
      lastPurchaseCost: Number.isFinite(lastPurchaseCost) ? lastPurchaseCost : null,
      minStock:      parseFloat(item.min_stock) || 0,
      costUpdatedAt: item.cost_updated_at || null,
      costingMethod: item.costing_method || 'average',
      hasCost,
      costMissing: !hasCost
    };
  });
}

// ─── Codebox 02: Costing method dispatch ─────────────────────────────────────

/**
 * Pure function — derive the correct issue cost from an already-fetched item row.
 *
 * Selects the cost value based on the item's costing_method:
 *   'average'   → average_cost (weighted average)
 *   'fifo'      → average_cost (FIFO layer consumption not yet implemented in pilot —
 *                  using average as a temporary proxy; documented in risk register R08)
 *   'standard'  → standard_cost
 *   'last_cost' → last_purchase_cost
 *
 * Falls back to cost_price (legacy field) if the primary cost is null / zero.
 *
 * @param {object|null} itemData  A row from inventory_items (or null)
 * @returns {{ issueCost: number|null, costingMethod: string, source: string }}
 */
function getIssueCostFromItemData(itemData) {
  if (!itemData) return { issueCost: null, costingMethod: 'average', source: 'not_found' };

  const method = itemData.costing_method || 'average';
  let issueCost = null;
  let source    = method;

  switch (method) {
    case 'standard':
      issueCost = parseFloat(itemData.standard_cost) || null;
      break;
    case 'last_cost':
      issueCost = parseFloat(itemData.last_purchase_cost) || null;
      break;
    case 'fifo':
      // FIFO layer consumption not fully implemented in the MrEasy pilot.
      // Use weighted average as proxy until FIFO consumption is added (Codebox 05+).
      issueCost = parseFloat(itemData.average_cost) || null;
      source    = 'fifo_proxy_average';
      break;
    case 'average':
    default:
      issueCost = parseFloat(itemData.average_cost) || null;
      break;
  }

  // Legacy fallback: if primary method yields null/zero, try cost_price
  if ((issueCost == null || issueCost === 0) && itemData.cost_price) {
    const fb = parseFloat(itemData.cost_price);
    if (Number.isFinite(fb) && fb > 0) {
      issueCost = fb;
      source    = 'cost_price_fallback';
    }
  }

  return { issueCost, costingMethod: method, source };
}

/**
 * Async version — fetches the item row from DB then calls getIssueCostFromItemData.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @returns {Promise<{ issueCost: number|null, costingMethod: string, source: string }>}
 */
async function getItemIssueCost(supabase, companyId, itemId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('average_cost, last_purchase_cost, standard_cost, cost_price, costing_method')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (error || !data) return { issueCost: null, costingMethod: 'average', source: 'not_found' };
  return getIssueCostFromItemData(data);
}

// ─── Codebox 02: Safety guard ─────────────────────────────────────────────────

/**
 * Guard function that prevents any caller from directly inserting valuation
 * movements. All stock mutations must flow through adjustStockTx → RPC.
 *
 * Call this anywhere a deprecated direct-insert path once existed to make
 * any accidental re-introduction loud at call time.
 *
 * Throws unconditionally.
 */
function recordValuationMovement() {
  throw new Error(
    'Direct valuation movement insertion is forbidden. ' +
    'All inventory movements must flow through stockMutationService.adjustStockTx(). ' +
    'The adjust_inventory_stock() RPC writes the valuation ledger atomically.'
  );
}

// ─── Codebox 02: Validated receipt wrapper ────────────────────────────────────

/**
 * Validated wrapper around adjustStockTx for stock-in (receipt) events.
 *
 * Applies stricter input validation than the raw adjustStockTx:
 *  - receivedQty  must be > 0
 *  - receivedUnitCost must be provided explicitly (null is rejected;
 *    pass 0 explicitly for zero-cost receives)
 *
 * All 5 costing side-effects (stock update, weighted average, valuation ledger,
 * FIFO layer, cost history) are handled atomically by the RPC.
 *
 * @param {object} supabase
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.itemId
 * @param {number} params.receivedQty         Must be > 0
 * @param {number} params.receivedUnitCost    Must not be null; pass 0 for zero-cost
 * @param {string} [params.reference]
 * @param {string} [params.notes]
 * @param {number} [params.createdBy]
 * @param {string} [params.sourceType]        e.g. 'po_receive', 'receipt', 'manual'
 * @param {string} [params.sourceId]
 * @param {number} [params.warehouseId]
 * @returns {Promise<{success: boolean, new_stock?: number, new_avg_cost?: number, error?: string}>}
 */
async function updateAverageCostAfterReceipt(supabase, {
  companyId, itemId,
  receivedQty, receivedUnitCost,
  reference, notes,
  createdBy, sourceType, sourceId,
  warehouseId = null
}) {
  if (!receivedQty || receivedQty <= 0)
    return { success: false, error: 'receivedQty must be greater than zero' };
  if (receivedUnitCost == null)
    return { success: false, error: 'receivedUnitCost is required; pass 0 explicitly for zero-cost receives' };
  if (receivedUnitCost < 0)
    return { success: false, error: 'receivedUnitCost cannot be negative' };

  return adjustStockTx(supabase, {
    companyId,
    itemId,
    delta:        receivedQty,
    movementType: 'in',
    warehouseId,
    reference,
    notes,
    unitCost:     receivedUnitCost,
    createdBy,
    sourceType:   sourceType || 'receipt',
    sourceId
  });
}

// ─── Codebox 02: WO cost reporting ───────────────────────────────────────────

/**
 * Compute a complete cost breakdown for a work order.
 *
 * For FINALIZED WOs: material cost is read from the authoritative accumulated
 *   total in work_order_costs.material_cost. Unit costs per component come from
 *   issue_unit_cost (frozen at issue time) where available.
 *
 * For IN-PROGRESS WOs: shows running accumulated total from work_order_costs,
 *   with per-component estimates using current pricing where issue_unit_cost
 *   is not yet available (pre-Codebox-02 issues).
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} workOrderId
 * @returns {Promise<{
 *   success: boolean,
 *   status: string,
 *   materialCost: number,
 *   laborCost: number,
 *   overheadCost: number,
 *   totalCost: number,
 *   completedQty: number,
 *   unitCost: number|null,
 *   components: Array
 * }>}
 */
async function calculateWorkOrderCost(supabase, companyId, workOrderId) {
  // Read the authoritative accumulated cost totals
  const { data: woc } = await supabase
    .from('work_order_costs')
    .select('material_cost, labor_cost, overhead_cost, completed_qty, unit_cost, status')
    .eq('work_order_id', workOrderId)
    .eq('company_id', companyId)
    .single();

  const materialCost = parseFloat(woc?.material_cost)  || 0;
  const laborCost    = parseFloat(woc?.labor_cost)     || 0;
  const overheadCost = parseFloat(woc?.overhead_cost)  || 0;
  const totalCost    = materialCost + laborCost + overheadCost;
  const completedQty = parseFloat(woc?.completed_qty)  || 0;
  const unitCost     = woc?.status === 'finalized'
    ? (parseFloat(woc.unit_cost) || (completedQty > 0 ? totalCost / completedQty : null))
    : (completedQty > 0 ? totalCost / completedQty : null);

  // Read per-component data with issue-time cost and current cost
  const { data: materials } = await supabase
    .from('work_order_materials')
    .select([
      'id', 'item_id', 'required_qty', 'issued_qty', 'issue_unit_cost',
      'inventory_items:item_id(name, sku, average_cost, last_purchase_cost, cost_price, costing_method)'
    ].join(', '))
    .eq('work_order_id', workOrderId);

  const components = (materials || []).map(m => {
    const frozenCost     = parseFloat(m.issue_unit_cost);
    const { issueCost: currentCost } = getIssueCostFromItemData(m.inventory_items);
    const issuedQty      = parseFloat(m.issued_qty)   || 0;
    const requiredQty    = parseFloat(m.required_qty) || 0;
    const hasFrozenCost  = Number.isFinite(frozenCost) && frozenCost >= 0;
    const displayCost    = hasFrozenCost ? frozenCost : currentCost;

    return {
      item_id:          m.item_id,
      item_name:        m.inventory_items?.name || 'Unknown',
      sku:              m.inventory_items?.sku  || null,
      required_qty:     requiredQty,
      issued_qty:       issuedQty,
      remaining_qty:    Math.max(0, requiredQty - issuedQty),
      issue_unit_cost:  hasFrozenCost ? frozenCost   : null,
      current_unit_cost: currentCost,
      unit_cost:        displayCost,
      issued_cost:      displayCost != null ? issuedQty * displayCost : null,
      cost_basis:       hasFrozenCost ? 'frozen_at_issue' : 'current_estimate',
      cost_missing:     displayCost == null
    };
  });

  return {
    success: true,
    status: woc?.status || 'no_record',
    materialCost,
    laborCost,
    overheadCost,
    totalCost,
    completedQty,
    unitCost,
    components
  };
}

module.exports = {
  // Pure computation
  computeWeightedAverage,
  computeWorkOrderUnitCost,

  // DB helpers
  getItemAverageCost,
  getItemCostingState,

  // Codebox 02: costing method dispatch
  getIssueCostFromItemData,
  getItemIssueCost,

  // Codebox 02: safety guard
  recordValuationMovement,

  // Codebox 02: validated receipt wrapper
  updateAverageCostAfterReceipt,

  // Work order cost accumulation
  accumulateWorkOrderMaterialCost,
  finalizeWorkOrderCost,

  // Codebox 02: WO cost reporting
  calculateWorkOrderCost,

  // Reporting
  getStockValuation
};
