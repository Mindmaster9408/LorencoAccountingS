/**
 * ============================================================================
 * POS Promotion Campaigns Routes - Checkout Charlie Module
 * ============================================================================
 * A named campaign (e.g. "Black Friday") with a date window — a pure
 * grouping/reporting wrapper, NOT its own pricing mechanic. Replaces an
 * earlier code-redeemed cart-discount design (2026-08-02, shipped then
 * reverted the same day after clarifying the real requirement): no promo
 * code on the till, and the real model is a campaign containing one or more
 * PER-PRODUCT markdowns — which is exactly what pos_daily_discounts already
 * is (per-product, automatic, no code, already correctly priced by
 * sales.js's resolveEffectivePrices()). A campaign item is just a
 * pos_daily_discounts row tagged with campaign_id; checkout pricing needs
 * zero changes as a result.
 *
 * Table: pos_promotion_campaigns (created by pos-schema.js auto-migration)
 *   Items live in pos_daily_discounts, tagged via campaign_id.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { getBusinessDayBounds } = require('../services/discountWindow');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/promotion-campaigns
 * List campaigns for this company, with a live item count each.
 */
router.get('/', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data: campaigns, error } = await supabase
      .from('pos_promotion_campaigns')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const results = await Promise.all((campaigns || []).map(async (c) => {
      const { count } = await supabase
        .from('pos_daily_discounts')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id)
        .eq('is_active', true);
      return { ...c, item_count: count || 0 };
    }));

    res.json({ campaigns: results });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/promotion-campaigns/:id
 * A single campaign plus its current product markdowns — powers the
 * Loyalty → Promotions "Manage" detail view.
 */
