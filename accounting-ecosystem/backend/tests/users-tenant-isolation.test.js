'use strict';

/**
 * SEC-USERS — tenant isolation on PUT/DELETE /api/users/:id
 *
 * Root cause fixed (2026-10-01): the write routes on /api/users/:id never checked
 * that the target user belonged to the caller's company. Any business_owner
 * (and anyone can self-register as one) could rename, re-email, deactivate or
 * strip all company access from any user on the platform by numeric id.
 *
 *   TEST-SEC-U01  Cross-tenant edit is refused and changes nothing.
 *   TEST-SEC-U02  Cross-tenant delete is refused and changes nothing.
 *   TEST-SEC-U03  Own single-company user: edit + delete behave as before.
 *   TEST-SEC-U04  Multi-company user: resending unchanged fields (null vs '') + role/app change is allowed.
 *   TEST-SEC-U05  Multi-company user: changing email / name / is_active is refused.
 *   TEST-SEC-U06  Multi-company user: delete only removes them from the caller's company.
 *   TEST-SEC-U07  company_ids (move between arbitrary companies) is super-admin only.
 *   TEST-SEC-U08  Super admin can still edit any user.
 *   TEST-SEC-U09  revoke_company_access still works for an own member.
 */

const { createFakeSupabase, callRoute } = require('./helpers/fakeSupabase');

const SEED = {
  users: [
    { id: 1, username: 'owner_a', email: 'a@x.co', full_name: 'Owner A', is_active: true },
    { id: 2, username: 'cashier_a', email: 'ca@x.co', full_name: 'Cashier A', is_active: true },
    { id: 3, username: 'victim_b', email: 'b@x.co', full_name: 'Victim B', is_active: true },
    { id: 4, username: 'shared', email: null, full_name: 'Shared Person', is_active: true },
  ],
  user_company_access: [
    { user_id: 1, company_id: 10, role: 'business_owner', is_active: true },
    { user_id: 2, company_id: 10, role: 'cashier', is_active: true },
    { user_id: 3, company_id: 20, role: 'cashier', is_active: true },
    { user_id: 4, company_id: 10, role: 'cashier', is_active: true },
    { user_id: 4, company_id: 20, role: 'cashier', is_active: true },
  ],
  user_app_access: [],
};

const mockFake = createFakeSupabase(SEED);

jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../middleware/audit', () => ({ auditFromReq: jest.fn(async () => {}) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => next(),
  requireCompany: (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
  invalidateUserSessions: jest.fn(),
}));

const router = require('../shared/routes/users');

const OWNER_A = { user: { userId: 1, role: 'business_owner', isSuperAdmin: false }, companyId: 10 };
const SUPER   = { user: { userId: 99, role: 'super_admin', isSuperAdmin: true }, companyId: 10 };

const put = (id, body, caller) => callRoute(router, 'put', '/:id', { ...caller, params: { id: String(id) }, body });
const del = (id, caller) => callRoute(router, 'delete', '/:id', { ...caller, params: { id: String(id) } });
const user = id => mockFake.find('users', u => u.id === id);
const access = (u, c) => mockFake.find('user_company_access', a => a.user_id === u && a.company_id === c);

beforeEach(() => mockFake.reset(SEED));

test('TEST-SEC-U01 cross-tenant edit is refused', async () => {
  const r = await put(3, { full_name: 'Hacked', email: 'evil@x.co', is_active: false }, OWNER_A);
  expect(r.status).toBe(403);
  expect(user(3)).toMatchObject({ full_name: 'Victim B', email: 'b@x.co', is_active: true });
});

test('TEST-SEC-U02 cross-tenant delete is refused', async () => {
  const r = await del(3, OWNER_A);
  expect(r.status).toBe(403);
  expect(user(3).is_active).toBe(true);
  expect(access(3, 20).is_active).toBe(true);
});

test('TEST-SEC-U03 own single-company user: edit + delete unchanged', async () => {
  let r = await put(2, { full_name: 'Cashier Renamed', email: 'new@x.co', role: 'cashier', is_active: true }, OWNER_A);
  expect(r.status).toBe(200);
  expect(user(2)).toMatchObject({ full_name: 'Cashier Renamed', email: 'new@x.co' });

  r = await del(2, OWNER_A);
  expect(r.status).toBe(200);
  expect(user(2).is_active).toBe(false);
  expect(access(2, 10).is_active).toBe(false);
});

