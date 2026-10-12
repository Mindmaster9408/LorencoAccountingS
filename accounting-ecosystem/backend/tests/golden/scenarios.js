'use strict';

/**
 * ============================================================================
 * Paytime golden scenarios — see docs/paytime/REGSTELPLAN_2026-10.md §1.1
 * ============================================================================
 * Each scenario describes one employee in one company over one or more pay
 * periods. The runner pushes it through the REAL production pipeline
 * (PayrollDataService.fetchCalculationInputs → PayrollCalculationService.calculate)
 * against an in-memory database, locking each period before the next one so
 * YTD behaves exactly as in production.
 *
 * Defaults mirror PRODUCTION as found on 2026-10-12 (Fase 0.1):
 *   - PAYE_YTD_METHOD = cumulative        (was projection_type until 2026-10-12, step D.1)
 *   - tax_config      = the __global__ KV row, copied verbatim below
 *
 * The baseline records CURRENT behaviour, including known defects. Each fix
 * phase must change only the scenarios it lists as expected changes.
 * ============================================================================
 */

// Copy of payroll_kv_store_eco (__global__, tax_config) in production.
// History:
//   2026-10-12 Fase 0 baseline: bracket 4 base 125559 + medical credits 364/364/246 (both wrong).
//   2026-10-12 step D.2: corrected in production to SARS 2027 — base 125599, medical 376/376/254.
const PROD_GLOBAL_TAX_CONFIG = {
  BRACKETS: [
    { max: 245100,  min: 0,       base: 0,      rate: 0.18 },
    { max: 383100,  min: 245101,  base: 44118,  rate: 0.26 },
    { max: 530200,  min: 383101,  base: 79998,  rate: 0.31 },
    { max: 695800,  min: 530201,  base: 125599, rate: 0.36 },
    { max: 887000,  min: 695801,  base: 185215, rate: 0.39 },
    { max: 1878600, min: 887001,  base: 259783, rate: 0.41 },
    { max: null,    min: 1878601, base: 666339, rate: 0.45 }
  ],
  SDL_RATE: 0.01, TAX_YEAR: '2026/2027', UIF_RATE: 0.01,
  PRIMARY_REBATE: 17820, TERTIARY_REBATE: 3249, UIF_MONTHLY_CAP: 177.12, SECONDARY_REBATE: 9765,
  MEDICAL_CREDIT_MAIN: 376, MEDICAL_CREDIT_FIRST_DEP: 376, MEDICAL_CREDIT_ADDITIONAL: 254
};

// ── Builders ──────────────────────────────────────────────────────────────────

/** Recurring item assigned to the employee ("Regular input"). */
function regular(name, type, amount, cfg = {}) {
  return { kind: 'regular', name, type, amount, cfg };
}
/** Current-period input ("Current input") — uses the item's master config if `cfg` given. */
function current(name, type, amount, cfg) {
  return { kind: 'current', name, type, amount, cfg };
}
const ot = (hours, rate_multiplier) => ({ hours, rate_multiplier });
const st = (hours_missed) => ({ hours_missed });
const mr = (hours, rate) => ({ hours, rate_multiplier: rate }); // as stored by employee-detail.html

/** Periods 'YYYY-MM' from start to end inclusive. */
function months(start, end) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Single-period scenario helper. */
function one(id, desc, period, overrides = {}, inputs = {}) {
  return Object.assign({ id, desc, periods: { [period]: inputs } }, overrides);
}

const emp = (o = {}) => Object.assign({
  basic_salary: 20000, dob: '1985-06-15', hire_date: '2020-01-01',
  medical_aid_members: 0, tax_directive: null, is_director: false,
  termination_date: null, voluntary_tax_config: null, is_active: true
}, o);

const P = '2026-10'; // default single period (current tax year, month 8)

