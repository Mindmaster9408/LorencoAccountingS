'use strict';

/**
 * salesOrderService — Codebox 09 Sales Order & Demand Engine
 *
 * Sales order lifecycle:
 *   draft → confirmed → allocated → partially_fulfilled → fulfilled
 *                    ↘ cancelled (from any pre-fulfilled state)
 *
 * Stock impact:
 *   Allocation: createReservation(source_type='sales_order') per line
 *   Fulfillment: consumeReservation() + adjustStockTx(OUT) per line
 *   Cancellation: releaseReservation() for all active reservations
 *
 * ATP is calculated dynamically — never cached in the browser.
 */

const reservationService = require('./reservationService');
const { adjustStockTx }  = require('./stockMutationService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseQty(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function nextSONumber(companyId) {
  const ts = Date.now().toString(36).toUpperCase();
  return `SO-${companyId}-${ts}`;
}

async function logStatusChange(supabase, companyId, soId, fromStatus, toStatus, changedBy, notes = null) {
  await supabase.from('sales_order_status_history').insert({
    company_id:  companyId,
    so_id:       soId,
    from_status: fromStatus || null,
    to_status:   toStatus,
    changed_by:  changedBy || null,
    notes:       notes || null,
    created_at:  new Date().toISOString()
  }).catch(err => console.warn('[salesOrderService] status history insert failed:', err.message));
}

// ─── Create sales order ───────────────────────────────────────────────────────

async function createSalesOrder(supabase, companyId, {
  customer_name,
  customer_email   = null,
  customer_phone   = null,
  customer_ref     = null,
  required_date    = null,
  delivery_address = null,
  currency_code    = 'ZAR',
  notes            = null,
  created_by       = null,
  lines            = []
}) {
  if (!customer_name?.trim()) return { success: false, status: 400, error: 'customer_name is required' };
  if (!lines || lines.length === 0) return { success: false, status: 400, error: 'At least one order line is required' };

  // Validate all items belong to this company
  const itemIds = [...new Set(lines.map(l => parseInt(l.item_id)).filter(Boolean))];
  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, sku, unit, sell_price')
    .eq('company_id', companyId)
    .in('id', itemIds);

  const itemMap = new Map((items || []).map(i => [i.id, i]));
  const missing = itemIds.filter(id => !itemMap.has(id));
  if (missing.length > 0) return { success: false, status: 404, error: `Items not found: ${missing.join(', ')}` };

  const now = new Date().toISOString();
  const soNumber = nextSONumber(companyId);

  // Compute total
  let total = 0;
  const lineInserts = lines.map((l, idx) => {
    const item = itemMap.get(parseInt(l.item_id));
    const qty  = parseQty(l.quantity_ordered);
    const price = parseQty(l.unit_price ?? item?.sell_price ?? 0);
    total += qty * price;
    return {
      company_id:         companyId,
      item_id:            parseInt(l.item_id),
      line_number:        idx + 1,
      quantity_ordered:   qty,
      quantity_allocated: 0,
      quantity_fulfilled: 0,
      unit_price:         price,
      required_date:      l.required_date || required_date || null,
      notes:              l.notes || null,
      created_at:         now,
      updated_at:         now
    };
  });

  const { data: so, error: soErr } = await supabase
    .from('sales_orders')
    .insert({
      company_id:       companyId,
      so_number:        soNumber,
      customer_name:    customer_name.trim(),
      customer_email:   customer_email || null,
      customer_phone:   customer_phone || null,
      customer_ref:     customer_ref   || null,
      required_date:    required_date  || null,
      delivery_address: delivery_address || null,
      currency_code:    currency_code || 'ZAR',
      notes:            notes          || null,
      so_status:        'draft',
      total_amount:     parseFloat(total.toFixed(4)),
      created_by:       created_by     || null,
      created_at:       now,
      updated_at:       now
    })
    .select()
    .single();

  if (soErr) return { success: false, status: 500, error: soErr.message };

  // Insert lines
  const insertLines = lineInserts.map(l => ({ ...l, so_id: so.id }));
  const { error: lineErr } = await supabase.from('sales_order_lines').insert(insertLines);
  if (lineErr) {
    await supabase.from('sales_orders').delete().eq('id', so.id);
    return { success: false, status: 500, error: lineErr.message };
  }

  await logStatusChange(supabase, companyId, so.id, null, 'draft', created_by);
  return { success: true, sales_order: so };
}

