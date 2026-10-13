'use strict';

/**
 * Tests — Fase 5 (spec 06 ENJ-20/21, 03 WN-10, 07 UF-02; findings B8, V4):
 *   - pro-rata factor is not rounded; only rand amounts are
 *   - basic salary AND fixed allowances are pro-rated; once-off inputs, overtime and
 *     deductions are not
 *   - hired after the period → blocked with a clear message; terminated before the
 *     period → excluded, also when still flagged active
 */

const express = require('express');
const PayrollEngine = require('../core/payroll-engine');
const { payrollEligibility } = require('../modules/payroll/services/payrollEligibility');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1, role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  requirePaytimeModule: () => (req, res, next) => next(),
  getEmployeeFilter: async () => ({ type: 'none' })
}));

describe('pro-rata factor (ENJ-20, B8)', () => {
  test('not rounded: 15 of 22 working days', () => {
    const f = PayrollEngine.calculateProRataFactor('2026-10-10', null, '2026-10', null, 8);
    expect(f.factor).toBeCloseTo(15 / 22, 12);
    expect(f.factor).not.toBe(0.68);
  });

  test('R30 000 from the 10th: basic = 30 000 × 15/22, to the cent', () => {
    const r = PayrollEngine.calculateWithProRata({ basic_salary: 30000, regular_inputs: [] }, '2026-10-10', null,
      [], [], [], [], {}, '2026-10', null, null);
    expect(r.gross).toBe(20454.55);
  });
});

describe('what is pro-rated (ENJ-21)', () => {
  const r = PayrollEngine.calculateWithProRata(
    { basic_salary: 22000, regular_inputs: [
      { description: 'Travel', amount: 4400, type: 'allowance' },
      { description: 'Phone 5%', is_percentage: true, percentage_value: 5, amount: 0, type: 'allowance' },
      { description: 'Medical aid', amount: 1000, type: 'deduction' }] },
    '2026-10-16', null,
    [{ description: 'Bonus', amount: 1000, type: 'income' }],
    [{ hours: 2, rate_multiplier: 1.5 }], [], [], {}, '2026-10', null, null);
  const line = (d) => r.payslip_lines.find(l => l.description === d);
  const f = 11 / 22;  // 16–31 Oct 2026 = Fri 16 + two full weeks = 11 of 22 working days

  test('basic salary and fixed allowance are pro-rated', () => {
    expect(line('Basic Salary').amount).toBeCloseTo(22000 * f, 2);
    expect(line('Travel').amount).toBeCloseTo(4400 * f, 2);
  });
  test('percentage item follows the pro-rated basic salary', () => {
    expect(line('Phone 5%').amount).toBeCloseTo(PayrollEngine.r2(22000 * f) * 0.05, 2);
  });
  test('once-off input and deduction are NOT pro-rated', () => {
    expect(line('Bonus').amount).toBe(1000);
    expect(line('Medical aid').amount).toBe(1000);
  });
  test('the lines still add up', () => {
    expect(r.payslip_check.ok).toBe(true);
  });
});

describe('payrollEligibility (WN-10, UF-02)', () => {
  const P = ['2026-10-01', '2026-10-31'];
  test('hired after the period → blocked with the agreed message', () => {
    const e = payrollEligibility({ is_active: true, hire_date: '2026-11-03', first_name: 'Sipho', last_name: 'Dlamini' }, ...P);
    expect(e).toEqual({ eligible: false, code: 'STARTS_AFTER_PERIOD',
      message: 'Sipho Dlamini only starts on 2026-11-03. Choose a later period, or change the start date if it is wrong.' });
  });
  test('hired inside the period → eligible (pro-rata)', () => {
    expect(payrollEligibility({ is_active: true, hire_date: '2026-10-31' }, ...P).eligible).toBe(true);
  });
  test('terminated before the period → excluded even if still flagged active', () => {
    expect(payrollEligibility({ is_active: true, termination_date: '2026-09-30' }, ...P).code).toBe('TERMINATED_BEFORE_PERIOD');
  });
  test('terminated inside the period → eligible (final month)', () => {
    expect(payrollEligibility({ is_active: false, termination_date: '2026-10-01' }, ...P).eligible).toBe(true);
  });
  test('timestamps are compared as dates', () => {
    expect(payrollEligibility({ is_active: true, hire_date: '2026-10-31T00:00:00Z' }, ...P).eligible).toBe(true);
  });
});

describe('single payslip calculation refuses months outside employment', () => {
  let server, base;
  beforeAll(async () => {
    Object.assign(mockDb, {
      employees: [
        { id: 1, company_id: 7, is_active: true, hire_date: '2026-12-01', first_name: 'New', last_name: 'Starter' },
        { id: 2, company_id: 7, is_active: true, hire_date: '2020-01-01', termination_date: '2026-08-31', first_name: 'Gone', last_name: 'Already' }],
      payroll_snapshots: [], companies: [{ id: 7, payroll_strict_period_order: false }]
    });
    const app = express();
    app.use(express.json());
    app.use('/calc', require('../modules/payroll/routes/calculate'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const calc = async (employee_id) => {
    const r = await fetch(base + '/calc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, period_key: '2026-10' }) });
    return { status: r.status, body: await r.json() };
  };

  test('before the start date → 422 STARTS_AFTER_PERIOD', async () => {
    const r = await calc(1);
    expect([r.status, r.body.code]).toEqual([422, 'STARTS_AFTER_PERIOD']);
    expect(r.body.error).toMatch(/only starts on 2026-12-01/);
  });
  test('after the termination month → 422 TERMINATED_BEFORE_PERIOD', async () => {
    const r = await calc(2);
    expect([r.status, r.body.code]).toEqual([422, 'TERMINATED_BEFORE_PERIOD']);
  });
});
