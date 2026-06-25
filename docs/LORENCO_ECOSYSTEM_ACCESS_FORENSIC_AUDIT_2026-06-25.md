# LORENCO ECOSYSTEM ACCESS FORENSIC AUDIT REPORT

**Date:** 2026-06-25  
**Scope:** Full ecosystem — Eco Dashboard, Accounting, Paytime, POS, Inventory, Practice, Sean AI, Coaching  
**Method:** Static forensic analysis — codebase read, no live testing, no code changes  
**Auditor:** Claude Sonnet 4.6 (automated forensic scan)  
**Status:** AUDIT COMPLETE — No fixes applied

---

## 1. Executive Summary

### Overall Status

The ecosystem has a **working but uneven access-control posture**. The backbone is correct: JWT-based authentication with `companyId` embedded at select-company time, enforced at backend middleware level. Most modules are protected. Most tenant isolation works.

However, several structural gaps exist that — individually — represent moderate risk, and collectively represent a pattern that must be addressed before broader rollout to external clients.

### Biggest Risks

| # | Risk | Severity | App |
|---|------|----------|-----|
| 1 | No database-level RLS policies — all isolation relies on application code | CRITICAL | All |
| 2 | Unauthenticated password reset — no OTP, no email verification | CRITICAL | All |
| 3 | Practice module missing blanket `requireCompany` guard — several sub-routes may lack company enforcement | HIGH | Practice |
| 4 | `activeCompanyId` defaults to hardcoded company `1` in accounting frontend if localStorage is empty | HIGH | Accounting |
| 5 | Token revocation gap — 8-hour window after access is revoked | HIGH | All |
| 6 | Coaching module not behind ecosystem `authenticateToken` at mount point | HIGH | Coaching |
| 7 | `isSuperAdmin` read from mutable localStorage in ECO Dashboard and Payroll | HIGH | Eco, Payroll |
| 8 | `has_coaching_access` stored in localStorage and can drift from DB — coaching tile may remain visible after access revoked | HIGH | Eco Dashboard |

### Apps That Appear Safe

- **POS (Checkout Charlie):** Strongest isolation. JWT-enforced, company-scoped, no business data in localStorage, PIN login properly implemented.
- **Inventory / Storehouse:** `requireCompany` applied at mount level — cleanest backend guard in the ecosystem.
- **Payroll backend:** Sub-routes individually apply `requireCompany`. No payroll business data in localStorage (KV bridge correctly excluded).

### Apps Requiring Urgent Correction

- **Practice Management:** `requireCompany` not applied at the module mount level; individual sub-routes have inconsistent coverage.
- **Accounting Frontend:** `activeCompanyId || 1` fallback is a silent wrong-company display bug.
- **ECO Dashboard:** `isSuperAdmin` and `has_coaching_access` sourced from mutable localStorage; company list read from cached localStorage that may be stale.

---

## 2. Current Access Architecture

### Identity Layer

Every app relies on JWT authentication. The ecosystem has one token issuer: `POST /api/auth/login`. Tokens carry:

```json
{
  "userId": 12,
  "email": "user@lorenco.co.za",
  "role": "manager",
  "companyId": 7,
  "isSuperAdmin": false,
  "hasCoachingAccess": false,
  "ssoSource": "ecosystem",
  "targetApp": "pos"
}
```

Company context (`companyId`) is embedded in the JWT at `POST /api/auth/select-company` time (or `POST /api/auth/sso-launch` for app-specific tokens). This is the server-authoritative source. The backend never trusts a frontend-supplied `company_id` field in a request body — it uses `req.companyId` from `authenticateToken` middleware.

### Company Isolation Mechanism

```
Login → JWT (no companyId yet)
      ↓
Select Company → POST /api/auth/select-company
              ↓ verifies user_company_access row (for non-super-admin)
              ↓ issues new JWT with companyId embedded
              ↓
All subsequent API calls carry that JWT
              ↓
authenticateToken → sets req.companyId from JWT payload
              ↓
requireCompany → blocks if req.companyId is null
              ↓
All DB queries use WHERE company_id = req.companyId
```

### Super Admin Override

Super admins (`isSuperAdmin: true` in JWT) bypass the `user_company_access` membership check at `select-company` and can switch to any company. They can also send `X-Company-Id` header on any request to override `req.companyId` without re-issuing a token. This is intended design (CLAUDE.md Rule F1) but operates without per-request audit logging.

### RLS Status

