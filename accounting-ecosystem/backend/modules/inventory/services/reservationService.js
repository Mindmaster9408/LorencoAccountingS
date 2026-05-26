'use strict';

/**
 * reservationService — Inventory Reservation Engine (Codebox 04)
 *
 * Reservations are COMMITMENTS, not stock movements.
 *   - No stock_movements row is created when reserving stock.
 *   - adjustStockTx() remains the ONLY path for actual stock mutations.
 *   - available_stock is computed dynamically:
 *       available = current_stock − SUM(qty_reserved − qty_released − qty_consumed)
 *       for reservations in status: active | partially_released
 *
 * Concurrency safety:
 *   createReservation() delegates to the reserve_stock() PostgreSQL function
 *   which acquires SELECT FOR UPDATE on inventory_items, preventing concurrent
 *   over-reservation even under simultaneous WO releases.
 */

/**
 * Get available stock for a single item.
 * available_stock = current_stock − active_reserved
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @param {number|null} warehouseId  — null = all warehouses combined
 * @returns {Promise<object>}
 */
async function getAvailableStock(supabase, companyId, itemId, warehouseId = null) {
  const { data: item, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, average_cost, min_stock')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (itemErr || !item) {
    return { success: false, error: 'Item not found' };
  }

  let q = supabase
    .from('stock_reservations')
    .select('id, quantity_reserved, quantity_released, quantity_consumed, source_type, source_id, source_line_id, reference, reservation_status, created_at')
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .in('reservation_status', ['active', 'partially_released']);

  if (warehouseId !== null) q = q.eq('warehouse_id', warehouseId);

  const { data: reservations, error: resErr } = await q;
  if (resErr) return { success: false, error: resErr.message };

  const activeReservations = reservations || [];
  const activeReserved = activeReservations.reduce((sum, r) => {
    return sum + (
      parseFloat(r.quantity_reserved) -
      parseFloat(r.quantity_released) -
      parseFloat(r.quantity_consumed)
    );
  }, 0);

  const currentStock    = parseFloat(item.current_stock) || 0;
  const availableStock  = Math.max(0, currentStock - activeReserved);

  return {
    success:         true,
    item_id:         itemId,
    item_name:       item.name,
    sku:             item.sku,
    unit:            item.unit,
    current_stock:   currentStock,
    active_reserved: activeReserved,
    available_stock: availableStock,
    is_low:          availableStock <= (parseFloat(item.min_stock) || 0),
    reservations:    activeReservations
  };
}

/**
 * Create a new reservation using the reserve_stock() RPC.
 * Validates available stock atomically before inserting.
 *
 * @param {object}  supabase
 * @param {object}  params
 * @param {number}  params.companyId
 * @param {number}  params.itemId
 * @param {number|null} params.warehouseId
 * @param {string}  params.sourceType    — 'work_order' | 'manual_hold' | etc.
 * @param {number}  params.sourceId      — WO id, company_id for manual_hold, etc.
 * @param {number|null} params.sourceLineId — work_order_materials.id
 * @param {number}  params.quantity
 * @param {string|null} params.reference
 * @param {string|null} params.reason
 * @param {number|null} params.createdBy
 * @returns {Promise<object>}
 */
async function createReservation(supabase, {
  companyId,
  itemId,
  warehouseId   = null,
  sourceType,
  sourceId,
  sourceLineId  = null,
  quantity,
  reference     = null,
  reason        = null,
  createdBy     = null
}) {
  if (!companyId || !itemId || !sourceType || !sourceId || !quantity) {
    return { success: false, error: 'companyId, itemId, sourceType, sourceId and quantity are required' };
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) {
    return { success: false, error: 'quantity must be a positive number' };
  }

  const { data, error } = await supabase.rpc('reserve_stock', {
    p_company_id:     companyId,
    p_item_id:        itemId,
    p_quantity:       qty,
    p_source_type:    sourceType,
    p_source_id:      sourceId,
    p_source_line_id: sourceLineId ?? null,
    p_warehouse_id:   warehouseId  ?? null,
    p_reference:      reference    ?? null,
    p_reason:         reason       ?? null,
    p_created_by:     createdBy    ?? null
  });

  if (error) return { success: false, error: error.message || 'Database error during reservation' };
  if (!data)  return { success: false, error: 'No response from reservation RPC' };

  if (!data.success) {
    return {
      success:       false,
      error:         data.error,
      current_stock: data.current_stock != null ? Number(data.current_stock) : undefined,
      reserved:      data.reserved      != null ? Number(data.reserved)      : undefined,
      available:     data.available     != null ? Number(data.available)     : undefined,
      requested:     data.requested     != null ? Number(data.requested)     : undefined
    };
  }

  return {
    success:         true,
    reservation_id:  data.reservation_id,
    current_stock:   Number(data.current_stock),
    reserved_before: Number(data.reserved_before),
    reserved_after:  Number(data.reserved_after),
    available_after: Number(data.available_after)
  };
}

