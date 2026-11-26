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

/**
 * 2026-11-20 (Ruan): the bot is a normal Ledger Leo user — it may call ANY Ledger Leo route
 * (/api/accounting/…), read or write, edit or delete, exactly like a person on the screens.
 * Leo's own role and permission checks decide what this user may do. Firmflow (/api/practice/…)
 * was added the same day on the same terms (see the Firmflow block below). What stays closed here,
 * whatever a tool asks for ("the other apps and matters"):
 *   - every other app (Paytime, Checkout Charlie, Stockton, …) — nothing outside /api/accounting
 *   - contacting clients (any /send, recurring billing that e-mails), SARS submissions
 *   - system: integrations / keys, raw KV, diagnostics, pilot tools, company admin
 *   - its own leash: AI / Sean settings, approving its own Bot Review items
 *   - bank allocation only through allocate_bank_transaction (approved allocation rules checked);
 *     since 2026-11-24 it posts like an employee — nothing waits for approval
 */
const W = 'WRITE', ANY = 'ANY';
const HARD_BLOCK = [
  [W,      /\/send$/,                                                   'e-mailing clients is done by a person — the bot never contacts clients'],
  [W,      /^\/api\/accounting\/customer-invoices\/recurring-plans\/run$/, 'running recurring billing e-mails clients — a person does that'],
  [W,      /^\/api\/accounting\/customer-invoices\/\d+\/billing-choice$/,  'monthly billing plans e-mail clients — a person sets them up'],
  [W,      /^\/api\/accounting\/vat-recon\/periods\/[^/]+\/submit$/,       'SARS submissions are done by a person'],
  [W,      /^\/api\/accounting\/vat-returns(\/|$)/,                       'capturing filed SARS VAT returns and payments is done by a person'],
  [W,      /^\/api\/accounting\/vat-recon\/cycle$/,                        'changing the company\'s VAT cycle is done by a person'],
  [ANY,    /^\/api\/accounting\/paye(\/|$)/,                             'PAYE / payroll belongs to Paytime, which the bot does not use'],
  [ANY,    /^\/api\/accounting\/employees(\/|$)/,                        'employees belong to Paytime, which the bot does not use'],
  [ANY,    /^\/api\/accounting\/pos\/(?!customers(\/|$))/,               'Checkout Charlie (POS) is not available to the bot'],
  [ANY,    /^\/api\/accounting\/(integrations|kv|diagnostics|pilot|pilot-smoke-tests)(\/|$)/, 'system settings, keys and integrations are not available to the bot'],
  [W,      /^\/api\/accounting\/company(\/|$)/,                          'creating, changing or deleting companies is done by a person'],
  [W,      /^\/api\/accounting\/(ai\/settings|bank\/sean-settings)$/,     'the bot cannot change AI / Sean settings'],
  [W,      /^\/api\/accounting\/(bot-decisions|ai\/actions)\/\d+\/(approve|reject)$/, 'approving or rejecting bot / AI work is done by a person'],
  ['POST', /^\/api\/accounting\/bank\/transactions\/\d+\/allocate$/,     'allocate bank lines with allocate_bank_transaction (approved allocation rules are checked there)'],
  // 2026-11-24 (Ruan: the bot is an ordinary employee): transfers between own accounts are done the way a
  // person does them — Leo's transfer function (PUT /bank/transactions/transfer, or confirming a transfer
  // detected on import), which matches both bank lines once. Both routes are open to the bot now.

  // ── Firmflow (practice management, /api/practice) — 2026-11-20 ──
  // The bot does the work (clients, tasks, time, deadlines, tax and secretarial prep) and submits it for
  // review; sign-off stays with a person: approving / rejecting / QA-locking / partner overrides / recording
  // reviews. Firmflow itself sends no e-mail.
  [ANY,    /^\/api\/practice\/(kv|pilot-readiness)(\/|$)/,               'system and pilot tools are not available to the bot'],
  [W,      /^\/api\/practice\/(team|users|profile|deadline-settings|tax-configs|alert-rules|automation)(\/|$)/,
                                                                         'practice settings, staff and users are managed by a person'],
  [W,      /^\/api\/practice\/tax-(submissions|disputes)\/[^/]+\/mark-submitted$/, 'only the person who submitted on SARS eFiling marks a submission as submitted'],
  [W,      /^\/api\/practice\/(?!tax-disputes\/).+\/(approve|reject|approve-[a-z-]+|reject-[a-z-]+|start-review|qa-lock|qa-unlock|partner-review|partner-override|override|accept-risk|sign|lock|decision)$/,
                                                                         'sign-off (approve / reject / QA lock / partner override) is done by a person — submit the work for review instead'],
  ['POST', /^\/api\/practice\/.+\/(reviews|review)$/,                    'reviews are recorded by the person who did the review']
];
const LEO_PATH = /^\/api\/(accounting|practice)\/[A-Za-z0-9._~\-/]*$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Why this call is refused, or null when it may go to Leo. */
function blockReason(method, path) {
  const m = String(method || '').toUpperCase();
  if (!METHODS.includes(m)) return 'unsupported method ' + m;
  const p = String(path || '').split('?')[0];
  if (!LEO_PATH.test(p) || p.includes('..') || p.includes('//')) {
    return 'only Ledger Leo (/api/accounting/…) and Firmflow (/api/practice/…) are available to the bot — other apps are not';
  }
  for (const [bm, re, why] of HARD_BLOCK) {
    if ((bm === ANY || (bm === W ? m !== 'GET' : bm === m)) && re.test(p)) return why;
  }
  return null;
}
const isAllowedCall = (method, path) => blockReason(method, path) === null;

