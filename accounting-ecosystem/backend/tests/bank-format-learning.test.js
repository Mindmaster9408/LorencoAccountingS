'use strict';

/**
 * ============================================================================
 * Ledger Leo — learned bank statement formats (migration 183)
 * ============================================================================
 * All statement text below is FICTIONAL (made-up bank, names, amounts).
 *
 * Invariants:
 *   1. A row is only "verified" when a printed amount equals the change in the
 *      printed balance — the model's recipe is never trusted on its own.
 *   2. Glued columns ("17,659.462,985,566.97CR") and amount+fee are handled.
 *   3. Date lines that move no money are skipped as noise; anything else that
 *      does not verify is returned as unverified (CHECK), never dropped.
 *   4. Small recipe slips (thousands separator, date format) are corrected by
 *      the balance chain (bestVariant).
 *   5. A stored recipe can never carry amounts, numbers or other client data.
 *   6. The company's own learned format wins a tie with a global one.
 * ============================================================================
 */

jest.mock('../config/database', () => ({ supabase: {} }));

const R = require('../sean/bank-format/recipeReader');
const { judge, feedbackFor } = require('../sean/bank-format/bankFormatJob');
const { pickBest } = require('../sean/bank-format/formatStore');

// Fictional "Karoo Mutual" statement: posted + value date glued, columns glued, CR suffix.
const GLUED = [
  'Karoo Mutual Bank', 'Account statement', 'Statement period01 Jan to 31 Jan 2026',
  'Posted', 'date', 'Value', 'date', 'DescriptionDebitCreditBalance',
  '01/01/2026Opening balance12,500.00',
  '05/01/202606/01/2026Deposit received2,000.0014,500.00CR',
  '09/01/202609/01/2026Monthly service fee',
  '(excl. VAT)',
  '120.0014,380.00CR',
  'Fee 18.00 incl. VAT',
  '20/01/202620/01/2026Debit order insurance1,380.0013,000.00CR',
  '31/01/2026Closing balance13,000.00',
].join('\n');

const GLUED_RECIPE = {
  date_format: 'DD/MM/YYYY', thousands_separator: ',', decimal_separator: '.',
  negative_balance_marker: 'DR', opening_balance_label: 'Opening balance', closing_balance_label: 'Closing balance',
};

// Fictional statement with space thousands, 1-digit days, amount + fee columns and a header line with a date.
const SPACED = [
  'Veld Bank', 'Your transactions',
  '1/02/2026Bal Brought Forward10 000.00',
  '1/02/2026Statement printed on 1/02/2026 page 1 of 1 0.00',
  '3/02/2026Card purchase Corner Deli-250.00-5.009 745.00',
  '7/02/2026Salary credit15 000.0024 745.00',
  '9/02/2026Transfer out-4 745.0020 000.00',
].join('\n');
const SPACED_RECIPE = {
  date_format: 'DD/MM/YYYY', thousands_separator: ' ', decimal_separator: '.',
  negative_balance_marker: '-', opening_balance_label: 'Bal Brought Forward', closing_balance_label: '',
};

const today = new Date('2026-11-14T10:00:00Z');

