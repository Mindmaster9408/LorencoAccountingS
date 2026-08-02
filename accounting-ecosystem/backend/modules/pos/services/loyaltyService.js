/**
 * ============================================================================
 * POS Loyalty Service - Checkout Charlie Module
 * ============================================================================
 * Shared point/tier logic — extracted 2026-08-02 from routes/loyalty.js so
 * sales.js can wire earning/redeeming into checkout without duplicating this
 * math in two places. routes/loyalty.js's /earn and /redeem are now thin
 * wrappers around awardPoints()/redeemPoints() below; the request/response
 * shape of those two endpoints is unchanged.
 *
 * Tables used:
 *   loyalty_programs            — one row per company (program config)
 *   loyalty_transactions        — per-customer earn/redeem/adjust events
 *   customers.loyalty_points    — running balance (denormalised for speed)
 *   customers.loyalty_tier      — 'bronze' | 'silver' | 'gold' | 'platinum'
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

function getTier(points) {
  if (points >= 5000) return 'platinum';
  if (points >= 2000) return 'gold';
  if (points >= 500)  return 'silver';
  return 'bronze';
}

/**
 * Validate-and-compute only — no writes. Used by sales.js to size a
 * redemption discount BEFORE the sale is created (the total must be known
 * up front), while the actual point deduction only happens after the sale
 * succeeds (see redeemPoints() below, called with the real sale_id).
 *
 * @returns {Promise<{ok:true, randValue:number}|{ok:false, error:string}>}
 */
async function previewRedemption({ companyId, customerId, pointsToRedeem }) {
  if (!customerId || pointsToRedeem === undefined || pointsToRedeem <= 0) {
    return { ok: false, error: 'customer_id and a positive points_to_redeem are required' };
  }

  const { data: program } = await supabase
    .from('loyalty_programs')
    .select('redemption_rate, min_redemption_points, is_active')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!program || !program.is_active) {
    return { ok: false, error: 'Loyalty program is not active for this company' };
  }
  if (pointsToRedeem < program.min_redemption_points) {
    return { ok: false, error: `Minimum redemption is ${program.min_redemption_points} points` };
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, loyalty_points')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .single();

  if (custErr || !customer) return { ok: false, error: 'Customer not found' };

  if ((customer.loyalty_points || 0) < pointsToRedeem) {
    return { ok: false, error: 'Insufficient loyalty points' };
  }

  const randValue = parseFloat((pointsToRedeem * program.redemption_rate).toFixed(2));
  return { ok: true, randValue };
}

/**
 * The real write: deduct points, update tier, record a 'redeem' transaction.
 * Re-validates everything previewRedemption() already checked — this is the
 * actual enforcement point (a concurrent redemption between preview and this
 * call is still caught here, same race-safety class as the stock pre-check/
 * write-time-check pattern already used elsewhere in this codebase).
 */
async function redeemPoints({ companyId, customerId, saleId, pointsToRedeem, notes, userId }) {
  const { data: program } = await supabase
    .from('loyalty_programs')
    .select('redemption_rate, min_redemption_points, is_active')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!program || !program.is_active) {
    return { ok: false, error: 'Loyalty program is not active for this company' };
  }
  if (pointsToRedeem < program.min_redemption_points) {
    return { ok: false, error: `Minimum redemption is ${program.min_redemption_points} points` };
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, loyalty_points')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .single();

  if (custErr || !customer) return { ok: false, error: 'Customer not found' };

  if ((customer.loyalty_points || 0) < pointsToRedeem) {
    return { ok: false, error: 'Insufficient loyalty points', available: customer.loyalty_points || 0 };
  }

  const newBalance = customer.loyalty_points - pointsToRedeem;
  const newTier    = getTier(newBalance);
  const randValue  = parseFloat((pointsToRedeem * program.redemption_rate).toFixed(2));

  await supabase
    .from('customers')
    .update({ loyalty_points: newBalance, loyalty_tier: newTier })
    .eq('id', customerId)
    .eq('company_id', companyId);

  const { data: tx, error: txErr } = await supabase
    .from('loyalty_transactions')
    .insert({
      company_id:    companyId,
      customer_id:   customerId,
      sale_id:       saleId || null,
      type:          'redeem',
      points:        -pointsToRedeem,
      balance_after: newBalance,
      notes:         notes || null,
      created_by:    userId,
    })
    .select()
    .single();

  if (txErr) return { ok: false, error: txErr.message };

  return { ok: true, transaction: tx, points_redeemed: pointsToRedeem, rand_value: randValue, new_balance: newBalance, new_tier: newTier };
}

/**
 * Award points for an amount spent. No-op (ok:true, points_earned:0) rather
 * than an error when the program isn't active — earning is a background
 * side-effect of a sale, not something that should ever fail the sale.
 */
async function awardPoints({ companyId, customerId, saleId, amountSpent, notes, userId }) {
  if (!customerId || amountSpent === undefined || amountSpent < 0) {
    return { ok: false, error: 'customer_id and a non-negative amount_spent are required' };
  }

  const { data: program } = await supabase
    .from('loyalty_programs')
    .select('points_per_rand, is_active')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!program || !program.is_active) {
    return { ok: true, points_earned: 0, skipped: 'Loyalty program is not active for this company' };
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, loyalty_points')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .single();

  if (custErr || !customer) return { ok: false, error: 'Customer not found' };

  const pointsEarned = Math.floor(amountSpent * program.points_per_rand);
  const newBalance    = (customer.loyalty_points || 0) + pointsEarned;
  const newTier       = getTier(newBalance);

  await supabase
    .from('customers')
    .update({ loyalty_points: newBalance, loyalty_tier: newTier })
    .eq('id', customerId)
    .eq('company_id', companyId);

  const { data: tx, error: txErr } = await supabase
    .from('loyalty_transactions')
    .insert({
      company_id:    companyId,
      customer_id:   customerId,
      sale_id:       saleId || null,
      type:          'earn',
      points:        pointsEarned,
      balance_after: newBalance,
      notes:         notes || null,
      created_by:    userId,
    })
    .select()
    .single();

  if (txErr) return { ok: false, error: txErr.message };

  return { ok: true, transaction: tx, points_earned: pointsEarned, new_balance: newBalance, new_tier: newTier };
}

module.exports = { getTier, previewRedemption, redeemPoints, awardPoints };
