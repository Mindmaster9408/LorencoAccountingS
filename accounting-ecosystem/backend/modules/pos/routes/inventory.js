/**
 * ============================================================================
 * POS Inventory Routes - Checkout Charlie Module
 * ============================================================================
 * Stock level queries and manual adjustments.
 *
 * Table used for adjustments: inventory_adjustments
 *   (created by pos-schema.js auto-migration on startup)
 *
 * Column names match the products schema:
 *   product_name, unit_price, min_stock_level
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/inventory
 * Get stock levels for all products, optionally filtered to low-stock items.
 */
router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { low_stock } = req.query;

    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, barcode, product_code, stock_quantity, min_stock_level, cost_price, unit_price, category_id, category, categories(name)')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('product_name');

    if (error) return res.status(500).json({ error: error.message });

    let products = data || [];
    if (low_stock === 'true') {
      products = products.filter(p => p.stock_quantity <= (p.min_stock_level ?? 10));
    }

    res.json({ inventory: products });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/inventory/adjust
 * Manual stock adjustment — records to inventory_adjustments table.
 */
router.post('/adjust', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const { product_id, quantity_change, reason, notes } = req.body;

    if (!product_id || quantity_change === undefined) {
      return res.status(400).json({ error: 'product_id and quantity_change are required' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required for stock adjustments' });
    }

    // Get current stock — must belong to this company
    const { data: product } = await supabase
      .from('products')
      .select('stock_quantity, product_name')
      .eq('id', product_id)
      .eq('company_id', req.companyId)
      .single();

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const oldQty = product.stock_quantity;
    const newQty = Math.max(0, oldQty + quantity_change);

    // Update stock
    const { error: updateErr } = await supabase
      .from('products')
      .update({ stock_quantity: newQty, updated_at: new Date().toISOString() })
      .eq('id', product_id)
      .eq('company_id', req.companyId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Record adjustment in inventory_adjustments
    // (table created by pos-schema.js migration)
    const { data: adj, error: adjErr } = await supabase
      .from('inventory_adjustments')
      .insert({
        company_id:      req.companyId,
        product_id,
        adjusted_by:     req.user.userId,
        quantity_before: oldQty,
        quantity_change,
        quantity_after:  newQty,
        reason:          reason || 'manual',
        notes:           notes || null,
      })
      .select()
      .single();

    if (adjErr) return res.status(500).json({ error: adjErr.message });

    await auditFromReq(req, 'UPDATE', 'inventory', product_id, {
      module:    'pos',
      fieldName: 'stock_quantity',
      oldValue:  oldQty,
      newValue:  newQty,
      metadata:  { product_name: product.product_name, reason }
    });

    res.json({ adjustment: adj });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/inventory/adjustments
 * List stock adjustment history for this company.
 */
router.get('/adjustments', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inventory_adjustments')
      .select('*, products(product_name, barcode)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ adjustments: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
