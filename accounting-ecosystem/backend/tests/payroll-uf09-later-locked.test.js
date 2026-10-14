'use strict';

/** Tests — spec 07 UF-09: later finalized months listed BEFORE a reversal (latest first). */

const express = require('express');
const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 51; req.user = { userId: 1, role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  getEmployeeFilter: async () => ({ type: 'all' }), requirePaytimeModule: () => (req, res, next) => next()
}));

let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.companyId = 51; req.user = { userId: 1, role: 'admin' }; next(); });
  app.use('/p', require('../modules/payroll/routes/payruns'));
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

const snap = (run, p, emp, locked = true) => ({ company_id: 51, payroll_run_id: run, period_key: p, employee_id: emp, is_locked: locked, status: locked ? 'finalized' : 'draft' });

test('lists later finalized runs that contain these employees, latest first', async () => {
  Object.assign(mockDb, {
    payroll_runs: [
      { id: 'r07', company_id: 51, period_key: '2026-07', status: 'finalized' },
      { id: 'r08', company_id: 51, period_key: '2026-08', status: 'finalized' },
      { id: 'r09', company_id: 51, period_key: '2026-09', status: 'finalized' },
      { id: 'r10', company_id: 51, period_key: '2026-10', status: 'draft' },
      { id: 'x09', company_id: 99, period_key: '2026-09', status: 'finalized' }
    ],
    payroll_snapshots: [
      snap('r07', '2026-07', 1), snap('r07', '2026-07', 2),
      snap('r08', '2026-08', 1), snap('r09', '2026-09', 2), snap('r09', '2026-09', 3),
      snap('r10', '2026-10', 1, false),
      Object.assign(snap('x09', '2026-09', 1), { company_id: 99 })
    ]
  });
  const r = await (await fetch(base + '/p/history/run/r07/later-locked')).json();
  expect(r.success).toBe(true);
  expect(r.later_runs).toEqual([
    { run_id: 'r09', period_key: '2026-09', employees: 1 },
    { run_id: 'r08', period_key: '2026-08', employees: 1 }
  ]);
});

test('no later months → empty list; unknown run → 404', async () => {
  expect((await (await fetch(base + '/p/history/run/r09/later-locked')).json()).later_runs).toEqual([]);
  expect((await fetch(base + '/p/history/run/nope/later-locked')).status).toBe(404);
});
