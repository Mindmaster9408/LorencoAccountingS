# Eco Platform Access Architecture Audit

**Date:** 2026-06-26  
**Status:** Audit only — no code changed, no migration created  
**Scope:** Users, companies, access tables, auth routes, dashboard company switcher, app tiles  

---

## Executive Summary

The ecosystem has a solid 4-tier permission foundation that works correctly for the current usage pattern.
The gaps are not in the permission logic itself — they are in **identity structure**: the concept of
Practice Code and Client Code does not exist at the DB level, client uniqueness has no enforcement,
`isSuperAdmin` has a localStorage trust dependency, and the Platform Control Centre layer is implicit
(mixed into the dashboard) rather than explicit (a separate authority layer).

None of the gaps are production emergencies. All can be added as non-breaking migrations.

---

## 1. What Exists Today

### 1.1 Core Tables

#### `users`
Global identity table. One row per person across the entire ecosystem.

```
id, username, email, password_hash, full_name
is_super_admin BOOLEAN          -- platform authority flag
has_coaching_access BOOLEAN     -- coaching hard lock (Ruan only)
is_active BOOLEAN
role VARCHAR                    -- LEGACY: do not trust. Live role = user_company_access.role
```

**Status:** Works. `role` column is stale — no current code path writes to it, but its existence creates
a future read risk. Documented as follow-up in the permissions architecture doc.

#### `companies`
A company is the unit of data isolation. Both practice firms AND client businesses live in this table.
Distinguished by `account_holder_type`.

```
id, company_name, trading_name
registration_number, vat_number
modules_enabled TEXT[]          -- which apps are purchased/active for this company
account_holder_type VARCHAR     -- 'accounting_practice' | 'business_owner' | 'individual' | NULL
subscription_status VARCHAR     -- 'active' | 'demo' | 'inactive'
is_active BOOLEAN
is_demo BOOLEAN                 -- demo companies provisioned at registration
owner_user_id INTEGER           -- loosely linked, not used for auth
```

There is **no practice code field** (e.g. `PRAC-0001`). Practice firms are identifiable only by
`account_holder_type = 'accounting_practice'` — but this has no unique reference code.

#### `user_company_access`
The authoritative role link between a user and a company.

```
user_id, company_id
role VARCHAR                    -- authoritative role in this company context
is_primary BOOLEAN              -- preferred company at login
is_active BOOLEAN
apps_access TEXT[]              -- redundant with user_app_access (see §6 below)
```

`apps_access` on this table was the original app restriction mechanism (Migration 006).
It was superseded by `user_app_access` (Migration 009). Both exist simultaneously —
there are now **two app access columns** with overlapping (but inconsistently enforced) semantics.

#### `eco_clients`
The client registry. Links a managing practice to a client's isolated data silo.

```
id SERIAL                       -- sequential integer (NOT random)
company_id INTEGER              -- the MANAGING practice that owns this client record
client_company_id INTEGER       -- the client's isolated companies row (their data silo)
name VARCHAR
email, phone, id_number, address
apps TEXT[]                     -- which apps the client can use
client_type VARCHAR             -- 'individual' | 'business'
is_active BOOLEAN
```

There is **no client code field** (e.g. `CLI-00042` or random reference). The `id` is sequential
SERIAL — trivially guessable and meaningless as a business reference.

There is **no uniqueness constraint on registration number or ID number** within a practice. A practice
can add the same client twice with different names.

#### `user_app_access` (Migration 009)
Per-user, per-company, per-app grants.

```
user_id, company_id, app_key
-- UNIQUE (user_id, company_id, app_key)
-- Zero rows for (user_id, company_id) = unrestricted (all company-enabled apps)
-- Any rows = restrict to exactly those apps
```

#### `user_client_access` (Migration 010)
Per-user, per-company, per-eco_client visibility.

```
user_id, company_id, eco_client_id
-- UNIQUE (user_id, company_id, eco_client_id)
-- Zero rows for (user_id, company_id) = unrestricted (see all clients)
-- Any rows = restrict to exactly those eco_client_ids
```

#### `eco_client_firm_access` (Migration 008)
Firm-to-client read-only cross-visibility. Allows a second practice to see a shared client.

```
client_id, firm_company_id, granted_at
```