Supabase Row-Level Security is **enabled** on all major tables via `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. However, **no `CREATE POLICY` statements exist in `database/schema.sql`**. The backend uses the Supabase service-role key which bypasses RLS entirely. All tenant isolation is enforced at the application level (`WHERE company_id = req.companyId`), with no database-layer safety net.

### App-Level Access

`GET /api/auth/sso-launch` is the gateway for cross-app navigation. It verifies:
1. Valid JWT
2. User has access to the target company (`user_company_access` row for non-super-admin)
3. Coaching special gate: `user.has_coaching_access` from DB (not JWT)
4. Module is enabled for the company (`company_modules` or `modules_enabled`)
5. User has app access (`user_app_access` table for non-super-admin)

The issued SSO token is app-specific (`targetApp` + `ssoSource: 'ecosystem'` in payload).

---

## 3. Eco Dashboard Findings

### Login

- **Login endpoint:** `POST /api/auth/login` — bcrypt password comparison, rate-limited, returns JWT.
- **Company list:** Returned from `GET /api/auth/companies` — scoped to `user_company_access` for regular users; returns all companies for `isSuperAdmin`.
- **Company list persistence:** Stored in `localStorage.setItem('eco_companies', ...)`. On next page load, read from localStorage first. **If stale, reflects outdated access until logout.**
- **`isSuperAdmin` flag:** Stored as `localStorage.setItem('eco_super_admin', 'true')`. The entire dashboard reads this from localStorage for every render decision. A user who manipulates this to `'true'` sees the admin panel button and admin-level UI — but backend calls still require the JWT to carry `isSuperAdmin: true`.

### Company List

- **Source:** `localStorage.getItem('eco_companies')` cached at login. Refreshed from `/api/auth/companies` when empty.
- **Risk:** Company list is only refreshed at login. If a user's access is revoked (or a new company is added), the dashboard won't reflect it until re-login.
- **Super admin behaviour:** Gets all ecosystem companies regardless of membership.

### App Tiles (renderApps)

- **Super admin bypass (Rule F1):** `isSuperAdmin` bypasses both `userAppsAccess` and `companyModules` checks — every app tile is visible.
- **Coaching gate (Rule F2):** `app.key === 'coaching'` hardcoded to check `currentUser?.hasCoachingAccess === true`. Super admin flag explicitly NOT checked for this path. Correct implementation.
- **Coaching tile drift risk:** `currentUser.hasCoachingAccess` is populated from `localStorage.getItem('eco_user')`. If `has_coaching_access` is revoked in DB, the tile remains visible until re-login. The backend SSO launch re-checks from DB (line 851, `auth.js`) — so actual coaching launch is blocked. But the tile remains rendered in the DOM for revoked users, which violates CLAUDE.md Rule F2 ("completely invisible for non-Ruan users").

### Company Switching

- Company switcher sends `POST /api/auth/select-company`.
- For regular users: backend verifies `user_company_access` row.
- For super admins: only verifies company exists and is active.
- Issues new JWT with updated `companyId`.
- Re-stores company context in localStorage (`eco_companies`, `selectedCompanyId`, etc.).

### User Management

- ECO admin panel calls `GET /api/auth/companies/:companyId/users`.
- Super admins can view users for any company.
- `canManageCompanyUsers()` returns `true` for super admin with any `companyId` — correct for ECO context, dangerous if exposed in wrong context (see Codebox 68 fix for POS).

### Platform / Super User Access

- Follows CLAUDE.md Part F correctly.
- Sean AI restricted to `CORE_SUPER_USERS` email list — correct.
- Coaching restricted to `has_coaching_access` DB flag — correct in backend, drift risk in frontend.

### Direct App Launch

- App tiles call `POST /api/auth/sso-launch` → receive `appToken`.
- Token stored in localStorage for the target app.
- Target app reads this token on load.
- Security: SSO launch verifies membership and module access server-side before issuing token.

---

## 4. Accounting App Findings

### Company Access

- **Token source:** `localStorage.getItem('token')` — SSO token from ECO dashboard.
- **Company identity:** `localStorage.getItem('activeCompanyId')` — carried over from ECO SSO launch. **Critical gap: several pages fall back to `|| 1` if this key is missing.**
- **Backend guard:** `authenticateToken` + `requireModule('accounting')`. The JWT's `companyId` is used for all backend queries. Even if the frontend sends `activeCompanyId=99`, the backend ignores it and uses `req.companyId` from the JWT.

### The `|| 1` Fallback Problem

In `frontend-accounting/company.html` at lines 975, 1001, 1015, 1241, 1255, 1363:

```javascript
parseInt(localStorage.getItem('activeCompanyId')) || 1
safeLocalStorage.getItem('activeCompanyId') || 1
```

If `activeCompanyId` is absent (direct URL navigation, cleared storage, expired session), the page silently operates against company ID 1. In production with multiple tenants, company ID 1 is whoever was first provisioned. This is a **display bug** (backend still enforces JWT companyId) but creates a confusing and potentially misleading experience.

### Client Switching

- Accounting company switch goes back through ECO `select-company` flow.
- No in-app switcher that bypasses ECO found.

### Route Guards

- `requireModule('accounting')` at backend mount.
- `authenticateToken` at backend mount.
- Frontend client-side guards (`AUTH.requireAuth()`, `AUTH.requireCompany()`).

### API Authorization

- Accounting routes use `req.companyId` from JWT for all queries.
- Supabase queries scoped to `company_id = req.companyId`.

### Reports / Bank / Invoices / PAYE

- All accessed via authenticated API endpoints.
- Backend scopes all data to `req.companyId`.
- No cross-company leakage found in backend logic.

### localStorage Findings (Accounting)

| Key | Usage | Classification |
|-----|-------|---------------|
| `activeCompanyId` | Frontend company context (display only) | COMPANY_ID — dangerous for display decisions |
| `token` | JWT | AUTH_TOKEN (allowed) |
| `user` | User metadata | AUTH_TOKEN (borderline) |
| `selectedCompanyId` | Company context | COMPANY_ID — same risk |
| `safeLocalStorage.*` | KV bridge for some keys | Varies (see Section 13) |

---

## 5. Paytime Findings

### Payroll Company Access

- **Token source:** `localStorage.getItem('token')` — SSO or direct login JWT.
- **Company context:** From JWT `companyId` — correct.
- **`session` object:** Stored in localStorage as `{ company_id, role, is_super_admin, modules_enabled }`. Frontend auth decisions (`AUTH.isSuperAdmin()`, `AUTH.hasRole()`) read from this mutable object.

### Employee Data Isolation

- All payroll routes require `requireCompany`.
- All queries scoped to `company_id = req.companyId`.
- `payroll_snapshots` table has `company_id` column used in all queries.

### Finalized Payroll (Stability Lock)

- `is_locked = true` on `payroll_snapshots` table is the only finalization gate.
- No localStorage finalization flag (the old pattern was removed per May 2026 stability lock).
- Locked periods are immutable — backend returns snapshot data without recalculation.

### Reports / PAYE / UIF

- All reports are API-driven, scoped to `req.companyId`.
- PAYE recon totals sourced from `payroll_snapshots` — correct.

### Direct URL / API Risks

- Payroll pages (`employee-detail.html`, `payroll-execution.html`, etc.) load from static file server — no server-side auth at static serving level. Client-side `AUTH.requireAuth()` / `AUTH.requireCompany()` redirects to login if no valid token.
- If token is present but for a different company, the JWT gates the backend — data from the wrong company cannot be returned.

### localStorage Findings (Payroll)

| Key | Usage | Classification |
|-----|-------|---------------|
| `token` | JWT | AUTH_TOKEN (allowed) |
| `session` | `{ company_id, role, is_super_admin, modules_enabled }` | DANGEROUS — business auth state in mutable storage |
| `availableCompanies` | Company list cache | COMPANY_ID — stale risk |
| `cache_*` | Offline API response fallback | UI_PREF (acceptable) |
| `empNavSort` | sessionStorage — employee sort preference | UI_PREF (allowed) |

**KV bridge (`safeLocalStorage`):** Non-local keys route to `/api/payroll/kv` endpoint. The `isLocalKey()` guard correctly keeps `session`, `token`, `cache_*`, `eco_*`, `availableCompanies` in native localStorage. Business data writes go through direct API endpoints, not KV. The KV bridge is a migration-period artifact — Rule D3 requires migration to proper SQL tables.

---

## 6. POS Findings

### Company / Till Access

- **Company context:** JWT `companyId` from SSO token — never from localStorage for business decisions.
- **In-memory only:** `currentCompanyId` is a JS variable set from JWT payload on login. Not written to localStorage.
- **Codebox 68 fix applied:** Settings → Users no longer calls `/api/companies`. Company context is always `currentCompanyId`.

### Cashier Access

- PIN login: `POST /api/auth/pos/pin-login` — bcrypt, 5-attempt lockout in 15 minutes, server-side.
- Only roles `cashier, senior_cashier, shift_supervisor, assistant_manager` are PIN-eligible.
- PIN login issues a JWT with `companyId` embedded — same standard JWT chain.

### Product Access

- `GET /api/pos/products` scoped to `company_id = req.companyId`.
- Shortcuts: `pos_user_product_shortcuts` table scoped to `(company_id, user_id)` — Codebox 66.

### Sales Data

- `pos_sales` table has `company_id` column.
- All sales routes use `requireCompany`.
- Cart is in-memory only — no browser persistence.

### Offline Queue Risks

- No `indexedDB` usage found in POS code.
- No service worker writing business data found.
- Offline mode: if API is unreachable, cart is in-memory and the sale cannot complete. No silent local queue that could bypass company scoping.

### Browser Storage Findings (POS)

| Key | Usage | Classification |
|-----|-------|---------------|
| `token` | SSO JWT | AUTH_TOKEN (allowed) |
| `company` | Company object from ECO launch | COMPANY_ID — carried but not used as business truth; `currentCompanyId` from JWT decode is authoritative |
| `isSuperAdmin` | `localStorage.setItem('isSuperAdmin', 'true')` at login | DANGEROUS — UI state, backend ignores |
| `user` | User metadata | AUTH_TOKEN (borderline) |

**`isSuperAdmin` in localStorage:** POS stores `localStorage.setItem('isSuperAdmin', ...)` during login. This is used to show/hide manager-only UI elements. Backend does not trust this flag — it reads from JWT. A cashier who sets this to `'true'` in DevTools sees manager UI but all management API calls return 403.

---

## 7. Inventory / Storehouse Findings

### Company Access

- **Backend mount:** `app.use('/api/inventory', authenticateToken, requireCompany, requireModule('inventory'), ...)` — **best-in-class setup**. Both `authenticateToken` AND `requireCompany` applied at mount. No route can slip through without both checks.

### Stock Item Isolation

- All inventory queries scoped to `company_id = req.companyId`.
- No cross-company item access possible via normal API calls.

### localStorage Findings (Inventory)

- Token read from localStorage for API calls (allowed).
- No business data written to localStorage found.

---

## 8. Practice Management Findings

### Practice Profile Isolation

- **Backend mount (server.js):** `app.use('/api/practice', authenticateToken, requireModule('practice'), ...)` — `requireCompany` is **NOT at the mount level**.
- `requireCompany` is applied individually by some sub-routers.

### Sub-Router Coverage

| Sub-router | requireCompany applied? |
|------------|------------------------|
| `tax-bulk-operations.js` | YES |
| `tax-pipeline.js` | YES |
| `tax-submissions.js` | YES |
| `tax-reports.js` | YES |
| `clients.js` | NOT CONFIRMED — not audited individually |
| `billing.js` | NOT CONFIRMED |
| `workflows.js` | NOT CONFIRMED |
| `tasks.js` | NOT CONFIRMED |
| `deadlines.js` | NOT CONFIRMED |
| `team.js` | NOT CONFIRMED |

The four tax sub-routers explicitly apply `requireCompany` because they were recently built. Older sub-routers (clients, billing, workflows, tasks, deadlines, team) may or may not apply it individually. This is the most significant backend coverage gap in the ecosystem.

### Team vs Client Users

- Practice team users: have `user_company_access` row for the practice company.
- Client users: relationship via `eco_clients` table linking a client company to the practice company.
- A practice user cannot see another practice's clients through the normal API — queries are scoped to `req.companyId` at the practice level.

### localStorage Findings (Practice)

- `localStorage.getItem('token') || localStorage.getItem('practice_token')` — dual fallback for token. The `practice_token` is a vestige; both are JWTs and backend validates them the same way.

---

## 9. Sean AI Findings

### What Data Sean Can Access

- Sean is a standalone Next.js app (`sean-webapp/`).
- It does NOT have direct SQL access to the accounting ecosystem's Supabase database.
- Sean calls the ecosystem's API on behalf of the user (via the SSO session and API proxy pattern). Data returned is limited to what the ecosystem API returns for that user's JWT scope.
- Sean's own database is SQLite (`prisma.db`) — stores sessions, allowed emails, coaching access flags.

### Sean Access Model

- Gated by hardcoded `CORE_SUPER_USERS` email list PLUS `AllowedEmail` table in SQLite.
- Sessions are 30-day UUIDs — no JWT, no expiry activity reset.
- No company context in Sean's own data model — Sean is accessed as a super user tool, not a per-client tool.

### Cross-Client Leakage Risk (Sean)

- If Sean proxies requests to the ecosystem API, it uses the logged-in user's JWT.
- The JWT carries `companyId` — so proxied calls are naturally scoped to the active company.
- No mechanism for Sean to cross company boundaries unless the user holds a super admin JWT and sends `X-Company-Id` header.

### Coaching Filter

- `sean-webapp/lib/coaching-filter.ts` exists and filters coaching queries from non-authorized users.
- Coaching-specific data is blocked from non-`hasCoachingAccess` users at the Sean layer.

### Placeholder Emails Risk

- `ADDITIONAL_SUPER_ADMINS` in `auth.ts` contains `user3@lorenco.co.za` and `user4@lorenco.co.za`.
- If these are not real registered users, these email addresses are unclaimed. Anyone who registers them externally would gain Sean super-user access.

---

## 10. Coaching App Findings

### Who Can Access

- ECO Dashboard: coaching tile only renders for `currentUser.hasCoachingAccess === true` — reading from localStorage-cached user object.
- SSO launch: backend re-reads `has_coaching_access` from DB at launch time (line 851, `auth.js`). Correct — DB is authoritative at token issuance.

### Backend Enforcement

- **Gap:** `app.use('/api/coaching', coachingRoutes)` in `server.js` has NO `authenticateToken` or `requireCompany` at the mount point.
- Each coaching sub-router applies its own auth middleware using `COACHING_JWT_SECRET || JWT_SECRET`.
- If `COACHING_JWT_SECRET` env var is not set, it falls back to the shared `JWT_SECRET`. This means any valid ecosystem JWT could technically present to coaching routes, but would then fail to match a `coaching_users` row (separate DB table).
- **Public routes found:** `/api/coaching/leads POST` — explicitly public (lead capture form, no auth). `/api/coaching/settings GET` — apparently readable without auth.

### Direct URL Protection

- `GET /coaching` serves `coaching/login.html` without server-side auth.
- Coaching login requires a `coaching_users` account in a separate database.
- Ecosystem users without a `coaching_users` account cannot authenticate directly.
- The coaching app is de facto hidden from ecosystem users — they see a login form they cannot use.

### Coaching Debug Route

- `router.use('/debug', require('./routes/debug'))` in coaching `index.js` — marked "TEMPORARY — remove after diagnosis."
- Auth requirements of the debug route were not confirmed. If the debug route is unprotected, it may expose internal state.

### `has_coaching_access` Drift

- If `has_coaching_access` is revoked in DB, the ECO dashboard coaching tile remains visible until re-login (localStorage drift).
- Backend SSO launch correctly blocks issuance of coaching token.
- **Violation of CLAUDE.md Rule F2:** "completely invisible for non-Ruan users" — tile remains in DOM until localStorage is refreshed.

---

## 11. Shared Backend / Middleware Findings

### `authenticateToken`

```javascript
// middleware/auth.js lines 47-73 (summarized)
const decoded = jwt.verify(token, JWT_SECRET);
req.user = decoded;
req.companyId = decoded.companyId || null;

