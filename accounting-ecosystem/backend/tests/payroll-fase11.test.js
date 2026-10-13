'use strict';

/**
 * Tests — Fase 11: employee notes in the database (were browser/KV), company-scoped,
 * confidential employees hidden, delete audited (CLAUDE.md Part D, spec 13 TS-05, WN-14).
 */

const express = require('express');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1, role: req.headers['x-role'] || 'business_owner' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
const mockAudit = [];
jest.mock('../middleware/audit', () => ({ auditFromReq: async (req, action, entity, id) => { mockAudit.push({ action, entity, id }); } }));
jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  requirePaytimeModule: () => (req, res, next) => next(),
  getEmployeeFilter: async () => ({ type: 'none' }),
  applyFilter: (q) => q,
  // a 'clerk' may not see confidential employees
  canViewEmployee: async (role, userId, companyId, emp) => role !== 'clerk' || emp.classification === 'public'
}));

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/emp', require('../modules/payroll/routes/employees'));
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  Object.keys(mockDb).forEach(k => delete mockDb[k]);
  mockAudit.length = 0;
  Object.assign(mockDb, {
    employees: [
      { id: 1, company_id: 7, classification: 'public' },
      { id: 2, company_id: 7, classification: 'confidential' },
      { id: 9, company_id: 99, classification: 'public' }],
    employee_notes: [], users: [{ id: 1, full_name: 'Ruan', email: 'r@x' }]
  });
});
const call = async (method, path, body, role) => {
  const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, role ? { 'x-role': role } : {}),
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('add, list (with author) and delete a note — in the database, audited', async () => {
  expect((await call('POST', '/emp/1/notes', { notes: [{ content: 'Asked for payslip copy' }] })).status).toBe(201);
  const list = await call('GET', '/emp/1/notes');
  expect(list.body.data).toEqual([expect.objectContaining({ content: 'Asked for payslip copy', author: 'Ruan' })]);
  const id = list.body.data[0].id;
  expect((await call('DELETE', '/emp/1/notes/' + id)).status).toBe(200);
  expect(mockDb.employee_notes).toEqual([]);
  expect(mockAudit.map(a => a.action)).toEqual(['CREATE', 'DELETE']);
});

test('another company\'s employee → 404, nothing written', async () => {
  expect((await call('POST', '/emp/9/notes', { notes: 'x' })).status).toBe(404);
  expect(mockDb.employee_notes).toEqual([]);
});

test('confidential employee is invisible to a restricted user', async () => {
  mockDb.employee_notes.push({ id: 5, company_id: 7, employee_id: 2, content: 'private', created_by: 1 });
  expect((await call('GET', '/emp/2/notes', null, 'clerk')).status).toBe(404);
  expect((await call('DELETE', '/emp/2/notes/5', null, 'clerk')).status).toBe(404);
  expect(mockDb.employee_notes).toHaveLength(1);
});

test('empty note refused; a note of another employee cannot be deleted through this one', async () => {
  expect((await call('POST', '/emp/1/notes', { notes: [{ content: '   ' }] })).status).toBe(400);
  mockDb.employee_notes.push({ id: 6, company_id: 7, employee_id: 2, content: 'other', created_by: 1 });
  expect((await call('DELETE', '/emp/1/notes/6')).status).toBe(404);
});
