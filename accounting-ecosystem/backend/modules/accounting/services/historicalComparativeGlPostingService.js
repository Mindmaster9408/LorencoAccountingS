'use strict';

/**
 * ============================================================================
 * Historical Comparatives -> General Ledger posting
 * ============================================================================
 * Deliberately a SEPARATE module from historicalComparativesService.js, which
 * documents its own hard rule: "NEVER writes to journals, journal_lines,
 * bank_transactions..." (historicalComparativesService.js:9-10). That rule
 * stays true for that module — it still only ever reads/writes
 * historical_comparative_lines/batches.
 *
 * This module is the one deliberate, reviewed, one-way bridge: it READS a
 * FINALIZED batch's lines and creates real, dated, posted journal entries
 * from them, so a client's pre-go-live monthly figures can appear in a real
 * Profit & Loss for that historical month — not just in the Historical
 * Comparatives charts. It never writes back into historical_comparative_lines
 * or historical_comparative_batches (other than the posted_to_gl_at/by
 * tracking columns added for this feature by migration 171).
 *
 * Key facts this design accounts for (see migration 171 / plan research):
 *   - historical_comparative_lines.amount is SIGNED, not guaranteed positive.
 *   - historical_comparative_lines.account_id CAN be null (unmapped/manual
 *     account) — those lines cannot become journal lines and are reported
 *     back as excluded, never silently dropped or guessed at.
 *   - A month's income/expense lines alone will not balance (no
 *     balance-sheet side) — the difference is posted to a dedicated
 *     "Historical P&L Import Reserve" equity account (auto-created per
 *     company, AccountLookups.getOrCreateHistoricalImportReserveAccount),
 *     NOT Retained Earnings: a journal built only from natural-sign P&L
 *     lines can only balance if a profitable month DEBITS the balancing
 *     account, which would be backwards for Retained Earnings specifically.
 *   - The live GL may already have real activity for the same account+month
 *     (a company can be a live POS/Payroll client before Accounting go-live)
 *     — posting on top of that would double-count. Any account+month with
 *     existing non-import GL activity is treated as a conflict and excluded,
 *     never summed together.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — for the cross-table overlap check
const HistoricalComparativesService = require('./historicalComparativesService');
const AccountLookups = require('./accountLookups');
const JournalService = require('./journalService');
const { toDateOnlyString } = require('./profitLossService');

const SOURCE_TYPE = 'historical_comparative_import';

/** Round to cents the same way the rest of the accounting module does. */
function r2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

/**
 * Resolve one historical_comparative_lines row (with its live account
 * already joined) into a { debit, credit } pair, using the exact same
 * sign convention classifyAccountBalance/buildProfitLossTotals already use
 * elsewhere in this module (income: credit-normal, expense: debit-normal) —
 * just applied in the opposite direction (building an entry instead of
 * reading a balance).
 */
function resolveDebitCredit(account, amount) {
  const amt = r2(amount);
  if (amt === 0) return null; // nothing to post

  const isIncome = account.type === 'income';
  if (isIncome) {
    return amt > 0 ? { debit: 0, credit: amt } : { debit: -amt, credit: 0 };
  }
  // Expense (and anything else that ends up here — only income/expense
  // accounts are ever captured in a profit_loss-basis batch).
  return amt > 0 ? { debit: amt, credit: 0 } : { debit: 0, credit: -amt };
}

/**
 * Shared resolution step used by both previewPosting and executePosting —
 * executePosting NEVER trusts a client-supplied preview, it always re-derives
 * this itself from the live batch + live accounts + live GL state.
 *
 * Returns { batch, months, excluded, conflicts } where `months` is only the
 * cleanly-postable months (conflicted/excluded lines removed and reported
 * separately) — actual journal amounts, not yet written anywhere.
 */