// Super admin X-Company-Id override:
if ((req.user.isGlobalAdmin || req.user.role === 'super_admin') && req.headers['x-company-id']) {
    req.companyId = req.headers['x-company-id'];
}
```

- Trusts JWT payload without re-querying DB on every call.
- Super admin can override `req.companyId` via header.
- Does NOT verify that the JWT's `companyId` still has an active `user_company_access` row. Revoked access remains effective for JWT lifetime.

### `requireCompany`

```javascript
// middleware/auth.js lines 80-89 (summarized)
if (!req.companyId) return res.status(400).json({ error: 'Company context required' });
next();
```

- Only checks for null/undefined `companyId`.
- Does NOT re-query `user_company_access`.
- Token revocation gap: 8-hour window.

### `requireModule`

- Checks `company_modules` table for the module being accessed.
- Correct — scoped to `req.companyId`.

### Module Mount Guard Summary

| Module | authenticateToken | requireCompany at mount | requireModule at mount |
|--------|------------------|------------------------|----------------------|
| `/api/pos` | YES | NO | YES (`pos`) |
| `/api/payroll` | YES | NO | YES (`payroll`) |
| `/api/accounting` | YES | NO | YES (`accounting`) |
| `/api/inventory` | YES | **YES** | YES (`inventory`) |
| `/api/practice` | YES | NO | YES (`practice`) |
| `/api/sean` | YES | NO | ? |
| `/api/coaching` | **NO** | NO | NO |
| `/api/auth` (shared) | Varies per route | Varies | N/A |
| `/api/companies` (shared) | YES | NO | N/A |

**Inventory is the only module with `requireCompany` at the mount level.**

### Role Checks

- Roles stored in JWT, read at route level via `requirePermission()`.
- `requirePermission()` checks `permissions.js` definitions — role-based, not per-company permission sets.
- A user with role `manager` at Turkstra has manager permissions at any company they switch to (if super admin grants them access). Roles are not company-specific beyond the `user_company_access.role` column used at select-company time to embed the role in the JWT.

### Audit Logs

- `audit_logs` table exists in schema.
- SSO launch events are logged.
- Most routine API calls are NOT individually audit-logged.
- Super admin `X-Company-Id` header overrides are NOT audit-logged per request.

---

## 12. Database / Schema Findings

### Key Tables

#### `users`

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  full_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'cashier',
  is_active BOOLEAN DEFAULT true,
  is_super_admin BOOLEAN DEFAULT false,
  has_coaching_access BOOLEAN DEFAULT false,  -- added via migration
  ...
)
```

