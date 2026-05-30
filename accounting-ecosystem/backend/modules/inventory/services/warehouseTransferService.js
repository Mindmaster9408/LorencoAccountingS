'use strict';

/**
 * warehouseTransferService — Codebox 08 Warehouse Transfer Engine
 *
 * Manages warehouse-to-warehouse stock transfers with full audit trail.
 *
 * Transfer lifecycle:
 *   draft → approved → in_transit → received
 *                    ↘ cancelled (from draft or approved)
 *
 * Stock flow:
 *   Ship (in_transit):  adjustStockTx OUT from source warehouse
 *   Receive:            adjustStockTx IN  to destination warehouse
 *
 * Source of truth for company-total stock: inventory_items.current_stock
 * Source of truth for per-warehouse stock: inventory_stock_locations (maintained here)
 *
 * Every transfer creates real stock_movements audit records.
 * No silent stock changes. No stock teleportation.
 */

const { adjustStockTx } = require('./stockMutationService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseQty(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function nextTransferNumber(companyId) {
  const ts = Date.now().toString(36).toUpperCase();
  return `TRF-${companyId}-${ts}`;
}

// ─── Stock location ledger ────────────────────────────────────────────────────

/**
 * Upsert the per-(item × warehouse × location) quantity summary.
 * delta is positive (stock in) or negative (stock out).
 * Graceful on failure — stock movements are already written; this is supplementary.
 */
async function upsertStockLocation(supabase, { companyId, itemId, warehouseId, locationId = null, delta }) {
  try {
    const { data: existing } = await supabase
      .from('inventory_stock_locations')
      .select('id, quantity_on_hand')
      .eq('company_id', companyId)
      .eq('item_id', itemId)
      .eq('warehouse_id', warehouseId)
      .is('location_id', locationId === null ? null : undefined)
      .eq('location_id', locationId !== null ? locationId : undefined)
      .maybeSingle();

    // Filter workaround: Supabase JS doesn't allow chaining .is() and .eq() on the same column.
    // Use the select with explicit filter instead.
    const { data: rows } = await supabase
      .from('inventory_stock_locations')
      .select('id, quantity_on_hand')
      .eq('company_id', companyId)
      .eq('item_id', itemId)
      .eq('warehouse_id', warehouseId);

    const row = (rows || []).find(r =>
      locationId === null ? r.location_id === null : r.location_id === locationId
    );

    const newQty = Math.max(0, (row ? parseQty(row.quantity_on_hand) : 0) + delta);

    if (row) {
      await supabase
        .from('inventory_stock_locations')
        .update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() })
        .eq('id', row.id);
    } else {
      await supabase
        .from('inventory_stock_locations')
        .insert({
          company_id:       companyId,
          item_id:          itemId,
          warehouse_id:     warehouseId,
          location_id:      locationId,
          quantity_on_hand: Math.max(0, delta),
          quantity_reserved: 0
        });
    }
  } catch (err) {
    // Log but do not fail — primary stock record (adjustStockTx) is already committed
    console.warn('[warehouseTransferService] upsertStockLocation failed:', err.message);
  }
}

// ─── getWarehouseStock ────────────────────────────────────────────────────────

/**
 * Returns per-item stock for a warehouse.
 * If warehouseId is null, returns stock from inventory_stock_locations grouped
 * by warehouse. Falls back to inventory_items if no location data exists.
 */
async function getWarehouseStock(supabase, companyId, warehouseId = null) {
  let q = supabase
    .from('inventory_stock_locations')
    .select(`
      warehouse_id, location_id, quantity_on_hand, quantity_reserved, updated_at,
      inventory_items:item_id (id, name, sku, unit, item_type, average_cost, min_stock),
      warehouses:warehouse_id (id, name, warehouse_code),
      warehouse_locations:location_id (id, location_code, location_name, location_type)
    `)
    .eq('company_id', companyId)
    .order('updated_at', { ascending: false });

  if (warehouseId) q = q.eq('warehouse_id', warehouseId);

  const { data, error } = await q;
  if (error) return { success: false, error: error.message };

  const rows = data || [];
  const available = rows.map(r => ({
    ...r,
    quantity_available: Math.max(0, parseQty(r.quantity_on_hand) - parseQty(r.quantity_reserved))
  }));

  return { success: true, stock: available };
}

