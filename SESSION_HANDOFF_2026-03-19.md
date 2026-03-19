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
