# Historical Comparative Financial Engine — Implementation Report

**Module:** Lorenco Accounting — Historical Comparatives  
**Session date:** 2026 (continuation from previous session)  
**Status:** IMPLEMENTATION COMPLETE — awaiting migration execution and UAT

---

## 1. Purpose

The Historical Comparative Financial Engine provides a structured, auditable layer for capturing and comparing historical monthly financial figures across multiple financial years.

**Key design principles:**
- **Completely separate from live financial data.** No writes to `journals`, `journal_lines`, `bank_transactions`, VAT tables, or any live financial table.
- **Immutability on finalization.** Once a batch is finalized, it is permanently locked. No exceptions.
- **SA financial year aware.** Month order defaults to March–February (SA standard).
- **Full audit trail.** Every create, update, validation, finalization, and blocked-edit attempt is recorded in `historical_comparative_audit_log`.
- **No browser storage.** All data is persisted server-side via API. Zero localStorage, zero sessionStorage.

---

## 2. Files Created / Modified

### New files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/database/migrations/042_historical_comparatives.sql` | DB migration — 3 tables, all indexes, constraints |
| `accounting-ecosystem/backend/modules/accounting/services/historicalComparativesService.js` | Service layer — all business logic |
| `accounting-ecosystem/backend/modules/accounting/routes/historicalComparatives.js` | Express routes — 11 endpoints (incl. dashboard/trends) |
| `accounting-ecosystem/frontend-accounting/historical-comparatives.html` | Frontend — batch management + capture grid + reports |
| `accounting-ecosystem/frontend-accounting/historical-comparatives-charts.html` | Dashboard chart widgets (Chart.js, 5 widgets) |
| `accounting-ecosystem/backend/tests/historical-comparatives-dashboard.test.js` | Jest tests for dashboard chart integration |

### Modified files

| File | Change |
|------|--------|
| `accounting-ecosystem/backend/modules/accounting/index.js` | Added `router.use('/historical-comparatives', ...)` mount |
| `accounting-ecosystem/backend/modules/accounting/middleware/auth.js` | Added 4 permissions to PERMISSIONS map |
| `accounting-ecosystem/frontend-accounting/js/navigation.js` | Added "Historical Comparatives" and "Historical Charts" links under Reports > Historical |
| `accounting-ecosystem/frontend-accounting/dashboard.html` | Added "Historical Analysis" summary card (shows only when finalized batches exist) |

---

## 3. Database Schema

### `historical_comparative_batches`
A named capture session for a company. One batch = one import/capture event for a defined FY range.

**Key columns:** `id (UUID)`, `company_id (INTEGER)`, `status (draft→validated→finalized)`, `financial_year_start`, `financial_year_end`, `report_basis`, `finalized_at`, `finalized_by`

### `historical_comparative_lines`
One row per account × month × financial year × batch.

**Key columns:** `batch_id (UUID)`, `company_id (INTEGER)`, `account_id (INTEGER, nullable)`, `account_code (TEXT)`, `account_name (TEXT)`, `financial_year`, `period_month (1–12)`, `amount (NUMERIC 18,2)`, `is_finalized (BOOLEAN)`

**Unique index:** `(batch_id, account_id, financial_year, period_month) WHERE account_id IS NOT NULL` — prevents duplicate lines for the same account/period.

### `historical_comparative_audit_log`
Append-only. Never updated or deleted.

**Actions tracked:** `BATCH_CREATED`, `BATCH_UPDATED`, `LINE_CREATED`, `LINE_UPDATED`, `LINE_DELETED`, `BATCH_VALIDATED`, `BATCH_FINALIZED`, `BATCH_ARCHIVED`, `FINALIZED_EDIT_BLOCKED`

### Type corrections vs spec
The original spec used UUID for `company_id` and `account_id`. These were corrected:

| Field | Spec | Actual |
|-------|------|--------|
| `company_id` | UUID | INTEGER (matches `companies.id` which is SERIAL) |
| `account_id` | UUID | INTEGER nullable (matches `accounts.id` which is SERIAL) |
| User fields | UUID | UUID (matches Supabase auth `users.id`) |

