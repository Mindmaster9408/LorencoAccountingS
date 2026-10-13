'use strict';

/**
 * SEC-ECO — eco_clients tenant guards (2026-10-01)
 *
 * Root cause: an eco_client row is a trust link — select-company / sso-launch
 * give the managing practice's staff access to eco_clients.client_company_id.
 * POST /api/eco-clients accepted client_company_id and company_id from the body
 * unchecked, so any self-registered user could link ANY company to their own
 * "practice" and then switch into it as owner. PUT/DELETE /:id had no ownership
 * check at all.
 *
 *   TEST-SEC-E01  Non-admin cannot link an existing company (client_company_id).
 *   TEST-SEC-E02  A cashier cannot create clients.
 *   TEST-SEC-E03  Cannot create a client under a practice you don't manage.
 *   TEST-SEC-E04  Owner can still create a client under their own practice (new company created).
 *   TEST-SEC-E05  Non-admin cannot create a client with Firmflow pre-activated.
 *   TEST-SEC-E06  Cannot edit another practice's client.
 *   TEST-SEC-E07  Can still edit own client.
 *   TEST-SEC-E08  Cannot deactivate another practice's client.
 *   TEST-SEC-E09  Can still deactivate own client.
 *   TEST-SEC-E10  Cannot list another practice's firm-access links.
 *   TEST-SEC-E11  Super admin can still link an existing company.
 */

const { createFakeSupabase, callRoute } = require('./helpers/fakeSupabase');

const SEED = {
  companies: [
    { id: 10, company_name: 'Practice A', is_active: true },
    { id: 20, company_name: 'Practice B', is_active: true },
    { id: 50, company_name: 'Victim Co', is_active: true },
  ],
  user_company_access: [
    { user_id: 1, company_id: 10, role: 'business_owner', is_active: true },
    { user_id: 2, company_id: 10, role: 'cashier', is_active: true },
  ],
  eco_clients: [
    { id: 100, company_id: 10, client_company_id: 60, name: 'A Client', apps: [], is_active: true },
    { id: 200, company_id: 20, client_company_id: 70, name: 'B Client', apps: [], is_active: true },
  ],
  eco_client_firm_access: [],
};

const mockFake = createFakeSupabase(SEED);

jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../middleware/audit', () => ({ auditFromReq: jest.fn(async () => {}) }));

const router = require('../shared/routes/eco-clients');

const OWNER_A   = { user: { userId: 1, role: 'business_owner', isSuperAdmin: false }, companyId: 10 };
const CASHIER_A = { user: { userId: 2, role: 'cashier', isSuperAdmin: false }, companyId: 10 };
const SUPER     = { user: { userId: 99, role: 'super_admin', isSuperAdmin: true }, companyId: 10 };

const client = id => mockFake.find('eco_clients', c => c.id === id);
const create = (who, body) => callRoute(router, 'post', '/', { ...who, body });

beforeEach(() => mockFake.reset(SEED));

test('TEST-SEC-E01 non-admin cannot link an existing company', async () => {
  const r = await create(OWNER_A, { name: 'Grab', client_company_id: 50 });
  expect(r.status).toBe(403);
  expect(mockFake.find('eco_clients', c => c.client_company_id === 50)).toBeUndefined();
});

test('TEST-SEC-E02 cashier cannot create clients', async () => {
  const r = await create(CASHIER_A, { name: 'New' });
  expect(r.status).toBe(403);
});

test('TEST-SEC-E03 cannot create under a practice you do not manage', async () => {
  const r = await create(OWNER_A, { name: 'Planted', company_id: 20 });
  expect(r.status).toBe(403);
  expect(mockFake.find('eco_clients', c => c.name === 'Planted')).toBeUndefined();
});

test('TEST-SEC-E04 owner can still create a client (fresh company)', async () => {
  const r = await create(OWNER_A, { name: 'Legit Client', company_id: 10, apps: ['payroll'] });
  expect(r.status).toBe(201);
  const created = mockFake.find('eco_clients', c => c.name === 'Legit Client');
  expect(created.company_id).toBe(10);
  expect([10, 20, 50, 60, 70]).not.toContain(created.client_company_id);
});

test('TEST-SEC-E05 non-admin cannot pre-activate Firmflow', async () => {
  const r = await create(OWNER_A, { name: 'FF', apps: ['practice'] });
  expect(r.status).toBe(403);
});

test('TEST-SEC-E06 cannot edit another practice client', async () => {
  const r = await callRoute(router, 'put', '/:id', { ...OWNER_A, params: { id: '200' }, body: { name: 'Hijacked', is_active: false } });
  expect(r.status).toBe(403);
  expect(client(200)).toMatchObject({ name: 'B Client', is_active: true });
});

test('TEST-SEC-E07 can still edit own client', async () => {
  const r = await callRoute(router, 'put', '/:id', { ...OWNER_A, params: { id: '100' }, body: { notes: 'hello' } });
  expect(r.status).toBe(200);
  expect(client(100).notes).toBe('hello');
});

test('TEST-SEC-E08 cannot deactivate another practice client', async () => {
  const r = await callRoute(router, 'delete', '/:id', { ...OWNER_A, params: { id: '200' } });
  expect(r.status).toBe(403);
  expect(client(200).is_active).toBe(true);
});

test('TEST-SEC-E09 can still deactivate own client', async () => {
  const r = await callRoute(router, 'delete', '/:id', { ...OWNER_A, params: { id: '100' } });
  expect(r.status).toBe(200);
  expect(client(100).is_active).toBe(false);
});

test('TEST-SEC-E10 cannot list another practice firm-access links', async () => {
  const r = await callRoute(router, 'get', '/:id/firm-access', { ...OWNER_A, params: { id: '200' } });
  expect(r.status).toBe(403);
});

test('TEST-SEC-E11 super admin can still link an existing company', async () => {
  const r = await create(SUPER, { name: 'Adopted', company_id: 10, client_company_id: 50 });
  expect(r.status).toBe(201);
  expect(mockFake.find('eco_clients', c => c.name === 'Adopted').client_company_id).toBe(50);
});
