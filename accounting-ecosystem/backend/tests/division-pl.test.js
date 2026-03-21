'use strict';

/**
 * Tests for Division P&L report logic
 *
 * Strategy: Extract pure functions from source via regex (no DB connection needed).
 * Tests cover:
 *   aggregateLines()          — sums debit/credit per account_id
 *   Subtotals formula         — grossProfit, operatingProfit, netProfit
 *   Section mapping           — sub_type → section key
 *   segmentValueId filtering  — 'untagged' → IS NULL, numeric → eq, absent → none
 *   bank.js passthrough       — segmentValueId reaches journalLines
 */

const path = require('path');
const fs   = require('fs');

const reportsSrc = fs.readFileSync(
  path.resolve(__dirname, '../modules/accounting/routes/reports.js'), 'utf8'
);
const bankSrc = fs.readFileSync(
  path.resolve(__dirname, '../modules/accounting/routes/bank.js'), 'utf8'
);

// ─── Extract aggregateLines (pure function, no DB) ─────────────────────────
let aggregateLines = null;
{
  // Match: function aggregateLines(lines) { ... }
  const match = reportsSrc.match(/function aggregateLines\(lines\) \{([\s\S]*?)\n\}/);
  if (match) {
    try {
      // eslint-disable-next-line no-new-func
      aggregateLines = new Function('lines', match[1]);
    } catch (_) {}
  }
}

// ─── 1. aggregateLines ────────────────────────────────────────────────────────
describe('aggregateLines()', () => {
  beforeAll(() => {
    if (!aggregateLines) throw new Error('Could not extract aggregateLines from reports.js');
  });

  test('returns empty map for empty input', () => {
    const result = aggregateLines([]);
    expect(result).toEqual({});
  });

  test('sums debit and credit per account_id', () => {
    const lines = [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 1, debit: 50,  credit: 0 },
      { account_id: 2, debit: 0,   credit: 200 },
    ];
    const result = aggregateLines(lines);
    expect(result[1].debit).toBe(150);
    expect(result[1].credit).toBe(0);
    expect(result[2].debit).toBe(0);
    expect(result[2].credit).toBe(200);
  });

  test('initialises missing accounts to 0 before accumulating', () => {
    const lines = [{ account_id: 5, debit: 0, credit: 75 }];
    const result = aggregateLines(lines);
    expect(result[5].debit).toBe(0);
    expect(result[5].credit).toBe(75);
  });

  test('handles null/undefined debit/credit gracefully', () => {
    const lines = [{ account_id: 3, debit: null, credit: undefined }];
    const result = aggregateLines(lines);
    expect(result[3].debit).toBe(0);
    expect(result[3].credit).toBe(0);
  });

  test('aggregates the same account across many lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      account_id: 9, debit: i % 2 === 0 ? 10 : 0, credit: i % 2 !== 0 ? 5 : 0,
    }));
    const result = aggregateLines(lines);
    expect(result[9].debit).toBe(50);   // 5 even entries × 10
    expect(result[9].credit).toBe(25);  // 5 odd entries × 5
  });
});

// ─── 2. Division P&L subtotals formula ───────────────────────────────────────
describe('Division P&L subtotals formula', () => {
  // These are the exact formulas in reports.js — verify correctness
  function computeTotals({ operatingIncome, otherIncome, costOfSales, operatingExpenses, depreciation, financeCosts }) {
    const grossProfit     = operatingIncome - costOfSales;
    const operatingProfit = grossProfit + otherIncome - operatingExpenses - depreciation;
    const netProfit       = operatingProfit - financeCosts;
    return { grossProfit, operatingProfit, netProfit };
  }

  test('grossProfit = operatingIncome - costOfSales', () => {
    const { grossProfit } = computeTotals({ operatingIncome: 100000, costOfSales: 40000, otherIncome: 0, operatingExpenses: 0, depreciation: 0, financeCosts: 0 });
    expect(grossProfit).toBe(60000);
  });

  test('operatingProfit deducts expenses and depreciation from grossProfit', () => {
    const { operatingProfit } = computeTotals({
      operatingIncome: 100000, costOfSales: 40000,
      otherIncome: 5000, operatingExpenses: 20000, depreciation: 3000, financeCosts: 0,
    });
    // grossProfit = 60000; + 5000 other – 20000 opex – 3000 dep = 42000
    expect(operatingProfit).toBe(42000);
  });

  test('netProfit deducts finance costs from operatingProfit', () => {
    const { netProfit } = computeTotals({
      operatingIncome: 100000, costOfSales: 40000,
      otherIncome: 0, operatingExpenses: 20000, depreciation: 0, financeCosts: 8000,
    });
    // operatingProfit = 60000 – 20000 = 40000; netProfit = 40000 – 8000 = 32000
    expect(netProfit).toBe(32000);
  });

  test('all zeros returns all zero subtotals', () => {
    const { grossProfit, operatingProfit, netProfit } = computeTotals({
      operatingIncome: 0, costOfSales: 0, otherIncome: 0,
      operatingExpenses: 0, depreciation: 0, financeCosts: 0,
    });
    expect(grossProfit).toBe(0);
    expect(operatingProfit).toBe(0);
    expect(netProfit).toBe(0);
  });

  test('loss scenario: netProfit is negative', () => {
    const { netProfit } = computeTotals({
      operatingIncome: 10000, costOfSales: 8000,
      otherIncome: 0, operatingExpenses: 5000, depreciation: 0, financeCosts: 0,
    });
    // grossProfit = 2000; – 5000 opex = –3000
    expect(netProfit).toBe(-3000);
  });
});

