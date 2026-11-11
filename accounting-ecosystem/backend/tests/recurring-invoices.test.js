'use strict';

/**
 * Ledger Leo — annual / monthly billing plans (migration 178).
 * Pure money/date rules of services/recurringInvoiceService.js.
 *
 *   RI-01  12 instalments add up EXACTLY to the annual line amount (EX VAT)
 *   RI-02  same for INC VAT gross amounts
 *   RI-03  last instalment carries the rounding remainder
 *   RI-04  instalment dates keep the day, clamp to month end, roll the year
 *   RI-05  multi-line invoice — header totals = sum of lines every month
 *   RI-06  quantity > 1 still sums exactly
 *   RI-07  todaySA uses Johannesburg time, not UTC
 */

jest.mock('../config/database', () => ({ supabase: {} }));
jest.mock('../modules/accounting/config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

const {
  splitUnitPrice, buildInstalment, instalmentDate, todaySA, addDays,
} = require('../modules/accounting/services/recurringInvoiceService');

const sum = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;

describe('monthly billing — money', () => {
  test('RI-01 EX VAT: 12 instalments sum to the annual ex-VAT amount', () => {
    const annual = [{ description: 'Bookkeeping', account_id: 1, quantity: 1, unit_price: 10000, vat_rate: 15 }];
    const subs = [];
    for (let n = 1; n <= 12; n++) subs.push(buildInstalment(annual, 12, n, false).totals.subtotalExVat);
    expect(sum(subs)).toBe(10000);
  });

  test('RI-02 INC VAT: 12 instalments sum to the annual gross amount', () => {
    const annual = [{ description: 'Support', account_id: 1, quantity: 1, unit_price: 11500, vat_rate: 15 }];
    const totals = [];
    for (let n = 1; n <= 12; n++) totals.push(buildInstalment(annual, 12, n, true).totals.totalIncVat);
    expect(sum(totals)).toBe(11500);
  });

  test('RI-03 remainder lands on the last instalment', () => {
    expect(splitUnitPrice(1000, 12, 1)).toBe(83.33);
    expect(splitUnitPrice(1000, 12, 11)).toBe(83.33);
    expect(splitUnitPrice(1000, 12, 12)).toBe(83.37);
    expect(Math.round((83.33 * 11 + 83.37) * 100) / 100).toBe(1000);
  });

  test('RI-05 multi-line: header = sum of lines, and each line sums to its annual amount', () => {
    const annual = [
      { description: 'A', account_id: 1, quantity: 1, unit_price: 7777.77, vat_rate: 15 },
      { description: 'B', account_id: 2, quantity: 1, unit_price: 1234.56, vat_rate: 0 },
    ];
    const lineA = []; const lineB = [];
    for (let n = 1; n <= 12; n++) {
      const { lines, totals } = buildInstalment(annual, 12, n, false);
      expect(totals.subtotalExVat).toBe(sum(lines.map((l) => l.subtotalExVat)));
      expect(totals.vatAmount).toBe(sum(lines.map((l) => l.vatAmount)));
      lineA.push(lines[0].subtotalExVat); lineB.push(lines[1].subtotalExVat);
    }
    expect(sum(lineA)).toBe(7777.77);
    expect(sum(lineB)).toBe(1234.56);
  });

  test('RI-06 quantity > 1 still sums exactly', () => {
    const annual = [{ description: 'Licences', account_id: 1, quantity: 3, unit_price: 1000, vat_rate: 15 }];
    const subs = [];
    for (let n = 1; n <= 12; n++) subs.push(buildInstalment(annual, 12, n, false).totals.subtotalExVat);
    expect(sum(subs)).toBe(3000);
  });
});

describe('monthly billing — dates', () => {
  test('RI-04 dates keep day-of-month, clamp to month end, roll the year', () => {
    expect(instalmentDate('2026-11-15', 1)).toBe('2026-11-15');
    expect(instalmentDate('2026-11-15', 2)).toBe('2026-12-15');
    expect(instalmentDate('2026-11-15', 3)).toBe('2027-01-15');
    expect(instalmentDate('2026-11-15', 12)).toBe('2027-10-15');
    expect(instalmentDate('2027-01-31', 2)).toBe('2027-02-28');
    expect(instalmentDate('2027-01-31', 3)).toBe('2027-03-31'); // back to the 31st, no drift
    expect(instalmentDate('2028-01-31', 2)).toBe('2028-02-29'); // leap year
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
  });

  test('RI-07 todaySA is the Johannesburg date', () => {
    // 23:30 UTC on 31 Dec = 01:30 on 1 Jan in SA
    expect(todaySA(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(todaySA(new Date('2026-06-15T10:00:00Z'))).toBe('2026-06-15');
  });
});
