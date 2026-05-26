# LORENCO PRACTICE — FOUNDATION AUDIT
# Codebox 01: Discovery & Safe Build Plan

> Date: May 2026
> Status: COMPLETE
> Auditor: Claude (Principal Architect role)

---

## 1. Executive Summary

**App:** Lorenco Practice — Accounting Practice Management  
**Purpose:** Client files, tasks, deadlines, and time tracking for accounting practices.

The app is **partially built**. The backend is production-complete with full CRUD, company scoping, and audit logging. The database has 4 fully deployed tables. The frontend is a functional single-file placeholder that needs to be refactored into a proper multi-page application matching the quality of Paytime and Accounting.

| Layer | Status |
|---|---|
| Eco dashboard tile | ✅ Exists |
| Backend routes | ✅ Production-complete |
| Database tables | ✅ Deployed (migrations 007 + 011) |
| Frontend | ⚠️ Single placeholder `index.html` — functional but incomplete |
| Auth JS | ✅ `frontend-practice/js/auth.js` exists (API-backed) |
| Company selection flow | ❌ Missing — no company-selection.html |
| Polyfills / safeLocalStorage | ⚠️ Auth shim only — no polyfills.js |

---

## 2. Existing Eco Tile / Box

**File:** `accounting-ecosystem/frontend-ecosystem/dashboard.html`  
**Lines:** ~1883–1890 (within the `ECOSYSTEM_APPS` array)

```javascript
{
  key:      'practice',
  name:     'Lorenco Practice',
  subtitle: 'Practice Management',
  icon:     '📋',
  desc:     'Client files, tasks, deadlines and time tracking for your accounting practice.',
  path:     '/practice',
  cssClass: 'practice',
}
```

**Visibility rules:**
- Tile is rendered for all users whose company has `practice` in `modules_enabled`.
- Disabled (0.4 opacity, "○ Not Activated") if the module is not in the company's `modules_enabled` array.
- Enabled by `MODULE_PRACTICE_ENABLED=true` environment variable (backend) and the company record.
- Click target: `/practice` — served as static HTML by `server.js` line 538.

**Route serving (server.js lines 399, 538–540):**
```javascript
const practiceFrontendPath = path.join(__dirname, '..', 'frontend-practice');
app.use('/practice', express.static(practiceFrontendPath));
app.get('/practice/*', (req, res) => {
  res.sendFile(path.join(practiceFrontendPath, 'index.html'));
});
```

---

## 3. Current Frontend Footprint

**Location:** `accounting-ecosystem/frontend-practice/`

```
frontend-practice/
├── index.html                  (51.5 KB — single-page placeholder app)
├── js/
│   └── auth.js                 (API-backed auth, safeLocalStorage shim)
├── lorenco-logo-cropped.png
└── lorenco-logo-exact-reference.png
```

**What `index.html` currently contains:**
- Purple/violet accent colour scheme (`--accent: #a78bfa`, `--accent-2: #7c3aed`)
- Sticky topbar with back button and company badge
- Tab navigation: Clients | Tasks | Time | Deadlines
- Stats bar (5 KPI cards: total clients, open tasks, overdue, upcoming deadlines, hours this month)
- All 4 sections with table UIs and Add/Edit modals
- Calls all `/api/practice/*` endpoints
- Uses `safeLocalStorage.getItem('token')` for auth — routed via auth.js shim

**What is MISSING from the frontend:**
- No `company-selection.html` — user goes directly to `index.html` with no company selector
- No `polyfills.js` — business data safety not enforced
- No login page (assumed to arrive via SSO from ecosystem dashboard)
- No pagination (all data loaded in bulk)
- No proper empty states or error boundaries
- No date pickers (plain text inputs for dates)
- No inline task status change (must open full edit modal)
- No client detail / profile page
- No time tracking summary / billing report
- No deadline calendar view
- No document management
- No filtering on deadline type, time period billing

---

## 4. Current Backend Footprint

**File:** `accounting-ecosystem/backend/modules/practice/index.js` (370 lines)

**Registration in server.js (lines 378–388):**
```javascript
if (practiceRoutes) {
  app.use('/api/practice',
    authenticateToken,
    requireModule('practice'),
    practiceRoutes
  );
}
```

