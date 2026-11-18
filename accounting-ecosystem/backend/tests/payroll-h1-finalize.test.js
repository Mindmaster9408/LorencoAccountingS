'use strict';

/**
 * Tests — audit 2026-11-18 H1: finalize marks the run finalized FIRST, then locks its
 * payslips; a failure never leaves payslips locked under a draft run. Supplemental runs
 * (employees missed in the month's first run) can be finalized once migration 038 has
 * dropped the one-finalized-run-per-month index; before that they get a clear 409 and
 * nothing is locked.
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
const mockJournal = { calls: [] };
jest.mock('../modules/payroll/services/payrollJournal', () => ({
  defaultDeps: () => ({}),
  createDraftForRun: async (deps, p) => { mockJournal.calls.push(p.runId); return { created: true, run: p.runId }; },
  handleRunReversal: async () => ({ action: 'none' })
}));

const PERIOD = '2026-10';
const snap = (id, emp, run, locked) => ({
  id, company_id: 7, employee_id: emp, period_key: PERIOD, payroll_run_id: run,
  is_locked: !!locked, status: locked ? 'finalized' : 'draft',
  calculation_output: { gross: 1000, net: 900 }, calculation_input: {}
});

// The DB index migration 038 drops: one finalized run per company + period.
const uniqueFinalizedRun = (hit, patch, db) => {
  if (patch.status !== 'finalized') return null;
  for (const r of hit) {
    const clash = db.payroll_runs.find(o => o !== r && o.status === 'finalized' &&
      String(o.company_id) === String(r.company_id) && o.period_key === r.period_key);
    if (clash) return { code: '23505', message: 'duplicate key value violates unique constraint "idx_payroll_runs_finalized_unique"' };
  }
  return null;
};

const reset = (extra) => {
  Object.keys(mockDb).forEach(k => delete mockDb[k]);
  Object.assign(mockDb, {
    companies: [{ id: 7, payroll_strict_period_order: false }],
    employees: [{ id: 1, company_id: 7, first_name: 'A' }, { id: 2, company_id: 7, first_name: 'B' }],
    payroll_runs: [], payroll_snapshots: []
  }, extra || {});
  mockJournal.calls = [];
};

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
    body: JSON.stringify({ run_id, period_key: PERIOD }) });
  return { status: r.status, body: await r.json() };
};
const run = id => mockDb.payroll_runs.find(r => r.id === id);
const snapById = id => mockDb.payroll_snapshots.find(s => s.id === id);

describe('H1 — finalize order', () => {
  test('normal finalize: run finalized, payslips locked, Leo journal for this run', async () => {
    reset({
      payroll_runs: [{ id: 'r1', company_id: 7, period_key: PERIOD, status: 'draft' }],
      payroll_snapshots: [snap(11, 1, 'r1'), snap(12, 2, 'r1')]
    });
    const r = await fin('r1');
    expect(r.status).toBe(200);
    expect(r.body.locked_count).toBe(2);
    expect(run('r1').status).toBe('finalized');
    expect([snapById(11).is_locked, snapById(12).is_locked]).toEqual([true, true]);
    expect(mockJournal.calls).toEqual(['r1']);
  });

  test('supplemental run BEFORE migration 038: 409 PERIOD_ALREADY_FINALIZED and NOTHING is locked', async () => {
    reset({
      __beforeUpdate: { payroll_runs: uniqueFinalizedRun },
      payroll_runs: [
        { id: 'r0', company_id: 7, period_key: PERIOD, status: 'finalized' },
        { id: 'r1', company_id: 7, period_key: PERIOD, status: 'draft' }],
      payroll_snapshots: [snap(10, 1, 'r0', true), snap(12, 2, 'r1')]
    });
    const r = await fin('r1');
    expect([r.status, r.body.code]).toEqual([409, 'PERIOD_ALREADY_FINALIZED']);
    expect(run('r1').status).toBe('draft');
    expect(snapById(12).is_locked).toBe(false);          // the old bug locked this one
    expect(mockJournal.calls).toEqual([]);
  });

  test('supplemental run AFTER migration 038: finalized on its own, own journal, first run untouched', async () => {
    reset({
      payroll_runs: [
        { id: 'r0', company_id: 7, period_key: PERIOD, status: 'finalized' },
        { id: 'r1', company_id: 7, period_key: PERIOD, status: 'draft' }],
      payroll_snapshots: [snap(10, 1, 'r0', true), snap(12, 2, 'r1')]
    });
    const r = await fin('r1');
    expect(r.status).toBe(200);
    expect(r.body.locked_count).toBe(1);
    expect([run('r0').status, run('r1').status]).toEqual(['finalized', 'finalized']);
    expect(snapById(12).is_locked).toBe(true);
    expect(snapById(12).payroll_run_id).toBe('r1');
    expect(mockJournal.calls).toEqual(['r1']);
  });

  test('locking fails → the run is put back to draft (nothing half-finalized)', async () => {
    reset({
      __beforeUpdate: { payroll_snapshots: () => ({ code: '57014', message: 'canceling statement due to statement timeout' }) },
      payroll_runs: [{ id: 'r1', company_id: 7, period_key: PERIOD, status: 'draft' }],
      payroll_snapshots: [snap(11, 1, 'r1')]
    });
    const r = await fin('r1');
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/nothing was finalized/);
    expect(run('r1').status).toBe('draft');
    expect(run('r1').finalized_at).toBeNull();
    expect(snapById(11).is_locked).toBe(false);
    expect(mockJournal.calls).toEqual([]);
  });

  test('another company\'s run with the same id is never finalized', async () => {
    reset({
      payroll_runs: [{ id: 'r1', company_id: 99, period_key: PERIOD, status: 'draft' }],
      payroll_snapshots: [{ ...snap(11, 1, 'r1'), company_id: 99 }]
    });
    const r = await fin('r1');
    expect(r.status).toBe(404);
    expect(run('r1').status).toBe('draft');
  });
});

describe('H1 — PayrollHistoryService.finalizePayrollRun', () => {
  const PHS = require('../modules/payroll/services/PayrollHistoryService');
  const supabase = () => require('../config/database').supabase;

  test('only a draft run is finalized; a finalized one gives PGRST116 (no double finalize)', async () => {
    reset({ payroll_runs: [{ id: 'r1', company_id: 7, period_key: PERIOD, status: 'finalized', finalized_by: 5 }] });
    await expect(PHS.finalizePayrollRun(supabase(), 'r1', 1, 7)).rejects.toMatchObject({ code: 'PGRST116' });
    expect(run('r1').finalized_by).toBe(5);
  });

  test('keeps the unique-index error code (23505)', async () => {
    reset({
      __beforeUpdate: { payroll_runs: uniqueFinalizedRun },
      payroll_runs: [
        { id: 'r0', company_id: 7, period_key: PERIOD, status: 'finalized' },
        { id: 'r1', company_id: 7, period_key: PERIOD, status: 'draft' }]
    });
    await expect(PHS.finalizePayrollRun(supabase(), 'r1', 1, 7)).rejects.toMatchObject({ code: '23505' });
  });

  test('revertRunToDraft only touches a finalized run of this company', async () => {
    reset({ payroll_runs: [
      { id: 'r1', company_id: 7, period_key: PERIOD, status: 'finalized', finalized_by: 1, finalized_at: 'x' },
      { id: 'r2', company_id: 99, period_key: PERIOD, status: 'finalized', finalized_by: 1, finalized_at: 'x' }] });
    await PHS.revertRunToDraft(supabase(), 'r1', 7);
    await PHS.revertRunToDraft(supabase(), 'r2', 7);
    expect([run('r1').status, run('r2').status]).toEqual(['draft', 'finalized']);
  });
});