async function resolvePosting({ companyId, batchId }) {
  const batch = await HistoricalComparativesService.getBatch({ companyId, batchId });
  if (!batch) throw new Error('Batch not found or access denied.');
  if (batch.status !== 'finalized') {
    throw new Error('Only a finalized batch can be posted to the General Ledger.');
  }
  if (batch.posted_to_gl_at) {
    throw new Error(`This batch was already posted to the General Ledger on ${batch.posted_to_gl_at}.`);
  }

  const lines = await HistoricalComparativesService.getBatchLines({ companyId, batchId });
  if (!lines.length) throw new Error('This batch has no lines to post.');

  // ── Resolve every distinct account_id referenced by the batch, once ──────
  const accountIds = [...new Set(lines.map(l => l.account_id).filter(Boolean))];
  const accountMap = {};
  if (accountIds.length) {
    const { data: accounts, error: acctErr } = await supabase
      .from('accounts')
      .select('id, code, name, type, is_active, is_postable')
      .eq('company_id', companyId)
      .in('id', accountIds);
    if (acctErr) throw new Error(acctErr.message);
    (accounts || []).forEach(a => { accountMap[a.id] = a; });
  }

  // Deliberately NOT Retained Earnings — see accountLookups.js's header
  // comment on getOrCreateHistoricalImportReserveAccount for why: a journal
  // built only from natural-sign P&L lines can only balance if a profitable
  // month DEBITS the balancing account, which would be backwards for RE.
  const balancingAccount = await AccountLookups.getOrCreateHistoricalImportReserveAccount(companyId);

  // ── Split lines into postable vs excluded (unmapped/missing/non-postable account) ──
  const excluded = [];
  const postable = [];
  for (const line of lines) {
    if (!line.account_id) {
      excluded.push({ ...line, reason: 'unmapped_account' });
      continue;
    }
    const account = accountMap[line.account_id];
    if (!account || account.is_active === false) {
      excluded.push({ ...line, reason: 'account_not_found_or_inactive' });
      continue;
    }
    if (account.is_postable === false) {
      excluded.push({ ...line, reason: 'account_not_postable' });
      continue;
    }
    if (account.type !== 'income' && account.type !== 'expense') {
      excluded.push({ ...line, reason: 'not_an_income_or_expense_account' });
      continue;
    }
    postable.push({ ...line, account });
  }

  // ── Overlap/conflict check: does the live GL already have real activity ──
  // for any of these account+month combinations? Real = any journal not
  // created by this same import feature.
  const conflicts = [];
  const conflictKey = (accountId, periodStart) => `${accountId}|${periodStart}`;
  const conflictSet = new Set();

  if (postable.length) {
    const minDate = postable.reduce((m, l) => (l.period_start < m ? l.period_start : m), postable[0].period_start);
    const maxDate = postable.reduce((m, l) => (l.period_end > m ? l.period_end : m), postable[0].period_end);
    const postableAccountIds = [...new Set(postable.map(l => l.account_id))];

    // Raw pg query (not a Supabase embedded join) — journalService.js and
    // reports.js both avoid FK-embed syntax across journal_lines/journals for
    // the same reason: it depends on the relationship being present in
    // PostgREST's schema cache, which has bitten this codebase before.
    const { rows: existingLines } = await db.query(
      `SELECT jl.account_id, j.date
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       WHERE j.company_id = $1
         AND j.status IN ('posted', 'reversed')
         AND j.source_type IS DISTINCT FROM $2
         AND j.date >= $3 AND j.date <= $4
         AND jl.account_id = ANY($5::int[])`,
      [companyId, SOURCE_TYPE, minDate, maxDate, postableAccountIds]
    );

    // Bucket existing real activity by account + the batch line's own
    // period_start (not the journal's exact date) so a line's whole month
    // is flagged if anything landed inside it.
    for (const line of postable) {
      const hasOverlap = existingLines.some(el => {
        if (el.account_id !== line.account_id) return false;
        const d = toDateOnlyString(el.date);
        return d >= line.period_start && d <= line.period_end;
      });
      if (hasOverlap) conflictSet.add(conflictKey(line.account_id, line.period_start));
    }
  }

  const cleanLines = [];
  for (const line of postable) {
    if (conflictSet.has(conflictKey(line.account_id, line.period_start))) {
      conflicts.push({ ...line, reason: 'existing_gl_activity_same_account_month' });
    } else {
      cleanLines.push(line);
    }
  }

  // ── Idempotency guard for partial-failure retries ─────────────────────────
  // batch.posted_to_gl_at is only set after EVERY month succeeds (see
  // executePosting), so it alone can't catch a retry after a PARTIAL
  // failure (e.g. month 5 of 8 hits a locked accounting period) — without
  // this, re-running would re-create journals for the months that already
  // succeeded, silently duplicating them. Any month with an existing POSTED
  // journal tagged to this batch is treated as already done and skipped.
  const { rows: alreadyPostedRows } = await db.query(
    `SELECT date FROM journals
     WHERE company_id = $1 AND historical_comparative_batch_id = $2 AND status = 'posted'`,
    [companyId, batchId]
  );
  const alreadyPostedDates = new Set(alreadyPostedRows.map(r => toDateOnlyString(r.date)));

  // ── Group clean lines into one journal per (financial_year, period_month) ──
  const byMonth = new Map();
  for (const line of cleanLines) {
    if (alreadyPostedDates.has(toDateOnlyString(line.period_end))) continue;
    const key = `${line.financial_year}-${line.period_month}`;
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        financialYear: line.financial_year,
        periodMonth: line.period_month,
        journalDate: line.period_end,
        lines: [],
      });
    }
    byMonth.get(key).lines.push(line);
  }

  const months = [];
  for (const month of byMonth.values()) {
    const journalLines = [];
    let netAmount = 0;
    for (const line of month.lines) {
      const dc = resolveDebitCredit(line.account, line.amount);
      if (!dc) continue; // zero-amount line — nothing to post
      journalLines.push({
        accountId: line.account_id,
        description: `Historical comparative import — ${line.account.name}`,
        debit: dc.debit,
        credit: dc.credit,
      });
      netAmount += dc.credit - dc.debit; // positive = net income for the month
    }

    if (!journalLines.length) continue; // whole month was zero-amount lines

    // journalLines so far are net credit-heavy by `netAmount` when the month
    // was profitable (income > expense) — the balancing line must be
    // debit-heavy by the same amount to bring the journal to zero, and
    // credit-heavy when the month was a loss. See accountLookups.js's
    // getOrCreateHistoricalImportReserveAccount for why this direction is
    // correct for a dedicated reserve account but would be backwards for
    // Retained Earnings.
    const balancingAmount = r2(netAmount);
    if (Math.abs(balancingAmount) > 0.004) {
      journalLines.push({
        accountId: balancingAccount.id,
        description: 'Historical comparative import — balancing entry',
        debit: balancingAmount > 0 ? balancingAmount : 0,
        credit: balancingAmount < 0 ? -balancingAmount : 0,
      });
    }

    months.push({
      financialYear: month.financialYear,
      periodMonth: month.periodMonth,
      journalDate: month.journalDate,
      netAmount: r2(netAmount),
      lines: journalLines,
    });
  }

  return { batch, months, excluded, conflicts, balancingAccount };
}