---

## 4. API Endpoints

All endpoints are under `/api/accounting/historical-comparatives`.

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/batches` | `historical.view` | List batches (optional ?status= filter) |
| POST | `/batches` | `historical.create` | Create a new draft batch |
| GET | `/accounts/search?q=` | `historical.view` | Search COA for account lookup |
| GET | `/batch/:id/lines` | `historical.view` | Get all lines for a batch |
| POST | `/batch/:id/manual-line` | `historical.create` | Save a single line (upsert) |
| POST | `/batch/:id/manual-grid` | `historical.create` | Bulk-save 12 months for one account |
| POST | `/batch/:id/validate` | `historical.finalize` | Validate batch, set status = validated |
| POST | `/batch/:id/finalize` | `historical.finalize` | Finalize and lock batch permanently |
| GET | `/reports/monthly-pl` | `historical.view` | Monthly comparative P&L report |
| GET | `/reports/account-trend` | `historical.view` | Trend data for a specific account |
| GET | `/dashboard/trends` | `historical.view` | Chart.js-compatible dataset for dashboard widgets |

---

## 5. Permission Model

New permissions added to `middleware/auth.js`:

| Permission | Roles |
|-----------|-------|
| `historical.view` | admin, accountant, bookkeeper, viewer |
| `historical.create` | admin, accountant |
| `historical.edit` | admin, accountant |
| `historical.finalize` | admin, accountant |

---

## 6. Frontend Features

**Data Capture tab:**
- Batch list (left panel) with status filter
- Create Batch modal: description, FY range, report basis, source type
- Account search (live search against COA, debounced 250ms)
- Monthly capture grid: Mar–Feb month order (SA FY), Tab/Enter keyboard navigation
- Currency formatting on blur, raw numeric editing on focus
- Per-account "Save" button + global "Save All" button
- Validate button → marks batch as validated
- Finalize button → confirmation dialog → permanent lock
- Finalized banner (blue) locks all inputs when batch is finalized

**Reports tab:**
- Monthly P&L comparative report
- Year range selector + account type filter
- Columns: 12 months × N years, plus annual total column per year
- Only finalized data appears in reports

---

## 7. Business Logic Enforced

### Finalization immutability
```
Batch status = 'finalized'
      ↓
