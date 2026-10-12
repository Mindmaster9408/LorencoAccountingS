'use strict';

/**
 * Tests — Paytime month-order rules (UF-04 / UF-09), Fase 3b.
 * docs/paytime/FASE3_CHANGE_IMPACT_NOTE.md · docs/paytime/spec/07_UITVOER_EN_FINALISERING.md
 */

const {
  taxYearPeriodKeys,
  previousPeriodInTaxYear,
  findPeriodSequenceViolations,
  findCalculationBlocks,
  isStrictPeriodOrder,
  getCalculationBlocks
} = require('../modules/payroll/services/periodSequence');
const { createFakeSupabase } = require('./golden/fake-supabase');

const emp = (id, hire_date = '2020-01-01') => ({ id, first_name: 'Emp', last_name: String(id), hire_date });
const locked = (employee_id, ...periods) => periods.map(period_key => ({ employee_id, period_key }));

describe('taxYearPeriodKeys / previousPeriodInTaxYear', () => {
  test('March → February of the same SA tax year', () => {
    expect(taxYearPeriodKeys('2026-10')).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
      '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'
    ]);
  });
  test('January/February belong to the tax year that started the previous March', () => {
    expect(taxYearPeriodKeys('2027-02')[0]).toBe('2026-03');
    expect(taxYearPeriodKeys('2026-02')[0]).toBe('2025-03');
  });
  test('previous month stays inside the tax year; March has none', () => {
    expect(previousPeriodInTaxYear('2026-10')).toBe('2026-09');
    expect(previousPeriodInTaxYear('2027-01')).toBe('2026-12');
    expect(previousPeriodInTaxYear('2026-03')).toBeNull();
  });
});

describe('findPeriodSequenceViolations (finalize)', () => {
  test('complete history up to the previous month → allowed', () => {
    expect(findPeriodSequenceViolations('2026-06', [emp(1)], locked(1, '2026-03', '2026-04', '2026-05'))).toEqual([]);
  });
  test('first month in Paytime this tax year (no locked history) → allowed', () => {
    expect(findPeriodSequenceViolations('2026-10', [emp(1)], [])).toEqual([]);
  });
  test('gap after the first locked month → missing_previous with the months', () => {
    const v = findPeriodSequenceViolations('2026-10', [emp(1)], locked(1, '2026-04'));
    expect(v).toEqual([expect.objectContaining({ type: 'missing_previous',
      periods: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'] })]);
  });
  test('a LATER month already locked → later_locked', () => {
    const v = findPeriodSequenceViolations('2026-05', [emp(1)], locked(1, '2026-03', '2026-04', '2026-06'));
    expect(v).toEqual([expect.objectContaining({ type: 'later_locked', periods: ['2026-06'] })]);
  });
  test('later month in the NEXT tax year does not block', () => {
    expect(findPeriodSequenceViolations('2027-02', [emp(1)], locked(1, '2027-01', '2027-03'))).toEqual([]);
  });
  test('months before the employee was hired are not required', () => {
    expect(findPeriodSequenceViolations('2026-10', [emp(1, '2026-09-15')], locked(1, '2026-04', '2026-09'))).toEqual([]);
  });
  test('only the employee with the gap is reported; ids compare as strings', () => {
    const v = findPeriodSequenceViolations('2026-06', [emp(1), emp('2')],
      [...locked(1, '2026-03', '2026-04', '2026-05'), ...locked(2, '2026-03', '2026-05')]);
    expect(v.map(x => String(x.employee_id))).toEqual(['2']);
    expect(v[0].periods).toEqual(['2026-04']);
  });
});

describe('findCalculationBlocks (calculate)', () => {
  test('previous month locked → can calculate', () => {
    expect(findCalculationBlocks('2026-10', [emp(1)], locked(1, '2026-08', '2026-09'))).toEqual([]);
  });
  test('previous month open → blocked, names the previous month only', () => {
    const b = findCalculationBlocks('2026-10', [emp(1)], locked(1, '2026-04'));
    expect(b).toEqual([expect.objectContaining({ employee_id: 1, periods: ['2026-09'] })]);
  });
  test('first month in Paytime (no earlier locked month) → can calculate', () => {
    expect(findCalculationBlocks('2026-10', [emp(1)], [])).toEqual([]);
  });
  test('March is never blocked', () => {
    expect(findCalculationBlocks('2026-03', [emp(1)], locked(1, '2025-12'))).toEqual([]);
  });
  test('hired after the previous month → can calculate', () => {
    expect(findCalculationBlocks('2026-10', [emp(1, '2026-10-05')], locked(1, '2026-04'))).toEqual([]);
  });
});

describe('getCalculationBlocks — company switch (migration 026)', () => {
  const db = (strict) => ({
    companies: [{ id: 5, payroll_strict_period_order: strict }],
    employees: [Object.assign(emp(1), { company_id: 5 })],
    payroll_snapshots: [{ company_id: 5, employee_id: 1, period_key: '2026-04', is_locked: true }]
  });

  test('strict company → previous month open blocks', async () => {
    const b = await getCalculationBlocks(createFakeSupabase(db(true)), 5, [1], '2026-10');
    expect(b.map(x => x.periods[0])).toEqual(['2026-09']);
  });
  test('non-strict company → never blocks calculation', async () => {
    expect(await getCalculationBlocks(createFakeSupabase(db(false)), 5, [1], '2026-10')).toEqual([]);
  });
  test('column missing (migration not run yet) → treated as non-strict', async () => {
    const d = db(true); delete d.companies[0].payroll_strict_period_order;
    expect(await isStrictPeriodOrder(createFakeSupabase(d), 5)).toBe(false);
    expect(await getCalculationBlocks(createFakeSupabase(d), 5, [1], '2026-10')).toEqual([]);
  });
  test('other company rows are never read (company scoping)', async () => {
    const d = db(true);
    d.payroll_snapshots.push({ company_id: 99, employee_id: 1, period_key: '2026-09', is_locked: true });
    const b = await getCalculationBlocks(createFakeSupabase(d), 5, [1], '2026-10');
    expect(b.map(x => x.periods[0])).toEqual(['2026-09']);   // company 99's September does not count
  });
});