// ─── getWarehouseAvailability ─────────────────────────────────────────────────

/**
 * Returns available stock (on_hand − reserved) per warehouse.
 * Also surfaces items below min_stock threshold per warehouse.
 */
async function getWarehouseAvailability(supabase, companyId) {
  const { data: whRows, error: whErr } = await supabase
    .from('warehouses')
    .select('id, name, warehouse_code, warehouse_type, is_default')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('name');

  if (whErr) return { success: false, error: whErr.message };

  const warehouses = whRows || [];
  const whIds = warehouses.map(w => w.id);

  if (whIds.length === 0) return { success: true, warehouses: [] };

  const { data: stockRows } = await supabase
    .from('inventory_stock_locations')
    .select(`
      warehouse_id, quantity_on_hand, quantity_reserved,
      inventory_items:item_id (id, name, sku, unit, item_type, min_stock, average_cost)
    `)
    .eq('company_id', companyId)
    .in('warehouse_id', whIds);

  const byWarehouse = {};
  for (const w of warehouses) {
    byWarehouse[w.id] = { ...w, items: [], total_value: 0, low_stock_count: 0 };
  }

  for (const r of (stockRows || [])) {
    const wh = byWarehouse[r.warehouse_id];
    if (!wh) continue;
    const onHand   = parseQty(r.quantity_on_hand);
    const reserved = parseQty(r.quantity_reserved);
    const available = Math.max(0, onHand - reserved);
    const item = r.inventory_items || {};
    const value = onHand * (parseQty(item.average_cost));
    wh.total_value += value;
    if (available <= parseQty(item.min_stock)) wh.low_stock_count++;
    wh.items.push({
      item_id:            item.id,
      item_name:          item.name,
      sku:                item.sku,
      unit:               item.unit,
      item_type:          item.item_type,
      quantity_on_hand:   onHand,
      quantity_reserved:  reserved,
      quantity_available: available,
      min_stock:          parseQty(item.min_stock),
      value
    });
  }

  return { success: true, warehouses: Object.values(byWarehouse) };
}

// ─── Create transfer ──────────────────────────────────────────────────────────

async function createTransfer(supabase, companyId, {
  from_warehouse_id,
  to_warehouse_id,
  from_location_id = null,
  to_location_id   = null,
  notes            = null,
  requested_by     = null,
  lines            = []
}) {
  if (!from_warehouse_id || !to_warehouse_id) {
    return { success: false, status: 400, error: 'from_warehouse_id and to_warehouse_id are required' };
  }
  if (from_warehouse_id === to_warehouse_id) {
    return { success: false, status: 400, error: 'Source and destination warehouses must be different' };
  }
  if (!lines || lines.length === 0) {
    return { success: false, status: 400, error: 'At least one transfer line is required' };
  }

  // Verify both warehouses belong to this company
  const { data: whs } = await supabase
    .from('warehouses')
    .select('id')
    .eq('company_id', companyId)
    .in('id', [from_warehouse_id, to_warehouse_id]);

  if ((whs || []).length < 2) {
    return { success: false, status: 404, error: 'One or both warehouses not found for this company' };
  }

  // Verify all items belong to this company
  const itemIds = [...new Set(lines.map(l => parseInt(l.item_id)).filter(Boolean))];
  const { data: items } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('company_id', companyId)
    .in('id', itemIds);

  const foundIds = new Set((items || []).map(i => i.id));
  const missing = itemIds.filter(id => !foundIds.has(id));
  if (missing.length > 0) {
    return { success: false, status: 404, error: `Items not found: ${missing.join(', ')}` };
  }

  const transferNumber = nextTransferNumber(companyId);
  const now = new Date().toISOString();

  const { data: transfer, error: tErr } = await supabase
    .from('warehouse_transfers')
    .insert({
      company_id:        companyId,
      transfer_number:   transferNumber,
      from_warehouse_id: parseInt(from_warehouse_id),
      to_warehouse_id:   parseInt(to_warehouse_id),
      from_location_id:  from_location_id ? parseInt(from_location_id) : null,
      to_location_id:    to_location_id   ? parseInt(to_location_id)   : null,
      transfer_status:   'draft',
      requested_by:      requested_by ? parseInt(requested_by) : null,
      notes:             notes || null,
      created_at:        now,
      updated_at:        now
    })
    .select()
    .single();

  if (tErr) return { success: false, status: 500, error: tErr.message };

  // Insert lines
  const lineInserts = lines.map(l => ({
    company_id:          companyId,
    transfer_id:         transfer.id,
    item_id:             parseInt(l.item_id),
    quantity_requested:  parseQty(l.quantity_requested),
    from_location_id:    l.from_location_id ? parseInt(l.from_location_id) : (from_location_id ? parseInt(from_location_id) : null),
    to_location_id:      l.to_location_id   ? parseInt(l.to_location_id)   : (to_location_id   ? parseInt(to_location_id)   : null),
    notes:               l.notes || null,
    created_at:          now,
    updated_at:          now
  }));

  const { error: lineErr } = await supabase
    .from('warehouse_transfer_lines')
    .insert(lineInserts);

  if (lineErr) {
    // Clean up the transfer header on line insert failure
    await supabase.from('warehouse_transfers').delete().eq('id', transfer.id);
    return { success: false, status: 500, error: lineErr.message };
  }

  return { success: true, transfer };
}

