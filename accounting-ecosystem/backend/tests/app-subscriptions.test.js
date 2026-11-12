'use strict';

/**
 * APP-SUB — clients request apps, Lorenco approves (2026-11-11, migration 179)
 *
 * Root cause: any manager of a client could tick an app in ECO Hub "+ Add"
 * (PUT /api/eco-clients/:id) and it went live immediately — Lorenco was never
 * told, so pricing was never discussed and the app was never invoiced. A
 * self-registered business owner manages its own self-referencing eco_client,
 * so it could switch on any app for itself.
 *
 *   TEST-APP-01  nextBillingDate: strictly after today, short months clamp.
 *   TEST-APP-02  Non-admin PUT adding an app is refused (code APP_CHANGE_REQUIRES_REQUEST).
 *   TEST-APP-03  Non-admin PUT sending the SAME apps (any order) + other edits still works.
 *   TEST-APP-04  Non-admin cannot change addons or billing fields.
 *   TEST-APP-05  Super admin still switches apps on directly (Rule F1).
 *   TEST-APP-06  Non-admin creating a client: ticked apps → requests, nothing switched on.
 *   TEST-APP-07  Request needs accepted terms; creates pending row; emails Ruan + Anton.
 *   TEST-APP-08  Duplicate open request is refused.
 *   TEST-APP-09  Firmflow cannot be requested by a non-practice.
 *   TEST-APP-10  Another practice cannot see or request for my client.
 *   TEST-APP-11  Approve switches the app on, sets billing day, emails the requester.
 *   TEST-APP-12  Approve twice → second is refused; decline stores the reason.
 *   TEST-APP-13  Cancel is scheduled for the next billing date; app stays on.
 *   TEST-APP-14  Runner switches off only on/after the effective date; data rows untouched.
 *   TEST-APP-15  Undo before the date keeps the app; the runner then leaves it alone.
 *   TEST-APP-16  Non-admin cannot reach the Lorenco queue / approve.
 */

const { createFakeSupabase, callRoute } = require('./helpers/fakeSupabase');

const SEED = {
  companies: [
    { id: 1, company_name: 'The Infinite Legacy', is_active: true },
    { id: 10, company_name: 'Self Co', account_holder_type: 'business_owner', is_active: true, modules_enabled: [] },
    { id: 20, company_name: 'Other Practice', account_holder_type: 'accounting_practice', is_active: true },
  ],
  users: [
    { id: 1, full_name: 'Owner Self', email: 'owner@self.test' },
    { id: 2, full_name: 'Other Owner', email: 'other@practice.test' },
    { id: 99, full_name: 'Ruan', email: 'ruan@lorenco.test' },
  ],
  user_company_access: [
    { user_id: 1, company_id: 10, role: 'business_owner', is_active: true },
    { user_id: 2, company_id: 20, role: 'business_owner', is_active: true },
  ],
  eco_clients: [
    // self-registered business: manages its own self-referencing row
    { id: 100, company_id: 10, client_company_id: 10, name: 'Self Co', client_type: 'business',
      apps: ['payroll'], addons: [], is_active: true, billing_day: 15, created_at: '2026-10-01T08:00:00Z' },
  ],
  app_subscription_requests: [],
  employees: [{ id: 5000, company_id: 10, full_name: 'Real Employee' }],
};

const mockFake = createFakeSupabase(SEED);
const mockSendEmail = jest.fn(async () => ({ success: true }));

jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../middleware/audit', () => ({ auditFromReq: jest.fn(async () => {}) }));
jest.mock('../shared/services/email', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const ecoRouter = require('../shared/routes/eco-clients');
const subRouter = require('../shared/routes/app-subscriptions');
const svc = require('../shared/services/appSubscriptions');

const OWNER  = { user: { userId: 1, role: 'business_owner', isSuperAdmin: false, email: 'owner@self.test' }, companyId: 10 };
const OTHER  = { user: { userId: 2, role: 'business_owner', isSuperAdmin: false }, companyId: 20 };
const SUPER  = { user: { userId: 99, role: 'super_admin', isSuperAdmin: true }, companyId: 1 };

const client = id => mockFake.find('eco_clients', c => c.id === id);
const requests = () => mockFake.rows('app_subscription_requests');
const put = (who, body) => callRoute(ecoRouter, 'put', '/:id', { ...who, params: { id: '100' }, body });
const sub = (method, path, who, params = {}, body = {}) => callRoute(subRouter, method, path, { ...who, params, body });

beforeEach(() => { mockFake.reset(SEED); mockSendEmail.mockClear(); });

test('TEST-APP-01 nextBillingDate', () => {
  expect(svc.nextBillingDate(15, '2026-11-11')).toBe('2026-11-15');
  expect(svc.nextBillingDate(15, '2026-11-15')).toBe('2026-12-15'); // today counts as billed
  expect(svc.nextBillingDate(15, '2026-12-20')).toBe('2027-01-15');
  expect(svc.nextBillingDate(31, '2027-02-10')).toBe('2027-02-28'); // short month clamps
  expect(svc.nextBillingDate(31, '2027-02-28')).toBe('2027-03-31');
  expect(svc.addDays('2027-03-01', -1)).toBe('2027-02-28');
});

test('TEST-APP-02 non-admin cannot switch an app on via PUT', async () => {
  const r = await put(OWNER, { apps: ['payroll', 'accounting'] });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('APP_CHANGE_REQUIRES_REQUEST');
  expect(client(100).apps).toEqual(['payroll']);
});

test('TEST-APP-03 non-admin may resend the same apps with other edits', async () => {
  mockFake.find('eco_clients', c => c.id === 100).apps = ['payroll', 'pos'];
  const r = await put(OWNER, { apps: ['pos', 'payroll'], notes: 'hi' });
  expect(r.status).toBe(200);
  expect(client(100).notes).toBe('hi');
});

test('TEST-APP-04 non-admin cannot change addons or billing fields', async () => {
  expect((await put(OWNER, { addons: ['sean'] })).status).toBe(403);
  expect((await put(OWNER, { last_billed_date: '2026-11-01T00:00:00Z' })).status).toBe(403);
  expect((await put(OWNER, { billing_day: 3 })).status).toBe(403);
  expect(client(100).billing_day).toBe(15);
});

test('TEST-APP-05 super admin still switches apps on directly', async () => {
  const r = await put(SUPER, { apps: ['payroll', 'accounting'] });
  expect(r.status).toBe(200);
  expect(client(100).apps).toEqual(['payroll', 'accounting']);
  expect(mockFake.find('companies', c => c.id === 10).modules_enabled).toContain('accounting');
});

test('TEST-APP-06 non-admin new client: apps become requests, nothing on', async () => {
  const r = await callRoute(ecoRouter, 'post', '/', { ...OWNER, body: { name: 'Sub Client', company_id: 10, apps: ['pos', 'accounting'] } });
  expect(r.status).toBe(201);
  const created = mockFake.find('eco_clients', c => c.name === 'Sub Client');
  expect(created.apps).toEqual([]);
  expect(mockFake.find('companies', c => c.id === created.client_company_id).modules_enabled).toEqual([]);
  const reqs = requests().filter(q => q.eco_client_id === created.id);
  expect(reqs.map(q => q.app_key).sort()).toEqual(['accounting', 'pos']);
  expect(reqs.every(q => q.status === 'pending' && q.kind === 'add')).toBe(true);
  expect(r.body.app_requests).toHaveLength(2);
});

test('TEST-APP-07 request needs terms, creates pending row, emails Ruan + Anton', async () => {
  const noTerms = await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'accounting' });
  expect(noTerms.status).toBe(400);
  expect(requests()).toHaveLength(0);

  const r = await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'accounting', accepted_terms: true });
  expect(r.status).toBe(201);
  expect(requests()[0]).toMatchObject({ app_key: 'accounting', kind: 'add', status: 'pending', requested_by: 1, requested_by_email: 'owner@self.test' });
  expect(client(100).apps).toEqual(['payroll']); // NOT switched on
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect(mockSendEmail.mock.calls[0][0].to).toEqual(['ruanvlog@lorenco.co.za', 'antonjvr@lorenco.co.za']);
});

test('TEST-APP-08 duplicate open request refused', async () => {
  await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'pos', accepted_terms: true });
  const again = await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'pos', accepted_terms: true });
  expect(again.status).toBe(409);
  expect(requests()).toHaveLength(1);
});

test('TEST-APP-09 Firmflow cannot be requested by a non-practice', async () => {
  const r = await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'practice', accepted_terms: true });
  expect(r.status).toBe(403);
});

test('TEST-APP-10 another practice cannot see or request for my client', async () => {
  expect((await sub('get', '/client/:clientId', OTHER, { clientId: '100' })).status).toBe(403);
  expect((await sub('post', '/client/:clientId/request', OTHER, { clientId: '100' }, { app_key: 'pos', accepted_terms: true })).status).toBe(403);
});

