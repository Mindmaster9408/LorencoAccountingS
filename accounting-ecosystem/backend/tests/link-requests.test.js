'use strict';

/**
 * LINK — "Link an existing company" (2026-11-12, migration 181). Fictional data.
 *
 *   TEST-LINK-01  Lookup by client code finds the company; a malformed email is refused.
 *   TEST-LINK-02  Request needs at least one app; creates a pending row; emails the company's managers.
 *   TEST-LINK-03  A super admin can NOT answer on the company's behalf (consent).
 *   TEST-LINK-04  Approve with some apps → access_link eco_client with exactly those apps;
 *                 the company's own modules_enabled is untouched.
 *   TEST-LINK-05  Answering twice is refused; declining creates nothing.
 *   TEST-LINK-06  The practice cannot edit details or apps of a linked company (PUT 409),
 *                 but can switch the link off.
 */

const { createFakeSupabase, callRoute } = require('./helpers/fakeSupabase');

const SEED = {
  companies: [
    { id: 1, company_name: 'Lorenco Practice', is_active: true },
    { id: 30, company_name: 'Corner Shop (Pty) Ltd', email: 'info@cornershop.test', is_active: true, modules_enabled: ['payroll', 'pos'] },
  ],
  users: [
    { id: 7, full_name: 'Shop Owner', email: 'owner@cornershop.test', is_active: true },
    { id: 8, full_name: 'Practice Accountant', email: 'acc@practice.test', is_active: true },
    { id: 99, full_name: 'Super', email: 'super@lorenco.test', is_active: true },
  ],
  user_company_access: [
    { user_id: 7, company_id: 30, role: 'business_owner', is_active: true },
    { user_id: 8, company_id: 1, role: 'accountant', is_active: true },
  ],
  eco_clients: [
    { id: 300, company_id: 30, client_company_id: 30, name: 'Corner Shop (Pty) Ltd', client_code: 'CLT-AAAA1111',
      apps: ['payroll', 'pos'], addons: [], is_active: true },
  ],
  company_link_requests: [],
};

const mockFake = createFakeSupabase(SEED);
const mockSendEmail = jest.fn(async () => ({ success: true }));
jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../middleware/audit', () => ({ auditFromReq: jest.fn(async () => {}) }));
jest.mock('../shared/services/email', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const linkRouter = require('../shared/routes/link-requests');
const ecoRouter = require('../shared/routes/eco-clients');

const ACC   = { user: { userId: 8, role: 'accountant', isSuperAdmin: false, email: 'acc@practice.test' }, companyId: 1 };
const OWNER = { user: { userId: 7, role: 'business_owner', isSuperAdmin: false }, companyId: 30 };
const SUPER = { user: { userId: 99, role: 'super_admin', isSuperAdmin: true }, companyId: 1 };
const call = (method, path, who, params = {}, body = {}) => callRoute(linkRouter, method, path, { ...who, params, body });

beforeEach(() => { mockFake.reset(SEED); mockSendEmail.mockClear(); });

async function makeRequest(apps = ['payroll', 'pos']) {
  const r = await call('post', '/', ACC, {}, { target_company_id: 30, apps });
  expect(r.status).toBe(201);
  return r.body.request;
}

test('TEST-LINK-01 lookup by client code; malformed email refused', async () => {
  const ok = await call('post', '/lookup', ACC, {}, { query: 'clt-aaaa1111' });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ company_id: 30, name: 'Corner Shop (Pty) Ltd', already_linked: false });
  const bad = await call('post', '/lookup', ACC, {}, { query: 'x@y.test),id.gt.0' });
  expect(bad.status).toBe(404);
});

test('TEST-LINK-02 request: needs an app, creates pending row, emails the company', async () => {
  expect((await call('post', '/', ACC, {}, { target_company_id: 30, apps: [] })).status).toBe(400);
  const req = await makeRequest();
  expect(req.status).toBe('pending');
  expect(req.requested_apps).toEqual(['payroll', 'pos']);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect(mockSendEmail.mock.calls[0][0].to).toEqual(['owner@cornershop.test']);
  expect((await call('post', '/', ACC, {}, { target_company_id: 30, apps: ['pos'] })).status).toBe(409);
});

test('TEST-LINK-03 super admin cannot answer for the company', async () => {
  const req = await makeRequest();
  const r = await call('post', '/:id/decide', SUPER, { id: String(req.id) }, { approved_apps: ['payroll'] });
  expect(r.status).toBe(403);
  expect(mockFake.rows('eco_clients')).toHaveLength(1);
});

test('TEST-LINK-04 approve some apps → access_link row with exactly those; company untouched', async () => {
  const req = await makeRequest();
  const r = await call('post', '/:id/decide', OWNER, { id: String(req.id) }, { approved_apps: ['payroll', 'accounting'] });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'approved', approved_apps: ['payroll'] }); // 'accounting' was never requested
  const link = mockFake.find('eco_clients', c => c.company_id === 1 && c.client_company_id === 30);
  expect(link).toMatchObject({ access_link: true, apps: ['payroll'], is_active: true });
  expect(mockFake.find('companies', c => c.id === 30).modules_enabled).toEqual(['payroll', 'pos']);
  // requester told
  expect(mockSendEmail.mock.calls.some(c => c[0].to === 'acc@practice.test')).toBe(true);
});

test('TEST-LINK-05 answering twice refused; decline creates nothing', async () => {
  const req = await makeRequest();
  expect((await call('post', '/:id/decide', OWNER, { id: String(req.id) }, { approved_apps: [] })).body.status).toBe('declined');
  expect((await call('post', '/:id/decide', OWNER, { id: String(req.id) }, { approved_apps: ['pos'] })).status).toBe(409);
  expect(mockFake.rows('eco_clients')).toHaveLength(1);
});

test('TEST-LINK-06 linked company is read-only for the practice, but can be switched off', async () => {
  const req = await makeRequest();
  await call('post', '/:id/decide', OWNER, { id: String(req.id) }, { approved_apps: ['payroll'] });
  const link = mockFake.find('eco_clients', c => c.company_id === 1 && c.client_company_id === 30);
  const put = body => callRoute(ecoRouter, 'put', '/:id', { ...ACC, params: { id: String(link.id) }, body });
  const r1 = await put({ apps: ['payroll', 'pos'] });
  expect(r1.status).toBe(409);
  expect(r1.body.code).toBe('LINKED_COMPANY_READ_ONLY');
  expect((await put({ name: 'Renamed' })).status).toBe(409);
  expect((await put({ is_active: false })).status).toBe(200);
  expect(mockFake.find('companies', c => c.id === 30).modules_enabled).toEqual(['payroll', 'pos']);
});
