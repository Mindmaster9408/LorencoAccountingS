'use strict';

/**
 * Tests — spec 04 IT-05 (Ruan 2026-10-14, option a): items without an IRP5 code are a
 * warning on the run and block the IRP5 at EMP501. Net-only deductions need no code.
 */

const C = require('../modules/payroll/services/irp5ItemCheck');

const MASTERS = [
  { id: 1, item_name: 'Commission', item_type: 'income', irp5_code: '3606' },
  { id: 2, item_name: 'Travel Allowance', item_type: 'allowance', irp5_code: null },
  { id: 3, item_name: 'Provident Fund', item_type: 'deduction', irp5_code: '' },
  { id: 4, item_name: 'Savings', item_type: 'deduction', irp5_code: null }
];
const input = (regular, current) => ({ regular_inputs: regular, currentInputs: current || [] });

test('earning without a code is reported; with a code it is not', () => {
  const r = C.itemsMissingCode(input([
    { description: 'Commission', type: 'earning', amount: 1000 },
    { description: 'Travel Allowance', type: 'earning', amount: 2000 }
  ]), MASTERS);
  expect(r).toEqual([{ description: 'Travel Allowance', type: 'earning' }]);
});

test('pre-tax deduction needs a code; net-only deduction (loan, savings) does not', () => {
  const r = C.itemsMissingCode(input([
    { description: 'Provident Fund', type: 'deduction', tax_treatment: 'pre_tax', amount: 500 },
    { description: 'Savings', type: 'deduction', tax_treatment: 'net_only', amount: 450 },
    { description: 'Staff Loan', type: 'deduction', amount: 300 }
  ]), MASTERS);
  expect(r.map(x => x.description)).toEqual(['Provident Fund']);
});

test('item not on the Payroll Items screen at all, current inputs, zero amounts', () => {
  const r = C.itemsMissingCode(input(
    [{ description: 'Variable thing', type: 'earning', amount: 0 }],
    [{ description: 'Once-off bonus', type: 'input', amount: 5000 }]
  ), MASTERS);
  expect(r).toEqual([{ description: 'Once-off bonus', type: 'input' }]);
});

test('employer contribution needs a code', () => {
  expect(C.itemsMissingCode(input([{ description: 'Employer pension', type: 'company_contribution', amount: 900 }]), MASTERS))
    .toHaveLength(1);
});

test('messages: one per item name', () => {
  expect(C.issueText([{ description: 'A' }, { description: 'A' }, { description: 'B' }]))
    .toEqual(['Payroll item "A" has no IRP5 code', 'Payroll item "B" has no IRP5 code']);
});

test('code source: screen rows, else the old KV list', async () => {
  const mk = (tables) => ({ from: (t) => { const res = tables[t] || { data: [], error: null };
    const b = { select: () => b, eq: () => b, maybeSingle: async () => res, then: (ok) => Promise.resolve(res).then(ok) }; return b; } });
  expect(await C.loadCodeSource(mk({ payroll_items_master: { data: MASTERS, error: null } }), 7)).toBe(MASTERS);
  const kv = await C.loadCodeSource(mk({ payroll_kv_store_eco: { data: { value: JSON.stringify([{ item_name: 'Bonus', irp5_code: '3605' }]) }, error: null } }), 15);
  expect(kv[0]).toMatchObject({ item_name: 'Bonus', irp5_code: '3605' });
});
