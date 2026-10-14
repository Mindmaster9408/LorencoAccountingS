'use strict';

/**
 * Tests — spec 03 WN-11 (Ruan 2026-10-14): salary history with an effective month,
 * back pay for finalized months, scheduled increases.
 */

const express = require('express');
const SH = require('../modules/payroll/services/salaryHistory');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 51; req.user = { userId: 9, role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  getEmployeeFilter: async () => ({ type: 'all' }), applyFilter: (q) => q,
  canViewEmployee: async () => true, requirePaytimeModule: () => (req, res, next) => next()
}));

describe('salaryForPeriod', () => {
  const rows = [
    { id: 1, effective_period: '2026-08', basic_salary: 22000, previous_salary: 20000, created_at: '2026-08-01' },
    { id: 2, effective_period: '2027-03', basic_salary: 24000, previous_salary: 22000, created_at: '2026-10-14' }
  ];
  test('the change effective on or before the month applies; scheduled increase from its month', () => {
    expect(SH.salaryForPeriod(rows, '2026-10', 99).salary).toBe(22000);
    expect(SH.salaryForPeriod(rows, '2027-03', 99).salary).toBe(24000);
  });
  test('before the first change: its previous salary; no history: the employee record', () => {
    expect(SH.salaryForPeriod(rows, '2026-07', 99).salary).toBe(20000);
    expect(SH.salaryForPeriod([], '2026-07', 18000)).toEqual({ salary: 18000, source: 'employee' });
  });
});

describe('backPay', () => {
  const locked = [
    { period_key: '2026-08', calculation_input: { basic_salary: 20000 }, calculation_output: {} },
    { period_key: '2026-09', calculation_input: { basic_salary: 20000 }, calculation_output: { prorataFactor: 0.5 } },
    { period_key: '2026-07', calculation_input: { basic_salary: 20000 }, calculation_output: {} }
  ];
  test('difference over the finalized months from the effective month (pro-rata kept), paid in the next open month', () => {
    const bp = SH.backPay(22000, '2026-08', locked);
    expect(bp.amount).toBe(2000 + 1000);
    expect(bp.months.map(m => m.period_key)).toEqual(['2026-08', '2026-09']);
    expect(bp.target_period).toBe('2026-10');
  });
  test('effective after the last finalized month → no back pay', () => {
    expect(SH.backPay(22000, '2026-10', locked)).toMatchObject({ amount: 0, months: [], target_period: null });
  });
});

describe('POST /:id/salary-change', () => {
  let server, base, rpcCalls;
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use('/e', require('../modules/payroll/routes/employees'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => {
    rpcCalls = [];
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      employees: [{ id: 7, company_id: 51, first_name: 'A', last_name: 'B', basic_salary: 20000 }],
      employee_salary_history: [],
      payroll_snapshots: [
        { company_id: 51, employee_id: 7, period_key: '2026-08', is_locked: true, status: 'finalized', calculation_input: { basic_salary: 20000 }, calculation_output: {} },
        { company_id: 51, employee_id: 7, period_key: '2026-09', is_locked: true, status: 'finalized', calculation_input: { basic_salary: 20000 }, calculation_output: {} }
      ],
      payroll_periods: [{ id: 310, company_id: 51, period_key: '2026-10' }],
      payroll_period_inputs: [{ company_id: 51, employee_id: 7, payroll_period_id: 310, description: 'Bonus', amount: 500, item_type: 'earning', affects_uif: true, is_deleted: false }],
      __rpc: { paytime_replace_period_rows: (a) => { rpcCalls.push(a); return a.p_rows.length; } }
    });
  });
  const post = async (body) => {
    const r = await fetch(base + '/e/7/salary-change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('preview shows the back pay and saves nothing', async () => {
    const r = await post({ effective_period: '2026-08', basic_salary: 22000, reason: 'Increase', preview: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ preview: true, previous_salary: 20000, back_pay: { amount: 4000, target_period: '2026-10' } });
    expect(mockDb.employee_salary_history).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  test('saving: back pay appended to the open month (existing inputs kept), history row, employee updated', async () => {
    const r = await post({ effective_period: '2026-08', basic_salary: 22000, reason: 'Increase' });
    expect(r.status).toBe(201);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_rows.map(x => [x.description, x.amount])).toEqual([['Bonus', 500], ['Back pay — salary from 2026-08', 4000]]);
    expect(mockDb.employee_salary_history[0]).toMatchObject({ effective_period: '2026-08', basic_salary: 22000, previous_salary: 20000, backpay_amount: 4000, backpay_period: '2026-10', reason: 'Increase' });
    expect(mockDb.employees[0].basic_salary).toBe(22000);
  });

  test('scheduled increase: no back pay, employee record unchanged until its month', async () => {
    const r = await post({ effective_period: '2099-03', basic_salary: 30000, reason: 'Scheduled' });
    expect(r.status).toBe(201);
    expect(rpcCalls).toEqual([]);
    expect(mockDb.employees[0].basic_salary).toBe(20000);
  });

  test('retroactive decrease into finalized months is refused; reason and month are required', async () => {
    expect((await post({ effective_period: '2026-08', basic_salary: 18000, reason: 'x' })).body.code).toBe('RETRO_DECREASE');
    expect((await post({ effective_period: '2026-08', basic_salary: 22000 })).status).toBe(400);
    expect((await post({ effective_period: 'Aug', basic_salary: 22000, reason: 'x' })).status).toBe(400);
  });
});