// ─── Confirm sales order ──────────────────────────────────────────────────────

async function confirmSalesOrder(supabase, companyId, soId, userId) {
  const { data: so } = await supabase
    .from('sales_orders')
    .select('id, so_status')
    .eq('id', soId)
    .eq('company_id', companyId)
    .single();

  if (!so) return { success: false, status: 404, error: 'Sales order not found' };
  if (so.so_status !== 'draft') return { success: false, status: 409, error: `Cannot confirm a ${so.so_status} sales order` };

  const { error } = await supabase
    .from('sales_orders')
    .update({ so_status: 'confirmed', confirmed_by: userId || null, updated_at: new Date().toISOString() })
    .eq('id', soId)
    .eq('company_id', companyId);

  if (error) return { success: false, status: 500, error: error.message };
  await logStatusChange(supabase, companyId, soId, 'draft', 'confirmed', userId);
  return { success: true };
}

// ─── Allocate sales order ─────────────────────────────────────────────────────

/**
 * Attempts to reserve stock for each SO line.
 * Uses reserve_stock() RPC — atomic, row-locked, concurrency-safe.
 * Lines that succeed are marked allocated.
 * Lines that fail (insufficient stock) are logged in errors[].
 * SO status → 'allocated' only if ALL lines are fully allocated.
 */
async function allocateSalesOrder(supabase, companyId, soId, userId) {
  const { data: so } = await supabase
    .from('sales_orders')
    .select('*, sales_order_lines(*)')
    .eq('id', soId)
    .eq('company_id', companyId)
    .single();

  if (!so) return { success: false, status: 404, error: 'Sales order not found' };
  if (!['confirmed', 'draft'].includes(so.so_status)) {
    return { success: false, status: 409, error: `Cannot allocate a ${so.so_status} sales order` };
  }

  const lines = so.sales_order_lines || [];
  if (!lines.length) return { success: false, status: 400, error: 'Sales order has no lines' };

  const allocated = [];
  const errors    = [];
  const now = new Date().toISOString();

  for (const line of lines) {
    if (line.quantity_allocated >= line.quantity_ordered) continue; // already fully allocated

    const remaining = parseQty(line.quantity_ordered) - parseQty(line.quantity_allocated);
    if (remaining <= 0) continue;

    const result = await reservationService.createReservation(supabase, {
      companyId,
      itemId:       line.item_id,
      sourceType:   'sales_order',
      sourceId:     soId,
      sourceLineId: line.id,
      quantity:     remaining,
      reference:    so.so_number,
      reason:       `Sales order ${so.so_number} — customer: ${so.customer_name}`,
      createdBy:    userId || null
    });

    if (!result.success) {
      errors.push({
        line_id:    line.id,
        item_id:    line.item_id,
        error:      result.error,
        available:  result.available,
        requested:  remaining
      });
      continue;
    }

    // Update line with allocated qty and reservation_id
    await supabase
      .from('sales_order_lines')
      .update({
        quantity_allocated: parseQty(line.quantity_allocated) + remaining,
        reservation_id:     result.reservation_id,
        updated_at:         now
      })
      .eq('id', line.id)
      .eq('company_id', companyId);

    allocated.push({ line_id: line.id, item_id: line.item_id, reserved_qty: remaining, reservation_id: result.reservation_id });
  }

  // Refresh lines to recompute status
  const { data: refreshed } = await supabase
    .from('sales_order_lines')
    .select('quantity_ordered, quantity_allocated')
    .eq('so_id', soId)
    .eq('company_id', companyId);

  const allAllocated = (refreshed || []).every(l =>
    parseQty(l.quantity_allocated) >= parseQty(l.quantity_ordered)
  );

  const newStatus = allAllocated ? 'allocated' : (so.so_status === 'draft' ? 'confirmed' : so.so_status);
  await supabase
    .from('sales_orders')
    .update({ so_status: newStatus, updated_at: now })
    .eq('id', soId)
    .eq('company_id', companyId);

  if (newStatus !== so.so_status) {
    await logStatusChange(supabase, companyId, soId, so.so_status, newStatus, userId);
  }

  return { success: allocated.length > 0, allocated, errors, so_status: newStatus };
}

