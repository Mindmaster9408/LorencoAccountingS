# LORENCO PRACTICE — FRONTEND SAFETY BUILD-OUT
# Codebox 02: Implementation Record

> Date: May 2026
> Status: COMPLETE
> Prerequisite: Codebox 01 (Foundation Audit) — COMPLETE

---

## 1. Build Goal

Transform the single-file `frontend-practice/index.html` placeholder (824 lines) into a safe, multi-page Practice Management application with:
- Auth guard on every page
- No localStorage for business data (Rule D compliant)
- User picker for task assigned_to field
- Pagination on all list views
- Loading, empty, and error states
- Cross-browser compatible (Chrome, Firefox, Safari, Edge)

---

## 2. Files Created

| File | Purpose |
|---|---|
| `frontend-practice/css/practice.css` | Shared stylesheet — all styles extracted here |
| `frontend-practice/js/polyfills.js` | safeLocalStorage bridge — Rule D enforcement |
| `frontend-practice/js/api.js` | Shared API helper — `PracticeAPI.fetch()` with auth + 401 redirect |
| `frontend-practice/js/layout.js` | Topbar + nav injector — `LAYOUT.init('page-key')` |
| `frontend-practice/clients.html` | Client list — search, status filter, pagination, add/edit modal |
| `frontend-practice/tasks.html` | Task list — status/client/type/assignee filters, user picker, add/edit/delete |
| `frontend-practice/time.html` | Time tracker — log form, month/client filter, summary bar, edit/delete |
| `frontend-practice/deadlines.html` | Deadlines — status/client/type filters, quick actions, add/edit/delete |

## 3. Files Modified

| File | Change |
|---|---|
| `frontend-practice/index.html` | Refactored to dashboard-only — shared CSS/nav via external files, quick-nav cards |
| `backend/modules/practice/index.js` | Added `GET/PUT /api/practice/kv/:key` and `GET /api/practice/users` endpoints |

---

## 4. Auth Pattern (on every page)

```javascript
async function init() {
    var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
    if (!token) { window.location.href = '/'; return; }
    try {
        var res = await PracticeAPI.fetch('/api/auth/me');
        if (!res.ok) { window.location.href = '/'; return; }
    } catch(e) { window.location.href = '/'; return; }
    LAYOUT.init('page-key');
    // load data...
}
```

- Synchronous token check first (no flicker)
- API verification second (`/api/auth/me`)
- 401 from any API call → auto-redirect to `/` (handled in `api.js`)

---

## 5. Storage Safety (Rule D)

### `polyfills.js` allowed keys
```javascript
var ALLOWED_KEYS = [
    'token', 'practice_token', 'session', 'user', 'company',
    'sso_source', 'availableCompanies'
];
```

All other keys route to `/api/practice/kv/:key` (server KV store). Business data only goes to SQL via API endpoints. No localStorage/sessionStorage violations in any new file.

### localStorage audit (all new files)
- `index.html`: reads `token`, `practice_token`, `company` — all AUTH_TOKEN ✅
- `clients.html`: no localStorage access — all data via API ✅
- `tasks.html`: no localStorage access — all data via API ✅
- `time.html`: no localStorage access — all data via API ✅
- `deadlines.html`: no localStorage access — all data via API ✅
- `api.js`: reads `token`, `practice_token` for auth header only ✅
- `layout.js`: reads `company` for company badge display only ✅
- `polyfills.js`: reads/writes allowed auth keys only ✅

---

## 6. User Picker (Task assigned_to — R06 from Audit)

### Backend endpoint added
```javascript
GET /api/practice/users
// Returns: { users: [{ id, first_name, last_name, email }] }
// Source: user_company_access JOIN users, filtered by company_id
```

### Frontend implementation (tasks.html)
- Filter bar: "All Assignees" dropdown populated from `/api/practice/users`
- Modal: "Assigned To" dropdown populated from same data
- Display: assignee name shown in task card meta
- Correctly converts integer IDs when sending to API

---

## 7. Pagination

All list views use client-side pagination (data fully loaded, split into pages):

| Page | Page size | Approach |
|---|---|---|
| `clients.html` | 20 per page | Client-side (search + status filter applied before pagination) |
| `tasks.html` | 20 per page | Client-side (server filters applied at load time) |
| `deadlines.html` | 30 per page | Client-side (type filter applied client-side after server load) |
| `time.html` | All in view | No pagination — filtered by month (naturally bounded) |

---

## 8. Cross-Browser Compatibility Fixes

| Issue | Fix |
|---|---|
| `input[type="month"]` — not supported in Firefox/Safari | Replaced with year `<select>` + month `<select>` |
| `backdrop-filter` — not supported in Safari | Added `-webkit-backdrop-filter` prefix |
| `maximum-scale`, `user-scalable` in viewport | Removed — accessibility violation |

---

## 9. Backend New Endpoints

### `GET /api/practice/kv/:key`
- Returns stored KV value for `practice_{companyId}_{key}`
- Uses existing `payroll_kv_store_eco` table with `practice_` prefix

### `PUT /api/practice/kv/:key`
- Upserts KV value via Supabase `upsert`
- For UI preferences only (sort state, last tab, etc.) — not business data

### `GET /api/practice/users`
- Returns users for the current company via `user_company_access` table
- Sorted by `first_name`
- Used for task `assigned_to` picker

---

## 10. Loading, Empty, and Error States

Every list view has three states:

**Loading:** Spinner + "Loading…" text (`<div class="loading"><div class="loading-spinner">`)

**Empty:** Icon + title + description (`<div class="empty">…</div>`)

**Error:** Red banner (`<div class="error-banner">⚠️ …</div>`)

All API calls use `try/catch` — failures render the error banner rather than silently failing.

---

## 11. Navigation Structure

```
/practice             → index.html  (Dashboard + quick nav cards)
/practice/clients.html → clients.html (Client list)
/practice/tasks.html  → tasks.html  (Task list + user picker)
/practice/time.html   → time.html   (Time tracker)
/practice/deadlines.html → deadlines.html (Deadlines)
```

Nav is injected by `LAYOUT.init('page-key')` into `#app-topbar` and `#app-nav` on each page.

The tasks page accepts `?client=ID` URL param (linked from clients page) to pre-filter by client.

---

## 12. Risks Resolved

| Risk from Audit | Status |
|---|---|
| R01 — No auth guard | ✅ Fixed — auth guard on all 5 pages |
| R02 — Monolithic index.html | ✅ Fixed — split into 5 pages + shared CSS/JS |
| R03 — No polyfills.js | ✅ Fixed — polyfills.js created, loads before auth.js |
| R04 — No pagination | ✅ Fixed — pagination on clients, tasks, deadlines |
| R05 — No user picker for assigned_to | ✅ Fixed — user picker on tasks page, `/api/practice/users` endpoint added |

---

## 13. What Was NOT Built (out of scope for Codebox 02)

- Individual Income Tax calculator
- Provisional Tax engine
- Sean AI integration
- Client detail profile page (`client.html`)
- Billing / invoicing
- Document upload / management
- PDF report export
- SARS auto-populate deadlines from fiscal year end
- Role-based access control (staff vs manager view)

These are reserved for Codebox 03+.