test('TEST-APP-11 approve switches the app on and emails the requester', async () => {
  mockFake.find('eco_clients', c => c.id === 100).billing_day = null;
  await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'accounting', accepted_terms: true });
  mockSendEmail.mockClear();
  const id = requests()[0].id;
  const r = await sub('post', '/requests/:reqId/approve', SUPER, { reqId: String(id) }, { billing_day: 7 });
  expect(r.status).toBe(200);
  expect(client(100).apps).toEqual(['payroll', 'accounting']);
  expect(client(100).billing_day).toBe(7);
  expect(mockFake.find('companies', c => c.id === 10).modules_enabled).toContain('accounting');
  expect(requests()[0].status).toBe('approved');
  expect(mockSendEmail.mock.calls[0][0].to).toBe('owner@self.test');
});

test('TEST-APP-12 approve twice refused; decline stores reason', async () => {
  await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'pos', accepted_terms: true });
  const id = requests()[0].id;
  expect((await sub('post', '/requests/:reqId/approve', SUPER, { reqId: String(id) })).status).toBe(200);
  expect((await sub('post', '/requests/:reqId/approve', SUPER, { reqId: String(id) })).status).toBe(409);

  await sub('post', '/client/:clientId/request', OWNER, { clientId: '100' }, { app_key: 'accounting', accepted_terms: true });
  const id2 = requests().find(q => q.app_key === 'accounting').id;
  const d = await sub('post', '/requests/:reqId/decline', SUPER, { reqId: String(id2) }, { reason: 'Not available yet' });
  expect(d.status).toBe(200);
  expect(requests().find(q => q.id === id2)).toMatchObject({ status: 'declined', decision_note: 'Not available yet' });
  expect(client(100).apps).not.toContain('accounting');
});

test('TEST-APP-13 cancel scheduled for next billing date; app stays on', async () => {
  const r = await sub('post', '/client/:clientId/cancel', OWNER, { clientId: '100' }, { app_key: 'payroll' });
  expect(r.status).toBe(201);
  const row = requests()[0];
  expect(row).toMatchObject({ kind: 'cancel', status: 'scheduled' });
  expect(row.effective_date).toBe(svc.nextBillingDate(15, svc.todaySA()));
  expect(client(100).apps).toEqual(['payroll']);
  expect(mockSendEmail.mock.calls[0][0].subject).toMatch(/Cancellation/);
});

test('TEST-APP-14 runner switches off only on/after the date; data untouched', async () => {
  await sub('post', '/client/:clientId/cancel', OWNER, { clientId: '100' }, { app_key: 'payroll' });
  const eff = requests()[0].effective_date;

  const before = await svc.runDueCancellations({ today: svc.addDays(eff, -1) });
  expect(before.applied).toBe(0);
  expect(client(100).apps).toEqual(['payroll']);

  const on = await svc.runDueCancellations({ today: eff });
  expect(on.applied).toBe(1);
  expect(client(100).apps).toEqual([]);
  expect(requests()[0].status).toBe('applied');
  expect(mockFake.find('employees', e => e.id === 5000)).toBeDefined(); // nothing deleted
  expect(mockFake.find('companies', c => c.id === 10).modules_enabled || []).not.toContain('payroll');
});

test('TEST-APP-15 undo keeps the app; runner leaves it alone', async () => {
  await sub('post', '/client/:clientId/cancel', OWNER, { clientId: '100' }, { app_key: 'payroll' });
  const row = requests()[0];
  const u = await sub('post', '/client/:clientId/requests/:reqId/withdraw', OWNER, { clientId: '100', reqId: String(row.id) });
  expect(u.status).toBe(200);
  expect(requests()[0].status).toBe('undone');
  await svc.runDueCancellations({ today: row.effective_date });
  expect(client(100).apps).toEqual(['payroll']);
});

test('TEST-APP-16 non-admin cannot reach the Lorenco side', async () => {
  // requireLorenco is route middleware; callRoute skips it, so check it directly.
  const layer = subRouter.stack.find(l => l.route && l.route.path === '/queue');
  let status = 200;
  const res = { status(s) { status = s; return res; }, json() { return res; } };
  layer.route.stack[0].handle({ ...OWNER }, res, () => {});
  expect(status).toBe(403);
  const ok = jest.fn();
  layer.route.stack[0].handle({ ...SUPER }, res, ok);
  expect(ok).toHaveBeenCalled();
});
