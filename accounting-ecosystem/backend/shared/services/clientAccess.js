'use strict';

/**
 * ============================================================================
 * Access to a CLIENT company through a practice — one rule for everyone
 * (Ruan 2026-11-26: "jy moet geïnvite word na die kliënt se profiel toe", option a)
 * ============================================================================
 * A user with no direct membership of a company may still work in it when the
 * company is an active client (eco_clients) of a practice the user belongs to, and:
 *   - the user's role at that practice is an OWNER role (the practice owner sees all
 *     its clients — the owner is the one who invites), or
 *   - the user has been INVITED to that client (a user_client_access row:
 *     user_id, company_id = the practice, eco_client_id = the client link).
 * No invitation = no access. Super users never reach this code (they have full access, F1).
 *
 * Inside the client the user keeps the practice role and the practice membership's
 * app list (apps_access). A "linked company" (eco_clients.access_link, migration 181)
 * still limits the practice to the apps that company approved.
 *
 * Used by: auth select-company + sso-launch, the session check in middleware/auth.js,
 * the eco-clients list and GET /api/auth/companies?include_clients=1.
 * ============================================================================
 */

const OWNER_ROLES = ['business_owner', 'super_admin'];
const isOwnerRole = (role) => OWNER_ROLES.includes(String(role || ''));

async function practiceLinks(db, clientCompanyId, practiceIds) {
  const q = (cols) => db.from('eco_clients').select(cols)
    .eq('client_company_id', clientCompanyId).in('company_id', practiceIds).eq('is_active', true);
  const withLink = await q('id, company_id, access_link, apps');
  if (!withLink.error) return withLink.data || [];
  const plain = await q('id, company_id');           // before migration 181
  return plain.data || [];
}

/**
 * @param {object} db  Supabase client
 * @param {{userId: number, clientCompanyId: number, targetApp?: string}} p
 * @returns {Promise<{ok: boolean, role?: string, apps_access?: string[]|null, practiceId?: number,
 *                    ecoClientId?: number, invited?: boolean, reason?: string}>}
 */
async function resolveClientAccess(db, { userId, clientCompanyId, targetApp }) {
  if (!userId || !clientCompanyId) return { ok: false, reason: 'no_company' };
  const { data: memberships, error } = await db.from('user_company_access')
    .select('company_id, role, apps_access').eq('user_id', userId).eq('is_active', true);
  if (error || !memberships || !memberships.length) return { ok: false, reason: 'no_practice' };
  const byPractice = new Map(memberships.map(m => [Number(m.company_id), m]));

  const links = await practiceLinks(db, clientCompanyId, [...byPractice.keys()]);
  if (!links.length) return { ok: false, reason: 'not_a_client' };

  let appRefused = null;
  for (const link of links) {
    const m = byPractice.get(Number(link.company_id));
    if (!m) continue;
    if (link.access_link && targetApp && !(Array.isArray(link.apps) && link.apps.includes(targetApp))) {
      appRefused = targetApp;
      continue;
    }
    const grant = { role: m.role, apps_access: m.apps_access || null, practiceId: Number(link.company_id), ecoClientId: Number(link.id) };
    if (isOwnerRole(m.role)) return Object.assign({ ok: true, invited: false }, grant);
    const { data: inv } = await db.from('user_client_access').select('id')
      .eq('user_id', userId).eq('company_id', link.company_id).eq('eco_client_id', link.id).limit(1);
    if (inv && inv.length) return Object.assign({ ok: true, invited: true }, grant);
  }
  return appRefused ? { ok: false, reason: 'app_not_shared', app: appRefused } : { ok: false, reason: 'not_invited' };
}

/**
 * Every client company a user may open through practices (owners: all clients; others: invited ones).
 * @returns {Promise<Array<{client_company_id, eco_client_id, practice_id, role, apps_access}>>}
 */
async function listReachableClients(db, userId) {
  const { data: memberships } = await db.from('user_company_access')
    .select('company_id, role, apps_access').eq('user_id', userId).eq('is_active', true);
  if (!memberships || !memberships.length) return [];
  const byPractice = new Map(memberships.map(m => [Number(m.company_id), m]));
  const { data: links } = await db.from('eco_clients').select('id, company_id, client_company_id')
    .in('company_id', [...byPractice.keys()]).eq('is_active', true).not('client_company_id', 'is', null);
  const { data: invites } = await db.from('user_client_access').select('company_id, eco_client_id').eq('user_id', userId);
  const invited = new Set((invites || []).map(i => `${i.company_id}|${i.eco_client_id}`));
  const out = [];
  for (const l of links || []) {
    if (Number(l.client_company_id) === Number(l.company_id)) continue;   // a practice's own self row
    const m = byPractice.get(Number(l.company_id));
    if (!m) continue;
    if (isOwnerRole(m.role) || invited.has(`${l.company_id}|${l.id}`)) {
      out.push({ client_company_id: Number(l.client_company_id), eco_client_id: Number(l.id), practice_id: Number(l.company_id),
        role: m.role, apps_access: m.apps_access || null });
    }
  }
  return out;
}

module.exports = { resolveClientAccess, listReachableClients, isOwnerRole, OWNER_ROLES };
