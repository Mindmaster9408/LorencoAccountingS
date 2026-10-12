'use strict';

/**
 * ============================================================================
 * Paytime month-order rules — docs/paytime/spec/07_UITVOER_EN_FINALISERING.md (UF-04, UF-09)
 * ============================================================================
 * PAYE year-to-date only counts LOCKED (finalized or imported) prior months, so
 * the order in which months are calculated and finalized matters.
 *
 * Decided by Ruan 2026-10-12:
 *   - Calculate (payslip screen + Execute Payroll) is refused when the PREVIOUS
 *     month is not finalized — only for companies with
 *     companies.payroll_strict_period_order = TRUE (migration 026). Exception: the
 *     employee's first month in Paytime this tax year.
 *   - Finalize is always refused when a LATER month is already finalized.
 *   - Finalize with open EARLIER months: refused for strict companies; for the
 *     others it needs the user's confirmation.
 * ============================================================================
 */

const PayrollEngine = require('../../../core/payroll-engine');

/** All 12 period keys ('YYYY-MM') of the SA tax year that contains periodKey. */
function taxYearPeriodKeys(periodKey) {
  const startYear = parseInt(PayrollEngine.getTaxYearForPeriod(periodKey).split('/')[0], 10);
  const keys = [];
  for (let i = 0; i < 12; i++) {
    const m = ((2 + i) % 12) + 1;               // 3,4,…,12,1,2
    const y = m >= 3 ? startYear : startYear + 1;
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}

function periodEndDate(periodKey) {
  const [y, m] = periodKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${periodKey}-${String(last).padStart(2, '0')}`;
}

/** Previous month in the SAME tax year, or null for March (first month of the tax year). */
function previousPeriodInTaxYear(periodKey) {
  const keys = taxYearPeriodKeys(periodKey);
  const i = keys.indexOf(periodKey);
  return i > 0 ? keys[i - 1] : null;
}

const employeeName = emp => `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || `Employee ${emp.id}`;
const lockedSetFor = (emp, lockedRows) => new Set((lockedRows || [])
  .filter(r => String(r.employee_id) === String(emp.id))
  .map(r => r.period_key));
const employedIn = (emp, periodKey) => {
  const hire = emp.start_date || emp.hire_date || null;
  return !hire || hire <= periodEndDate(periodKey);
};

/**
 * Finalize rule (pure).
 * @returns {object[]} [{ employee_id, name, type: 'later_locked'|'missing_previous', periods: [] }]
 */
function findPeriodSequenceViolations(periodKey, employees, lockedRows) {
  const yearKeys = taxYearPeriodKeys(periodKey);
  const violations = [];
  for (const emp of employees || []) {
    const locked = lockedSetFor(emp, lockedRows);
    const name = employeeName(emp);
    const later = yearKeys.filter(p => p > periodKey && locked.has(p));
    if (later.length) {
      violations.push({ employee_id: emp.id, name, type: 'later_locked', periods: later });
      continue;
    }
    const earlier = yearKeys.filter(p => p < periodKey);
    const firstLocked = earlier.find(p => locked.has(p));
    if (!firstLocked) continue;   // first month in Paytime this tax year — never blocked
    const missing = earlier.filter(p => p > firstLocked && !locked.has(p) && employedIn(emp, p));
    if (missing.length) violations.push({ employee_id: emp.id, name, type: 'missing_previous', periods: missing });
  }
  return violations;
}

/**
 * Calculate rule (pure): the previous month (same tax year) must be locked, unless the
 * employee has no locked month earlier in this tax year (first month in Paytime) or was
 * not yet employed in the previous month.
 * @returns {object[]} [{ employee_id, name, periods: [previousPeriod] }]
 */
function findCalculationBlocks(periodKey, employees, lockedRows) {
  const prev = previousPeriodInTaxYear(periodKey);
  if (!prev) return [];
  const blocks = [];
  for (const emp of employees || []) {
    const locked = lockedSetFor(emp, lockedRows);
    const hasEarlier = [...locked].some(p => p < periodKey);
    if (!hasEarlier) continue;
    if (!employedIn(emp, prev)) continue;
    if (!locked.has(prev)) blocks.push({ employee_id: emp.id, name: employeeName(emp), periods: [prev] });
  }
  return blocks;
}

function listViolations(violations) {
  const shown = violations.slice(0, 5).map(v => `${v.name}: ${v.periods.join(', ')}`);
  const more = violations.length > 5 ? `; and ${violations.length - 5} more employee(s)` : '';
  return shown.join('; ') + more;
}

function describeLaterLocked(periodKey, violations) {
  return `Cannot finalize ${periodKey}: a later month is already finalized for ` +
    `${listViolations(violations)}. Reverse the later month(s) first, then finalize in order.`;
}

function describeOpenEarlier(periodKey, violations) {
  return `Earlier months are not finalized in Paytime for ${listViolations(violations)}. ` +
    `PAYE for ${periodKey} only uses the months that are in Paytime. For the most accurate PAYE, ` +
    `import the missing months (Import) first. Continue and finalize ${periodKey} anyway?`;
}

function describeCalculationBlocks(periodKey, blocks) {
  return `Cannot calculate ${periodKey} yet — PAYE uses the previous month, which is not finalized for ` +
    `${listViolations(blocks)}. Finalize (or import) the previous month first.`;
}

// ── DB helpers (every query is scoped to the company) ────────────────────────

/** TRUE only when the column exists and is TRUE. Missing column / error → FALSE (non-strict). */
async function isStrictPeriodOrder(supabase, companyId) {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('payroll_strict_period_order')
      .eq('id', companyId)
      .maybeSingle();
    if (error || !data) return false;
    return data.payroll_strict_period_order === true;
  } catch (_) {
    return false;
  }
}

async function loadEmployeesAndLocked(supabase, companyId, employeeIds, periodKey) {
  const [{ data: employees, error: eErr }, { data: lockedRows, error: lErr }] = await Promise.all([
    supabase.from('employees').select('*').eq('company_id', companyId).in('id', employeeIds),
    supabase.from('payroll_snapshots').select('employee_id, period_key')
      .eq('company_id', companyId).eq('is_locked', true)
      .in('employee_id', employeeIds).in('period_key', taxYearPeriodKeys(periodKey))
  ]);
  if (eErr) throw eErr;
  if (lErr) throw lErr;
  return { employees: employees || [], lockedRows: lockedRows || [] };
}

/**
 * Employees that may NOT be calculated for periodKey (strict companies only).
 * @returns {Promise<object[]>} blocks as in findCalculationBlocks; [] when not strict.
 */
async function getCalculationBlocks(supabase, companyId, employeeIds, periodKey) {
  if (!employeeIds || !employeeIds.length) return [];
  if (!previousPeriodInTaxYear(periodKey)) return [];
  if (!(await isStrictPeriodOrder(supabase, companyId))) return [];
  const { employees, lockedRows } = await loadEmployeesAndLocked(supabase, companyId, employeeIds, periodKey);
  return findCalculationBlocks(periodKey, employees, lockedRows);
}

module.exports = {
  taxYearPeriodKeys,
  periodEndDate,
  previousPeriodInTaxYear,
  findPeriodSequenceViolations,
  findCalculationBlocks,
  describeLaterLocked,
  describeOpenEarlier,
  describeCalculationBlocks,
  isStrictPeriodOrder,
  loadEmployeesAndLocked,
  getCalculationBlocks
};
