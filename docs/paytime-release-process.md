# Paytime Safe Release Process
## Lorenco Ecosystem — Production Rollout Strategy

> **Audience:** Sean (developer/owner)
> **Last updated:** March 2026
> **Purpose:** A clear, daily-usable workflow that keeps live clients safe while you keep coding.

---

## OVERVIEW

The release process uses:
- **One codebase** — no duplicate apps, no manual copy/paste
- **Two branches** — `staging` (testing) and `main` (production)
- **Two Zeabur deployments** — staging environment and production environment
- **Feature flags** — so new code can exist in production but be hidden from clients until you're ready

```
You code → staging branch → staging Zeabur → you test safely
                                                    ↓
                                              happy? merge to main
                                                    ↓
                                            main → production Zeabur
                                                    ↓
                                            flag OFF for all clients
                                                    ↓
                                            flag ON for superuser → verify
                                                    ↓
                                            flag ON for test client → verify
                                                    ↓
                                            flag ON for all clients → done
```

---

## TABLE OF CONTENTS

1. [One-Time Setup — Read This First](#1-one-time-setup)
2. [Daily Workflow — Simple Steps](#2-daily-workflow)
3. [Branch Strategy](#3-branch-strategy)
4. [Deployment Environments](#4-deployment-environments)
5. [Feature Flags System](#5-feature-flags-system)
6. [How to Roll Out a New Feature Safely](#6-how-to-roll-out-a-new-feature-safely)
7. [Data Safety Rules](#7-data-safety-rules)
8. [Emergency Rollback](#8-emergency-rollback)
9. [Staging Environment Data Policy](#9-staging-environment-data-policy)
10. [Command Reference](#10-command-reference)

---

## 1. ONE-TIME SETUP

Do this once. Then never again.

### 1A. Create the staging branch

```bash
git checkout main
git pull origin main
git checkout -b staging
git push -u origin staging
```

### 1B. Create a second Supabase project for staging

1. Go to [supabase.com](https://supabase.com) → New project
2. Name it: `lorenco-staging` (or similar)
3. Choose the same region as production
4. Save the credentials:
   - Project URL (e.g. `https://xyz123.supabase.co`)
   - Service role key (under Settings → API)
   - Direct DB connection string (under Settings → Database → Connection string → URI)

> **WHY:** Staging must NEVER connect to the production database. If staging shares production Supabase, you risk overwriting live client data during testing. Two separate Supabase projects is the only safe approach.

### 1C. Create a second Zeabur service for staging

1. Go to your Zeabur project
2. Create a new service
3. Point it to the same GitHub repo
4. Set **Root Directory** = `accounting-ecosystem` (SAME as production — do not change this)
5. Set branch = `staging`
6. Add environment variables — copy from production but change:
   - `SUPABASE_URL` → your staging Supabase URL
   - `SUPABASE_SERVICE_KEY` → staging service key
   - `SUPABASE_ANON_KEY` → staging anon key
   - `DATABASE_URL` → staging direct connection string
   - `ACCOUNTING_DATABASE_URL` → staging direct connection string
   - `JWT_SECRET` → a DIFFERENT secret from production
   - `NODE_ENV` → `staging`
   - `APP_URL` → your staging Zeabur domain (e.g. `https://lorenco-staging.zeabur.app`)

Use `.env.staging.example` as the template (it's in `accounting-ecosystem/backend/`).

### 1D. Add GitHub secrets for staging migrations

1. Go to GitHub repo → Settings → Secrets → Actions
2. Add secret: `SUPABASE_DB_URL_STAGING` = your staging Supabase direct connection string
   - Format: `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres`

The existing `SUPABASE_DB_URL` secret remains for production.

### 1E. Run the feature flags migration on both databases

```bash
# Production
psql "$SUPABASE_DB_URL" -f accounting-ecosystem/backend/config/migrations/008_feature_flags.sql

# Staging
psql "$SUPABASE_DB_URL_STAGING" -f accounting-ecosystem/backend/config/migrations/008_feature_flags.sql
```

Or just push to `main` (production) and `staging` — the GitHub Actions workflows will apply them automatically.

---

## 2. DAILY WORKFLOW

Simple steps. Follow these every day.

### A. Start your day

```bash
git checkout staging
git pull origin staging
```

Open your Codespace / VS Code. You are on `staging`. Code freely.

### B. Code your changes

Work normally. Commit to staging:

```bash
git add <specific files>
git commit -m "feat: add enhanced payslip layout"
git push origin staging
```

→ GitHub Actions runs `staging-migrations.yml` → applies DB migrations to staging Supabase
→ Zeabur auto-deploys staging branch → your staging URL updates within ~2 minutes

### C. Test in staging

Open your staging Zeabur URL (e.g. `https://lorenco-staging.zeabur.app`).

Test thoroughly. Use test data. Break things. Fix things. Repeat.

**Live clients are on production. Staging cannot affect them.**

### D. When you are happy — merge to main

```bash
git checkout main
git pull origin main
git merge staging
git push origin main
```

→ GitHub Actions runs `apply-migrations.yml` → applies DB migrations to production Supabase
→ Zeabur auto-deploys main branch → production updates within ~2 minutes

### E. Check production is healthy

```
GET https://your-production-url.zeabur.app/api/health
```

Verify `"status": "healthy"`.

### F. Keep new features OFF for clients

Your new code is deployed. New features are hidden behind feature flags.

Clients see nothing new yet. Existing functionality is unchanged.

### G. Test in production as superuser

Your `isSuperAdmin=true` account automatically sees all feature-flagged features.

Test the new feature in production using your superuser account.

### H. Enable for test client

Once you verify as superuser, activate for your test client:

```http
PUT /api/feature-flags/PAYTIME_ENHANCED_PAYSLIP
Authorization: Bearer <your-super-admin-token>
Content-Type: application/json

{
  "is_active": true,
  "rollout_level": "test_client",
  "allowed_company_ids": [42]
}
```

(Replace `42` with your test client's company ID.)

Have someone on that test client verify the feature works for a real account.

### I. Roll out to all clients

Once confident, activate for everyone:

```http
PUT /api/feature-flags/PAYTIME_ENHANCED_PAYSLIP
{
  "is_active": true,
  "rollout_level": "all"
}
```

Done. Feature is live for all clients.

---

## 3. BRANCH STRATEGY

| Branch   | Purpose               | Deploys to        | DB                  |
|----------|-----------------------|-------------------|---------------------|
| `staging`| Development + testing | Staging Zeabur    | Staging Supabase    |
| `main`   | Production            | Production Zeabur | Production Supabase |

### Rules

- **Never push untested code directly to `main`.**
- Always work on `staging` first.
- Merge to `main` only when you have tested on staging.
- If you need a hotfix in production: fix on `staging` first, test, then merge to `main`.
  - For critical urgent fixes: you may fix directly on `main` but must merge back to `staging` immediately after.

### Do NOT create feature branches

The ecosystem is one person (Sean). Feature branches add overhead without benefit.
Use `staging` as your working branch. It works.

---

## 4. DEPLOYMENT ENVIRONMENTS

### Staging Environment

| Property         | Value                                 |
|------------------|---------------------------------------|
| Branch           | `staging`                             |
| Zeabur service   | Second Zeabur service (staging)       |
| Supabase project | Separate staging project              |
| JWT_SECRET       | Different from production             |
| NODE_ENV         | `staging`                             |
| Auto-deploys     | Yes, on push to `staging`             |
| Data             | Test data only — safe to delete/reset |

### Production Environment

| Property         | Value                                 |
|------------------|---------------------------------------|
| Branch           | `main`                                |
| Zeabur service   | Primary Zeabur service                |
| Supabase project | Production project                    |
| JWT_SECRET       | Strong random secret (set at launch)  |
| NODE_ENV         | `production`                          |
| Auto-deploys     | Yes, on push to `main`                |
| Data             | Live client data — NEVER touch        |

### DB Migrations

Migrations are applied by GitHub Actions:
- Push to `staging` → `staging-migrations.yml` → staging Supabase
- Push to `main` → `apply-migrations.yml` → production Supabase

All migrations are idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

---

## 5. FEATURE FLAGS SYSTEM

### What it is

A database table (`feature_flags`) that controls which features are visible to which users/companies.

Features can be activated gradually using rollout levels.

### Rollout levels

| Level              | Who can see the feature                          |
|--------------------|--------------------------------------------------|
| `disabled`         | Nobody (flag completely off)                     |
| `superuser`        | Super admins only (`isSuperAdmin=true`)          |
| `test_client`      | Super admins + companies in `allowed_company_ids`|
| `selected_clients` | Super admins + explicit company list (broader)   |
| `all`              | Everyone (full rollout)                          |

### Key behavior

- **Super admins ALWAYS see all feature-flagged functionality**, regardless of rollout level (except `disabled`). This lets you test any feature in production as yourself.
- Flags are cached for 2 minutes in memory. After an update, the change propagates within 2 minutes.
- Unknown flags (key not in DB) always return `false` → safe by default.

### Managing flags via API

All flag management requires super admin authentication.

**List all flags:**
```
GET /api/feature-flags
GET /api/feature-flags/app/paytime
```

**Create a flag:**
```http
POST /api/feature-flags
{
  "flag_key": "PAYTIME_NEW_FEATURE",
  "display_name": "New Feature Name",
  "description": "What this feature does",
  "app": "paytime",
  "is_active": false,
  "rollout_level": "disabled"
}
```

**Update a flag (e.g. promote rollout):**
```http
PUT /api/feature-flags/PAYTIME_NEW_FEATURE
{
  "is_active": true,
  "rollout_level": "test_client",
  "allowed_company_ids": [42]
}
```

**Check if a flag is enabled for current user:**
```
GET /api/feature-flags/check/PAYTIME_NEW_FEATURE
```

**Get all flags enabled for my context:**
```
GET /api/feature-flags/my-flags
```

### Using flags in backend (Node.js)

```javascript
const { featureFlags } = require('../../services/featureFlags');

// In a route handler:
const enabled = await featureFlags.isEnabled('PAYTIME_NEW_FEATURE', req);
if (!enabled) return res.status(404).json({ error: 'Feature not available' });

// Or use middleware to block a whole route:
const { requireFeatureFlag } = require('../../services/featureFlags');
router.get('/new-endpoint', requireFeatureFlag('PAYTIME_NEW_FEATURE'), handler);
```

### Using flags in frontend (Paytime HTML pages)

Include the helper:
```html
<script src="/payroll/js/feature-flags.js"></script>
```

Then:
```javascript
// Load all flags once at page start (one API call):
await FeatureFlags.loadAll();

// Check flag:
if (FeatureFlags.get('PAYTIME_ENHANCED_PAYSLIP')) {
  document.getElementById('newPayslipSection').style.display = '';
}

// Or guard an element directly:
FeatureFlags.guardElement(document.getElementById('bulkRunBtn'), 'PAYTIME_BULK_PAYRUN');

// Or check async:
const enabled = await FeatureFlags.isEnabled('PAYTIME_LEAVE_PORTAL');
if (enabled) initLeavePortal();
```

---

## 6. HOW TO ROLL OUT A NEW FEATURE SAFELY

Complete step-by-step for every new feature.

### Step 1 — Create the flag (in staging)

While developing, create the flag on staging:

```http
POST /api/feature-flags
{
  "flag_key": "PAYTIME_MY_FEATURE",
  "display_name": "My Feature Name",
  "description": "Brief description of what it does",
  "app": "paytime",
  "is_active": false,
  "rollout_level": "disabled"
}
```

### Step 2 — Guard your code with the flag

**Backend route:**
```javascript
router.get('/my-feature', requireFeatureFlag('PAYTIME_MY_FEATURE'), myHandler);
```

**Frontend:**
```javascript
FeatureFlags.guardElement(document.getElementById('myFeatureSection'), 'PAYTIME_MY_FEATURE');
```

### Step 3 — Test on staging

Push to staging. The feature is deployed but hidden (flag is `disabled`).

Enable the flag for yourself on staging:
```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{ "is_active": true, "rollout_level": "all" }
```

Test thoroughly. Fix issues. Push fixes. Test again.

### Step 4 — Merge to production

Once happy on staging:

```bash
git checkout main
git merge staging
git push origin main
```

Production deploys. The flag was created on staging — you need to also create it on production now:

```http
POST /api/feature-flags
{
  "flag_key": "PAYTIME_MY_FEATURE",
  "display_name": "My Feature Name",
  "description": "...",
  "app": "paytime",
  "is_active": false,
  "rollout_level": "disabled"
}
```

Clients see nothing new. Feature code exists but is hidden.

### Step 5 — Activate for yourself in production

As super admin, you automatically see all features in production.

Test the feature works as expected in the live environment.

### Step 6 — Activate for test client

```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{
  "is_active": true,
  "rollout_level": "test_client",
  "allowed_company_ids": [YOUR_TEST_CLIENT_COMPANY_ID]
}
```

Have someone on the test client account verify the feature.

### Step 7 — Roll out to all clients

```http
PUT /api/feature-flags/PAYTIME_MY_FEATURE
{ "is_active": true, "rollout_level": "all" }
```

Feature is live for everyone.

---

## 7. DATA SAFETY RULES

### The absolute rules

1. **Staging uses a separate Supabase project.** It never touches production data.
2. **Staging JWT secret is different from production.** A staging token cannot be used in production.
3. **Never test in production with real client data.** Use your superuser account with your own test data.
4. **Never run migrations directly against production.** Migrations are applied by CI (GitHub Actions) only.
5. **Never merge to `main` without testing on `staging` first.**

### If staging database needs to be reset

Staging Supabase can be reset at any time — it contains only test data. Run the migrations again to recreate the schema:

```bash
for f in accounting-ecosystem/backend/config/migrations/*.sql; do
  psql "$SUPABASE_DB_URL_STAGING" -f "$f"
done
```

### What lives where

| Data type                  | Location            | Can reset? |
|---------------------------|---------------------|------------|
| Live client payroll data  | Production Supabase | NEVER      |
| Live client company data  | Production Supabase | NEVER      |
| Test data for staging     | Staging Supabase    | Yes        |
| Feature flags (prod)      | Production Supabase | Only flags |
| Feature flags (staging)   | Staging Supabase    | Yes        |

---

## 8. EMERGENCY ROLLBACK

### If a production deployment breaks something

**Option 1 — Disable via feature flag (fastest)**

If the broken feature is behind a feature flag, set it back to `disabled`:

```http
PUT /api/feature-flags/PAYTIME_BROKEN_FEATURE
{ "is_active": false, "rollout_level": "disabled" }
```

Feature is hidden immediately for all clients. Zero downtime.

**Option 2 — Revert the commit**

```bash
git checkout main
git revert HEAD --no-edit
git push origin main
```

This creates a new commit that undoes the last change and deploys it.

**Option 3 — Zeabur manual rollback**

In the Zeabur dashboard, you can manually trigger a deploy of a previous build without code changes.

### After rollback

1. Investigate root cause on staging
2. Fix on staging
3. Test on staging
4. Merge fix to main
5. Re-verify production

---

## 9. STAGING ENVIRONMENT DATA POLICY

### What goes in staging

- Test employees with clearly fake names (e.g. "Test Employee 001")
- Test companies with clearly fake names (e.g. "Staging Test Co")
- Generated payroll data for testing scenarios
- Never real client names, tax numbers, bank details, or salaries

### Seeding staging with test data

After resetting staging, seed minimal test data:

1. Register via `/` (login page)
2. Create a test super admin account
3. Create a test company: "Staging Test Co"
4. Create 3–5 test employees with fake data
5. Create test payroll items

Keep a record of the test company ID — you will use it as `allowed_company_ids` when testing flags at `test_client` level.

---

## 10. COMMAND REFERENCE

### Git

```bash
# Start working on staging
git checkout staging && git pull origin staging

# Push to staging (triggers staging deploy)
git push origin staging

# Merge staging to production
git checkout main && git merge staging && git push origin main

# Emergency revert
git revert HEAD --no-edit && git push origin main
```

### Feature flag management (API)

Replace `<TOKEN>` with your super admin JWT token.

```bash
# List all flags
curl -H "Authorization: Bearer <TOKEN>" https://your-app.zeabur.app/api/feature-flags

# Create a flag
curl -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"flag_key":"PAYTIME_MY_FEATURE","display_name":"My Feature","app":"paytime","is_active":false,"rollout_level":"disabled"}' \
  https://your-app.zeabur.app/api/feature-flags

# Activate for superuser only
curl -X PUT -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"is_active":true,"rollout_level":"superuser"}' \
  https://your-app.zeabur.app/api/feature-flags/PAYTIME_MY_FEATURE

# Activate for test client (company ID 42)
curl -X PUT -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"is_active":true,"rollout_level":"test_client","allowed_company_ids":[42]}' \
  https://your-app.zeabur.app/api/feature-flags/PAYTIME_MY_FEATURE

# Full rollout
curl -X PUT -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"is_active":true,"rollout_level":"all"}' \
  https://your-app.zeabur.app/api/feature-flags/PAYTIME_MY_FEATURE

# Check if flag is enabled for current user
curl -H "Authorization: Bearer <TOKEN>" \
  https://your-app.zeabur.app/api/feature-flags/check/PAYTIME_MY_FEATURE

# Health check
curl https://your-app.zeabur.app/api/health
```

### Tests

```bash
cd accounting-ecosystem/backend
npx jest tests/featureFlags.test.js --verbose
npx jest --watchAll --testPathPattern=featureFlags
```

---

## RELATED FILES

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/services/featureFlags.js` | Core feature flag service |
| `accounting-ecosystem/backend/shared/routes/featureFlags.js` | Feature flag API routes |
| `accounting-ecosystem/backend/config/migrations/008_feature_flags.sql` | DB migration |
| `accounting-ecosystem/backend/config/feature-flags-schema.js` | Startup schema check |
| `accounting-ecosystem/frontend-payroll/js/feature-flags.js` | Paytime frontend helper |
| `accounting-ecosystem/backend/.env.staging.example` | Staging env var template |
| `.github/workflows/apply-migrations.yml` | Production CI (main branch) |
| `.github/workflows/staging-migrations.yml` | Staging CI (staging branch) |
| `CLAUDE.md` Part C | Zeabur deployment rules (never violate) |

---

*This document is the daily operational reference for safe Paytime releases.*
*Keep it updated whenever the release process changes.*
