'use strict';

/**
 * Tests — spec 04 IT-02 / IT-13: calculation items are linked to the Payroll Items screen
 * by ID (migration 033), else by name + side; a rename keeps the link and the settings.
 */

const express = require('express');
const ItemLink = require('../modules/payroll/services/itemLink');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => { req.companyId = 7; req.user = { userId: 1, role: 'admin' }; next(); },
  requireCompany:    (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next()
}));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));
jest.mock('../sean/irp5-learning', () => ({ recordLearningEvent: async () => {} }));

const MASTERS = [
  { id: 37, company_id: 7, item_name: 'Savings', item_type: 'earning', is_taxable: true, affects_uif: true },
  { id: 38, company_id: 7, item_name: 'Savings', item_type: 'deduction', is_taxable: false, affects_uif: false, tax_treatment: 'pre_tax' },
  { id: 40, company_id: 7, item_name: 'Provident Fund', item_type: 'deduction' }
];

describe('pickMaster', () => {
  test('fixed link wins, even after a rename', () => {
    expect(ItemLink.pickMaster(MASTERS, { master_item_id: 40, name: 'Old name', type: 'deduction' }).id).toBe(40);
  });
  test('same name on two sides: the deduction gets the deduction row', () => {
    expect(ItemLink.pickMaster(MASTERS, { name: 'savings', type: 'deduction' }).id).toBe(38);
    expect(ItemLink.pickMaster(MASTERS, { name: 'Savings', type: 'income' }).id).toBe(37);
  });
  test('old behaviour kept: unique name on another side still matches; unknown → null', () => {
    expect(ItemLink.pickMaster(MASTERS, { name: 'Provident Fund', type: 'earning' }).id).toBe(40);
    expect(ItemLink.pickMaster(MASTERS, { name: 'Nope', type: 'earning' })).toBeNull();
  });
});

describe('routes', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/items', require('../modules/payroll/routes/items'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  beforeEach(() => {
    Object.assign(mockDb, {
      payroll_items_master: MASTERS.map(m => Object.assign({}, m)),
      payroll_items: [
        { id: 5, company_id: 7, name: 'Savings', item_type: 'deduction', master_item_id: null, affects_uif: true },
        { id: 6, company_id: 7, name: 'Savings', item_type: 'earning', master_item_id: null, affects_uif: true },
        { id: 9, company_id: 99, name: 'Savings', item_type: 'deduction', master_item_id: null }
      ],
      employee_payroll_items: []
    });
  });

  test('rename on the screen renames the calculation row of that side and links it', async () => {
    const r = await call('PUT', '/items/38', { item_name: 'Staff Savings', affects_uif: false });
    expect(r.status).toBe(200);
    const row5 = mockDb.payroll_items.find(x => x.id === 5);
    expect(row5).toMatchObject({ name: 'Staff Savings', master_item_id: 38, affects_uif: false });
    expect(mockDb.payroll_items.find(x => x.id === 6).name).toBe('Savings');         // earning untouched
    expect(mockDb.payroll_items.find(x => x.id === 9).name).toBe('Savings');         // other company untouched
  });

  test('assigning the deduction "Savings" uses the deduction rows, not the earning', async () => {
    const r = await call('POST', '/items/employee', { employee_id: 11, description: 'Savings', item_type: 'deduction', amount: 450 });
    expect(r.status).toBe(201);
    expect(r.body.item.payroll_item_id).toBe(5);
    const row5 = mockDb.payroll_items.find(x => x.id === 5);
    expect(row5).toMatchObject({ master_item_id: 38, affects_uif: false });
  });
});