POST /manual-line → 403 error
POST /manual-grid → 403 error
POST /validate    → 403 error
POST /finalize    → 403 error (already finalized)
UI inputs → disabled, finalized banner shown
```

### Validation gate before finalization
A batch must pass validation (`status = 'validated'`) before it can be finalized. Draft batches cannot be directly finalized.

### Company scoping
`company_id` is always sourced from `req.user.companyId` (set by the auth bridge from the JWT). It is never accepted from the request body or query params.

### Reports only show finalized data
The monthly P&L report queries `WHERE l.is_finalized = true AND b.status = 'finalized'`. Draft/validated data never appears in comparative reports.

### SA financial year
Month order in grids and reports: `[3,4,5,6,7,8,9,10,11,12,1,2]` (Mar–Feb). Calendar year adjustment: months 1–2 map to `financialYear + 1` in calendar year.

---

## 8. Required Action: Run Migration

**The migration has NOT been applied yet.** It must be run manually in the Supabase SQL Editor.

**File to run:** `accounting-ecosystem/database/migrations/042_historical_comparatives.sql`

**Steps:**
1. Open Supabase dashboard → SQL Editor
2. Copy the full contents of `042_historical_comparatives.sql`
3. Paste and run
4. Confirm 3 tables created: `historical_comparative_batches`, `historical_comparative_lines`, `historical_comparative_audit_log`

---

## 9. Testing Checklist (UAT)

| Test | Expected |
|------|---------|
| Create batch | Batch appears in list with status 'draft' |
| Search account | COA results appear as you type |
| Enter amounts in grid | Tab/Enter navigation works; currency formatting on blur |
| Save All | All grids saved, success message shown |
| Validate batch | Status changes to 'validated' |
| Finalize without validating | Error: "must be validated first" |
| Finalize with confirmation | Status changes to 'finalized', all inputs locked |
| Edit finalized batch | 403 error returned; banner shown |
| Generate P&L report | Only finalized data appears |
| Switch company | Data correctly shows for new company only |
| No localStorage writes | DevTools → Application → Storage = empty for business data |

---

## 10. Future Enhancements (not built — tracked follow-ups)

- CSV/Excel import for bulk capture (sourceType = 'csv'/'excel' is supported in schema, UI import not yet built)
- Batch archiving (status = 'archived' supported in schema, UI action not yet built)
- Balance sheet comparative view (schema supports `report_basis = 'balance_sheet'`, report not yet built)
- Year-end carry-forward from historical comparatives to new FY setup

---

## 11. Dashboard Chart Integration

**Session:** Add-on implementation — Dashboard Chart Widgets

### New endpoint

`GET /api/accounting/historical-comparatives/dashboard/trends`

**Supported metrics:**

| Metric | Returns |
|--------|---------|
| `revenue` | Monthly Income totals per year |
| `expenses` | Monthly Expense totals per year |
| `net_profit` | Monthly Income minus Expense per year |
| `gross_profit` | Same as net_profit (no COGS sub-type distinction in schema — documented simplification) |
| `account_trend` | Monthly totals for a specific account per year (requires `accountId`) |
| `annual_summary` | Annual totals: Revenue, Expenses, Net Profit — three series, one per year label |

**Query parameters:**

| Param | Required | Notes |
|-------|----------|-------|
| `metric` | Yes | One of the 6 valid values above |
| `fromYear` | Yes | FY start (inclusive) |
| `toYear` | Yes | FY end (inclusive) |
| `batchId` | No | Narrow to a specific batch |
| `accountId` | For `account_trend` | Account ID from COA |
| `accountType` | No | Extra filter (Income/Expense/Asset/etc.) |
| `includeDraft` | No | `'true'` — only honoured for admin/accountant roles |

**Response shape (monthly metrics):**
```json
{
  "labels": ["Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb"],
  "datasets": [
    { "label": "FY 2021/22", "data": [...] },
    { "label": "FY 2022/23", "data": [...] }
  ],
  "monthOrder": [3,4,5,6,7,8,9,10,11,12,1,2],
  "source": "historical_comparatives",
  "metadata": {
    "financialYearStart": 2021,
    "financialYearEnd": 2023,
    "metric": "revenue",
    "finalizedOnly": true,
    "batches": [...]
  }
}
```

**Response shape (annual_summary):**
```json
{
  "labels": ["FY 2021/22", "FY 2022/23"],
  "datasets": [
    { "label": "Revenue",    "data": [...] },
    { "label": "Expenses",   "data": [...] },
    { "label": "Net Profit", "data": [...] }
  ],
  "source": "historical_comparatives",
  "metadata": { ... }
}
```

### Chart page: `historical-comparatives-charts.html`

Five chart widgets — all using Chart.js (CDN v4, no NPM install required):

| # | Widget | Chart Type | Metric |
|---|--------|-----------|--------|
| 1 | Historical Revenue Trend | Line | `revenue` |
| 2 | Historical Expense Trend | Bar | `expenses` |
| 3 | Historical Net Profit Trend | Line (filled) | `net_profit` |
| 4 | Annual Summary | Grouped Bar | `annual_summary` |
| 5 | Account Trend (interactive) | Line | `account_trend` |

- Every widget displays `Source: Historical Comparatives` badge.
- Every widget has a collapsible "Data source info" panel showing contributing batches (description, source name, FY period, status, finalized date).
- Empty state shown when no data exists — links to the data capture page.
- Year range filters at top — "Apply" button reloads all widgets.
- Draft data toggle — visible only to admin/accountant; ignored for other roles.

### Dashboard summary card (`dashboard.html`)

A "Historical Analysis" card is added to the existing dashboard cards grid. It:
- Fetches `/api/accounting/historical-comparatives/batches?status=finalized`
- Shows the count of finalized batches
- Links to `historical-comparatives-charts.html`
- Is hidden (`display:none`) when no finalized batches exist — does not disrupt the dashboard layout

### Security enforced

- `company_id` always sourced from `req.user.companyId` — never from query params
- Draft data (`finalizedOnly = false`) only exposed when `includeDraft=true` AND user role is `admin` or `accountant`
- `batchId` and `accountId` always parameterized in SQL — never interpolated
- Read-only: no writes to `journals`, `journal_lines`, `bank_transactions`, VAT tables, or any live ledger table

### Tests (`backend/tests/historical-comparatives-dashboard.test.js`)

14 Jest test cases covering:

| Group | Tests |
|-------|-------|
| `_buildChartDataset` — revenue | Correct month order, per-year datasets, zero-fill for missing years |
| `_buildChartDataset` — expenses | Uses Expense rows only |
| `_buildChartDataset` — net_profit | Income minus Expense per month |
| `_buildChartDataset` — account_trend | Uses total_amount directly, populates accountInfo |
| `_buildAnnualSummaryDataset` | Three series, missing-year zero-fill, SA label format, source field |
| `getDashboardTrends` — validation | Invalid metric, fromYear > toYear, account_trend without accountId |
| `getDashboardTrends` — data isolation | SQL includes `is_finalized = true` by default; draft filter when finalizedOnly=false |
| `getDashboardTrends` — company scoping | companyId is first SQL param; SQL injection via metric field is blocked |
| `getDashboardTrends` — chart values | Revenue/net_profit values match mock row data |
| No live writes | All db.query calls are SELECT-only — no INSERT/UPDATE/DELETE |

---

## 9. Chart of Accounts Sub-Account Support

**Session:** Add-on implementation — COA sub-accounts + edit modal sub-account creation flow

### Database migrations added

| Migration | Purpose |
|-----------|---------|
| `044_coa_sub_accounts.sql` | Adds `is_postable`, `account_level`, `display_order`, `created_from_parent` to `accounts` table |
| `045_historical_coa_sync.sql` | Creates `historical_comparative_batch_accounts` helper table; adds snapshot columns to `historical_comparative_lines` |

### New backend endpoint: next-code suggestion

**`GET /api/accounting/accounts/:accountId/sub-accounts/next-code`**

- Returns the suggested next 3-digit suffix for a parent account's next sub-account
- Inspects all existing children (`parent_id = accountId`), finds highest numeric suffix after `/`, returns next padded to 3 digits
- Example: parent `4000` has children `4000/001`, `4000/002` → returns `{ nextSuffix: "003", nextCode: "4000/003" }`
- Fallback if no children exist: `001`

### Parent name prepending rule

`POST /api/accounting/accounts/:accountId/sub-accounts` now constructs the full account name as:

```
fullName = parent.name + " - " + name (from request body)
```

Example:
- Parent: `4000 — Sales Revenue`
- User enters name: `Online Sales`
- Created account name: `Sales Revenue - Online Sales`

The frontend sends the short label only. The backend always prepends the parent name.

### Edit modal "Create Sub Account" button

**File:** `frontend-accounting/accounts.html`

Button `+ Create Sub Account` added to the edit modal action bar (between Cancel and Update Account).

Visibility rules — shown only when ALL conditions are true:
- Currently editing an existing account (`editingId` is set)
- Account is active (`is_active === true`)
- Account is not a child itself (`parent_id` is null)
- Account is not a system account (`is_system === false`)

When clicked: `createSubAccountFromEdit()` closes the edit modal and immediately calls `showSubAccountModal()` with the parent context pre-filled.

### Sub-account modal enhancements

- **Auto-suggested suffix**: On modal open, `_loadNextSuffix()` calls the next-code API and populates the suffix field. Field shows `…` while loading. Fallback to `001` on error.
- **3-digit default**: Suffix API returns values padded to 3 digits (`001`, `002`, `003`). Existing validation (`/^\d{1,4}$/`) remains compatible with legacy 2-digit values.
- **Short name field**: User enters only the short label (e.g. `Online Sales`). Placeholder updated to reflect this.
- **Full name preview**: As user types the short name, a live preview shows the resulting full name: `Full account name: Sales Revenue - Online Sales`. Hidden when field is empty.
- **Focus on name field**: Modal opens with focus on the Name field (not Suffix), since suffix is auto-suggested.
- **Backdrop click**: Clicking outside the modal closes it.

### Parent non-postable behaviour (unchanged rule, now triggered from both surfaces)

First sub-account creation → parent `is_postable = false` (set by backend, idempotent). This means:
- Parent appears with `PARENT` badge in COA table
- Direct journals, bank allocations, and historical capture lines to the parent account are blocked
- Historical Comparatives sync shows parent as a group-row section header (non-editable)

### Tests

| Test | Expected result |
|------|----------------|
| Open `4000 Sales Revenue` edit modal | "Create Sub Account" button visible |
| Open edit modal on inactive account | "Create Sub Account" button hidden |
| Open edit modal on a sub-account | "Create Sub Account" button hidden |
| Click "Create Sub Account" | Edit modal closes; sub-account modal opens with `4000 — Sales Revenue` pre-filled |
| Sub-account modal opens for account with no children | Suffix field auto-fills to `001` |
| Sub-account modal opens for account with `4000/001`, `4000/002` | Suffix auto-fills to `003` |
| Type "Online Sales" in name field | Preview shows `Full account name: Sales Revenue - Online Sales` |
| Submit with suffix `001`, name `Online Sales` | Account `4000/001` created with name `Sales Revenue - Online Sales` |
| Parent `4000` after first sub-account | `is_postable = false`, PARENT badge visible, non-editable in Historical Comparatives |
| Second sub-account creation from edit modal | Suffix auto-suggests `002` |
| Historical Comparatives COA sync | `4000` shows as group row; `4000/001` and `4000/002` show as editable capture rows |
| No localStorage used | Confirmed — all state in DB via API |

---

## 10. Historical Comparatives COA Sync

**Session:** Add-on implementation — COA-driven batch account list + auto-sync

### New backend endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/accounting/historical-comparatives/batch/:batchId/sync-accounts` | Upserts all active COA accounts into the batch accounts table. Blocked for finalized batches. Returns `{ synced, parentRows, captureRows, syncedAt }` |
| `GET /api/accounting/historical-comparatives/batch/:batchId/accounts` | Returns the synced account list with `can_capture` and `captured_lines` per account |

