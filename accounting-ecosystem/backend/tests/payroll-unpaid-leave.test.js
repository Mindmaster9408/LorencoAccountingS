'use strict';

/**
 * Tests — leave saving restored + approved unpaid leave becomes short time (2026-11-11).
 * Change Impact Note: docs/paytime/UNPAID_LEAVE_CHANGE_IMPACT_NOTE.md
 */

const express = require('express');
const { unpaidLeaveForMonth, monthsBetween } = require('../modules/payroll/services/unpaidLeave');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1, role: req.headers['x-role'] || 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  requirePaytimeModule: () => (req, res, next) => next(),
  getEmployeeFilter: async (role) => role === 'restricted' ? { type: 'ids', ids: [1] } : { type: 'none' }
}));

const unpaid = (start, end, status) => ({ leave_type: 'unpaid', status: status || 'approved', start_date: start, end_date: end });

describe('unpaidLeaveForMonth (pure)', () => {
  const emp = { hire_date: '2020-01-01' };
  test('weekdays × 8 h by default; weekends and public holidays are not counted', () => {
    // 2026-09-21 (Mon) .. 2026-09-27 (Sun); 24 Sep = Heritage Day
    const r = unpaidLeaveForMonth({ periodKey: '2026-09', leave: [unpaid('2026-09-21', '2026-09-27')], schedule: null, employee: emp });
    expect(r.days).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-25']);
    expect(r.hours).toBe(32);
  });
  test('only approved UNPAID leave counts', () => {
    const leave = [unpaid('2026-09-01', '2026-09-01', 'pending'),
      { leave_type: 'annual', status: 'approved', start_date: '2026-09-02', end_date: '2026-09-02' },
      unpaid('2026-09-03', '2026-09-03')];
    expect(unpaidLeaveForMonth({ periodKey: '2026-09', leave, schedule: null, employee: emp })).toEqual({ days: ['2026-09-03'], hours: 8 });
  });
  test('leave across two months is split per month; schedule hours are used', () => {
    const schedule = { hours_per_day: 9, working_days: [{ day: 'MON', enabled: true }, { day: 'TUE', enabled: true },
      { day: 'WED', enabled: true }, { day: 'THU', enabled: true }, { day: 'FRI', enabled: true, type: 'partial', partial_hours: 5 }] };
    const leave = [unpaid('2026-09-29', '2026-10-02')];   // Tue 29, Wed 30 | Thu 1, Fri 2
    expect(unpaidLeaveForMonth({ periodKey: '2026-09', leave, schedule, employee: emp }).hours).toBe(18);
    expect(unpaidLeaveForMonth({ periodKey: '2026-10', leave, schedule, employee: emp }).hours).toBe(14);
  });
  test('days outside employment are not counted', () => {
    const r = unpaidLeaveForMonth({ periodKey: '2026-09', leave: [unpaid('2026-09-01', '2026-09-04')],
      schedule: null, employee: { hire_date: '2026-09-03' } });
    expect(r.days).toEqual(['2026-09-03', '2026-09-04']);
  });
  test('monthsBetween', () => {
    expect(monthsBetween('2026-11-20', '2027-01-05')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(monthsBetween('2026-09-01', null)).toEqual(['2026-09']);
  });
});

describe('leave API', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/att', require('../modules/payroll/routes/attendance'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const call = async (method, path, body, role) => {
    const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, role ? { 'x-role': role } : {}),
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  let rpcCalls;
  const reset = (extra) => {
    rpcCalls = [];
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      employees: [
        { id: 1, company_id: 7, first_name: 'Ann', last_name: 'A', is_active: true, hire_date: '2020-01-01' },
        { id: 9, company_id: 99, first_name: 'Other', last_name: 'Co', is_active: true, hire_date: '2020-01-01' }],
      employee_work_schedule: [], leave_records: [],
      leave_balances: [{ id: 1, company_id: 7, employee_id: 1, leave_type: 'annual', year: 2026, balance: 15 }],
      payroll_periods: [{ id: 50, company_id: 7, period_key: '2026-09', start_date: '2026-09-01', end_date: '2026-09-30' },
                        { id: 51, company_id: 7, period_key: '2026-10', start_date: '2026-10-01', end_date: '2026-10-31' }],
      payroll_short_time: [], payroll_snapshots: [],
      __rpc: { paytime_apply_unpaid_leave: (a) => {
        rpcCalls.push(a);
        if (a.p_period_id === 51 && mockDb.__lockOct) throw new Error('PERIOD_LOCKED');
        return a.p_hours > 0 ? 1 : 0;
      } }
    }, extra || {});
  };
  const leave = (r) => ({ employee_id: 1, records: [Object.assign({ leave_type: 'annual', start_date: '2026-09-07',
    end_date: '2026-09-08', days_taken: 2, status: 'approved', reason: 'x' }, r)] });

  test('POST /leave saves again (was missing since Fase 8); approved leave uses the balance, pending does not', async () => {
    reset();
    const a = await call('POST', '/att/leave', leave());
    expect(a.status).toBe(201);
    expect(mockDb.leave_records).toHaveLength(1);
    expect(mockDb.leave_balances[0].balance).toBe(13);
    expect(a.body.payslip).toBeNull();                       // not unpaid → payslip untouched
    await call('POST', '/att/leave', leave({ status: 'pending' }));
    expect(mockDb.leave_balances[0].balance).toBe(13);
    expect(rpcCalls).toEqual([]);
  });

  test('POST /leave refuses another company\'s or a hidden employee, bad types and dates', async () => {
    reset();
    expect((await call('POST', '/att/leave', Object.assign(leave(), { employee_id: 9 }))).status).toBe(404);
    expect((await call('POST', '/att/leave', leave({ leave_type: 'holiday' }))).status).toBe(400);
    expect((await call('POST', '/att/leave', leave({ end_date: '2026-09-01' }))).status).toBe(400);
    expect((await call('POST', '/att/leave', leave({ start_date: 'soon' }))).status).toBe(400);
    expect(mockDb.leave_records).toEqual([]);
  });

  test('approved unpaid leave → short time per month, server-calculated hours', async () => {
    reset();
    const r = await call('POST', '/att/leave', leave({ leave_type: 'unpaid', start_date: '2026-09-29', end_date: '2026-10-02', days_taken: 4 }));
    expect(r.status).toBe(201);
    expect(rpcCalls.map(c => [c.p_company_id, c.p_employee_id, c.p_period_id, c.p_hours, c.p_description])).toEqual([
      [7, 1, 50, 16, 'Unpaid leave: 2 days'], [7, 1, 51, 16, 'Unpaid leave: 2 days']]);
    expect(r.body.payslip.updated).toEqual([{ period_key: '2026-09', days: 2, hours: 16 }, { period_key: '2026-10', days: 2, hours: 16 }]);
  });

  test('pending unpaid leave writes 0 hours; approving it later deducts; deleting removes it', async () => {
    reset();
    await call('POST', '/att/leave', leave({ leave_type: 'unpaid', status: 'pending', start_date: '2026-09-07', end_date: '2026-09-07', days_taken: 1 }));
    expect(rpcCalls[0]).toMatchObject({ p_period_id: 50, p_hours: 0 });
    const id = mockDb.leave_records[0].id;
    const u = await call('PUT', `/att/leave/${id}`, { status: 'approved' });
    expect(u.status).toBe(200);
    expect(rpcCalls[1]).toMatchObject({ p_period_id: 50, p_hours: 8, p_description: 'Unpaid leave: 1 day' });
    const d = await call('DELETE', `/att/leave/${id}`);
    expect(d.status).toBe(200);
    expect(rpcCalls[2]).toMatchObject({ p_period_id: 50, p_hours: 0 });
  });

  test('moving unpaid leave to another month recomputes both months', async () => {
    reset();
    await call('POST', '/att/leave', leave({ leave_type: 'unpaid', start_date: '2026-09-07', end_date: '2026-09-07', days_taken: 1 }));
    rpcCalls.length = 0;
    const id = mockDb.leave_records[0].id;
    await call('PUT', `/att/leave/${id}`, { start_date: '2026-10-05', end_date: '2026-10-05' });
    expect(rpcCalls.map(c => [c.p_period_id, c.p_hours])).toEqual([[50, 0], [51, 8]]);
  });

  test('a finalized month is reported, never written', async () => {
    reset({ __lockOct: true });
    const r = await call('POST', '/att/leave', leave({ leave_type: 'unpaid', start_date: '2026-10-05', end_date: '2026-10-05', days_taken: 1 }));
    expect(r.status).toBe(201);                               // the leave itself is saved
    expect(r.body.payslip.locked).toEqual(['2026-10']);
    expect(r.body.payslip.updated).toEqual([]);
  });

  test('before migration 037 the leave is saved with a clear warning', async () => {
    reset();
    delete mockDb.__rpc;
    const r = await call('POST', '/att/leave', leave({ leave_type: 'unpaid' }));
    expect(r.status).toBe(201);
    expect(r.body.payslip.warning).toMatch(/037/);
  });
});
