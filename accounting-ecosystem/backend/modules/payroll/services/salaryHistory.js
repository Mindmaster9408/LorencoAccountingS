'use strict';

/**
 * Paytime spec 03 WN-11 — salary history with an effective MONTH (Ruan 2026-10-14):
 *   1. a change applies from a month (the whole month — no split inside a month)
 *   2. effective month already finalized → back pay: the difference for the finalized
 *      months is added as ONE once-off "Back pay" input in the first open month;
 *      finalized payslips are never touched
 *   3. increases may be scheduled ahead (future effective month)
 * Table employee_salary_history (migration 034). Until it exists, nothing changes:
 * the salary is employees.basic_salary as before.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function nextPeriod(p) {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Current month in South Africa (YYYY-MM). */
function currentPeriod(now = new Date()) {
  const sa = new Date(now.getTime() + 2 * 3600 * 1000);   // SAST = UTC+2, no DST
  return `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Salary for a month (pure).
 * @param rows history rows of ONE employee
 * @param fallback employees.basic_salary
 */
function salaryForPeriod(rows, periodKey, fallback) {
  const list = (rows || []).slice().sort((a, b) =>
    a.effective_period.localeCompare(b.effective_period) || String(a.created_at || a.id).localeCompare(String(b.created_at || b.id)));
  if (!list.length) return { salary: Number(fallback) || 0, source: 'employee' };
  const applicable = list.filter(r => r.effective_period <= periodKey);
  if (applicable.length) {
    const r = applicable[applicable.length - 1];
    return { salary: Number(r.basic_salary) || 0, source: 'history', effective_period: r.effective_period };
  }
  const first = list[0];
  if (first.previous_salary != null) return { salary: Number(first.previous_salary) || 0, source: 'history_previous' };
  return { salary: Number(fallback) || 0, source: 'employee' };
}

/**
 * Back pay for a change effective in an already-finalized month (pure).
 * @param lockedSnaps this employee's finalized payslips { period_key, calculation_input, calculation_output }
 * @returns {{ amount, months: [{period_key, paid, due, diff}], target_period|null }}
 */
function backPay(newSalary, effectivePeriod, lockedSnaps) {
  const months = (lockedSnaps || [])
    .filter(s => s.period_key >= effectivePeriod)
    .sort((a, b) => a.period_key.localeCompare(b.period_key))
    .map(s => {
      const paidBasic = Number((s.calculation_input || {}).basic_salary) || 0;
      const factor = (s.calculation_output || {}).prorataFactor;
      const f = factor != null && factor > 0 && factor < 1 ? Number(factor) : 1;
      const diff = r2((Number(newSalary) - paidBasic) * f);
      return { period_key: s.period_key, paid_salary: paidBasic, new_salary: r2(newSalary), factor: f, diff };
    })
    .filter(m => m.diff !== 0);
  const latest = (lockedSnaps || []).map(s => s.period_key).sort().pop();
  return {
    amount: r2(months.reduce((t, m) => t + m.diff, 0)),
    months,
    target_period: latest && latest >= effectivePeriod ? nextPeriod(latest) : null
  };
}

let _hasTable = false;
async function hasTable(supabase) {
  if (_hasTable) return true;
  try {
    const { error } = await supabase.from('employee_salary_history').select('id').limit(1);
    if (!error) _hasTable = true;
  } catch (_) { /* not there yet */ }
  return _hasTable;
}

module.exports = { salaryForPeriod, backPay, nextPeriod, currentPeriod, hasTable, PERIOD_RE };
