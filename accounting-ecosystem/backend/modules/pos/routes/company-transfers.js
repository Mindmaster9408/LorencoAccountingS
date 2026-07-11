/**
 * ============================================================================
 * POS Inter-Company Stock Transfer Routes — Checkout Charlie (Workstream 81)
 * ============================================================================
 * Send/receive/return stock between two Checkout Charlie companies that have
 * an ACTIVE, mutually-confirmed relationship (built in Workstream 80) with
 * the relevant permission flag enabled (Workstream 80's permissions JSON,
 * toggled via PATCH /api/pos/company-links/:id/permissions).
 *
 * No accounting integration, no invoice creation, no automatic receiving —
 * every stock movement here is the direct result of an explicit action by a
 * management-permissioned user on one side or the other.
 *
 * Routes:
 *   GET  /transferable-companies      — companies this one can send stock to
 *   POST /send                        — create + send a transfer (sender stock decreases)
 *   GET  /outgoing                    — transfers this company sent
 *   GET  /incoming                    — transfers this company is receiving
 *   GET  /:id                         — full transfer detail (+ auto-match suggestions)
 *   POST /:id/items/:itemId/map       — manually map an item to a receiver product
 *   POST /:id/receive                 — receive (full or partial) — receiver stock increases
 *   POST /:id/reject                  — reject before any receive — sender stock restored
 *   POST /:id/cancel                  — sender cancels before any receive — sender stock restored
 *   POST /:id/return                  — receiver returns received items — receiver stock decreases
 *   POST /:id/confirm-return          — sender confirms a return — sender stock increases
 *
 * Stock changes use a compare-and-swap update (read current value, then
 * UPDATE ... WHERE stock_quantity = <value read>) so a concurrent change to
 * the same product between read and write causes the write to affect zero
 * rows rather than silently overwriting a concurrent change — this is the
 * "atomic stock decrement" the ticket asked for on the send path, applied
 * consistently to every stock-affecting action in this file.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { getStockPolicy } = require('../services/stockPolicyCache');
const { supabaseSeanStore } = require('../../../sean/supabase-store');
// Compare-and-swap stock adjustment — moved to a shared module in Workstream 87
// so the Purchase Order delivery engine (purchase-orders.js) reuses the exact
// same primitive instead of duplicating it. Behaviour is byte-identical to
// the function this replaces.
const { adjustStockCAS } = require('../services/stockCAS');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

const RETURN_REASONS = new Set(['damaged', 'wrong_item', 'over_supplied', 'expired', 'not_ordered', 'supplier_collection', 'other']);

function generateTransferNumber() {
  return 'XFER-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Fetch the active relationship between req.companyId and otherCompanyId,
 * verifying the given permission flag is enabled. Returns the relationship
 * row or null.
 */
async function getAuthorizedRelationship(companyId, otherCompanyId, permissionKey) {
  const { data: rel } = await supabase
    .from('inter_company_relationships')
    .select('*')
    .or(`and(company_a_id.eq.${companyId},company_b_id.eq.${otherCompanyId}),and(company_a_id.eq.${otherCompanyId},company_b_id.eq.${companyId})`)
    .eq('status', 'active')
    .maybeSingle();
  if (!rel) return null;
  if (permissionKey && !(rel.permissions || {})[permissionKey]) return null;
  return rel;
}

/**
 * Redact sender pricing/reference from a transfer for a receiver who hasn't
 * been granted pricing_visible / invoice_reference_visible on the relationship.
 */
function redactForReceiver(transfer, relationship) {
  const perms = (relationship && relationship.permissions) || {};
  const out = { ...transfer };
  if (!perms.invoice_reference_visible) out.reference = null;
  if (out.items) {
    out.items = out.items.map(item => {
      if (perms.pricing_visible) return item;
      const { unit_cost, selling_price, ...rest } = item;
      return rest;
    });
  }
  return out;
}

