/**
 * ============================================================================
 * POS Inter-Store Transfer + Shrinkage Control Routes — Checkout Charlie
 * (Workstream 85)
 * ============================================================================
 * Forensic inter-store custody and variance system for transfers between two
 * LOCATIONS of the SAME company (Turkstra Factory -> Turkstra Retail Store) —
 * not to be confused with inter-COMPANY transfers (Turkstra -> Pennygrow,
 * Workstream 81, company-transfers.js).
 *
 * REUSE, NOT A PARALLEL ENGINE: both flows share the same underlying tables
 * (pos_company_transfers / pos_company_transfer_items), distinguished by
 * transfer_type. This file only ever writes/reads transfer_type='inter_store'
 * rows; company-transfers.js only ever writes/reads 'inter_company' rows —
 * both are filtered explicitly on every query so they can never bleed into
 * each other's lists.
 *
 * Stock model: since no location-scoped stock existed anywhere in this
 * schema before this workstream (audited — see pos-schema.js), dispatch and
 * receive here mutate the NEW, additive product_location_stock table via
 * adjustLocationStockCAS (below) — not products.stock_quantity, which
 * checkout and every existing report still depend on unchanged. See the
 * Workstream 85 doc for the documented limitation this implies (the two
 * stock concepts are not currently reconciled).
 *
 * Status lifecycle actually implemented (a deliberate simplification of the
 * ticket's suggested list — documented, not silently dropped):
 *   draft -> in_transit -> (partially_received) -> received_complete | received_with_variance -> resolved
 *   draft -> cancelled
 * "Dispatched" and "in transit" are merged into one atomic transition
 * (in_transit) since there is no distinct real-world action between "stock
 * left the source location" and "stock is now in transit" — they are the
 * same event. "Disputed"/investigation is a boolean flag
 * (investigation_required) set during variance resolution, not a separate
 * status, so a received_with_variance transfer's status doesn't have to
 * change again just because a manager is now looking into it.
 *
 * Routes:
 *   GET  /transferable-locations   — locations this user may transfer between (their own assignments only)
 *   POST /                         — create a draft transfer (no stock movement yet)
 *   PUT  /:id/items                — set/replace the draft's item list (source stock existence checked, not decremented)
 *   POST /:id/dispatch              — atomic: lock items, decrement source location stock, status -> in_transit
 *   GET  /outgoing | /incoming | /in-transit
 *   GET  /:id                      — detail (+ blind-receive redaction for the receiver)
 *   POST /:id/receive               — independent count-and-confirm; usable stock increases by accepted qty only
 *   POST /:id/resolve-variance      — management-only; sets resolution once, never edits/deletes
 *   POST /:id/cancel                — draft only
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { getStockPolicy } = require('../services/stockPolicyCache');
const { getAssignedLocationIds } = require('./locations');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

const DISCREPANCY_REASONS = new Set([
  'confirmed_shortage_in_transit', 'source_counting_error', 'destination_counting_error',
  'damaged_in_transit', 'returned_to_source', 'theft_suspected', 'documentation_error', 'other',
]);

function generateTransferNumber() {
  return 'ST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Compare-and-swap stock adjustment against product_location_stock —
 * the same safety pattern as company-transfers.js's adjustStockCAS
 * (read current value, then UPDATE ... WHERE quantity = <value read>, so a
 * concurrent change causes the write to affect zero rows instead of
 * silently overwriting it), applied to the new per-location stock table
 * instead of the company-wide products.stock_quantity.
 */
async function adjustLocationStockCAS(companyId, locationId, productId, delta, { allowNegative = false } = {}) {
  const { data: existing } = await supabase
    .from('product_location_stock')
    .select('id, quantity')
    .eq('company_id', companyId).eq('location_id', locationId).eq('product_id', productId)
    .maybeSingle();

  const oldQty = existing ? parseFloat(existing.quantity || 0) : 0;
  const newQty = oldQty + delta;
  if (delta < 0 && newQty < 0 && !allowNegative) {
    return { ok: false, error: 'insufficient_stock', oldQty };
  }

  if (!existing) {
    if (delta < 0) return { ok: false, error: 'insufficient_stock', oldQty: 0 };
    const { data, error } = await supabase.from('product_location_stock')
      .insert({ company_id: companyId, location_id: locationId, product_id: productId, quantity: newQty })
      .select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, oldQty: 0, newQty, row: data };
  }

  const { data: updated, error } = await supabase
    .from('product_location_stock')
    .update({ quantity: newQty, updated_at: new Date().toISOString() })
    .eq('id', existing.id).eq('quantity', oldQty)
    .select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: 'concurrent_update', oldQty };

  return { ok: true, oldQty, newQty, row: updated };
}

