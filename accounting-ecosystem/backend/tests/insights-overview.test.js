'use strict';

/**
 * Insights (owner dashboard) — pure-logic unit tests.
 * Live-data parity with Ledger Leo and Checkout Charlie was verified
 * separately against the real database on 2026-11-11 (see SESSION_HANDOFF).
 */

jest.mock('../modules/accounting/config/database', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));
jest.mock('../config/database', () => ({ supabase: {} }));

const db = require('../modules/accounting/config/database');
const { buildOverview, _internal } = require('../modules/insights/services/overviewService');
const sales = require('../modules/pos/services/salesAnalyticsService');

const { isValidDate, comparisonPeriod, priorYearPeriod, trendStart, pctChange, minusMonths, runLimited } = _internal;

describe('date helpers', () => {
  test('isValidDate accepts real dates only', () => {
    expect(isValidDate('2026-11-11')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-01')).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
    expect(isValidDate("2026-01-01' OR 1=1")).toBe(false);
  });

  test('minusMonths clamps to the end of shorter months', () => {
    expect(minusMonths('2026-03-31', 1)).toBe('2026-02-28');
    expect(minusMonths('2024-03-31', 1)).toBe('2024-02-29');
    expect(minusMonths('2026-01-15', 1)).toBe('2025-12-15');
  });

  test('month-to-date compares with the same days last month', () => {
    expect(comparisonPeriod('2026-11-01', '2026-11-11'))
      .toEqual({ from: '2026-10-01', to: '2026-10-11', label: 'vs previous month' });
  });

  test('a full month compares with the full previous month', () => {
    expect(comparisonPeriod('2026-03-01', '2026-03-31'))
      .toEqual({ from: '2026-02-01', to: '2026-02-28', label: 'vs previous month' });
  });

  test('three full months compare with the three before', () => {
    expect(comparisonPeriod('2026-08-01', '2026-10-31'))
      .toEqual({ from: '2026-05-01', to: '2026-07-31', label: 'vs previous 3 months' });
  });

  test('year-to-date compares with the same dates last year', () => {
    expect(comparisonPeriod('2026-01-01', '2026-11-11'))
      .toEqual({ from: '2025-01-01', to: '2025-11-11', label: 'vs same period last year' });
  });

  test('January alone is still "previous month"', () => {
    expect(comparisonPeriod('2026-01-01', '2026-01-31').label).toBe('vs previous month');
  });

  test('an arbitrary range compares with the same number of days before it', () => {
    expect(comparisonPeriod('2026-11-05', '2026-11-11'))
      .toEqual({ from: '2026-10-29', to: '2026-11-04', label: 'vs previous 7 days' });
  });

  test('prior-year period and 12-month trend start', () => {
    expect(priorYearPeriod('2026-11-01', '2026-11-11')).toEqual({ from: '2025-11-01', to: '2025-11-11' });
    expect(trendStart('2026-11-11')).toBe('2025-12-01');
  });
});

describe('pctChange', () => {
  test('returns null when there is nothing to compare with', () => {
    expect(pctChange(100, 0)).toBeNull();
  });
  test('rounds to one decimal and handles a negative base', () => {
    expect(pctChange(112.5, 100)).toBe(12.5);
    expect(pctChange(-50, -100)).toBe(50);
    expect(pctChange(0, 100)).toBe(-100);
  });
});

describe('runLimited', () => {
  test('never runs more than the limit at once and keeps result order', async () => {
    let inFlight = 0, peak = 0;
    const task = (v, ms) => async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, ms));
      inFlight--;
      return v;
    };
    const out = await runLimited([task('a', 20), task('b', 5), task('c', 10), task('d', 1), task('e', 3)], 2);
    expect(out).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(2);
  });
});

describe('sales SQL filters', () => {
  const { filteredSalesCte, filteredItemsCte } = sales._internal;

  test('always scoped to one company, completed sales, end of day', () => {
    const { sql, params } = filteredSalesCte(51, '2026-11-01', '2026-11-11');
    expect(params).toEqual([51, '2026-11-01', '2026-11-11T23:59:59.999']);
    expect(sql).toMatch(/s\.company_id = \$1/);
    expect(sql).toMatch(/s\.status = 'completed'/);
  });

  test('slicer values are bound as parameters, never inlined', () => {
    const evil = "x' OR '1'='1";
    const { sql, params } = filteredSalesCte(51, '2026-11-01', '2026-11-11', { store: evil, paymentMethod: 'card' });
    expect(sql).not.toContain(evil);
    expect(params).toEqual([51, '2026-11-01', '2026-11-11T23:59:59.999', evil, 'CARD']);
    const itemSql = filteredItemsCte(params, { category: evil });
    expect(itemSql).not.toContain(evil);
    expect(params[params.length - 1]).toBe(evil);
  });
});

describe('buildOverview access', () => {
  beforeEach(() => db.query.mockReset());

  test('a cashier gets no sections and no data is queried', async () => {
    const out = await buildOverview({ companyId: 51, user: { role: 'cashier' }, from: '2026-11-01', to: '2026-11-11' });
    expect(out.finance).toEqual({ available: false, reason: 'no_permission' });
    expect(out.sales).toEqual({ available: false, reason: 'no_permission' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('store_manager stays out of margin-tier data (Ruan, 2026-07-31)', async () => {
    const out = await buildOverview({ companyId: 51, user: { role: 'store_manager' }, from: '2026-11-01', to: '2026-11-11' });
    expect(out.sales.reason).toBe('no_permission');
    expect(out.finance.reason).toBe('no_permission');
  });

  test('a super admin with an empty company gets "no_data", not an error', async () => {
    db.query.mockResolvedValue({ rows: [{ has: false }] });
    const out = await buildOverview({ companyId: 51, user: { role: 'accountant', isSuperAdmin: true }, from: '2026-11-01', to: '2026-11-11' });
    expect(out.finance).toEqual({ available: false, reason: 'no_data' });
    expect(out.sales).toEqual({ available: false, reason: 'no_data' });
  });
});