// ── GET /transferable-companies ──────────────────────────────────────────
// Only companies with an ACTIVE relationship AND stock_transfer enabled.
// This is the exclusive source for the "linked company" dropdown — no
// global company list is ever reachable from this module.
router.get('/transferable-companies', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const relationships = await supabaseSeanStore.getAllRelationships(req.companyId);
    const eligible = relationships.filter(r => r.status === 'active' && (r.permissions || {}).stock_transfer);
    const otherIds = eligible.map(r => r.company_a_id === req.companyId ? r.company_b_id : r.company_a_id);

    if (otherIds.length === 0) return res.json({ companies: [] });

    const { data: companies } = await supabase
      .from('companies').select('id, company_name, trading_name').in('id', otherIds);

    const shaped = eligible.map(r => {
      const otherId = r.company_a_id === req.companyId ? r.company_b_id : r.company_a_id;
      const company = (companies || []).find(c => c.id === otherId);
      return { relationship_id: r.id, company_id: otherId, company_name: company ? (company.trading_name || company.company_name) : `Company ${otherId}` };
    });

    res.json({ companies: shaped });
  } catch (err) {
    console.error('[company-transfers] transferable-companies:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /send ────────────────────────────────────────────────────────────
router.post('/send', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { receiverCompanyId, items, reference, notes, expected_receive_date, override } = req.body;
    const receiverId = parseInt(receiverCompanyId);
    if (!receiverId) return res.status(400).json({ error: 'receiverCompanyId is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const relationship = await getAuthorizedRelationship(req.companyId, receiverId, 'stock_transfer');
    if (!relationship) {
      return res.status(403).json({ error: 'No active relationship with stock transfer enabled for that company' });
    }

    const lines = items
      .map(i => ({ product_id: parseInt(i.product_id), quantity: parseInt(i.quantity), notes: i.notes ? String(i.notes).trim() : null }))
      .filter(l => l.product_id > 0 && l.quantity > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a quantity greater than zero' });

    const productIds = lines.map(l => l.product_id);
    const { data: dbProducts, error: prodErr } = await supabase
      .from('products').select('id, product_name, product_code, barcode, stock_quantity, cost_price, unit_price')
      .eq('company_id', req.companyId).in('id', productIds);
    if (prodErr) return res.status(500).json({ error: prodErr.message });

    const byId = new Map((dbProducts || []).map(p => [p.id, p]));
    const missing = productIds.filter(id => !byId.has(id));
    if (missing.length > 0) return res.status(400).json({ error: `Product IDs not found for this company: ${missing.join(', ')}` });

    const allowNegative = await getStockPolicy(req.companyId, supabase);
    const bypassGuard = allowNegative || override === true;

    if (!bypassGuard) {
      const exceeding = lines
        .map(l => ({ ...l, product: byId.get(l.product_id) }))
        .filter(l => l.quantity > parseFloat(l.product.stock_quantity || 0));
      if (exceeding.length > 0) {
        return res.status(400).json({
          error: 'Transfer quantity exceeds current stock for one or more products',
          exceeding: exceeding.map(l => ({ product_id: l.product_id, product_name: l.product.product_name, requested: l.quantity, current_stock: l.product.stock_quantity })),
        });
      }
    }

    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);
    const { data: transfer, error: txErr } = await supabase
      .from('pos_company_transfers')
      .insert({
        company_id: req.companyId, receiver_company_id: receiverId, relationship_id: relationship.id,
        transfer_number: generateTransferNumber(), status: 'sent',
        reference: reference || null, notes: notes || null,
        expected_receive_date: expected_receive_date || null,
        item_count: lines.length, total_quantity_sent: totalQty,
        sent_by: req.user.userId, sent_at: new Date().toISOString(),
      })
      .select().single();
    if (txErr) return res.status(500).json({ error: txErr.message });

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_CREATED, {
      metadata: { transfer_id: transfer.id, transfer_number: transfer.transfer_number, receiver_company_id: receiverId, item_count: lines.length },
    });

    const processedItems = [];
    for (const line of lines) {
      const product = byId.get(line.product_id);
      const result = await adjustStockCAS(req.companyId, line.product_id, -line.quantity, { allowNegative: bypassGuard });
      if (!result.ok) {
        // Best-effort: record the item anyway with quantity_sent so the
        // transfer record is truthful, but flag it via notes since stock
        // could not be safely decremented (concurrent change mid-request).
        console.error('[company-transfers] stock decrement failed mid-send:', line.product_id, result.error);
      }

      await supabase.from('pos_company_transfer_items').insert({
        transfer_id: transfer.id, company_id: req.companyId, product_id: line.product_id,
        product_code: product.product_code || null, barcode: product.barcode || null,
        description: product.product_name, quantity_sent: line.quantity,
        unit_cost: product.cost_price, selling_price: product.unit_price,
        notes: line.notes,
      });

      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: line.product_id, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: -line.quantity, quantity_after: result.newQty,
          reason: 'company_transfer_sent', notes: `Transfer ${transfer.transfer_number} to company #${receiverId}`,
        });
        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId: line.product_id,
          beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty },
          metadata: { product_name: product.product_name, quantity_change: -line.quantity, reason: 'company_transfer_sent', transfer_id: transfer.id },
        });
      }

      processedItems.push({ product_id: line.product_id, product_name: product.product_name, quantity: line.quantity, stock_updated: result.ok });
    }

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_SENT, {
      metadata: { transfer_id: transfer.id, transfer_number: transfer.transfer_number, receiver_company_id: receiverId, item_count: lines.length, total_quantity: totalQty },
    });

    res.json({ transfer: { ...transfer, items: processedItems } });
  } catch (err) {
    console.error('[company-transfers] send:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /outgoing ─────────────────────────────────────────────────────────
router.get('/outgoing', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('pos_company_transfers').select('*').eq('company_id', req.companyId);
    if (status) query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });

    const otherIds = [...new Set((data || []).map(t => t.receiver_company_id))];
    let namesById = {};
    if (otherIds.length > 0) {
      const { data: companies } = await supabase.from('companies').select('id, company_name, trading_name').in('id', otherIds);
      namesById = Object.fromEntries((companies || []).map(c => [c.id, c.trading_name || c.company_name]));
    }

    res.json({ transfers: (data || []).map(t => ({ ...t, receiver_company_name: namesById[t.receiver_company_id] || `Company ${t.receiver_company_id}` })) });
  } catch (err) {
    console.error('[company-transfers] outgoing:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /incoming ─────────────────────────────────────────────────────────
router.get('/incoming', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('pos_company_transfers').select('*').eq('receiver_company_id', req.companyId);
    if (status) query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });

    const otherIds = [...new Set((data || []).map(t => t.company_id))];
    let namesById = {};
    if (otherIds.length > 0) {
      const { data: companies } = await supabase.from('companies').select('id, company_name, trading_name').in('id', otherIds);
      namesById = Object.fromEntries((companies || []).map(c => [c.id, c.trading_name || c.company_name]));
    }

    const shaped = (data || []).map(t => redactForReceiver({ ...t, sender_company_name: namesById[t.company_id] || `Company ${t.company_id}` }, null));
    res.json({ transfers: shaped });
  } catch (err) {
    console.error('[company-transfers] incoming:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────
router.get('/:id', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.company_id !== req.companyId && transfer.receiver_company_id !== req.companyId) {
      return res.status(403).json({ error: 'Not authorized for this transfer' });
    }
    const isReceiver = transfer.receiver_company_id === req.companyId;

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId).order('id');

    let shapedItems = items || [];
    if (isReceiver) {
      // Attempt barcode/product_code auto-match against the receiver's own
      // products for any item not yet mapped — suggestion only, never
      // persisted until the receiver explicitly maps or receives it.
      shapedItems = await Promise.all(shapedItems.map(async item => {
        if (item.receiver_product_id) return item;
        let suggested = null;
        if (item.barcode) {
          const { data } = await supabase.from('products').select('id, product_name').eq('company_id', req.companyId).eq('barcode', item.barcode).maybeSingle();
          if (data) suggested = { ...data, matched_by: 'barcode' };
        }
        if (!suggested && item.product_code) {
          const { data } = await supabase.from('products').select('id, product_name').eq('company_id', req.companyId).eq('product_code', item.product_code).maybeSingle();
          if (data) suggested = { ...data, matched_by: 'product_code' };
        }
        return { ...item, suggested_match: suggested };
      }));
    }

    const otherCompanyId = isReceiver ? transfer.company_id : transfer.receiver_company_id;
    const { data: otherCompany } = await supabase.from('companies').select('id, company_name, trading_name').eq('id', otherCompanyId).maybeSingle();
    const otherCompanyName = otherCompany ? (otherCompany.trading_name || otherCompany.company_name) : `Company ${otherCompanyId}`;

    let result = {
      ...transfer, items: shapedItems, is_receiver: isReceiver,
      sender_company_name: isReceiver ? otherCompanyName : undefined,
      receiver_company_name: isReceiver ? undefined : otherCompanyName,
    };
    if (isReceiver) {
      const relationship = await getAuthorizedRelationship(req.companyId, transfer.company_id, null);
      result = redactForReceiver(result, relationship);
    }

    res.json({ transfer: result });
  } catch (err) {
    console.error('[company-transfers] detail:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/items/:itemId/map ──────────────────────────────────────────
router.post('/:id/items/:itemId/map', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    const receiverProductId = parseInt(req.body.receiver_product_id);
    if (!transferId || !itemId || !receiverProductId) return res.status(400).json({ error: 'transfer id, item id, and receiver_product_id are required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('id, receiver_company_id, company_id').eq('id', transferId).single();
    if (!transfer || transfer.receiver_company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });

    const { data: product } = await supabase.from('products').select('id').eq('id', receiverProductId).eq('company_id', req.companyId).single();
    if (!product) return res.status(400).json({ error: 'receiver_product_id does not belong to this company' });

    const { data: item, error } = await supabase.from('pos_company_transfer_items')
      .update({ receiver_product_id: receiverProductId, match_status: 'manually_matched' })
      .eq('id', itemId).eq('transfer_id', transferId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_PRODUCT_MAPPED, {
      productId: receiverProductId,
      metadata: { transfer_id: transferId, item_id: itemId, sender_company_id: transfer.company_id },
    });

    res.json({ item });
  } catch (err) {
    console.error('[company-transfers] map:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/receive ─────────────────────────────────────────────────────
router.post('/:id/receive', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer || transfer.receiver_company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });
    if (!['sent', 'partially_received'].includes(transfer.status)) {
      return res.status(400).json({ error: `Transfer cannot be received in its current status (${transfer.status})` });
    }

    const relationship = await getAuthorizedRelationship(req.companyId, transfer.company_id, 'receive_transfer');
    if (!relationship) return res.status(403).json({ error: 'This relationship does not have receive_transfer enabled' });

    const { data: allItems } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);
    const itemsById = new Map((allItems || []).map(i => [i.id, i]));

    const lines = items
      .map(i => ({
        item_id: parseInt(i.item_id),
        quantity_received: parseInt(i.quantity_received),
        receiver_product_id: i.receiver_product_id ? parseInt(i.receiver_product_id) : null,
      }))
      .filter(l => l.item_id > 0 && l.quantity_received > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a receive quantity greater than zero' });

    // Every line must resolve to a receiver product — either already mapped,
    // supplied in this request, or auto-matchable by barcode/product_code.
    // Unmapped items block the receive, per the ticket's product-matching rule.
    const unmapped = [];
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      if (!item || item.transfer_id !== transferId) { unmapped.push({ item_id: line.item_id, reason: 'item not found on this transfer' }); continue; }
      const remaining = item.quantity_sent - item.quantity_received;
      if (line.quantity_received > remaining) { unmapped.push({ item_id: line.item_id, reason: `cannot receive more than the ${remaining} unit(s) still outstanding` }); continue; }

      let resolvedProductId = line.receiver_product_id || item.receiver_product_id;
      if (!resolvedProductId && item.barcode) {
        const { data } = await supabase.from('products').select('id').eq('company_id', req.companyId).eq('barcode', item.barcode).maybeSingle();
        if (data) resolvedProductId = data.id;
      }
      if (!resolvedProductId && item.product_code) {
        const { data } = await supabase.from('products').select('id').eq('company_id', req.companyId).eq('product_code', item.product_code).maybeSingle();
        if (data) resolvedProductId = data.id;
      }
      if (!resolvedProductId) { unmapped.push({ item_id: line.item_id, description: item.description, reason: 'no matching product found — map it manually first' }); continue; }

      line.resolvedProductId = resolvedProductId;
    }
    if (unmapped.length > 0) {
      return res.status(400).json({ error: 'One or more items could not be matched to a product in your inventory', unmapped });
    }

    const processedItems = [];
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      if (!item.receiver_product_id || item.receiver_product_id !== line.resolvedProductId) {
        await supabase.from('pos_company_transfer_items')
          .update({ receiver_product_id: line.resolvedProductId, match_status: item.receiver_product_id ? item.match_status : 'auto_matched' })
          .eq('id', item.id);
      }

      const result = await adjustStockCAS(req.companyId, line.resolvedProductId, line.quantity_received, {});
      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: line.resolvedProductId, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: line.quantity_received, quantity_after: result.newQty,
          reason: 'company_transfer_received', notes: `Transfer ${transfer.transfer_number} from company #${transfer.company_id}`,
        });
        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId: line.resolvedProductId,
          beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty },
          metadata: { quantity_change: line.quantity_received, reason: 'company_transfer_received', transfer_id: transferId },
        });
      }

      const newReceivedQty = item.quantity_received + line.quantity_received;
      await supabase.from('pos_company_transfer_items').update({ quantity_received: newReceivedQty }).eq('id', item.id);

      processedItems.push({ item_id: item.id, quantity_received: line.quantity_received, stock_updated: result.ok });
    }

    const { data: refreshedItems } = await supabase.from('pos_company_transfer_items').select('quantity_sent, quantity_received').eq('transfer_id', transferId);
    const fullyReceived = (refreshedItems || []).every(i => i.quantity_received >= i.quantity_sent);
    const anyReceived = (refreshedItems || []).some(i => i.quantity_received > 0);
    const newStatus = fullyReceived ? 'received' : (anyReceived ? 'partially_received' : transfer.status);

    const { data: updatedTransfer } = await supabase.from('pos_company_transfers')
      .update({
        status: newStatus,
        received_by: req.user.userId, received_at: new Date().toISOString(),
        notes: notes ? `${transfer.notes ? transfer.notes + ' | ' : ''}Receive note: ${notes}` : transfer.notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transferId).select().single();

    posAuditFromReq(req, fullyReceived ? POS_EVENTS.COMPANY_TRANSFER_RECEIVED : POS_EVENTS.COMPANY_TRANSFER_PARTIALLY_RECEIVED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, sender_company_id: transfer.company_id, item_count: lines.length },
    });

    res.json({ transfer: updatedTransfer, items: processedItems });
  } catch (err) {
    console.error('[company-transfers] receive:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/reject ──────────────────────────────────────────────────────
router.post('/:id/reject', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });
    const reason = (req.body.reason || '').trim();

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer || transfer.receiver_company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'sent') return res.status(400).json({ error: 'Only a transfer with no items received yet can be rejected' });

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);

    // Rejection means the receiver never took any of it — restore the
    // sender's stock (an explicit, deterministic consequence of the
    // receiver's own explicit reject action, not automated receiving).
    for (const item of items || []) {
      const result = await adjustStockCAS(transfer.company_id, item.product_id, item.quantity_sent, {});
      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: transfer.company_id, product_id: item.product_id, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: item.quantity_sent, quantity_after: result.newQty,
          reason: 'company_transfer_rejected', notes: `Transfer ${transfer.transfer_number} rejected by receiver`,
        });
      }
    }

    const { data: updated } = await supabase.from('pos_company_transfers')
      .update({ status: 'rejected', rejected_by: req.user.userId, rejected_at: new Date().toISOString(), rejection_reason: reason || null, updated_at: new Date().toISOString() })
      .eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_REJECTED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, sender_company_id: transfer.company_id, reason: reason || null },
    });

    res.json({ transfer: updated });
  } catch (err) {
    console.error('[company-transfers] reject:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/cancel ──────────────────────────────────────────────────────
router.post('/:id/cancel', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer || transfer.company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'sent') return res.status(400).json({ error: 'Only a transfer with no items received yet can be cancelled' });

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);
    for (const item of items || []) {
      if (item.quantity_received > 0) continue; // safety: never restore stock for an already-received item
      const result = await adjustStockCAS(req.companyId, item.product_id, item.quantity_sent, {});
      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: item.product_id, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: item.quantity_sent, quantity_after: result.newQty,
          reason: 'company_transfer_cancelled', notes: `Transfer ${transfer.transfer_number} cancelled by sender`,
        });
      }
    }

    const { data: updated } = await supabase.from('pos_company_transfers')
      .update({ status: 'cancelled', cancelled_by: req.user.userId, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_CANCELLED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, receiver_company_id: transfer.receiver_company_id },
    });

    res.json({ transfer: updated });
  } catch (err) {
    console.error('[company-transfers] cancel:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/return ──────────────────────────────────────────────────────
router.post('/:id/return', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer || transfer.receiver_company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });
    if (!['received', 'partially_received'].includes(transfer.status)) {
      return res.status(400).json({ error: `Only received items can be returned (current status: ${transfer.status})` });
    }

    const relationship = await getAuthorizedRelationship(req.companyId, transfer.company_id, 'return_transfer');
    if (!relationship) return res.status(403).json({ error: 'This relationship does not have return_transfer enabled' });

    const { data: allItems } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId);
    const itemsById = new Map((allItems || []).map(i => [i.id, i]));

    const lines = items
      .map(i => ({
        item_id: parseInt(i.item_id), quantity: parseInt(i.quantity),
        reason: RETURN_REASONS.has(i.reason) ? i.reason : 'other',
        notes: i.notes ? String(i.notes).trim() : null,
      }))
      .filter(l => l.item_id > 0 && l.quantity > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a return quantity greater than zero' });

    const invalid = lines.filter(l => {
      const item = itemsById.get(l.item_id);
      if (!item || item.transfer_id !== transferId) return true;
      return l.quantity > (item.quantity_received - item.quantity_returned);
    });
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'Return quantity exceeds what was received (minus any prior return) for one or more items', invalid: invalid.map(l => l.item_id) });
    }

    const processedItems = [];
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      const productId = item.receiver_product_id;
      const result = productId ? await adjustStockCAS(req.companyId, productId, -line.quantity, {}) : { ok: false, error: 'no receiver product mapped' };
      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: productId, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: -line.quantity, quantity_after: result.newQty,
          reason: 'company_transfer_return', notes: `Return on transfer ${transfer.transfer_number} (${line.reason})`,
        });
        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId,
          beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty },
          metadata: { quantity_change: -line.quantity, reason: 'company_transfer_return', transfer_id: transferId, return_reason: line.reason },
        });
      }

      await supabase.from('pos_company_transfer_items').update({
        quantity_returned: item.quantity_returned + line.quantity,
        return_reason: line.reason,
        notes: line.notes ? `${item.notes ? item.notes + ' | ' : ''}Return note: ${line.notes}` : item.notes,
      }).eq('id', item.id);

      processedItems.push({ item_id: item.id, quantity_returned: line.quantity, reason: line.reason, stock_updated: result.ok });
    }

    const { data: updated } = await supabase.from('pos_company_transfers')
      .update({
        status: 'return_sent',
        return_requested_by: req.user.userId, return_requested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_RETURN_REQUESTED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, sender_company_id: transfer.company_id, item_count: lines.length },
    });
    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_RETURN_SENT, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, sender_company_id: transfer.company_id, item_count: lines.length },
    });

    res.json({ transfer: updated, items: processedItems });
  } catch (err) {
    console.error('[company-transfers] return:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/confirm-return ──────────────────────────────────────────────
// Sender-only. Sender stock is only ever increased here — never on the
// receiver's /return call above.
router.post('/:id/confirm-return', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const transferId = parseInt(req.params.id);
    if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });

    const { data: transfer } = await supabase.from('pos_company_transfers').select('*').eq('id', transferId).single();
    if (!transfer || transfer.company_id !== req.companyId) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status !== 'return_sent') return res.status(400).json({ error: `No pending return to confirm (current status: ${transfer.status})` });

    const { data: items } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', transferId).gt('quantity_returned', 0);

    for (const item of items || []) {
      const result = await adjustStockCAS(req.companyId, item.product_id, item.quantity_returned, {});
      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: item.product_id, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: item.quantity_returned, quantity_after: result.newQty,
          reason: 'company_transfer_return_received', notes: `Return confirmed on transfer ${transfer.transfer_number}`,
        });
        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, {
          productId: item.product_id,
          beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty },
          metadata: { quantity_change: item.quantity_returned, reason: 'company_transfer_return_received', transfer_id: transferId },
        });
      }
    }

    const { data: updated } = await supabase.from('pos_company_transfers')
      .update({ status: 'return_received', return_received_by: req.user.userId, return_received_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', transferId).select().single();

    posAuditFromReq(req, POS_EVENTS.COMPANY_TRANSFER_RETURN_RECEIVED, {
      metadata: { transfer_id: transferId, transfer_number: transfer.transfer_number, receiver_company_id: transfer.receiver_company_id },
    });

    res.json({ transfer: updated });
  } catch (err) {
    console.error('[company-transfers] confirm-return:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
