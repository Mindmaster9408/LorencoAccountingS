/**
 * ============================================================================
 * POS Daily Discounts Routes - Checkout Charlie Module
 * ============================================================================
 * Per-product promotional discounts with optional date range.
 * Replaces the hardcoded stub that was in pos/index.js.
 *
 * Table: pos_daily_discounts (created by pos-schema.js auto-migration)
 *   discount_type  — 'fixed' (R amount off) or 'percent' (% off)
 *   discount_value — amount or percentage
 *   valid_from     — optional start date
 *   valid_until    — optional end date (inclusive)
 *   is_active      — soft toggle
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
 * GET /api/pos/discounts/performance
 * Sales performance for every discount on record (active or expired) —
 * units sold, revenue, cost, and profit while that specific discount was in
 * effect. Powers the Dashboard's "Daily Discounts" panel. Registered before
 * GET /:id would be (there is no GET /:id in this file, but keep it above
 * one if ever added, so Express doesn't try to parse "performance" as an id).
 *
 * Gated on REPORTS.VIEW, matching every other Dashboard data source — the
 * Dashboard tab is already hidden for roles without it (see
 * applyRoleBasedVisibility() in index.html), so this stays consistent with
 * "every widget on that tab requires the same permission" rather than
 * introducing a new one.
 */