- `has_coaching_access` exists (via migration, not in base schema).
- `is_super_admin` is the DB source of truth; JWT embeds this at login.

#### `companies`

```sql
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  ...
  is_active BOOLEAN DEFAULT true
)
```

#### `user_company_access`

```sql
CREATE TABLE user_company_access (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  role VARCHAR(50) NOT NULL DEFAULT 'cashier',
  is_primary BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(user_id, company_id)
)
```

- This is the authoritative membership table.
- Checked at `select-company` and `sso-launch` for non-super-admins.
- NOT checked on every API request (JWT trusted).

#### `company_modules`

- Controls which modules are active per company.
- Checked by `requireModule()` middleware on every request — correct.

#### `user_app_access`

- Controls which apps a non-super-admin user can access.
- Referenced in SSO launch flow.
- Not in base `schema.sql` — exists via migration.

#### `payroll_snapshots`

- Has `company_id` column.
- `is_locked = true` is the finalization gate.
- No cross-company leakage possible in current implementation.

### RLS Status

```sql
-- From schema.sql:
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_company_access ENABLE ROW LEVEL SECURITY;
-- ... (all major tables)
```

**RLS is ENABLED but no `CREATE POLICY` statements exist.** With the Supabase service-role key (used by the backend), RLS is bypassed entirely. The effect: RLS provides zero protection. Isolation is 100% application-level.

### Missing Indexes

- `user_company_access (company_id)` — missing; queries filter by company_id frequently.
- `payroll_snapshots (company_id, period_start)` — frequently queried compound.
- `pos_sales (company_id, created_at)` — not confirmed but likely high-frequency.

---

## 13. Browser Storage Findings

### Complete Inventory