/**
 * Release a reservation — fully or partially.
 * qty = null → release all remaining uncommitted quantity.
 *
 * @param {object}      supabase
 * @param {number}      reservationId
 * @param {number}      companyId
 * @param {number|null} qty         — null = full release
 * @param {number|null} userId
 * @returns {Promise<object>}
 */
async function releaseReservation(supabase, reservationId, companyId, qty, userId) {
  const { data: res, error: fetchErr } = await supabase
    .from('stock_reservations')
    .select('id, quantity_reserved, quantity_released, quantity_consumed, reservation_status')
    .eq('id', reservationId)
    .eq('company_id', companyId)
    .single();

  if (fetchErr || !res) return { success: false, error: 'Reservation not found' };
  if (!['active', 'partially_released'].includes(res.reservation_status)) {
    return { success: false, error: `Cannot release a reservation in '${res.reservation_status}' status` };
  }

  const remaining   = parseFloat(res.quantity_reserved) - parseFloat(res.quantity_released) - parseFloat(res.quantity_consumed);
  const releaseQty  = qty == null ? remaining : Math.min(parseFloat(qty), remaining);

  if (releaseQty <= 0) return { success: false, error: 'Nothing to release' };

  const newReleased      = parseFloat(res.quantity_released) + releaseQty;
  const newConsumed      = parseFloat(res.quantity_consumed);
  const isFullySettled   = (newReleased + newConsumed) >= parseFloat(res.quantity_reserved);

  const updates = {
    quantity_released:  newReleased,
    reservation_status: isFullySettled ? 'released' : 'partially_released',
    released_at:        new Date().toISOString(),
    released_by:        userId ?? null,
    updated_at:         new Date().toISOString()
  };

  const { error: updErr } = await supabase
    .from('stock_reservations')
    .update(updates)
    .eq('id', reservationId)
    .eq('company_id', companyId);

  if (updErr) return { success: false, error: updErr.message };
  return { success: true, released_qty: releaseQty, new_status: updates.reservation_status };
}

/**
 * Consume a reservation — fully or partially.
 * Called immediately after a successful adjustStockTx stock-out.
 * qty = null → consume all remaining uncommitted quantity.
 *
 * @param {object}      supabase
 * @param {number}      reservationId
 * @param {number}      companyId
 * @param {number|null} qty         — null = full consume
 * @param {number|null} userId
 * @returns {Promise<object>}
 */
async function consumeReservation(supabase, reservationId, companyId, qty, userId) {
  const { data: res, error: fetchErr } = await supabase
    .from('stock_reservations')
    .select('id, quantity_reserved, quantity_released, quantity_consumed, reservation_status')
    .eq('id', reservationId)
    .eq('company_id', companyId)
    .single();

  if (fetchErr || !res) return { success: false, error: 'Reservation not found' };
  if (!['active', 'partially_released'].includes(res.reservation_status)) {
    return { success: false, error: `Cannot consume a reservation in '${res.reservation_status}' status` };
  }

  const remaining   = parseFloat(res.quantity_reserved) - parseFloat(res.quantity_released) - parseFloat(res.quantity_consumed);
  const consumeQty  = qty == null ? remaining : Math.min(parseFloat(qty), remaining);

  if (consumeQty <= 0) return { success: false, error: 'Nothing to consume' };

  const newConsumed    = parseFloat(res.quantity_consumed) + consumeQty;
  const newReleased    = parseFloat(res.quantity_released);
  const isFullySettled = (newReleased + newConsumed) >= parseFloat(res.quantity_reserved);

  const updates = {
    quantity_consumed:  newConsumed,
    reservation_status: isFullySettled ? 'consumed' : 'partially_released',
    consumed_at:        new Date().toISOString(),
    consumed_by:        userId ?? null,
    updated_at:         new Date().toISOString()
  };

  const { error: updErr } = await supabase
    .from('stock_reservations')
    .update(updates)
    .eq('id', reservationId)
    .eq('company_id', companyId);

  if (updErr) return { success: false, error: updErr.message };
  return { success: true, consumed_qty: consumeQty, new_status: updates.reservation_status };
}