Auth: `authenticateToken` → JWT validated → `req.companyId` set → `requireModule('practice')` checks company modules_enabled.

**Implemented endpoints:**

| Method | Route | Description |
|---|---|---|
| GET | `/api/practice/status` | Health check |
| GET | `/api/practice/dashboard` | 5 KPI stats (clients, tasks, overdue, upcoming, hours) |
| GET/POST/PUT | `/api/practice/clients` | CRUD for practice clients |
| GET | `/api/practice/clients/:id` | Single client |
| GET/POST/PUT/DELETE | `/api/practice/tasks` | CRUD for tasks (filters: client_id, status, assigned_to, type, due range) |
| GET/POST/PUT/DELETE | `/api/practice/time-entries` | CRUD for time entries (filters: client, task, user, date range) |
| GET/POST/PUT/DELETE | `/api/practice/deadlines` | CRUD for deadlines (filters: client, status, date range) |

**Company scoping:** Every query filters by `req.companyId`. No cross-company leakage is possible via these routes.

**Audit logging:** `auditFromReq()` called on CREATE client, CREATE task, DELETE deadline.

**NOT yet implemented in backend:**
- DELETE clients (only soft-delete via `is_active=false` through PUT)
- Billing/invoice generation
- Document upload/storage
- Report export (PDF/XLSX)
- `/api/practice/kv` endpoint for safeLocalStorage bridge

---

## 5. Current Database Footprint

**Migrations:**
- `backend/config/migrations/007_inventory_practice.sql` — Initial 4 tables
- `backend/config/migrations/011_practice_phase1_fixes.sql` — Constraint expansions

**Tables:**

### `practice_clients`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER FK → companies | Tenant isolation |
| name | TEXT NOT NULL | |
| email, phone | TEXT | |
| industry, vat_number, registration_number | TEXT | |
| fiscal_year_end | TEXT | e.g. "February" |
| address, notes | TEXT | |
| is_active | BOOLEAN DEFAULT TRUE | |
| created_at, updated_at | TIMESTAMPTZ | |

### `practice_tasks`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER FK → companies | Tenant isolation |
| client_id | INTEGER FK → practice_clients | Nullable |
| title | TEXT NOT NULL | |
| description, notes | TEXT | |
| type | TEXT CHECK | general, vat_return, tax_return, annual_financial, management_accounts, payroll, audit, bookkeeping, secretarial, other |
| priority | TEXT CHECK | low, medium, high, urgent |
| status | TEXT CHECK | open, in_progress, review, completed, cancelled |
| due_date | DATE | |
| completed_at | TIMESTAMPTZ | Set when status → completed |
| assigned_to | INTEGER FK → users | |
| created_by | INTEGER FK → users | |

### `practice_time_entries`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER FK → companies | Tenant isolation |
| user_id | INTEGER FK → users | Who logged the time |
| client_id | INTEGER FK → practice_clients | |
| task_id | INTEGER FK → practice_tasks | |
| hours | NUMERIC(6,2) CHECK > 0 | |
| description | TEXT | |
| date | DATE NOT NULL | |
| billable | BOOLEAN DEFAULT TRUE | |
| rate | NUMERIC(10,2) | Hourly rate at time of entry |

### `practice_deadlines`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER FK → companies | Tenant isolation |
| client_id | INTEGER FK → practice_clients | |
| title | TEXT NOT NULL | |
| type | TEXT CHECK | general, vat_return, tax_return, paye, uif, sdl, annual_financial, provisional_tax_p1, provisional_tax_p2, provisional_tax_top_up, cipc_annual_return, beneficial_ownership, other |
| due_date | DATE NOT NULL | |
| status | TEXT CHECK | pending, submitted, completed, missed |
| notes | TEXT | |
| submitted_at | TIMESTAMPTZ | Set when status → submitted |

**Indexes:**
- `idx_practice_clients_company(company_id)`
- `idx_practice_tasks_company(company_id)`
- `idx_practice_tasks_client(client_id)`
- `idx_practice_tasks_status(company_id, status)`
- `idx_practice_time_company/client/user`
- `idx_practice_deadlines_company/client/due_date`

