'use strict';

/**
 * Tests — Fase 6 (spec 07 UF-06, 08 PS-02/03, findings B3, V5, BT-09):
 *   - the engine returns payslip lines that add up to the totals (PS-03)
 *   - finalized snapshots print their FROZEN lines; old snapshots are rebuilt from
 *     their frozen inputs, never from the employee's current items (PS-02)
 *   - input routes refuse a finalized month (423) and replace rows atomically
 *   - replaced draft runs are marked superseded and cannot be finalized (UF-06)
 *   - the exact tax table + fingerprint is frozen in calculation_output._meta (BT-09)
 */

const express = require('express');

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

const PayrollEngine = require('../core/payroll-engine');
const PayrollCalculationService = require('../modules/payroll/services/PayrollCalculationService');
const PayrollHistoryService = require('../modules/payroll/services/PayrollHistoryService');

const reset = (extra) => {
  Object.keys(mockDb).forEach(k => delete mockDb[k]);
  Object.assign(mockDb, {
    employees: [{ id: 1, company_id: 7 }, { id: 2, company_id: 7 }, { id: 9, company_id: 99 }],
    payroll_periods: [{ id: 50, company_id: 7, period_key: '2026-10', start_date: '2026-10-01', end_date: '2026-10-31' }],
    payroll_snapshots: [],
    payroll_period_inputs: [], payroll_overtime: [], payroll_short_time: [], payroll_multi_rate: [],
    payroll_items_master: [], payroll_kv_store_eco: [], payroll_runs: []
  }, extra || {});
};

// ── Engine lines ──────────────────────────────────────────────────────────────
describe('engine payslip_lines (PS-02/03)', () => {
  const run = (payrollData, ci, ot, mr, st, opts) =>
    PayrollEngine.calculateFromData(payrollData, ci || [], ot || [], mr || [], st || [], opts || {}, '2026-10', null, null);

  test('every kind of line, and they add up to gross / deductions / net', () => {
    const r = run(
      { basic_salary: 25000, regular_inputs: [
        { description: 'Travel Allowance', amount: 5000, type: 'allowance', taxable_percentage: 80 },
        { description: 'Cellphone', is_percentage: true, percentage_value: 2, amount: 0, type: 'allowance' },
        { description: 'Pension', amount: 1500, type: 'deduction', tax_treatment: 'pre_tax' },
        { description: 'Medical Aid', amount: 900, type: 'deduction' }] },
      [{ description: 'Commission', amount: 3000, type: 'income' }, { description: 'Loan', amount: 400, type: 'deduction' }],
      [{ hours: 4, rate_multiplier: 1.5 }, { hours: 2, rate_multiplier: 2 }],
      [{ hours: 3, hourly_rate: 200 }],
      [{ hours_missed: 5 }],
      { medicalMembers: 2, voluntaryTaxConfig: [{ id: 'f1', type: 'fixed', fixed_amount: 250, description: 'extra' }] }
    );
    const kinds = r.payslip_lines.map(l => l.kind);
    ['basic', 'regular', 'current', 'overtime', 'multi_rate', 'short_time', 'paye', 'voluntary', 'uif', 'uif_employer', 'sdl']
      .forEach(k => expect(kinds).toContain(k));
    expect(r.payslip_lines.find(l => l.description === 'Cellphone').amount).toBe(500);       // 2% of 25 000
    expect(r.payslip_lines.find(l => l.kind === 'short_time').amount).toBeLessThan(0);
    expect(r.payslip_lines.find(l => l.description === 'Pension').pre_tax).toBe(true);
    expect(r.payslip_check.ok).toBe(true);
    expect(r.payslip_check.earnings).toBeCloseTo(r.gross, 2);
    expect(r.payslip_check.net).toBeCloseTo(r.net, 2);
  });

  test('pro-rata: the basic line is the pro-rated salary', () => {
    const r = PayrollEngine.calculateWithProRata({ basic_salary: 31000, regular_inputs: [] }, '2026-10-16', null,
      [], [], [], [], {}, '2026-10', null, null);
    expect(r.payslip_lines.find(l => l.kind === 'basic').amount).toBeCloseTo(r.gross, 2);
    expect(r.payslip_check.ok).toBe(true);
  });

  test('checkPayslipLines flags lines that do not add up', () => {
    const c = PayrollEngine.checkPayslipLines(
      [{ section: 'earning', amount: 1000 }, { section: 'tax', amount: 100 }],
      { gross: 1200, paye: 100, uif: 0, deductions: 0, net: 1100 });
    expect(c.ok).toBe(false);
    expect(c.gross_diff).toBe(-200);
  });
});

