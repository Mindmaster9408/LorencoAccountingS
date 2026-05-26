/**
 * stock-helpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared helper that replaces the broken adjust_inventory_stock() Supabase RPC.
 *
 * Root cause: migration 041 deployed the RPC with `type` and `cost_price`
 * column names, but the stock_movements table (created in migration 007)
 * uses `movement_type` and `unit_cost`.
 *
 * This helper replicates the RPC's logic directly in Node.js using the
 * correct column names. It does NOT insert into stock_valuation_movements,
 * inventory_cost_layers, or item_cost_history — those are costing-ledger
 * tables that the demo tests do not exercise.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Atomically (best-effort) adjusts inventory stock.
 *
 * @param {object} supabase  - Supabase client instance
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.itemId
 * @param {number} params.delta          - positive = stock in, negative = stock out
 * @param {string} params.movementType   - 'in' | 'out' | 'adjustment' | 'return'
 * @param {number|null} params.warehouseId
 * @param {string|null} params.reference
 * @param {string|null} params.notes
 * @param {number|null} params.costPrice - unit cost (maps to unit_cost column)
 * @param {number|null} params.createdBy
 * @param {string|null} params.sourceType
 * @param {string|null} params.sourceId
 *
 * @returns {{ success: boolean, new_stock?: number, new_avg_cost?: number, error?: string, available?: number }}
 */
async function adjustStock(supabase, {
  companyId,
  itemId,
  delta,
  movementType,
  warehouseId = null,
  reference = null,
  notes = null,
  costPrice = null,
  createdBy = null,
  sourceType = null,
  sourceId = null
}) {
  // ── Step 1: Read current item state ──────────────────────────────────────
  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('current_stock, average_cost')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (itemErr || !item) {
    return { success: false, error: 'Item not found' };
  }

  const oldStock = parseFloat(item.current_stock) || 0;
  const oldAvg   = parseFloat(item.average_cost)  || 0;

  // ── Step 2: Guard — no negative stock for outbound movements ─────────────
  if (delta < 0 && (oldStock + delta) < 0) {
    return { success: false, error: 'Insufficient stock', available: oldStock };
  }

  // ── Step 3: Weighted average cost (inbound with known cost only) ─────────
  let newAvg = oldAvg;
  if (delta > 0 && costPrice != null) {
    if (oldStock <= 0) {
      newAvg = costPrice;
    } else {
      newAvg = Math.round(
        ((oldStock * oldAvg) + (delta * costPrice)) / (oldStock + delta) * 1e6
      ) / 1e6;
    }
  }

  const newStock = oldStock + delta;

  // ── Step 4: Update inventory_items ───────────────────────────────────────
  const itemUpdate = {
    current_stock: newStock,
    average_cost:  newAvg,
    updated_at:    new Date().toISOString()
  };
  if (costPrice != null && (sourceType === 'quick_receive' || sourceType === 'po_receive')) {
    itemUpdate.last_purchase_cost = costPrice;
    itemUpdate.cost_updated_at    = new Date().toISOString();
  }

  const { error: updateErr } = await supabase
    .from('inventory_items')
    .update(itemUpdate)
    .eq('id', itemId)
    .eq('company_id', companyId);

  if (updateErr) {
    return { success: false, error: updateErr.message };
  }

  // ── Step 5: Insert stock movement (CORRECT column names) ─────────────────
  const { error: movErr } = await supabase
    .from('stock_movements')
    .insert({
      company_id:    companyId,
      item_id:       itemId,
      warehouse_id:  warehouseId || null,
      movement_type: movementType,        // ← correct column name (not "type")
      quantity:      Math.abs(delta),
      unit_cost:     costPrice ?? null,   // ← correct column name (not "cost_price")
      reference:     reference   || null,
      notes:         notes       || null,
      created_by:    createdBy   || null
    });

  if (movErr) {
    return { success: false, error: movErr.message };
  }

  return { success: true, new_stock: newStock, new_avg_cost: newAvg };
}

module.exports = { adjustStock };