// ─── Approve transfer ─────────────────────────────────────────────────────────

async function approveTransfer(supabase, companyId, transferId, approvedBy) {
  const { data: transfer, error } = await supabase
    .from('warehouse_transfers')
    .select('id, transfer_status')
    .eq('id', transferId)
    .eq('company_id', companyId)
    .single();

  if (error || !transfer) return { success: false, status: 404, error: 'Transfer not found' };
  if (transfer.transfer_status !== 'draft') {
    return { success: false, status: 409, error: `Cannot approve a transfer with status '${transfer.transfer_status}'` };
  }

  const { error: upErr } = await supabase
    .from('warehouse_transfers')
    .update({
      transfer_status: 'approved',
      approved_by:     approvedBy ? parseInt(approvedBy) : null,
      approved_at:     new Date().toISOString(),
      updated_at:      new Date().toISOString()
    })
    .eq('id', transferId)
    .eq('company_id', companyId);

  if (upErr) return { success: false, status: 500, error: upErr.message };
  return { success: true };
}

// ─── Ship transfer (in_transit) ───────────────────────────────────────────────

/**
 * Mark transfer as in_transit and create OUT movements from source warehouse.
 * shipLines: [{ line_id, quantity_shipped }] — allows partial shipment.
 * If shipLines is empty/absent, ships the full requested quantity for all lines.
 */