### Helper table: `historical_comparative_batch_accounts`

Stores the ordered account list for each batch snapshot:
- `is_group_row = true` for parent (non-postable) accounts → rendered as section headers
- `is_postable = true` + `is_group_row = false` → rendered as editable capture grids
- `UNIQUE (batch_id, account_id)` — safe to re-sync repeatedly (upsert)
- Finalized batches: sync endpoint returns 403 — account list is frozen

### Frontend COA-driven capture grid

**File:** `frontend-accounting/historical-comparatives.html`

**On batch open (`renderCaptureMain`):**
1. Loads synced accounts (`GET /batch/:id/accounts`) and existing lines (`GET /batch/:id/lines`) in parallel
2. If no accounts exist and batch is not finalized: **auto-syncs COA** immediately
3. Builds `lineDataMap` (account_id → year → month → amount) for grid pre-population
4. Any line-only accounts (added before first sync) are preserved below the synced list
5. Group rows render as `.group-row-header` section dividers (indigo left-border, non-editable)
6. Postable rows render as full editable 12-month × N-year grids

**COA Sync Bar (shown above all account grids):**
- Shows last sync timestamp: `Synced with Chart of Accounts: [datetime]`
- `↻ Sync COA` button — calls `POST /batch/:id/sync-accounts`, then full re-render
- Finalized batches: shows locked note instead of sync button

