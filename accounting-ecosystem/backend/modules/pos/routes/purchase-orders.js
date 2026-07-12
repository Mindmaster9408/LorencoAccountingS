/**
 * ============================================================================
 * Purchase Order + Delivery Fulfilment Engine — Checkout Charlie (Workstream 87)
 * ============================================================================
 * A Purchase Order is a single commercial document that may be fulfilled over
 * ANY number of separate deliveries (Turkstra has 25 today, 10 tomorrow, 15
 * next week — Pennygrow raises ONE order, gets ONE invoice, THREE deliveries).
 *
 * Three deliberately separate concepts (never merged into one object):
 *   Commercial — pos_purchase_orders / pos_purchase_order_items (this file).
 *                Named with the pos_ prefix because a DIFFERENT, already-
 *                shipped purchase_orders table already exists (Accounting/
 *                Inventory module, accounting-schema.js "23c") — caught live
 *                in Workstream 89's verification pass before any data was
 *                written; see docs/checkout-charlie-production/89_*.md.
 *                Ordered quantity never changes after submission.
 *   Logistics  — REUSED, not duplicated: pos_company_transfers /
 *                pos_company_transfer_items / pos_transfer_discrepancies
 *                (Workstream 81/85) with transfer_type='po_delivery'. Every
 *                delivery is one row in that table; dispatch/receive here
 *                calls the exact same adjustStockCAS primitive company-
 *                transfers.js uses (see services/stockCAS.js).
 *   Financial  — REUSED, not a third invoicing system: inter_company_invoices
 *                via InvoiceSender (accounting-ecosystem/backend/inter-company).
 *                This file only builds the line items and calls .send().
 *
 * v1 scope: Purchase Orders may only be raised against a supplier that is
 * linked to another company on the platform (suppliers.linked_company_id set)
 * with an ACTIVE inter_company_relationships row that has the purchase_orders
 * permission flag enabled — "Supplier accepts" is a real action taken by a
 * real user on the other side, which is only possible when the supplier is
 * itself a Checkout Charlie company. Raising a PO against a manual/unlinked
 * supplier (paper-only fulfilment) is a natural v2 extension — see the
 * FOLLOW-UP NOTE in docs/checkout-charlie-production/87_*_IMPLEMENTED.md.
 *
 * Routes:
 *   GET  /transferable-suppliers          — linked suppliers PO-eligible for this company
 *   POST /                                — create a draft PO
 *   PUT  /:id/items                       — replace items on a draft PO
 *   POST /:id/submit                      — customer: draft → submitted
 *   POST /:id/accept                      — supplier: submitted → accepted (+ Option B invoice)
 *   POST /:id/reject                      — supplier: submitted → rejected
 *   POST /:id/cancel                      — either side, subject to in-transit-delivery guard
 *   POST /:id/close                       — customer management: force-complete short of full qty
 *   GET  /                                — list POs (role=customer|supplier|all, status filter)
 *   GET  /:id                             — full detail: items + deliveries + invoice summary
 *   POST /:id/deliveries                  — supplier: create + dispatch a delivery (atomic)
 *   POST /:id/deliveries/:deliveryId/receive         — customer: receive a delivery
 *   POST /:id/deliveries/:deliveryId/resolve-variance — customer management: close out a discrepancy
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { getStockPolicy } = require('../services/stockPolicyCache');
const { adjustStockCAS } = require('../services/stockCAS');
const { supabaseSeanStore } = require('../../../sean/supabase-store');
const InvoiceSender = require('../../../inter-company/invoice-sender');
const { hasPermission } = require('../../../config/permissions');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// Same variance-risk thresholds established in Workstream 85 (store-transfers.js) —
// reused here so a "damaged/short delivery" reads the same way across both
// inter-store shrinkage and PO delivery variance.
const VARIANCE_PCT_THRESHOLD = 10;

function generatePoNumber() {
  return 'PO-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
}
function generateDeliveryNumber() {
  return 'DEL-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
}

/** Active relationship between companyId and otherCompanyId with a given permission flag set. */
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

/** Fetch a PO the caller is authorized for (either the customer or the supplier side). Returns {po, isSupplier} or null. */
async function getAuthorizedPO(poId, companyId) {
  const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).maybeSingle();
  if (!po) return null;
  if (po.company_id !== companyId && po.supplier_company_id !== companyId) return null;
  return { po, isSupplier: po.supplier_company_id === companyId };
}

