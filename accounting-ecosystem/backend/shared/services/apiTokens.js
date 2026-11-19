'use strict';

/**
 * Personal access tokens (migration 186).
 *
 * A token belongs to ONE user and carries no rights of its own: whoever presents it acts
 * as that user, with the user's own role, companies and client delegation, checked by the
 * normal Lorenco API on every request (Ruan 2026-11-18: a bot is an employee user; the
 * practice decides its rights). Only a SHA-256 hash is stored; the token is shown once.
 *
 * Format: "lnc_" + 43 url-safe chars (32 random bytes). The prefix makes leaked tokens
 * easy to recognise and lets a user tell their tokens apart (token_prefix is stored).
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'lnc_';
const MAX_ACTIVE_PER_USER = 20;
const LAST_USED_WRITE_EVERY_MS = 60 * 1000;   // don't write last_used_at on every request

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/**
 * Lorenco PLATFORM admins never get keys: a super admin (and the accounting module's
 * global-admin emails, ADMIN_EMAILS) can open every company and bypass permission checks,
 * so a key on such an account would hand a bot unrestricted access. A practice's own roles
 * are the practice's choice (Ruan 2026-11-18) — this only covers Lorenco's platform accounts.
 */
function isPlatformAdmin(user) {
  if (!user) return false;
  if (user.is_super_admin === true || user.isSuperAdmin === true) return true;
  const admins = (process.env.ADMIN_EMAILS || 'ruanvlog@lorenco.co.za,antonjvr@lorenco.co.za')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return !!user.email && admins.includes(String(user.email).toLowerCase());
}

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Bot policy per key (migration 187, Codebox 4). What a bot using this key may do ON ITS
 * OWN. Set by a person in Profile; the bot connection can never change it. Missing keys
 * mean the safe default. Director/owner lines ALWAYS need a person — not a policy option.
 */
const POLICY_DEFAULTS = Object.freeze({
  allow_create_rules: false,          // create_allocation_rule
  allow_reconcile_difference: false,  // reconcile_bank_transactions with allow_difference
  allow_sean_auto: false,             // sean_auto_allocate
  require_approval_all: false         // every allocation waits for a person
});
function normalizePolicy(p) {
  const src = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  const out = {};
  for (const k of Object.keys(POLICY_DEFAULTS)) out[k] = src[k] === true;
  return out;
}

const isActive = (t, now = Date.now()) =>
  !t.revoked_at && (!t.expires_at || new Date(t.expires_at).getTime() > now);

/** Public shape — never includes the hash. */
function present(t) {
  return {
    id: t.id, name: t.name, prefix: t.token_prefix, created_at: t.created_at,
    last_used_at: t.last_used_at || null, expires_at: t.expires_at || null,
    revoked_at: t.revoked_at || null, active: isActive(t), policy: normalizePolicy(t.policy)
  };
}

async function listTokens(supabase, userId) {
  const { data, error } = await supabase.from('user_api_tokens')
    .select('id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at, policy')
    .eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw new Error('Could not load tokens: ' + error.message);
  return (data || []).map(present);
}

/**
 * @returns {{ token: string, record: object }} — token is returned ONCE, never stored.
 */
async function createToken(supabase, userId, { name, expiresInDays, policy } = {}) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) { const e = new Error('Give the key a name (e.g. "Grok bot")'); e.status = 400; throw e; }
  let expiresAt = null;
  if (expiresInDays != null && expiresInDays !== '') {
    const d = parseInt(expiresInDays, 10);
    if (!(d >= 1 && d <= 3650)) { const e = new Error('expires_in_days must be between 1 and 3650'); e.status = 400; throw e; }
    expiresAt = new Date(Date.now() + d * 86400000).toISOString();
  }
  const existing = await listTokens(supabase, userId);
  if (existing.filter(t => t.active).length >= MAX_ACTIVE_PER_USER) {
    const e = new Error(`At most ${MAX_ACTIVE_PER_USER} active keys per user — revoke one first`); e.status = 409; throw e;
  }
  const token = generateToken();
  const { data, error } = await supabase.from('user_api_tokens').insert({
    user_id: userId, name: cleanName, token_hash: hashToken(token),
    token_prefix: token.slice(0, 12), expires_at: expiresAt, policy: normalizePolicy(policy)
  }).select('id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at, policy').single();
  if (error) throw new Error('Could not create the key: ' + error.message);
  return { token, record: present(data) };
}

/** Change a key's bot policy (a person, from Profile — never through the bot connection). */
async function setTokenPolicy(supabase, userId, tokenId, policy) {
  const clean = normalizePolicy(policy);
  const { data, error } = await supabase.from('user_api_tokens').update({ policy: clean })
    .eq('id', tokenId).eq('user_id', userId).is('revoked_at', null).select('id');
  if (error) throw new Error('Could not save the key settings: ' + error.message);
  return (data || []).length > 0 ? clean : null;
}

async function revokeToken(supabase, userId, tokenId, revokedBy) {
  const { data, error } = await supabase.from('user_api_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy || userId })
    .eq('id', tokenId).eq('user_id', userId).is('revoked_at', null)
    .select('id');
  if (error) throw new Error('Could not revoke the key: ' + error.message);
  return (data || []).length > 0;
}

/**
 * Resolve a presented token to its (active) user. Returns null for anything invalid —
 * unknown, revoked, expired, or the user is inactive.
 * @returns {Promise<{tokenId, user: {id, username, email, full_name, is_super_admin, has_coaching_access}}|null>}
 */
async function resolveToken(supabase, raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX) || raw.length < 40 || raw.length > 100) return null;
  const { data: t, error } = await supabase.from('user_api_tokens')
    .select('id, user_id, expires_at, revoked_at, last_used_at, policy')
    .eq('token_hash', hashToken(raw)).maybeSingle();
  if (error || !t || !isActive(t)) return null;
  const { data: user } = await supabase.from('users')
    .select('id, username, email, full_name, is_super_admin, has_coaching_access, is_active')
    .eq('id', t.user_id).maybeSingle();
  if (!user || user.is_active === false) return null;
  if (isPlatformAdmin(user)) return null;      // also covers a key made before the account became admin
  if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > LAST_USED_WRITE_EVERY_MS) {
    supabase.from('user_api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', t.id)
      .then(() => {}, () => {});
  }
  return { tokenId: t.id, user, policy: normalizePolicy(t.policy) };
}

module.exports = {
  TOKEN_PREFIX, MAX_ACTIVE_PER_USER,
  hashToken, generateToken, isActive, present, isPlatformAdmin,
  listTokens, createToken, revokeToken, resolveToken,
  POLICY_DEFAULTS, normalizePolicy, setTokenPolicy
};
