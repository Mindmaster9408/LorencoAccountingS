/**
 * ============================================================================
 * Account Sale → Buyer Purchase Order Sync — Checkout Charlie (Workstream 99)
 * ============================================================================
 * When an ACCOUNT sale is made to a customer whose local record is linked to
 * another company on the platform, this makes the transaction visible on
 * that company's side as a Purchase Order — either attached as a delivery
 * against an existing open PO, or a brand-new PO auto-created and marked
 * fully accepted + delivered (the goods have already physically left the
 * store via the POS sale itself, so there is nothing left to "approve").
 *
 * Deliberately a NEW, SELF-CONTAINED module rather than modifying the
 * existing Purchase Order engine (purchase-orders.js) — that engine is
 * already live-verified and proven (Workstreams 87-89); this file calls it
 * only for its exported generatePoInvoice() helper and otherwise re-derives
 * the small subset of dispatch/receive logic it needs, adapted for the one
 * real difference: stock has ALREADY moved (the seller's side, via the POS
 * sale) — this only ever increments the BUYER's stock, never the seller's.
 *
 * Never allowed to fail or block the sale that triggered it — every call
 * site treats this as fire-and-forget-but-logged, exactly like
 * postAccountCharge()/reverseAccountCharge() elsewhere in sales.js.
 * ============================================================================
 */

const crypto = require('crypto');
const { supabase } = require('../../../config/database');
const { posAuditFromReq, POS_EVENTS } = require('./posAuditLogger');
const { adjustStockCAS } = require('./stockCAS');
const { generatePoInvoice } = require('../routes/purchase-orders');

const OPEN_PO_STATUSES = ['submitted', 'accepted', 'partially_fulfilled', 'awaiting_final_delivery'];

