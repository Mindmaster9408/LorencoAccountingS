'use strict';

/**
 * ============================================================================
 * Paytime → Ledger Leo payroll journal (spec 10 VU-04, owner-confirmed 2026-10-12)
 * ============================================================================
 * When a pay run is FINALIZED, Paytime creates the payroll journal in Ledger Leo as
 * a DRAFT. The accountant reviews and posts it — Paytime never posts.
 * When a run is REVERSED: a still-draft journal is deleted; a posted one gets a
 * reversing DRAFT (debits ↔ credits) for the accountant to post.
 *
 * Totals come only from the run's finalized snapshots (never recalculated):
 *   Dr Salaries and Wages (6000)            gross pay
 *   Dr Employer UIF Contributions (6020)    employer UIF
 *   Dr Employer SDL Contributions (6030)    SDL
 *   Cr PAYE / UIF Payable (2400)            PAYE + employee UIF + employer UIF
 *   Cr SDL Payable (2410)                   SDL
 *   Cr Payroll deductions payable           other deductions (pension, medical, loans…)
 *   Cr Salaries payable (net pay control)   net pay — cleared by the bank payments
 * Balanced because gross − PAYE − UIF − deductions = net.
 *
 * Accounts are found in the company's own chart of accounts (standard codes, or by
 * name for the two control accounts). Nothing is created in a client's chart of
 * accounts automatically: when an account is missing the journal is not created and
 * the reason is returned so Execute Payroll can say exactly what to add.
 * Never throws into the payroll flow — callers get { created:false, reason }.
 * ============================================================================
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const ROLES = [
  { role: 'salaries_expense',     label: 'Salaries and Wages (expense)',              codes: ['6000'] },
  { role: 'uif_employer_expense', label: 'Employer UIF Contributions (expense)',      codes: ['6020'] },
  { role: 'sdl_expense',          label: 'Employer SDL Contributions (expense)',      codes: ['6030'] },
  { role: 'paye_uif_payable',     label: 'PAYE / UIF Payable (liability)',            codes: ['2400'] },
  { role: 'sdl_payable',          label: 'SDL Payable (liability)',                   codes: ['2410'] },
  { role: 'deductions_payable',   label: 'Payroll Deductions Payable (liability)',    codes: [],
    name: /(payroll|salary|employee)\s+deductions?\s+payable/i },
  { role: 'net_pay_payable',      label: 'Salaries Payable / Net Pay Control (liability)', codes: [],
    name: /(salar(y|ies)|wages?|net\s*pay)\s*(payable|control)/i }
];

/** Pick the account for each role from a company's chart of accounts (pure). */
function resolveAccounts(accounts) {
  const usable = (accounts || []).filter(a => a.is_postable !== false && a.is_active !== false);
  const found = {}, missing = [];
  ROLES.forEach(r => {
    let acc = usable.find(a => r.codes.includes(String(a.code)));
    if (!acc && r.name) acc = usable.find(a => r.name.test(a.name || '') && /liabilit/i.test(a.type || 'liability'));
    if (acc) found[r.role] = acc; else missing.push(r);
  });
  return { found, missing };
}

/** Sum the finalized snapshots of a run (pure). */
function runTotals(snapshots) {
  const t = { gross: 0, paye: 0, uif: 0, uif_employer: 0, sdl: 0, deductions: 0, net: 0, employees: 0 };
  (snapshots || []).forEach(s => {
    const o = s.calculation_output || {};
    t.gross += Number(o.gross) || 0;
    t.paye += Number(o.paye) || 0;
    t.uif += Number(o.uif) || 0;
    t.uif_employer += Number(o.uif_employer != null ? o.uif_employer : o.uif) || 0;
    t.sdl += Number(o.sdl) || 0;
    t.deductions += Number(o.deductions) || 0;
    t.net += Number(o.net) || 0;
    t.employees++;
  });
  Object.keys(t).forEach(k => { if (k !== 'employees') t[k] = r2(t[k]); });
  return t;
}

/** The non-zero journal lines for the totals, by account role (pure). */
function lineSpecs(t) {
  return [
    { role: 'salaries_expense',     debit: t.gross,        description: 'Gross salaries and wages' },
    { role: 'uif_employer_expense', debit: t.uif_employer, description: 'Employer UIF contribution' },
    { role: 'sdl_expense',          debit: t.sdl,          description: 'Skills development levy' },
    { role: 'paye_uif_payable',     credit: r2(t.paye + t.uif + t.uif_employer), description: 'PAYE + UIF (employee and employer) payable to SARS' },
    { role: 'sdl_payable',          credit: t.sdl,         description: 'SDL payable to SARS' },
    { role: 'deductions_payable',   credit: t.deductions,  description: 'Other payroll deductions payable' },
    { role: 'net_pay_payable',      credit: t.net,         description: 'Net salaries payable' }
  ].filter(l => r2(l.debit || l.credit) !== 0);
}

/** Journal lines with the resolved accounts (pure). */
function buildLines(t, acc) {
  return lineSpecs(t).map(l => ({ accountId: acc[l.role].id, debit: r2(l.debit || 0), credit: r2(l.credit || 0), description: l.description, _role: l.role }));
}

const balanced = (lines) => {
  const d = r2(lines.reduce((s, l) => s + l.debit, 0)), c = r2(lines.reduce((s, l) => s + l.credit, 0));
  return { debit: d, credit: c, ok: Math.abs(d - c) < 0.005 };
};