// ── Snapshot lines + tax table ────────────────────────────────────────────────
describe('snapshot payslip lines (PS-02)', () => {
  test('new snapshots carry their lines and the frozen tax table + hash (BT-09)', async () => {
    const calc = await PayrollCalculationService.calculate({
      basic_salary: 20000, regular_inputs: [], currentInputs: [], overtime: [], shortTime: [], multiRate: [],
      employeeOptions: {}, period: '2026-10', ytdData: null
    }, { taxConfig: null });
    const snap = PayrollHistoryService.prepareSnapshot(7, 1, 50, '2026-10', { basic_salary: 20000 }, calc, 1);
    const out = PayrollHistoryService.formatForResponse(Object.assign({ id: 1, is_locked: true }, snap));
    expect(out.payslip_lines_source).toBe('snapshot');
    expect(out.payslip_check.ok).toBe(true);
    expect(calc._meta.taxTable.tax_year).toBe('2026/2027');
    expect(calc._meta.taxTable.rebates[0]).toBe(17820);
    expect(calc._meta.taxTableHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await PayrollCalculationService.calculate({
      basic_salary: 5, regular_inputs: [], employeeOptions: {}, period: '2026-11', ytdData: null }, {});
    expect(again._meta.taxTableHash).toBe(calc._meta.taxTableHash);   // same table → same fingerprint
  });

  test('old snapshot: lines rebuilt from the FROZEN input, totals untouched', () => {
    const out = PayrollHistoryService.formatForResponse({
      id: 3, is_locked: true,
      calculation_input: { basic_salary: 18000, regular_inputs: [{ description: 'Old allowance', amount: 1000, type: 'allowance' }] },
      calculation_output: { gross: 19000, paye: 1500, uif: 177.12, uif_employer: 177.12, sdl: 190, deductions: 0, net: 17322.88 }
    });
    expect(out.payslip_lines_source).toBe('rebuilt_from_frozen_inputs');
    expect(out.payslip_lines.map(l => l.description)).toContain('Old allowance');
    expect(out.payslip_check.ok).toBe(true);
    expect(out.calculation_output.gross).toBe(19000);
  });

  test('a snapshot without frozen input gets no invented lines', () => {
    const out = PayrollHistoryService.formatForResponse({ id: 4, calculation_output: { gross: 1 } });
    expect(out.payslip_lines).toBeNull();
    expect(out.payslip_lines_source).toBe('none');
  });
});

// ── Input routes ──────────────────────────────────────────────────────────────
describe('period input routes (6.1)', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/tx', require('../modules/payroll/routes/transactions'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const lockedSnap = (status) => ({ id: 1, company_id: 7, employee_id: 1, period_key: '2026-10', is_locked: status !== 'reversed', status: status || 'finalized' });

  test('open month: the set is replaced (legacy path before migration 028)', async () => {
    reset({ payroll_overtime: [{ id: 1, company_id: 7, employee_id: 1, payroll_period_id: 50, hours: 9, rate_multiplier: 1.5 }] });
    const r = await post('/tx/overtime', { employee_id: 1, period_key: '2026-10', entries: [{ hours: 2 }, { hours: 3, rate_multiplier: 2 }] });
    expect(r.status).toBe(200);
    expect(mockDb.payroll_overtime.map(o => o.hours)).toEqual([2, 3]);
  });

  test('finalized month: 423 PERIOD_LOCKED and nothing changes — all four routes', async () => {
    for (const [path, table, body] of [
      ['/tx/inputs', 'payroll_period_inputs', { inputs: [{ description: 'X', amount: 1 }] }],
      ['/tx/overtime', 'payroll_overtime', { entries: [{ hours: 1 }] }],
      ['/tx/short-time', 'payroll_short_time', { entries: [{ hours_missed: 1 }] }],
      ['/tx/multi-rate', 'payroll_multi_rate', { entries: [{ hours: 1, rate_multiplier: 100 }] }]]) {
      reset({ payroll_snapshots: [lockedSnap()], [table]: [{ id: 7, company_id: 7, employee_id: 1, payroll_period_id: 50, keep: true }] });
      const r = await post(path, Object.assign({ employee_id: 1, period_key: '2026-10' }, body));
      expect([path, r.status, r.body.code]).toEqual([path, 423, 'PERIOD_LOCKED']);
      expect(mockDb[table]).toEqual([{ id: 7, company_id: 7, employee_id: 1, payroll_period_id: 50, keep: true }]);
    }
  });

  test('a reversed month is open again', async () => {
    reset({ payroll_snapshots: [lockedSnap('reversed')] });
    expect((await post('/tx/short-time', { employee_id: 1, period_key: '2026-10', entries: [{ hours_missed: 2 }] })).status).toBe(200);
  });

  test('another company\'s employee is refused (404)', async () => {
    reset();
    expect((await post('/tx/overtime', { employee_id: 9, period_key: '2026-10', entries: [{ hours: 1 }] })).status).toBe(404);
    expect(mockDb.payroll_overtime).toEqual([]);
  });

  test('after migration 028 the database function does the replace', async () => {
    const calls = [];
    reset({ __rpc: { paytime_replace_period_rows: (args) => { calls.push(args); return args.p_rows.length; } } });
    const r = await post('/tx/inputs', { employee_id: 2, period_key: '2026-10', inputs: [{ description: 'Bonus', amount: 1000, type: 'earning' }] });
    expect(r.status).toBe(200);
    expect(calls[0]).toMatchObject({ p_table: 'payroll_period_inputs', p_company_id: 7, p_employee_id: 2, p_period_id: 50 });
    expect(calls[0].p_rows[0]).toMatchObject({ description: 'Bonus', amount: 1000, item_type: 'earning', affects_uif: true });
  });

  test('database function says PERIOD_LOCKED → 423', async () => {
    reset({ __rpc: { paytime_replace_period_rows: () => { throw new Error('PERIOD_LOCKED'); } } });
    const r = await post('/tx/overtime', { employee_id: 1, period_key: '2026-10', entries: [] });
    expect(r.status).toBe(423);
  });
});

