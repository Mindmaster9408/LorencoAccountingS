'use strict';

/**
 * Tests — audit 2026-11-18 H2: Supabase returns at most 1000 rows per request; recon,
 * EMP201, EMP501, e@syFile and the annual report must page through instead of silently
 * dropping the rest. The fake database is capped at 4 rows per read (db.__maxRows) to
 * prove every row is still counted.
 */

const express = require('express');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1 }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));

const { fetchAllRows } = require('../modules/payroll/services/fetchAllRows');

const N = 10;   // payslips — more than the 4-row cap
const snap = (i) => ({
  id: 'snap-' + String(i).padStart(3, '0'), company_id: 7, employee_id: i, period_key: '2026-04',
  is_locked: true, status: 'finalized', created_at: '2026-05-01T00:00:00Z',
  calculation_input: { basic_salary: 1000 },
  calculation_output: { gross: 1000, taxableGross: 1000, paye: 100, uif: 10, uif_employer: 10, sdl: 10, net: 890 }
});

beforeEach(() => {
  Object.keys(mockDb).forEach(k => delete mockDb[k]);
  Object.assign(mockDb, {
    __maxRows: 4,
    employees: Array.from({ length: N }, (_, i) => ({ id: i + 1, company_id: 7, first_name: 'E' + (i + 1), last_name: 'X', id_number: '1', tax_number: '1' })),
    payroll_snapshots: Array.from({ length: N }, (_, i) => snap(i + 1)),
    payroll_historical: [], payroll_transactions: [], payroll_items_master: [], payroll_kv_store_eco: []
  });
});

describe('fetchAllRows', () => {
  const supabase = () => require('../config/database').supabase;

  test('a plain read is truncated by the cap (the bug)', async () => {
    const { data } = await supabase().from('payroll_snapshots').select('id').eq('company_id', 7);
    expect(data.length).toBe(4);
  });

  test('fetchAllRows reads every row, each exactly once', async () => {
    const { data, error } = await fetchAllRows(() => supabase().from('payroll_snapshots').select('id').eq('company_id', 7));
    expect(error).toBeNull();
    expect(data.length).toBe(N);
    expect(new Set(data.map(r => r.id)).size).toBe(N);
  });

  test('filters still apply on every page', async () => {
    mockDb.payroll_snapshots.push({ ...snap(99), id: 'other-co', company_id: 99 });
    const { data } = await fetchAllRows(() => supabase().from('payroll_snapshots').select('id').eq('company_id', 7));
    expect(data.some(r => r.id === 'other-co')).toBe(false);
    expect(data.length).toBe(N);
  });

  test('an error on a page is returned, not swallowed', async () => {
    mockDb.__beforeUpdate = {};
    const failing = () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) });
    const r = await fetchAllRows(failing);
    expect(r).toEqual({ data: null, error: { message: 'boom' } });
  });
});

describe('PAYE recon summary counts every payslip', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/recon', require('../modules/payroll/routes/recon'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('10 employees in April with a 4-row cap → all 10 in the EMP201 totals', async () => {
    const r = await fetch(base + '/recon/summary?taxYear=2026/2027');
    const body = await r.json();
    expect(r.status).toBe(200);
    const apr = body.totals['2026-04'];
    expect(apr.employeeCount).toBe(N);
    expect(apr.gross).toBe(N * 1000);
    expect(apr.paye).toBe(N * 100);
    expect(apr.uif).toBe(N * 20);           // employee + employer
  });
});