/** Read-only: build and return what WOULD be posted. Writes nothing. */
async function previewPosting({ companyId, batchId }) {
  const { batch, months, excluded, conflicts, balancingAccount } = await resolvePosting({ companyId, batchId });
  return {
    batchId: batch.id,
    balancingAccount: { id: balancingAccount.id, code: balancingAccount.code, name: balancingAccount.name },
    months,
    excluded,
    conflicts,
  };
}

/**
 * Re-resolves everything server-side (never trusts a prior preview call) and
 * actually creates + posts one journal per clean month. Fails loudly and
 * stops on the first month that can't be posted (e.g. a locked accounting
 * period) — reports exactly which months succeeded vs failed rather than
 * silently partially succeeding.
 */
async function executePosting({ companyId, batchId, userId }) {
  const { batch, months } = await resolvePosting({ companyId, batchId });
  if (!months.length) {
    throw new Error('Nothing postable — every month was either zero-amount, unmapped, or in conflict with existing GL activity.');
  }

  const created = [];
  for (const month of months) {
    let journal;
    try {
      journal = await JournalService.createDraftJournal({
        companyId,
        date: month.journalDate,
        description: `Historical comparative import — ${month.periodMonth}/${month.financialYear}`,
        sourceType: SOURCE_TYPE,
        createdByUserId: userId,
        lines: month.lines,
        metadata: { historicalComparativeBatchId: batchId },
      });
      journal = await JournalService.postJournal(journal.id, companyId, userId);
    } catch (err) {
      throw new Error(
        `Posting stopped at ${month.periodMonth}/${month.financialYear}: ${err.message}. ` +
        `Months already posted before this one: ${created.map(c => `${c.periodMonth}/${c.financialYear}`).join(', ') || 'none'}.`
      );
    }

    const { error: tagErr } = await supabase
      .from('journals')
      .update({ historical_comparative_batch_id: batchId })
      .eq('id', journal.id)
      .eq('company_id', companyId);
    if (tagErr) throw new Error(`Journal ${journal.id} posted but failed to tag with batch id: ${tagErr.message}`);

    created.push({ journalId: journal.id, periodMonth: month.periodMonth, financialYear: month.financialYear, netAmount: month.netAmount });
  }

  const { error: batchErr } = await supabase
    .from('historical_comparative_batches')
    .update({ posted_to_gl_at: new Date().toISOString(), posted_to_gl_by: userId })
    .eq('id', batchId)
    .eq('company_id', companyId);
  if (batchErr) throw new Error(`Journals posted but failed to mark batch as posted: ${batchErr.message}`);

  return { batchId: batch.id, journalsCreated: created };
}

module.exports = { previewPosting, executePosting };