---

## 6. Current Auth / Tenant Flow

**How users arrive at Practice:**
1. User logs into Eco dashboard (`/login` → `dashboard.html`)
2. User selects company → dashboard calls `POST /api/auth/select-company`
3. Backend returns a company-scoped JWT (`companyId` embedded)
4. Dashboard calls `launchApp('practice')` → SSO bridge sets `token`, `user`, `company` in localStorage → opens `/practice` in new tab (or same window)
5. Practice `index.html` loads → reads `token` from `localStorage.getItem('token')` (via `auth.js` safeLocalStorage shim)
6. All subsequent `/api/practice/*` calls carry `Authorization: Bearer <token>`
7. Backend `authenticateToken` middleware extracts `req.companyId` from JWT — all queries automatically scoped

**`frontend-practice/js/auth.js`:**
- Has `safeLocalStorage` fallback shim (`if (typeof window.safeLocalStorage === 'undefined') window.safeLocalStorage = window.localStorage`)
- AUTH module: `login()`, `logout()`, `getToken()`, `getCurrentUser()`, `selectCompany()`, `isAuthenticated()`
- All calls go to `/api/auth/*`
- Stores token via `safeLocalStorage.setItem('token', ...)`

**Tenant isolation enforcement:**
- Backend: every route filters by `req.companyId` (extracted from JWT, never from request body)
- Frontend: no business data stored client-side — all reads/writes via API
- Risk: if the user somehow lands on `/practice` without a valid token, the first API call will 401 and `auth.js` should redirect to login

---

## 7. App Activation / Access Flow

**To activate Practice for a company:**
1. Set `MODULE_PRACTICE_ENABLED=true` in Zeabur environment
2. Ensure company record has `'practice'` in `modules_enabled` array

**`requireModule('practice')` middleware (server.js):**
- Reads `req.companyId` from JWT
- Queries company record from DB
- Checks `modules_enabled` array includes `'practice'`
- Returns 403 if not activated

**Dashboard tile state:**
- `disabled` if company's activated apps list doesn't include `practice`
- `active` if included

---

## 8. No-localStorage Audit

### Frontend-Practice

| File | Line | Key | Classification | Risk |
|---|---|---|---|---|
| `js/auth.js` | 22 | `token` | AUTH_TOKEN | ✅ Allowed |
| `js/auth.js` | 58 | `availableCompanies` | AUTH_TOKEN | ✅ Allowed |
| `index.html` | ~430 | `token` or `practice_token` | AUTH_TOKEN | ✅ Allowed |

**Finding:** No business data written to localStorage in the practice frontend. Auth tokens only. **No violations.**

### Ecosystem Dashboard (relevant to Practice launch)

| File | Line | Key | Classification | Risk |
|---|---|---|---|---|
| `dashboard.html` | 2436 | `eco_client_id` | BUSINESS_DATA | ⚠️ Tracked follow-up |
| `dashboard.html` | 3794 | `eco_demos` | UI_PREF | ✅ Acceptable (recently cleaned) |

All token SSO bridge keys (`token`, `user`, `company`, `sso_source`) are AUTH_TOKEN — allowed.

**Overall localStorage risk for Practice: LOW.** The placeholder already avoids business data in localStorage.

---

## 9. Existing Patterns To Reuse

### Auth pattern (from Payroll/Accounting)
- `js/auth.js` already exists and is API-backed
- Follow the same `AUTH.init()` → `AUTH.getToken()` → attach to all fetch calls
- Mirror `frontend-payroll/js/auth.js` structure for consistency

### Company-selection pattern
- `frontend-payroll/company-selection.html` — full working template
- Practice needs its own `company-selection.html` once multi-company support is needed
- For now: SSO from dashboard sets token with embedded companyId

### Route structure (from Payroll)
```
/practice                    → index.html (dashboard + stats)
/practice/clients            → clients list + profile
/practice/tasks              → task board
/practice/time               → time tracker
/practice/deadlines          → deadline calendar
```

### Dark theme CSS variables
```css
--bg: #0f0a1a
--accent: #a78bfa  (Practice-specific purple)
--accent-2: #7c3aed
```
Already defined in `index.html` and matches ecosystem dark theme.

