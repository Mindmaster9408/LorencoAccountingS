'use strict';

/**
 * SEC-SESSION — access changes take effect immediately (Ruan's rule, 2026-10-01)
 *
 * Exercises the REAL middleware/auth.js authenticateToken + middleware/module-check.js
 * requireModule against an in-memory database.
 *
 *   TEST-SEC-S01  Valid token + unchanged membership passes and exposes req.companyAccess.
 *   TEST-SEC-S02  Role changed in the DB → old token is refused with SESSION_ROLE_CHANGED.
 *   TEST-SEC-S03  Removed from the company → refused on the very next request once
 *                 invalidateUserSessions() ran (no 60 s cache wait).
 *   TEST-SEC-S04  Super admin token is unaffected by membership role checks.
 *   TEST-SEC-S05  apps_access is enforced per request by requireModule.
 *   TEST-SEC-S06  'sean' is exempt from apps_access (infrastructure used by every app).
 *   TEST-SEC-S07  apps_access null = unrestricted.
 */

process.env.JWT_SECRET = 'session-test-secret-that-is-long-enough-12345';

const jwt = require('jsonwebtoken');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const SEED = {
  users: [
    { id: 1, is_active: true },
    { id: 2, is_active: true },
    { id: 9, is_active: true },
  ],
  companies: [{ id: 10, is_active: true, modules_enabled: ['pos', 'payroll', 'sean'] }],
  user_company_access: [
    { id: 1, user_id: 1, company_id: 10, role: 'business_owner', apps_access: null, is_active: true },
    { id: 2, user_id: 2, company_id: 10, role: 'cashier', apps_access: ['payroll'], is_active: true },
  ],
  user_app_access: [],
};

const mockFake = createFakeSupabase(SEED);
jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../config/modules', () => ({
  isModuleEnabled: () => true,
  companyHasModule: async () => true,
  modules: {},
}));

const { authenticateToken, invalidateUserSessions } = require('../middleware/auth');
const { requireModule } = require('../middleware/module-check');

const tokenFor = payload => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

function run(middleware, token) {
  return new Promise(resolve => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      statusCode: 200,
      status(s) { this.statusCode = s; return this; },
      json(body) { resolve({ passed: false, status: this.statusCode, body, req }); },
    };
    middleware(req, res, () => resolve({ passed: true, req }));
  });
}

// authenticateToken then requireModule, like server.js mounts them
async function runApp(moduleKey, token) {
  const first = await run(authenticateToken, token);
  if (!first.passed) return first;
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(s) { this.statusCode = s; return this; },
      json(body) { resolve({ passed: false, status: this.statusCode, body }); },
    };
    requireModule(moduleKey)(first.req, res, () => resolve({ passed: true }));
  });
}

const owner   = tokenFor({ userId: 1, companyId: 10, role: 'business_owner', isSuperAdmin: false });
const cashier = tokenFor({ userId: 2, companyId: 10, role: 'cashier', isSuperAdmin: false });
const superA  = tokenFor({ userId: 9, companyId: 10, role: 'super_admin', isSuperAdmin: true });

beforeEach(() => {
  mockFake.reset(SEED);
  [1, 2, 9].forEach(invalidateUserSessions); // clean cache between tests
});

test('TEST-SEC-S01 unchanged membership passes', async () => {
  const r = await run(authenticateToken, owner);
  expect(r.passed).toBe(true);
  expect(r.req.companyAccess).toEqual({ role: 'business_owner', apps_access: null });
});

test('TEST-SEC-S02 role changed in DB → old token refused', async () => {
  expect((await run(authenticateToken, owner)).passed).toBe(true); // warms the cache
  mockFake.find('user_company_access', a => a.user_id === 1).role = 'cashier';
  invalidateUserSessions(1);
  const r = await run(authenticateToken, owner);
  expect(r.passed).toBe(false);
  expect(r.status).toBe(401);
  expect(r.body.code).toBe('SESSION_ROLE_CHANGED');
  // A fresh token carrying the new role works.
  const fresh = tokenFor({ userId: 1, companyId: 10, role: 'cashier', isSuperAdmin: false });
  expect((await run(authenticateToken, fresh)).passed).toBe(true);
});

test('TEST-SEC-S03 removal is immediate after invalidation', async () => {
  expect((await run(authenticateToken, cashier)).passed).toBe(true); // cached OK
  mockFake.find('user_company_access', a => a.user_id === 2).is_active = false;
  invalidateUserSessions(2);
  const r = await run(authenticateToken, cashier);
  expect(r.passed).toBe(false);
  expect(r.status).toBe(403);
});

test('TEST-SEC-S04 super admin unaffected', async () => {
  const r = await run(authenticateToken, superA);
  expect(r.passed).toBe(true);
});

test('TEST-SEC-S05 apps_access enforced per request', async () => {
  expect((await runApp('payroll', cashier)).passed).toBe(true);
  const pos = await runApp('pos', cashier);
  expect(pos.passed).toBe(false);
  expect(pos.status).toBe(403);
});

test('TEST-SEC-S06 sean exempt from apps_access', async () => {
  expect((await runApp('sean', cashier)).passed).toBe(true);
});

test('TEST-SEC-S07 apps_access null = unrestricted', async () => {
  expect((await runApp('pos', owner)).passed).toBe(true);
});
