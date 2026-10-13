'use strict';

/**
 * SEC-COMPANY — company user management + company create/edit hardening (2026-10-01)
 *
 * /api/auth/companies/:companyId/users (P2)
 *   TEST-SEC-C01  A cashier cannot create users (was: any member could, with any role).
 *   TEST-SEC-C02  A manager cannot create a user above their own level.
 *   TEST-SEC-C03  An owner can still create users (unchanged behaviour).
 *   TEST-SEC-C04  link-existing judges role level at the TARGET company, not the token's company.
 *   TEST-SEC-C05  A store manager cannot remove the business owner.
 *   TEST-SEC-C06  An owner can still remove a cashier.
 *   TEST-SEC-C07  Any member can still LIST users (read path unchanged).
 *
 * /api/companies (P3 + edit tenant guard)
 *   TEST-SEC-C08  Create: non-super-admin cannot self-grant modules (e.g. Firmflow) — gets BASE_MODULES.
 *   TEST-SEC-C09  Create: super admin may still choose modules.
 *   TEST-SEC-C10  Edit: cannot edit another company by id (bank details untouched).
 *   TEST-SEC-C11  Edit: own company (token company) still works.
 *   TEST-SEC-C12  Edit: modules_enabled / is_active are super-admin only.
 *   TEST-SEC-C13  Edit: super admin can still edit any company.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-1234567890';

const { createFakeSupabase, callRoute } = require('./helpers/fakeSupabase');

const SEED = {
  users: [
    { id: 1, username: 'owner_a', email: 'a@x.co', full_name: 'Owner A', is_active: true },
    { id: 2, username: 'cashier_a', email: 'ca@x.co', full_name: 'Cashier A', is_active: true },
    { id: 3, username: 'manager_a', email: 'ma@x.co', full_name: 'Store Mgr A', is_active: true },
    { id: 5, username: 'free_agent', email: 'fa@x.co', full_name: 'Free Agent', is_active: true },
  ],
  user_company_access: [
    { user_id: 1, company_id: 10, role: 'business_owner', is_active: true },
    { user_id: 2, company_id: 10, role: 'cashier', is_active: true },
    { user_id: 3, company_id: 10, role: 'store_manager', is_active: true },
    // user 3 is business_owner of their OWN company 30 — token for 30 must not lift their level at 10
    { user_id: 3, company_id: 30, role: 'business_owner', is_active: true },
  ],
  companies: [
    { id: 10, company_name: 'Company A', bank_account_number: '111', is_active: true, modules_enabled: ['pos'] },
    { id: 20, company_name: 'Company B', bank_account_number: '222', is_active: true, modules_enabled: ['pos'] },
    { id: 30, company_name: 'Company C', bank_account_number: '333', is_active: true, modules_enabled: ['pos'] },
  ],
};

const mockFake = createFakeSupabase(SEED);

jest.mock('../config/database', () => ({ supabase: mockFake.client }));
jest.mock('../middleware/audit', () => ({ auditFromReq: jest.fn(async () => {}) }));
jest.mock('../middleware/auth', () => {
  const pass = (req, res, next) => next();
  return {
    authenticateToken: pass, requireCompany: pass, requireSuperAdmin: pass,
    requirePermission: () => pass, invalidateUserSessions: jest.fn(), JWT_SECRET: 'test-secret-that-is-long-enough-1234567890',
  };
});
jest.mock('../modules/pos/services/posAuditLogger', () => ({
  logPosEvent: jest.fn(), posAuditFromReq: jest.fn(), POS_EVENTS: {},
}));
jest.mock('../services/twoFactorAuth', () => ({}));

const authRouter = require('../shared/routes/auth');
const companiesRouter = require('../shared/routes/companies');

const caller = (userId, role, companyId, isSuperAdmin = false) => ({ user: { userId, role, isSuperAdmin }, companyId });
const OWNER_A   = caller(1, 'business_owner', 10);
const CASHIER_A = caller(2, 'cashier', 10);
const MGR_A     = caller(3, 'store_manager', 10);
const MGR_A_TOKEN_FOR_C = caller(3, 'business_owner', 30); // same person, token issued for company 30
const SUPER     = caller(99, 'super_admin', 10, true);

const access = (u, c) => mockFake.find('user_company_access', a => a.user_id === u && a.company_id === c);
const company = id => mockFake.find('companies', c => c.id === id);
const newUser = { username: 'newbie', password: 'secret123', full_name: 'New Person' };

beforeEach(() => mockFake.reset(SEED));

describe('company user management (P2)', () => {
  const create = (who, body) => callRoute(authRouter, 'post', '/companies/:companyId/users',
    { ...who, params: { companyId: '10' }, body });

  test('TEST-SEC-C01 cashier cannot create users', async () => {
    const r = await create(CASHIER_A, { ...newUser, role: 'business_owner' });
    expect(r.status).toBe(403);
    expect(mockFake.find('users', u => u.username === 'newbie')).toBeUndefined();
  });

  test('TEST-SEC-C02 manager cannot create a user above their level', async () => {
    const r = await create(MGR_A, { ...newUser, role: 'business_owner' });
    expect(r.status).toBe(403);
  });

  test('TEST-SEC-C03 owner can still create users', async () => {
    const r = await create(OWNER_A, { ...newUser, role: 'cashier' });
    expect(r.status).toBe(201);
    const created = mockFake.find('users', u => u.username === 'newbie');
    expect(created).toBeDefined();
    expect(access(created.id, 10)).toMatchObject({ role: 'cashier', is_active: true });
  });

  test('TEST-SEC-C04 link-existing uses the role at the target company', async () => {
    const r = await callRoute(authRouter, 'post', '/companies/:companyId/users/link-existing',
      { ...MGR_A_TOKEN_FOR_C, params: { companyId: '10' }, body: { identifier: 'fa@x.co', role: 'business_owner' } });
    expect(r.status).toBe(403);
    expect(access(5, 10)).toBeUndefined();
  });

  test('TEST-SEC-C05 store manager cannot remove the owner', async () => {
    const r = await callRoute(authRouter, 'delete', '/companies/:companyId/users/:userId',
      { ...MGR_A, params: { companyId: '10', userId: '1' } });
    expect(r.status).toBe(403);
    expect(access(1, 10).is_active).toBe(true);
  });

  test('TEST-SEC-C06 owner can still remove a cashier', async () => {
    const r = await callRoute(authRouter, 'delete', '/companies/:companyId/users/:userId',
      { ...OWNER_A, params: { companyId: '10', userId: '2' } });
    expect(r.status).toBe(200);
    expect(access(2, 10).is_active).toBe(false);
  });

  test('TEST-SEC-C07 any member can still list users', async () => {
    const r = await callRoute(authRouter, 'get', '/companies/:companyId/users',
      { ...CASHIER_A, params: { companyId: '10' } });
    expect(r.status).toBe(200);
  });
});

describe('company create / edit (P3 + edit tenant guard)', () => {
  test('TEST-SEC-C08 create: no self-granted modules', async () => {
    const r = await callRoute(companiesRouter, 'post', '/',
      { ...OWNER_A, body: { company_name: 'Sneaky Co', modules_enabled: ['pos', 'practice'] } });
    expect(r.status).toBeLessThan(300);
    const created = mockFake.find('companies', c => c.company_name === 'Sneaky Co');
    expect(created.modules_enabled).toEqual(['pos', 'payroll', 'accounting', 'sean']);
  });

  test('TEST-SEC-C09 create: super admin may choose modules', async () => {
    await callRoute(companiesRouter, 'post', '/',
      { ...SUPER, body: { company_name: 'Admin Co', modules_enabled: ['pos', 'practice'] } });
    expect(mockFake.find('companies', c => c.company_name === 'Admin Co').modules_enabled).toEqual(['pos', 'practice']);
  });

  const edit = (who, id, body) => callRoute(companiesRouter, 'put', '/:id', { ...who, params: { id: String(id) }, body });

  test('TEST-SEC-C10 edit: cannot edit another company', async () => {
    const r = await edit(OWNER_A, 20, { bank_account_number: '999-attacker' });
    expect(r.status).toBe(403);
    expect(company(20).bank_account_number).toBe('222');
  });

  test('TEST-SEC-C11 edit: own company still works', async () => {
    const r = await edit(OWNER_A, 10, { bank_account_number: '112', trading_name: 'A Trading' });
    expect(r.status).toBe(200);
    expect(company(10)).toMatchObject({ bank_account_number: '112', trading_name: 'A Trading' });
  });

  test('TEST-SEC-C12 edit: modules_enabled / is_active super-admin only', async () => {
    let r = await edit(OWNER_A, 10, { modules_enabled: ['pos', 'practice'] });
    expect(r.status).toBe(403);
    r = await edit(OWNER_A, 10, { is_active: false });
    expect(r.status).toBe(403);
    expect(company(10)).toMatchObject({ modules_enabled: ['pos'], is_active: true });
  });

  test('TEST-SEC-C13 edit: super admin can edit any company', async () => {
    const r = await edit(SUPER, 20, { is_active: false });
    expect(r.status).toBe(200);
    expect(company(20).is_active).toBe(false);
  });
});
