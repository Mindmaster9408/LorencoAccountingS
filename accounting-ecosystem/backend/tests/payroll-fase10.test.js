'use strict';

/**
 * Tests — Fase 10: security and required fields
 *   - payslip unlock: same-company manager only, no self-approval, 5 failures / 15 min,
 *     same answer for wrong e-mail and wrong password, fail-closed, audited (UF-10, TS-04, B6)
 *   - SA ID / SARS tax number validation (WN-02, WN-03) and duplicate IDs (WN-04)
 *   - auditFromReq keeps context passed at the top level
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { idNumberError, taxNumberError, employeeTaxIssues } = require('../shared/utils/saIdentity');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: Number(req.headers['x-user'] || 1), email: 'clerk@co.za', role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));

// Valid test numbers (Luhn-correct, fictitious)
const ID_OK = '8001015009087';     // 1980-01-01
const TAX_OK = '0123456782';       // starts 0, Luhn ok

describe('saIdentity', () => {
  test('SA ID: 13 digits, real date, check digit; passports accepted', () => {
    expect(idNumberError(ID_OK)).toBeNull();
    expect(idNumberError('8001015009088')).toMatch(/check digit/);
    expect(idNumberError('8013015009083')).toMatch(/date of birth/);
    expect(idNumberError('800101500908')).toMatch(/13 digits/);
    expect(idNumberError('A12345678')).toBeNull();
    expect(idNumberError('')).toMatch(/required/);
  });
  test('SARS tax number: 10 digits, first digit 0/1/2/3/9, check digit', () => {
    expect(taxNumberError(TAX_OK)).toBeNull();
    expect(taxNumberError('0123 456 782')).toBeNull();
    expect(taxNumberError('0123456781')).toMatch(/check digit/);
    expect(taxNumberError('5123456787')).toMatch(/start with/);
    expect(taxNumberError('')).toMatch(/required/);
  });
  test('employeeTaxIssues for run warnings / IRP5 block', () => {
    expect(employeeTaxIssues({ tax_number: TAX_OK, id_number: ID_OK })).toEqual([]);
    expect(employeeTaxIssues({ tax_number: '', tax_number_pending: true, id_number: ID_OK })).toEqual(['not yet registered with SARS']);
    expect(employeeTaxIssues({ tax_number: null, id_number: null })).toEqual(['no SARS tax number', 'no ID or passport number']);
  });
});

describe('payslip unlock (UF-10)', () => {
  let server, base;
  const hash = bcrypt.hashSync('Secret!1', 4);
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/unlock', require('../modules/payroll/routes/unlock'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const reset = (extra) => {
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      payroll_snapshots: [{ id: 11, company_id: 7, employee_id: 5, period_key: '2026-09', is_locked: true, status: 'finalized', payroll_run_id: null }],
      payroll_runs: [],
      users: [
        { id: 1, email: 'clerk@co.za', password_hash: hash, full_name: 'Clerk', is_active: true },
        { id: 2, email: 'boss@co.za', password_hash: hash, full_name: 'Boss', is_active: true },
        { id: 3, email: 'other@co.za', password_hash: hash, full_name: 'Other Co Boss', is_active: true },
        { id: 4, email: 'super@co.za', password_hash: hash, full_name: 'Super', is_active: true, is_super_admin: true }],
      user_company_access: [
        { user_id: 1, company_id: 7, role: 'business_owner', is_active: true },
        { user_id: 2, company_id: 7, role: 'business_owner', is_active: true },
        { user_id: 3, company_id: 99, role: 'business_owner', is_active: true }],
      audit_log: [], payroll_kv_store_eco: []
    }, extra || {});
  };
  const unlock = async (managerEmail, managerPassword, user) => {
    const r = await fetch(base + '/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': String(user || 1) },
      body: JSON.stringify({ empId: 5, period: '2026-09', managerEmail, managerPassword }) });
    return { status: r.status, body: await r.json() };
  };
  const locked = () => mockDb.payroll_snapshots[0].is_locked;

  test('a manager of THIS company unlocks; the attempt is audited in audit_log', async () => {
    reset();
    const r = await unlock('boss@co.za', 'Secret!1');
    expect(r.status).toBe(200);
    expect(locked()).toBe(false);
    expect(mockDb.audit_log.map(a => a.action_type)).toEqual(['PAYSLIP_UNLOCK']);
  });

  test('a manager of ANOTHER company is refused (was accepted)', async () => {
    reset();
    const r = await unlock('other@co.za', 'Secret!1');
    expect(r.status).toBe(401);
    expect(locked()).toBe(true);
  });

  test('a super user may approve', async () => {
    reset();
    expect((await unlock('super@co.za', 'Secret!1')).status).toBe(200);
  });

  test('no self-approval', async () => {
    reset();
    const r = await unlock('clerk@co.za', 'Secret!1', 1);
    expect([r.status, r.body.code]).toEqual([403, 'SELF_APPROVAL']);
    expect(locked()).toBe(true);
  });

  test('wrong e-mail and wrong password give the same answer', async () => {
    reset();
    const a = await unlock('nobody@co.za', 'Secret!1');
    const b = await unlock('boss@co.za', 'wrong');
    expect([a.status, a.body.error]).toEqual([b.status, b.body.error]);
  });

  test('5 failures in 15 minutes → locked out, even with the right password', async () => {
    reset();
    for (let i = 0; i < 5; i++) await unlock('boss@co.za', 'wrong');
    const r = await unlock('boss@co.za', 'Secret!1');
    expect([r.status, r.body.code]).toEqual([429, 'TOO_MANY_ATTEMPTS']);
    expect(locked()).toBe(true);
  });

  test('payslip in a finalized run → must reverse the run', async () => {
    reset({ payroll_snapshots: [{ id: 11, company_id: 7, employee_id: 5, period_key: '2026-09', is_locked: true, status: 'finalized', payroll_run_id: 'r1' }],
            payroll_runs: [{ id: 'r1', company_id: 7, status: 'finalized' }] });
    expect((await unlock('boss@co.za', 'Secret!1')).body.code).toBe('REQUIRES_RUN_REVERSAL');
  });

  test('fail-closed: if failed attempts cannot be recorded, nothing is unlocked', async () => {
    reset();
    delete mockDb.audit_log;
    const real = require('../config/database').supabase;
    const orig = real.from;
    real.from = (t) => t === 'audit_log' ? { select() { return this; }, eq() { return this; }, gte: async () => ({ data: null, error: { message: 'down' } }),
                                            insert: async () => ({ error: { message: 'down' } }) } : orig(t);
    try {
      const r = await unlock('boss@co.za', 'Secret!1');
      expect(r.status).toBe(503);
      expect(locked()).toBe(true);
    } finally { real.from = orig; }
  });
});

describe('employee create / edit (WN-01..04)', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/emp', require('../shared/routes/employees'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const reset = () => {
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      employees: [
        { id: 1, company_id: 7, first_name: 'Old', last_name: 'Record', id_number: '', tax_number: '', is_active: true, tax_number_pending: false },
        { id: 2, company_id: 7, first_name: 'Has', last_name: 'Id', id_number: ID_OK, tax_number: TAX_OK, is_active: true, tax_number_pending: false }],
      audit_log: []
    });
  };

  test('create: tax number required unless "not yet registered"', async () => {
    reset();
    expect((await call('POST', '/emp', { first_name: 'A', last_name: 'B', id_number: 'P1234567' })).status).toBe(400);
    const ok = await call('POST', '/emp', { first_name: 'A', last_name: 'B', id_number: 'P1234567', tax_number_pending: true });
    expect(ok.status).toBe(201);
    expect(mockDb.employees.find(e => e.first_name === 'A').tax_number_pending).toBe(true);
  });

  test('create: invalid numbers refused with the reason', async () => {
    reset();
    const r = await call('POST', '/emp', { first_name: 'A', last_name: 'B', id_number: '8001015009088', tax_number: '0123456781' });
    expect(r.status).toBe(400);
    expect(r.body.problems.join(' ')).toMatch(/SA ID number is not valid.*SARS tax number is not valid/);
  });

  test('create: duplicate ID in the same company refused', async () => {
    reset();
    const r = await call('POST', '/emp', { first_name: 'A', last_name: 'B', id_number: ID_OK, tax_number: TAX_OK });
    expect([r.status, r.body.code]).toEqual([409, 'DUPLICATE_ID']);
  });

  test('edit: an incomplete old record can still be edited when the tax/ID fields do not change', async () => {
    reset();
    const r = await call('PUT', '/emp/1', { first_name: 'Old', last_name: 'Renamed', id_number: '', tax_number: '' });
    expect(r.status).toBe(200);
  });

  test('edit: a changed tax number must be valid; a valid one clears the pending flag', async () => {
    reset();
    mockDb.employees[0].tax_number_pending = true;
    expect((await call('PUT', '/emp/1', { tax_number: '123' })).status).toBe(400);
    expect((await call('PUT', '/emp/1', { tax_number: TAX_OK })).status).toBe(200);
    expect(mockDb.employees[0].tax_number_pending).toBe(false);
  });

  test('edit: changing the ID to another employee\'s ID is refused', async () => {
    reset();
    expect((await call('PUT', '/emp/1', { id_number: ID_OK })).status).toBe(409);
  });
});

describe('auditFromReq keeps top-level context (Fase 10)', () => {
  test('extra keys land in metadata', async () => {
    jest.isolateModules(() => {
      Object.keys(mockDb).forEach(k => delete mockDb[k]);
      mockDb.audit_log = [];
    });
    const { auditFromReq } = jest.requireActual('../middleware/audit');
    await auditFromReq({ companyId: 7, user: { userId: 1 }, headers: {}, path: '/payroll/run' }, 'PAYROLL_RUN', 'payroll_runs', 'r1',
      { period_key: '2026-10', employee_count: 3, metadata: { x: 1 } });
    expect(JSON.parse(mockDb.audit_log[0].metadata)).toEqual({ period_key: '2026-10', employee_count: 3, x: 1 });
  });
});
