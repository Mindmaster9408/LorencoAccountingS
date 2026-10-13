'use strict';

/** Fase 11: hidden payroll items in SQL (payroll_hidden_items), company-scoped, audited. */

const express = require('express');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1, role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../sean/irp5-learning', () => ({ recordLearningEvent: async () => {} }));

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/items', require('../modules/payroll/routes/items'));
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));
const call = async (method, body) => {
  const r = await fetch(base + '/items/hidden', { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('replace the list; only this company is touched', async () => {
  Object.assign(mockDb, { payroll_hidden_items: [
    { company_id: 7, item_name: 'Old' }, { company_id: 99, item_name: 'Other company' }] });
  const r = await call('PUT', { names: ['Commission', 'Commission', ' Tips '] });
  expect(r.body.names).toEqual(['Commission', 'Tips']);
  expect((await call('GET')).body.names.sort()).toEqual(['Commission', 'Tips']);
  expect(mockDb.payroll_hidden_items.find(x => x.company_id === 99)).toBeTruthy();
});