describe('readWithRecipe', () => {
  test('glued columns, glued value date, multi-line description, closing balance', () => {
    const r = R.readWithRecipe(GLUED, GLUED_RECIPE, { today });
    expect(r.rows.map(x => [x.date, x.amount, x.balance, x.verified])).toEqual([
      ['2026-01-05', 2000, 14500, true],
      ['2026-01-09', -120, 14380, true],
      ['2026-01-20', -1380, 13000, true],
    ]);
    expect(r.closingOk).toBe(true);
    expect(R.acceptable(r)).toBe(true);
    expect(r.rows[1].description).toMatch(/Monthly service fee/);
  });

  test('amount + fee: split into two rows (fee separately); a dated header line is skipped as noise', () => {
    const r = R.readWithRecipe(SPACED, SPACED_RECIPE, { today });
    expect(r.rows.map(x => [x.amount, x.balance, x.verified])).toEqual([
      [-250, 9750, true], [-5, 9745, true], [15000, 24745, true], [-4745, 20000, true]]);
    expect(r.rows[1].description).toMatch(/^Fee: /);
    expect(r.skipped).toBe(1);
    expect(r.unverified).toBe(0);
  });

  test('a row whose amount does not match the balance change is returned as unverified, not dropped', () => {
    const broken = SPACED.replace('Salary credit15 000.0024 745.00', 'Salary credit14 000.0024 745.00');
    const r = R.readWithRecipe(broken, SPACED_RECIPE, { today });
    const salary = r.rows.find(x => /Salary/.test(x.description));
    expect(salary.verified).toBe(false);
    expect(r.unverified).toBe(1);
  });

  test('wrong recipe finds nothing usable', () => {
    const r = R.readWithRecipe(GLUED, { ...GLUED_RECIPE, date_format: 'DD MMM YYYY' }, { today });
    expect(R.acceptable(r)).toBe(false);
  });
});

describe('bestVariant / judge — the balance chain corrects small recipe slips', () => {
  test('model said "," but the statement uses space thousands → corrected', () => {
    const j = judge(SPACED, { ...SPACED_RECIPE, thousands_separator: ',' });
    expect(j.ok).toBe(true);
    expect(j.recipe.thousands_separator).toBe(' ');
    expect(j.counts).toMatchObject({ verified: 4, unverified: 0 });
  });

  test('garbage answer → not ok, with feedback for the next try', () => {
    const j = judge(GLUED, { date_format: 'nonsense', opening_balance_label: 'xyz' });
    expect(j.recipe.date_format).toBe('DD/MM/YYYY'); // sanitised + variant found
    const bad = judge('no transactions in here at all', {});
    expect(bad.ok).toBe(false);
    expect(feedbackFor(R.sanitizeRecipe({}), bad.res)).toMatch(/found NO transaction lines/);
  });
});

describe('recipe hygiene — no client data can be stored', () => {
  test('labels keep letters/spaces only; unknown fields are dropped', () => {
    const s = R.sanitizeRecipe({
      date_format: 'DD/MM/YYYY', opening_balance_label: 'Opening balance 12,500.00 acc 4012345678',
      closing_balance_label: 'J. Fictional Closing', account_number: '4012345678', ignore_lines_containing: ['x'],
    });
    expect(s.opening_balance_label).toBe('Opening balance acc');
    expect(Object.keys(s).sort()).toEqual(['closing_balance_label', 'date_format', 'decimal_separator',
      'negative_balance_marker', 'opening_balance_label', 'thousands_separator']);
    expect(JSON.stringify(s)).not.toMatch(/\d/);
    expect(R.sanitizeBankName('Karoo Mutual 4012345678')).toBe('Karoo Mutual');
  });
});

describe('pickBest — which learned format reads a statement', () => {
  test('only acceptable readings count; own company wins a tie with a global format', () => {
    const own = { id: 1, company_id: 51, recipe: GLUED_RECIPE, global_status: 'pending' };
    const glob = { id: 2, company_id: 7, recipe: GLUED_RECIPE, global_status: 'approved' };
    const wrong = { id: 3, company_id: 51, recipe: SPACED_RECIPE, global_status: 'pending' };
    expect(pickBest(GLUED, [glob, wrong, own], 51, { today }).format.id).toBe(1);
    expect(pickBest(GLUED, [wrong], 51, { today })).toBeNull();
  });
});

describe('chainCheck — does a generic parse already reconcile?', () => {
  test('reconciling rows vs broken rows', () => {
    expect(R.chainCheck([{ amount: 0, balance: 100 }, { amount: -20, balance: 80 }, { amount: 5, balance: 85 }]).reconciles).toBe(true);
    expect(R.chainCheck([{ amount: 0, balance: 100 }, { amount: -20, balance: 70 }]).reconciles).toBe(false);
    expect(R.chainCheck([{ amount: 1, balance: null }]).reconciles).toBe(false);
  });
});
