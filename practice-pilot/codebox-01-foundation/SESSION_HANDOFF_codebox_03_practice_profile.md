# SESSION HANDOFF — CODEBOX 03 — PRACTICE PROFILE FOUNDATION

> Date: May 2026
> Status: COMPLETE
> Codebox type: Migration + Backend + Frontend

---

## Status

**COMPLETE.** Tenant-level Practice Profile built from migration to frontend form.

---

## Files Created This Codebox

| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/054_practice_profile.sql` | `practice_profiles` table — INTEGER PK, UNIQUE on company_id |
| `accounting-ecosystem/frontend-practice/profile.html` | 6-section profile form (Identity, Contact, Address, Defaults, Branding, Notes) |
| `accounting-ecosystem/frontend-practice/js/profile.js` | Profile load/create/update logic, user picker, auth guard |
| `practice-pilot/codebox-01-foundation/03_practice_profile_foundation.md` | Build record |
| `practice-pilot/codebox-01-foundation/SESSION_HANDOFF_codebox_03_practice_profile.md` | This file |

---

## Files Modified This Codebox

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `GET/POST/PUT /api/practice/profile` + `sanitizeProfileBody()` helper |
| `accounting-ecosystem/frontend-practice/js/layout.js` | Added `{ key: 'profile', label: 'Profile', href: '/practice/profile.html' }` as last nav item |
| `accounting-ecosystem/frontend-practice/css/practice.css` | Added `.notice-banner` class (informational blue banner for "no profile yet" state) |

---

## What Was Confirmed Safe (pre-commit validation checklist)

- [ ] Migration uses `SERIAL PRIMARY KEY` (INTEGER) — matches all existing practice_* tables
- [ ] `company_id UNIQUE` — one profile per company enforced at DB level
- [ ] No business data in localStorage — `profile.js` reads/writes only via API
- [ ] Auth guard present: token check → `/api/auth/me` → LAYOUT.init → load data
- [ ] Script load order correct: polyfills.js → auth.js → api.js → layout.js → profile.js
- [ ] `sanitizeProfileBody()` prevents injection of `id`, `company_id`, `created_at` from client
- [ ] Audit trail: CREATE and UPDATE events logged via `auditFromReq()` with `{ module: 'practice' }`
- [ ] `PGRST116` (no rows) handled in GET — returns null, not 500
- [ ] POST returns 409 on duplicate company_id — prevents double-create race condition
- [ ] `updated_at` set manually in PUT handler — consistent with existing practice routes
- [ ] Province CHECK constraint in DB matches SELECT options in form HTML exactly
- [ ] All form `<label>` elements have `for` attributes
- [ ] All `<select>` elements have `aria-label` attributes
- [ ] No `type="button"` missing on non-submit buttons (no non-submit buttons on this page)
- [ ] Existing navigation pages (dashboard, clients, tasks, time, deadlines) unaffected
- [ ] No changes to `paytime.*`, `frontend-payroll/`, or any other app

---

## Architecture

```
/api/practice/profile
  GET    → practice_profiles WHERE company_id = req.companyId
  POST   → INSERT practice_profiles (company_id from JWT, not body)
  PUT    → UPDATE practice_profiles WHERE company_id = req.companyId

frontend-practice/
├── profile.html      ← 6-section form
└── js/
    └── profile.js    ← load/create/update logic
```

**Profile mode logic:**
```
GET returns null   →  profileMode = 'create'  →  POST on submit
GET returns object →  profileMode = 'update'  →  PUT on submit
After POST success →  profileMode = 'update'  →  subsequent saves use PUT
```

---

## Backend Endpoints Added

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/practice/profile` | Read practice profile (null if not created yet) |
| `POST` | `/api/practice/profile` | Create practice profile (once per company) |
| `PUT` | `/api/practice/profile` | Update practice profile |

All inherit `authenticateToken` + `requireModule('practice')` from router registration.

---

## Key Technical Decisions

**INTEGER not UUID** — The Codebox 03 spec hinted at UUIDs, but the actual database schema uses `SERIAL INTEGER` for all practice_* tables and all other tables in this ecosystem. The migration uses `SERIAL PRIMARY KEY` to match.

**No FK on `default_task_assignee_id`** — The users table lives in `auth.users` (Supabase). Adding a FK across schemas creates migration complexity. Soft reference with application-layer validation is the correct approach here.

**`updated_at` manual, no DB trigger** — Existing practice routes (clients, tasks) set `updated_at: new Date().toISOString()` manually in `PUT` handlers. Matching this pattern avoids introducing a DB trigger inconsistency.

**`sanitizeProfileBody()` allowlist** — Explicit allowlist of 20 permitted fields prevents any client-supplied field (id, company_id, created_at) from passing through to Supabase. Same pattern as existing `allowed` array in `PUT /clients/:id`.

**Profile in last nav position** — Profile is a settings/admin page. Placed last in nav to keep day-to-day workflow pages (Clients, Tasks, Time, Deadlines) in the primary positions.

---

## Open Risks / Follow-ups

| # | Risk | Severity | Recommended Action |
|---|---|---|---|
| RF01 | `default_task_assignee_id` soft ref — stale if user leaves company | LOW | Validate on load; show warning if assignee not in `/api/practice/users` |
| RF02 | Province constraint in DB must exactly match HTML SELECT options | MEDIUM | Verify after migration runs — test a province save end-to-end |
| RF03 | `primary_colour` / `logo_url` stored but not yet applied to app UI | LOW | Codebox 04+ branding pass |
| RF04 | `fiscal_year_end_month` stored but not connected to deadline generation | LOW | Codebox 04+ deadline automation |
| RF05 | Migration `054_practice_profile.sql` not yet applied to Supabase | REQUIRED | Run in Supabase SQL Editor before testing |

---

## Required Action Before Testing

**Run migration in Supabase SQL Editor:**
```sql
-- Copy contents of: accounting-ecosystem/database/migrations/054_practice_profile.sql
-- Paste into Supabase SQL Editor → Run
```

---

## Recommended Codebox 04

**Goal:** Client Profile Detail page + Reports

1. Build `client.html` — single client view with embedded Tasks / Time / Deadlines tabs
2. Build `reports.html` — time summary per client (billable hours, rate, total)
3. Connect `fiscal_year_end_month` from profile to auto-generate provisional tax and year-end deadlines
4. Apply `primary_colour` from profile to topbar accent (branding pass)
5. Add `limit`/`offset` server-side pagination to deadlines and tasks backend
6. Add `assigned_to` display name join in task queries (show name, not just ID)

---

## What Was NOT Changed

- No changes to `server.js` — router registration unchanged
- No changes to `frontend-practice/js/auth.js` — kept exactly as found
- No changes to any Paytime files
- No changes to Inventory, POS, Accounting, or ECO Hub apps
- No environment variables added
- Nothing committed or pushed — all changes are local only