// ── Superseded runs ───────────────────────────────────────────────────────────
describe('superseded draft runs (UF-06)', () => {
  test('older drafts with no open payslips are marked superseded; others stay draft', async () => {
    reset({
      payroll_runs: [
        { id: 'old-empty', company_id: 7, period_key: '2026-10', status: 'draft' },
        { id: 'old-partial', company_id: 7, period_key: '2026-10', status: 'draft' },
        { id: 'finalized', company_id: 7, period_key: '2026-10', status: 'finalized' },
        { id: 'other-month', company_id: 7, period_key: '2026-09', status: 'draft' },
        { id: 'new', company_id: 7, period_key: '2026-10', status: 'draft' }],
      payroll_snapshots: [{ id: 1, company_id: 7, payroll_run_id: 'old-partial', status: 'draft', is_locked: false }]
    });
    const supabase = require('../config/database').supabase;
    const marked = await PayrollHistoryService.markSupersededRuns(supabase, 7, '2026-10', 'new');
    expect(marked).toEqual(['old-empty']);
    const st = Object.fromEntries(mockDb.payroll_runs.map(r => [r.id, r.status]));
    expect(st).toEqual({ 'old-empty': 'superseded', 'old-partial': 'draft', finalized: 'finalized', 'other-month': 'draft', new: 'draft' });
    expect(mockDb.payroll_runs[0].superseded_by_run_id).toBe('new');
  });

  describe('finalize refuses', () => {
    let server, base;
    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use('/pr', require('../modules/payroll/routes/payruns'));
      await new Promise(r => { server = app.listen(0, r); });
      base = 'http://127.0.0.1:' + server.address().port;
    });
    afterAll(() => new Promise(r => server.close(r)));
    const fin = async (run_id) => {
      const r = await fetch(base + '/pr/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id, period_key: '2026-10' }) });
      return { status: r.status, body: await r.json() };
    };

    test('a superseded run', async () => {
      reset({ payroll_runs: [{ id: 'r1', company_id: 7, period_key: '2026-10', status: 'superseded', superseded_by_run_id: 'r2' }] });
      const r = await fin('r1');
      expect([r.status, r.body.code, r.body.superseded_by_run_id]).toEqual([409, 'RUN_SUPERSEDED', 'r2']);
    });

    test('a draft run that no longer owns any open payslip — nothing is locked', async () => {
      reset({
        payroll_runs: [{ id: 'r1', company_id: 7, period_key: '2026-10', status: 'draft' }],
        payroll_snapshots: [{ id: 5, company_id: 7, employee_id: 1, period_key: '2026-10', payroll_run_id: 'r2', is_locked: false, status: 'draft' }]
      });
      const r = await fin('r1');
      expect([r.status, r.body.code]).toEqual([409, 'RUN_SUPERSEDED']);
      expect(mockDb.payroll_runs[0].status).toBe('draft');
      expect(mockDb.payroll_snapshots[0].is_locked).toBe(false);
    });
  });
});
