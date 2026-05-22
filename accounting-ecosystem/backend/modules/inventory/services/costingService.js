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
    .select('id, name, sku, category, current_stock, average_cost, cost_price, costing_method')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('name');

  if (error) throw new Error(error.message);

  return (data || []).map(item => {
    const qty      = parseFloat(item.current_stock) || 0;
    const unitCost = parseFloat(item.average_cost) || parseFloat(item.cost_price) || 0;
    return {
      itemId:        item.id,
      name:          item.name,
      sku:           item.sku,
      category:      item.category,
      qty,
      unitCost,
      totalValue:    qty * unitCost,
      costingMethod: item.costing_method || 'average'
    };
  });
}

module.exports = {
  // Pure computation
  computeWeightedAverage,
  computeWorkOrderUnitCost,

  // DB helpers
  getItemAverageCost,
  getItemCostingState,

  // Work order cost accumulation
  accumulateWorkOrderMaterialCost,
  finalizeWorkOrderCost,

  // Reporting
  getStockValuation
};
