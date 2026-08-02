/**
 * ============================================================================
 * POS Promotion Service - Checkout Charlie Module
 * ============================================================================
 * Cart-level, code-redeemed promotions — a cashier enters a code at checkout
 * to apply a whole-sale discount. Distinct from pos_daily_discounts
 * (per-product, automatic, no code) and customer_product_discounts
 * (per-customer-per-product, automatic) — those are per-line pricing
 * candidates resolved in resolveEffectivePrices(); a promotion is a final
 * whole-sale reduction, the same tier as the manual discretionary discount.
 *
 * Tables used:
 *   pos_promotions            — one row per code (company-scoped, unique code)
 *   pos_promotion_redemptions — one row per sale that redeemed a code (audit trail)
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

/**
 * Validate-and-compute only — no writes. Used by sales.js to size the
 * discount BEFORE the sale is created (the total must be known up front),
 * and by GET /promotions/validate for the checkout screen's live preview.
 *
 * @returns {Promise<{ok:true, promotion:object, discountAmount:number}|{ok:false, error:string}>}
 */
async function previewPromotion({ companyId, code, cartSubtotal }) {
  if (!code || typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'A promotion code is required' };
  }
  if (cartSubtotal === undefined || cartSubtotal === null || isNaN(cartSubtotal)) {
    return { ok: false, error: 'A valid cart subtotal is required' };
  }

  const { data: promotion, error } = await supabase
    .from('pos_promotions')
    .select('*')
    .eq('company_id', companyId)
    .eq('code', code.trim().toUpperCase())
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!promotion) return { ok: false, error: 'Promotion code not found' };
  if (!promotion.is_active) return { ok: false, error: 'This promotion is no longer active' };

  const now = new Date();
  if (promotion.start_date && now < new Date(promotion.start_date)) {
    return { ok: false, error: 'This promotion has not started yet' };
  }
  if (promotion.end_date && now > new Date(promotion.end_date)) {
    return { ok: false, error: 'This promotion has expired' };
  }
  if (promotion.usage_limit !== null && promotion.current_usage_count >= promotion.usage_limit) {
    return { ok: false, error: 'This promotion has reached its usage limit' };
  }
  if (promotion.min_purchase_amount && cartSubtotal < parseFloat(promotion.min_purchase_amount)) {
    return { ok: false, error: `Minimum purchase of R ${parseFloat(promotion.min_purchase_amount).toFixed(2)} required for this promotion` };
  }

  const discountValue = parseFloat(promotion.discount_value);
  const discountAmount = promotion.discount_type === 'percent'
    ? Math.round(cartSubtotal * (discountValue / 100) * 100) / 100
    : Math.min(cartSubtotal, discountValue);

  return { ok: true, promotion, discountAmount: Math.max(0, discountAmount) };
}

/**
 * The real write: increments current_usage_count and inserts a redemption
 * row. Re-checks the usage limit at write time — same race-safety class as
 * every other write-time re-check in this codebase (e.g. loyalty redemption,
 * stock pre-check/write-time-check).
 */
async function redeemPromotion({ companyId, promotionId, saleId, customerId, discountAmount }) {
  const { data: promotion, error: fetchErr } = await supabase
    .from('pos_promotions')
    .select('id, usage_limit, current_usage_count')
    .eq('id', promotionId)
    .eq('company_id', companyId)
    .single();

  if (fetchErr || !promotion) return { ok: false, error: 'Promotion not found' };
  if (promotion.usage_limit !== null && promotion.current_usage_count >= promotion.usage_limit) {
    return { ok: false, error: 'Promotion usage limit reached' };
  }

  const { error: updateErr } = await supabase
    .from('pos_promotions')
    .update({ current_usage_count: promotion.current_usage_count + 1, updated_at: new Date().toISOString() })
    .eq('id', promotionId)
    .eq('company_id', companyId);

  if (updateErr) return { ok: false, error: updateErr.message };

  const { data: redemption, error: insertErr } = await supabase
    .from('pos_promotion_redemptions')
    .insert({
      company_id:      companyId,
      promotion_id:    promotionId,
      sale_id:         saleId || null,
      customer_id:     customerId || null,
      discount_amount: discountAmount,
    })
    .select()
    .single();

  if (insertErr) return { ok: false, error: insertErr.message };

  return { ok: true, redemption };
}

module.exports = { previewPromotion, redeemPromotion };