Currently used as a secondary visibility chain. Enforcement lives in `GET /api/eco-clients`.

---

### 1.2 Auth Routes

#### `POST /api/auth/login`
- Looks up user by username or email.
- Fetches all `user_company_access` rows for that user.
- Super admins land on "The Infinite Legacy" company by default.
- Issues JWT with `companyId`, `role`, `isSuperAdmin`, `hasCoachingAccess`.
- Returns `companies` list (annotated with `company_type`: practice | client | standalone).

#### `POST /api/auth/select-company`
- Validates the user has access to the requested company.
- For regular users: checks `user_company_access` directly OR follows the eco_client chain
  (practice user → eco_clients → client_company_id).
- Checks `user_client_access` delegated access for restricted-role users.
- Issues a new JWT with the updated `companyId` and `role`.
- Also reads `has_coaching_access` fresh from DB (not trusted from token) — correct.

#### `POST /api/auth/sso-launch`
- Takes `{ targetApp, companyId }`.
- Coaching hard lock: only `users.has_coaching_access = true` may launch coaching — no super admin bypass.
- Super admins: bypass all company checks, always granted.
- Regular users with direct `user_company_access` row: checks `user_app_access` gate.
- Regular users WITHOUT direct row: follows eco_client chain (practice → eco_clients → client_company_id).
  - Restricted-role users at practice: must also have `user_app_access` grant + `user_client_access` grant for the specific client.
- Issues an app-scoped JWT.

#### `GET /api/auth/companies`
- Returns only companies the user is explicitly linked to via `user_company_access`.
- Annotates each with `company_type` by cross-referencing `eco_clients`.
- Super admins receive only their explicit rows (not all companies) — correct post-fix.

---

### 1.3 Dashboard Company Switcher

Located in `frontend-ecosystem/dashboard.html`. Works as follows:

1. On login, `companies` array is loaded from the login API response.
2. User selects a company from the switcher → `selectCompany(idx)` updates `selectedCompany`.
3. `renderApps()` is called after each company switch.
4. No new API call for the switch — the company list was loaded at login.
5. A new token IS issued when clicking through to an app via `sso-launch` (which selects company at launch time).

**Gap:** After switching companies in the dashboard, the dashboard shows the new company's modules
but the in-memory JWT still contains the old `companyId`. The JWT is only updated by sso-launch or
by calling select-company. If any dashboard-level API call uses the old JWT companyId, it will hit
the wrong company. This is a latent cross-company data leak risk.

---

### 1.4 App Tiles (`renderApps()`)

Logic at `dashboard.html:2212`:

```
For each app in APP_DEFS:
  SEAN:     only if isSuperAdmin
  Coaching: only if currentUser.hasCoachingAccess === true (DB flag — no super admin bypass)
  Others:   only if isSuperAdmin OR (userAppsAccess is null OR app.key in userAppsAccess)
  isActive: userCanAccess AND (isSuperAdmin OR app.key in companyModules)
```

`isSuperAdmin` is sourced at line 1941 from `localStorage.getItem('eco_super_admin')` — **localStorage
is the primary trust source**. The JWT decode is used only as a fallback if the localStorage value
is false-y. This means that if a user manually sets `eco_super_admin=true` in their browser storage,
they pass the `isSuperAdmin` gate in the frontend before any API call. The backend still validates
on every request, so no real data is exposed — but they would see super-admin UI tiles.

---

## 2. What Is Missing for Practice Code

**Required:** A stable, human-readable, unique practice identifier (e.g. `PRAC-0002`).

**What exists today:** Nothing. A practice is identified only by:
- `companies.id` (sequential integer — not a business reference)
- `companies.account_holder_type = 'accounting_practice'`
- `companies.company_name` (free text, not unique, no format enforcement)

**Missing:**
- `companies.practice_code VARCHAR UNIQUE` — auto-generated on company creation for `accounting_practice` type
- Format: `PRAC-` + zero-padded sequential number or nanoid (e.g. `PRAC-0001`, `PRAC-0002`)
- Displayed in the dashboard header when logged in as a practice
- Used as a reference in cross-practice operations (e.g. eco_client_firm_access)