// ─── Fulfill sales order line ─────────────────────────────────────────────────

/**
 * Fulfills a sales order line (or part of it).
 * Consumes the reservation and creates an OUT stock movement.
 * If all lines are fulfilled, SO moves to 'fulfilled'.
 */
async function fulfillSalesOrderLine(supabase, companyId, soId, lineId, qty, userId) {
  const { data: line } = await supabase
    .from('sales_order_lines')
    .select('*')
    .eq('id', lineId)
    .eq('so_id', soId)
    .eq('company_id', companyId)
    .single();

  if (!line) return { success: false, status: 404, error: 'Line not found' };

  const remaining = parseQty(line.quantity_ordered) - parseQty(line.quantity_fulfilled);
  if (remaining <= 0) return { success: false, status: 409, error: 'Line is already fully fulfilled' };

  const fulfillQty = Math.min(parseQty(qty) || remaining, remaining);
  if (fulfillQty <= 0) return { success: false, status: 400, error: 'Quantity must be positive' };

  // Consume reservation if exists
  if (line.reservation_id) {
    const consumeResult = await reservationService.consumeReservation(
      supabase, line.reservation_id, companyId, fulfillQty, userId
    );
    if (!consumeResult.success) {
      return { success: false, status: 500, error: `Reservation consume failed: ${consumeResult.error}` };
    }
  }

  // Create stock OUT movement
  const { data: so } = await supabase
    .from('sales_orders')
    .select('so_number, customer_name')
    .eq('id', soId)
    .single();

  const stockResult = await adjustStockTx(supabase, {
    companyId,
    itemId:       line.item_id,
    delta:        -fulfillQty,
    movementType: 'out',
    reference:    so?.so_number || `SO-${soId}`,
    notes:        `Sales order fulfillment — ${so?.customer_name || ''}`,
    createdBy:    userId || null,
    sourceType:   'sales_order',
    sourceId:     String(soId)
  });

  if (!stockResult.success) {
    return { success: false, status: 422, error: stockResult.error, available: stockResult.available };
  }

  const now = new Date().toISOString();
  const newFulfilled = parseQty(line.quantity_fulfilled) + fulfillQty;
  await supabase
    .from('sales_order_lines')
    .update({ quantity_fulfilled: newFulfilled, updated_at: now })
    .eq('id', lineId)
    .eq('company_id', companyId);

  // Check if entire SO is now fulfilled
  const { data: allLines } = await supabase
    .from('sales_order_lines')
    .select('quantity_ordered, quantity_fulfilled')
    .eq('so_id', soId)
    .eq('company_id', companyId);

  const allFulfilled  = (allLines || []).every(l => parseQty(l.quantity_fulfilled) >= parseQty(l.quantity_ordered));
  const anyFulfilled  = (allLines || []).some(l => parseQty(l.quantity_fulfilled) > 0);

  const { data: curSo } = await supabase.from('sales_orders').select('so_status').eq('id', soId).single();
  const prevStatus = curSo?.so_status || 'allocated';
  const newStatus  = allFulfilled ? 'fulfilled' : (anyFulfilled ? 'partially_fulfilled' : prevStatus);

  const soUpdates = { so_status: newStatus, updated_at: now };
  if (allFulfilled) soUpdates.fulfilled_at = now;

  await supabase.from('sales_orders').update(soUpdates).eq('id', soId).eq('company_id', companyId);
  if (newStatus !== prevStatus) await logStatusChange(supabase, companyId, soId, prevStatus, newStatus, userId);

  return { success: true, fulfilled_qty: fulfillQty, so_status: newStatus };
}