### API call pattern
```javascript
const resp = await fetch('/api/practice/clients', {
  headers: { 'Authorization': 'Bearer ' + AUTH.getToken() }
});
```

### Deployment pattern
- Server serves `/practice` as static HTML folder
- No separate Node.js process needed
- `MODULE_PRACTICE_ENABLED=true` in Zeabur env vars

### Smoke test pattern
- From `inventory-mrpeasy-pilot/`: run behavioral verification scripts
- For Practice: test CRUD operations against live `/api/practice/*` endpoints

---

## 10. Risks Found

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R01 | No `company-selection.html` — user arriving via direct URL `/practice` without SSO token gets 401 errors with no redirect | HIGH | Add auth guard on page load: if no token, redirect to dashboard or login |
| R02 | Single monolithic `index.html` — 51.5 KB, all logic in one file. Hard to maintain, test, and extend | MEDIUM | Refactor to multi-page app in Codebox 02 |
| R03 | No polyfills.js — `safeLocalStorage` shim falls back to raw `localStorage`. If any developer adds business data storage later, Rule D violation goes undetected | MEDIUM | Add `polyfills.js` (copy from Payroll, update KV endpoint to `/api/practice/kv`). Also add backend KV route. |
| R04 | No pagination — all tasks/clients/time entries loaded in single query. Will degrade at scale | MEDIUM | Add server-side pagination in Codebox 02 |
| R05 | `eco_client_id` stored in dashboard localStorage — business data Rule D violation (pre-existing, not introduced by Practice) | LOW (tracked) | Tracked follow-up in CLAUDE.md |
| R06 | `assigned_to` in tasks is a user ID but the frontend has no user picker — user must enter raw ID | HIGH | Build user picker (GET /api/employees or GET /api/users) in Codebox 02 |
| R07 | No delete for `practice_clients` — only soft-delete via `is_active=false`. Frontend shows no delete button. Consistent but should be documented | LOW | Document as intentional soft-delete pattern |
| R08 | `requireModule('practice')` enforces module access but only checks DB — if env var `MODULE_PRACTICE_ENABLED=false`, routes not registered at all (correct, fails-closed). Document this dual gate. | LOW | Documented here |
| R09 | No CSRF protection on API routes (shared with other modules — pre-existing) | LOW | Future security review |

---

## 11. Recommended Safe Build Sequence

### Codebox 02 — Frontend Build-Out (Recommended Next)

**Goal:** Transform the single placeholder into a proper multi-page Practice app.

**Priority order:**
1. Auth guard on `index.html` — redirect to dashboard if no token (prevents 401 flood)
2. Add `/api/practice/kv` backend route + `polyfills.js` to frontend
3. Refactor `index.html` into separate pages: `clients.html`, `tasks.html`, `time.html`, `deadlines.html`
4. Add user picker for `assigned_to` (task assignment)
5. Add pagination to all list endpoints
6. Add client detail page (`client.html`) with embedded tasks + time + deadlines
7. Improve empty states, loading states, error handling
8. Add deadline calendar view

### Codebox 03 — Reporting

1. Time tracking summary per client (billable hours, rate, total)
2. Deadline status summary report (PDF)
3. Task completion analytics

### Codebox 04 — Document Management (Future)

1. Client document upload/storage (Supabase Storage)
2. Document categories and versions
3. Compliance checklists

---

## 12. Open Questions

| # | Question | Priority |
|---|---|---|
| Q1 | Should Practice have its own company-selection flow, or always arrive via SSO from dashboard? | HIGH |
| Q2 | Should `assigned_to` pull from `users` table or only from employees of the practice? | HIGH |
| Q3 | Is billing/invoicing for client work in scope? If yes, link to Accounting module? | MEDIUM |
| Q4 | Should deadlines auto-populate based on client's fiscal year end and tax type? | MEDIUM |
| Q5 | Should Sean AI be able to query practice data (e.g. "what deadlines are due this week")? | LOW (future) |
| Q6 | Multi-user time tracking: should staff see only their own time entries, or all? | MEDIUM |
