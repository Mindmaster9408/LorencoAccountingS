'use strict';

/**
 * Tests — Sean payroll item meaning (Paytime spec 14 SN-04)
 *   "Comm." = "Commission"; an earning "Savings" ≠ a deduction "Savings".
 */

const M = require('../sean/item-meaning');

test('abbreviations and synonyms share one meaning', () => {
  const same = (a, b) => expect(M.subjectFor(a, 'income')).toBe(M.subjectFor(b, 'earning'));
  same('Comm.', 'Commission');
  same('Monthly Commission', 'Commissions');
  same('Basic', 'Basic Salary');
  same('Basic Pay', 'Salary');
  same('O/T', 'Overtime');
  same('13th Cheque', 'Annual Bonus');
  same('Travel Allow.', 'Travel Allowance');
  same('Cell Phone Allowance', 'Cellphone Allowance');
});

test('different meanings stay different', () => {
  const diff = (a, b) => expect(M.subjectFor(a, 'income')).not.toBe(M.subjectFor(b, 'income'));
  diff('Commission', 'Bonus');
  diff('Travel Allowance', 'Travel Reimbursement');
  diff('Overtime', 'Sunday Pay');
});

test('the side is part of the meaning', () => {
  expect(M.subjectFor('Savings', 'earning')).toBe('savings');
  expect(M.subjectFor('Savings', 'deduction')).toBe('savings [deduction]');
  expect(M.subjectFor('Pension Fund', 'employer_contribution')).toBe('pension fund [employer]');
  expect(M.subjectFor('Pens. Fund', 'company_contribution')).toBe('pension fund [employer]');
  expect(M.subjectFor('Savings', 'deduction')).not.toBe(M.subjectFor('Savings', 'income'));
});

test('canonicalSubject is idempotent and reads old plain names as earnings', () => {
  for (const [n, t] of [['Comm.', 'income'], ['Savings', 'deduction'], ['PF', 'employer_contribution']]) {
    const s = M.subjectFor(n, t);
    expect(M.canonicalSubject(s)).toBe(s);
  }
  expect(M.canonicalSubject('comm')).toBe('commission');
  expect(M.canonicalSubject('')).toBe('');
});
