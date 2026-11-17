'use strict';

/**
 * Login activity (migration 184) — fictional users only.
 * Invariants:
 *   1. Latest access per company; super users' visits never count.
 *   2. recordActivity never throws and never blocks, even when the DB fails.
 */

const calls = [];
jest.mock('../config/database', () => ({
  supabase: {
    from: (table) => ({
      update: (patch) => {
        const chain = {
          eq: (col, val) => { calls.push({ table, patch, col, val }); return chain; },
          then: (ok) => Promise.resolve({ error: { message: 'column "last_access_at" does not exist' } }).then(ok),
        };
        return chain;
      },
    }),
  },
}));

const { recordActivity, latestByCompany } = require('../shared/services/loginActivity');

describe('latestByCompany', () => {
  test('latest per company wins; super users are left out', () => {
    const rows = [
      { company_id: 51, last_access_at: '2026-11-10T08:00:00Z', users: { id: 1, full_name: 'Test Owner' } },
      { company_id: 51, last_access_at: '2026-11-12T09:30:00Z', users: { id: 2, full_name: 'Test Clerk' } },
      { company_id: 51, last_access_at: '2026-11-16T10:00:00Z', users: { id: 3, full_name: 'Super', is_super_admin: true } },
      { company_id: 60, last_access_at: null, users: { id: 4, full_name: 'Never' } },
    ];
    expect(latestByCompany(rows)).toEqual({ 51: { at: '2026-11-12T09:30:00Z', user_id: 2, name: 'Test Clerk' } });
  });
});

describe('recordActivity', () => {
  test('stamps login + company access; a failing DB never throws', async () => {
    expect(() => recordActivity(7, 51, { login: true })).not.toThrow();
    await new Promise(r => setImmediate(r));
    expect(calls.some(c => c.table === 'users' && c.patch.last_login_at)).toBe(true);
    expect(calls.some(c => c.table === 'user_company_access' && c.patch.last_access_at)).toBe(true);
  });

  test('no user → nothing; no company → only the login stamp', () => {
    calls.length = 0;
    recordActivity(null, 51, { login: true });
    expect(calls).toHaveLength(0);
    recordActivity(7, null, { login: true });
    expect(calls.every(c => c.table === 'users')).toBe(true);
  });
});