| File | Key | Data Stored | Classification | Action |
|------|-----|-------------|----------------|--------|
| `dashboard.html:1931` | `eco_token` | JWT | AUTH_TOKEN | Keep |
| `dashboard.html:1939` | `eco_user` | `{ fullName, email, hasCoachingAccess }` | DANGEROUS — coaching access cached here | Refresh from DB on every page load |
| `dashboard.html:1940` | `eco_companies` | Full company list array | COMPANY_ID (stale risk) | Refresh from API on each login, not just when empty |
| `dashboard.html:1941` | `eco_super_admin` | `'true'`/`'false'` string | DANGEROUS — UI decisions based on this | Read from JWT decode only, not localStorage |
| `dashboard.html:2059,2080` | `eco_companies` | Company list updates | COMPANY_ID | See above |
| `dashboard.html:2321` | `auth_token` | Coaching SSO token | AUTH_TOKEN | Keep |
| `dashboard.html:2322` | `user` | User object | AUTH_TOKEN (borderline) | Review — may include sensitive fields |
| `dashboard.html:2323` | `sso_source` | `'ecosystem'` | UI_PREF | Keep |
| `dashboard.html:2366` | `token` | App-specific SSO token | AUTH_TOKEN | Keep |
| `dashboard.html:2367` | `user` | User object | AUTH_TOKEN (borderline) | Review |
| `dashboard.html:2379` | `activeCompanyId` | Company ID integer | COMPANY_ID (used for display) | Accept but ensure backend never trusts it |
| `dashboard.html:2380` | `selectedCompanyId` | Company ID integer | COMPANY_ID | Same |
| `dashboard.html:2381` | `eco_company_name` | Company name string | UI_PREF | Keep |
| `dashboard.html:2450-2453` | `company`, `selectedCompanyId`, `activeCompanyId`, `eco_company_name` | Company object + IDs | COMPANY_ID | Accept for display only |
| `dashboard.html:2459` | `eco_client_id` | Client ID integer | LOW risk — not sensitive by itself | Minor — persists last-viewed client |
| `dashboard.html:3876,3919` | `eco_demos` | Demo session flags | BUSINESS_DATA (medium) | Review — should this persist? |
| `payroll/auth.js:49` | `token` | JWT | AUTH_TOKEN | Keep |
| `payroll/auth.js:60` | `availableCompanies` | Company list | COMPANY_ID (stale risk) | Refresh on each login |
| `payroll/auth.js:148,153` | `session` | `{ company_id, role, is_super_admin, modules_enabled }` | DANGEROUS — mutable auth state | Replace with JWT-decode reads only |
| `payroll/data-access.js:68-77` | `cache_*` | API response cache | UI_PREF | Keep |
| `payroll/data-access.js:88-100` | `session` | Same as above | DANGEROUS | Same |
| `pos/index.html` | `isSuperAdmin` | `'true'`/`'false'` | DANGEROUS — UI decisions | Read from JWT decode only |
| `pos/index.html` | `token` | SSO JWT | AUTH_TOKEN | Keep |
| `pos/index.html` | `company` | Company object | COMPANY_ID (not used as business truth) | Accept — `currentCompanyId` from JWT is authoritative |
| `payroll/employee-detail.html` | `empNavSort` (sessionStorage) | Sort order | UI_PREF | Keep |
| `accounting/company.html` | `activeCompanyId` | Company ID with `|| 1` fallback | DANGEROUS — wrong-company display | Remove `|| 1` fallback |

### KV Bridge Assessment

`safeLocalStorage` in `frontend-payroll/js/data-access.js` routes non-local keys to `/api/payroll/kv` (Supabase `payroll_kv_store_eco` table). Local keys (`session`, `token`, `cache_*`, etc.) stay in native localStorage.

Currently active KV keys requiring SQL migration per Rule D3:
- `voluntaryTaxConfig_*` → needs `employee_tax_overrides` table
- `attendance_*` → needs `attendance_records` table
- `paye_recon_*` → needs `paye_reconciliation` table
- `sean_learning_*` → needs `sean_knowledge_mappings` table
- `bank_allocations_*` → needs `bank_transaction_allocations` table

**These KV migrations are tracked follow-ups, not new findings.**

---

## 14. Direct URL Bypass Findings

### Static Serving (All Apps)

All frontend files are served as static assets:

```javascript
// server.js pattern (simplified)
app.use('/pos', express.static('frontend-pos'));
app.use('/payroll', express.static('frontend-payroll'));
app.use('/accounting', express.static('frontend-accounting'));
app.use('/practice', express.static('frontend-practice'));
app.use('/coaching', express.static('frontend-coaching'));
```

There is no server-side auth check when serving HTML files. Any user can load the HTML of any app by typing the URL directly.

### What Happens on Direct URL

| Scenario | Result |
|----------|--------|
| Load `/pos/index.html` with no token | Client-side `AUTH.requireAuth()` redirects to login |
| Load `/pos/index.html` with expired token | Same — redirect to login |
| Load `/pos/index.html` with valid token for Company A | POS loads for Company A — correct |
| Load `/pos/index.html` with valid token, manually call API with Company B's ID | Backend rejects — `req.companyId` is from JWT, not request body |
| Load `/admin/index.html` with no token | Client-side redirect to login |
| Load `/admin/index.html` with non-super-admin token | Client-side redirect (if guard is implemented) |
| Load `/coaching/index.html` with no coaching account | Coaching login screen (separate auth system) |

### Admin / QA Pages

- `GET /admin` and `GET /qa-hub` serve static HTML without server-side auth.
- Client-side JS is responsible for redirecting non-super-admins.
- If client-side guard is missing or bypassed, the page HTML loads — though API calls would still require JWT.

### Assessment

Direct URL access to HTML files is acceptable given that:
1. All business data is behind authenticated API endpoints.
2. The JWT gates all actual data operations.
3. An attacker who sees the HTML of a page they're not authorized for gains only the page structure, not any data.

**Risk level: LOW** — Not ideal, but not a data exposure risk given the backend guards.

---

## 15. Cross-Company Leakage Tests (Conceptual)

These tests trace the access path conceptually based on code analysis.

### Scenario: User has access to Turkstra Bakkery, NOT Pennygrow

| Test | Finding |
|------|---------|
| Does dashboard show Pennygrow? | Only if user has `user_company_access` row for Pennygrow, OR is super admin. Regular user: NO. |
| Does company switcher show Pennygrow? | No — switcher is built from `GET /api/auth/companies` which returns only companies the user has access to (for non-super-admin). |
| Can user access Pennygrow via direct URL? | They can load the page HTML. But any API call requires JWT with Pennygrow's `companyId`. They'd need to go through `select-company` with Pennygrow's ID — which the backend would reject (no `user_company_access` row). |
| Can user call API with Pennygrow `company_id` in request body? | No — backend uses `req.companyId` from JWT, not from request body. Request body `company_id` is ignored for authorization purposes. |
| Can user call API with Pennygrow ID in URL params? | Depends on the route. Routes like `GET /api/pos/products` use `req.companyId` from middleware — URL params are only used for resource IDs, not company scoping. |
| Can reports include Pennygrow data? | No — all report queries are scoped to `req.companyId` from JWT. |
| Can Sean answer from Pennygrow data? | Sean proxies API calls using the user's JWT — which is scoped to Turkstra. Sean cannot access Pennygrow data unless the user holds a Pennygrow-scoped JWT. |
| Can exported files leak Pennygrow data? | No — exports are generated server-side from company-scoped queries. |

### Scenario: Practice user vs Client user

- A practice team member has access to the practice's own `company_id` and can navigate to client companies via the `eco_clients` delegation chain.
- A client user only has access to their own `company_id`.
- One practice cannot see another practice's clients through normal API flows.

### Scenario: Super admin metadata exposure

- Super admins can see all companies via ECO dashboard.
- In ECO context, this is intentional (Rule F1).
- In client app context (POS, Payroll), super admins are subject to the same JWT-scoped company context as any other user. The Codebox 68 fix enforces this at the POS Settings → Users level.