router.get('/:id', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data: campaign, error: campErr } = await supabase
      .from('pos_promotion_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (campErr) return res.status(500).json({ error: campErr.message });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { data: items, error: itemsErr } = await supabase
      .from('pos_daily_discounts')
      .select('*, products(product_name, product_code, unit_price)')
      .eq('campaign_id', campaign.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (itemsErr) return res.status(500).json({ error: itemsErr.message });

    res.json({ campaign, items: items || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/promotion-campaigns
 * Create a new campaign.
 */
router.post('/', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { name, start_date, end_date } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, error } = await supabase
      .from('pos_promotion_campaigns')
      .insert({
        company_id: req.companyId,
        name:       name.trim(),
        start_date: start_date || null,
        end_date:   end_date || null,
        created_by: req.user.userId,
        is_active:  true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'promotion_campaign', data.id, {
      module:   'pos',
      newValue: { name: data.name, start_date, end_date },
    });

    res.status(201).json({ campaign: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/promotion-campaigns/:id
 * Update a campaign's name/dates/active toggle.
 */
router.put('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { name, start_date, end_date, is_active } = req.body;

    const { data: existing } = await supabase
      .from('pos_promotion_campaigns')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Campaign not found' });

    const updates = { updated_at: new Date().toISOString() };
    if (name       !== undefined) updates.name = name.trim();
    if (start_date !== undefined) updates.start_date = start_date || null;
    if (end_date   !== undefined) updates.end_date = end_date || null;
    if (is_active  !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('pos_promotion_campaigns')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ campaign: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/promotion-campaigns/:id
 * Deactivate a campaign (soft delete). Its pos_daily_discounts rows are
 * NOT deleted or untagged — historical performance stays attributable to
 * the campaign; each item's own is_active/valid_until still governs
 * whether it keeps applying at checkout.
 */
router.delete('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('pos_promotion_campaigns')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'promotion_campaign', req.params.id, { module: 'pos' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/promotion-campaigns/:id/items
 * Add a product markdown to the campaign — creates a pos_daily_discounts
 * row tagged with campaign_id, valid_from/valid_until mirroring the
 * campaign's own dates so the existing date-window logic in
 * discountWindow.js (unchanged) governs it correctly, including a genuine
 * multi-day campaign.
 */
router.post('/:id/items', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { product_id, discount_type, discount_value } = req.body;

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

    const { data: campaign, error: campErr } = await supabase
      .from('pos_promotion_campaigns')
      .select('id, name, start_date, end_date')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (campErr) return res.status(500).json({ error: campErr.message });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

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
        campaign_id:    campaign.id,
        discount_type,
        discount_value,
        valid_from:     campaign.start_date || null,
        valid_until:    campaign.end_date || null,
        reason:         campaign.name,
        created_by:     req.user.userId,
        is_active:      true,
      })
      .select('*, products(product_name, product_code, unit_price)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'promotion_campaign_item', data.id, {
      module:   'pos',
      newValue: { campaign_id: campaign.id, product_id, discount_type, discount_value },
    });

    res.status(201).json({ item: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/promotion-campaigns/:id/items/:discountId
 * Remove one product markdown from the campaign (soft-deactivate its
 * pos_daily_discounts row — same convention discounts.js's own DELETE uses).
 */
router.delete('/:id/items/:discountId', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('pos_daily_discounts')
      .update({ is_active: false })
      .eq('id', req.params.discountId)
      .eq('campaign_id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'promotion_campaign_item', req.params.discountId, { module: 'pos' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/promotion-campaigns/:id/performance
 * Sales performance for this campaign — units sold, revenue, cost, and
 * profit summed across every product markdown tagged to it, while each was
 * in effect. Adapted from discounts.js's per-discount calculation (same
 * sale_items x sales join, same window-bounded query), just scoped to one
 * campaign_id and aggregated. The "here's what this promotion delivered
 * for you" report.
 */
router.get('/:id/performance', requirePermission('REPORTS.VIEW'), async (req, res) => {
  try {
    const { data: campaign, error: campErr } = await supabase
      .from('pos_promotion_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (campErr) return res.status(500).json({ error: campErr.message });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { data: items, error: itemsErr } = await supabase
      .from('pos_daily_discounts')
      .select('*, products(product_name, product_code, unit_price, cost_price)')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false });

    if (itemsErr) return res.status(500).json({ error: itemsErr.message });

    const results = await Promise.all((items || []).map(async (d) => {
      const windowStart = d.valid_from || d.created_at;
      const windowEnd   = d.valid_until
        ? `${d.valid_until}T23:59:59.999+02:00`
        : getBusinessDayBounds(d.created_at).dayEndISO;

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
      // Same VAT-inclusive-revenue-minus-cost convention as discounts.js's
      // performance endpoint and reports.js's fetchSalesWithProfit.
      const revenue   = (saleItems || []).reduce((sum, i) => sum + (parseFloat(i.line_total) || 0), 0);
      const costPrice = parseFloat(d.products?.cost_price || 0);
      const cost      = costPrice * unitsSold;
      const profit    = Math.round((revenue - cost) * 100) / 100;

      return {
        id: d.id,
        product_id: d.product_id,
        product_name: d.products?.product_name || 'Unknown product',
        product_code: d.products?.product_code || null,
        discount_type: d.discount_type,
        discount_value: parseFloat(d.discount_value),
        is_active: d.is_active,
        units_sold: unitsSold,
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        profit,
      };
    }));

    const summary = {
      itemCount:      results.length,
      totalUnitsSold: results.reduce((sum, r) => sum + r.units_sold, 0),
      totalRevenue:   Math.round(results.reduce((sum, r) => sum + r.revenue, 0) * 100) / 100,
      totalCost:      Math.round(results.reduce((sum, r) => sum + r.cost, 0) * 100) / 100,
      totalProfit:    Math.round(results.reduce((sum, r) => sum + r.profit, 0) * 100) / 100,
    };
    summary.isProfitable = summary.totalProfit > 0;

    res.json({ campaign, items: results, summary });
  } catch (err) {
    console.error('[promotionCampaigns] performance:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
