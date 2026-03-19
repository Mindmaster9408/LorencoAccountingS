# Session Handoff — 2026-03-19

## WHAT THIS SESSION DID

Two things were completed:
1. Built and deployed a full safe release process (staging branch + feature flags)
2. Found and fixed a production bug: saving VAT number on company.html returned 500

---

## 1. PRODUCTION BUG FIXED — VAT NUMBER 500 ERROR

**Symptom:** Pressing Save on the accounting company.html page (when entering VAT number or VAT registration details) returned a 500 error.

**Root cause:** The `vat_number` column was never added to the `companies` table. It existed in the `suppliers` table but was missing from the `companyColumns` list in `accounting-schema.js`. The PUT route tried to write `companies.vat_number` → Supabase threw 500.

**Fix applied:**
- `accounting-ecosystem/backend/config/accounting-schema.js` — added `vat_number VARCHAR(50)` to companyColumns
- `accounting-ecosystem/backend/config/migrations/009_companies_vat_number.sql` — standalone migration SQL

**Status:** Pushed to `main`. GitHub Actions CI is applying migration 009 to production Supabase automatically. Once CI completes (~2 min after push), saving VAT number will work. No further action needed.

---

## 2. SAFE RELEASE PROCESS — WHAT WAS BUILT

### Branches (both live on GitHub now)
| Branch | Purpose |
|--------|---------|
| `main` | Production — deploys to live Zeabur service |
| `staging` | Your daily work branch — safe testing, does NOT affect live clients |

**You are currently on: `staging`**

### Files Created
| File | What it does |
|------|-------------|
| `accounting-ecosystem/backend/services/featureFlags.js` | Core feature flag service — DB-backed, cached |
| `accounting-ecosystem/backend/shared/routes/featureFlags.js` | API endpoints for managing + checking flags |
| `accounting-ecosystem/backend/config/migrations/008_feature_flags.sql` | Creates `feature_flags` table in Supabase + 5 seed Paytime flags |
| `accounting-ecosystem/backend/config/feature-flags-schema.js` | Startup check — warns if table missing |
| `accounting-ecosystem/backend/server.js` | Updated — mounts `/api/feature-flags` routes |
| `accounting-ecosystem/frontend-payroll/js/feature-flags.js` | Paytime frontend helper (`FeatureFlags.isEnabled()` etc.) |
| `.github/workflows/staging-migrations.yml` | CI for staging branch — applies migrations to staging Supabase |
| `accounting-ecosystem/backend/.env.staging.example` | Template for staging Zeabur environment variables |
| `docs/paytime-release-process.md` | Full daily workflow documentation — READ THIS |
| `accounting-ecosystem/backend/tests/featureFlags.test.js` | 20 unit tests for feature flag rollout logic |

### Feature Flag Rollout Levels
```
disabled → superuser → test_client → selected_clients → all
```
- **Super admins always see all flagged features** regardless of level (so you can test in production as yourself)
- Flags are DB-backed, updated without restart, cached 2 minutes

---

## 3. WHAT YOU STILL NEED TO DO (ONE-TIME SETUP)

The code is all in place. You need to set up the staging environment infrastructure.

### Step 1 — Create a staging Supabase project
- Go to supabase.com → New project → name it `lorenco-staging`
- Save: project URL, service role key, anon key, direct DB connection string

### Step 2 — Create a staging Zeabur service
- New Zeabur service → same GitHub repo
- Root Directory: `accounting-ecosystem` (same as production — do NOT change)
- Branch: `staging`
- Env vars: copy from production but replace all `SUPABASE_*` with staging credentials
- `JWT_SECRET`: use a different value from production
- `NODE_ENV`: `staging`
- Template: `accounting-ecosystem/backend/.env.staging.example`

### Step 3 — Add GitHub secret for staging migrations
- GitHub repo → Settings → Secrets → Actions → New secret
- Name: `SUPABASE_DB_URL_STAGING`
- Value: your staging Supabase direct connection string
  - Format: `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres`

### Step 4 — Run feature flags migration on production Supabase
Migration 008 (feature_flags table) was already pushed to `main`. GitHub Actions will apply it automatically. If it hasn't run yet, you can also run it manually in Supabase SQL Editor:
```
accounting-ecosystem/backend/config/migrations/008_feature_flags.sql
```

---

## 4. DAILY WORKFLOW GOING FORWARD

```
1. git checkout staging && git pull origin staging
2. Code your changes
3. git add <files> && git commit -m "..." && git push origin staging
4. Test on your staging Zeabur URL
5. When happy: git checkout main && git merge staging && git push origin main
6. Production deploys automatically
7. Use feature flags to control who sees new features
```

Full documentation: `docs/paytime-release-process.md`

---

## 5. FEATURE FLAGS — HOW TO USE ONCE TABLE EXISTS

**Create a flag (via API, super admin token):**
```http
POST /api/feature-flags
{ "flag_key": "PAYTIME_MY_FEATURE", "display_name": "My Feature", "app": "paytime", "is_active": false, "rollout_level": "disabled" }
```

**Activate for yourself only:**
```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{ "is_active": true, "rollout_level": "superuser" }
```

**Activate for a test client (company ID e.g. 42):**
```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{ "is_active": true, "rollout_level": "test_client", "allowed_company_ids": [42] }
```

**Full rollout:**
```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{ "is_active": true, "rollout_level": "all" }
```

---

## 6. CURRENT GIT STATE

```
Branch:  staging (your daily work branch)
main:    clean, up to date with origin/main
staging: clean, up to date with origin/staging
```

Both branches are identical right now (staging was just merged to main and pushed).

---

## 7. OPEN ISSUES (NOT CHANGED THIS SESSION)

