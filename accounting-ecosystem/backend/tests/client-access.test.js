/**
 * Access to a client company through a practice — invitation model (Ruan 2026-11-26).
 * Fictional data only; a tiny in-memory stand-in for the Supabase query builder.
 */
const { resolveClientAccess, listReachableClients, isOwnerRole } = require('../shared/services/clientAccess');

function fakeDb(tables) {
  return {
    from(name) {
      const rows = (tables[name] || []).slice();
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push(r => String(r[k]) === String(v)); return q; },
        in(k, vs) { filters.push(r => vs.map(String).includes(String(r[k]))); return q; },
        not(k, op, v) { filters.push(r => !(op === 'is' && v === null && (r[k] === null || r[k] === undefined))); return q; },
        limit() { return q; },
        then(res) { return Promise.resolve({ data: rows.filter(r => filters.every(f => f(r))), error: null }).then(res); }
      };
      return q;
    }
  };
}

// Practice 38 manages clients 2, 3, 7 (eco ids 1, 2, 5); practice 6 manages client 8 (eco 6).
const base = () => ({
  eco_clients: [
    { id: 1, company_id: 38, client_company_id: 2, is_active: true },
    { id: 2, company_id: 38, client_company_id: 3, is_active: true },
    { id: 5, company_id: 38, client_company_id: 7, is_active: true },
    { id: 35, company_id: 38, client_company_id: 38, is_active: true },            // practice self row
    { id: 6, company_id: 6, client_company_id: 8, is_active: true },
    { id: 9, company_id: 38, client_company_id: 9, is_active: true, access_link: true, apps: ['payroll'] }
  ],
  user_company_access: [
    { user_id: 1, company_id: 38, role: 'business_owner', apps_access: null, is_active: true },   // owner
    { user_id: 46, company_id: 38, role: 'accountant', apps_access: ['practice', 'accounting'], is_active: true },
    { user_id: 50, company_id: 38, role: 'practice_manager', apps_access: null, is_active: true },
    { user_id: 60, company_id: 6, role: 'accountant', apps_access: null, is_active: true },
    { user_id: 70, company_id: 38, role: 'accountant', apps_access: null, is_active: false }      // inactive
  ],
  user_client_access: [
    { user_id: 46, company_id: 38, eco_client_id: 1 },
    { user_id: 46, company_id: 38, eco_client_id: 5 },
    { user_id: 46, company_id: 6, eco_client_id: 6 },          // a row on another firm's link: worthless
    { user_id: 70, company_id: 38, eco_client_id: 1 }
  ]
});

describe('resolveClientAccess', () => {
  test('the practice owner opens every client of the practice', async () => {
    const db = fakeDb(base());
    for (const c of [2, 3, 7]) {
      const g = await resolveClientAccess(db, { userId: 1, clientCompanyId: c });
      expect(g).toMatchObject({ ok: true, role: 'business_owner', practiceId: 38, invited: false });
    }
  });

  test('staff open only the clients they were invited to — role and apps come from the practice', async () => {
    const db = fakeDb(base());
    expect(await resolveClientAccess(db, { userId: 46, clientCompanyId: 2 }))
      .toMatchObject({ ok: true, role: 'accountant', apps_access: ['practice', 'accounting'], ecoClientId: 1, invited: true });
    expect(await resolveClientAccess(db, { userId: 46, clientCompanyId: 7 })).toMatchObject({ ok: true });
    expect(await resolveClientAccess(db, { userId: 46, clientCompanyId: 3 })).toMatchObject({ ok: false, reason: 'not_invited' });
  });

  test('a practice manager or accountant without invitations gets nothing (no more "empty = all")', async () => {
    const db = fakeDb(base());
    expect((await resolveClientAccess(db, { userId: 50, clientCompanyId: 2 })).ok).toBe(false);
  });

  test('another firm’s client is never reachable, even with a stray invitation row', async () => {
    const db = fakeDb(base());
    expect(await resolveClientAccess(db, { userId: 46, clientCompanyId: 8 })).toMatchObject({ ok: false, reason: 'not_a_client' });
    expect(await resolveClientAccess(db, { userId: 60, clientCompanyId: 2 })).toMatchObject({ ok: false, reason: 'not_a_client' });
  });

  test('an inactive practice membership gives nothing', async () => {
    const db = fakeDb(base());
    expect(await resolveClientAccess(db, { userId: 70, clientCompanyId: 2 })).toMatchObject({ ok: false, reason: 'no_practice' });
  });

  test('a linked company still limits the practice to the apps it approved', async () => {
    const db = fakeDb(base());
    expect(await resolveClientAccess(db, { userId: 1, clientCompanyId: 9, targetApp: 'accounting' })).toMatchObject({ ok: false, reason: 'app_not_shared' });
    expect((await resolveClientAccess(db, { userId: 1, clientCompanyId: 9, targetApp: 'payroll' })).ok).toBe(true);
  });
});

describe('listReachableClients', () => {
  test('owner: all clients (not the practice self row); staff: invited ones only', async () => {
    const db = fakeDb(base());
    expect((await listReachableClients(db, 1)).map(r => r.client_company_id).sort((a, b) => a - b)).toEqual([2, 3, 7, 9]);
    expect((await listReachableClients(db, 46)).map(r => r.client_company_id).sort((a, b) => a - b)).toEqual([2, 7]);
    expect(await listReachableClients(db, 50)).toEqual([]);
  });
  test('owner roles', () => {
    expect(isOwnerRole('business_owner')).toBe(true);
    expect(isOwnerRole('super_admin')).toBe(true);
    expect(isOwnerRole('practice_manager')).toBe(false);
    expect(isOwnerRole('accountant')).toBe(false);
  });
});