async function call(bearer, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      method,
      signal: ctrl.signal,
      headers: Object.assign({
        'Authorization': 'Bearer ' + bearer,
        'X-Lorenco-Channel': 'mcp'        // lets audit / Sean learning see the bot channel later
      }, isForm ? {} : { 'Content-Type': 'application/json' }),   // FormData sets its own boundary
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined
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
  // Keyed per KEY as well: the minted JWT carries apiTokenId, so a new key for the same bot user must never
  // reuse a session minted for an older (revoked) key (2026-11-24: 'This bot key is no longer valid' for 10 min).
  const companyTokens = new Map();   // `${userId}|${tokenId}|${companyId}` → { token, exp }
  const allowedCache = new Map();    // userId → { ids: Set, exp }

  return {
    /** Companies this user can open (exactly the user's own list in the Eco dashboard). */
    async listCompanies(ctx) {
      // include_clients=1: also clients the user may open through a practice (owner: all; others:
      // invited ones) — the bot works there as practice staff (2026-11-26).
      const r = await call(mintUserJwt(ctx.user, ctx.tokenId), 'GET', '/api/auth/companies?include_clients=1');
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
      const key = `${ctx.user.id}|${ctx.tokenId}|${cid}`;
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

    /** Call a Ledger Leo API path as this user in this company. Anything on the hard-block
     *  list (other apps, contacting clients, SARS, system) is refused before it is sent. */
    async request(ctx, companyId, method, path, body) {
      const why = blockReason(method, path);
      if (why) throw new LorencoApiError(403, 'Not available to the bot: ' + why);
      const token = await this.companyToken(ctx, companyId);
      const r = await call(token, method, path, body);
      if (!r.ok) {
        // A role change or revoked access shows up here — drop the cached company token.
        if (r.status === 401 || r.status === 403) companyTokens.delete(`${ctx.user.id}|${ctx.tokenId}|${parseInt(companyId, 10)}`);
        throw new LorencoApiError(r.status, (r.data && (r.data.error || r.data.message)) || `Request failed (${r.status})`);
      }
      return r.data;
    },

    forgetUser(userId) {
      for (const k of companyTokens.keys()) if (k.startsWith(userId + '|')) companyTokens.delete(k);
    }
  };
}

module.exports = { createClient, mintUserJwt, LorencoApiError, baseUrl, isAllowedCall, blockReason, HARD_BLOCK };