// ── Scenarios ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  // Salary levels across the brackets
  one('S01', 'Basic R15 000', P, { employee: emp({ basic_salary: 15000 }) }),
  one('S02', 'Basic R25 000', P, { employee: emp({ basic_salary: 25000 }) }),
  one('S03', 'Basic R40 000 (UIF cap)', P, { employee: emp({ basic_salary: 40000 }) }),
  one('S04', 'Basic R50 000 (bracket 4 — base typo zone)', P, { employee: emp({ basic_salary: 50000 }) }),
  one('S05', 'Basic R80 000', P, { employee: emp({ basic_salary: 80000 }) }),
  one('S06', 'Basic R200 000 (top bracket)', P, { employee: emp({ basic_salary: 200000 }) }),

  // Age rebates and medical credits
  one('S07', 'Age 65 at year end, R25 000', P, { employee: emp({ basic_salary: 25000, dob: '1961-12-01' }) }),
  one('S08', 'Age 75 at year end, R25 000', P, { employee: emp({ basic_salary: 25000, dob: '1951-12-01' }) }),
  one('S09', 'Medical aid 1 member, R25 000', P, { employee: emp({ basic_salary: 25000, medical_aid_members: 1 }) }),
  one('S10', 'Medical aid 2 members, R25 000', P, { employee: emp({ basic_salary: 25000, medical_aid_members: 2 }) }),
  one('S11', 'Medical aid 4 members, R25 000', P, { employee: emp({ basic_salary: 25000, medical_aid_members: 4 }) }),

  // Regular items
  one('S12', 'Travel allowance R5 000 @ 80% taxable', P, { employee: emp(),
    items: [regular('Travel Allowance', 'allowance', 5000, { taxable_percentage: 80, proj: 'FIXED_RECURRING' })] }),
  // Ruan 2026-10-12: UIF on a travel allowance must be on the 80% taxable portion only.
  // Basic below the UIF ceiling so the 80% is visible: expected UIF base 10 000 + 4 000 = 14 000 → R140.
  one('S12a', 'Travel allowance R5 000 @ 80% — UIF on 80% only (regular)', P, { employee: emp({ basic_salary: 10000 }),
    items: [regular('Travel Allowance', 'allowance', 5000, { taxable_percentage: 80, proj: 'FIXED_RECURRING' })] }),
  one('S12b', 'Travel allowance R5 000 @ 80% — UIF on 80% only (current input)', P, { employee: emp({ basic_salary: 10000 }),
    master: [{ item_name: 'Travel Allowance', taxable_percentage: 80, proj: 'FIXED_RECURRING' }] },
    { inputs: [current('Travel Allowance', 'income', 5000)] }),
  one('S13', 'Non-taxable reimbursement R2 000', P, { employee: emp(),
    items: [regular('Reimbursement', 'allowance', 2000, { is_taxable: false, affects_uif: false })] }),
  one('S14', 'Pension R2 000 pre-tax on R30 000', P, { employee: emp({ basic_salary: 30000 }),
    items: [regular('Pension Fund', 'deduction', 2000, { tax_treatment: 'pre_tax' })] }),
  one('S15', 'Medical aid employee portion R1 500 (net only)', P, { employee: emp({ basic_salary: 30000 }),
    items: [regular('Medical Aid', 'deduction', 1500, { tax_treatment: 'net_only' })] }),
  one('S16', 'Percentage item 10% of basic', P, { employee: emp(),
    items: [regular('Housing 10%', 'allowance', null, { percentage: 10 })] }),
  one('S17', 'Employer contribution item (IT-10)', P, { employee: emp(),
    items: [regular('Employer Pension Contribution', 'employer_contribution', 1500, {})] }),

  // Current inputs
  one('S20', 'Once-off bonus R20 000 (current input, no master)', P, { employee: emp() },
    { inputs: [current('Bonus', 'income', 20000)] }),
  one('S21', 'Non-taxable current input (master says not taxable) — B1', P, { employee: emp(),
    master: [{ item_name: 'Tool Reimbursement', is_taxable: false, affects_uif: false }] },
    { inputs: [current('Tool Reimbursement', 'income', 3000)] }),
  one('S22', 'Pre-tax current deduction (master pre_tax) — B2', P, { employee: emp({ basic_salary: 30000 }),
    master: [{ item_name: 'RA Contribution', item_type: 'deduction', tax_treatment: 'pre_tax' }] },
    { inputs: [current('RA Contribution', 'deduction', 2000)] }),

  // Hours
  one('S30', 'Overtime 10h @1.5 + 4h @2.0', P, { employee: emp() }, { overtime: [ot(10, 1.5), ot(4, 2.0)] }),
  one('S31', 'Short time 16h', P, { employee: emp() }, { shortTime: [st(16)] }),
  one('S32', 'Multi-rate 10h @ R250 — K4', P, { employee: emp() }, { multiRate: [mr(10, 250)] }),

  // Flags
  one('S40', 'Director — WN-06 (Ruan: directors pay UIF)', P, { employee: emp({ is_director: true }) }),
  one('S41', 'Employee UIF-exempt — B9', P, { employee: emp(), setup: { uif_exempt: true } }),
  one('S42', 'Company not UIF registered', P, { employee: emp(), company: { uif_registered: false } }),
  one('S43', 'Company not SDL registered', P, { employee: emp(), company: { sdl_registered: false } }),
  one('S44', 'Tax directive 25%', P, { employee: emp({ tax_directive: 25 }) }),

  // Voluntary PAYE adjustments
  one('S50', 'Voluntary fixed +R500', P, { employee: emp({ voluntary_tax_config: [{ type: 'fixed', direction: 'increase', fixed_amount: 500 }] }) }),
  one('S51', 'Voluntary reduce R300 — W6 (to become inactive)', P, { employee: emp({ voluntary_tax_config: [{ type: 'fixed', direction: 'reduce', fixed_amount: 300, description: 'test' }] }) }),
  one('S52', 'Target PAYE R500 below statutory — VPA-04', P, { employee: emp({ voluntary_tax_config: [{ type: 'target_paye', target_paye: 500, description: 'test' }] }) }),
  one('S53', 'Target PAYE R5 000 above statutory', P, { employee: emp({ voluntary_tax_config: [{ type: 'target_paye', target_paye: 5000, description: 'test' }] }) }),

  // Pro-rata
  one('S60', 'Starts 10 Oct (pro-rata) — B8', P, { employee: emp({ hire_date: '2026-10-10' }) }),
  one('S61', 'Terminates 15 Oct (pro-rata)', P, { employee: emp({ termination_date: '2026-10-15', is_active: false }) }),
  one('S62', 'Starts 10 Oct with travel allowance (ENJ-21)', P, { employee: emp({ hire_date: '2026-10-10' }),
    items: [regular('Travel Allowance', 'allowance', 5000, { taxable_percentage: 80, proj: 'FIXED_RECURRING' })] }),

  // Tax table selection
  one('S70', 'Code default tables (no tax_config), R25 000', P, { employee: emp({ basic_salary: 25000 }), taxConfig: null }),
  one('S71', 'Back period 2024-06 with global override — W3', '2024-06', { employee: emp({ basic_salary: 25000 }) }),
  one('S72', 'Back period 2024-06 code tables only', '2024-06', { employee: emp({ basic_salary: 25000 }), taxConfig: null }),

  // ── Multi-period (each month locked before the next) ──
  { id: 'M01', desc: 'Full tax year R20 000, R20 000 bonus in December',
    employee: emp(), periods: Object.fromEntries(months('2026-03', '2027-02').map(p =>
      [p, p === '2026-12' ? { inputs: [current('Bonus', 'income', 20000)] } : {}])) },
  { id: 'M02', desc: 'Mid-year starter 1 Oct R30 000 — K2',
    employee: emp({ basic_salary: 30000, hire_date: '2026-10-01' }),
    periods: Object.fromEntries(months('2026-10', '2027-02').map(p => [p, {}])) },
  { id: 'M03', desc: 'R20 000 salary, R100 000 bonus in April — K3',
    employee: emp(), periods: Object.fromEntries(months('2026-03', '2026-08').map(p =>
      [p, p === '2026-04' ? { inputs: [current('Bonus', 'income', 100000)] } : {}])) },
  { id: 'M04', desc: 'Travel allowance 80% over 4 months (projection uses 100%?)',
    employee: emp(), items: [regular('Travel Allowance', 'allowance', 5000, { taxable_percentage: 80, proj: 'FIXED_RECURRING' })],
    periods: Object.fromEntries(months('2026-03', '2026-06').map(p => [p, {}])) },
  { id: 'M05', desc: 'Variable commission (VARIABLE_AVERAGE) 3k/0/8k/2k',
    employee: emp(), periods: { '2026-03': {}, '2026-04': {}, '2026-05': {}, '2026-06': {} },
    variableByPeriod: { name: 'Commission', amounts: { '2026-03': 3000, '2026-04': 0, '2026-05': 8000, '2026-06': 2000 } } },
  { id: 'M06', desc: 'Bonus spread R1 300 Sep–Dec, R20 000 bonus paid December — VPA-14',
    employee: emp({ voluntary_tax_config: [{ type: 'bonus_spread', direction: 'increase', bonus_amount: 20000,
      monthly_spread_amount: 1300, start_period: '2026-09', end_period: '2026-12' }] }),
    periods: Object.fromEntries(months('2026-09', '2026-12').map(p =>
      [p, p === '2026-12' ? { inputs: [current('Bonus', 'income', 20000)] } : {}])) },
  { id: 'M07', desc: 'M01 under average_taxable method (non-production default)', method: 'average_taxable',
    employee: emp(), periods: Object.fromEntries(months('2026-03', '2027-02').map(p =>
      [p, p === '2026-12' ? { inputs: [current('Bonus', 'income', 20000)] } : {}])) },
  { id: 'M08', desc: 'M02 under average_taxable method', method: 'average_taxable',
    employee: emp({ basic_salary: 30000, hire_date: '2026-10-01' }),
    periods: Object.fromEntries(months('2026-10', '2027-02').map(p => [p, {}])) }
];

module.exports = { SCENARIOS, PROD_GLOBAL_TAX_CONFIG };
