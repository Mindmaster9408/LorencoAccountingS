'use strict';

/**
 * Tests — PAYE reconciliation / EMP501 figures (Fase 7, spec 09 RS-01/02/04/05).
 *   - EMP201 UIF = employee + employer (was employee only, finding W7)
 *   - EMP501 employer UIF from the snapshot (was hardcoded 0)
 *   - historical import rows never double-count a month that has a locked snapshot
 */

const express = require('express');
const { createFakeSupabase } = require('./golden/fake-supabase');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1 }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));

const snap = (employee_id, period_key, out) => ({
  company_id: 7, employee_id, period_key, is_locked: true, status: 'finalized',
  created_at: '2026-10-01T00:00:00Z', calculation_input: { basic_salary: out.gross }, calculation_output: out
});

let server, base;
beforeAll(async () => {
  Object.assign(mockDb, {
    employees: [
      { id: 1, company_id: 7, first_name: 'A', last_name: 'One', id_number: '1', tax_number: '1' },
      { id: 2, company_id: 7, first_name: 'B', last_name: 'Two', id_number: '2', tax_number: '2' }
    ],
    payroll_snapshots: [
      // engine snapshot with uif_employer stored
      snap(1, '2026-04', { gross: 20000, taxableGross: 20000, paye: 2115, uif: 177.12, uif_employer: 177.12, sdl: 200, net: 17707.88 }),
      // older snapshot without uif_employer → employer matches employee
      snap(2, '2026-04', { gross: 10000, taxableGross: 10000, paye: 0, uif: 100, sdl: 100, net: 9900 }),
      // another company — must never be read
      { company_id: 99, employee_id: 1, period_key: '2026-04', is_locked: true, status: 'finalized', created_at: '2026-10-01',
        calculation_output: { gross: 1e6, paye: 1e5, uif: 177.12, uif_employer: 177.12, sdl: 1e4, net: 1 } }
    ],
    payroll_historical: [
      // duplicate of a snapshotted month → ignored
      { company_id: 7, employee_id: 1, period_key: '2026-04', gross: 20000, paye: 2115, uif: 177.12, sdl: 200, net: 17707.88 },
      // month with no snapshot → counted
      { company_id: 7, employee_id: 2, period_key: '2026-03', gross: 10000, paye: 0, uif: 100, sdl: 100, net: 9900 }
    ]
  });
  const app = express();
  app.use('/recon', require('../modules/payroll/routes/recon'));
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

const get = async (path) => (await fetch(base + path)).json();

describe('GET /recon/summary', () => {
  test('period UIF = employee + employer (EMP201), with the split', async () => {
    const d = await get('/recon/summary?taxYear=2026/2027');
    const apr = d.totals['2026-04'];
    expect(apr.uif_employee).toBeCloseTo(277.12, 2);
    expect(apr.uif_employer).toBeCloseTo(277.12, 2);   // 177.12 stored + 100 (fallback = employee)
    expect(apr.uif).toBeCloseTo(554.24, 2);
    expect(apr.total).toBeCloseTo(2115 + 554.24 + 300, 2);
    expect(apr.gross).toBe(30000);                      // other company + duplicate historical excluded
  });
  test('historical month without a snapshot is included, employer UIF = employee', async () => {
    const d = await get('/recon/summary?taxYear=2026/2027');
    expect(d.totals['2026-03'].uif).toBeCloseTo(200, 2);
    expect(d.totals['2026-03'].sdl).toBeCloseTo(100, 2);
  });
  test('annual totals carry the same split', async () => {
    const d = await get('/recon/summary?taxYear=2026/2027');
    expect(d.annualTotals.uif).toBeCloseTo(d.annualTotals.uif_employee + d.annualTotals.uif_employer, 2);
  });
  test('per-employee period UIF stays the employee deduction', async () => {
    const d = await get('/recon/summary?taxYear=2026/2027');
    const e1 = d.employees.find(e => e.employee_id === 1);
    expect(e1.periods['2026-04'].uif).toBeCloseTo(177.12, 2);
    expect(e1.periods['2026-04'].uif_employer).toBeCloseTo(177.12, 2);
  });
});

describe('GET /recon/emp501', () => {
  test('employer UIF comes from the snapshot (fallback = employee), never 0', async () => {
    const d = await get('/recon/emp501?taxYear=2026/2027');
    const byId = Object.fromEntries(d.livePayroll.map(r => [r.employee_id, r]));
    expect(byId[1].uif_employer).toBeCloseTo(177.12, 2);
    expect(byId[2].uif_employer).toBeCloseTo(100, 2);
  });
  test('historical rows for months with a locked snapshot are not counted twice', async () => {
    const d = await get('/recon/emp501?taxYear=2026/2027');
    const h1 = d.historicalImports.find(h => h.employee_id === 1);
    const h2 = d.historicalImports.find(h => h.employee_id === 2);
    expect(h1).toBeUndefined();
    expect(h2.uif_employer).toBeCloseTo(100, 2);
    expect(h2.sdl).toBeCloseTo(100, 2);
  });
});
