# LORENCO PRACTICE — PRACTICE PROFILE FOUNDATION
# Codebox 03: Implementation Record

> Date: May 2026
> Status: COMPLETE
> Prerequisite: Codebox 02 (Frontend Safety Build-Out) — COMPLETE

---

## 1. Build Goal

Establish the tenant-level Practice Profile for Lorenco Practice Management.

**Critical distinction enforced throughout:**
- **Practice Profile** (`practice_profiles`) = the accounting firm using Lorenco Practice
- **Client Profile** (`practice_clients`) = that firm's own client files
  
These must never be mixed. The profile form is the firm's identity, not a client's.

---

## 2. Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/054_practice_profile.sql` | DB migration — `practice_profiles` table |
| `accounting-ecosystem/frontend-practice/profile.html` | Practice Profile page — 6-section form |
| `accounting-ecosystem/frontend-practice/js/profile.js` | Profile page logic — load/create/update, user picker |

---

## 3. Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `GET/POST/PUT /api/practice/profile` + `sanitizeProfileBody()` |
| `accounting-ecosystem/frontend-practice/js/layout.js` | Added 'Profile' nav item (key: `'profile'`, end of nav) |
| `accounting-ecosystem/frontend-practice/css/practice.css` | Added `.notice-banner` class (informational blue banner) |

---

## 4. Database Schema

```sql
CREATE TABLE IF NOT EXISTS practice_profiles (
    id                          SERIAL PRIMARY KEY,
    company_id                  INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    tax_practitioner_number     TEXT,
    vat_registration_number     TEXT,
    practice_type               TEXT CHECK (practice_type IN (
                                    'sole_proprietor','partnership','company','cc','trust','other'
                                )),
    practice_email              TEXT,
    practice_phone              TEXT,
    practice_website            TEXT,
    address_line1               TEXT,
    address_line2               TEXT,
    address_city                TEXT,
    address_province            TEXT CHECK (address_province IN (...9 SA provinces...)),
    address_postal_code         TEXT,
    default_hourly_rate         NUMERIC(10, 2),
    default_currency            TEXT NOT NULL DEFAULT 'ZAR',
    fiscal_year_end_month       INTEGER CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
    default_task_assignee_id    INTEGER,  -- soft ref, no FK
    primary_colour              TEXT,
    logo_url                    TEXT,
    compliance_notes            TEXT,
    settings                    JSONB NOT NULL DEFAULT '{}',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key decisions:**
- `SERIAL PRIMARY KEY` (INTEGER) — matches all existing practice_* tables
- `company_id UNIQUE` — enforces one profile per company
- `default_task_assignee_id` — soft reference (no FK) to avoid cross-schema complexity with `auth.users`
- `updated_at` managed by `PUT` handler (`new Date().toISOString()`), no DB trigger needed (matching existing pattern in practice routes)
- `settings JSONB` — future-proofed extension point (feature flags, default VAT period, etc.)
- Province constraint added — prevents invalid SA province values

---

## 5. Backend Endpoints

All routes inherit `authenticateToken` + `requireModule('practice')` from router registration in `server.js`.

### `GET /api/practice/profile`
- Returns `{ profile: object | null }` — null if no profile created yet
- Error code `PGRST116` (no rows) handled explicitly — returns null, not 500

### `POST /api/practice/profile`
- Creates profile for the authenticated company
- Returns `409` if profile already exists (duplicate `company_id`)
- Body sanitized through `sanitizeProfileBody()` — no extra fields pass through
- Audited via `auditFromReq(req, 'CREATE', 'practice_profile', id, { module: 'practice' })`

### `PUT /api/practice/profile`
- Updates profile for the authenticated company
- Sets `updated_at` to current timestamp
- Returns `404` if no profile exists (use POST first)
- Audited via `auditFromReq(req, 'UPDATE', 'practice_profile', id, { module: 'practice' })`

### `sanitizeProfileBody(body)` helper
- Allowlist of 20 permitted field names
- Prevents client from injecting `company_id`, `id`, `created_at`, etc.

---

## 6. Frontend Architecture

### Auth Pattern
```javascript
async function init() {
    var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
    if (!token) { window.location.href = '/'; return; }
    var res = await PracticeAPI.fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/'; return; }
    LAYOUT.init('profile');
    await Promise.all([loadUsers(), loadProfile()]);
}
```

Users and profile load in parallel after auth passes.

### Create vs Update Mode
```javascript
var profileMode = 'create'; // or 'update'
// On load: if GET returns null → 'create', else 'update'
// On save: method = profileMode === 'create' ? 'POST' : 'PUT'
// After first POST succeeds: profileMode = 'update', notice hidden
```

### localStorage Audit (Rule D)
- `profile.html`: no localStorage access — all data via API ✅
- `profile.js`: no localStorage access — all data via API ✅
- Auth token reads in `init()` only — identical to all other pages ✅

---

## 7. Form Sections

| Section | Fields |
|---|---|
| Practice Identity | Tax Practitioner Number, VAT Registration Number, Practice Type |
| Contact Details | Practice Email, Practice Phone, Website |
| Physical Address | Line 1, Line 2, City, Province (SA provinces only), Postal Code |
| Workflow Defaults | Default Hourly Rate, Currency, Fiscal Year End Month, Default Task Assignee |
| Branding | Primary Colour (hex), Logo URL |
| Compliance & Notes | Internal Notes textarea |

---

## 8. Navigation Update

`layout.js` PAGES array updated — `profile` added as last nav item:
```javascript
{ key: 'profile', label: 'Profile', href: '/practice/profile.html' }
```

All existing pages (`dashboard`, `clients`, `tasks`, `time`, `deadlines`) unchanged.

---

## 9. Risks Resolved

| Risk from Audit | Status |
|---|---|
| UUID vs INTEGER mismatch in spec | ✅ Resolved — migration uses SERIAL INTEGER to match existing schema |
| companies table field overlap | ✅ Resolved — practice_profiles focuses on practice-specific fields only |
| `detectModule()` doesn't handle 'practice' | ✅ Resolved — explicit `{ module: 'practice' }` passed to `auditFromReq()` |
| `updated_at` trigger pattern | ✅ Resolved — manual update in PUT handler, no trigger needed |

---

## 10. What Was NOT Built (out of scope for Codebox 03)

- Tax calculations (Individual Tax, Provisional Tax)
- Client onboarding wizard
- Task template library
- CIPC/SARS integration
- Sean AI integration
- Document upload / logo file upload (logo_url is a URL field only)
- Role-based access control
- Profile photo/branding preview
- Auto-deadline generation from fiscal year end month

---

## 11. Open Risks / Follow-ups

| # | Risk | Severity | Recommended Action |
|---|---|---|---|
| RF01 | `default_task_assignee_id` is a soft reference — if user leaves company, stale ID persists in profile | LOW | Validate assignee against `/api/practice/users` on load; show warning if not found |
| RF02 | Province SELECT constraint in DB must match HTML options exactly — if a province name differs, PUT will return 500 | MEDIUM | Test live after migration; DB constraint lists exact province strings |
| RF03 | `primary_colour` and `logo_url` stored but not applied to the app UI yet | LOW | Apply in Codebox 04+ branding pass |
| RF04 | `settings` JSONB exposed in GET response but no UI to edit it — developer-only for now | LOW | Acceptable; document as extension point |
| RF05 | `fiscal_year_end_month` stored but not yet used to auto-generate deadlines | LOW | Connect in Codebox 04+ deadline automation |
