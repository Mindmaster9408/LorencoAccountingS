'use strict';

/**
 * Director register roles (practice_company_directors.role) — one place for
 * the secretarial routes and the statutory change-case implementer.
 *
 *   director       plain director (Pty Ltd / NPC) — default for companies
 *   executive      executive director
 *   non_executive  non-executive director
 *   alternate      alternate director
 *   member         member of a close corporation (BK) — default for CCs
 *
 * Input is forgiving: case, spaces and hyphens are ignored ("Director",
 * "Non-Executive", "non executive director" all resolve). Must stay in step
 * with the CHECK constraint (migration 191).
 */

const DIRECTOR_ROLES = ['director', 'executive', 'non_executive', 'alternate', 'member'];

const ALIASES = {
  nonexecutive: 'non_executive',
  non_executive_director: 'non_executive',
  executive_director: 'executive',
  alternate_director: 'alternate',
  cc_member: 'member',
  lid: 'member',
  direkteur: 'director',
};

/**
 * undefined → no role given; null → given but not a known role; else the
 * canonical role. Pure.
 */
function normalizeDirectorRole(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const role = ALIASES[key] || key;
  return DIRECTOR_ROLES.includes(role) ? role : null;
}

/** Default role when none is given: 'member' for a CC, else 'director'. Pure. */
function defaultDirectorRole(companyType, clientType) {
  return (companyType === 'cc' || (!companyType && clientType === 'cc')) ? 'member' : 'director';
}

/**
 * Default role for a client: the secretarial profile's company_type wins,
 * else practice_clients.client_type. Reads only — never creates a profile.
 */
async function resolveDefaultDirectorRole(supabase, companyId, clientId) {
  const [{ data: profile }, { data: client }] = await Promise.all([
    supabase.from('practice_secretarial_profiles').select('company_type')
      .eq('company_id', companyId).eq('client_id', clientId).maybeSingle(),
    supabase.from('practice_clients').select('client_type')
      .eq('company_id', companyId).eq('id', clientId).maybeSingle(),
  ]);
  return defaultDirectorRole(profile && profile.company_type, client && client.client_type);
}

const invalidRoleMessage = value =>
  `Invalid role "${value}". Valid roles: ${DIRECTOR_ROLES.join(', ')}`;

module.exports = {
  DIRECTOR_ROLES, normalizeDirectorRole, defaultDirectorRole,
  resolveDefaultDirectorRole, invalidRoleMessage,
};
