/**
 * ============================================================================
 * POS Suppliers Routes — Checkout Charlie
 * ============================================================================
 * Supplier list + product-supplier link management.
 *
 * Routes:
 *   GET    /api/pos/suppliers                         — list suppliers (search/filter)
 *   POST   /api/pos/suppliers                         — create supplier
 *   PUT    /api/pos/suppliers/:id                      — edit supplier
 *   PATCH  /api/pos/suppliers/:id/deactivate           — archive supplier
 *   PATCH  /api/pos/suppliers/:id/activate             — restore an archived supplier
 *   POST   /api/pos/suppliers/:id/link-company         — request a cross-company link
 *                                                         by invitation code (Workstream 80)
 *   GET    /api/pos/suppliers/:id/products            — get linked products
 *                                                         (with per-link price
 *                                                         tracking + current stock)
 *   PUT    /api/pos/suppliers/:id/products            — save linked products
 *                                                         (diff-based upsert)
 *
 * Product-supplier links live in product_suppliers (migration 039; extended
 * with price-tracking columns in Workstream 78 — see pos-schema.js).
 * Cross-company linking reuses the existing shared inter_company_relationships
 * table (accounting's inter-company module) — see linked_company_id/
 * linked_relationship_id/link_status columns added in Workstream 80 and
 * docs/checkout-charlie-future/INTER_COMPANY_CUSTOMER_SUPPLIER_LINKING.md.
 * Company isolation enforced on every query via req.companyId.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const InterCompanyNetwork = require('../../../inter-company/network');
const { supabaseSeanStore } = require('../../../sean/supabase-store');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

function getNetwork() {
  return new InterCompanyNetwork(supabaseSeanStore);
}

function generateSupplierCode() {
  return 'SUP-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
}

/**
 * GET /api/pos/suppliers
 * List suppliers for this company. Active only by default.
 * Query params:
 *   search           — matches supplier_name/name/supplier_code/contact_name (case-insensitive)
 *   include_inactive  — 'true' to also return archived suppliers
 */
