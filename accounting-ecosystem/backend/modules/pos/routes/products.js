/**
 * ============================================================================
 * POS Products Routes - Checkout Charlie Module
 * ============================================================================
 * Product CRUD with company isolation and price-change auditing.
 *
 * Field names match the Supabase schema (products table):
 *   product_name  — display name  (frontend sends: product_name)
 *   product_code  — unique SKU    (frontend sends: product_code)
 *   unit_price    — selling price (frontend sends: unit_price)
 *   cost_price    — cost / buy-in price
 *   min_stock_level — reorder threshold
 *   requires_vat  — boolean VAT flag
 *   vat_rate      — VAT %
 *   category      — category string (denormalised for speed)
 *   category_id   — FK to categories table
 *   barcode       — EAN/UPC barcode
 *   sku           — additional SKU reference (added via pos-schema.js)
 *   unit          — unit of measure (added via pos-schema.js)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/products
 */
router.get('/', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { category_id, search, active_only } = req.query;

    const buildQuery = () => {
      let query = supabase
        .from('products')
        .select('*, categories(name)')
        .eq('company_id', req.companyId);

      if (active_only !== 'false') query = query.eq('is_active', true);
      if (category_id) query = query.eq('category_id', category_id);
      if (search) {
        query = query.or(
          `product_name.ilike.%${search}%,barcode.ilike.%${search}%,product_code.ilike.%${search}%`
        );
      }

      return query.order('product_name');
    };

    // PostgREST caps unranged queries at its configured max-rows (1000 by
    // default). A company can have more products than that, so page through
    // with .range() until a batch comes back short of the page size.
    const PAGE_SIZE = 1000;
    let data = [];
    let from = 0;
    while (true) {
      const { data: page, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
      if (error) return res.status(500).json({ error: error.message });
      data = data.concat(page || []);
      if (!page || page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    // Attach today's active daily discount (if any) to each matching product.
    // This is the ONLY thing that makes a discount created via POST
    // /api/pos/discounts actually affect what the till charges — until this,
    // discounts.js could save a discount row but nothing ever read it back
    // into a price a cashier would see or charge. Same is_active/valid_from/
    // valid_until predicate as discounts.js's default GET (must stay in sync
    // with that route — there is no shared date-window helper for this single
    // three-condition predicate, but if either changes, check the other).
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const { data: activeDiscounts } = await supabase
      .from('pos_daily_discounts')
      .select('product_id, discount_type, discount_value, valid_until, reason')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .or(`valid_from.is.null,valid_from.lte.${today}`)
      .or(`valid_until.is.null,valid_until.gte.${today}`);

    if (activeDiscounts && activeDiscounts.length > 0) {
      const discountByProduct = new Map(activeDiscounts.map(d => [d.product_id, d]));
      data = data.map(p => {
        const d = discountByProduct.get(p.id);
        if (!d) return p;
        const original = parseFloat(p.unit_price) || 0;
        const discounted = d.discount_type === 'percent'
          ? original * (1 - parseFloat(d.discount_value) / 100)
          : original - parseFloat(d.discount_value);
        return {
          ...p,
          discount_price: Math.max(0, Math.round(discounted * 100) / 100),
          active_discount: { type: d.discount_type, value: parseFloat(d.discount_value), valid_until: d.valid_until, reason: d.reason },
        };
      });
    }

    // Private cache: browser may serve the product list for up to 60 s without
    // re-fetching, then revalidate in the background for 30 s more.
    // Applies to GET only — POST/PUT/DELETE are not cached.
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
    res.json({ products: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/products/:id
 */
router.get('/:id', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*, categories(name)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/products
 */
router.post('/', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
  try {
    const {
      product_name, product_code, description, barcode, sku,
      category, category_id,
      cost_price, unit_price,
      stock_quantity, min_stock_level,
      requires_vat, vat_rate, unit
    } = req.body;

    if (!product_name || unit_price === undefined) {
      return res.status(400).json({ error: 'product_name and unit_price are required' });
    }
    if (unit_price < 0) {
      return res.status(400).json({ error: 'unit_price must be non-negative' });
    }

    // Auto-generate product_code if not provided
    const code = product_code || `PRO-${Date.now()}`;

    const { data, error } = await supabase
      .from('products')
      .insert({
        company_id:      req.companyId,
        product_name,
        product_code:    code,
        description:     description || null,
        barcode:         barcode || null,
        sku:             sku || null,
        category:        category || null,
        category_id:     category_id || null,
        cost_price:      cost_price != null ? cost_price : 0,
        unit_price,
        stock_quantity:  stock_quantity != null ? stock_quantity : 0,
        min_stock_level: min_stock_level != null ? min_stock_level : 10,
        requires_vat:    requires_vat != null ? Boolean(requires_vat) : true,
        vat_rate:        vat_rate != null ? vat_rate : 15,
        unit:            unit || 'each',
        is_active:       true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'product', data.id, {
      module: 'pos',
      newValue: { product_name, unit_price, barcode }
    });
    posAuditFromReq(req, POS_EVENTS.PRODUCT_CREATED, {
      productId:     data.id,
      afterSnapshot: { product_id: data.id, product_name, product_code: data.product_code, unit_price, stock_quantity: data.stock_quantity },
    });

    res.status(201).json({ product: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/products/:id
 * Includes PRICE_CHANGE audit for compliance.
 */
router.put('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const id = req.params.id;

    const { data: old } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Product not found' });

    const allowed = [
      'product_name', 'product_code', 'description', 'barcode', 'sku',
      'category', 'category_id',
      'cost_price', 'unit_price',
      'stock_quantity', 'min_stock_level',
      'requires_vat', 'vat_rate', 'unit', 'is_active'
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Compliance audit: track price changes
    if (updates.unit_price !== undefined && old.unit_price !== updates.unit_price) {
      await auditFromReq(req, 'PRICE_CHANGE', 'product', id, {
        module: 'pos',
        fieldName: 'unit_price',
        oldValue: old.unit_price,
        newValue: updates.unit_price,
        metadata: { product_name: old.product_name }
      });
      posAuditFromReq(req, POS_EVENTS.PRODUCT_PRICE_CHANGED, {
        productId:      id,
        beforeSnapshot: { field: 'unit_price', value: old.unit_price, product_name: old.product_name },
        afterSnapshot:  { field: 'unit_price', value: updates.unit_price },
      });
    }
    if (updates.cost_price !== undefined && old.cost_price !== updates.cost_price) {
      await auditFromReq(req, 'PRICE_CHANGE', 'product', id, {
        module: 'pos',
        fieldName: 'cost_price',
        oldValue: old.cost_price,
        newValue: updates.cost_price,
        metadata: { product_name: old.product_name }
      });
      posAuditFromReq(req, POS_EVENTS.PRODUCT_PRICE_CHANGED, {
        productId:      id,
        beforeSnapshot: { field: 'cost_price', value: old.cost_price, product_name: old.product_name },
        afterSnapshot:  { field: 'cost_price', value: updates.cost_price },
      });
    }

    await auditFromReq(req, 'UPDATE', 'product', id, {
      module: 'pos',
      oldValue: old,
      newValue: data
    });
    posAuditFromReq(req, POS_EVENTS.PRODUCT_UPDATED, {
      productId:      id,
      beforeSnapshot: { product_name: old.product_name, unit_price: old.unit_price, is_active: old.is_active },
      afterSnapshot:  { product_name: data.product_name, unit_price: data.unit_price, is_active: data.is_active },
      metadata:       { fields_changed: Object.keys(updates).filter(k => k !== 'updated_at') },
    });

    res.json({ product: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/products/next-code/:prefix
 * Generate the next product code with given prefix.
 */
router.post('/next-code/:prefix', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
  try {
    const prefix = req.params.prefix || 'PRO';

    const { data: settings } = await supabase
      .from('company_settings')
      .select('product_code_prefix')
      .eq('company_id', req.companyId)
      .maybeSingle();

    const codePrefix = settings?.product_code_prefix || prefix;

    const { data: products } = await supabase
      .from('products')
      .select('product_code')
      .eq('company_id', req.companyId)
      .ilike('product_code', `${codePrefix}%`)
      .order('product_code', { ascending: false })
      .limit(1);

    let nextNum = 1;
    if (products && products.length > 0) {
      const lastCode = products[0].product_code;
      const numPart = parseInt(lastCode.replace(codePrefix, '')) || 0;
      nextNum = numPart + 1;
    }

    const nextCode = `${codePrefix}${String(nextNum).padStart(4, '0')}`;
    res.json({ code: nextCode, prefix: codePrefix });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/products/:id/stock-by-location
 * Returns stock level. Multi-location is a future feature.
 */
router.get('/:id/stock-by-location', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('id, product_name, stock_quantity')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !product) return res.status(404).json({ error: 'Product not found' });

    res.json({
      product_id:   product.id,
      product_name: product.product_name,
      locations: [{ location: 'Main Store', stock_quantity: product.stock_quantity }],
      total_stock:  product.stock_quantity
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/products/:id (soft delete)
 */
router.delete('/:id', requirePermission('PRODUCTS.DELETE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'product', req.params.id, { module: 'pos' });
    posAuditFromReq(req, POS_EVENTS.PRODUCT_DEACTIVATED, {
      productId:      req.params.id,
      beforeSnapshot: { is_active: true },
      afterSnapshot:  { is_active: false },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