**Hard tenant boundary (PRAC-0002 cannot see PRAC-0003):**
Currently enforced at application layer only via the eco_client chain: `eco_clients.company_id` must
match the managing practice's company ID. There is no DB-level constraint preventing a rogue route
from returning all eco_clients regardless of company_id. The RLS Phase 1 migration (migration 091)
stages the DB-layer enforcement but does not activate it. Until Phase 3 enforcement is turned on,
inter-practice isolation depends entirely on every route correctly scoping `WHERE company_id = ?`.

An `eco_clients` row for PRAC-0002 can currently only be fetched through the `eco-clients.js` route,
which always scopes by `company_id`. But no foreign-key or policy prevents creating a cross-reference.

---

## 3. What Is Missing for Client Code

**Required:** A random, non-sequential, unique client reference (e.g. `CLI-A3F9` or `C-00042`).

**What exists today:** Only `eco_clients.id` (SERIAL — sequential, integer, meaningless as reference).

**Missing:**
- `eco_clients.client_code VARCHAR UNIQUE` — auto-generated at creation (random, not sequential)
  - Recommended format: nanoid-based 8-character alphanumeric (e.g. `CLT-X7K2M9`)
  - Must be globally unique (not just per-practice) to be useful as an external reference
- `eco_clients.registration_number_hash` or a uniqueness constraint on `(company_id, id_number)`
  to prevent the same client being added twice under the same practice
- `eco_clients.id_number` exists but has no unique index and no validation format

**Client profile uniqueness:**
Currently there is no constraint preventing a practice from adding the same client twice
(same person, different name, same reg no). The only soft guards are:
- `email` has no uniqueness constraint on eco_clients
- `id_number` has no uniqueness constraint on eco_clients

---

## 4. How Practice Users Work Today

A practice user is any user whose primary `user_company_access` row links to a company with
`account_holder_type = 'accounting_practice'`.

**Practice user flow:**
1. Login → JWT includes the practice company as `companyId`.
2. Dashboard shows clients managed by the practice via `GET /api/eco-clients?company_id=X`.
3. App tiles show modules enabled for the practice company.
4. To work on a client's data: launch a client app → sso-launch resolves through the eco_client chain.
5. Client access restrictions: `user_client_access` rows determine which clients the user can see.
   - Zero rows = can see all practice clients (unrestricted default).
   - Any rows = restricted to exactly those `eco_client_id`s.

**Gaps:**
- A practice user with zero `user_client_access` rows sees ALL clients of the practice automatically.
  New staff members are unrestricted by default — this is the safe backward-compatible behavior, but
  it means access must be explicitly restricted rather than explicitly granted.
- Once a practice user SSOs into a client's isolated company, they operate with their practice role
  inside that company's full data scope. There is no per-app content filtering inside the client app.
- If a practice user is removed from `user_company_access` (is_active = false), their
  `user_client_access` rows remain (cleaned up only on full user delete via cascade). Stale rows
  are harmless but create audit noise.

---

## 5. How Client Users Work Today

A client user is any user whose primary `user_company_access` row links to a company that is
referenced as `eco_clients.client_company_id` — i.e. they belong to an isolated client data silo.

**Client user flow:**
1. Registration creates a company row for the client and a `user_company_access` row with `business_owner`.
2. Login → JWT includes the client company as `companyId`.
3. Dashboard shows only the apps enabled for that client company.
4. Client management section is hidden (no practice clients to manage).
5. App tiles: only apps in the client company's `modules_enabled[]`.

**Gaps:**
- A client user can theoretically call `POST /api/auth/select-company` with any `companyId` value.
  The route checks `user_company_access` first — if there is no row, it follows the eco_client chain.
  A client user has no eco_client rows, so this would correctly 403. But if a client user were
  incorrectly given a `user_company_access` row to a practice company (e.g. by a bug in user management),
  they would gain practice-level access. There is no DB constraint preventing this.
- There is no `is_client_user` flag or type distinction on the `users` table. Practice staff and
  client users are structurally identical — only their `user_company_access` links distinguish them.
- A client who self-registers gets a demo Paytime company as a second company in their access list
  (see registration route, ~line 320). This means many client users have TWO companies in their
  `user_company_access`: their practice-assigned isolated company AND the auto-provisioned demo company.
  If the demo company persists beyond the trial period, this creates stale access.