These were pre-existing — not introduced today:

1. **pg Pool DATABASE_URL in Zeabur** — journals, accounts, bank, suppliers, reports still use pg Pool. If `DATABASE_URL` not set in Zeabur → those routes return 500. Fix: add Supabase direct connection string as `DATABASE_URL` in Zeabur env vars.
2. **reports.html P&L subtotals** — backend returns structured data but frontend still renders flat.
3. **Customer invoice detail modal** — clicking customer name shows stub alert.
4. **Customer payments list tab** — placeholder only.

---

*Come back, read this file, then check `docs/paytime-release-process.md` for full workflow details.*

---

# SESSION HANDOFF ADDENDUM — 2026-03-19 (Part 2)
## Multi-Tenant Access Fix: Paytime + Ecosystem

---

## WHAT WAS CHANGED (PART 2)

### Root Cause Summary

**The core multi-tenant access bug**: Non-superadmin accounting firm employees (accountants, payroll admins) could NOT open client companies in Paytime. The system was designed correctly for superadmins but broke for everyone else in 3 different places.

---

### File 1: `accounting-ecosystem/frontend-payroll/company-selection.html`

**CRITICAL FIX — `selectCompany(companyId)`**: Replaced `AUTH.selectCompany()` (which called `POST /api/auth/select-company`) with a direct `POST /api/auth/sso-launch` call.

`select-company` requires a `user_company_access` row for the target company. Accountants at a firm have no such row for client companies — access is via the eco_client chain. Only `sso-launch` handles this correctly. Result: all non-superadmins got 403 when trying to open a client in Paytime.

**ALSO FIXED — `loadEcoClients()`**: Now uses `eco_token || token` for the eco-clients query. When navigating back from company-dashboard.html (where the payroll token has CLIENT_COMPANY_ID), the eco-clients query would return empty results without this fix. `eco_token` always has the firm's company_id.

---

### File 2: `accounting-ecosystem/frontend-payroll/company-dashboard.html`

**CRITICAL FIX — `switchToCompany(companyId)`**: Was only updating `localStorage.session.company_id` without issuing a new JWT. After the "switch", API calls still carried the OLD company's JWT → wrong data shown. Now calls `sso-launch` to get a new scoped JWT, stores it, updates session, reloads.

**CRITICAL FIX — `loadCompaniesCarousel()`**: Was reading only from the `availableCompanies` localStorage cache (set at login, contains only the firm from `user_company_access`). Clients never appeared in the sidebar switcher. Now fetches eco-clients via `GET /api/eco-clients?app=payroll` using `eco_token || token` and renders both firm and all managed clients. Clients show with `↗` suffix and turn green when active.

**MINOR FIX — company name display in `loadDashboard()`**: `AUTH.getCompanyById()` only searches the login-time cache and fails for client companies. Now falls back to `session.company_name` → `company` localStorage key → 'Unnamed Company'.

---

### File 3: `accounting-ecosystem/backend/shared/routes/auth.js`

**BACKEND SAFETY NET — `POST /api/auth/select-company`**: Added eco_client indirect access support. If no direct `user_company_access` row exists for the target company, now applies the same eco_client chain lookup as `sso-launch` (fetch user's practices → check eco_clients → verify role). This also fixes the accounting app's `navigation.js` company switcher, which calls `select-company`.

---

## BUGS FIXED

| Bug | Symptom | File |
|-----|---------|------|
| `selectCompany()` using wrong endpoint | 403 for all non-superadmins selecting client in Paytime | `company-selection.html` |
| `loadEcoClients()` using wrong token when navigating back | Client list empty on company-selection after returning from dashboard | `company-selection.html` |
| `switchToCompany()` not issuing new JWT | API calls showed wrong company's data after switch | `company-dashboard.html` |
| `loadCompaniesCarousel()` reading from login cache only | Sidebar only showed firm, never clients | `company-dashboard.html` |
| Company name blank in Paytime header for clients | `getCompanyById()` fails for client companies | `company-dashboard.html` |
| `select-company` blocking indirect access | Accounting app company switcher broken for non-superadmins | `auth.js` |

---

## TESTING REQUIRED

1. **Accountant at Firm A opens Paytime for Client X from ecosystem dashboard** → should reach client's dashboard
2. **Direct Paytime login as firm accountant** → company-selection shows firm AND clients → clicking client works
3. **Paytime sidebar company switcher** → shows firm AND all managed clients → switching loads correct client data
4. **Sub-user (payroll_admin) at firm** → can launch Paytime for any client via ecosystem
5. **Navigate back: company-dashboard → company-selection** → clients still visible (eco_token used)
6. **Accounting app company switcher** → works for non-superadmin firm employees

---

## FOLLOW-UP NOTES

```
FOLLOW-UP NOTE
- Area: frontend-payroll/users.html
- Dependency: Uses legacy AUTH.USERS / AUTH.getRegisteredUsers() (localStorage-based)
- Confirmed now: Not a blocker — only business_owner/admin roles can access this page
- Not yet confirmed: Whether firm owners need to see API-managed users here
- Risk if not checked: Users created via ecosystem dashboard API don't appear in Paytime users.html
- Recommended next check: When Paytime user management is needed, rewrite to call GET /api/users
```

```
FOLLOW-UP NOTE
- Area: AUTH.selectCompany() in frontend-payroll/js/auth.js
- Dependency: Method still calls select-company endpoint
- Confirmed now: company-selection.html no longer calls AUTH.selectCompany()
- Not yet confirmed: Whether any other Paytime page calls AUTH.selectCompany()
- Risk if not checked: Low — backend select-company now supports eco_client chain too
- Recommended next check: Audit all Paytime pages for AUTH.selectCompany() usage
```