function lastDayOf(periodKey) {
  const [y, m] = periodKey.split('-').map(Number);
  return `${periodKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

async function findRunJournals(supabase, companyId, runId) {
  const { data, error } = await supabase.from('journals')
    .select('id, status, reference, metadata')
    .eq('company_id', companyId)
    .eq('source_type', 'payroll');
  if (error) throw new Error(error.message);
  return (data || []).filter(j => j.metadata && String(j.metadata.run_id) === String(runId));
}

/**
 * Create the draft journal for a finalized run. Idempotent (one per run).
 * @param {object} deps { supabase, JournalService }
 * @returns {Promise<{created:boolean, journal_id?, reason?, missing_accounts?, totals?}>}
 */
async function createDraftForRun(deps, { companyId, runId, periodKey, userId }) {
  const { supabase, JournalService } = deps;
  try {
    const existing = (await findRunJournals(supabase, companyId, runId)).filter(j => !(j.metadata && j.metadata.reversal_of));
    if (existing.length) return { created: false, journal_id: existing[0].id, reason: 'already_exists' };

    const { data: accounts, error: accErr } = await supabase.from('accounts')
      .select('id, code, name, type, is_postable, is_active').eq('company_id', companyId);
    if (accErr) return { created: false, reason: 'accounts_unavailable' };
    if (!(accounts || []).length) return { created: false, reason: 'ledger_not_set_up' };
    const { found, missing } = resolveAccounts(accounts);

    const { data: snaps, error: snapErr } = await supabase.from('payroll_snapshots')
      .select('calculation_output').eq('company_id', companyId).eq('payroll_run_id', runId)
      .eq('is_locked', true).neq('status', 'reversed');
    if (snapErr) return { created: false, reason: 'snapshots_unavailable' };
    const totals = runTotals(snaps);
    if (!totals.employees) return { created: false, reason: 'no_finalized_payslips' };

    const needed = new Set(lineSpecs(totals).map(l => l.role));
    const missingNeeded = missing.filter(m => needed.has(m.role));
    if (missingNeeded.length) {
      return { created: false, reason: 'missing_accounts', missing_accounts: missingNeeded.map(m => m.label), totals };
    }

    const lines = buildLines(totals, found);
    const bal = balanced(lines);
    if (!bal.ok) return { created: false, reason: 'not_balanced', totals, balance: bal };

    const journal = await JournalService.createDraftJournal({
      companyId,
      date: lastDayOf(periodKey),
      reference: 'PAYROLL ' + periodKey,
      description: `Paytime payroll ${periodKey} — ${totals.employees} employee(s) (draft — review and post)`,
      sourceType: 'payroll',
      createdByUserId: userId || null,
      lines: lines.map(({ _role, ...l }) => l),   // eslint-disable-line no-unused-vars
      metadata: { source: 'paytime', run_id: runId, period_key: periodKey, totals }
    });
    return { created: true, journal_id: journal.id, totals };
  } catch (err) {
    console.error('[payroll journal] create failed (payroll unaffected):', err.message);
    return { created: false, reason: 'error', error: err.message };
  }
}

/**
 * A run was reversed: delete its still-draft journal, or create a reversing draft for a
 * posted one. @param deps { supabase, JournalService, db }
 */
async function handleRunReversal(deps, { companyId, runId, periodKey, userId, reason }) {
  const { supabase, JournalService, db } = deps;
  try {
    const journals = (await findRunJournals(supabase, companyId, runId)).filter(j => !(j.metadata && j.metadata.reversal_of));
    if (!journals.length) return { action: 'none' };
    const j = journals[0];

    if (j.status === 'draft') {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [j.id]);
        const del = await client.query(`DELETE FROM journals WHERE id = $1 AND company_id = $2 AND status = 'draft'`, [j.id, companyId]);
        if (del.rowCount !== 1) throw new Error('draft journal changed meanwhile');
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return { action: 'draft_deleted', journal_id: j.id };
    }

    if (j.status === 'posted') {
      const already = (await findRunJournals(supabase, companyId, runId)).find(x => x.metadata && String(x.metadata.reversal_of) === String(j.id));
      if (already) return { action: 'reversal_exists', journal_id: already.id };
      const { data: lines, error } = await supabase.from('journal_lines')
        .select('account_id, debit, credit, description').eq('journal_id', j.id);
      if (error) throw new Error(error.message);
      const rev = await JournalService.createDraftJournal({
        companyId,
        date: lastDayOf(periodKey),
        reference: 'PAYROLL REVERSAL ' + periodKey,
        description: `Reversal of payroll journal ${j.reference || j.id} — pay run reversed${reason ? ': ' + reason : ''} (draft — review and post)`,
        sourceType: 'payroll',
        createdByUserId: userId || null,
        lines: (lines || []).map(l => ({ accountId: l.account_id, debit: Number(l.credit) || 0, credit: Number(l.debit) || 0, description: 'Reversal: ' + (l.description || '') })),
        metadata: { source: 'paytime', run_id: runId, period_key: periodKey, reversal_of: j.id }
      });
      return { action: 'reversal_draft_created', journal_id: rev.id };
    }
    return { action: 'none', status: j.status };
  } catch (err) {
    console.error('[payroll journal] reversal handling failed (payroll unaffected):', err.message);
    return { action: 'error', error: err.message };
  }
}

/** Real dependencies (lazy — the accounting pool is only needed when used). */
function defaultDeps() {
  return {
    supabase: require('../../../config/database').supabase,
    JournalService: require('../../accounting/services/journalService'),
    db: require('../../accounting/config/database')
  };
}

module.exports = { createDraftForRun, handleRunReversal, resolveAccounts, runTotals, lineSpecs, buildLines, balanced, defaultDeps, ROLES };
