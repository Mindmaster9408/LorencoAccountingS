'use strict';

/**
 * Tests — Ledger Leo: recognise payroll payments on the bank (Paytime spec 10 VU-04 part 2)
 *   exact amount + date window; net per employee / per run → Salaries Payable;
 *   EMP201 → 2400 + 2410 split; missing accounts reported; used matches ranked last.
 */

const PBM = require('../modules/accounting/services/payrollBankMatching');

const ACCOUNTS = [
  { id: 4, code: '2400', name: 'PAYE / UIF Payable', type: 'liability' },
  { id: 5, code: '2410', name: 'SDL Payable', type: 'liability' },
  { id: 7, code: '2430', name: 'Salaries Payable', type: 'liability' }
];
const snap = (emp, o, run = 'r10', p = '2026-10') => ({ employee_id: emp, payroll_run_id: run, period_key: p, calculation_output: o });
const SNAPS = [
  snap(1, { net: 17183.88, paye: 1739, uif: 177.12, uif_employer: 177.12, sdl: 200 }),
  snap(2, { net: 9900, paye: 0, uif: 100, uif_employer: 100, sdl: 100 })
];
const EMPS = [{ id: 1, first_name: 'Anna', last_name: 'Botha' }, { id: 2, first_name: 'Ben', last_name: 'Cele' }];
const cands = PBM.buildCandidates(SNAPS, EMPS);
const tx = (id, date, amount, status = 'unmatched') => ({ id, date, amount, status });

test('one employee net pay → Salaries Payable, named', () => {
  const r = PBM.matchTransactions([tx(1, '2026-10-25', -9900)], cands, ACCOUNTS, []);
  expect(r[1]).toHaveLength(1);
  expect(r[1][0]).toMatchObject({ kind: 'emp', employee_id: 2, already_matched: false });
  expect(r[1][0].label).toMatch(/Ben Cele, 2026-10/);
  expect(r[1][0].lines).toEqual([{ accountId: 7, accountCode: '2430', accountName: 'Salaries Payable', amount: 9900 }]);
});

test('bulk payment of the whole run net', () => {
  const r = PBM.matchTransactions([tx(2, '2026-10-31', -27083.88)], cands, ACCOUNTS, []);
  expect(r[2][0]).toMatchObject({ kind: 'net', run_id: 'r10', amount: 27083.88 });
});

test('EMP201 → split PAYE/UIF (2400) and SDL (2410)', () => {
  const total = 1739 + 177.12 * 2 + 100 * 2 + 300;   // paye + uif both sides (both employees) + sdl
  const r = PBM.matchTransactions([tx(3, '2026-11-07', -total)], cands, ACCOUNTS, []);
  const m = r[3][0];
  expect(m.kind).toBe('emp201');
  expect(m.lines).toEqual([
    { accountId: 4, accountCode: '2400', accountName: 'PAYE / UIF Payable', amount: 2293.24 },
    { accountId: 5, accountCode: '2410', accountName: 'SDL Payable', amount: 300 }
  ]);
});

test('no match: different cents, money in, outside the window, already allocated', () => {
  const r = PBM.matchTransactions([
    tx(4, '2026-10-25', -9900.01),
    tx(5, '2026-10-25', 9900),
    tx(6, '2026-12-15', -9900),
    tx(7, '2026-10-25', -9900, 'matched')
  ], cands, ACCOUNTS, []);
  expect(r).toEqual({});
});

test('missing Salaries Payable → suggestion says which account to add, no lines', () => {
  const r = PBM.matchTransactions([tx(8, '2026-10-25', -9900)], cands, ACCOUNTS.filter(a => a.code !== '2430'), []);
  expect(r[8][0].lines).toEqual([]);
  expect(r[8][0].missing_accounts[0]).toMatch(/Salaries Payable/);
});

test('same net two months running: nearest period first; an already used match ranks last', () => {
  const c = PBM.buildCandidates([snap(2, { net: 9900 }, 'r09', '2026-09'), snap(2, { net: 9900 }, 'r10', '2026-10')], EMPS);
  const r = PBM.matchTransactions([tx(9, '2026-10-05', -9900)], c, ACCOUNTS, []);
  expect(r[9].map(m => m.period_key)).toEqual(['2026-09', '2026-10']);
  const used = PBM.matchTransactions([tx(9, '2026-10-05', -9900)], c, ACCOUNTS, ['payroll:emp:r09:2']);
  expect(used[9].map(m => [m.period_key, m.already_matched])).toEqual([['2026-10', false], ['2026-09', true]]);
});

test('a one-person run gives only the employee match (no duplicate run match)', () => {
  const c = PBM.buildCandidates([snap(2, { net: 9900 }, 'r11', '2026-10')], EMPS);
  expect(c.filter(x => x.kind === 'net')).toEqual([]);
});

test('match keys are validated before going into journal metadata', () => {
  expect(PBM.cleanMatchKey('payroll:emp:3f2a-uuid:12')).toBe('payroll:emp:3f2a-uuid:12');
  expect(PBM.cleanMatchKey('payroll:emp201:2026-10')).toBe('payroll:emp201:2026-10');
  expect(PBM.cleanMatchKey('anything else')).toBeNull();
  expect(PBM.cleanMatchKey({ a: 1 })).toBeNull();
});

test('periodsFor covers the windows of the given dates', () => {
  expect(PBM.periodsFor(['2026-11-07'])).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
});