router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { search, include_inactive } = req.query;

    let query = supabase
      .from('suppliers')
      .select('id, supplier_code, supplier_name, name, contact_name, contact_email, email, contact_phone, phone, address, payment_terms, notes, is_active, linked_company_id, link_status, created_at')
      .eq('company_id', req.companyId);

    if (include_inactive !== 'true') query = query.eq('is_active', true);

    if (search && search.trim()) {
      const term = search.trim().replace(/[%_]/g, '');
      query = query.or(`supplier_name.ilike.%${term}%,name.ilike.%${term}%,supplier_code.ilike.%${term}%,contact_name.ilike.%${term}%`);
    }

    const { data, error } = await query.order('supplier_name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ suppliers: data || [] });
  } catch (err) {
    console.error('[suppliers] list:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/suppliers
 * Create a supplier. supplier_code auto-generated if not provided.
 */
router.post('/', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { supplier_name, contact_name, contact_email, contact_phone, address, payment_terms, notes, supplier_code } = req.body;
    if (!supplier_name || !supplier_name.trim()) {
      return res.status(400).json({ error: 'supplier_name is required' });
    }

    const row = {
      company_id:    req.companyId,
      supplier_code: (supplier_code && supplier_code.trim()) || generateSupplierCode(),
      supplier_name: supplier_name.trim(),
      name:          supplier_name.trim(),
      contact_name:  contact_name || null,
      contact_email: contact_email || null,
      email:         contact_email || null,
      contact_phone: contact_phone || null,
      phone:         contact_phone || null,
      address:       address || null,
      payment_terms: payment_terms != null && payment_terms !== '' ? parseInt(payment_terms) : 30,
      notes:         notes || null,
      is_active:     true,
    };

    const { data, error } = await supabase.from('suppliers').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_CREATED, {
      entityType: 'supplier',
      entityId:   data.id,
      metadata:   { supplier_name: data.supplier_name, supplier_code: data.supplier_code },
    });

    res.json({ supplier: data });
  } catch (err) {
    console.error('[suppliers] create:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/suppliers/:id
 * Edit an existing supplier's details (not its product links — see /:id/products).
 */
router.put('/:id', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const { data: existing } = await supabase
      .from('suppliers').select('*').eq('id', supplierId).eq('company_id', req.companyId).single();
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    const { supplier_name, contact_name, contact_email, contact_phone, address, payment_terms, notes, supplier_code } = req.body;
    if (supplier_name !== undefined && !supplier_name.trim()) {
      return res.status(400).json({ error: 'supplier_name cannot be empty' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (supplier_name !== undefined) { updates.supplier_name = supplier_name.trim(); updates.name = supplier_name.trim(); }
    if (contact_name !== undefined)  updates.contact_name = contact_name || null;
    if (contact_email !== undefined) { updates.contact_email = contact_email || null; updates.email = contact_email || null; }
    if (contact_phone !== undefined) { updates.contact_phone = contact_phone || null; updates.phone = contact_phone || null; }
    if (address !== undefined)       updates.address = address || null;
    if (payment_terms !== undefined) updates.payment_terms = payment_terms !== '' ? parseInt(payment_terms) : null;
    if (notes !== undefined)         updates.notes = notes || null;
    if (supplier_code !== undefined && supplier_code.trim()) updates.supplier_code = supplier_code.trim();

    const { data, error } = await supabase.from('suppliers').update(updates).eq('id', supplierId).eq('company_id', req.companyId).select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_UPDATED, {
      entityType: 'supplier',
      entityId:   supplierId,
      beforeSnapshot: { supplier_name: existing.supplier_name, contact_name: existing.contact_name, contact_email: existing.contact_email, contact_phone: existing.contact_phone },
      afterSnapshot:  { supplier_name: data.supplier_name, contact_name: data.contact_name, contact_email: data.contact_email, contact_phone: data.contact_phone },
    });

    res.json({ supplier: data });
  } catch (err) {
    console.error('[suppliers] update:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/pos/suppliers/:id/deactivate
 * Archive a supplier (soft delete — is_active = false). Existing product
 * links, receive/return history, and any company link are left untouched.
 */
router.patch('/:id/deactivate', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const { data, error } = await supabase
      .from('suppliers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', supplierId).eq('company_id', req.companyId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Supplier not found' });

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_DEACTIVATED, {
      entityType: 'supplier', entityId: supplierId,
      metadata: { supplier_name: data.supplier_name },
    });

    res.json({ supplier: data });
  } catch (err) {
    console.error('[suppliers] deactivate:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/pos/suppliers/:id/activate
 * Restore a previously archived supplier.
 */
router.patch('/:id/activate', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const { data, error } = await supabase
      .from('suppliers')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', supplierId).eq('company_id', req.companyId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Supplier not found' });

    posAuditFromReq(req, POS_EVENTS.SUPPLIER_REACTIVATED, {
      entityType: 'supplier', entityId: supplierId,
      metadata: { supplier_name: data.supplier_name },
    });

    res.json({ supplier: data });
  } catch (err) {
    console.error('[suppliers] activate:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/suppliers/:id/link-company
 * Request a cross-company link for this supplier using another company's
 * invitation code (Workstream 80 — Turkstra/Pennygrow foundation).
 *
 * Body: { invitationCode }
 *
 * Looks the code up via the shared InterCompanyNetwork (same engine used by
 * the accounting inter-company invoice module — one relationship record
 * covers both use cases, see permissions JSON). Creates a PENDING
 * relationship; nothing is shared or activated until the other company
 * confirms via their own side. Only safe preview info (name/city/industry)
 * is ever returned — never the target company's financial/contact details.
 */
router.post('/:id/link-company', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });
    const invitationCode = (req.body.invitationCode || '').trim();
    if (!invitationCode) return res.status(400).json({ error: 'invitationCode is required' });

    const { data: supplier } = await supabase
      .from('suppliers').select('*').eq('id', supplierId).eq('company_id', req.companyId).single();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (supplier.link_status === 'active' || supplier.link_status === 'pending') {
      return res.status(400).json({ error: `This supplier already has a ${supplier.link_status} company link. Revoke it first.` });
    }

    const network = getNetwork();
    const matches = await network.findCompanies({ invitationCode }, req.companyId);
    const match = matches.find(m => m.matchType === 'invitation_code');
    if (!match) return res.status(404).json({ error: 'No company found for that invitation code' });

    const result = await network.createRelationship(req.companyId, match.companyId, req.companyId, {
      stock_transfer: false, receive_transfer: false, return_transfer: false,
      pricing_visible: false, invoice_reference_visible: false,
    });
    if (!result.success) return res.status(400).json(result);

    const { data: updatedSupplier, error: updErr } = await supabase
      .from('suppliers')
      .update({
        linked_company_id:      match.companyId,
        linked_relationship_id: result.relationship.id,
        link_status:             'pending',
        updated_at:              new Date().toISOString(),
      })
      .eq('id', supplierId).eq('company_id', req.companyId)
      .select().single();
    if (updErr) return res.status(500).json({ error: updErr.message });

    posAuditFromReq(req, POS_EVENTS.COMPANY_RELATIONSHIP_REQUESTED, {
      entityType: 'supplier', entityId: supplierId,
      metadata: { relationship_id: result.relationship.id, target_company_name: match.companyName },
    });

    res.json({
      supplier: updatedSupplier,
      linked_company: { id: match.companyId, name: match.companyName },
      relationship_status: 'pending',
      message: 'Link request sent. The other company must approve before any data is shared.',
    });
  } catch (err) {
    console.error('[suppliers] link-company:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/suppliers/:id/products
 * Get all products linked to this supplier, including per-link price-tracking
 * metadata (supplier SKU, last purchase price/date, preferred flag, notes) and
 * each product's current stock/cost — used by both the "Manage Linked
 * Products" screen and the "Receive from Supplier" / "Return to Supplier"
 * screens (same data shape, three consumers — kept in one endpoint).
 */
router.get('/:id/products', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    // Verify supplier belongs to this company
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('id, supplier_name, name')
      .eq('id', supplierId)
      .eq('company_id', req.companyId)
      .single();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const { data, error } = await supabase
      .from('product_suppliers')
      .select(`
        id, product_id, supplier_sku, last_purchase_price, last_purchase_date,
        preferred_supplier, notes,
        products(id, product_name, product_code, barcode, stock_quantity, unit_price, cost_price)
      `)
      .eq('company_id', req.companyId)
      .eq('supplier_id', supplierId);

    if (error) return res.status(500).json({ error: error.message });

    const products = (data || [])
      .filter(row => row.products)
      .map(row => ({
        ...row.products,
        link_id:              row.id,
        supplier_sku:         row.supplier_sku,
        last_purchase_price:  row.last_purchase_price,
        last_purchase_date:   row.last_purchase_date,
        preferred_supplier:   row.preferred_supplier,
        notes:                row.notes,
      }))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    res.json({ supplier, products });
  } catch (err) {
    console.error('[suppliers] get-products:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/suppliers/:id/products
 * Save the linked-product set for this supplier, diffed against the current
 * set so price-tracking history is never destroyed on an unrelated edit.
 *
 * Body: { links: [{ product_id, supplier_sku, preferred_supplier, notes }] }
 *
 * - Products present now but not in the new set are unlinked (deleted).
 * - Products newly present are linked (inserted, no price history yet).
 * - Products present in both only have supplier_sku/preferred_supplier/notes
 *   updated — last_purchase_price/last_purchase_date are preserved untouched,
 *   since they are populated by the receive flow, not this screen.
 */
router.put('/:id/products', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const links = (Array.isArray(req.body.links) ? req.body.links : [])
      .map(l => ({
        product_id:         parseInt(l.product_id),
        supplier_sku:       l.supplier_sku ? String(l.supplier_sku).trim().slice(0, 100) : null,
        preferred_supplier: !!l.preferred_supplier,
        notes:              l.notes ? String(l.notes).trim() : null,
      }))
      .filter(l => l.product_id > 0);

    // Verify supplier belongs to this company
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('id, supplier_name, name')
      .eq('id', supplierId)
      .eq('company_id', req.companyId)
      .single();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Verify all submitted product_ids belong to this company
    if (links.length > 0) {
      const productIds = links.map(l => l.product_id);
      const { data: validProducts } = await supabase
        .from('products')
        .select('id')
        .eq('company_id', req.companyId)
        .in('id', productIds);
      const validIds = new Set((validProducts || []).map(p => p.id));
      const invalid = productIds.filter(id => !validIds.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Product IDs not found for this company: ${invalid.join(', ')}` });
      }
    }

    const { data: existingRows, error: existingErr } = await supabase
      .from('product_suppliers')
      .select('id, product_id')
      .eq('company_id', req.companyId)
      .eq('supplier_id', supplierId);
    if (existingErr) return res.status(500).json({ error: existingErr.message });

    const existingByProduct = new Map((existingRows || []).map(r => [r.product_id, r]));
    const newByProduct      = new Map(links.map(l => [l.product_id, l]));

    const toUnlink = (existingRows || []).filter(r => !newByProduct.has(r.product_id));
    const toInsert = links.filter(l => !existingByProduct.has(l.product_id));
    const toUpdate = links.filter(l => existingByProduct.has(l.product_id));

    if (toUnlink.length > 0) {
      const { error: delErr } = await supabase
        .from('product_suppliers')
        .delete()
        .in('id', toUnlink.map(r => r.id));
      if (delErr) return res.status(500).json({ error: delErr.message });
    }

    if (toInsert.length > 0) {
      const rows = toInsert.map(l => ({
        company_id:         req.companyId,
        supplier_id:        supplierId,
        product_id:         l.product_id,
        supplier_sku:       l.supplier_sku,
        preferred_supplier: l.preferred_supplier,
        notes:              l.notes,
      }));
      const { error: insErr } = await supabase.from('product_suppliers').insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }

    for (const l of toUpdate) {
      const row = existingByProduct.get(l.product_id);
      await supabase
        .from('product_suppliers')
        .update({
          supplier_sku:       l.supplier_sku,
          preferred_supplier: l.preferred_supplier,
          notes:              l.notes,
          updated_at:         new Date().toISOString(),
        })
        .eq('id', row.id);
    }

    for (const r of toUnlink) {
      posAuditFromReq(req, POS_EVENTS.SUPPLIER_PRODUCT_UNLINKED, {
        productId: r.product_id,
        metadata:  { supplier_id: supplierId, supplier_name: supplier.supplier_name || supplier.name },
      });
    }
    for (const l of toInsert) {
      posAuditFromReq(req, POS_EVENTS.SUPPLIER_PRODUCT_LINKED, {
        productId: l.product_id,
        metadata:  { supplier_id: supplierId, supplier_name: supplier.supplier_name || supplier.name, supplier_sku: l.supplier_sku },
      });
    }

    res.json({ supplier_id: supplierId, product_count: links.length, linked: toInsert.length, unlinked: toUnlink.length, updated: toUpdate.length });
  } catch (err) {
    console.error('[suppliers] put-products:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