async function shipTransfer(supabase, companyId, transferId, shippedBy, shipLines = []) {
  // Load transfer + lines
  const { data: transfer, error: tErr } = await supabase
    .from('warehouse_transfers')
    .select('*, warehouse_transfer_lines(*)')
    .eq('id', transferId)
    .eq('company_id', companyId)
    .single();

  if (tErr || !transfer) return { success: false, status: 404, error: 'Transfer not found' };
  if (!['draft', 'approved'].includes(transfer.transfer_status)) {
    return { success: false, status: 409, error: `Cannot ship a transfer with status '${transfer.transfer_status}'` };
  }

  const lines = transfer.warehouse_transfer_lines || [];
  if (lines.length === 0) return { success: false, status: 400, error: 'Transfer has no lines' };

  // Build ship qty map
  const shipQtyByLine = {};
  if (shipLines && shipLines.length > 0) {
    for (const s of shipLines) shipQtyByLine[parseInt(s.line_id)] = parseQty(s.quantity_shipped);
  }

  const transferRef = `TRF-OUT-${transfer.transfer_number}`;
  const errors = [];
  const shipped = [];

  for (const line of lines) {
    const qty = shipQtyByLine[line.id] ?? parseQty(line.quantity_requested);
    if (qty <= 0) continue;

    // Create OUT movement from source warehouse
    const result = await adjustStockTx(supabase, {
      companyId,
      itemId:       line.item_id,
      delta:        -qty,
      movementType: 'transfer',
      warehouseId:  transfer.from_warehouse_id,
      reference:    transferRef,
      notes:        `Transfer ${transfer.transfer_number} → warehouse ${transfer.to_warehouse_id}`,
      unitCost:     null,
      createdBy:    shippedBy ? parseInt(shippedBy) : null,
      sourceType:   'warehouse_transfer',
      sourceId:     String(transfer.id)
    });

    if (!result.success) {
      errors.push({ item_id: line.item_id, error: result.error, available: result.available });
      continue;
    }

    // Update stock location ledger
    await upsertStockLocation(supabase, {
      companyId,
      itemId:      line.item_id,
      warehouseId: transfer.from_warehouse_id,
      locationId:  line.from_location_id || transfer.from_location_id || null,
      delta:       -qty
    });

    // Update line with shipped qty
    await supabase
      .from('warehouse_transfer_lines')
      .update({ quantity_shipped: qty, updated_at: new Date().toISOString() })
      .eq('id', line.id);

    shipped.push({ line_id: line.id, item_id: line.item_id, quantity_shipped: qty });
  }

  if (errors.length > 0 && shipped.length === 0) {
    return { success: false, status: 422, errors };
  }

  // Update transfer status
  await supabase
    .from('warehouse_transfers')
    .update({
      transfer_status: 'in_transit',
      shipped_at:      new Date().toISOString(),
      updated_at:      new Date().toISOString()
    })
    .eq('id', transferId)
    .eq('company_id', companyId);

  return { success: true, shipped, errors };
}

// ─── Receive transfer ─────────────────────────────────────────────────────────

/**
 * Receive transfer at destination warehouse and create IN movements.
 * receiveLines: [{ line_id, quantity_received }] — allows partial receipt.
 * If absent, receives the full shipped quantity.
 */
async function receiveTransfer(supabase, companyId, transferId, receivedBy, receiveLines = []) {
  const { data: transfer, error: tErr } = await supabase
    .from('warehouse_transfers')
    .select('*, warehouse_transfer_lines(*)')
    .eq('id', transferId)
    .eq('company_id', companyId)
    .single();

  if (tErr || !transfer) return { success: false, status: 404, error: 'Transfer not found' };
  if (transfer.transfer_status !== 'in_transit') {
    return { success: false, status: 409, error: `Cannot receive a transfer with status '${transfer.transfer_status}'` };
  }

  const lines = transfer.warehouse_transfer_lines || [];
  const recvQtyByLine = {};
  if (receiveLines && receiveLines.length > 0) {
    for (const r of receiveLines) recvQtyByLine[parseInt(r.line_id)] = parseQty(r.quantity_received);
  }

  const transferRef = `TRF-IN-${transfer.transfer_number}`;
  const errors = [];
  const received = [];

  for (const line of lines) {
    const qty = recvQtyByLine[line.id] ?? (parseQty(line.quantity_shipped) || parseQty(line.quantity_requested));
    if (qty <= 0) continue;

    // Fetch current cost to preserve average_cost accuracy on receipt
    const { data: item } = await supabase
      .from('inventory_items')
      .select('average_cost, cost_price')
      .eq('id', line.item_id)
      .eq('company_id', companyId)
      .single();
    const unitCost = item ? (parseQty(item.average_cost) || parseQty(item.cost_price)) : null;

    // Create IN movement to destination warehouse
    const result = await adjustStockTx(supabase, {
      companyId,
      itemId:       line.item_id,
      delta:        qty,
      movementType: 'transfer',
      warehouseId:  transfer.to_warehouse_id,
      reference:    transferRef,
      notes:        `Transfer ${transfer.transfer_number} from warehouse ${transfer.from_warehouse_id}`,
      unitCost:     unitCost || null,
      createdBy:    receivedBy ? parseInt(receivedBy) : null,
      sourceType:   'warehouse_transfer',
      sourceId:     String(transfer.id)
    });

    if (!result.success) {
      errors.push({ item_id: line.item_id, error: result.error });
      continue;
    }

    // Update destination stock location ledger
    await upsertStockLocation(supabase, {
      companyId,
      itemId:      line.item_id,
      warehouseId: transfer.to_warehouse_id,
      locationId:  line.to_location_id || transfer.to_location_id || null,
      delta:       qty
    });

    // Update line
    await supabase
      .from('warehouse_transfer_lines')
      .update({ quantity_received: qty, updated_at: new Date().toISOString() })
      .eq('id', line.id);

    received.push({ line_id: line.id, item_id: line.item_id, quantity_received: qty });
  }

  if (errors.length > 0 && received.length === 0) {
    return { success: false, status: 422, errors };
  }

  await supabase
    .from('warehouse_transfers')
    .update({
      transfer_status: 'received',
      received_at:     new Date().toISOString(),
      updated_at:      new Date().toISOString()
    })
    .eq('id', transferId)
    .eq('company_id', companyId);

  return { success: true, received, errors };
}

