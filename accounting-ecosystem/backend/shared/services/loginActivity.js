/**
 * ============================================================================
 * Login activity — "who last used this company, and when" (migration 184)
 * ============================================================================
 * Ruan 2026-11-17: super users want to see in the admin panel whether
 * clients actually use the program.
 *
 *   users.last_login_at                  last successful login (any company)
 *   user_company_access.last_access_at   last time this user entered THIS
 *                                        company (login with it selected,
 *                                        company switch, opening an app, POS PIN)
 *
 * Fire-and-forget by design: never awaited by the auth routes, never throws,
 * and changes nothing about tokens, company context or responses. A failed
 * write only costs an out-of-date "last used" date.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn('[login-activity] ' + msg + ' (shown once)');
}

/**
 * @param {number} userId
 * @param {number|null} companyId   company the user is now working in
 * @param {{ login?: boolean }} [opts] login: also stamp users.last_login_at
 */
function recordActivity(userId, companyId, opts = {}) {
  try {
    if (!userId) return;
    const now = new Date().toISOString();
    if (opts.login) {
      supabase.from('users').update({ last_login_at: now }).eq('id', userId)
        .then(({ error }) => { if (error) warnOnce('users.last_login_at: ' + error.message); }, () => {});
    }
    if (companyId) {
      supabase.from('user_company_access').update({ last_access_at: now })
        .eq('user_id', userId).eq('company_id', companyId)
        .then(({ error }) => { if (error) warnOnce('user_company_access.last_access_at: ' + error.message); }, () => {});
    }
  } catch (_) { /* never affect the login */ }
}

/**
 * Pure: latest access per company from user_company_access rows (with users
 * embedded). Super users are left out — their visits to a client's company
 * must not make an unused company look used.
 * @returns {Object<number, { at: string, user_id: number, name: string }>}
 */
function latestByCompany(rows) {
  const out = {};
  for (const r of rows || []) {
    const u = r.users;
    if (!r.last_access_at || !u || u.is_super_admin) continue;
    const cur = out[r.company_id];
    if (!cur || r.last_access_at > cur.at) {
      out[r.company_id] = { at: r.last_access_at, user_id: u.id, name: u.full_name || u.username || u.email || 'User' };
    }
  }
  return out;
}

module.exports = { recordActivity, latestByCompany };
