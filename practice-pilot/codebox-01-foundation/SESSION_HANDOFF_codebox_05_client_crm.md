# SESSION HANDOFF — CODEBOX 05 — CLIENT CRM FOUNDATION

> Date: May 2026
> Status: COMPLETE
> Codebox type: Migration + Backend + Frontend (list + detail)

---

## Status

**COMPLETE.** Practice Client CRM Foundation built from migration to frontend. Client list enhanced, full detail page created, contact persons module built.

---

## What Was Built

A full Client CRM Foundation for Lorenco Practice:
- Database migration extending `practice_clients` with ~35 new columns
- New `practice_client_contacts` sub-table
- Enhanced backend client routes (full `sanitizeClientBody()`, enum validation, audit logging)
- New contact CRUD routes (`GET/POST/PUT/DELETE /clients/:id/contacts`)
- Enhanced `clients.html` list with type badge, compliance flags, responsible member, CRM filters
- New `client-detail.html` — 11-section full CRM profile page
- New `js/client-detail.js` — IIFE, load/save/archive, contact CRUD, conditional sections

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/056_practice_client_crm_expansion.sql` | ALTER TABLE practice_clients + CREATE practice_client_contacts |
| `accounting-ecosystem/frontend-practice/client-detail.html` | Full 11-section CRM profile page |
| `accounting-ecosystem/frontend-practice/js/client-detail.js` | Client detail page logic |
| `practice-pilot/codebox-01-foundation/05_client_crm_foundation.md` | Full build record |
| `practice-pilot/codebox-01-foundation/SESSION_HANDOFF_codebox_05_client_crm.md` | This file |

---

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Replaced basic client routes (lines 305–373) with full CRM routes + contact CRUD; added `CLIENT_TYPES`, `CLIENT_ONBOARDING_STATUSES`, `CLIENT_RISK_RATINGS`, `sanitizeClientBody()`, `sanitizeContactBody()` |
| `accounting-ecosystem/frontend-practice/clients.html` | Rewritten: IIFE pattern, enhanced table columns, client_type filter, team loading, updated quick-add modal, "View" link to detail page |

---

## Database Migration

**File:** `accounting-ecosystem/database/migrations/056_practice_client_crm_expansion.sql`

**Required action before testing:**
```sql
-- Paste contents of 056_practice_client_crm_expansion.sql into Supabase SQL Editor → Run
```

Also run if not done: `054_practice_profile.sql`, `055_practice_team_members.sql`

**Changes:** `ALTER TABLE practice_clients ADD COLUMN IF NOT EXISTS` (safe, ~35 columns) + `CREATE TABLE IF NOT EXISTS practice_client_contacts`

---

## API Endpoints Added / Changed

| Method | Route | Status | Description |
|---|---|---|---|
| `GET` | `/api/practice/clients` | ENHANCED | New filters: client_type, onboarding_status, risk_rating, responsible_team_member_id, vat/paye/provisional flags |
| `GET` | `/api/practice/clients/:id` | UNCHANGED | Single client |
| `POST` | `/api/practice/clients` | ENHANCED | sanitizeClientBody, enum validation, audit |
| `PUT` | `/api/practice/clients/:id` | ENHANCED | sanitizeClientBody, ownership check, audit |
| `DELETE` | `/api/practice/clients/:id` | **NEW** | Soft archive: is_active=false, onboarding_status='archived' |
| `GET` | `/api/practice/clients/:id/contacts` | **NEW** | List active contacts |
| `POST` | `/api/practice/clients/:id/contacts` | **NEW** | Create contact |
| `PUT` | `/api/practice/clients/:clientId/contacts/:contactId` | **NEW** | Update contact |
| `DELETE` | `/api/practice/clients/:clientId/contacts/:contactId` | **NEW** | Soft deactivate contact |

---

## Frontend URLs

- `/practice/clients.html` — Enhanced client list (unchanged URL)
- `/practice/client-detail.html?id={clientId}` — Full CRM profile for one client

---

## Key Design Decisions

1. **`email`/`phone` preserved** — existing columns kept as "Primary Email/Phone"; UI labels updated. No duplicate columns.
2. **`fiscal_year_end TEXT` preserved** — legacy free-text kept for backward compat; `financial_year_end_month INTEGER` added alongside.
3. **`address TEXT` preserved** — legacy free-text kept; structured `address_line1/2/city/...` added alongside.
4. **Team member refs are soft INTEGER refs** — no FK to `practice_team_members`; consistent with `user_id` soft ref pattern in team members.
5. **Contact modal fetches fresh from API** — avoids stale state for edit; slightly less efficient but safer.

---

## Manual Test Steps

1. Run `056_practice_client_crm_expansion.sql` in Supabase SQL Editor
2. Open Clients page — confirm existing clients show type badge ("Company" by default), no data loss
3. Filter by client type → confirm filtering works
4. Quick-add modal: add client with type + responsible member → confirm in list
5. Click "View" → `client-detail.html?id=X` opens with all fields populated
6. Change entity type to "Individual" → Individual Taxpayer section appears
7. Uncheck "Postal same as physical" → postal section appears
8. Save → confirm all 11 sections persist (check backend payload in DevTools)
9. Add contact person → confirm in contacts table with badges
10. Edit contact → change primary flag → save → confirm
11. Remove contact → confirm removed from table
12. Archive client from detail page → confirm redirect + client shown as inactive
13. Confirm no client/contact data in DevTools → Application → Local Storage
14. Open `/practice/client-detail.html` without auth → confirm redirect to `/`
15. Open without `?id=` → confirm redirect to `/practice/clients.html`
16. Confirm Tasks, Time, Deadlines still work (no regressions)

---

## Known Risks

| # | Risk | Severity |
|---|---|---|
| RF01 | Legacy `address TEXT` and structured address can diverge | LOW |
| RF02 | Legacy `fiscal_year_end TEXT` and `financial_year_end_month` can diverge | LOW |
| RF03 | `is_primary` contact not unique at DB level — multiple primaries possible | LOW |
| RF04 | Individual taxpayer fields not format-validated | MEDIUM |
| RF05 | Contact modal opens with fresh API call (slightly less efficient) | LOW |

---

## Recommended Codebox 06

**Tasks + Deadlines Client Linking / Practice Workflow**

1. Add client context tabs to `client-detail.html` — Tasks / Time / Deadlines per client
2. Auto-suggest provisional tax deadlines from `financial_year_end_month`
3. Time entries linked to client + team member
4. Client-filtered summary views
5. Deadline bulk-create from compliance flags

---

## What Was NOT Changed

- No changes to `server.js`
- No changes to `js/auth.js`, `js/api.js`, `js/polyfills.js`, `js/layout.js`
- No changes to tasks.html, time.html, deadlines.html, dashboard.html
- No changes to Paytime, Inventory, POS, Accounting, ECO Hub
- No environment variables added
- Nothing committed or pushed — all changes are local only
