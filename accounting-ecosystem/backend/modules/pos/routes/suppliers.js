/**
 * ============================================================================
 * POS Suppliers Routes — Checkout Charlie
 * ============================================================================
 * Supplier list + product-supplier link management.
 *
 * Routes:
 *   GET    /api/pos/suppliers                         — list suppliers
 *   GET    /api/pos/suppliers/:id/products            — get linked products
 *   PUT    /api/pos/suppliers/:id/products            — replace linked products
 *
 * Product-supplier links live in product_suppliers (migration 039).
 * Company isolation enforced on every query via req.companyId.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');

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
 * Get all products linked to this supplier.
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
      .select('product_id, products(id, product_name, product_code, barcode, stock_quantity, unit_price)')
      .eq('company_id', req.companyId)
      .eq('supplier_id', supplierId);

    if (error) return res.status(500).json({ error: error.message });

    const products = (data || [])
      .map(row => row.products)
      .filter(Boolean)
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    res.json({ supplier, products });
  } catch (err) {
    console.error('[suppliers] get-products:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/suppliers/:id/products
 * Replace the full set of products linked to this supplier.
 * Body: { product_ids: [1, 2, 3] }
 *
 * Deletes all existing links then inserts the provided set.
 * Passing an empty array unlinks all products.
 */
router.put('/:id/products', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const supplierId = parseInt(req.params.id);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const productIds = (req.body.product_ids || [])
      .map(id => parseInt(id))
      .filter(id => id > 0);

    // Verify supplier belongs to this company
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('id, supplier_name, name')
      .eq('id', supplierId)
      .eq('company_id', req.companyId)
      .single();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Verify all submitted product_ids belong to this company
    if (productIds.length > 0) {
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

    // Replace link set atomically: delete all, re-insert
    const { error: delErr } = await supabase
      .from('product_suppliers')
      .delete()
      .eq('company_id', req.companyId)
      .eq('supplier_id', supplierId);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (productIds.length > 0) {
      const rows = productIds.map(pid => ({
        company_id:  req.companyId,
        product_id:  pid,
        supplier_id: supplierId,
      }));
      const { error: insErr } = await supabase.from('product_suppliers').insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }

    res.json({ supplier_id: supplierId, product_count: productIds.length });
  } catch (err) {
    console.error('[suppliers] put-products:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
