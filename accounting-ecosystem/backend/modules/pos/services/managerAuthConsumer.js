/**
 * ============================================================================
 * Manager Authorization Consumer - Checkout Charlie Module
 * ============================================================================
 * Extracted 2026-08-02 from sales.js so cashPaidOuts.js can reuse the same
 * "was this actually approved" check for a payout, instead of duplicating
 * the pos_manager_authorizations lookup a second time. Originally shared
 * only between sales.js's own discount/return/void checks.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

/**
 * Find + consume (mark used) an unexpired, unused manager-PIN authorization
 * (POST /manager-auth/verify) for a given action. One real "was this
 * actually approved" check, since the PIN modal feeds the same
 * pos_manager_authorizations table for every action type.
 *
 * @returns {Promise<{ok:true}|{ok:false}>}
 */
async function consumeManagerAuthorization({ companyId, tillSessionId, actionType, discountPercent }) {
  let query = supabase
    .from('pos_manager_authorizations')
    .select('id')
    .eq('company_id', companyId)
    .eq('till_session_id', tillSessionId)
    .eq('action_type', actionType)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  // line_discount (2026-08-21) needs the same exact-percent match as
  // 'discount' — otherwise an authorization granted for a 5% line override
  // could be silently reused to cover a 50% one.
  if (actionType === 'discount' || actionType === 'line_discount') query = query.eq('discount_percent', discountPercent);

  const { data: authRow } = await query.maybeSingle();
  if (!authRow) return { ok: false };

  // Single-use — a second sale/return can't silently reuse the same approval.
  await supabase.from('pos_manager_authorizations').update({ used_at: new Date().toISOString() }).eq('id', authRow.id);
  return { ok: true };
}

module.exports = { consumeManagerAuthorization };
