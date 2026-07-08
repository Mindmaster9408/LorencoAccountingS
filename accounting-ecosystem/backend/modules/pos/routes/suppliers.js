/**
 * ============================================================================
 * POS Suppliers Routes — Checkout Charlie
 * ============================================================================
 * Supplier list + product-supplier link management.
 *
 * Routes:
 *   GET    /api/pos/suppliers                         — list suppliers
 *   GET    /api/pos/suppliers/:id/products            — get linked products
 *                                                         (with per-link price
 *                                                         tracking + current stock)
 *   PUT    /api/pos/suppliers/:id/products            — save linked products
 *                                                         (diff-based upsert)
 *
 * Product-supplier links live in product_suppliers (migration 039; extended
 * with price-tracking columns in Workstream 78 — see pos-schema.js).
 * Company isolation enforced on every query via req.companyId.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/suppliers
 * List active suppliers for this company.
 */
router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('suppliers')
      .select('id, supplier_code, supplier_name, name, contact_name, contact_email, email, contact_phone, phone, is_active')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('supplier_name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ suppliers: data || [] });
  } catch (err) {
    console.error('[suppliers] list:', err.message);
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