async function getLocationStock(companyId, locationId, productId) {
  const { data } = await supabase.from('product_location_stock').select('quantity')
    .eq('company_id', companyId).eq('location_id', locationId).eq('product_id', productId).maybeSingle();
  return data ? parseFloat(data.quantity || 0) : 0;
}

async function assertLocationAccess(req, locationId, res) {
  const assigned = await getAssignedLocationIds(req.companyId, req.user.userId, req.user.role);
  if (!assigned.includes(locationId)) {
    res.status(403).json({ error: 'You are not assigned to that location' });
    return false;
  }
  return true;
}

// ── GET /transferable-locations ──────────────────────────────────────────
router.get('/transferable-locations', requirePermission('TRANSFERS.CREATE'), async (req, res) => {
  try {
    const ids = await getAssignedLocationIds(req.companyId, req.user.userId, req.user.role);
    if (ids.length === 0) return res.json({ locations: [] });
    const { data } = await supabase.from('locations').select('id, location_name, location_code').eq('company_id', req.companyId).eq('is_active', true).in('id', ids).order('location_name');
    res.json({ locations: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST / — create draft ────────────────────────────────────────────────
router.post('/', requirePermission('TRANSFERS.CREATE'), async (req, res) => {
  try {
    const { source_location_id, destination_location_id, reference, notes, expected_receive_date, transport_reference, transported_by } = req.body;
    const sourceId = parseInt(source_location_id);
    const destId = parseInt(destination_location_id);
    if (!sourceId || !destId) return res.status(400).json({ error: 'source_location_id and destination_location_id are required' });
    if (sourceId === destId) return res.status(400).json({ error: 'Source and destination locations must be different' });

    if (!(await assertLocationAccess(req, sourceId, res))) return;

    const { data: locs } = await supabase.from('locations').select('id').eq('company_id', req.companyId).in('id', [sourceId, destId]);
    if ((locs || []).length !== 2) return res.status(400).json({ error: 'One or both locations were not found for this company' });

    const { data: settings } = await supabase.from('company_settings').select('blind_transfer_receiving').eq('company_id', req.companyId).maybeSingle();

    const { data: transfer, error } = await supabase.from('pos_company_transfers').insert({
      company_id: req.companyId, receiver_company_id: req.companyId, // same company on both sides for inter_store
      transfer_type: 'inter_store', source_location_id: sourceId, destination_location_id: destId,
      transfer_number: generateTransferNumber(), status: 'draft',
      reference: reference || null, notes: notes || null,
      expected_receive_date: expected_receive_date || null,
      transport_reference: transport_reference || null, transported_by: transported_by || null,
      blind_receive: !!(settings && settings.blind_transfer_receiving),
      counted_by_source: req.user.userId,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_CREATED, {
      metadata: { transfer_id: transfer.id, transfer_number: transfer.transfer_number, source_location_id: sourceId, destination_location_id: destId },
    });

    res.json({ transfer });
  } catch (err) {
    console.error('[store-transfers] create:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /:id/items — set the draft's item list ───────────────────────────
router.put('/:id/items', requirePermission('TRANSFERS.CREATE'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'draft') return res.status(400).json({ error: 'Only a draft transfer can have its items changed' });
    if (!(await assertLocationAccess(req, transfer.source_location_id, res))) return;

    const lines = items
      .map(i => ({ product_id: parseInt(i.product_id), quantity: parseInt(i.quantity), notes: i.notes ? String(i.notes).trim() : null }))
      .filter(l => l.product_id > 0 && l.quantity > 0); // zero-quantity rows skipped
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a quantity greater than zero' });

    const productIds = lines.map(l => l.product_id);
    const { data: products } = await supabase.from('products').select('id, product_name, product_code, barcode, cost_price, unit_price').eq('company_id', req.companyId).in('id', productIds);
    const byId = new Map((products || []).map(p => [p.id, p]));
    const missing = productIds.filter(id => !byId.has(id));
    if (missing.length > 0) return res.status(400).json({ error: `Product IDs not found for this company: ${missing.join(', ')}` });

    // Replace the draft's item set (safe pre-dispatch — nothing is locked/immutable yet)
    await supabase.from('pos_company_transfer_items').delete().eq('transfer_id', transferId);

    const rows = [];
    for (const line of lines) {
      const product = byId.get(line.product_id);
      const currentStock = await getLocationStock(req.companyId, transfer.source_location_id, line.product_id);
      rows.push({
        transfer_id: transferId, company_id: req.companyId, product_id: line.product_id,
        product_code: product.product_code || null, barcode: product.barcode || null, description: product.product_name,
        quantity_sent: line.quantity, unit_cost: product.cost_price, selling_price: product.unit_price,
        source_stock_before: currentStock, sender_notes: line.notes,
      });
    }
    const { data: inserted, error } = await supabase.from('pos_company_transfer_items').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
    await supabase.from('pos_company_transfers').update({ item_count: lines.length, total_quantity_sent: totalQty, updated_at: new Date().toISOString() }).eq('id', transferId);

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_ITEM_COUNTED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, item_count: lines.length, total_quantity: totalQty },
    });

    res.json({ items: inserted });
  } catch (err) {
    console.error('[store-transfers] set items:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/dispatch ────────────────────────────────────────────────────
router.post('/:id/dispatch', requirePermission('TRANSFERS.DISPATCH'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const { override } = req.body;

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'draft') return res.status(400).json({ error: `Transfer cannot be dispatched from its current status (${transfer.status})` });
    if (!(await assertLocationAccess(req, transfer.source_location_id, res))) return;

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);
    if (!items || items.length === 0) return res.status(400).json({ error: 'This transfer has no items to dispatch' });

    const allowNegative = await getStockPolicy(req.companyId, supabase);
    const bypassGuard = allowNegative || override === true;

    if (!bypassGuard) {
      const exceeding = [];
      for (const item of items) {
        const stock = await getLocationStock(req.companyId, transfer.source_location_id, item.product_id);
        if (item.quantity_sent > stock) exceeding.push({ product_id: item.product_id, description: item.description, requested: item.quantity_sent, current_stock: stock });
      }
      if (exceeding.length > 0) {
        return res.status(400).json({ error: 'Transfer quantity exceeds current stock at the source location for one or more products', exceeding });
      }
    }

    for (const item of items) {
      const result = await adjustLocationStockCAS(req.companyId, transfer.source_location_id, item.product_id, -item.quantity_sent, { allowNegative: bypassGuard });
      if (result.ok) {
        await supabase.from('pos_company_transfer_items').update({ source_stock_before: result.oldQty, source_stock_after: result.newQty }).eq('id', item.id);
      } else {
        console.error('[store-transfers] dispatch stock decrement failed:', item.product_id, result.error);
      }
    }

    const { data: updated } = await supabase.from('pos_company_transfers').update({
      status: 'in_transit', dispatched_by: req.user.userId, dispatched_at: new Date().toISOString(),
      approved_by_source: req.user.userId, updated_at: new Date().toISOString(),
    }).eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_DISPATCHED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, source_location_id: transfer.source_location_id, destination_location_id: transfer.destination_location_id, item_count: items.length, total_quantity: transfer.total_quantity_sent },
    });

    res.json({ transfer: updated });
  } catch (err) {
    console.error('[store-transfers] dispatch:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /outgoing | /incoming | /in-transit ──────────────────────────────
async function listTransfers(req, res, { locationField, statuses }) {
  try {
    const assigned = await getAssignedLocationIds(req.companyId, req.user.userId, req.user.role);
    if (assigned.length === 0) return res.json({ transfers: [] });

    let query = supabase.from('pos_company_transfers').select('*')
      .eq('company_id', req.companyId).eq('transfer_type', 'inter_store')
      .in(locationField, assigned);
    if (statuses) query = query.in('status', statuses);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: error.message });

    const locIds = [...new Set((data || []).flatMap(t => [t.source_location_id, t.destination_location_id]))];
    const { data: locs } = await supabase.from('locations').select('id, location_name').in('id', locIds);
    const locNames = Object.fromEntries((locs || []).map(l => [l.id, l.location_name]));

    res.json({ transfers: (data || []).map(t => ({ ...t, source_location_name: locNames[t.source_location_id], destination_location_name: locNames[t.destination_location_id] })) });
  } catch (err) {
    console.error('[store-transfers] list:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

router.get('/outgoing', requirePermission('TRANSFERS.VIEW_REPORTS'), (req, res) => listTransfers(req, res, { locationField: 'source_location_id' }));
router.get('/incoming', requirePermission('TRANSFERS.VIEW_REPORTS'), (req, res) => listTransfers(req, res, { locationField: 'destination_location_id' }));
router.get('/in-transit', requirePermission('TRANSFERS.VIEW_REPORTS'), (req, res) => listTransfers(req, res, { locationField: 'destination_location_id', statuses: ['in_transit', 'partially_received'] }));

// ── GET /:id — detail (+ blind-receive redaction) ────────────────────────
router.get('/:id', requirePermission('TRANSFERS.VIEW_REPORTS'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    const assigned = await getAssignedLocationIds(req.companyId, req.user.userId, req.user.role);
    const isDestinationViewer = assigned.includes(transfer.destination_location_id);
    const isSourceViewer = assigned.includes(transfer.source_location_id);
    if (!isDestinationViewer && !isSourceViewer) return res.status(403).json({ error: 'Not authorized for this transfer' });

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId).order('id');
    const { data: locs } = await supabase.from('locations').select('id, location_name').in('id', [transfer.source_location_id, transfer.destination_location_id]);
    const locNames = Object.fromEntries((locs || []).map(l => [l.id, l.location_name]));

    // Blind receive: hide quantity_sent from a destination-only viewer until
    // the transfer has moved past in_transit (i.e. a count has been submitted).
    const hideSentQty = transfer.blind_receive && isDestinationViewer && !isSourceViewer && transfer.status === 'in_transit';
    const shapedItems = (items || []).map(i => hideSentQty ? { ...i, quantity_sent: null } : i);

    const { data: discrepancies } = await supabase.from('pos_transfer_discrepancies').select('*').eq('transfer_id', transferId).order('flagged_at', { ascending: false });

    res.json({
      transfer: { ...transfer, source_location_name: locNames[transfer.source_location_id], destination_location_name: locNames[transfer.destination_location_id] },
      items: shapedItems,
      discrepancies: discrepancies || [],
      blind_receive_active: hideSentQty,
    });
  } catch (err) {
    console.error('[store-transfers] detail:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/receive ──────────────────────────────────────────────────
router.post('/:id/receive', requirePermission('TRANSFERS.RECEIVE'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!['in_transit', 'partially_received'].includes(transfer.status)) {
      return res.status(400).json({ error: `Transfer cannot be received in its current status (${transfer.status})` });
    }
    if (!(await assertLocationAccess(req, transfer.destination_location_id, res))) return;

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_RECEIVE_STARTED, { metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number } });

    const { data: allItems } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);
    const itemsById = new Map((allItems || []).map(i => [i.id, i]));

    const lines = items.map(i => ({
      item_id: parseInt(i.item_id),
      quantity_received: parseInt(i.quantity_received) || 0,
      quantity_damaged: parseInt(i.quantity_damaged) || 0,
      quantity_rejected: parseInt(i.quantity_rejected) || 0,
      notes: i.notes ? String(i.notes).trim() : null,
    })).filter(l => l.item_id > 0 && (l.quantity_received > 0 || l.quantity_damaged > 0 || l.quantity_rejected > 0));
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a received/damaged/rejected quantity greater than zero' });

    // Idempotency: each line's total (received+damaged+rejected) is checked
    // against what's still outstanding on the item at the moment of writing —
    // a resubmitted duplicate request would find less (or zero) outstanding
    // remaining and be rejected here rather than double-crediting stock.
    const overClaims = [];
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      if (!item || item.transfer_id !== transferId) { overClaims.push({ item_id: line.item_id, reason: 'item not found on this transfer' }); continue; }
      const alreadyAccounted = item.quantity_received + item.quantity_damaged + item.quantity_rejected;
      const outstanding = item.quantity_sent - alreadyAccounted;
      const claiming = line.quantity_received + line.quantity_damaged + line.quantity_rejected;
      if (claiming > outstanding) overClaims.push({ item_id: line.item_id, description: item.description, reason: `cannot account for more than the ${outstanding} unit(s) still outstanding`, outstanding });
    }
    if (overClaims.length > 0) return res.status(400).json({ error: 'One or more lines exceed the outstanding quantity for this transfer', overClaims });

    const processed = [];
    let anyDamage = false;
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      let stockResult = { ok: true, oldQty: null, newQty: null };
      if (line.quantity_received > 0) {
        stockResult = await adjustLocationStockCAS(req.companyId, transfer.destination_location_id, item.product_id, line.quantity_received, {});
      }
      if (line.quantity_damaged > 0) anyDamage = true;

      const newReceived = item.quantity_received + line.quantity_received;
      const newDamaged = item.quantity_damaged + line.quantity_damaged;
      const newRejected = item.quantity_rejected + line.quantity_rejected;
      await supabase.from('pos_company_transfer_items').update({
        quantity_received: newReceived, quantity_damaged: newDamaged, quantity_rejected: newRejected,
        destination_stock_before: stockResult.oldQty, destination_stock_after: stockResult.newQty,
        receiver_notes: line.notes ? `${item.receiver_notes ? item.receiver_notes + ' | ' : ''}${line.notes}` : item.receiver_notes,
      }).eq('id', item.id);

      if (stockResult.ok && line.quantity_received > 0) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: item.product_id, adjusted_by: req.user.userId,
          quantity_before: stockResult.oldQty, quantity_change: line.quantity_received, quantity_after: stockResult.newQty,
          reason: 'store_transfer_received', notes: `Transfer ${transfer.transfer_number} from location #${transfer.source_location_id}`,
        });
      }

      processed.push({ item_id: item.id, quantity_received: line.quantity_received, quantity_damaged: line.quantity_damaged, quantity_rejected: line.quantity_rejected, stock_updated: stockResult.ok });
    }

    if (anyDamage) {
      posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_DAMAGE_RECORDED, { metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number } });
    }

    const { data: refreshedItems } = await supabase.from('pos_company_transfer_items').select('quantity_sent, quantity_received, quantity_damaged, quantity_rejected').eq('transfer_id', transferId);
    const totalOutstanding = (refreshedItems || []).reduce((s, i) => s + (i.quantity_sent - i.quantity_received - i.quantity_damaged - i.quantity_rejected), 0);
    const totalReceived = (refreshedItems || []).reduce((s, i) => s + i.quantity_received, 0);
    const totalDamaged = (refreshedItems || []).reduce((s, i) => s + i.quantity_damaged, 0);
    const totalRejected = (refreshedItems || []).reduce((s, i) => s + i.quantity_rejected, 0);
    const totalSent = (refreshedItems || []).reduce((s, i) => s + i.quantity_sent, 0);
    // Unexplained variance = sent minus everything accounted for (received + damaged + rejected).
    // Damage/rejection are explained losses, not "unexplained shortage" — matching the
    // ticket's "sent 100, received 96 + damaged 4 -> no unexplained shortage" example exactly.
    const totalVariance = totalSent - totalReceived - totalDamaged - totalRejected;

    let newStatus;
    if (totalOutstanding > 0) newStatus = 'partially_received';
    else newStatus = totalVariance === 0 ? 'received_complete' : 'received_with_variance';

    const { data: updated } = await supabase.from('pos_company_transfers').update({
      status: newStatus, received_by: req.user.userId, received_at: new Date().toISOString(),
      counted_by_destination: req.user.userId, approved_by_destination: totalOutstanding === 0 ? req.user.userId : null,
      total_received: totalReceived, total_damaged: totalDamaged, total_rejected: totalRejected, total_variance: totalVariance,
      notes: notes ? `${transfer.notes ? transfer.notes + ' | ' : ''}Receive note: ${notes}` : transfer.notes,
      updated_at: new Date().toISOString(),
    }).eq('id', transferId).select().single();

    posAuditFromReq(req, newStatus === 'partially_received' ? POS_EVENTS.STORE_TRANSFER_PARTIALLY_RECEIVED : POS_EVENTS.STORE_TRANSFER_RECEIVED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, total_received: totalReceived, total_variance: totalVariance },
    });

    // Discrepancy record — only once the transfer is fully accounted for and
    // there's something unexplained left over. Append-only: never edited,
    // only "resolved" via a separate action below.
    if (newStatus === 'received_with_variance' && totalVariance !== 0) {
      await supabase.from('pos_transfer_discrepancies').insert({
        company_id: req.companyId, transfer_id: transferId,
        discrepancy_type: totalVariance < 0 ? 'shortage' : 'overage',
        variance_quantity: totalVariance, flagged_by: req.user.userId,
      });
      posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_VARIANCE_DETECTED, {
        metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, variance: totalVariance, type: totalVariance < 0 ? 'shortage' : 'overage' },
      });
    }

    res.json({ transfer: updated, items: processed });
  } catch (err) {
    console.error('[store-transfers] receive:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/resolve-variance ───────────────────────────────────────────
// Management-only (TRANSFERS.RESOLVE_VARIANCE is a stricter tier than
// CREATE/DISPATCH/RECEIVE) — the ticket's rule that dispatching and
// resolving one's own discrepancy shouldn't normally be the same person is
// enforced by this permission tier, not a same-user runtime check.
router.post('/:id/resolve-variance', requirePermission('TRANSFERS.RESOLVE_VARIANCE'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const discrepancyId = parseInt(req.body.discrepancy_id);
    const reason = req.body.resolution_reason;
    const notes = (req.body.resolution_notes || '').trim();
    if (!discrepancyId) return res.status(400).json({ error: 'discrepancy_id is required' });
    if (!DISCREPANCY_REASONS.has(reason)) return res.status(400).json({ error: `resolution_reason must be one of: ${[...DISCREPANCY_REASONS].join(', ')}` });
    if (!notes) return res.status(400).json({ error: 'resolution_notes is required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    const { data: disc } = await supabase.from('pos_transfer_discrepancies').select('*').eq('id', discrepancyId).eq('transfer_id', transferId).single();
    if (!disc) return res.status(404).json({ error: 'Discrepancy not found' });
    if (disc.resolution_reason) return res.status(400).json({ error: 'This discrepancy has already been resolved and cannot be re-resolved' });

    const investigationRequired = reason === 'theft_suspected';

    const { data: updatedDisc, error } = await supabase.from('pos_transfer_discrepancies').update({
      resolution_reason: reason, resolution_notes: notes, resolved_by: req.user.userId, resolved_at: new Date().toISOString(),
      investigation_required: investigationRequired,
    }).eq('id', discrepancyId).select().single();
    if (error) return res.status(500).json({ error: error.message });

    const transferUpdates = { resolved_by: req.user.userId, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (investigationRequired) transferUpdates.investigation_required = true;
    if (transfer.status === 'received_with_variance') transferUpdates.status = 'resolved';
    await supabase.from('pos_company_transfers').update(transferUpdates).eq('id', transferId);

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_VARIANCE_RESOLVED, {
      metadata: { transfer_id: transferId, discrepancy_id: discrepancyId, resolution_reason: reason },
    });
    if (investigationRequired) {
      // Investigation flag only, per the ticket's explicit rule: preserve
      // all audit evidence, never make an automated accusation. Nothing
      // here names or blames anyone — it only marks the transfer for
      // manual follow-up and preserves everything already recorded.
      posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_INVESTIGATION_FLAGGED, {
        metadata: { transfer_id: transferId, discrepancy_id: discrepancyId },
      });
    }

    res.json({ discrepancy: updatedDisc });
  } catch (err) {
    console.error('[store-transfers] resolve-variance:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/cancel ──────────────────────────────────────────────────────
router.post('/:id/cancel', requirePermission('TRANSFERS.DISPATCH'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).eq('company_id', req.companyId).eq('transfer_type', 'inter_store').single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'draft') return res.status(400).json({ error: 'Only a draft transfer can be cancelled (nothing has been dispatched yet)' });

    const { data: updated } = await supabase.from('pos_company_transfers').update({ status: 'cancelled', cancelled_by: req.user.userId, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.STORE_TRANSFER_CANCELLED, { metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number } });

    res.json({ transfer: updated });
  } catch (err) {
    console.error('[store-transfers] cancel:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
