/**
 * ============================================================================
 * POS Promotions Routes - Checkout Charlie Module
 * ============================================================================
 * Cart-level, code-redeemed promotions. Management (CRUD) lives here;
 * GET /validate is the checkout-screen's live preview before a code is sent
 * with the sale — the real, authoritative check happens server-side in
 * sales.js POST / via promotionService.previewPromotion() regardless of
 * what this preview says.
 *
 * Table: pos_promotions (created by pos-schema.js auto-migration)
 *   discount_type  — 'percent' or 'fixed'
 *   discount_value — percentage or R amount
 *   min_purchase_amount — optional, cart subtotal must meet this to qualify
 *   start_date/end_date — optional TIMESTAMPTZ window
 *   usage_limit    — optional total redemption cap
 *   is_active      — soft toggle
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const promotionService = require('../services/promotionService');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/promotions/validate?code=X&subtotal=Y
 * Checkout-screen live preview — no writes. Registered before GET /:id
 * would be, so Express doesn't try to parse "validate" as an id (there is
 * no GET /:id today, but kept above for the same reason discounts.js does).
 */
router.get('/validate', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { code } = req.query;
    const subtotal = parseFloat(req.query.subtotal);

    const result = await promotionService.previewPromotion({
      companyId: req.companyId, code, cartSubtotal: subtotal,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });

    res.json({
      promotion: { id: result.promotion.id, name: result.promotion.name, code: result.promotion.code },
      discountAmount: result.discountAmount,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/promotions
 * List all promotions for this company (management view).
 */
router.get('/', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_promotions')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ promotions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/promotions
 * Create a new promotion.
 */
router.post('/', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { name, code, discount_type, discount_value, min_purchase_amount, start_date, end_date, usage_limit } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'name and code are required' });
    }
    if (discount_value === undefined || discount_value === null) {
      return res.status(400).json({ error: 'discount_value is required' });
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
    if (usage_limit !== undefined && usage_limit !== null && usage_limit <= 0) {
      return res.status(400).json({ error: 'usage_limit must be positive when set' });
    }

    const { data, error } = await supabase
      .from('pos_promotions')
      .insert({
        company_id:          req.companyId,
        name,
        code:                code.trim().toUpperCase(),
        discount_type,
        discount_value,
        min_purchase_amount: min_purchase_amount || null,
        start_date:          start_date || null,
        end_date:            end_date || null,
        usage_limit:         usage_limit || null,
        created_by:          req.user.userId,
        is_active:           true,
      })
      .select()
      .single();

    if (error) {
      // Postgres unique_violation on (company_id, code)
      if (error.code === '23505') {
        return res.status(400).json({ error: `A promotion with code "${code.trim().toUpperCase()}" already exists` });
      }
      return res.status(500).json({ error: error.message });
    }

    await auditFromReq(req, 'CREATE', 'promotion', data.id, {
      module:   'pos',
      newValue: { name, code: data.code, discount_type, discount_value },
    });

    res.status(201).json({ promotion: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/promotions/:id
 * Update a promotion.
 */
router.put('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { name, code, discount_type, discount_value, min_purchase_amount, start_date, end_date, usage_limit, is_active } = req.body;

    const { data: existing } = await supabase
      .from('pos_promotions')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!existing) return res.status(404).json({ error: 'Promotion not found' });

    if (discount_type !== undefined && !['fixed', 'percent'].includes(discount_type)) {
      return res.status(400).json({ error: "discount_type must be 'fixed' or 'percent'" });
    }
    if (discount_value !== undefined && discount_value <= 0) {
      return res.status(400).json({ error: 'discount_value must be positive' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (name                 !== undefined) updates.name = name;
    if (code                 !== undefined) updates.code = code.trim().toUpperCase();
    if (discount_type        !== undefined) updates.discount_type = discount_type;
    if (discount_value       !== undefined) updates.discount_value = discount_value;
    if (min_purchase_amount  !== undefined) updates.min_purchase_amount = min_purchase_amount || null;
    if (start_date           !== undefined) updates.start_date = start_date || null;
    if (end_date              !== undefined) updates.end_date = end_date || null;
    if (usage_limit          !== undefined) updates.usage_limit = usage_limit || null;
    if (is_active             !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('pos_promotions')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: `A promotion with code "${updates.code}" already exists` });
      }
      return res.status(500).json({ error: error.message });
    }

    res.json({ promotion: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/promotions/:id
 * Deactivate a promotion (soft delete) — preserves the redemption audit trail.
 */
router.delete('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('pos_promotions')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'promotion', req.params.id, { module: 'pos' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