---

## 16. Risk Register

### CRITICAL

---

**RISK-01 — No database RLS policies**

- **App:** All modules
- **Description:** RLS is enabled on all tables but no `CREATE POLICY` statements exist in `database/schema.sql`. The backend uses Supabase service-role key which bypasses RLS entirely. All tenant isolation is application-level `WHERE company_id = req.companyId` filters.
- **Proof:** `accounting-ecosystem/database/schema.sql` — RLS enabled, no POLICY definitions. Backend `.env` uses `SUPABASE_SERVICE_ROLE_KEY`.
- **Impact:** A single missed `WHERE company_id` filter in any route exposes all tenants' data. No database-layer backstop. In a multi-tenant SaaS this is the last line of defence — it is absent.
- **Fix:** Define `CREATE POLICY` statements for all tables. Use `anon`/`authenticated` roles with RLS policies for data access. Switch backend to use `authenticated` role with row-level grants where possible, reserving service-role for admin operations only.

---

**RISK-02 — Unauthenticated password reset**

- **App:** All (shared auth)
- **Description:** `POST /api/auth/forgot-password/reset` accepts email + new password with no OTP, no email token, no confirmation link. Any caller who knows a user's email can reset that password.
- **Proof:** `accounting-ecosystem/backend/shared/routes/auth.js` lines 738-803. Comment at line 753 acknowledges this.
- **Impact:** Full account takeover for any user whose email is known. Given the ecosystem manages payroll, tax, and accounting data, this is a critical authentication bypass.
- **Fix:** Implement email-based OTP or secure reset token. Supabase Auth has built-in password reset flows that can be used here.

---

### HIGH

---

**RISK-03 — Token revocation gap**

- **App:** All
- **Description:** `requireCompany` and `authenticateToken` trust the JWT without re-querying the database. Revoking a user's `user_company_access.is_active` does not invalidate their existing JWT — they retain full access for up to 8 hours.
- **Proof:** `accounting-ecosystem/backend/middleware/auth.js` lines 47-73, 80-89. No DB lookup on each request.
- **Impact:** A deprovisioned employee retains 8-hour access window. For payroll and accounting data, this is significant.
- **Fix (short-term):** Add `is_active` check against `user_company_access` in `requireCompany` (adds one DB query per request). **OR:** Maintain a token blacklist/revocation table. **OR:** Shorten JWT expiry to 1 hour and implement refresh tokens.

---

**RISK-04 — `isSuperAdmin` from mutable localStorage**

- **App:** ECO Dashboard, Payroll
- **Description:** Dashboard reads `isSuperAdmin = localStorage.getItem('eco_super_admin') === 'true'`. Payroll reads `AUTH.isSuperAdmin()` from `session.is_super_admin` in localStorage. These are mutable — any user can set them to `'true'` in DevTools.
- **Proof:** `frontend-ecosystem/dashboard.html:1941`, `frontend-payroll/js/auth.js:197-200`.
- **Impact:** A manipulated user sees admin-level UI (admin panel button, admin sections, user management). Backend calls still require valid JWT — so data access is blocked. But UI surface exposure is undesirable and may enable social engineering or confusion.
- **Fix:** Parse `isSuperAdmin` from the JWT token itself using `jwt-decode` (client-side decode, no validation — just for UI display). Never write it to localStorage.

---

**RISK-05 — Practice module missing blanket `requireCompany`**

- **App:** Practice Management
- **Description:** Practice backend module (`/api/practice`) is mounted without `requireCompany`. Only four recently-built sub-routers apply it individually. Older sub-routers (clients, billing, workflows, tasks, deadlines, team) may lack company enforcement if their route handlers don't individually apply it.
- **Proof:** `accounting-ecosystem/backend/server.js` practice mount — no `requireCompany`. `backend/modules/practice/index.js` — no `router.use(requireCompany)`.
- **Impact:** Practice routes without individual `requireCompany` could process requests from authenticated users without a company context. Depending on how queries are written, this could expose data from all companies (if query lacks WHERE filter) or return a 500 error (if `req.companyId` is undefined).
- **Fix:** Add `router.use(requireCompany)` to the practice module's `index.js` — one line, prevents all routes from operating without company context.

---

**RISK-06 — `activeCompanyId || 1` fallback in Accounting**

- **App:** Accounting
- **Description:** Six locations in `company.html` use `parseInt(localStorage.getItem('activeCompanyId')) || 1` or `safeLocalStorage.getItem('activeCompanyId') || 1`. If `activeCompanyId` is absent, the frontend silently loads company ID 1.
- **Proof:** `frontend-accounting/company.html` lines 975, 1001, 1015, 1241, 1255, 1363.
- **Impact:** Display bug — user sees company 1's data instead of an error. Backend API calls still use JWT company ID (correct). However, the company settings page could display confusing data, and any changes submitted from this page would use the frontend-derived ID which the backend should ignore. If the backend DOES use the supplied company ID from the request body (not exclusively `req.companyId`), this becomes a company-switching vector.
- **Fix:** Remove all `|| 1` fallbacks. Show an error or redirect to login if `activeCompanyId` is absent.

---

**RISK-07 — Coaching module not behind ecosystem `authenticateToken` at mount**

- **App:** Coaching
- **Description:** `app.use('/api/coaching', coachingRoutes)` has no `authenticateToken` at mount. Each sub-route applies coaching's own auth middleware. New routes added without their own auth middleware would be publicly accessible.
- **Proof:** `accounting-ecosystem/backend/server.js` line 364.
- **Impact:** Public routes (`/api/coaching/leads`, `/api/coaching/settings`) are intentionally unauthenticated. But the pattern creates risk that future routes added without auth middleware would be silently public. The debug route's auth status is unknown.
- **Fix:** Add `authenticateToken` at the coaching module mount (even if some routes then override with coaching-specific auth). Makes the ecosystem-level auth the baseline. Audit the debug route immediately.

---

**RISK-08 — `has_coaching_access` drift in localStorage**

- **App:** ECO Dashboard
- **Description:** `currentUser.hasCoachingAccess` is read from `localStorage.getItem('eco_user')`. If revoked in DB, the coaching tile remains visible until re-login. Violates CLAUDE.md Rule F2 ("completely invisible for non-Ruan users").
- **Proof:** `frontend-ecosystem/dashboard.html:1939, 1952-1955`.
- **Impact:** A coaching client could see the coaching tile after their access is revoked (until they log out). The backend SSO launch correctly re-checks from DB and blocks token issuance — so they cannot actually access coaching data. But the tile visibility violates the "invisible" requirement.
- **Fix:** Always re-fetch `has_coaching_access` from `/api/auth/me` on dashboard load. Never use the localStorage-cached value for coaching tile visibility.

