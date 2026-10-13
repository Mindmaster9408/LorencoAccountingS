'use strict';

/**
 * Tests — spec 06 VPA-05: Target PAYE needs a reason, enforced on the backend.
 * Only new/changed entries are checked (an old entry never blocks the list).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../config/database', () => ({ supabase: {} }));
const { voluntaryTaxProblems } = require('../shared/routes/employees');

const T = (o) => Object.assign({ id: 1, type: 'target_paye', target_paye: 2500, description: 'Employee request' }, o);

test('new Target PAYE without a reason is refused', () => {
  expect(voluntaryTaxProblems([T({ description: '  ' })], [])).toEqual(['A reason is required for a Target PAYE entry']);
});

test('new Target PAYE with a reason and valid amount is fine', () => {
  expect(voluntaryTaxProblems([T()], null)).toEqual([]);
});

test('invalid amount is refused', () => {
  expect(voluntaryTaxProblems([T({ target_paye: 'abc' })], [])).toEqual(['Target PAYE amount must be zero or more']);
  expect(voluntaryTaxProblems([T({ target_paye: -5 })], [])).toEqual(['Target PAYE amount must be zero or more']);
});

test('an unchanged older entry without a reason does not block saving the list', () => {
  const old = T({ description: '' });
  expect(voluntaryTaxProblems([old, { id: 2, type: 'fixed', amount: 100 }], [old])).toEqual([]);
});

test('changing an older entry requires the reason', () => {
  expect(voluntaryTaxProblems([T({ description: '', target_paye: 3000 })], [T({ description: '' })]))
    .toEqual(['A reason is required for a Target PAYE entry']);
});

test('other types and clearing the list are not affected', () => {
  expect(voluntaryTaxProblems([{ id: 3, type: 'fixed', amount: 100 }, { id: 4, type: 'bonus_spread' }], [])).toEqual([]);
  expect(voluntaryTaxProblems(null, [T()])).toEqual([]);
  expect(voluntaryTaxProblems({ a: 1 }, [])).toEqual(['voluntary_tax_config must be a list']);
});
