'use strict';

/** Tests — spec 07 UF-03: review before finalizing (shows only, never blocks). */

const R = require('../modules/payroll/services/runReview');

const snap = (id, net, extra) => ({ employee_id: id, calculation_output: Object.assign({ net, gross: net * 1.2, paye: net * 0.1 }, extra || {}), calculation_input: {} });
const EMPS = [1, 2, 3, 4, 5, 6].map(id => ({ id, first_name: 'Emp', last_name: String(id) }));
const build = (current, previous, o) => R.buildReview(Object.assign({
  current, previous, employees: EMPS,
  taxIssues: (e) => (e.id === 4 ? ['Tax number missing'] : []),
  missingCodes: () => []
}, o || {}));

test('previous month across the tax year boundary', () => {
  expect(R.previousMonth('2026-03')).toBe('2026-02');
  expect(R.previousMonth('2027-01')).toBe('2026-12');
});

test('flags: large change, new employee, negative net, tax number, not in run; steady pay is clean', () => {
  const r = build(
    [snap(1, 10000), snap(2, 12000), snap(3, 5000), snap(4, 8000), snap(5, -50, { negativeNetPay: true })],
    [snap(1, 10050), snap(2, 10000), snap(4, 8000), snap(5, 100), snap(6, 7000)]
  );
  const by = Object.fromEntries(r.rows.map(x => [x.employee_id, x.flags.map(f => f.code)]));
  expect(by[1]).toEqual([]);                          // R50 change: not large
  expect(by[2]).toEqual(['large_change']);            // +R2 000 (+20%)
  expect(by[3]).toEqual(['new']);
  expect(by[4]).toEqual(['tax_number']);
  expect(by[5]).toEqual(expect.arrayContaining(['large_change', 'negative_net']));
  expect(r.not_in_run.map(x => x.employee_id)).toEqual([6]);
  expect(r.flagged).toBe(5);
  expect(r.rows.find(x => x.employee_id === 2)).toMatchObject({ prev_net: 10000, diff: 2000, diff_pct: 20 });
});

test('small percentage but big rand amount is not flagged; IRP5 code messages pass through', () => {
  const r = build([snap(1, 100000)], [snap(1, 105000)], { missingCodes: () => ['Payroll item "X" has no IRP5 code'] });
  expect(r.rows[0].flags.map(f => f.code)).toEqual(['irp5_code']);   // -4.76%: not large
});