---

## 6. Where Can Access Leak

| Risk | Severity | Current State |
|---|---|---|
| `isSuperAdmin` read from localStorage first | Medium | JS trusts `eco_super_admin` localStorage value as primary source. Backend still validates, so no data leak — but super-admin UI tiles would show. |
| `user_company_access.apps_access` vs `user_app_access` dual mechanism | Medium | Two overlapping columns. `apps_access` on `user_company_access` is checked at login/select-company. `user_app_access` table is checked at sso-launch. A user restricted in one mechanism but not the other could access apps they should not. |
| Zero `user_client_access` rows = unrestricted | Low-Medium | New practice users automatically see all clients. Intended behavior, but an administrator must remember to restrict access explicitly. |
| `users.role` stale column | Low | No current code reads it for auth decisions. Future code could accidentally read it. |
| Demo company persisting after trial | Low | Auto-provisioned demo companies remain in `user_company_access` after subscription_expires_at passes. No cleanup mechanism. |
| Client user select-company cross-check | Low | Client users cannot select a practice company today (no user_company_access row) — but the eco_client chain fallback runs before returning 403. No data escapes; one unnecessary DB query per blocked attempt. |
| Practice-to-practice isolation is application-only | Low (Phase 1) | RLS policies are staged (migration 091) but not enforced until Phase 3. All isolation depends on routes scoping `WHERE company_id = ?`. A route bug would break isolation. |
| Dashboard company switch without JWT refresh | Low-Medium | The in-memory JWT still holds the old companyId after a dashboard company switch. Dashboard-level API calls (not through sso-launch) could use the stale companyId. |

---

## 7. Database Changes Needed

### Required (for the new architecture)

**1. `companies.practice_code`**
```sql
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS practice_code VARCHAR(20) UNIQUE;
-- Auto-populate on INSERT for account_holder_type = 'accounting_practice'
-- Format: 'PRAC-' || LPAD(nextval('practice_code_seq')::TEXT, 4, '0')
-- Backfill existing practice companies
```

**2. `eco_clients.client_code`**
```sql
ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS client_code VARCHAR(20) UNIQUE;
-- Auto-populate at INSERT with a random non-sequential reference
-- Recommended: 'CLT-' || upper(substring(md5(random()::text), 1, 8))
-- Or use a BEFORE INSERT trigger
-- Backfill existing eco_clients
```

**3. Uniqueness constraint on client identity within a practice**
```sql
-- Prevent duplicate registration numbers within the same practice
CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_clients_practice_regnr
  ON eco_clients (company_id, id_number)
  WHERE id_number IS NOT NULL AND id_number != '';
```

**4. `companies` — enforce `practice_code NOT NULL` for new practice registrations**
```sql
-- Cannot add NOT NULL until all existing practices are backfilled.
-- Enforce in application code first, add NOT NULL constraint after backfill.
```

### Recommended (cleanup)

**5. Drop or clearly mark `users.role` as legacy**
```sql
-- Option A: Drop the column (breaking if any external tool reads it)
ALTER TABLE users DROP COLUMN IF EXISTS role;

-- Option B: Add a comment documenting it as dead
COMMENT ON COLUMN users.role IS 'LEGACY: Do not use for access decisions. Live role = user_company_access.role.';
```

**6. Align `user_company_access.apps_access` with `user_app_access`**

Two mechanisms for the same thing creates audit and enforcement confusion.
Recommended: deprecate `user_company_access.apps_access` (set to NULL for all rows) and
enforce exclusively through `user_app_access`. Remove the column in a future migration after
all reads of `apps_access` on `user_company_access` are removed from backend code.

**7. Demo company expiry cleanup**
```sql
-- Track trial expiry on eco_clients (not just companies)
ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ;
-- Background job or cron: deactivate demo companies past expiry
```

---

## 8. Backend Changes Needed

### Required

**1. Auto-generate `practice_code` on company creation**
- In `POST /api/auth/register`: after inserting the `companies` row for `account_holder_type = 'accounting_practice'`, generate and write `practice_code`.
- Use a DB sequence or select `MAX(practice_code)` + increment (with retry on conflict).