// ─── Cancel sales order ───────────────────────────────────────────────────────

async function cancelSalesOrder(supabase, companyId, soId, userId) {
  const { data: so } = await supabase
    .from('sales_orders')
    .select('id, so_status')
    .eq('id', soId)
    .eq('company_id', companyId)
    .single();

  if (!so) return { success: false, status: 404, error: 'Sales order not found' };
  if (['fulfilled', 'cancelled'].includes(so.so_status)) {
    return { success: false, status: 409, error: `Cannot cancel a ${so.so_status} sales order` };
  }

  // Release all active reservations for this SO
  const { data: reservations } = await supabase
    .from('stock_reservations')
    .select('id, reservation_status')
    .eq('company_id', companyId)
    .eq('source_type', 'sales_order')
    .eq('source_id', soId)
    .in('reservation_status', ['active', 'partially_released']);

  const releaseResults = [];
  for (const res of (reservations || [])) {
    const result = await reservationService.releaseReservation(supabase, res.id, companyId, null, userId);
    releaseResults.push({ reservation_id: res.id, ...result });
  }

  const now = new Date().toISOString();
  await supabase
    .from('sales_orders')
    .update({ so_status: 'cancelled', cancelled_by: userId || null, cancelled_at: now, updated_at: now })
    .eq('id', soId)
    .eq('company_id', companyId);

  await logStatusChange(supabase, companyId, soId, so.so_status, 'cancelled', userId, 'Sales order cancelled — reservations released');

  return { success: true, released_reservations: releaseResults.length };
}

// ─── Get sales order ──────────────────────────────────────────────────────────

async function getSalesOrder(supabase, companyId, soId) {
  const { data, error } = await supabase
    .from('sales_orders')
    .select(`
      *,
      sales_order_lines (
        id, line_number, item_id, quantity_ordered, quantity_allocated,
        quantity_fulfilled, unit_price, line_total, required_date, notes,
        reservation_id,
        inventory_items:item_id (id, name, sku, unit, item_type, current_stock, average_cost)
      ),
      sales_order_status_history (id, from_status, to_status, changed_by, notes, created_at)
    `)
    .eq('id', soId)
    .eq('company_id', companyId)
    .single();

  if (error || !data) return { success: false, status: 404, error: 'Sales order not found' };

  // Sort lines and history
  data.sales_order_lines?.sort((a, b) => a.line_number - b.line_number);
  data.sales_order_status_history?.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return { success: true, sales_order: data };
}

// ─── List sales orders ────────────────────────────────────────────────────────

async function listSalesOrders(supabase, companyId, { status, customer, from_date, to_date, limit = 100 } = {}) {
  let q = supabase
    .from('sales_orders')
    .select(`
      id, so_number, customer_name, customer_ref, so_status,
      required_date, total_amount, created_at, updated_at
    `)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit) || 100, 500));

  if (status)    q = q.eq('so_status', status);
  if (customer)  q = q.ilike('customer_name', `%${customer}%`);
  if (from_date) q = q.gte('created_at', from_date);
  if (to_date)   q = q.lte('created_at', to_date + 'T23:59:59.999Z');

  const { data, error } = await q;
  if (error) return { success: false, error: error.message };
  return { success: true, sales_orders: data || [] };
}

module.exports = {
  createSalesOrder,
  confirmSalesOrder,
  allocateSalesOrder,
  fulfillSalesOrderLine,
  cancelSalesOrder,
  getSalesOrder,
  listSalesOrders
};
