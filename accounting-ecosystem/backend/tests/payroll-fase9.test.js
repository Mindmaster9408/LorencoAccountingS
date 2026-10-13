'use strict';

/**
 * Tests — Fase 9 (one engine; spec 11 Net-to-Gross, spec 08/10 payslips from snapshots)
 */

const express = require('express');
const { loadTaxTableSeedRows } = require('./helpers/taxTableSeed');

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

describe('Net-to-Gross on the backend (NG-01, NG-02)', () => {
  let server, base;
  beforeAll(async () => {
    Object.assign(mockDb, { payroll_tax_tables: loadTaxTableSeedRows(), payroll_kv_store_eco: [] });
    const app = express();
    app.use(express.json());
    app.use('/calc', require('../modules/payroll/routes/calculate'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const n2g = async (body) => {
    const r = await fetch(base + '/calc/net-to-gross', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  test('recurring allowance (default): R20 000 net → basic R20 051.51 on the 2027 tables', async () => {
    const r = await n2g({ target_net: 20000, period_key: '2026-10', items: [{ description: 'Travel', type: 'taxable', amount: 3000 }] });
    expect(r.status).toBe(200);
    expect(r.body.basic).toBeCloseTo(20051.51, 1);
    expect(r.body.net).toBeCloseTo(20000, 1);
    expect(r.body.tax_year).toBe('2026/2027');
    expect(r.body.payslip_lines.find(l => l.description === 'Travel').kind).toBe('regular');
  });

  test('once-off allowance is taxed as once-off (lower basic) — only when asked (B12)', async () => {
    const r = await n2g({ target_net: 20000, period_key: '2026-10', items: [{ description: 'Bonus', type: 'taxable', amount: 3000, once_off: true }] });
    expect(r.body.basic).toBeLessThan(20051.51 - 100);
    expect(r.body.payslip_lines.find(l => l.description === 'Bonus').kind).toBe('current');
  });

  test('uses the period\'s own tax year (2024/2025 gives a different basic)', async () => {
    const a = await n2g({ target_net: 25000, period_key: '2026-10' });
    const b = await n2g({ target_net: 25000, period_key: '2024-10' });
    expect(b.body.tax_year).toBe('2024/2025');
    expect(b.body.basic).toBeGreaterThan(a.body.basic);   // 2027 brackets are wider → less tax
  });

  test('missing tax year → 422, bad target → 400', async () => {
    expect((await n2g({ target_net: 20000, period_key: '2030-10' })).status).toBe(422);
    expect((await n2g({ target_net: 0 })).status).toBe(400);
  });
});
