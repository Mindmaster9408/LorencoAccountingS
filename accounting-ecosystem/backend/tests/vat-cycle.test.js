'use strict';

/**
 * VAT cycles (SARS categories) → period list + dates for the VAT page.
 * vatPeriodUtils (4- and 6-monthly added) and vatCycleService.mergePeriodOptions.
 */

jest.mock('../config/database', () => ({ supabase: {} }));

const { derivePeriodForDate, generatePeriods } = require('../modules/accounting/services/vatPeriodUtils');
const { mergePeriodOptions, canonicalKey, saDate, monthsBack } = require('../modules/accounting/services/vatCycleService');
const { blockReason } = require('../modules/mcp/lorencoApi');

describe('four-monthly (Category F: ends Feb, Jun, Oct)', () => {
  test.each([
    ['2025-11-15', '2026-02', '2025-11-01', '2026-02-28'],
    ['2026-01-10', '2026-02', '2025-11-01', '2026-02-28'],
    ['2026-03-01', '2026-06', '2026-03-01', '2026-06-30'],
    ['2026-10-31', '2026-10', '2026-07-01', '2026-10-31'],
    ['2027-12-01', '2028-02', '2027-11-01', '2028-02-29'],
  ])('%s → %s', (date, key, from, to) => {
    expect(derivePeriodForDate(date, 'four-monthly')).toEqual({ periodKey: key, fromDate: from, toDate: to });
  });
});

describe('six-monthly (Category D: ends Feb, Aug)', () => {
  test.each([
    ['2025-09-01', '2026-02', '2025-09-01', '2026-02-28'],
    ['2026-02-28', '2026-02', '2025-09-01', '2026-02-28'],
    ['2026-03-01', '2026-08', '2026-03-01', '2026-08-31'],
  ])('%s → %s', (date, key, from, to) => {
    expect(derivePeriodForDate(date, 'six-monthly')).toEqual({ periodKey: key, fromDate: from, toDate: to });
  });
});

describe('bi-monthly is unchanged', () => {
  test('even: Sep–Oct 2025 = 2025-10 (the period Walkerpark still has to file)', () => {
    expect(derivePeriodForDate('2025-09-05', 'bi-monthly', 'even')).toEqual({ periodKey: '2025-10', fromDate: '2025-09-01', toDate: '2025-10-31' });
  });
  test('odd: Dec–Jan spans the year', () => {
    expect(derivePeriodForDate('2025-12-05', 'bi-monthly', 'odd')).toEqual({ periodKey: '2026-01', fromDate: '2025-12-01', toDate: '2026-01-31' });
  });
  test('36 months of even periods = 18 or 19 periods, no gaps', () => {
    const ps = generatePeriods('2023-11-01', '2026-11-26', 'bi-monthly', 'even');
    for (let i = 1; i < ps.length; i++) {
      const prevEnd = new Date(ps[i - 1].toDate + 'T00:00:00Z');
      expect(new Date(ps[i].fromDate + 'T00:00:00Z') - prevEnd).toBe(86400000);
    }
    expect(ps[ps.length - 1].periodKey).toBe('2026-12');
  });
});

describe('period list for the page', () => {
  const generated = [
    { periodKey: '2025-10', fromDate: '2025-09-01', toDate: '2025-10-31' },
    { periodKey: '2025-12', fromDate: '2025-11-01', toDate: '2025-12-31' },
  ];

  test('newest first; an old monthly DRAFT row is realigned to the cycle, strays hidden', () => {
    const stored = [
      { id: 61, period_key: '2025-12', from_date: '2025-12-01', to_date: '2025-12-31', status: 'DRAFT' },
      { id: 60, period_key: '2026-11', from_date: '2026-11-01', to_date: '2026-11-30', status: 'DRAFT' },
    ];
    const out = mergePeriodOptions(generated, stored, new Set());
    expect(out.map(p => p.periodKey)).toEqual(['2025-12', '2025-10']);
    expect(out[0]).toEqual(expect.objectContaining({ periodId: 61, fromDate: '2025-11-01', otherCycle: false }));
  });

  test('a filed / locked period keeps the dates it was filed with', () => {
    const stored = [
      { id: 61, period_key: '2025-12', from_date: '2025-12-01', to_date: '2025-12-31', status: 'LOCKED' },
      { id: 59, period_key: '2025.07', from_date: '2025-07-01', to_date: '2025-07-31', status: 'DRAFT' },
    ];
    const out = mergePeriodOptions(generated, stored, new Set([59]));
    expect(out.find(p => p.periodKey === '2025-12')).toEqual(expect.objectContaining({ fromDate: '2025-12-01', locked: true, otherCycle: true }));
    expect(out.find(p => p.periodKey === '2025-07')).toEqual(expect.objectContaining({ filed: true, otherCycle: true }));
  });

  test('helpers', () => {
    expect(canonicalKey('2025.10')).toBe('2025-10');
    expect(canonicalKey('oops')).toBeNull();
    expect(saDate('1999-12-31T22:00:00.000Z')).toBe('2000-01-01');
    expect(monthsBack('2026-11-26', 36)).toBe('2023-11-01');
  });
});

test('the bot cannot change the VAT cycle', () => {
  expect(blockReason('PUT', '/api/accounting/vat-recon/cycle')).toMatch(/done by a person/);
  expect(blockReason('GET', '/api/accounting/vat-recon/cycle/period-options')).toBeNull();
});