**2. Auto-generate `client_code` on eco_client creation**
- In `POST /api/eco-clients` (create client): generate and write `client_code` before insert.
- Use `crypto.randomBytes(4).toString('hex').toUpperCase()` prefixed with `CLT-`.

**3. Uniqueness check on client registration number / ID number**
- In `POST /api/eco-clients`: before insert, check if `id_number` already exists for the same `company_id`.
- Return 409 Conflict if duplicate detected, with a message identifying the existing record.

**4. Remove `isSuperAdmin` localStorage as primary source**
- Backend change: `GET /api/auth/me` already returns the correct value.
- All super-admin gating decisions must use the JWT claim only (decoded server-side on every request).
- The `eco_super_admin` localStorage key should be treated as a UI hint only, always refreshed from `/me` on load.

**5. Deprecate `user_company_access.apps_access` from all backend reads**
- Audit all routes that read `apps_access` from `user_company_access`.
- Replace with `user_app_access` table checks.
- Once all reads removed, stop writing to the column.

**6. Dashboard JWT refresh on company switch**
- Currently the dashboard switches the active company in-memory without refreshing the JWT.
- Either: call `POST /api/auth/select-company` on every dashboard company switch and store the new token.
- Or: explicitly document that no dashboard-level authenticated API calls use `companyId` from the JWT
  (only from the UI's `selectedCompany` object). Audit all dashboard-level API calls for this assumption.

### Recommended

**7. Add `practice_code` to login/select-company JWT response**
```javascript
// In select-company response, include:
practice_code: company.practice_code || null
```

**8. Client-user isolation check in select-company**
- When a client user calls `select-company`, verify the target company is not a practice company that
  manages them via eco_clients. Prevent client users from elevating to practice context.
- Check: if `target_company.account_holder_type = 'accounting_practice'` AND user has no explicit
  `user_company_access` row as staff, reject with 403.

---

## 9. Frontend / Dashboard Changes Needed

### Required

**1. Fix `isSuperAdmin` trust source**

Current (unsafe):
```javascript
isSuperAdmin = localStorage.getItem('eco_super_admin') === 'true';
```

Required:
```javascript
// Always derive from JWT or the /me endpoint response
// localStorage is a cache only — never the authority
isSuperAdmin = !!payload.isSuperAdmin;  // from JWT decode, validated by /me refresh
```

The `renderApps()` function and all `isSuperAdmin` checks in the dashboard must use the JWT-derived
value, not the localStorage-derived one. The `/me` call already runs at startup — its result should
be the authority.

**2. Display Practice Code in dashboard header**

When the logged-in company is a practice (`account_holder_type = 'accounting_practice'`), display
the practice code prominently:
- Company header area: "Lorenco Accounting / PRAC-0001"
- Use as an identifier when displaying clients managed by this practice

**3. Display Client Code on client cards**

In the Clients section of the dashboard, each client card should show the `client_code` as a
reference number beneath the client name. This enables staff to reference specific clients without
using ambiguous names.

**4. Company switcher: type-tagged entries**

The company switcher currently shows a flat list. Required:
- Tag each company with its type: `[Practice]`, `[Client]`, `[Business]`
- Group or visually separate practice companies from client companies

**5. Platform Control Centre: explicit super-admin layer**

Currently super-admin sections (Admin Panel button, superAdminSection div) are mixed into the
regular dashboard. Required architecture:
- Platform layer should be a distinct mode or overlay: not just additional buttons on the same page
- Platform layer shows: all companies, all practices, all clients, system health, user audit
- Platform layer access: `isSuperAdmin === true` only, sourced from JWT

**6. Client-only login: hide practice management entirely**

When `isOwnerOnly === true` (user has only client companies, no practice), the dashboard already
hides `clientManagementSection`. This is correct. Verify that Practice Settings, Team Management,
and the company switcher are also hidden or show only the user's own company.

---

## 10. Safe Migration Plan

All changes below are non-breaking additions. No existing data is changed.

### Phase A — Database additions (run in Supabase SQL Editor)

**A1.** Add `companies.practice_code` (nullable VARCHAR UNIQUE).
**A2.** Backfill `practice_code` for existing `account_holder_type = 'accounting_practice'` companies.
**A3.** Add `eco_clients.client_code` (nullable VARCHAR UNIQUE).
**A4.** Backfill `client_code` for all existing `eco_clients` rows (random codes).
**A5.** Add unique partial index on `eco_clients (company_id, id_number)` where id_number is not null.
**A6.** Add `COMMENT ON COLUMN users.role` as legacy marker.

Each step is idempotent (IF NOT EXISTS, idempotent backfills).

### Phase B — Backend (deploy with next server release)

**B1.** Auto-generate `practice_code` in `POST /api/auth/register` for accounting practices.
**B2.** Auto-generate `client_code` in `POST /api/eco-clients`.
**B3.** Add duplicate id_number check in `POST /api/eco-clients`.
**B4.** Include `practice_code` in `select-company` and `sso-launch` JWT response.
**B5.** Begin migrating `user_company_access.apps_access` reads to `user_app_access` — keep both working during transition.

No breaking changes. Old eco_clients without `client_code` (null) continue working — the code generates
for new records only.

### Phase C — Frontend (deploy with B or after)

**C1.** Fix `isSuperAdmin` to trust JWT/`/me` response, not localStorage.
**C2.** Display `practice_code` in dashboard header when logged in as a practice.
**C3.** Display `client_code` on client cards.
**C4.** Tag company switcher entries with type.

### Phase D — Cleanup (future session, after stabilization)

**D1.** Drop `user_company_access.apps_access` column once all reads migrated to `user_app_access`.
**D2.** Drop `users.role` column after confirming no code path reads it.
**D3.** Add demo company expiry cleanup mechanism.
**D4.** Add client-user isolation check in `select-company` to prevent practice elevation.

### Phase E — RLS enforcement (separate track — see docs/RLS_IMPLEMENTATION_PLAN_2026-06-25.md)

**E1.** Migration 091 (Phase 1 policies) is already created — run in Supabase (inert while service-role is used).
**E2.** Phase 2: set up pg Pool session variable injection.
**E3.** Phase 3+: enable enforcement per wave (non-critical modules first, payroll last).

---

## Appendix: Current Access Model Diagram

```
PLATFORM LAYER (invisible to all except super users)
  └── The Infinite Legacy company [is_super_admin users]
        └── All practices, all clients, system admin

PRACTICE LAYER (account_holder_type = 'accounting_practice')
  └── PRAC-0001 — Lorenco Accounting [company row]
        ├── Practice users [user_company_access → PRAC-0001 company]
        │     ├── business_owner  — full access, all clients
        │     ├── accountant      — full access, assigned clients only (user_client_access)
        │     └── employee        — restricted by user_app_access + user_client_access
        └── eco_clients [managed by this practice]
              ├── CLI-A3F9 — Turkstra Hardware → client_company_id = companies.id (X)
              ├── CLI-B7K2 — Katlego Retail   → client_company_id = companies.id (Y)
              └── CLI-C1M5 — Demo Company     → client_company_id = companies.id (Z)

CLIENT LAYER (client's isolated data silo)
  └── Company X — Turkstra Hardware [client_company_id, standalone company row]
        ├── Client owner/staff [user_company_access → Company X]
        └── App data (POS sales, payroll, accounting) — scoped to company_id = X
```

```
TENANT ISOLATION TODAY (application-layer, not DB-layer):
  eco_clients.company_id = PRAC-0001's companies.id
  → All queries scoped: WHERE company_id = req.companyId
  → Route bug = isolation breach (no DB backstop until RLS Phase 3)
```

---

## Key Findings Summary

| Finding | Gap Type | Priority |
|---|---|---|
| No `practice_code` field | Missing identity | High |
| No `client_code` field | Missing identity | High |
| `isSuperAdmin` sourced from localStorage | Security risk (frontend) | High |
| No client uniqueness by reg no / ID no | Data integrity | Medium |
| Two overlapping app-access mechanisms | Audit confusion | Medium |
| Dashboard company switch does not refresh JWT | Latent cross-company risk | Medium |
| Practice-to-practice isolation is application-only | Architectural gap (until RLS Phase 3) | Medium |
| `users.role` stale column | Technical debt | Low |
| Demo company expiry not enforced | Data hygiene | Low |
| Client user elevation check missing | Defense-in-depth | Low |
