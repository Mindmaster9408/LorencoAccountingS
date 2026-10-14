'use strict';

/**
 * Tests — spec 04 IT-06 (s11F 27.5% / R350 000 limit) and IT-07 (fringe benefits:
 * company car calculator, employer retirement contribution deemed paid by the employee).
 */

const E = require('../core/payroll-engine');
const Car = require('../modules/payroll/services/companyCar');

const calc = (salary, regular) => E.calculateFromData(
  { basic_salary: salary, regular_inputs: regular || [] }, [], [], [], [], { age: 35 }, '2026-10');

describe('IT-06 retirement deduction limit', () => {
  test('within 27.5%: the whole pre-tax contribution is deducted (unchanged behaviour)', () => {
    const r = calc(30000, [{ description: 'Pension', amount: 2000, type: 'deduction', tax_treatment: 'pre_tax' }]);
    expect(r.retirement_deduction_allowed).toBe(2000);
    expect(r.taxableGross).toBe(28000);
  });

  test('above 27.5% of remuneration: only 27.5% is deducted', () => {
    const r = calc(20000, [{ description: 'RA', amount: 8000, type: 'deduction', tax_treatment: 'pre_tax' }]);
    expect(r.retirement_cap_monthly).toBe(5500);
    expect(r.retirement_deduction_allowed).toBe(5500);
    expect(r.taxableGross).toBe(14500);
    expect(r.net).toBe(E.r2(20000 - 8000 - r.paye - r.uif));   // the full R8 000 is still deducted from pay
  });

  test('annual R350 000 limit: max R29 166.67 a month', () => {
    const r = calc(200000, [{ description: 'Pension', amount: 60000, type: 'deduction', tax_treatment: 'pre_tax' }]);
    expect(r.retirement_deduction_allowed).toBe(29166.67);
  });
});

describe('IT-07 employer retirement contribution (IRP5 3817)', () => {
  test('taxable fringe benefit AND deemed employee contribution → no extra PAYE within the limit', () => {
    const base = calc(30000);
    const r = calc(30000, [{ description: 'Employer pension', amount: 2000, type: 'company_contribution', irp5_code: '3817' }]);
    expect(r.fringe_benefits_taxable).toBe(2000);
    expect(r.retirement_deduction_allowed).toBe(2000);
    expect(r.taxableGross).toBe(base.taxableGross);
    expect(r.paye).toBe(base.paye);
    expect(r.net).toBe(base.net);
    expect(r.sdl).toBe(320);        // SDL is on total remuneration incl. the benefit — retirement deductions never reduce it
  });

  test('without the retirement code it stays an ordinary taxable contribution (IT-10)', () => {
    const base = calc(30000);
    const r = calc(30000, [{ description: 'Employer medical', amount: 2000, type: 'company_contribution', irp5_code: '3810' }]);
    expect(r.taxableGross).toBe(base.taxableGross + 2000);
    expect(r.paye).toBeGreaterThan(base.paye);
  });
});

describe('IT-07 company car', () => {
  const car = { id: 1, determined_value: 400000, maintenance_plan: false, business_use_80: false, start_period: '2026-09', end_period: null };

  test('calculator: 3.5% (2.5% with maintenance plan), PAYE on 80% (20% at ≥80% business use)', () => {
    expect(Car.monthlyValue(car)).toBe(14000);
    expect(Car.monthlyValue(Object.assign({}, car, { maintenance_plan: true }))).toBe(10000);
    expect(Car.taxablePercentage(car)).toBe(80);
    expect(Car.taxablePercentage(Object.assign({}, car, { business_use_80: true }))).toBe(20);
  });

  test('months it applies', () => {
    expect(Car.carInputs([car], '2026-08')).toEqual([]);
    expect(Car.carInputs([Object.assign({}, car, { end_period: '2026-10' })], '2026-11')).toEqual([]);
    expect(Car.carInputs([car], '2026-10')[0]).toMatchObject({ amount: 14000, type: 'fringe_benefit', taxable_percentage: 80, irp5_code: '3802' });
  });

  test('engine: taxable on 80%, never in gross or net, not in UIF, shown as a benefit line', () => {
    const base = calc(30000);
    const r = calc(30000, Car.carInputs([car], '2026-10'));
    expect(r.gross).toBe(base.gross);
    expect(r.taxableGross).toBe(base.taxableGross + 11200);
    expect(r.uif).toBe(base.uif);
    expect(r.fringe_benefits).toBe(14000);
    expect(r.employer_contributions).toBe(0);
    expect(r.net).toBe(E.r2(base.net - (r.paye - base.paye)));
    expect(r.payslip_lines.find(l => l.kind === 'fringe_benefit')).toMatchObject({ section: 'employer', amount: 14000, taxable_percentage: 80 });
    expect(r.payslip_check.ok).toBe(true);
  });
});
