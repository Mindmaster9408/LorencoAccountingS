'use strict';

/**
 * Tests — Fase 8: attendance → payroll (spec 05 PI-08 option b, PI-09; finding V1)
 *   - the proposal follows BCEA (roster-based overtime, 45h week, Sunday 2×,
 *     public holiday extra 1×) and does not count leave / holidays as absence
 *   - attendance is stored in the DB (hours calculated on the server)
 *   - nothing reaches a payslip until approved; approval replaces only the
 *     attendance rows, refuses a finalized month, and recalculates server-side
 */

const express = require('express');
const { computeAttendanceProposal, saPublicHolidays, hoursBetween } = require('../modules/payroll/services/attendanceProposal');

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
  // a 'restricted' user only sees employee 1 (confidential employees hidden, WN-14)
  getEmployeeFilter: async (role) => role === 'restricted' ? { type: 'ids', ids: [1] } : { type: 'none' }
}));

const day = (d, h, extra) => Object.assign({ attendance_date: d, hours_worked: h, status: 'present' }, extra || {});

describe('proposal rules (PI-09)', () => {
  const base = { periodKey: '2026-09', employee: { hire_date: '2020-01-01' }, schedule: null, leave: [], today: '2026-10-13' };

  test('SA public holidays 2026 incl. Easter and Sunday → Monday', () => {
    const h = saPublicHolidays(2026);
    ['2026-04-03', '2026-04-06', '2026-08-10', '2026-09-24', '2026-12-16'].forEach(d => expect(h.has(d)).toBe(true));
  });

  test('overtime = hours beyond the roster, not "> 8 a day"', () => {
    const sched = { hours_per_day: 9, working_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'].map(d => ({ day: d, enabled: true })) };
    const p = computeAttendanceProposal(Object.assign({}, base, { schedule: sched, records: [day('2026-09-01', 9.5)] }));
    expect(p.overtime_hours).toBe(0.5);           // 9h roster: only 0.5h overtime (old rule said 1.5)
  });

  test('ordinary hours above 45 in a week are overtime', () => {
    const sched = { hours_per_day: 10, working_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'].map(d => ({ day: d, enabled: true })) };
    const recs = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'].map(d => day(d, 10));
    const p = computeAttendanceProposal(Object.assign({}, base, { schedule: sched, records: recs }));
    expect(p.weekly_excess_hours).toBe(5);         // 50 ordinary hours → 5 over 45
    expect(p.overtime_rows[0]).toMatchObject({ rate_multiplier: 1.5 });
  });

  test('Sunday (not rostered) at 2×, public holiday worked at an extra 1×', () => {
    const p = computeAttendanceProposal(Object.assign({}, base, { records: [day('2026-09-06', 5), day('2026-09-24', 8)] }));
    expect(p.sunday_hours).toBe(5);
    expect(p.public_holiday_hours).toBe(8);
    expect(p.overtime_rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ hours: 5, rate_multiplier: 2 }),
      expect.objectContaining({ hours: 8, rate_multiplier: 1 })]));
  });

  test('absence = rostered day without attendance; leave and public holidays are not absence', () => {
    const recs = [];
    for (let d = 1; d <= 30; d++) {
      const ds = `2026-09-${String(d).padStart(2, '0')}`;
      const dow = new Date(ds + 'T00:00:00Z').getUTCDay();
      if (dow > 0 && dow < 6 && !['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-24'].includes(ds)) recs.push(day(ds, 8));
    }
    const p = computeAttendanceProposal(Object.assign({}, base, {
      records: recs, leave: [{ start_date: '2026-09-16', end_date: '2026-09-16', status: 'approved' },
                             { start_date: '2026-09-17', end_date: '2026-09-17', status: 'pending' }]
    }));
    expect(p.absent_days).toEqual(['2026-09-15', '2026-09-17']);   // pending leave is not leave
    expect(p.leave_days).toEqual(['2026-09-16']);
    expect(p.short_time_rows).toEqual([{ hours_missed: 16, description: 'Attendance: 2 absent day(s)' }]);
  });

  test('days before the start date or after leaving are never absences', () => {
    const p = computeAttendanceProposal(Object.assign({}, base, { employee: { hire_date: '2026-09-29' }, records: [day('2026-09-29', 8)] }));
    expect(p.absent_days).toEqual(['2026-09-30']);
  });

  test('future days are not absences', () => {
    const p = computeAttendanceProposal(Object.assign({}, base, { periodKey: '2026-10', records: [], today: '2026-10-02' }));
    expect(p.absent_days).toEqual(['2026-10-01', '2026-10-02']);
  });

  test('hoursBetween handles overnight shifts', () => {
    expect(hoursBetween('22:00', '06:30')).toBe(8.5);
    expect(hoursBetween('08:00', '')).toBe(0);
  });
});

