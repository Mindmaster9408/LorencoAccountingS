'use strict';

/**
 * Calls the normal Lorenco API AS the token's user, over loopback (same process, same
 * middleware as the browser): authenticateToken → session check (user active, company
 * active, membership, role) → module/app checks → the route's permission checks.
 * The MCP layer never touches the database for business data and never uses the
 * Supabase service key on the user's behalf.
 *
 * A short-lived user JWT is minted with exactly the login payload; the company context
 * is obtained through POST /api/auth/select-company, so the company-access rules
 * (direct membership, practice → client delegation) are the existing ones.
 */

const jwt = require('jsonwebtoken');

const BASE_JWT_TTL = '15m';
const COMPANY_CACHE_MS = 10 * 60 * 1000;

const baseUrl = () => (process.env.MCP_LOOPBACK_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');

function mintUserJwt(user, tokenId) {
  const isSuperAdmin = !!user.is_super_admin;
  return jwt.sign({
    userId: user.id,
    username: user.username,
    email: user.email,
    fullName: user.full_name,
    isSuperAdmin,
    hasCoachingAccess: !!user.has_coaching_access,
    companyId: null,
    role: isSuperAdmin ? 'super_admin' : null,
    via: 'api_token',                 // traceable in logs; grants nothing
    apiTokenId: tokenId
  }, process.env.JWT_SECRET, { expiresIn: BASE_JWT_TTL });
}

const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_REQUEST_TIMEOUT_MS, 10) || 25000;
const ALLOWED_COMPANIES_CACHE_MS = 60 * 1000;

class LorencoApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(bearer, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      method,
      signal: ctrl.signal,
      headers: {
        'Authorization': 'Bearer ' + bearer,
        'Content-Type': 'application/json',
        'X-Lorenco-Channel': 'mcp'        // lets audit / Sean learning see the bot channel later
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new LorencoApiError(504, `Lorenco took longer than ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s — try a smaller range`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, ok: res.ok, data };
}

function createClient() {
  const companyTokens = new Map();   // `${userId}|${companyId}` → { token, exp }
  const allowedCache = new Map();    // userId → { ids: Set, exp }

  return {
    /** Companies this user can open (exactly the user's own list in the Eco dashboard). */
    async listCompanies(ctx) {
      const r = await call(mintUserJwt(ctx.user, ctx.tokenId), 'GET', '/api/auth/companies');
      if (!r.ok) throw new LorencoApiError(r.status, (r.data && r.data.error) || 'Could not list companies');
      const list = (r.data && (r.data.companies || r.data.data)) || [];
      allowedCache.set(ctx.user.id, { ids: new Set(list.map(c => String(c.id))), exp: Date.now() + ALLOWED_COMPANIES_CACHE_MS });
      return list;
    },

    /** Defence in depth: the company must be in the user's OWN list (never an admin-wide view). */
    async assertAllowedCompany(ctx, cid) {
      let hit = allowedCache.get(ctx.user.id);
      if (!hit || hit.exp <= Date.now()) { await this.listCompanies(ctx); hit = allowedCache.get(ctx.user.id); }
      if (!hit || !hit.ids.has(String(cid))) {
        throw new LorencoApiError(403, 'This user has no access to company ' + cid + ' (see list_companies)');
      }
    },

    /** JWT for this user inside one company — via the normal select-company checks. */
    async companyToken(ctx, companyId) {
      const cid = parseInt(companyId, 10);
      if (!(cid > 0)) throw new LorencoApiError(400, 'company_id is required (use list_companies)');
      await this.assertAllowedCompany(ctx, cid);
      const key = `${ctx.user.id}|${cid}`;
      const hit = companyTokens.get(key);
      if (hit && hit.exp > Date.now()) return hit.token;
      const r = await call(mintUserJwt(ctx.user, ctx.tokenId), 'POST', '/api/auth/select-company', { companyId: cid });
      if (!r.ok || !r.data || !r.data.token) {
        throw new LorencoApiError(r.status === 200 ? 403 : r.status,
          (r.data && r.data.error) || 'This user has no access to company ' + cid);
      }
      companyTokens.set(key, { token: r.data.token, exp: Date.now() + COMPANY_CACHE_MS });
      if (companyTokens.size > 5000) {
        const now = Date.now();
        for (const [k, v] of companyTokens) if (v.exp <= now) companyTokens.delete(k);
      }
      return r.data.token;
    },

    /** Read a Lorenco API path as this user in this company. Phase 1 is read-only:
     *  any other method is refused here, whatever a tool asks for. */
    async request(ctx, companyId, method, path, body) {
      if (String(method).toUpperCase() !== 'GET') {
        throw new LorencoApiError(403, 'The bot connection is read-only — writing is not available');
      }
      const token = await this.companyToken(ctx, companyId);
      const r = await call(token, method, path, body);
      if (!r.ok) {
        // A role change or revoked access shows up here — drop the cached company token.
        if (r.status === 401 || r.status === 403) companyTokens.delete(`${ctx.user.id}|${parseInt(companyId, 10)}`);
        throw new LorencoApiError(r.status, (r.data && (r.data.error || r.data.message)) || `Request failed (${r.status})`);
      }
      return r.data;
    },

    forgetUser(userId) {
      for (const k of companyTokens.keys()) if (k.startsWith(userId + '|')) companyTokens.delete(k);
    }
  };
}

module.exports = { createClient, mintUserJwt, LorencoApiError, baseUrl };