### Finalized batch behaviour

- Sync button hidden; replaced with: "Chart of Accounts changes will no longer sync into this finalized batch."
- All amount inputs `disabled` (read-only display)
- Locked banner shown at top of capture area

---

## 11. Account Search Fix (2026)

**Symptom reported:** UI shows "Failed to search accounts." when typing in the COA search box. Capture grid was empty on batch open.

### Root Cause Analysis

**Primary root cause — Migration 044 not applied to production Supabase:**

The `searchAccounts` service method selected and filtered on the `is_postable` column
(added by `044_coa_sub_accounts.sql`). If that migration had not been run, PostgREST returned:

```
{ code: "42703", message: "column accounts.is_postable does not exist" }
```

The service method called `if (error) throw error;` → route caught it and returned 500
`{ error: "Failed to search accounts." }` → frontend `api()` helper threw that as an error
message → catch block displayed "Failed to search accounts." — exactly what the user saw.

`syncBatchAccountsFromCOA` had the same problem: it also selects `is_postable`,
`display_order`, and `account_level` (all added by migration 044). If that migration
was missing, the COA auto-sync on batch open also failed — explaining the empty capture grid.
The auto-sync previously swallowed this error silently; it now surfaces it to the user.

**Secondary issues also fixed in this session:**

| Bug | Location | Impact |
|-----|----------|--------|
| `searchAccounts` filtered `.eq('is_postable', true)` | Service | Excluded parent accounts (wrong — task requires them returned with flag) |
| Response format used `id`/`code`/`name` | Service | Mismatch: `selectAccount` expected these; charts page expected `account_code`/`account_id` |
| `saveManualLine` inserted `synced_from_coa`/`coa_synced_at` | Service | These columns don't exist in any migration → every save failed |
| Error handler returned `{ error: "..." }` only | Route | Frontend couldn't distinguish "column missing" from any other error |
| Charts page used `a.id`/`a.name` | `historical-comparatives-charts.html` | Mixed format (used `a.account_code` already but `a.id` not `a.account_id`) |