describe('attendance API', () => {
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
  const reset = (extra) => {
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      employees: [
        { id: 1, company_id: 7, first_name: 'Ann', last_name: 'A', is_active: true, hire_date: '2020-01-01' },
        { id: 2, company_id: 7, first_name: 'Ben', last_name: 'B', is_active: true, hire_date: '2020-01-01' },
        { id: 9, company_id: 99, first_name: 'Other', last_name: 'Co', is_active: true, hire_date: '2020-01-01' }],
      attendance: [], employee_work_schedule: [], leave_records: [],
      payroll_periods: [{ id: 50, company_id: 7, period_key: '2026-09', start_date: '2026-09-01', end_date: '2026-09-30' }],
      payroll_overtime: [], payroll_short_time: [], payroll_snapshots: []
    }, extra || {});
  };

  test('POST stores one row per day with server-calculated hours; GET returns HH:MM', async () => {
    reset();
    const r = await call('POST', '/att', { entries: [{ employee_id: 1, date: '2026-09-01', clock_in: '07:30', clock_out: '17:45', hours_worked: 99 }] });
    expect(r.status).toBe(201);
    expect(mockDb.attendance[0]).toMatchObject({ employee_id: 1, attendance_date: '2026-09-01', hours_worked: 10.25,
      clock_in: '2026-09-01T07:30:00+02:00' });
    mockDb.attendance[0].clock_in = '2026-09-01T05:30:00.000Z';   // as Postgres returns it (UTC)
    const g = await call('GET', '/att?from=2026-09-01&to=2026-09-30');
    expect(g.body.attendance[0]).toMatchObject({ date: '2026-09-01', clock_in: '07:30' });
  });

  test('POST refuses another company\'s employee and bad times', async () => {
    reset();
    expect((await call('POST', '/att', { entries: [{ employee_id: 9, date: '2026-09-01', clock_in: '08:00' }] })).status).toBe(400);
    expect((await call('POST', '/att', { entries: [{ employee_id: 1, date: '2026-09-01', clock_in: '25:00' }] })).status).toBe(400);
    expect(mockDb.attendance).toEqual([]);
  });

  test('confidential employees stay hidden from a restricted user', async () => {
    reset({ attendance: [
      { id: 1, company_id: 7, employee_id: 1, attendance_date: '2026-09-01', hours_worked: 8, status: 'present' },
      { id: 2, company_id: 7, employee_id: 2, attendance_date: '2026-09-01', hours_worked: 8, status: 'present' }] });
    const g = await call('GET', '/att?from=2026-09-01&to=2026-09-30', null, 'restricted');
    expect(g.body.attendance.map(a => a.employee_id)).toEqual([1]);
    expect((await call('POST', '/att', { entries: [{ employee_id: 2, date: '2026-09-02', clock_in: '08:00' }] }, 'restricted')).status).toBe(400);
  });

  test('proposal writes nothing', async () => {
    reset({ attendance: [{ id: 1, company_id: 7, employee_id: 1, attendance_date: '2026-09-01', hours_worked: 11, status: 'present' }] });
    const r = await call('GET', '/att/proposal?period_key=2026-09');
    expect(r.body.proposals).toHaveLength(1);
    expect(r.body.proposals[0].overtime_rows[0]).toMatchObject({ hours: 3, rate_multiplier: 1.5 });
    expect(mockDb.payroll_overtime).toEqual([]);
  });

  test('apply: server-calculated rows, finalized months skipped, nothing for unticked employees', async () => {
    const calls = [];
    reset({
      attendance: [
        { id: 1, company_id: 7, employee_id: 1, attendance_date: '2026-09-01', hours_worked: 11, status: 'present' },
        { id: 2, company_id: 7, employee_id: 2, attendance_date: '2026-09-01', hours_worked: 12, status: 'present' }],
      __rpc: { paytime_apply_attendance: (a) => {
        if (a.p_employee_id === 2) throw new Error('PERIOD_LOCKED');
        calls.push(a); return 1;
      } }
    });
    const r = await call('POST', '/att/apply', { period_key: '2026-09', employee_ids: [1, 2, 9] });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_company_id: 7, p_employee_id: 1, p_period_id: 50 });
    expect(calls[0].p_overtime[0]).toMatchObject({ hours: 3, rate_multiplier: 1.5 });
    expect(r.body.skipped.map(s => s.code || s.error)).toEqual(['Not eligible or not visible', 'PERIOD_LOCKED']);
  });

  test('apply before migration 029 → 409, nothing written', async () => {
    reset({ attendance: [{ id: 1, company_id: 7, employee_id: 1, attendance_date: '2026-09-01', hours_worked: 11, status: 'present' }] });
    const r = await call('POST', '/att/apply', { period_key: '2026-09', employee_ids: [1] });
    expect(r.status).toBe(409);
    expect(mockDb.payroll_overtime).toEqual([]);
  });
});