function generatePoNumber() {
  return 'PO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function generateDeliveryNumber() {
  return 'DEL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Synthetic req-like object so generatePoInvoice()/posAuditFromReq() can log
 * against the BUYER company, attributing the action to the real seller-side
 * user who triggered it (there is no real buyer-side user in this flow). */
function buyerAuditContext(buyerCompanyId, sellerUserId) {
  return { companyId: buyerCompanyId, user: { userId: sellerUserId, email: 'auto-sync', role: 'system' }, ip: null, headers: {} };
}

/**
 * @param {object} params
 * @param {number} params.companyId - the SELLER's company id (req.companyId)
 * @param {number} params.customerId
 * @param {number} params.saleId
 * @param {string} params.saleNumber
 * @param {Array<{product_id:number, quantity:number}>} params.saleItems - as sold (seller's own product ids)
 * @param {number} params.userId - the seller-side user who made the sale
 * @returns {Promise<{synced:boolean, reason?:string, po?:object, invoice?:object, unmatched?:Array}>}
 */
async function syncAccountSaleToLinkedBuyerPO({ companyId, customerId, saleId, saleNumber, saleItems, userId }) {
  try {
    if (!customerId || !Array.isArray(saleItems) || saleItems.length === 0) return { synced: false, reason: 'no_customer_or_items' };

    const { data: customer } = await supabase
      .from('customers').select('linked_company_id, link_status').eq('id', customerId).eq('company_id', companyId).maybeSingle();
    if (!customer || !customer.linked_company_id || customer.link_status !== 'active') {
      return { synced: false, reason: 'customer_not_linked' };
    }
    const buyerCompanyId = customer.linked_company_id;

    // Relationship must be active AND have purchase_orders enabled — same
    // authorization bar as manually raising a PO (purchase-orders.js POST /).
    const { data: relationship } = await supabase
      .from('inter_company_relationships')
      .select('*')
      .or(`and(company_a_id.eq.${companyId},company_b_id.eq.${buyerCompanyId}),and(company_a_id.eq.${buyerCompanyId},company_b_id.eq.${companyId})`)
      .eq('status', 'active')
      .maybeSingle();
    if (!relationship || !(relationship.permissions || {}).purchase_orders) {
      return { synced: false, reason: 'purchase_orders_not_enabled_on_relationship' };
    }

    // Match each sold item to the buyer's own product catalog by barcode,
    // then product_code — identical heuristic to the manual delivery
    // dispatch code in purchase-orders.js (POST /:id/deliveries).
    const productIds = [...new Set(saleItems.map(i => i.product_id))];
    const { data: myProducts } = await supabase
      .from('products').select('id, product_name, barcode, product_code, unit_price')
      .eq('company_id', companyId).in('id', productIds);
    const myProductsById = new Map((myProducts || []).map(p => [p.id, p]));

    const matched = [];
    const unmatched = [];
    for (const item of saleItems) {
      const myProduct = myProductsById.get(item.product_id);
      if (!myProduct) { unmatched.push(item); continue; }
      let buyerProduct = null;
      if (myProduct.barcode) {
        const { data } = await supabase.from('products').select('id, product_name').eq('company_id', buyerCompanyId).eq('barcode', myProduct.barcode).maybeSingle();
        buyerProduct = data;
      }
      if (!buyerProduct && myProduct.product_code) {
        const { data } = await supabase.from('products').select('id, product_name').eq('company_id', buyerCompanyId).eq('product_code', myProduct.product_code).maybeSingle();
        buyerProduct = data;
      }
      if (buyerProduct) matched.push({ item, myProduct, buyerProductId: buyerProduct.id, buyerProductName: buyerProduct.product_name });
      else unmatched.push(item);
    }
    if (matched.length === 0) return { synced: false, reason: 'no_matching_buyer_products', unmatched };

    // ── Find an existing open PO from the buyer against this seller ────────
    const { data: openPOs } = await supabase
      .from('pos_purchase_orders')
      .select('*').eq('company_id', buyerCompanyId).eq('supplier_company_id', companyId)
      .in('status', OPEN_PO_STATUSES).order('created_at', { ascending: true }).limit(1);
    let po = (openPOs && openPOs[0]) || null;
    let isNewPO = false;

    if (!po) {
      // Auto-create one. Needs the buyer's OWN supplier record pointing back
      // at this seller (pos_purchase_orders.supplier_id is a NOT NULL FK into
      // the buyer's suppliers table) — if that link doesn't exist yet on the
      // buyer's side, there is nothing valid to create a PO against; skip
      // rather than fail the sale.
      const { data: buyerSupplier } = await supabase
        .from('suppliers').select('id').eq('company_id', buyerCompanyId).eq('linked_company_id', companyId).eq('link_status', 'active').maybeSingle();
      if (!buyerSupplier) return { synced: false, reason: 'buyer_has_no_supplier_link_back' };

      const { data: settings } = await supabase.from('company_settings').select('po_invoice_timing').eq('company_id', buyerCompanyId).maybeSingle();
      const invoiceTiming = (settings && settings.po_invoice_timing) || 'after_final_delivery';
      const totalQty = matched.reduce((s, m) => s + m.item.quantity, 0);
      const nowIso = new Date().toISOString();

      const { data: newPo, error: poErr } = await supabase.from('pos_purchase_orders').insert({
        company_id: buyerCompanyId, supplier_id: buyerSupplier.id, supplier_company_id: companyId,
        relationship_id: relationship.id, po_number: generatePoNumber(), status: 'accepted',
        reference: saleNumber, notes: `Auto-generated from account sale ${saleNumber}`,
        invoice_timing: invoiceTiming, item_count: matched.length, total_ordered_qty: totalQty, total_received_qty: 0,
        created_by: userId, submitted_by: userId, submitted_at: nowIso, accepted_by: userId, accepted_at: nowIso,
      }).select().single();
      if (poErr) { console.error('[accountSaleToPOSync] PO create failed:', poErr.message); return { synced: false, reason: 'po_create_failed' }; }
      po = newPo;
      isNewPO = true;

      for (const m of matched) {
        await supabase.from('pos_purchase_order_items').insert({
          purchase_order_id: po.id, company_id: buyerCompanyId, product_id: m.buyerProductId, supplier_product_id: m.item.product_id,
          product_code: m.myProduct.product_code || null, barcode: m.myProduct.barcode || null, description: m.buyerProductName,
          quantity_ordered: m.item.quantity, quantity_received: 0, unit_cost: m.myProduct.unit_price,
        });
      }
    }

    const { data: poItems } = await supabase.from('pos_purchase_order_items').select('*').eq('purchase_order_id', po.id);
    const poItemsByBuyerProduct = new Map((poItems || []).map(i => [i.product_id, i]));

    // ── One delivery record, auto-completed (no stock decrement — the
    // seller's stock already moved via the POS sale itself) ────────────────
    const { count: priorDeliveries } = await supabase.from('pos_company_transfers').select('id', { count: 'exact', head: true }).eq('purchase_order_id', po.id);
    const deliveryNumber = (priorDeliveries || 0) + 1;
    const nowIso = new Date().toISOString();

    const deliverableLines = [];
    for (const m of matched) {
      const poItem = poItemsByBuyerProduct.get(m.buyerProductId);
      if (!poItem) continue; // matched to buyer's catalog but not an item on this PO — not tracked against it
      const outstanding = poItem.quantity_ordered - poItem.quantity_received;
      const qty = isNewPO ? m.item.quantity : Math.min(m.item.quantity, Math.max(0, outstanding));
      if (qty <= 0) continue;
      deliverableLines.push({ m, poItem, qty });
    }
    if (deliverableLines.length === 0) return { synced: false, reason: 'nothing_outstanding_to_attach' };

    const totalQtySent = deliverableLines.reduce((s, l) => s + l.qty, 0);
    const { data: delivery, error: delErr } = await supabase.from('pos_company_transfers').insert({
      company_id: companyId, receiver_company_id: buyerCompanyId, relationship_id: relationship.id,
      transfer_type: 'po_delivery', purchase_order_id: po.id, delivery_number: deliveryNumber,
      transfer_number: generateDeliveryNumber(), status: 'received',
      reference: po.po_number, notes: `Auto-generated from account sale ${saleNumber}`,
      sent_by: userId, sent_at: nowIso, dispatched_by: userId, dispatched_at: nowIso,
      received_by: userId, received_at: nowIso,
      item_count: deliverableLines.length, total_quantity_sent: totalQtySent,
    }).select().single();
    if (delErr) { console.error('[accountSaleToPOSync] delivery create failed:', delErr.message); return { synced: false, reason: 'delivery_create_failed' }; }

    for (const line of deliverableLines) {
      await supabase.from('pos_company_transfer_items').insert({
        transfer_id: delivery.id, company_id: companyId, product_id: line.m.item.product_id, receiver_product_id: line.m.buyerProductId,
        description: line.m.buyerProductName, quantity_sent: line.qty, quantity_received: line.qty,
        unit_cost: line.m.myProduct.unit_price, selling_price: line.m.myProduct.unit_price,
      });

      // Increment the BUYER's stock only — the seller's stock already moved
      // when the POS sale itself was created.
      const stockResult = await adjustStockCAS(buyerCompanyId, line.m.buyerProductId, line.qty, {});
      if (!stockResult.ok) console.error('[accountSaleToPOSync] buyer stock increment failed:', line.m.buyerProductId, stockResult.error);

      await supabase.from('pos_purchase_order_items').update({ quantity_received: line.poItem.quantity_received + line.qty }).eq('id', line.poItem.id);
    }

    const { data: refreshedItems } = await supabase.from('pos_purchase_order_items').select('quantity_ordered, quantity_received').eq('purchase_order_id', po.id);
    const totalReceived = (refreshedItems || []).reduce((s, i) => s + i.quantity_received, 0);
    const totalOrdered = (refreshedItems || []).reduce((s, i) => s + i.quantity_ordered, 0);
    const outstanding = Math.max(0, totalOrdered - totalReceived);
    const poCompleted = outstanding === 0;

    const { data: updatedPo } = await supabase.from('pos_purchase_orders').update({
      total_received_qty: totalReceived, status: poCompleted ? 'completed' : 'partially_fulfilled',
      completed_at: poCompleted ? nowIso : po.completed_at, updated_at: nowIso,
    }).eq('id', po.id).select().single();

    const buyerCtx = buyerAuditContext(buyerCompanyId, userId);
    posAuditFromReq(buyerCtx, isNewPO ? POS_EVENTS.PO_CREATED : POS_EVENTS.PO_PARTIAL_DELIVERY, {
      entityType: 'purchase_order', entityId: po.id,
      metadata: { po_number: po.po_number, auto_synced_from_sale: saleNumber, seller_company_id: companyId, is_new_po: isNewPO, total_received_qty: totalReceived, outstanding_qty: outstanding },
    });
    if (poCompleted) {
      posAuditFromReq(buyerCtx, POS_EVENTS.PO_FINAL_DELIVERY, { entityType: 'purchase_order', entityId: po.id, metadata: { po_number: po.po_number, auto_synced_from_sale: saleNumber } });
    }

    let invoice = null;
    if (poCompleted && updatedPo.invoice_timing === 'after_final_delivery' && !updatedPo.invoice_id) {
      invoice = await generatePoInvoice(updatedPo, 'received', buyerCtx);
    }

    return { synced: true, po: updatedPo, delivery, invoice, unmatched, isNewPO };
  } catch (err) {
    console.error('[accountSaleToPOSync] unexpected error:', err.message);
    return { synced: false, reason: 'unexpected_error', error: err.message };
  }
}

module.exports = { syncAccountSaleToLinkedBuyerPO };
