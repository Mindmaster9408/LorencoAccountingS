'use strict';

/**
 * Tests for the line-item P&L matrix and financial-year grouping in
 * modules/accounting/services/profitLossService.js (pure functions — no DB).
 *
 *   fyStartMonthFromYearEnd()   — both stored formats ('February' / '02'), null fallback
 *   financialYearKeyFromMonth() — labelled by the year the FY ENDS in
 *   rollupMonthlySeries()       — 'financial_year' buckets for the trend chart
 *   buildProfitLossMatrix()     — sections, subtotals, empty-row filtering,
 *                                 and agreement with buildProfitLossTotals / the chart series
 */

const {
  aggregateLinesByMonth,
  buildMonthlySeries,
  monthRangeLabels,
  rollupMonthlySeries,
  buildProfitLossMatrix,
  fyStartMonthFromYearEnd,
  financialYearKeyFromMonth,
} = require('../modules/accounting/services/profitLossService');

const ACCOUNTS = [
  { id: 1, code: '4000', name: 'Sales', type: 'income', sub_type: 'operating_income' },
  { id: 2, code: '4500', name: 'Interest Received', type: 'income', sub_type: 'other_income' },
  { id: 3, code: '5000', name: 'Purchases', type: 'expense', sub_type: 'cost_of_sales' },
  { id: 4, code: '6100', name: 'Rent', type: 'expense', sub_type: 'operating_expense' },
  { id: 5, code: '6200', name: 'Never Used', type: 'expense', sub_type: 'operating_expense' },
  { id: 6, code: '7020', name: 'Finance Charges', type: 'expense', sub_type: 'finance_cost' },
];

// Feb 2025 (FY2025), Mar 2025 + Feb 2026 (FY2026), Mar 2026 (FY2027) for a Feb year-end.
const LINES = [
  { account_id: 1, debit: 0, credit: 1000, date: '2025-02-15' },
  { account_id: 3, debit: 400, credit: 0, date: '2025-02-15' },
  { account_id: 1, debit: 0, credit: 2000, date: '2025-03-10' },
  { account_id: 3, debit: 800, credit: 0, date: '2025-03-10' },
  { account_id: 4, debit: 300, credit: 0, date: '2025-03-31' },
  { account_id: 2, debit: 0, credit: 5, date: '2025-03-31' },
  { account_id: 6, debit: 10, credit: 0, date: '2025-03-31' },
  { account_id: 1, debit: 0, credit: 500, date: '2026-02-28' },
  { account_id: 4, debit: 100, credit: 0, date: '2026-03-01' },
];

describe('fyStartMonthFromYearEnd', () => {
  test.each([
    ['February', 3], ['feb', 3], ['02', 3], ['2', 3],
    ['03', 4], ['12', 1], ['June', 7],
    [null, 3], [undefined, 3], ['', 3], ['nonsense', 3], ['13', 3],
  ])('%p -> starts month %p', (input, expected) => {
    expect(fyStartMonthFromYearEnd(input)).toBe(expected);
  });
});

describe('financialYearKeyFromMonth', () => {
  test('Feb year-end: labelled by the year the FY ends in', () => {
    expect(financialYearKeyFromMonth('2025-02', 3)).toBe('FY2025');
    expect(financialYearKeyFromMonth('2025-03', 3)).toBe('FY2026');
    expect(financialYearKeyFromMonth('2026-02', 3)).toBe('FY2026');
  });
  test('Dec year-end (January start) equals the calendar year', () => {
    expect(financialYearKeyFromMonth('2025-01', 1)).toBe('FY2025');
    expect(financialYearKeyFromMonth('2025-12', 1)).toBe('FY2025');
  });
});

describe('buildProfitLossMatrix', () => {
  const monthKeys = monthRangeLabels('2025-02-01', '2026-03-31');
  const byMonth = aggregateLinesByMonth(LINES);

  test('financial_year columns, sections and subtotals', () => {
    const m = buildProfitLossMatrix(ACCOUNTS, byMonth, monthKeys, 'financial_year', 3);
    expect(m.columns.map(c => c.key)).toEqual(['FY2025', 'FY2026', 'FY2027']);
    expect(m.columns[1].months[0]).toBe('2025-03');
    expect(m.columns[1].months).toHaveLength(12);

    const rev = m.sections.find(s => s.key === 'operating_income');
    expect(rev.accounts[0].values).toEqual([1000, 2500, 0]);
    expect(m.totals.costOfSales).toEqual([400, 800, 0]);
    expect(m.totals.grossProfit).toEqual([600, 1700, 0]);
    expect(m.totals.otherIncome).toEqual([0, 5, 0]);
    expect(m.totals.operatingExpenses).toEqual([0, 300, 100]);
    expect(m.totals.financeCosts).toEqual([0, 10, 0]);
    expect(m.totals.netProfit).toEqual([600, 1395, -100]);
  });

  test('accounts with no activity in any column are left out', () => {
    const m = buildProfitLossMatrix(ACCOUNTS, byMonth, monthKeys, 'financial_year', 3);
    const opex = m.sections.find(s => s.key === 'operating_expense');
    expect(opex.accounts.map(a => a.code)).toEqual(['6100']);
  });

  test('section totals equal the P&L totals for every column', () => {
    const m = buildProfitLossMatrix(ACCOUNTS, byMonth, monthKeys, 'monthly', 3);
    const rev = m.sections.find(s => s.key === 'operating_income');
    expect(rev.total).toEqual(m.totals.operatingIncome);
    expect(m.columns).toHaveLength(14);
    expect(m.columns[0]).toMatchObject({ key: '2025-02', label: 'Feb 2025' });
  });

  test('net profit agrees with the trend chart series at every granularity', () => {
    const monthly = buildMonthlySeries(ACCOUNTS, byMonth, monthKeys);
    for (const g of ['monthly', 'quarterly', 'yearly', 'financial_year']) {
      const chart = rollupMonthlySeries(monthly, monthKeys, g, 3);
      const m = buildProfitLossMatrix(ACCOUNTS, byMonth, monthKeys, g, 3);
      expect(m.totals.netProfit).toEqual(chart.datasets[2].data);
      expect(m.columns.map(c => c.label)).toEqual(chart.labels);
    }
  });
});
