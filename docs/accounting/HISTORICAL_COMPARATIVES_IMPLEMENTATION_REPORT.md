# Historical Comparatives — Implementation Report

## Overview

The Historical Comparative Financial Engine allows capturing and comparing historical
monthly financial data across multiple financial years. It operates as a fully separate
read/write layer and **never touches live journals, bank transactions, VAT tables, or
any other live financial table**.

---

## Module Components

| Component | Path |
|---|---|
| Database migration | `database/migrations/042_historical_comparatives.sql` |
| Backend routes | `backend/modules/accounting/routes/historicalComparatives.js` |
| Service layer | `backend/modules/accounting/services/historicalComparativesService.js` |
| Frontend UI | `frontend-accounting/historical-comparatives.html` |
| Route mount | `backend/modules/accounting/index.js` line 85 |
| Auth permissions | `backend/modules/accounting/middleware/auth.js` PERMISSIONS map |

---

## Permissions

| Permission | Roles |
|---|---|
| `historical.view` | admin, accountant, bookkeeper, viewer |
| `historical.create` | admin, accountant |
| `historical.edit` | admin, accountant |
| `historical.finalize` | admin, accountant |

---

## Batch Lifecycle

```
draft → validated → finalized → (archived)
```

- Finalized batches are **IMMUTABLE**. No edits ever.
- To correct data, create a new batch.
- Finalized status is stored DB-authoritative only (no localStorage).

---

## UUID / User ID Type Fix

**Migration:** `043_fix_historical_comparatives_user_id_types.sql`

### Root cause

Migration 042 defined all user-reference columns (`created_by`, `finalized_by`,
`entered_by`, `updated_by`, `performed_by`) as `UUID`. This was incorrect.

The app's `users` table uses `INTEGER` primary keys, confirmed by audit of:

| Migration | Evidence |
|---|---|
| `014_inventory_manufacturing.sql` | `created_by INTEGER REFERENCES users(id)` |
| `019_year_end_close.sql` | `closed_by_user_id INTEGER REFERENCES users(id)` |
| `041_inventory_costing_foundation.sql` | `created_by INTEGER` (×2 tables, RPC param) |

The ECO JWT payload carries `userId` as a number (e.g. `1`), sourced from the custom
`users` table. When the service passed this integer into a UUID column, PostgreSQL
rejected it with:

```
invalid input syntax for type uuid: "1"
```

### Affected columns

| Table | Column |
|---|---|
| `historical_comparative_batches` | `created_by` |
| `historical_comparative_batches` | `finalized_by` |
| `historical_comparative_lines` | `entered_by` |
| `historical_comparative_lines` | `updated_by` |
| `historical_comparative_audit_log` | `performed_by` |

### Actual existing app user ID type

**INTEGER** — consistent with `users.id` across all 40+ migrations.

### SQL migration applied

`043_fix_historical_comparatives_user_id_types.sql` — alters all five columns
from UUID to INTEGER using `USING NULL` (safe because the tables had no rows;
batch creation was blocked by this very error before any data could be inserted).

### Service fix applied

Added `_actorId(id)` private helper to `HistoricalComparativesService`:

```javascript
static _actorId(id) {
  if (id === null || id === undefined || id === '') return null;
  const n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}
```

Used at every write site: `created_by`, `finalized_by`, `entered_by`, `updated_by`,
and `performed_by` in `_writeAuditLog`.

### Tests required after fix

1. Run migration 043 in Supabase SQL Editor
2. Restart/redeploy backend
3. Create batch: description "2021-2027", FY start 2021, FY end 2027, Profit & Loss, Manual capture
4. Confirm batch saves without error
5. Confirm row exists in `historical_comparative_batches` with correct `created_by` integer
6. Confirm no rows in journals, journal_lines, bank_transactions (live tables untouched)
7. Confirm audit log row in `historical_comparative_audit_log` with `performed_by` integer

---

## Navigation Fix

**Commit:** `fix(accounting): add missing navigation.js to historical-comparatives page`

### Root cause

`historical-comparatives.html` was the only accounting page not loading
`js/navigation.js` in its `<head>`. The navigation entry for Historical Comparatives
was already correct in `navigation.js` (lines 155-156) but never executed on this page.

The page also had a broken body-level nav attempt:
`document.getElementById('navigation').innerHTML = createNavigation()` — broken because
`createNavigation()` inserts directly via `document.body.insertAdjacentHTML` and returns
nothing, so `innerHTML` was set to `undefined`.

### Fix

- Added `<script src="js/navigation.js"></script>` and `theme-guard.js` to `<head>`
- Removed duplicate body-level nav script and broken innerHTML call
- Removed unused `<div id="navigation">` placeholder

---

## Auth Fix

**Commit:** `fix(accounting): fix auth on historical-comparatives page`

### Root cause

The `api()` helper function sent only `Content-Type` and `credentials: 'include'`.
The ECO backend's `authenticateToken` middleware requires a `Bearer` token in the
`Authorization` header. No other accounting pages had this issue — they all read
`localStorage.getItem('token')` and attach it.

### Fix

- Added `const _token = localStorage.getItem('token'); if (!_token) window.location.href = '/';`
- Added `'Authorization': 'Bearer ' + _token` to all `api()` fetch calls

---

## CSS Fix

**Commit:** `fix(accounting): remove dead /accounting/css/main.css link`

`/accounting/css/main.css` does not exist. The server returned HTML on that path,
triggering a MIME type error. Removed the link — the page has complete inline styles.
