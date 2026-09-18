'use strict';

const { supabase } = require('../../../config/database');

/**
 * Small shared account-resolution helpers used by more than one service, so
 * the lookup logic can't silently drift between callers.
 */
class AccountLookups {
  /**
   * The single equity account a company has designated as Retained Earnings
   * (type='equity', sub_type='retained_earnings'). Used by year-end close
   * (routes/yearEnd.js) and by historicalComparativeGlPostingService.js's
   * monthly balancing line — both need the exact same account, found the
   * exact same way, or a batch import and a later year-end close could
   * silently disagree about which account "Retained Earnings" even is.
   *
   * Returns null if no such account exists (or is inactive) — callers must
   * surface this as an actionable error, not assume/create one silently.
   */
  static async getRetainedEarningsAccount(companyId) {
    const { data, error } = await supabase
      .from('accounts')
      .select('id, code, name')
      .eq('company_id', companyId)
      .eq('type', 'equity')
      .eq('sub_type', 'retained_earnings')
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data || null;
  }

  /**
   * The dedicated equity account that absorbs the monthly balancing entry
   * when historicalComparativeGlPostingService.js posts a Historical
   * Comparatives batch to the GL. Deliberately NOT Retained Earnings:
   * a journal built only from natural-sign P&L lines (no balance-sheet
   * side) can only balance if a profitable month DEBITS the balancing
   * account and a loss month CREDITS it — the opposite of what Retained
   * Earnings should ever do. A dedicated reserve account has no such
   * expectation, so this "backwards" direction is harmless there and never
   * pollutes the real Retained Earnings balance. Find-or-create per
   * company, since it's created lazily the first time a batch is posted.
   */
  static async getOrCreateHistoricalImportReserveAccount(companyId) {
    const SUB_TYPE = 'historical_import_reserve';

    const { data: existing, error } = await supabase
      .from('accounts')
      .select('id, code, name')
      .eq('company_id', companyId)
      .eq('type', 'equity')
      .eq('sub_type', SUB_TYPE)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) return existing;

    const baseCode = '9950';
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = attempt === 0 ? baseCode : `${baseCode}-${attempt + 1}`;
      const { data: created, error: insErr } = await supabase
        .from('accounts')
        .insert({
          company_id: companyId,
          code,
          name: 'Historical P&L Import Reserve',
          type: 'equity',
          sub_type: SUB_TYPE,
          description: 'Auto-created balancing account for posting finalized Historical Comparatives ' +
            'batches to the General Ledger. Kept separate from Retained Earnings so real year-end ' +
            'movements are never mixed with historical catch-up data.',
          is_active: true,
          sort_order: 9950,
        })
        .select('id, code, name')
        .single();
      if (!insErr) return created;
      if (insErr.code !== '23505') throw new Error(insErr.message); // not a code collision — give up
    }
    throw new Error('Could not create the Historical P&L Import Reserve account — ran out of code fallbacks.');
  }
}

module.exports = AccountLookups;
