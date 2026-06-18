'use strict';

/**
 * stockMutationService — Forensic Stock Mutation Engine (Codebox 01)
 *
 * Single approved path for all inventory stock changes.
 * Delegates to adjust_inventory_stock() PostgreSQL RPC which:
 *   - Acquires a SELECT ... FOR UPDATE row lock (no concurrent race condition)
 *   - Updates inventory_items atomically (current_stock + average_cost)
 *   - Inserts into stock_movements (movement audit trail)
 *   - Inserts into stock_valuation_movements (immutable forensic cost ledger)
 *   - Creates inventory_cost_layers rows for stock-in with known cost (FIFO)
 *   - Appends to item_cost_history when average_cost changes
 *
 * Every stock mutation in the inventory module MUST go through adjustStockTx().
 * Direct stock_movements inserts and the old adjustStock() helper are forbidden.
 */

/**
 * Adjust stock for one item within a transaction-safe DB function.
 *
 * @param {object} supabase        Supabase client instance
 * @param {object} params
 * @param {number} params.companyId      Tenant company ID — required, never null
 * @param {number} params.itemId         inventory_items.id
 * @param {number} params.delta          Stock change: positive = in, negative = out
 * @param {string} params.movementType   'in' | 'out' | 'adjustment' | 'return'
 * @param {number|null} params.warehouseId
 * @param {string|null} params.reference Human-readable reference (PO#, WO#, etc.)
 * @param {string|null} params.notes
 * @param {number|null} params.unitCost  Cost per unit for this movement
 * @param {number|null} params.createdBy users.id of the acting user
 * @param {string|null} params.sourceType 'po_receive'|'wo_issue'|'wo_complete'|'quick_receive'|'manual'
 * @param {string|null} params.sourceId  Source record ID (PO id, WO id, etc.)
 *
 * @returns {Promise<{
 *   success: boolean,
 *   movement_id?: number,  // stock_movements.id — null when sourceType/sourceId not provided
 *   old_stock?: number,
 *   new_stock?: number,
 *   new_avg_cost?: number,
 *   error?: string,
 *   available?: number
 * }>}
 */
async function adjustStockTx(supabase, {
  companyId,
  itemId,
  delta,
  movementType,
  warehouseId  = null,
  reference    = null,
  notes        = null,
  unitCost     = null,
  createdBy    = null,
  sourceType   = null,
  sourceId     = null
}) {
  // Input validation — fail fast before touching the database
  if (!companyId || typeof companyId !== 'number') {
    return { success: false, error: 'companyId is required and must be a number' };
  }
  if (!itemId || typeof itemId !== 'number') {
    return { success: false, error: 'itemId is required and must be a number' };
  }
  if (typeof delta !== 'number' || isNaN(delta) || delta === 0) {
    return { success: false, error: 'delta must be a non-zero number' };
  }
  if (!movementType || typeof movementType !== 'string') {
    return { success: false, error: 'movementType is required' };
  }

  const { data, error } = await supabase.rpc('adjust_inventory_stock', {
    p_company_id:    companyId,
    p_item_id:       itemId,
    p_delta:         delta,
    p_movement_type: movementType,
    p_warehouse_id:  warehouseId  ?? null,
    p_reference:     reference    ?? null,
    p_notes:         notes        ?? null,
    p_cost_price:    unitCost     ?? null,
    p_created_by:    createdBy    ?? null,
    p_source_type:   sourceType   ?? null,
    p_source_id:     sourceId     ? String(sourceId) : null
  });

  if (error) {
    // Supabase/PostgreSQL transport error — not a business rule failure
    return { success: false, error: error.message || 'Database error during stock mutation' };
  }

  if (!data || typeof data !== 'object') {
    return { success: false, error: 'Unexpected response from stock mutation RPC' };
  }

  // The RPC returns a JSONB object; Supabase deserialises it automatically
  if (!data.success) {
    return {
      success:   false,
      error:     data.error     || 'Stock mutation failed',
      available: data.available != null ? Number(data.available) : undefined
    };
  }

  // ── Resolve movement_id ─────────────────────────────────────────────────────
  // The RPC writes v_movement_id to stock_movements and stock_valuation_movements
  // but the current RETURN jsonb_build_object does not include it.
  // Primary path: data.movement_id is used directly when the RPC is updated.
  // Fallback path: query stock_valuation_movements via the source composite key —
  //   that table already holds movement_id and previous_stock, both populated by the RPC.
  let resolvedMovementId = data.movement_id != null ? Number(data.movement_id) : null;
  let resolvedOldStock   = data.old_stock   != null ? Number(data.old_stock)   : undefined;

  if (resolvedMovementId === null && sourceType && sourceId != null) {
    const { data: svmRow } = await supabase
      .from('stock_valuation_movements')
      .select('movement_id, previous_stock')
      .eq('company_id', companyId)
      .eq('item_id', itemId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (svmRow) {
      resolvedMovementId = svmRow.movement_id ?? null;
      if (resolvedOldStock === undefined && svmRow.previous_stock != null) {
        resolvedOldStock = Number(svmRow.previous_stock);
      }
    }
  }

  return {
    success:      true,
    movement_id:  resolvedMovementId,
    old_stock:    resolvedOldStock,
    new_stock:    data.new_stock    != null ? Number(data.new_stock)    : undefined,
    new_avg_cost: data.new_avg_cost != null ? Number(data.new_avg_cost) : undefined,
  };
}

module.exports = { adjustStockTx };