test('TEST-SEC-U04 multi-company user: unchanged fields + role/app change allowed', async () => {
  const r = await put(4, { full_name: 'Shared Person', email: '', role: 'cashier', is_active: true, apps_access: ['pos'] }, OWNER_A);
  expect(r.status).toBe(200);
  expect(access(4, 10).apps_access).toEqual(['pos']);
  expect(access(4, 20).apps_access).toBeUndefined();
});

test('TEST-SEC-U05 multi-company user: platform-wide fields refused', async () => {
  for (const body of [{ email: 'takeover@x.co' }, { full_name: 'Renamed' }, { is_active: false }, { username: 'grabbed' }]) {
    const r = await put(4, body, OWNER_A);
    expect(r.status).toBe(403);
  }
  expect(user(4)).toMatchObject({ email: null, full_name: 'Shared Person', is_active: true, username: 'shared' });
});

test('TEST-SEC-U06 multi-company user: delete only removes from caller company', async () => {
  const r = await del(4, OWNER_A);
  expect(r.status).toBe(200);
  expect(user(4).is_active).toBe(true);
  expect(access(4, 10).is_active).toBe(false);
  expect(access(4, 20).is_active).toBe(true);
});

test('TEST-SEC-U07 company_ids is super-admin only', async () => {
  const r = await put(2, { company_ids: [10, 20] }, OWNER_A);
  expect(r.status).toBe(403);
  expect(access(2, 20)).toBeUndefined();
});

test('TEST-SEC-U08 super admin can still edit any user', async () => {
  const r = await put(3, { full_name: 'Fixed by SA' }, SUPER);
  expect(r.status).toBe(200);
  expect(user(3).full_name).toBe('Fixed by SA');
});

test('TEST-SEC-U09 revoke_company_access still works for own member', async () => {
  const r = await put(2, { revoke_company_access: true }, OWNER_A);
  expect(r.status).toBe(200);
  expect(access(2, 10).is_active).toBe(false);
  expect(user(2).is_active).toBe(true);
});

/**
 * SEC-PWRESET — PUT /api/users/:id/password (Ruan's rule, 2026-10-01): only the actual
 * owner may reset someone else's password, and only for a person who works exclusively
 * at that company and is not themselves an owner / super admin.
 *
 *   TEST-SEC-P01  Owner can reset an own-company, single-company cashier.
 *   TEST-SEC-P02  Owner cannot reset a user who also works at another company.
 *   TEST-SEC-P03  Owner cannot reset a user in another company.
 *   TEST-SEC-P04  Owner-equivalent manager roles (administrator / practice_manager) can no longer reset.
 *   TEST-SEC-P05  Owner cannot reset another owner.
 *   TEST-SEC-P06  Super admin can reset anyone.
 */
describe('password reset by others', () => {
  const reset = (id, caller) => callRoute(router, 'put', '/:id/password',
    { ...caller, params: { id: String(id) }, body: { new_password: 'BrandNewPass123' } });
  const hashOf = id => user(id).password_hash;

  test('TEST-SEC-P01 owner resets own single-company cashier', async () => {
    const r = await reset(2, OWNER_A);
    expect(r.status).toBe(200);
    expect(hashOf(2)).toBeDefined();
  });

  test('TEST-SEC-P02 owner cannot reset a multi-company user', async () => {
    const r = await reset(4, OWNER_A);
    expect(r.status).toBe(403);
    expect(hashOf(4)).toBeUndefined();
  });

  test('TEST-SEC-P03 owner cannot reset a user in another company', async () => {
    const r = await reset(3, OWNER_A);
    expect(r.status).toBe(403);
  });

  test('TEST-SEC-P04 administrator / practice_manager can no longer reset', async () => {
    for (const role of ['administrator', 'practice_manager']) {
      const r = await reset(2, { user: { userId: 1, role, isSuperAdmin: false }, companyId: 10 });
      expect(r.status).toBe(403);
    }
    expect(hashOf(2)).toBeUndefined();
  });

  test('TEST-SEC-P05 owner cannot reset another owner', async () => {
    mockFake.db.users.push({ id: 5, username: 'owner2', email: 'o2@x.co', full_name: 'Owner Two', is_active: true });
    mockFake.db.user_company_access.push({ user_id: 5, company_id: 10, role: 'business_owner', is_active: true });
    const r = await reset(5, OWNER_A);
    expect(r.status).toBe(403);
  });

  test('TEST-SEC-P06 super admin can reset anyone', async () => {
    const r = await reset(4, SUPER);
    expect(r.status).toBe(200);
    expect(hashOf(4)).toBeDefined();
  });
});