// ─── Cancel transfer ──────────────────────────────────────────────────────────

async function cancelTransfer(supabase, companyId, transferId) {
  const { data: transfer, error } = await supabase
    .from('warehouse_transfers')
    .select('id, transfer_status')
    .eq('id', transferId)
    .eq('company_id', companyId)
    .single();

  if (error || !transfer) return { success: false, status: 404, error: 'Transfer not found' };
  if (transfer.transfer_status === 'in_transit') {
    return { success: false, status: 409, error: 'Cannot cancel a transfer that is already in transit. Receive it instead.' };
  }
  if (transfer.transfer_status === 'received') {
    return { success: false, status: 409, error: 'Cannot cancel a completed transfer' };
  }
  if (transfer.transfer_status === 'cancelled') {
    return { success: false, status: 409, error: 'Transfer is already cancelled' };
  }

  const { error: upErr } = await supabase
    .from('warehouse_transfers')
    .update({ transfer_status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', transferId)
    .eq('company_id', companyId);

  if (upErr) return { success: false, status: 500, error: upErr.message };
  return { success: true };
}

// ─── List transfers ───────────────────────────────────────────────────────────

async function listTransfers(supabase, companyId, { status, from_warehouse_id, to_warehouse_id, limit = 100 } = {}) {
  let q = supabase
    .from('warehouse_transfers')
    .select(`
      id, transfer_number, transfer_status, notes,
      shipped_at, received_at, approved_at, created_at,
      from_warehouses:from_warehouse_id (id, name, warehouse_code),
      to_warehouses:to_warehouse_id (id, name, warehouse_code)
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit) || 100, 500));

  if (status) q = q.eq('transfer_status', status);
  if (from_warehouse_id) q = q.eq('from_warehouse_id', parseInt(from_warehouse_id));
  if (to_warehouse_id) q = q.eq('to_warehouse_id', parseInt(to_warehouse_id));

  const { data, error } = await q;
  if (error) return { success: false, error: error.message };
  return { success: true, transfers: data || [] };
}

// ─── Get transfer by ID ───────────────────────────────────────────────────────

async function getTransferById(supabase, companyId, transferId) {
  const { data, error } = await supabase
    .from('warehouse_transfers')
    .select(`
      *,
      from_warehouses:from_warehouse_id (id, name, warehouse_code),
      to_warehouses:to_warehouse_id (id, name, warehouse_code),
      warehouse_transfer_lines (
        id, item_id, quantity_requested, quantity_shipped, quantity_received,
        from_location_id, to_location_id, notes,
        inventory_items:item_id (id, name, sku, unit, item_type)
      )
    `)
    .eq('id', transferId)
    .eq('company_id', companyId)
    .single();

  if (error || !data) return { success: false, status: 404, error: 'Transfer not found' };
  return { success: true, transfer: data };
}

module.exports = {
  createTransfer,
  approveTransfer,
  shipTransfer,
  receiveTransfer,
  cancelTransfer,
  listTransfers,
  getTransferById,
  getWarehouseStock,
  getWarehouseAvailability,
  upsertStockLocation
};