router.get('/performance', requirePermission('REPORTS.VIEW'), async (req, res) => {
  try {
    const { data: discounts, error: discErr } = await supabase
      .from('pos_daily_discounts')
      .select('*, products(product_name, product_code, unit_price, cost_price)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (discErr) return res.status(500).json({ error: discErr.message });

    const today = new Date().toISOString().split('T')[0];

    // Per discount: sum sale_items for that product within the discount's own
    // effective window (valid_from → valid_until, defaulting to created_at →
    // now where either bound is open-ended), completed sales only. Run in
    // parallel — each is a small, single-product/date-window query, not a
    // table scan, so this doesn't need the pagination helper reports.js uses
    // for whole-table queries.
    const results = await Promise.all((discounts || []).map(async (d) => {
      const windowStart = d.valid_from || d.created_at;
      const windowEnd   = d.valid_until ? `${d.valid_until}T23:59:59.999Z` : new Date().toISOString();

      const { data: saleItems, error: siErr } = await supabase
        .from('sale_items')
        .select('quantity, line_total, sales!inner(company_id, status, created_at)')
        .eq('product_id', d.product_id)
        .eq('sales.company_id', req.companyId)
        .eq('sales.status', 'completed')
        .gte('sales.created_at', windowStart)
        .lte('sales.created_at', windowEnd);
      if (siErr) throw new Error(siErr.message);

      const unitsSold = (saleItems || []).reduce((sum, i) => sum + (parseFloat(i.quantity) || 0), 0);
      // Revenue matches this app's existing gross-profit convention
      // (reports.js fetchSalesWithProfit): VAT-inclusive line_total minus
      // cost, not VAT-exclusive — kept consistent with every other profit
      // figure this app already shows rather than introducing a second,
      // differently-computed "profit" definition.
      const revenue   = (saleItems || []).reduce((sum, i) => sum + (parseFloat(i.line_total) || 0), 0);
      const costPrice = parseFloat(d.products?.cost_price || 0);
      const cost      = costPrice * unitsSold;
      const profit    = Math.round((revenue - cost) * 100) / 100;
      const originalPrice = parseFloat(d.products?.unit_price || 0);
      const discountedPrice = d.discount_type === 'percent'
        ? originalPrice * (1 - parseFloat(d.discount_value) / 100)
        : originalPrice - parseFloat(d.discount_value);

      return {
        id: d.id,
        product_id: d.product_id,
        product_name: d.products?.product_name || 'Unknown product',
        product_code: d.products?.product_code || null,
        discount_type: d.discount_type,
        discount_value: parseFloat(d.discount_value),
        original_price: Math.round(originalPrice * 100) / 100,
        discounted_price: Math.max(0, Math.round(discountedPrice * 100) / 100),
        reason: d.reason,
        valid_from: d.valid_from,
        valid_until: d.valid_until,
        is_active: d.is_active && (!d.valid_from || d.valid_from <= today) && (!d.valid_until || d.valid_until >= today),
        units_sold: unitsSold,
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        profit,
        is_profitable: profit > 0,
      };
    }));

    const summary = {
      totalDiscounts:  results.length,
      activeCount:     results.filter(r => r.is_active).length,
      totalUnitsSold:  results.reduce((sum, r) => sum + r.units_sold, 0),
      totalRevenue:    Math.round(results.reduce((sum, r) => sum + r.revenue, 0) * 100) / 100,
      totalCost:       Math.round(results.reduce((sum, r) => sum + r.cost, 0) * 100) / 100,
      totalProfit:     Math.round(results.reduce((sum, r) => sum + r.profit, 0) * 100) / 100,
    };
    summary.isProfitable = summary.totalProfit > 0;

    res.json({ discounts: results, summary });
  } catch (err) {
    console.error('[discounts] performance:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/discounts
 * List all active discounts for today (or all if ?all=true).
 */
router.get('/', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const showAll = req.query.all === 'true';

    let query = supabase
      .from('pos_daily_discounts')
      .select('*, products(product_name, product_code, unit_price, barcode)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });

    if (!showAll) {
      query = query
        .eq('is_active', true)
        .or(`valid_from.is.null,valid_from.lte.${today}`)
        .or(`valid_until.is.null,valid_until.gte.${today}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ discounts: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/discounts
 * Create a new discount.
 */
router.post('/', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { product_id, discount_type, discount_value, valid_from, valid_until, reason } = req.body;

    if (!product_id || discount_value === undefined) {
      return res.status(400).json({ error: 'product_id and discount_value are required' });
    }
    if (!['fixed', 'percent'].includes(discount_type)) {
      return res.status(400).json({ error: "discount_type must be 'fixed' or 'percent'" });
    }
    if (discount_value <= 0) {
      return res.status(400).json({ error: 'discount_value must be positive' });
    }
    if (discount_type === 'percent' && discount_value > 100) {
      return res.status(400).json({ error: 'Percentage discount cannot exceed 100' });
    }

    // Verify product belongs to this company
    const { data: prod } = await supabase
      .from('products')
      .select('id')
      .eq('id', product_id)
      .eq('company_id', req.companyId)
      .single();

    if (!prod) return res.status(404).json({ error: 'Product not found' });

    const { data, error } = await supabase
      .from('pos_daily_discounts')
      .insert({
        company_id:     req.companyId,
        product_id,
        discount_type:  discount_type || 'fixed',
        discount_value,
        valid_from:     valid_from  || null,
        valid_until:    valid_until || null,
        reason:         reason || null,
        created_by:     req.user.userId,
        is_active:      true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'discount', data.id, {
      module:   'pos',
      newValue: { product_id, discount_type, discount_value }
    });

    res.status(201).json({ discount: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/discounts/:id
 * Update a discount (value, dates, active toggle).
 */
router.put('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { discount_type, discount_value, valid_from, valid_until, reason, is_active } = req.body;

    const { data: existing } = await supabase
      .from('pos_daily_discounts')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!existing) return res.status(404).json({ error: 'Discount not found' });

    const updates = {};
    if (discount_type  !== undefined) updates.discount_type  = discount_type;
    if (discount_value !== undefined) updates.discount_value = discount_value;
    if (valid_from     !== undefined) updates.valid_from     = valid_from;
    if (valid_until    !== undefined) updates.valid_until    = valid_until;
    if (reason         !== undefined) updates.reason         = reason;
    if (is_active      !== undefined) updates.is_active      = is_active;

    const { data, error } = await supabase
      .from('pos_daily_discounts')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ discount: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/discounts/:id
 * Deactivate a discount (soft delete).
 */
router.delete('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('pos_daily_discounts')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'discount', req.params.id, { module: 'pos' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
