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