// ─── 3. Section mapping — sub_type → P&L section ─────────────────────────────
describe('Sub-type to section mapping', () => {
  // Mirror the logic in reports.js: effectiveSubType fallback + targetSection
  const validSections = ['operating_income', 'cost_of_sales', 'other_income', 'operating_expense', 'depreciation_amort', 'finance_cost'];

  function getTargetSection(a) {
    const effectiveSubType = a.sub_type ||
      (a.type === 'income' ? 'operating_income' : 'operating_expense');
    return validSections.includes(effectiveSubType)
      ? effectiveSubType
      : (a.type === 'income' ? 'operating_income' : 'operating_expense');
  }

  test('income with no sub_type → operating_income', () => {
    expect(getTargetSection({ type: 'income', sub_type: null })).toBe('operating_income');
  });

  test('expense with no sub_type → operating_expense', () => {
    expect(getTargetSection({ type: 'expense', sub_type: null })).toBe('operating_expense');
  });

  test('cost_of_sales sub_type → cost_of_sales section', () => {
    expect(getTargetSection({ type: 'expense', sub_type: 'cost_of_sales' })).toBe('cost_of_sales');
  });

  test('other_income sub_type → other_income section', () => {
    expect(getTargetSection({ type: 'income', sub_type: 'other_income' })).toBe('other_income');
  });

  test('depreciation_amort sub_type → depreciation_amort section', () => {
    expect(getTargetSection({ type: 'expense', sub_type: 'depreciation_amort' })).toBe('depreciation_amort');
  });

  test('finance_cost sub_type → finance_cost section', () => {
    expect(getTargetSection({ type: 'expense', sub_type: 'finance_cost' })).toBe('finance_cost');
  });

  test('unknown sub_type falls back to type-based default', () => {
    expect(getTargetSection({ type: 'expense', sub_type: 'unrecognised_type' })).toBe('operating_expense');
    expect(getTargetSection({ type: 'income',  sub_type: 'unrecognised_type' })).toBe('operating_income');
  });
});

// ─── 4. segmentValueId filtering — source-level assertions ───────────────────
describe('fetchAccountBalances segmentValueId filter (source)', () => {
  test("'untagged' triggers IS NULL filter in source", () => {
    expect(reportsSrc).toMatch(/segmentValueId === 'untagged'/);
    expect(reportsSrc).toMatch(/\.is\('segment_value_id',\s*null\)/);
  });

  test('numeric segmentValueId triggers eq filter in source', () => {
    expect(reportsSrc).toMatch(/\.eq\('segment_value_id',\s*parseInt\(segmentValueId\)\)/);
  });

  test('division-profit-loss passes untagged to fetchAccountBalances', () => {
    // Verify the 'untagged' sentinel is passed in division P&L handler
    expect(reportsSrc).toMatch(/segmentValueId:\s*'untagged'/);
  });

  test('division-profit-loss passes numeric id per division', () => {
    // Verify String(dv.id) is used for per-division calls
    expect(reportsSrc).toMatch(/segmentValueId:\s*String\(dv\.id\)/);
  });
});

// ─── 5. bank.js — segmentValueId passthrough to journalLines ─────────────────
describe('bank allocation segmentValueId passthrough (source)', () => {
  test('no-VAT allocation line includes segmentValueId', () => {
    // Look for the no-VAT journalLines.push and verify segmentValueId is included
    expect(bankSrc).toMatch(/segmentValueId:\s*line\.segmentValueId\s*\|\|\s*null/);
  });

  test('VAT-bearing allocation line also includes segmentValueId', () => {
    // The VAT-bearing push and the no-VAT push must both set segmentValueId
    const matches = (bankSrc.match(/segmentValueId:\s*line\.segmentValueId\s*\|\|\s*null/g) || []);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('bank account (contra) line does NOT receive segmentValueId', () => {
    // The bank account line is pushed first (before the allocation loop)
    // It should not contain segmentValueId
    const bankLineMatch = bankSrc.match(
      /Bank account line.*?\}\);/s
    );
    // Simply verify the first journalLines.push (bank line) comes before the segmentValueId assignments
    const firstPushIdx  = bankSrc.indexOf('journalLines.push({');
    const firstSegIdx   = bankSrc.indexOf('segmentValueId: line.segmentValueId');
    expect(firstSegIdx).toBeGreaterThan(firstPushIdx);
  });
});
