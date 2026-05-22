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

*Report updated to include Dashboard Chart Integration add-on.*
*Full implementation follows CLAUDE.md Part D (no browser storage) and Part A (audit-before-change) standards.*
