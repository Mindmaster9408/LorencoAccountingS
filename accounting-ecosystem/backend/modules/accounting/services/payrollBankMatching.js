'use strict';

/**
 * ============================================================================
 * Ledger Leo — recognise payroll payments on the bank statement
 * (Paytime spec 10 VU-04 part 2, owner-confirmed 2026-10-12)
 * ============================================================================
 * The payroll journal (Paytime → Leo draft, payrollJournal.js) credits:
 *   Salaries Payable (net pay control)  — cleared by the salary payments
 *   PAYE / UIF Payable (2400), SDL Payable (2410) — cleared by the EMP201 payment
 * This service looks at UNMATCHED money-out bank transactions and SUGGESTS which
 * payroll payment each one is, by exact amount (to the cent) and date window:
 *   net      — one bank payment of a whole run's net pay (bulk EFT)
 *   emp      — one employee's net pay from a run
 *   emp201   — the month's PAYE + UIF (both sides) + SDL to SARS (split 2400 / 2410)
 *
 * Suggest only. Nothing is allocated here — the accountant confirms on the Bank page,
 * which uses the normal allocate endpoint (journal posted, audited, reversible).
 * Figures come only from finalized (locked, not reversed) snapshots — never
 * recalculated. A suggestion already used for an earlier bank allocation (journal
 * metadata.payrollMatchKey) is still shown but marked already_matched and ranked last,
 * so a second payment of the same amount is never presented as the obvious match.
 * ============================================================================
 */

const { resolveAccounts } = require('../../payroll/services/payrollJournal');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n) => Math.round((Number(n) || 0) * 100);
const DAY = 86400000;

const KEY_RE = /^payroll:(net|emp|emp201):[A-Za-z0-9:_-]{1,100}$/;

function periodEnd(periodKey) {
  const [y, m] = String(periodKey).split('-').map(Number);
  return Date.UTC(y, m, 0);                      // last day of the period month
}
function periodStart(periodKey) {
  const [y, m] = String(periodKey).split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}
