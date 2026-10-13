'use strict';

/**
 * ============================================================================
 * Who may be paid in a pay period — Fase 5 (spec 03 WN-10, 07 UF-02, finding V4)
 * ============================================================================
 * One rule for Execute Payroll, the single payslip calculation and the golden
 * test harness:
 *
 *   - hired AFTER the period ends     → blocked, with a clear message (WN-10)
 *   - terminated BEFORE the period    → excluded (even if still flagged active)
 *   - inactive, not terminated in it  → excluded
 *   - otherwise                       → eligible (a hire/termination date inside
 *                                       the period is a pro-rata month)
 * Pure — no DB access.
 * ============================================================================
 */

const fmtDate = (d) => String(d || '').slice(0, 10);

/**
 * @param {object|null} emp  { is_active, hire_date, termination_date, first_name?, last_name? }
 * @param {string} periodStart 'YYYY-MM-DD'
 * @param {string} periodEnd   'YYYY-MM-DD'
 * @returns {{ eligible: boolean, code: string|null, message: string|null }}
 */
function payrollEligibility(emp, periodStart, periodEnd) {
  if (!emp) return { eligible: false, code: 'NOT_FOUND', message: 'Employee not found in this company' };
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ') || 'This employee';
  const hire = fmtDate(emp.hire_date);
  const term = fmtDate(emp.termination_date);

  if (hire && periodEnd && hire > periodEnd) {
    return {
      eligible: false, code: 'STARTS_AFTER_PERIOD',
      message: `${name} only starts on ${hire}. Choose a later period, or change the start date if it is wrong.`
    };
  }
  if (term && periodStart && term < periodStart) {
    return {
      eligible: false, code: 'TERMINATED_BEFORE_PERIOD',
      message: `${name} left on ${term}, before this period — not included.`
    };
  }
  if (!emp.is_active && !(term && periodStart && periodEnd && term >= periodStart && term <= periodEnd)) {
    return { eligible: false, code: 'INACTIVE', message: 'Employee is not active — skipped' };
  }
  return { eligible: true, code: null, message: null };
}

module.exports = { payrollEligibility };
