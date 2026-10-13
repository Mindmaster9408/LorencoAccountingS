'use strict';

/**
 * Tests — spec 05 PI-07 (finding B4): an input that cannot be LOADED stops the calculation
 * with a clear INPUTS_UNAVAILABLE error instead of silently calculating without it.
 */

const DS = require('../modules/payroll/services/PayrollDataService');

// Minimal query stub: every query on `failTable` resolves with an error, others with `rows`.
function stub(failTable, rows) {
  return {
    from(table) {
      const res = table === failTable ? { data: null, error: { message: 'connection reset', code: 'XX000' } }
                                      : { data: rows[table] !== undefined ? rows[table] : [], error: null };
      const b = {
        select: () => b, eq: () => b, in: () => b, order: () => b, neq: () => b, is: () => b, limit: () => b,
        single: async () => res, maybeSingle: async () => res,
        then: (ok, bad) => Promise.resolve(res).then(ok, bad)
      };
      return b;
    }
  };
}

const expectUnavailable = async (p, what) => {
  const err = await p.then(() => null, e => e);
  expect(err).not.toBeNull();
  expect(err.code).toBe('INPUTS_UNAVAILABLE');
  expect(err.message).toMatch(what);
};

test.each([
  ['payroll_period_inputs', /once-off inputs/],
  ['payroll_overtime', /overtime/],
  ['payroll_short_time', /short time/],
  ['payroll_multi_rate', /multi-rate/]
])('period inputs: %s fails → error, not an empty list', async (table, what) => {
  await expectUnavailable(DS.fetchPeriodInputs(51, 7, 3, stub(table, {})), what);
});

test('regular items: load failure → error', async () => {
  await expectUnavailable(DS.fetchRecurringPayrollItems(51, 7, stub('employee_payroll_items', {})), /regular payroll items/);
});

test('item settings: failure → error (no silent fallback to old KV settings)', async () => {
  const s = stub('payroll_items_master', { employee_payroll_items: [{ id: 1, item_type: 'earning', payroll_items: { name: 'Comm' } }] });
  await expectUnavailable(DS.fetchRecurringPayrollItems(51, 7, s), /payroll item settings/);
});

test('YTD: failure → error (no silent switch to the monthly method)', async () => {
  await expectUnavailable(DS.fetchYtdData(51, 7, '2026-10', stub('payroll_snapshots', {})), /year-to-date/);
});

test('work schedule: failure → error; no schedule saved → standard week', async () => {
  await expectUnavailable(DS.fetchWorkSchedule(51, 7, stub('employee_work_schedule', {})), /work schedule/);
  const none = { from: () => { const r = { data: null, error: { code: 'PGRST116', message: 'no rows' } }; const b = { select: () => b, eq: () => b, single: async () => r }; return b; } };
  expect(Array.isArray(await DS.fetchWorkSchedule(51, 7, none))).toBe(true);
});

test('SDL/UIF registration: failure → error (not "registered" by default)', async () => {
  await expectUnavailable(DS.fetchCompanyRegistrationFlags(51, stub('companies', {})), /SDL\/UIF registration/);
});

test('all loaded fine → lists returned as before', async () => {
  const r = await DS.fetchPeriodInputs(51, 7, 3, stub('none', { payroll_overtime: [{ id: 1, hours: 2, rate_multiplier: 1.5 }] }));
  expect(r.overtime).toHaveLength(1);
  expect(r.currentInputs).toEqual([]);
});