---

### MEDIUM

---

**RISK-09 — Super admin `X-Company-Id` header override not audit-logged**

- **App:** All
- **Description:** Super admins can switch company context on any request via `X-Company-Id` header without going through `select-company`. No per-request audit log entry is created for this override.
- **Proof:** `middleware/auth.js` lines 63-70. No audit log write in this path.
- **Impact:** Super admin actions against non-primary companies are harder to trace in audit reviews. SSO launch events are logged, but inline header overrides are not.
- **Fix:** Log `X-Company-Id` header usage to `audit_logs` table with `userId`, `companyId`, `endpoint`, `timestamp`.

---

**RISK-10 — `session` object in localStorage (Payroll)**

- **App:** Payroll
- **Description:** `{ company_id, role, is_super_admin, modules_enabled }` stored in localStorage. Frontend access control reads from this mutable object. A user who edits DevTools localStorage claims super admin permissions in the UI.
- **Proof:** `frontend-payroll/js/auth.js:148-158`, `data-access.js:87-100`.
- **Impact:** Frontend renders admin-level payroll UI to manipulated session. Backend still requires valid JWT — data access blocked. But UI surface exposure and potential confusion.
- **Fix:** Derive auth state from JWT decode (`atob(token.split('.')[1])`), not from a separate localStorage `session` object.

---

**RISK-11 — Company user creation requires only 6-character password**

- **App:** All
- **Description:** `POST /api/auth/companies/:companyId/users` requires `password.length >= 6`. Self-service registration requires 8. Combined with Risk-02 (no email verification for password reset), weak passwords are more easily brute-forced or reset.
- **Proof:** `backend/shared/routes/auth.js` line 1131.
- **Impact:** Easier account compromise.
- **Fix:** Raise minimum to 8 characters (matching self-service). Consider zxcvbn strength check.

---

**RISK-12 — Stale company list in ECO Dashboard localStorage**

- **App:** ECO Dashboard
- **Description:** `eco_companies` is loaded from localStorage on dashboard load and only refreshed from API when empty. Revoked access or new companies don't appear until re-login.
- **Proof:** `dashboard.html:1940`.
- **Impact:** User may see outdated company list. A revoked company remains in switcher until logout. Low security risk (backend verifies at `select-company`) but a usability and trust issue.
- **Fix:** Always fetch fresh from `/api/auth/companies` on dashboard load. Use localStorage only as a loading-state placeholder.

---

**RISK-13 — No Content-Security-Policy headers**

- **App:** All
- **Description:** `contentSecurityPolicy: false` in Helmet config. No CSP headers on any page served by the ecosystem backend.
- **Proof:** `accounting-ecosystem/backend/server.js` lines 97-100.
- **Impact:** XSS attacks have no CSP barrier. If an attacker injects a script, it can read tokens from localStorage without restriction.
- **Fix:** Define a strict CSP policy. Given the ecosystem serves its own static files, a policy that allows `'self'` for scripts and disallows inline scripts would eliminate most XSS escalation vectors.

---

**RISK-14 — `eco_demos` persisted in localStorage**

- **App:** ECO Dashboard
- **Description:** Demo company state (`eco_demos`) stored in localStorage, persists across sessions.
- **Proof:** `dashboard.html:3876, 3919`.
- **Impact:** Low — UI-only state. On shared devices, reveals which company accounts were last demoed. Not a data exposure.
- **Fix:** Use `sessionStorage` instead of `localStorage` for demo state.

---

### LOW

---

**RISK-15 — `eco_client_id` stored in localStorage**

- **App:** ECO Dashboard
- **Description:** `localStorage.setItem('eco_client_id', clientId)` stores the last-viewed client's ID.
- **Proof:** `dashboard.html:2459`.
- **Impact:** Persists last client context on shared devices. Not sensitive data by itself.
- **Fix:** Use `sessionStorage` or clear on logout.

---

**RISK-16 — Sean 30-day sessions, no activity timeout**

- **App:** Sean AI
- **Description:** Sean sessions expire at 30 days with no activity-based reset or timeout.
- **Proof:** `sean-webapp/lib/auth.ts:186-192`.
- **Impact:** Stolen session cookie valid for 30 days.
- **Fix:** Implement activity-based session sliding window (e.g., reset expiry on each request, cap at 7 days idle).

---

**RISK-17 — Placeholder emails in Sean `ADDITIONAL_SUPER_ADMINS`**

- **App:** Sean AI
- **Description:** `user3@lorenco.co.za` and `user4@lorenco.co.za` are in `CORE_SUPER_USERS` with `hasCoachingAccess: false`. If unclaimed externally, anyone who registers them gains Sean super-user access.
- **Proof:** `sean-webapp/lib/auth.ts:21-24`.
- **Impact:** Low if email domain is controlled, medium if it is not.
- **Fix:** Replace placeholder emails with real provisioned user emails or remove them.

---

**RISK-18 — Coaching debug route**

- **App:** Coaching
- **Description:** `router.use('/debug', require('./routes/debug'))` in coaching module — marked "TEMPORARY — remove after diagnosis." Auth status of debug routes not confirmed.
- **Proof:** `accounting-ecosystem/backend/modules/coaching/index.js:19`.
- **Impact:** Unknown — depends on debug route content. Potential internal state exposure.
- **Fix:** Remove debug route immediately. Or audit and confirm it requires authentication.

---

## 17. Protected Areas

The following areas are under stability lock (CLAUDE.md Part E) and must not be changed without explicit authorization:

| Area | Files | Protection Level |
|------|-------|-----------------|
| Payroll calculation engine | `frontend-payroll/js/payroll-engine.js` | CRITICAL — regression gate required |
| Payroll backend module | `backend/modules/payroll/**` | CRITICAL |
| Payroll data access | `frontend-payroll/js/data-access.js` | HIGH |
| Payroll frontend pages | `frontend-payroll/payroll-execution.html`, `employee-detail.html`, `payruns.html` | HIGH |
| Shared auth routes | `backend/shared/routes/auth.js` | HIGH — ecosystem-wide impact |
| Auth middleware | `backend/middleware/auth.js` | HIGH — ecosystem-wide impact |
| Companies route | `backend/shared/routes/companies.js` | HIGH |
| Permissions config | `backend/config/permissions.js` | MEDIUM |
| Coaching access gate | `frontend-ecosystem/dashboard.html` lines 2225-2226 | CRITICAL — Rule F2 |
| Super admin bypass | `frontend-ecosystem/dashboard.html` lines 2227, 2234 | CRITICAL — Rule F1 |

