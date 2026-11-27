'use strict';

/**
 * Audit R1 (2026-11-27): where a reversal lands, and that every GL sum counts a
 * reversed original together with its reversal. Fictional data only.
 *
 *   - original's month + VAT period still open → reversal takes the ORIGINAL's
 *     date and VAT period (an undo inside the same month / VAT return)
 *   - VAT period LOCKED, VAT return filed, year-end closed, or VAT lines without
 *     a VAT period → reversal goes to today (current open period)
 */

const fs = require('fs');
const path = require('path');

const mockQuery = jest.fn();
jest.mock('../modules/accounting/config/database', () => ({
  query: (...a) => mockQuery(...a),
  getClient: async () => { throw new Error('not used in these tests'); },
}));
jest.mock('../config/database', () => ({ supabase: {} }));

const JournalService = require('../modules/accounting/services/journalService');

const today = new Date().toISOString().split('T')[0];
const vatLines = [
  { account_id: 1, debit: 115, credit: 0, accounts: { code: '7000', reporting_group: 'expense' } },
  { account_id: 2, debit: 15, credit: 0, accounts: { code: '1400', reporting_group: 'vat_asset' } },
  { account_id: 3, debit: 0, credit: 130, accounts: { code: '1000', reporting_group: 'bank' } },
];
const plainLines = [
  { account_id: 1, debit: 100, credit: 0, accounts: { code: '7000', reporting_group: 'expense' } },
  { account_id: 3, debit: 0, credit: 100, accounts: { code: '1000', reporting_group: 'bank' } },
];

// mockQuery answers in call order: [yearEndRows, vatPeriodRows?]
function answers(yearEnd, vatPeriod) {
  mockQuery.mockReset();
  mockQuery.mockResolvedValueOnce({ rows: yearEnd ? [{ '?column?': 1 }] : [] });
  if (vatPeriod !== undefined) mockQuery.mockResolvedValueOnce({ rows: vatPeriod ? [vatPeriod] : [] });
}

describe('JournalService._chooseReversalPlacement', () => {
  const orig = (over = {}) => ({ id: 10, date: '2026-10-15', vat_period_id: 5, ...over });

  test('open VAT period, not filed → original date (undo in same period)', async () => {
    answers(false, { status: 'open', filed: false });
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p).toEqual({ date: '2026-10-15', mode: 'original', reason: 'periods_open' });
  });

  test('DRAFT status counts as open', async () => {
    answers(false, { status: 'DRAFT', filed: false });
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p.mode).toBe('original');
  });

  test('VAT period LOCKED → today', async () => {
    answers(false, { status: 'LOCKED', filed: false });
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p).toEqual({ date: today, mode: 'today', reason: 'vat_period_locked' });
  });

  test('VAT return filed (period not locked) → today', async () => {
    answers(false, { status: 'open', filed: true });
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p.reason).toBe('vat_return_filed');
    expect(p.date).toBe(today);
  });

  test('year-end closed over the date → today, VAT period not even read', async () => {
    answers(true);
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p.reason).toBe('year_end_closed');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('VAT period row missing → today (fail closed)', async () => {
    answers(false, null);
    const p = await JournalService._chooseReversalPlacement(9, orig(), vatLines);
    expect(p.reason).toBe('vat_period_missing');
  });

  test('VAT lines but no vat_period_id → today', async () => {
    answers(false);
    const p = await JournalService._chooseReversalPlacement(9, orig({ vat_period_id: null }), vatLines);
    expect(p.reason).toBe('vat_lines_without_vat_period');
  });

  test('no VAT lines and no VAT period → original date', async () => {
    answers(false);
    const p = await JournalService._chooseReversalPlacement(9, orig({ vat_period_id: null }), plainLines);
    expect(p).toEqual({ date: '2026-10-15', mode: 'original', reason: 'periods_open' });
  });

  test('original dated today → original date, no queries', async () => {
    mockQuery.mockReset();
    const p = await JournalService._chooseReversalPlacement(9, orig({ date: today }), vatLines);
    expect(p.mode).toBe('original');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a DB error throws instead of guessing', async () => {
    mockQuery.mockReset().mockRejectedValueOnce(new Error('connection lost'));
    await expect(JournalService._chooseReversalPlacement(9, orig(), vatLines)).rejects.toThrow('connection lost');
  });

  test('the year-end and VAT queries are scoped to the company', async () => {
    answers(false, { status: 'open', filed: false });
    await JournalService._chooseReversalPlacement(42, orig(), vatLines);
    expect(mockQuery.mock.calls[0][1][0]).toBe(42);
    expect(mockQuery.mock.calls[1][1]).toEqual([5, 42]);
  });
});

describe('GL sums count reversed originals together with their reversals', () => {
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test.each([
    'modules/accounting/services/vatReportService.js',
    'modules/accounting/services/vatDetailReportService.js',
    'modules/accounting/services/vatReturnsService.js',
    'modules/accounting/services/vatCategoryReportService.js',
    'modules/accounting/services/vatReconciliationService.js',
    'modules/accounting/routes/yearEnd.js',
  ])('%s has no posted-only journal filter', rel => {
    const src = read(rel);
    expect(src).not.toMatch(/j\.status\s*=\s*'posted'/);
    expect(src).not.toMatch(/\.eq\('status',\s*'posted'\)/);
  });

  test('year-end reads balances in one SQL aggregate (no 1000-row Supabase cap)', () => {
    const src = read('modules/accounting/routes/yearEnd.js');
    expect(src).toMatch(/j\.status IN \('posted', 'reversed'\)/);
    expect(src).not.toMatch(/from\('journal_lines'\)/);
  });
});