// ── GET /transferable-suppliers ──────────────────────────────────────────
router.get('/transferable-suppliers', requirePermission('PURCHASE_ORDERS.VIEW'), async (req, res) => {
  try {
    const { data: suppliers } = await supabase
      .from('suppliers')
      .select('id, supplier_name, linked_company_id, link_status')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .not('linked_company_id', 'is', null);

    const eligible = [];
    for (const s of (suppliers || [])) {
      if (s.link_status && s.link_status !== 'active') continue;
      const rel = await getAuthorizedRelationship(req.companyId, s.linked_company_id, 'purchase_orders');
      if (rel) eligible.push({ supplier_id: s.id, supplier_name: s.supplier_name, supplier_company_id: s.linked_company_id, relationship_id: rel.id });
    }

    res.json({ suppliers: eligible });
  } catch (err) {
    console.error('[purchase-orders] transferable-suppliers:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST / — create a draft PO ────────────────────────────────────────────
router.post('/', requirePermission('PURCHASE_ORDERS.CREATE'), async (req, res) => {
  try {
    const { supplier_id, items, reference, notes, expected_date } = req.body;
    const supplierId = parseInt(supplier_id);
    if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' });

    const { data: supplier } = await supabase.from('suppliers').select('*').eq('id', supplierId).eq('company_id', req.companyId).maybeSingle();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (!supplier.linked_company_id) return res.status(400).json({ error: 'This supplier is not linked to a company on the platform — purchase orders require a linked supplier' });

    const relationship = await getAuthorizedRelationship(req.companyId, supplier.linked_company_id, 'purchase_orders');
    if (!relationship) return res.status(403).json({ error: 'This relationship does not have purchase orders enabled' });

    const lines = Array.isArray(items) ? items
      .map(i => ({ product_id: parseInt(i.product_id), quantity: parseInt(i.quantity), unit_cost: i.unit_cost != null ? parseFloat(i.unit_cost) : null, notes: i.notes ? String(i.notes).trim() : null }))
      .filter(l => l.product_id > 0 && l.quantity > 0) : [];

    let dbProducts = [];
    if (lines.length > 0) {
      const productIds = lines.map(l => l.product_id);
      const { data, error: prodErr } = await supabase
        .from('products').select('id, product_name, product_code, barcode, cost_price')
        .eq('company_id', req.companyId).in('id', productIds);
      if (prodErr) return res.status(500).json({ error: prodErr.message });
      dbProducts = data || [];
      const byId = new Map(dbProducts.map(p => [p.id, p]));
      const missing = productIds.filter(id => !byId.has(id));
      if (missing.length > 0) return res.status(400).json({ error: `Product IDs not found for this company: ${missing.join(', ')}` });
    }

    const { data: settings } = await supabase.from('company_settings').select('po_invoice_timing').eq('company_id', req.companyId).maybeSingle();
    const invoiceTiming = (settings && settings.po_invoice_timing) || 'after_final_delivery';

    const totalOrdered = lines.reduce((sum, l) => sum + l.quantity, 0);
    const { data: po, error: poErr } = await supabase
      .from('pos_purchase_orders')
      .insert({
        company_id: req.companyId, supplier_id: supplierId, supplier_company_id: supplier.linked_company_id,
        relationship_id: relationship.id, po_number: generatePoNumber(), status: 'draft',
        reference: reference || null, notes: notes || null, expected_date: expected_date || null,
        invoice_timing: invoiceTiming, item_count: lines.length, total_ordered_qty: totalOrdered,
        created_by: req.user.userId,
      })
      .select().single();
    if (poErr) return res.status(500).json({ error: poErr.message });

    const byId = new Map(dbProducts.map(p => [p.id, p]));
    for (const line of lines) {
      const product = byId.get(line.product_id);
      await supabase.from('pos_purchase_order_items').insert({
        purchase_order_id: po.id, company_id: req.companyId, product_id: line.product_id,
        product_code: product.product_code || null, barcode: product.barcode || null, description: product.product_name,
        quantity_ordered: line.quantity, unit_cost: line.unit_cost != null ? line.unit_cost : product.cost_price, notes: line.notes,
      });
    }

    posAuditFromReq(req, POS_EVENTS.PO_CREATED, {
      entityType: 'purchase_order', entityId: po.id,
      metadata: { po_number: po.po_number, supplier_id: supplierId, supplier_company_id: supplier.linked_company_id, item_count: lines.length, total_ordered_qty: totalOrdered },
    });

    res.json({ purchaseOrder: po });
  } catch (err) {
    console.error('[purchase-orders] create:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /:id/items — replace items on a draft PO ─────────────────────────
router.put('/:id/items', requirePermission('PURCHASE_ORDERS.CREATE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(400).json({ error: `Items can only be changed while the order is in draft (current status: ${po.status})` });

    const lines = items
      .map(i => ({ product_id: parseInt(i.product_id), quantity: parseInt(i.quantity), unit_cost: i.unit_cost != null ? parseFloat(i.unit_cost) : null, notes: i.notes ? String(i.notes).trim() : null }))
      .filter(l => l.product_id > 0 && l.quantity > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a quantity greater than zero' });

    const productIds = lines.map(l => l.product_id);
    const { data: dbProducts, error: prodErr } = await supabase
      .from('products').select('id, product_name, product_code, barcode, cost_price')
      .eq('company_id', req.companyId).in('id', productIds);
    if (prodErr) return res.status(500).json({ error: prodErr.message });
    const byId = new Map((dbProducts || []).map(p => [p.id, p]));
    const missing = productIds.filter(id => !byId.has(id));
    if (missing.length > 0) return res.status(400).json({ error: `Product IDs not found for this company: ${missing.join(', ')}` });

    await supabase.from('pos_purchase_order_items').delete().eq('purchase_order_id', poId);
    for (const line of lines) {
      const product = byId.get(line.product_id);
      await supabase.from('pos_purchase_order_items').insert({
        purchase_order_id: poId, company_id: req.companyId, product_id: line.product_id,
        product_code: product.product_code || null, barcode: product.barcode || null, description: product.product_name,
        quantity_ordered: line.quantity, unit_cost: line.unit_cost != null ? line.unit_cost : product.cost_price, notes: line.notes,
      });
    }

    const totalOrdered = lines.reduce((sum, l) => sum + l.quantity, 0);
    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ item_count: lines.length, total_ordered_qty: totalOrdered, updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    res.json({ purchaseOrder: updated });
  } catch (err) {
    console.error('[purchase-orders] items:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/submit ──────────────────────────────────────────────────────
router.post('/:id/submit', requirePermission('PURCHASE_ORDERS.CREATE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(400).json({ error: `Only a draft order can be submitted (current status: ${po.status})` });
    if (po.item_count === 0) return res.status(400).json({ error: 'Add at least one item before submitting' });

    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ status: 'submitted', submitted_by: req.user.userId, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_SUBMITTED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, supplier_company_id: po.supplier_company_id } });

    res.json({ purchaseOrder: updated });
  } catch (err) {
    console.error('[purchase-orders] submit:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/** Build InvoiceSender line items from purchase_order_items, billing `quantity` per line (ordered vs delivered chosen by caller). */
async function buildInvoiceLineItems(poId, useField) {
  const { data: items } = await supabase.from('pos_purchase_order_items').select('*').eq('purchase_order_id', poId);
  return (items || []).map(i => ({
    description: i.description,
    quantity: useField === 'received' ? i.quantity_received : i.quantity_ordered,
    unitPrice: i.unit_cost || 0,
  })).filter(li => li.quantity > 0);
}

async function generatePoInvoice(po, useField, req) {
  const lineItems = await buildInvoiceLineItems(po.id, useField);
  if (lineItems.length === 0) return null;

  const sender = new InvoiceSender(supabaseSeanStore);
  const result = await sender.send({
    senderCompanyId: po.supplier_company_id,
    receiverCompanyId: po.company_id,
    invoiceNumber: `INV-${po.po_number}`,
    date: new Date().toISOString().split('T')[0],
    lineItems,
    notes: `Invoice for Purchase Order ${po.po_number}`,
  });
  if (!result.success || !result.invoice || !result.invoice.id) return null;

  await supabase.from('inter_company_invoices').update({ purchase_order_id: po.id }).eq('id', result.invoice.id);
  await supabase.from('pos_purchase_orders').update({ invoice_id: result.invoice.id }).eq('id', po.id);

  posAuditFromReq(req, POS_EVENTS.PO_INVOICE_GENERATED, {
    entityType: 'purchase_order', entityId: po.id,
    metadata: { po_number: po.po_number, invoice_id: result.invoice.id, invoice_number: result.invoice.invoice_number, basis: useField },
  });

  return result.invoice;
}

// ── POST /:id/accept ───────────────────────────────────────────────────────
router.post('/:id/accept', requirePermission('PURCHASE_ORDERS.APPROVE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('supplier_company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'submitted') return res.status(400).json({ error: `Only a submitted order can be accepted (current status: ${po.status})` });

    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ status: 'accepted', accepted_by: req.user.userId, accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_ACCEPTED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, company_id: po.company_id } });

    let invoice = null;
    if (po.invoice_timing === 'immediate') {
      invoice = await generatePoInvoice(updated, 'ordered', req);
    }

    res.json({ purchaseOrder: updated, invoice });
  } catch (err) {
    console.error('[purchase-orders] accept:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/reject ───────────────────────────────────────────────────────
router.post('/:id/reject', requirePermission('PURCHASE_ORDERS.APPROVE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const reason = (req.body.reason || '').trim();
    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('supplier_company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'submitted') return res.status(400).json({ error: `Only a submitted order can be rejected (current status: ${po.status})` });

    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ status: 'rejected', rejected_by: req.user.userId, rejected_at: new Date().toISOString(), rejection_reason: reason || null, updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_REJECTED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, company_id: po.company_id, reason: reason || null } });

    res.json({ purchaseOrder: updated });
  } catch (err) {
    console.error('[purchase-orders] reject:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/cancel ───────────────────────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const auth = await getAuthorizedPO(poId, req.companyId);
    if (!auth) return res.status(404).json({ error: 'Purchase order not found' });
    const { po } = auth;
    if (!['draft', 'submitted', 'accepted', 'partially_fulfilled', 'awaiting_final_delivery'].includes(po.status)) {
      return res.status(400).json({ error: `Order cannot be cancelled in its current status (${po.status})` });
    }

    // Draft/submitted: creator (customer) may cancel freely at CREATE tier.
    // Anything past acceptance: requires APPROVE tier and no delivery in transit.
    const needsApprovalTier = !['draft', 'submitted'].includes(po.status);
    const requiredPermission = needsApprovalTier ? 'PURCHASE_ORDERS.APPROVE' : 'PURCHASE_ORDERS.CREATE';
    if (!hasPermission(req.user.role, ...requiredPermission.split('.'))) {
      return res.status(403).json({ error: `Requires ${requiredPermission}` });
    }

    if (needsApprovalTier) {
      const { data: inTransit } = await supabase.from('pos_company_transfers').select('id').eq('purchase_order_id', poId).eq('status', 'sent').limit(1);
      if (inTransit && inTransit.length > 0) {
        return res.status(400).json({ error: 'Cannot cancel — a delivery is currently in transit. Wait for it to be received first.' });
      }
    }

    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ status: 'cancelled', cancelled_by: req.user.userId, cancelled_at: new Date().toISOString(), cancellation_reason: (req.body.reason || '').trim() || null, updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_CANCELLED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number } });

    res.json({ purchaseOrder: updated });
  } catch (err) {
    console.error('[purchase-orders] cancel:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/close — customer management force-completes a short order ──
router.post('/:id/close', requirePermission('PURCHASE_ORDERS.CLOSE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['partially_fulfilled', 'awaiting_final_delivery'].includes(po.status)) {
      return res.status(400).json({ error: `Only a partially fulfilled order can be force-closed (current status: ${po.status})` });
    }

    const { data: updated } = await supabase.from('pos_purchase_orders')
      .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', poId).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_CLOSED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, total_ordered_qty: po.total_ordered_qty, total_received_qty: po.total_received_qty } });

    let invoice = null;
    if (po.invoice_timing === 'after_final_delivery' && !po.invoice_id) {
      invoice = await generatePoInvoice(updated, 'received', req);
    }

    res.json({ purchaseOrder: updated, invoice });
  } catch (err) {
    console.error('[purchase-orders] close:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET / — list ────────────────────────────────────────────────────────
router.get('/', requirePermission('PURCHASE_ORDERS.VIEW'), async (req, res) => {
  try {
    const { role = 'all', status } = req.query;
    let query = supabase.from('pos_purchase_orders').select('*');
    if (role === 'customer') query = query.eq('company_id', req.companyId);
    else if (role === 'supplier') query = query.eq('supplier_company_id', req.companyId);
    else query = query.or(`company_id.eq.${req.companyId},supplier_company_id.eq.${req.companyId}`);
    if (status) query = query.eq('status', status);

    const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: error.message });

    const otherIds = [...new Set((data || []).flatMap(po => [po.company_id, po.supplier_company_id]))];
    const { data: companies } = otherIds.length ? await supabase.from('companies').select('id, company_name, trading_name').in('id', otherIds) : { data: [] };
    const namesById = Object.fromEntries((companies || []).map(c => [c.id, c.trading_name || c.company_name]));

    const shaped = (data || []).map(po => ({
      ...po,
      total_outstanding_qty: Math.max(0, po.total_ordered_qty - po.total_received_qty),
      customer_company_name: namesById[po.company_id],
      supplier_company_name: namesById[po.supplier_company_id],
      role: po.company_id === req.companyId ? 'customer' : 'supplier',
    }));

    res.json({ purchaseOrders: shaped });
  } catch (err) {
    console.error('[purchase-orders] list:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /:id — detail ─────────────────────────────────────────────────────
router.get('/:id', requirePermission('PURCHASE_ORDERS.VIEW'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const auth = await getAuthorizedPO(poId, req.companyId);
    if (!auth) return res.status(404).json({ error: 'Purchase order not found' });
    const { po, isSupplier } = auth;

    const { data: items } = await supabase.from('pos_purchase_order_items').select('*').eq('purchase_order_id', poId).order('id');
    const shapedItems = (items || []).map(i => ({ ...i, quantity_outstanding: Math.max(0, i.quantity_ordered - i.quantity_received) }));

    const { data: deliveries } = await supabase.from('pos_company_transfers').select('*').eq('purchase_order_id', poId).order('delivery_number');
    const deliveryIds = (deliveries || []).map(d => d.id);
    const { data: deliveryItems } = deliveryIds.length ? await supabase.from('pos_company_transfer_items').select('*').in('transfer_id', deliveryIds) : { data: [] };
    const { data: discrepancies } = deliveryIds.length ? await supabase.from('pos_transfer_discrepancies').select('*').in('transfer_id', deliveryIds) : { data: [] };

    const shapedDeliveries = (deliveries || []).map(d => ({
      ...d,
      items: (deliveryItems || []).filter(di => di.transfer_id === d.id),
      discrepancies: (discrepancies || []).filter(disc => disc.transfer_id === d.id),
    }));

    const otherCompanyId = isSupplier ? po.company_id : po.supplier_company_id;
    const { data: otherCompany } = await supabase.from('companies').select('id, company_name, trading_name').eq('id', otherCompanyId).maybeSingle();

    let invoiceSummary = null;
    if (po.invoice_id) {
      const invoice = await supabaseSeanStore.getInterCompanyInvoice(po.invoice_id);
      if (invoice) {
        invoiceSummary = {
          id: invoice.id, invoiceNumber: invoice.invoice_number, total: invoice.total,
          paymentStatus: invoice.payment_status, senderStatus: invoice.sender_status, receiverStatus: invoice.receiver_status,
          ordered: po.total_ordered_qty, delivered: po.total_received_qty, outstanding: Math.max(0, po.total_ordered_qty - po.total_received_qty),
        };
      }
    }

    res.json({
      purchaseOrder: { ...po, total_outstanding_qty: Math.max(0, po.total_ordered_qty - po.total_received_qty), is_supplier: isSupplier, other_company_name: otherCompany ? (otherCompany.trading_name || otherCompany.company_name) : `Company ${otherCompanyId}` },
      items: shapedItems, deliveries: shapedDeliveries, invoice: invoiceSummary,
    });
  } catch (err) {
    console.error('[purchase-orders] detail:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/deliveries — supplier creates + dispatches a delivery ──────
// Deliberately atomic (create+dispatch in one call), mirroring company-
// transfers.js's POST /send — a delivery only exists once it has actually
// been sent; there is no "draft delivery" state to manage separately.
router.post('/:id/deliveries', requirePermission('PURCHASE_ORDERS.DISPATCH'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const { items, transported_by, transport_reference, notes, expected_receive_date } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('supplier_company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (!['accepted', 'partially_fulfilled', 'awaiting_final_delivery'].includes(po.status)) {
      return res.status(400).json({ error: `Deliveries can only be dispatched against an accepted order (current status: ${po.status})` });
    }

    const { data: poItems } = await supabase.from('pos_purchase_order_items').select('*').eq('purchase_order_id', poId);
    const poItemsById = new Map((poItems || []).map(i => [i.id, i]));

    const lines = items
      .map(i => ({ purchase_order_item_id: parseInt(i.purchase_order_item_id), quantity: parseInt(i.quantity), supplier_product_id: i.supplier_product_id ? parseInt(i.supplier_product_id) : null }))
      .filter(l => l.purchase_order_item_id > 0 && l.quantity > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a quantity greater than zero' });

    // Resolve each line to a supplier-side product: explicit supplier_product_id,
    // else the mapping already stored from a prior delivery of this same PO item,
    // else auto-match by barcode/product_code against the supplier's own catalog.
    const unresolvable = [];
    for (const line of lines) {
      const poItem = poItemsById.get(line.purchase_order_item_id);
      if (!poItem || poItem.purchase_order_id !== poId) { unresolvable.push({ purchase_order_item_id: line.purchase_order_item_id, reason: 'item not found on this order' }); continue; }
      const outstanding = poItem.quantity_ordered - poItem.quantity_received;
      if (line.quantity > outstanding) { unresolvable.push({ purchase_order_item_id: line.purchase_order_item_id, reason: `cannot dispatch more than the ${outstanding} unit(s) still outstanding` }); continue; }

      let resolved = line.supplier_product_id || poItem.supplier_product_id;
      if (!resolved && poItem.barcode) {
        const { data } = await supabase.from('products').select('id').eq('company_id', req.companyId).eq('barcode', poItem.barcode).maybeSingle();
        if (data) resolved = data.id;
      }
      if (!resolved && poItem.product_code) {
        const { data } = await supabase.from('products').select('id').eq('company_id', req.companyId).eq('product_code', poItem.product_code).maybeSingle();
        if (data) resolved = data.id;
      }
      if (!resolved) { unresolvable.push({ purchase_order_item_id: line.purchase_order_item_id, description: poItem.description, reason: 'no matching product found in your catalog — supply supplier_product_id manually' }); continue; }
      line.resolvedProductId = resolved;
      line.poItem = poItem;
    }
    if (unresolvable.length > 0) return res.status(400).json({ error: 'One or more items could not be matched to a product in your inventory', unresolvable });

    const productIds = [...new Set(lines.map(l => l.resolvedProductId))];
    const { data: dbProducts } = await supabase.from('products').select('id, product_name, product_code, barcode, stock_quantity, cost_price, unit_price').eq('company_id', req.companyId).in('id', productIds);
    const productsById = new Map((dbProducts || []).map(p => [p.id, p]));

    const allowNegative = await getStockPolicy(req.companyId, supabase);
    const exceeding = lines.filter(l => !allowNegative && l.quantity > parseFloat((productsById.get(l.resolvedProductId) || {}).stock_quantity || 0));
    if (exceeding.length > 0) {
      return res.status(400).json({ error: 'Delivery quantity exceeds current stock for one or more products', exceeding: exceeding.map(l => ({ purchase_order_item_id: l.purchase_order_item_id, requested: l.quantity, current_stock: (productsById.get(l.resolvedProductId) || {}).stock_quantity })) });
    }

    const { count: priorDeliveries } = await supabase.from('pos_company_transfers').select('id', { count: 'exact', head: true }).eq('purchase_order_id', poId);
    const deliveryNumber = (priorDeliveries || 0) + 1;
    const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);

    const { data: delivery, error: delErr } = await supabase.from('pos_company_transfers').insert({
      company_id: req.companyId, receiver_company_id: po.company_id, relationship_id: po.relationship_id,
      transfer_type: 'po_delivery', purchase_order_id: poId, delivery_number: deliveryNumber,
      transfer_number: generateDeliveryNumber(), status: 'sent',
      reference: po.po_number, notes: notes || null, transported_by: transported_by || null, transport_reference: transport_reference || null,
      expected_receive_date: expected_receive_date || null, item_count: lines.length, total_quantity_sent: totalQty,
      sent_by: req.user.userId, sent_at: new Date().toISOString(), dispatched_by: req.user.userId, dispatched_at: new Date().toISOString(),
    }).select().single();
    if (delErr) return res.status(500).json({ error: delErr.message });

    const processedItems = [];
    for (const line of lines) {
      const product = productsById.get(line.resolvedProductId);
      const result = await adjustStockCAS(req.companyId, line.resolvedProductId, -line.quantity, { allowNegative });
      if (!result.ok) console.error('[purchase-orders] stock decrement failed mid-dispatch:', line.resolvedProductId, result.error);

      await supabase.from('pos_company_transfer_items').insert({
        transfer_id: delivery.id, company_id: req.companyId, product_id: line.resolvedProductId,
        receiver_product_id: line.poItem.product_id, product_code: product.product_code || null, barcode: product.barcode || null,
        description: line.poItem.description, quantity_sent: line.quantity, unit_cost: product.cost_price, selling_price: product.unit_price,
        source_stock_before: result.ok ? result.oldQty : null, source_stock_after: result.ok ? result.newQty : null,
      });

      if (!line.poItem.supplier_product_id) {
        await supabase.from('pos_purchase_order_items').update({ supplier_product_id: line.resolvedProductId }).eq('id', line.purchase_order_item_id);
      }

      if (result.ok) {
        await supabase.from('inventory_adjustments').insert({
          company_id: req.companyId, product_id: line.resolvedProductId, adjusted_by: req.user.userId,
          quantity_before: result.oldQty, quantity_change: -line.quantity, quantity_after: result.newQty,
          reason: 'po_delivery_dispatched', notes: `Delivery #${deliveryNumber} for PO ${po.po_number} to company #${po.company_id}`,
        });
        posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, { productId: line.resolvedProductId, beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty }, metadata: { quantity_change: -line.quantity, reason: 'po_delivery_dispatched', purchase_order_id: poId, delivery_id: delivery.id } });
      }
      processedItems.push({ purchase_order_item_id: line.purchase_order_item_id, product_id: line.resolvedProductId, quantity: line.quantity, stock_updated: result.ok });
    }

    // If this delivery, once fully received, would clear all remaining outstanding
    // quantity, flag the order as awaiting its final delivery.
    const { data: refreshedItems } = await supabase.from('pos_purchase_order_items').select('quantity_ordered, quantity_received').eq('purchase_order_id', poId);
    const totalOutstandingBeforeThis = (refreshedItems || []).reduce((sum, i) => sum + Math.max(0, i.quantity_ordered - i.quantity_received), 0);
    let newPoStatus = po.status;
    if (totalOutstandingBeforeThis - totalQty <= 0) newPoStatus = 'awaiting_final_delivery';
    if (newPoStatus !== po.status) {
      await supabase.from('pos_purchase_orders').update({ status: newPoStatus, updated_at: new Date().toISOString() }).eq('id', poId);
    }

    posAuditFromReq(req, POS_EVENTS.PO_DELIVERY_DISPATCHED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, delivery_id: delivery.id, delivery_number: deliveryNumber, item_count: lines.length, total_quantity: totalQty } });

    res.json({ delivery: { ...delivery, items: processedItems } });
  } catch (err) {
    console.error('[purchase-orders] deliveries create:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/deliveries/:deliveryId/receive ──────────────────────────────
router.post('/:id/deliveries/:deliveryId/receive', requirePermission('PURCHASE_ORDERS.RECEIVE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const deliveryId = parseInt(req.params.deliveryId);
    const { items, notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array is required' });

    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const { data: delivery } = await supabase.from('pos_company_transfers').select('*').eq('id', deliveryId).eq('purchase_order_id', poId).maybeSingle();
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    if (!['sent', 'partially_received'].includes(delivery.status)) return res.status(400).json({ error: `Delivery cannot be received in its current status (${delivery.status})` });

    const { data: deliveryItems } = await supabase.from('pos_company_transfer_items').select('*').eq('transfer_id', deliveryId);
    const itemsById = new Map((deliveryItems || []).map(i => [i.id, i]));

    const lines = items
      .map(i => ({ item_id: parseInt(i.item_id), quantity_received: parseInt(i.quantity_received) || 0, quantity_damaged: parseInt(i.quantity_damaged) || 0, quantity_rejected: parseInt(i.quantity_rejected) || 0 }))
      .filter(l => l.item_id > 0 && (l.quantity_received > 0 || l.quantity_damaged > 0 || l.quantity_rejected > 0));
    if (lines.length === 0) return res.status(400).json({ error: 'No items with a received/damaged/rejected quantity greater than zero' });

    const invalid = lines.filter(l => {
      const item = itemsById.get(l.item_id);
      if (!item || item.transfer_id !== deliveryId) return true;
      const claimed = l.quantity_received + l.quantity_damaged + l.quantity_rejected;
      return claimed > (item.quantity_sent - item.quantity_received);
    });
    if (invalid.length > 0) return res.status(400).json({ error: 'Claimed quantity exceeds what remains outstanding for one or more items', invalid: invalid.map(l => l.item_id) });

    let anyVariance = false;
    const discrepancies = [];
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      // Variance for this receive submission: damaged/rejected units never
      // reach usable stock, so they are the shortfall against what was sent.
      const lineVariance = (line.quantity_damaged + line.quantity_rejected) > 0 ? -(line.quantity_damaged + line.quantity_rejected) : 0;

      if (line.quantity_received > 0) {
        const result = await adjustStockCAS(req.companyId, item.receiver_product_id, line.quantity_received, {});
        if (result.ok) {
          await supabase.from('inventory_adjustments').insert({
            company_id: req.companyId, product_id: item.receiver_product_id, adjusted_by: req.user.userId,
            quantity_before: result.oldQty, quantity_change: line.quantity_received, quantity_after: result.newQty,
            reason: 'po_delivery_received', notes: `Delivery #${delivery.delivery_number} for PO ${po.po_number} from company #${po.supplier_company_id}`,
          });
          posAuditFromReq(req, POS_EVENTS.STOCK_ADJUSTED, { productId: item.receiver_product_id, beforeSnapshot: { stock_quantity: result.oldQty }, afterSnapshot: { stock_quantity: result.newQty }, metadata: { quantity_change: line.quantity_received, reason: 'po_delivery_received', purchase_order_id: poId, delivery_id: deliveryId } });
        }
      }

      await supabase.from('pos_company_transfer_items').update({
        quantity_received: item.quantity_received + line.quantity_received,
        quantity_damaged: (item.quantity_damaged || 0) + line.quantity_damaged,
        quantity_rejected: (item.quantity_rejected || 0) + line.quantity_rejected,
        destination_stock_after: null,
      }).eq('id', item.id);

      if (lineVariance !== 0) {
        anyVariance = true;
        const discType = line.quantity_damaged > 0 ? 'damage' : (line.quantity_rejected > 0 ? 'rejection' : 'shortage');
        const { data: disc } = await supabase.from('pos_transfer_discrepancies').insert({
          company_id: req.companyId, transfer_id: deliveryId, item_id: item.id, discrepancy_type: discType,
          variance_quantity: lineVariance, flagged_by: req.user.userId,
          investigation_required: Math.abs(lineVariance) / Math.max(1, item.quantity_sent) * 100 >= VARIANCE_PCT_THRESHOLD,
        }).select().single();
        if (disc) discrepancies.push(disc);
      }
    }

    // Roll received quantity up onto the PO item this delivery item maps to
    // (receiver_product_id was stamped at dispatch time to the customer's own product,
    // but the PO item is the authoritative "ordered" record — find it by product_id).
    for (const line of lines) {
      const item = itemsById.get(line.item_id);
      if (line.quantity_received <= 0) continue;
      const { data: poItem } = await supabase.from('pos_purchase_order_items').select('*').eq('purchase_order_id', poId).eq('product_id', item.receiver_product_id).maybeSingle();
      if (poItem) {
        await supabase.from('pos_purchase_order_items').update({ quantity_received: poItem.quantity_received + line.quantity_received }).eq('id', poItem.id);
      }
    }

    const { data: refreshedDeliveryItems } = await supabase.from('pos_company_transfer_items').select('quantity_sent, quantity_received').eq('transfer_id', deliveryId);
    const deliveryFullyReceived = (refreshedDeliveryItems || []).every(i => i.quantity_received >= i.quantity_sent);
    const deliveryAnyReceived = (refreshedDeliveryItems || []).some(i => i.quantity_received > 0);
    const newDeliveryStatus = deliveryFullyReceived ? (anyVariance ? 'received_with_variance' : 'received') : (deliveryAnyReceived ? 'partially_received' : delivery.status);

    await supabase.from('pos_company_transfers').update({
      status: newDeliveryStatus, received_by: req.user.userId, received_at: new Date().toISOString(),
      investigation_required: discrepancies.some(d => d.investigation_required) || delivery.investigation_required,
      notes: notes ? `${delivery.notes ? delivery.notes + ' | ' : ''}Receive note: ${notes}` : delivery.notes,
      updated_at: new Date().toISOString(),
    }).eq('id', deliveryId);

    const { data: refreshedPoItems } = await supabase.from('pos_purchase_order_items').select('quantity_ordered, quantity_received').eq('purchase_order_id', poId);
    const totalReceived = (refreshedPoItems || []).reduce((sum, i) => sum + i.quantity_received, 0);
    const totalOrdered = (refreshedPoItems || []).reduce((sum, i) => sum + i.quantity_ordered, 0);
    const outstanding = Math.max(0, totalOrdered - totalReceived);
    const poCompleted = outstanding === 0;
    const newPoStatus = poCompleted ? 'completed' : 'partially_fulfilled';

    const { data: updatedPo } = await supabase.from('pos_purchase_orders').update({
      total_received_qty: totalReceived, status: newPoStatus,
      completed_at: poCompleted ? new Date().toISOString() : po.completed_at, updated_at: new Date().toISOString(),
    }).eq('id', poId).select().single();

    posAuditFromReq(req, poCompleted ? POS_EVENTS.PO_FINAL_DELIVERY : POS_EVENTS.PO_PARTIAL_DELIVERY, {
      entityType: 'purchase_order', entityId: poId,
      metadata: { po_number: po.po_number, delivery_id: deliveryId, delivery_number: delivery.delivery_number, total_received_qty: totalReceived, outstanding_qty: outstanding },
    });
    if (anyVariance) {
      posAuditFromReq(req, POS_EVENTS.PO_VARIANCE_DETECTED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, delivery_id: deliveryId, discrepancy_count: discrepancies.length } });
    }

    let invoice = null;
    if (poCompleted && po.invoice_timing === 'after_final_delivery' && !po.invoice_id) {
      invoice = await generatePoInvoice(updatedPo, 'received', req);
    }

    posAuditFromReq(req, POS_EVENTS.PO_DELIVERY_RECEIVED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, delivery_id: deliveryId } });

    res.json({ purchaseOrder: updatedPo, delivery: { id: deliveryId, status: newDeliveryStatus }, discrepancies, invoice });
  } catch (err) {
    console.error('[purchase-orders] deliveries receive:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /:id/deliveries/:deliveryId/resolve-variance ─────────────────────
router.post('/:id/deliveries/:deliveryId/resolve-variance', requirePermission('PURCHASE_ORDERS.APPROVE'), async (req, res) => {
  try {
    const poId = parseInt(req.params.id);
    const deliveryId = parseInt(req.params.deliveryId);
    const { discrepancy_id, resolution_reason, resolution_notes } = req.body;
    if (!discrepancy_id || !resolution_reason) return res.status(400).json({ error: 'discrepancy_id and resolution_reason are required' });

    const { data: po } = await supabase.from('pos_purchase_orders').select('*').eq('id', poId).eq('company_id', req.companyId).maybeSingle();
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const { data: disc } = await supabase.from('pos_transfer_discrepancies').select('*').eq('id', discrepancy_id).eq('transfer_id', deliveryId).maybeSingle();
    if (!disc) return res.status(404).json({ error: 'Discrepancy not found' });
    if (disc.resolved_at) return res.status(400).json({ error: 'This discrepancy has already been resolved' });

    const { data: updated } = await supabase.from('pos_transfer_discrepancies').update({
      resolution_reason, resolution_notes: resolution_notes || null, resolved_by: req.user.userId, resolved_at: new Date().toISOString(),
    }).eq('id', discrepancy_id).select().single();

    posAuditFromReq(req, POS_EVENTS.PO_VARIANCE_RESOLVED, { entityType: 'purchase_order', entityId: poId, metadata: { po_number: po.po_number, delivery_id: deliveryId, discrepancy_id, resolution_reason } });

    res.json({ discrepancy: updated });
  } catch (err) {
    console.error('[purchase-orders] resolve-variance:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