---

## 18. Recommended Architecture Fixes

*This section is recommendation only. No implementation until explicitly instructed.*

### R1 — Define RLS Policies (CRITICAL priority)

Create `CREATE POLICY` statements for all major tables. For each table, define:
- A `SELECT` policy allowing access where `company_id = auth.uid()` (or equivalent JWT claim)
- An `INSERT` policy restricting to the current company
- An `UPDATE`/`DELETE` policy similarly scoped

Transition backend from service-role key to `authenticated` role where safe. Keep service-role for admin/migration operations only.

### R2 — Secure Password Reset (CRITICAL priority)

Implement token-based password reset:
1. `POST /forgot-password` — generates a signed, time-limited reset token; emails it
2. `POST /reset-password` — validates token, updates password, invalidates token

Supabase Auth's built-in `generateLink()` function can do this without custom implementation.

### R3 — Apply `requireCompany` to Practice Module Mount

One-line fix: add `router.use(requireCompany)` at the top of `backend/modules/practice/index.js`. This ensures every practice route, including new ones added in the future, requires company context.

### R4 — Remove `|| 1` Fallbacks from Accounting Frontend

Replace every `|| 1` company ID fallback with an error state or redirect to login. Optionally read `activeCompanyId` from JWT decode rather than localStorage.

### R5 — Source Auth State from JWT Decode, Not localStorage

For `isSuperAdmin` and `hasCoachingAccess` in the dashboard, and `session` object in Payroll: derive these from client-side JWT decode (`atob(token.split('.')[1])`). This eliminates the mutable-localStorage problem. The JWT is not re-validated on the client (crypto verification requires the secret), but the payload is harder to falsify in a way that also deceives the backend (which validates the signature).

For coaching tile visibility specifically: always call `/api/auth/me` on dashboard load and use the DB-authoritative value.

### R6 — Content-Security-Policy Headers

Define and enable a strict CSP in Helmet:
```javascript
contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],  // adjust if inline styles are used
    connectSrc: ["'self'", "https://*.supabase.co"]
  }
}
```

### R7 — Token Revocation Mechanism

Short-term: add `is_active` check against `user_company_access` in `requireCompany` (one DB query per request). Long-term: implement refresh token pattern with short-lived access tokens (15 min) and longer-lived refresh tokens.

### R8 — Audit Log for Super Admin `X-Company-Id` Override

Add a log entry to `audit_logs` when a super admin uses the `X-Company-Id` header override, recording: `user_id`, `actual_company_id` (from JWT), `override_company_id`, `endpoint`, `method`, `timestamp`.

### R9 — Coaching Module Mount Guard

Add `authenticateToken` at the coaching module mount. Sub-routes that need coaching-specific auth can override with their own middleware. Makes the ecosystem-level auth the baseline.

### R10 — Clean Up Placeholder Super Admin Emails

Replace `user3@lorenco.co.za` and `user4@lorenco.co.za` in `sean-webapp/lib/auth.ts` with real provisioned users or remove them.

### R11 — Remove Coaching Debug Route

Remove `router.use('/debug', ...)` from coaching module immediately, or confirm it requires authentication.

### R12 — Company List Refresh on Dashboard Load

Always fetch `eco_companies` from `/api/auth/companies` on each dashboard load rather than serving from localStorage. Use localStorage only as a pre-load placeholder to avoid flash of empty state.

### R13 — sessionStorage for Demo and Transient State

Replace `localStorage` with `sessionStorage` for `eco_demos`, `eco_client_id`, and other transient UI state that should not persist across browser sessions.

---

## 19. Final Verdict

### Is the ecosystem safe for rollout?

**Partially.** The core data isolation mechanisms are working — JWT-embedded `companyId`, backend query scoping, and module-level access control are all functional. A regular user cannot accidentally see another company's data through normal use.

However, two CRITICAL issues prevent confident external-client rollout:
1. **No RLS policies** — the entire security model depends on application code. One missed `WHERE company_id` in any route exposes all tenants' data. For a system managing payroll, tax, and accounting, this is unacceptable without a database-level backstop.
2. **Unauthenticated password reset** — any person who knows a client's email address can take over their account. This is not theoretical; it is a published API endpoint with no security check.

### Which app is most dangerous?

**Practice Management** — it is the only module with inconsistent backend `requireCompany` coverage. Older sub-routes (clients, billing, workflows, tasks, deadlines, team) may lack company enforcement. This needs verification and one-line fix (`router.use(requireCompany)` in `practice/index.js`).

**Accounting frontend** — the `|| 1` fallback is a silent wrong-company display that could confuse practitioners and, in edge cases, lead to changes being made against the wrong company context.

### Which app is closest to correct?

**POS (Checkout Charlie)** — strongest isolation:
- JWT-derived `companyId` in memory (not localStorage)
- Backend `requireCompany` on all POS routes
- No business data in browser storage
- PIN login server-side with lockout
- Codebox 68 fixed the last known company isolation gap

**Inventory** — `requireCompany` applied at mount level; cleanest backend setup in the ecosystem.

### What must be fixed first?

Priority order (audit findings only — no implementation until instructed):

1. **RISK-02** — Secure password reset (CRITICAL — authentication bypass)
2. **RISK-01** — Define RLS policies (CRITICAL — defense-in-depth gap)
3. **RISK-05** — Add `requireCompany` to Practice module mount (HIGH — one-line fix, high coverage)
4. **RISK-06** — Remove `|| 1` accounting fallback (HIGH — silent wrong-company display)
5. **RISK-08** — Fix coaching tile drift — always read `has_coaching_access` from DB (HIGH — Rule F2 violation)
6. **RISK-03** — Token revocation mechanism (HIGH — 8-hour gap after access revoked)

### What can wait?

- **RISK-04, RISK-10** (localStorage `isSuperAdmin`) — backend is correctly protected. UI surface exposure is real but not a data risk. Medium priority.
- **RISK-09** (Audit logging for super admin override) — operational improvement, not an immediate security gap.
- **RISK-13** (CSP headers) — important for XSS hardening but no active XSS vector currently identified.
- **RISK-11** (Password minimum length) — minor, especially combined with Risk-02 fix.
- **RISK-14, RISK-15** (localStorage demo/client state) — low priority, no data exposure.
- **RISK-16, RISK-17, RISK-18** (Sean sessions, placeholder emails, debug route) — low risk, clean up when touching those areas.

---

*This report is discovery and forensic documentation only. No code was changed during this audit.*  
*All file references are relative to the repository root.*  
*Audit completed: 2026-06-25*