const dayOf = (d) => { const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z'); return isNaN(t) ? null : t; };

// Payment windows (inclusive). Salaries: from the 1st of the month to 20 days after
// month end. EMP201: from 10 days before month end to 60 days after (late payments).
const WINDOWS = {
  net:    p => [periodStart(p), periodEnd(p) + 20 * DAY],
  emp:    p => [periodStart(p), periodEnd(p) + 20 * DAY],
  emp201: p => [periodEnd(p) - 10 * DAY, periodEnd(p) + 60 * DAY]
};

/** Period keys (YYYY-MM) whose windows can contain any of these dates. */
function periodsFor(dates) {
  const ts = dates.map(dayOf).filter(t => t != null);
  if (!ts.length) return [];
  const min = new Date(Math.min(...ts) - 70 * DAY), max = new Date(Math.max(...ts));
  const out = [];
  for (let y = min.getUTCFullYear(), m = min.getUTCMonth(); y < max.getUTCFullYear() || (y === max.getUTCFullYear() && m <= max.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Build the payment candidates from finalized snapshots (pure).
 * @param snapshots rows { employee_id, payroll_run_id, period_key, calculation_output }
 * @param employees rows { id, first_name, last_name }
 */
function buildCandidates(snapshots, employees) {
  const names = {};
  (employees || []).forEach(e => { names[e.id] = [e.first_name, e.last_name].filter(Boolean).join(' ') || `Employee ${e.id}`; });
  const runs = {}, months = {}, out = [];
  (snapshots || []).forEach(s => {
    const o = s.calculation_output || {};
    const net = r2(o.net);
    if (net > 0) {
      out.push({ kind: 'emp', key: `payroll:emp:${s.payroll_run_id}:${s.employee_id}`, period_key: s.period_key,
                 run_id: s.payroll_run_id, employee_id: s.employee_id, amount: net,
                 label: `Net pay — ${names[s.employee_id] || 'Employee ' + s.employee_id}, ${s.period_key}`,
                 parts: { net_pay_payable: net } });
    }
    const r = runs[s.payroll_run_id] || (runs[s.payroll_run_id] = { period_key: s.period_key, net: 0, n: 0 });
    r.net += Number(o.net) || 0; r.n++;
    const m = months[s.period_key] || (months[s.period_key] = { paye_uif: 0, sdl: 0 });
    m.paye_uif += (Number(o.paye) || 0) + (Number(o.uif) || 0) + (Number(o.uif_employer != null ? o.uif_employer : o.uif) || 0);
    m.sdl += Number(o.sdl) || 0;
  });
  Object.entries(runs).forEach(([runId, r]) => {
    if (r.n < 2 || r2(r.net) <= 0) return;      // a one-person run is already an 'emp' candidate
    out.push({ kind: 'net', key: `payroll:net:${runId}`, period_key: r.period_key, run_id: runId, amount: r2(r.net),
               label: `Net pay — whole pay run ${r.period_key} (${r.n} employees)`, parts: { net_pay_payable: r2(r.net) } });
  });
  Object.entries(months).forEach(([p, m]) => {
    const total = r2(r2(m.paye_uif) + r2(m.sdl));   // = sum of the rounded lines (balanced journal)
    if (total <= 0) return;
    out.push({ kind: 'emp201', key: `payroll:emp201:${p}`, period_key: p, amount: total,
               label: `SARS EMP201 ${p} — PAYE + UIF ${r2(m.paye_uif).toFixed(2)}, SDL ${r2(m.sdl).toFixed(2)}`,
               parts: { paye_uif_payable: r2(m.paye_uif), sdl_payable: r2(m.sdl) } });
  });
  return out;
}

/**
 * Match bank transactions to candidates (pure).
 * @returns {Object<string, Array>} bankTransactionId → ranked matches
 */
function matchTransactions(txns, candidates, accounts, matchedKeys) {
  const { found, missing } = resolveAccounts(accounts);
  const missingByRole = Object.fromEntries(missing.map(m => [m.role, m.label]));
  const used = new Set(matchedKeys || []);
  const result = {};
  (txns || []).forEach(t => {
    if (t.status !== 'unmatched' || !(Number(t.amount) < 0)) return;
    const d = dayOf(t.date);
    if (d == null) return;
    const want = cents(Math.abs(t.amount));
    const matches = candidates
      .filter(c => cents(c.amount) === want)
      .filter(c => { const [a, b] = WINDOWS[c.kind](c.period_key); return d >= a && d <= b; })
      .map(c => {
        const lines = [], missingAccounts = [];
        Object.entries(c.parts).forEach(([role, amt]) => {
          if (r2(amt) === 0) return;
          const acc = found[role];
          if (acc) lines.push({ accountId: acc.id, accountCode: acc.code, accountName: acc.name, amount: r2(amt) });
          else missingAccounts.push(missingByRole[role] || role);
        });
        return {
          kind: c.kind, key: c.key, period_key: c.period_key, run_id: c.run_id || null,
          employee_id: c.employee_id || null, label: c.label, amount: c.amount,
          lines, missing_accounts: missingAccounts, already_matched: used.has(c.key),
          _distance: Math.abs(d - periodEnd(c.period_key))
        };
      })
      .sort((a, b) => (a.already_matched - b.already_matched) || (a._distance - b._distance))
      .map(({ _distance, ...m }) => m);
    if (matches.length) result[t.id] = matches;
  });
  return result;
}

/**
 * Suggestions for the given bank transactions of one company.
 * @param {object} supabase
 * @returns {Promise<Object<string, Array>>}
 */
async function suggestForTransactions(supabase, companyId, transactionIds) {
  const ids = (transactionIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!ids.length) return {};

  const { data: txns, error: tErr } = await supabase.from('bank_transactions')
    .select('id, date, amount, status').eq('company_id', companyId).in('id', ids);
  if (tErr) throw new Error(tErr.message);
  const outgoing = (txns || []).filter(t => t.status === 'unmatched' && Number(t.amount) < 0);
  if (!outgoing.length) return {};

  const periods = periodsFor(outgoing.map(t => t.date));
  const { data: snaps, error: sErr } = await supabase.from('payroll_snapshots')
    .select('employee_id, payroll_run_id, period_key, calculation_output')
    .eq('company_id', companyId).eq('is_locked', true).neq('status', 'reversed')
    .in('period_key', periods);
  if (sErr) throw new Error(sErr.message);
  if (!(snaps || []).length) return {};

  const empIds = [...new Set(snaps.map(s => s.employee_id))];
  const [{ data: emps }, { data: accounts }, { data: used }] = await Promise.all([
    supabase.from('employees').select('id, first_name, last_name').eq('company_id', companyId).in('id', empIds),
    supabase.from('accounts').select('id, code, name, type, is_postable, is_active').eq('company_id', companyId),
    supabase.from('journals').select('metadata').eq('company_id', companyId).eq('source_type', 'bank')
      .neq('status', 'reversed').not('metadata->>payrollMatchKey', 'is', null)
  ]);
  const matchedKeys = (used || []).map(j => j.metadata && j.metadata.payrollMatchKey).filter(Boolean);
  return matchTransactions(outgoing, buildCandidates(snaps, emps), accounts, matchedKeys);
}

/** Validated key for journal metadata, or null. */
function cleanMatchKey(k) {
  return typeof k === 'string' && KEY_RE.test(k) ? k : null;
}

module.exports = { buildCandidates, matchTransactions, suggestForTransactions, periodsFor, cleanMatchKey, WINDOWS };