### Migrations Required (MUST be applied before feature works end-to-end)

Both migrations are safe to re-run (use `IF NOT EXISTS` / `IF EXISTS`).

| Migration | Purpose | How to apply |
|-----------|---------|--------------|
| `044_coa_sub_accounts.sql` | Adds `is_postable`, `account_level`, `display_order`, `created_from_parent` to `accounts` table | Supabase dashboard → SQL Editor → paste file → Run |
| `045_historical_coa_sync.sql` | Creates `historical_comparative_batch_accounts`; adds snapshot columns to `historical_comparative_lines` | Supabase dashboard → SQL Editor → paste file → Run |

### Code Changes Made

**`services/historicalComparativesService.js`**
- `searchAccounts`: removed `.eq('is_postable', true)` filter (returns ALL active accounts including parents); added `42703` graceful fallback (retries without `is_postable` if column doesn't exist yet); updated return format to `{ account_id, account_code, account_name, account_type, parent_account_id, is_postable, has_children }`; limit increased to 50.
- `syncBatchAccountsFromCOA`: added `42703` graceful fallback (retries with reduced column select if migration 044 not applied yet).
- `saveManualLine`: removed `synced_from_coa` and `coa_synced_at` from `lineData` — these columns do not exist in any migration.

**`routes/historicalComparatives.js`**
- Search route 500 handler: now returns `{ error: "...", detail: error.message }` so the frontend can display a useful diagnostic.

**`frontend-accounting/historical-comparatives.html`**
- `api()` helper: includes `json.detail` in the thrown error when present.
- `searchAccounts`: renders with `a.account_code` / `a.account_name`; non-postable accounts shown with `⊕` marker, click disabled, title tooltip; catch shows "Failed to search accounts: [detail]".
- `selectAccount`: uses `account.account_id` / `account.account_code` / `account.account_name`; blocks capture to non-postable accounts with a clear user message.
- COA auto-sync catch: no longer silent — shows error message with migration guidance.

**`frontend-accounting/historical-comparatives-charts.html`**
- `searchAccounts`: uses `a.account_id` (was `a.id`) and `a.account_name` (was `a.name`).

### Tests to Run After Applying Migrations

| Test | Expected result |
|------|----------------|
| Open batch → capture tab | COA auto-syncs; grid shows accounts |
| Search "4000" | Returns `Sales Revenue` with `is_postable` flag |
| Search "sales" | Returns `Sales Revenue` |
| Search another company's account | Not returned |
| Parent account returned | Shown with `⊕` badge; click does nothing |
| Click non-postable account | Warning "Parent account — select a sub-account" |
| Click postable account | Grid added; save works |
| Save grid | No error about `synced_from_coa` column |
| Charts page account search | Populates select with `account_id` as option value |
| Migrations NOT applied | Search returns "Failed to search accounts: column accounts.is_postable does not exist" — clear actionable message instead of blank failure |
| No localStorage used | Confirmed — all state in DB via API |

---

*Report updated to include Account Search Fix — root cause analysis, migration requirements, code changes.*
*All fixes follow CLAUDE.md Part A (audit-before-change), Part D (no browser storage), and Part E (payroll unaffected).*

---

## 12. Expand/Collapse Tree UI

**Session:** Add-on implementation — Expandable/collapsible account group tree in `historical-comparatives.html`  
**Scope:** Frontend / UI only — no backend changes, no schema changes, no calculation changes.

---

### Overview

The Historical Comparatives capture screen renders a flat list of account rows: group/parent rows (`is_group_row: true`, non-editable section headers) interleaved with postable child rows (`can_capture: true`, editable 12-month × N-year grids). This enhancement converts that flat list into a collapsible tree — each group header is clickable and toggles the visibility of its children.

---

### Rendering Logic

`buildGroupedRows(rows, years, disabled)` replaces the previous `allRows.map(acc => ...)` call in `renderCaptureMain`.

**Structure produced:**

```html
<div class="group-row-header expanded" id="grphdr_gid{id}" onclick="toggleGroup('{gid}')">
  <span class="group-toggle-arrow">▼</span>
  <span class="group-code">4000</span>
  <span class="group-name">Sales Revenue</span>
  <span class="group-badge">Income</span>
</div>
<div class="group-children" data-group-children="{gid}">
  <!-- one .account-grid-block per postable child -->
</div>
```

Each group section is a header `<div>` immediately followed by a sibling `<div class="group-children">` wrapper. The wrapper uses `data-group-children="{gid}"` as its selector key — not an `id` attribute — so the selector is always predictable regardless of content.

**`buildGroupedRows` flow:**
1. Iterates `rows` in order
2. When `acc.is_group_row === true` → closes any open `group-children` wrapper, emits new header + opens new `group-children` wrapper, adds `gid` to `expandedGroups`
3. Otherwise → emits `buildAccountGrid(acc, years, disabled)` inside the current open wrapper
4. Closes final wrapper after loop

**Default state:** All groups are expanded on first load. `expandedGroups` is populated by `buildGroupedRows` with every `gid` at render time.

---

### State Handling

```javascript
let expandedGroups = new Set();
```

- Module-level variable (same scope as `currentLines`, `currentBatchId`, etc.)
- **Frontend state only** — never persisted to DB, never sent to the server
- Re-initialized on every `renderCaptureMain` call (all groups open after each page re-render)
- `toggleGroup(gid)` adds/removes from the Set as the user expands/collapses
- `expandAllGroups()` / `collapseAllGroups()` bulk-updates both the Set and DOM

---

### toggleGroup / expandAllGroups / collapseAllGroups

```javascript
function toggleGroup(gid) {
  const childWrapper = document.querySelector('[data-group-children="' + gid + '"]');
  const header = document.getElementById('grphdr_' + gid);
  if (expandedGroups.has(gid)) {
    expandedGroups.delete(gid);
    childWrapper.style.display = 'none';      // CSS hide only — DOM nodes remain
    header.classList.remove('expanded');
    header.querySelector('.group-toggle-arrow').innerHTML = '&#9654;'; // ▶
  } else {
    expandedGroups.add(gid);
    childWrapper.style.display = '';          // Restore natural display
    header.classList.add('expanded');
    header.querySelector('.group-toggle-arrow').innerHTML = '&#9660;'; // ▼
  }
}
```

`expandAllGroups` and `collapseAllGroups` iterate `[data-group-children]` elements and `.group-row-header` elements respectively to bulk-set state.

---

### groupId() — DOM-safe ID generation

```javascript
function groupId(acc) {
  if (acc.account_id) return 'gid' + acc.account_id;
  return 'gc' + (acc.account_code || acc.account_name || '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 40);
}
```

Always returns an alphanumeric + underscore string. This makes it safe as:
- HTML `id` attribute value (`grphdr_{gid}`)
- CSS attribute selector value (`[data-group-children="{gid}"]`)
- JavaScript `onclick` string argument (`toggleGroup('{gid}')`)

Special characters in account names (slashes, spaces, parentheses) are replaced with `_` before use.

---

### Performance Approach

Children are hidden with `style.display = 'none'` — **DOM nodes are not removed**. This was a deliberate correctness-over-performance decision:

- `saveAllGrids()` uses `document.querySelectorAll('.account-grid-block')` — this traverses all DOM nodes regardless of CSS visibility. Hidden children are still found and their data is still saved.
- Removing hidden children from the DOM would cause `saveAllGrids()` to silently skip them — a data-loss bug.
- For the dataset sizes in historical comparatives (typically < 300 accounts), the DOM overhead of keeping hidden nodes is negligible.

If performance becomes a concern with very large COAs (>500 accounts), a lazy-render approach could be introduced in a future session. For now, correctness takes priority.

---

### Expand All / Collapse All Buttons

Two buttons added to the existing action row (alongside Validate, Finalize, Sync COA):

```html
<button type="button" class="btn btn-secondary btn-sm"
        onclick="expandAllGroups()" title="Expand all account groups">
  &#9660; Expand All
</button>
<button type="button" class="btn btn-secondary btn-sm"
        onclick="collapseAllGroups()" title="Collapse all account groups">
  &#9654; Collapse All
</button>
```

---

### CSS Additions

```css
.group-row-header { cursor: pointer; user-select: none; }
.group-row-header:hover { background: #eef2ff; border-left-color: #6366f1; }
.group-toggle-arrow {
  font-size: 11px; color: #9ca3af; min-width: 14px;
  display: inline-block; transition: color 0.15s; font-style: normal;
}
.group-row-header.expanded .group-toggle-arrow { color: #4f46e5; }
```

The `cursor: pointer` and `user-select: none` on `.group-row-header` prevent text selection when clicking to collapse/expand. The `expanded` class on the header drives the arrow colour transition (grey → indigo).

---

### Preserved Behaviours (not regressed)

| Behaviour | Status |
|-----------|--------|
| `saveAllGrids()` saves all accounts including collapsed | ✅ CSS hide only — all DOM nodes intact |
| Per-account Save button | ✅ Unchanged — inside `.account-grid-block`, always in DOM |
| Validate / Finalize / Sync COA buttons | ✅ Not affected — separate action row elements |
| Finalized batch — all inputs disabled | ✅ `isFinalized` flag passed through `buildGroupedRows` → `buildAccountGrid` as before |
| Finalized banner | ✅ Rendered before `buildGroupedRows`, not inside it |
| Report generation (Monthly P&L) | ✅ Reads from DB — no dependency on frontend DOM state |
| Year/month data mapping in grids | ✅ `buildAccountGrid` is unchanged — only called from a new wrapper function |
| Add Account (manual line) | ✅ Adds below the synced list — outside group wrappers, unaffected |
| Keyboard navigation (Tab/Enter in grids) | ✅ Grid input structure unchanged |
| No localStorage writes | ✅ `expandedGroups` is module-level JS only — never persisted |

---

### Files Changed

| File | Change |
|------|--------|
| `frontend-accounting/historical-comparatives.html` | CSS additions; `expandedGroups` state variable; `buildGroupRowHeader` updated (arrow, id, onclick); `groupId()`, `buildGroupedRows()`, `toggleGroup()`, `expandAllGroups()`, `collapseAllGroups()` added; `allRows.map(...)` replaced with `buildGroupedRows(...)`; Expand All / Collapse All buttons added to action row |

No backend files changed. No migration required.
