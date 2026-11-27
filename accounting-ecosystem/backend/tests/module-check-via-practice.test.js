/**
 * module-check tier 3 (user_app_access rows) must not apply to a session that reaches a client
 * through the user's practice — the practice membership's apps decide (2026-11-27).
 * Fictional data only.
 */
jest.mock('../config/modules', () => ({
  isModuleEnabled: () => true,
  companyHasModule: async () => true,
  modules: { payroll: { name: 'Paytime' } }
}));
const rows = [{ app_key: 'accounting' }];   // a leftover row from an earlier direct membership
jest.mock('../config/database', () => ({
  supabase: { from: () => { const q = { select: () => q, eq: () => q, then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; } }
}));

const { requireModule } = require('../middleware/module-check');

function run(req) {
  return new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ blocked: this.code, body }); } };
    requireModule('payroll')(req, res, () => resolve({ ok: true }));
  });
}

describe('module-check and practice sessions', () => {
  test('a direct member with an app list without payroll is blocked (unchanged)', async () => {
    const r = await run({ user: { userId: 46 }, companyId: 7, companyAccess: { role: 'business_owner', apps_access: null } });
    expect(r.blocked).toBe(403);
  });
  test('through the practice, leftover client rows are ignored — the practice apps decide', async () => {
    const r = await run({ user: { userId: 46 }, companyId: 7,
      companyAccess: { role: 'practice_manager', apps_access: ['practice', 'accounting', 'payroll'], via_practice_id: 38 } });
    expect(r.ok).toBe(true);
  });
  test('through the practice, the practice membership app list still limits apps', async () => {
    const r = await run({ user: { userId: 46 }, companyId: 7,
      companyAccess: { role: 'practice_manager', apps_access: ['practice', 'accounting'], via_practice_id: 38 } });
    expect(r.blocked).toBe(403);
  });
});
