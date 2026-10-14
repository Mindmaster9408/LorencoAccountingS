'use strict';

/** Tests — spec 08 PS-05: year-to-date totals frozen with the payslip. */

const { createFakeSupabase } = require('./golden/fake-supabase');
const DS = require('../modules/payroll/services/PayrollDataService');
const CS = require('../modules/payroll/services/PayrollCalculationService');

const out = (o) => ({ gross: 20000, taxableGross: 20000, paye: 2000, uif: 177.12, uif_employer: 177.12, sdl: 200, deductions: 500, net: 17322.88, medicalCredit: 0 , ...o });
const snap = (p, o) => ({ company_id: 51, employee_id: 7, period_key: p, is_locked: true, status: 'finalized', calculation_output: out(o) });

test('prior totals: summed from finalized months of the same tax year only', async () => {
  const db = { payroll_snapshots: [snap('2026-03'), snap('2026-04', { gross: 25000, net: 21000 }), snap('2026-02'), Object.assign(snap('2026-05'), { is_locked: false })] };
  const y = await DS.fetchYtdData(51, 7, '2026-06', createFakeSupabase(db));
  expect(y.prior_totals).toMatchObject({ months: 2, gross: 45000, net: 38322.88, paye: 4000, sdl: 400 });
});

test('payslip ytd = prior months + this payslip; first month of the year = this payslip', async () => {
  const inputs = { basic_salary: 20000, regular_inputs: [], currentInputs: [], overtime: [], shortTime: [], multiRate: [],
    employeeOptions: { age: 35 }, period: '2026-06',
    ytdData: null };
  const first = await CS.calculate(Object.assign({}, inputs, { period: '2026-03' }), {});
  expect(first.ytd).toMatchObject({ tax_year: expect.any(String), months: 1, gross: first.gross, paye: first.paye, net: first.net });

  const later = await CS.calculate(Object.assign({}, inputs, { ytdData: { method: 'cumulative_ytd', prior_taxable_gross: 40000, prior_paye_paid: 4000,
    prior_periodic_taxable_gross: 40000, prior_once_off_taxable_gross: 0, prior_total_paye_paid: 4000,
    prior_totals: { months: 2, gross: 40000, taxable: 40000, paye: 4000, uif: 354.24, uif_employer: 354.24, sdl: 400, deductions: 0, net: 35645.76, medical_credit: 0 } } }), {});
  expect(later.ytd.months).toBe(3);
  expect(later.ytd.gross).toBe(Math.round((40000 + later.gross) * 100) / 100);
  expect(later.ytd.net).toBe(Math.round((35645.76 + later.net) * 100) / 100);
});
