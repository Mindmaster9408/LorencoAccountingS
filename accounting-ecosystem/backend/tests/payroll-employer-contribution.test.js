'use strict';

/**
 * Tests — spec 04 IT-10 (owner decision a): employer contributions are never paid out.
 *   never in gross / net / deductions; taxable one → taxable income (PAYE + SDL), not UIF;
 *   payslip line under 'employer'; every other item unchanged.
 */

const E = require('../core/payroll-engine');

const BASE = { basic_salary: 20000, regular_inputs: [] };
const calc = (regular, current) => E.calculateFromData(
  Object.assign({}, BASE, { regular_inputs: regular || [] }), current || [], [], [], [], { age: 35 }, '2026-10');

const without = calc();

test('non-taxable employer contribution: nothing changes for the employee', () => {
  const r = calc([{ description: 'Employer UIF-like fund', amount: 1500, type: 'company_contribution', is_taxable: false }]);
  ['gross', 'taxableGross', 'paye', 'uif', 'sdl', 'net', 'deductions'].forEach(k => expect(r[k]).toBe(without[k]));
  expect(r.employer_contributions).toBe(1500);
  expect(r.fringe_benefits_taxable).toBe(0);
});

test('taxable employer contribution (fringe benefit): more PAYE + SDL, same gross and UIF, never in net', () => {
  const r = calc([{ description: 'Employer pension contribution', amount: 2000, type: 'employer_contribution' }]);
  expect(r.gross).toBe(without.gross);
  expect(r.taxableGross).toBe(without.taxableGross + 2000);
  expect(r.paye).toBeGreaterThan(without.paye);
  expect(r.uif).toBe(without.uif);
  expect(r.sdl).toBe(E.r2(without.sdl + 20));
  expect(r.net).toBe(E.r2(without.net - (r.paye - without.paye)));   // only the extra tax leaves net
  expect(r.fringe_benefits_taxable).toBe(2000);
});

test('payslip: contribution shown under employer, payslip still adds up', () => {
  const r = calc([{ description: 'Employer medical aid', amount: 1800, type: 'company_contribution' }]);
  const l = r.payslip_lines.find(x => x.kind === 'employer_contribution');
  expect(l).toMatchObject({ section: 'employer', description: 'Employer medical aid', amount: 1800, taxable: true });
  expect(r.payslip_lines.filter(x => x.section === 'earning').map(x => x.description)).toEqual(['Basic Salary']);
  expect(r.payslip_check.ok).toBe(true);
});

test('as a current (once-off) input as well', () => {
  const r = calc([], [{ description: 'Employer contribution', amount: 1000, type: 'employer_contribution', is_taxable: false }]);
  expect(r.net).toBe(without.net);
  expect(r.gross).toBe(without.gross);
  expect(r.employer_contributions).toBe(1000);
});

test('ordinary allowance is still paid (control)', () => {
  const r = calc([{ description: 'Cell allowance', amount: 500, type: 'allowance' }]);
  expect(r.gross).toBe(without.gross + 500);
  expect(r.employer_contributions).toBe(0);
});