/**
 * Get all reservations for a specific source (e.g., a work order).
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {string} sourceType
 * @param {number|string} sourceId
 * @returns {Promise<object>}
 */
async function getReservationsForSource(supabase, companyId, sourceType, sourceId) {
  const { data, error } = await supabase
    .from('stock_reservations')
    .select('*, inventory_items:item_id(name, sku, unit)')
    .eq('company_id', companyId)
    .eq('source_type', sourceType)
    .eq('source_id', parseInt(sourceId))
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, reservations: data || [] };
}

/**
 * Shortage report — items where active reservations exceed current stock.
 * Sorted by severity: items with actual shortages first.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @returns {Promise<object>}
 */
async function getShortageReport(supabase, companyId) {
  // Fetch all active reservations for this company
  const { data: reservations, error: resErr } = await supabase
    .from('stock_reservations')
    .select('item_id, source_type, source_id, quantity_reserved, quantity_released, quantity_consumed')
    .eq('company_id', companyId)
    .in('reservation_status', ['active', 'partially_released']);

  if (resErr) return { success: false, error: resErr.message };

  if (!reservations || reservations.length === 0) {
    return { success: true, shortages: [], total_shortage_items: 0, total_reserved_value: 0 };
  }

  // Aggregate net reserved quantity per item
  const itemReservedMap = {};
  for (const r of reservations) {
    const net = parseFloat(r.quantity_reserved) - parseFloat(r.quantity_released) - parseFloat(r.quantity_consumed);
    if (net > 0) {
      itemReservedMap[r.item_id] = (itemReservedMap[r.item_id] || 0) + net;
    }
  }

  const itemIds = Object.keys(itemReservedMap).map(Number);
  if (itemIds.length === 0) {
    return { success: true, shortages: [], total_shortage_items: 0, total_reserved_value: 0 };
  }

  // Fetch item details for all reserved items
  const { data: items, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, current_stock, average_cost, min_stock')
    .eq('company_id', companyId)
    .in('id', itemIds);

  if (itemErr) return { success: false, error: itemErr.message };

  const shortages = [];
  for (const item of (items || [])) {
    const reserved    = itemReservedMap[item.id] || 0;
    const onHand      = parseFloat(item.current_stock) || 0;
    const available   = Math.max(0, onHand - reserved);
    const shortageQty = Math.max(0, reserved - onHand);
    const avgCost     = parseFloat(item.average_cost) || 0;

    shortages.push({
      item_id:            item.id,
      sku:                item.sku,
      item_name:          item.name,
      unit:               item.unit,
      on_hand:            onHand,
      reserved:           reserved,
      available:          available,
      shortage_qty:       shortageQty,
      has_shortage:       shortageQty > 0,
      reserved_value:     reserved * avgCost,
      recommended_action: shortageQty > 0
        ? `Order ${shortageQty.toFixed(4)} ${item.unit || 'units'} to cover active reservations`
        : 'Sufficient stock'
    });
  }

  // Sort: items with shortages first (largest shortage first), then at-risk items
  shortages.sort((a, b) => b.shortage_qty - a.shortage_qty);

  return {
    success:              true,
    shortages,
    total_shortage_items: shortages.filter(s => s.has_shortage).length,
    total_reserved_value: shortages.reduce((sum, s) => sum + s.reserved_value, 0)
  };
}

module.exports = {
  getAvailableStock,
  createReservation,
  releaseReservation,
  consumeReservation,
  getReservationsForSource,
  getShortageReport
};
