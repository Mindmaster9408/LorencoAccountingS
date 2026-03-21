# Chart of Accounts & Division Reporting Architecture
> Created: 2026-03-21
> Status: Implemented

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:
    Accounting module — Chart of Accounts template model, segment/division model,
    division P&L reporting, company.html division management UI

- Files/services involved:
    backend/config/accounting-schema.js          — schema auto-migration (coa_segments fix)
    backend/modules/accounting/routes/segments.js — complete CRUD rewrite
    backend/modules/accounting/routes/reports.js  — new division-profit-loss endpoint + fetchAccountBalances untagged support
    frontend-accounting/division-pl.html          — new Division P&L page
    frontend-accounting/js/navigation.js          — new nav link
    frontend-accounting/company.html              — new Division Management section

- Current behaviour identified:
    - coa_segments table missing `code` and `description` columns; segments.js was
      selecting and inserting them, causing all segment API calls to fail silently
    - segments.js only had GET + seed-farming (108 lines). No CRUD for segments or values.
    - fetchAccountBalances had no 'untagged' (IS NULL) support
    - No division P&L page existed
    - company.html had no division management UI

- Required behaviours to preserve:
    1. Existing P&L report (reports.html) — segmentValueId filter unchanged
    2. Balance Sheet — fetchAccountBalances with no filter unchanged
    3. Trial Balance — unchanged
    4. Journal line segment_value_id FK — schema unchanged
    5. Multi-tenant isolation — all segment/value queries enforce company_id

- Risk of regression:
    LOW. The fetchAccountBalances change is strictly additive (new branch for 'untagged').
    The segments.js rewrite replaces a file that was broken anyway.

- Related dependencies:
    reports.html segment picker (loadSegments()) — uses GET /segments, unchanged API contract
    journals.html segment tagging — uses segment_value_id on journal lines, unchanged
    database: coa_segments, coa_segment_values, journal_lines.segment_value_id
```

---

## 1. Chart of Accounts Template Architecture

### Schema tables

| Table | Purpose |
|---|---|
| `coa_templates` | Named templates (e.g. "Standard SA Base", "Farming Overlay") |
| `coa_template_accounts` | Account definitions per template (code, name, type, sub_type, etc.) |
| `company_template_assignments` | Which templates have been applied to a company |
| `accounts` | Per-company Chart of Accounts (instantiated from templates or created manually) |

### Instantiation model

Templates are **read-only reference sets**. When a template is applied to a company, accounts are copied into the `accounts` table for that company's `company_id`. After that, the company's COA is fully independent — no shared mutable state across companies.

**Architecture rule: Each company owns its own accounts. Templates only bootstrap the initial account set.**

### Standard SA Base template

Seeded in `012_accounting_schema.sql`. 76 accounts covering:
- Assets: Bank, Debtors, Inventory, Fixed Assets, VAT Input
- Liabilities: Creditors (AP), VAT Output, Loans, Tax Payable
- Equity: Share Capital, Retained Earnings
- Income: Revenue (operating_income sub_type)
- Expenses: Cost of Sales, Salaries, Rent, Utilities, Marketing, Depreciation, Bank Charges, Finance Costs

### Account sub_type taxonomy

Used for P&L sectioning. Without `sub_type`, accounts default to `operating_income` or `operating_expense` based on type.

| sub_type | Section | Balance direction |
|---|---|---|
| `operating_income` | Revenue | credit – debit |
| `cost_of_sales` | Cost of Sales | debit – credit |
| `other_income` | Other Income | credit – debit |
| `operating_expense` | Operating Expenses | debit – credit |
| `depreciation_amort` | Depreciation | debit – credit |
| `finance_cost` | Finance Costs | debit – credit |

---

## 2. Division / Segment Model

### Schema tables

| Table | Purpose |
|---|---|
| `coa_segments` | Named tracking dimensions per company (e.g. "Farm Division") |
| `coa_segment_values` | Division values per segment (e.g. Cattle, Nuts, General) |
| `journal_lines.segment_value_id` | FK — tags each journal line to a division |

**Schema fix applied (2026-03-21):** `coa_segments` was missing `code VARCHAR(50)` and `description TEXT` columns. Added via `accounting-schema.js` auto-migration with a safe backfill (`code = 'SEG_' || id` for any rows without a code).

### Design rules

1. **One company can have multiple segments** (tracking dimensions, e.g. "Farm Division", "Property Division")
2. **Each segment has multiple values** (the actual divisions, e.g. Cattle, Nuts, General)
3. **Transactions tag the segment value** — NOT the account. The same account (e.g. 7100 — Salaries) is shared across all divisions. The division tag lives on the journal line.
4. **Soft-delete only** — deactivating a segment/value preserves all historical journal line tags for reporting
5. **Attendance and payroll are not affected** — this model is accounting-only

### Segment CRUD API

All endpoints at `/api/accounting/segments` require authentication.

| Method | Path | Purpose |
|---|---|---|
| GET | `/segments` | List all active segments + their active values |
| POST | `/segments` | Create a segment (with optional initial values) |
| PUT | `/segments/:id` | Update segment name/description |
| DELETE | `/segments/:id` | Soft-delete segment |
| POST | `/segments/:id/values` | Add a division value |
| PUT | `/segments/:id/values/:valueId` | Update value name/color/sort_order |
| DELETE | `/segments/:id/values/:valueId` | Soft-delete value |
| POST | `/segments/seed-farming` | Seed Cattle/Nuts/General defaults (idempotent) |

---

## 3. Division P&L Report

### Endpoint

```
GET /api/accounting/reports/division-profit-loss?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
```

### What it returns

A single response with:
- **`columns`** — one column per active division value + `{ id: 'untagged' }` + `{ id: 'total' }`
- **`sections`** — same 6-section structure as the single-division P&L (operatingIncome, costOfSales, otherIncome, operatingExpenses, depreciation, financeCosts)
- Each account row has a **`values`** map: `{ [columnId]: balance }`
- **`totals`** — subtotals per column: grossProfit, operatingProfit, netProfit, etc.

### How filtering works

`fetchAccountBalances` now supports three modes via `segmentValueId`:

| Value | Behaviour |
|---|---|
| `undefined` / `null` | ALL journal lines (existing behaviour — used by Balance Sheet, Trial Balance, standard P&L) |
| `'untagged'` | Only journal lines WHERE `segment_value_id IS NULL` |
| `'123'` (numeric string) | Only journal lines WHERE `segment_value_id = 123` |

The standard P&L endpoint (`/profit-loss`) passes `segmentValueId` from query param as-is, so it continues to filter by a single division value exactly as before.

### Performance note

The division P&L makes N+2 calls to `fetchAccountBalances` (one per division + untagged + total). For companies with 10+ divisions this could be slow. This is acceptable for the current client profile (farming companies with 2-5 divisions). If performance becomes a concern, the approach is to fetch ALL journal lines once and aggregate in-memory rather than making multiple DB calls.

---

## 4. Division Management UI (company.html)

A new "Business Divisions" section in company.html allows:
- Viewing all segments and their division values (colour-coded chips)
- Creating a new segment
- Adding division values with a name and colour picker
- Soft-deleting segments and values (with confirmation)
- Seeding farming defaults (Cattle / Macadamia / Nuts / General) via one click

---

## 5. Division P&L Frontend (division-pl.html)

Available at `/accounting/division-pl.html`. Navigation link added to "Financial" section of the Reports dropdown.

Features:
- Date range picker (defaults to current year)
- Calls `GET /api/accounting/reports/division-profit-loss`
- Renders columns: one per active division + Untagged + Total
- Division column headers respect the division's assigned colour
- Rows hidden when all columns show zero (no activity)
- Net Profit row colour-coded green/red per column
- Print/Export button (hides controls, prints the table)
- Handles no-divisions state gracefully (shows link to company.html)

---

## 6. Files Changed

| File | Change |
|---|---|
| `backend/config/accounting-schema.js` | Added `ALTER TABLE coa_segments ADD COLUMN IF NOT EXISTS code / description` + backfill |
| `backend/modules/accounting/routes/segments.js` | Complete rewrite: full CRUD (7 routes, 323 lines) |
| `backend/modules/accounting/routes/reports.js` | `fetchAccountBalances`: untagged support. New `division-profit-loss` route. |
| `frontend-accounting/division-pl.html` | New page — Division P&L report |
| `frontend-accounting/js/navigation.js` | Added "Division P&L" link in Reports → Financial dropdown |
| `frontend-accounting/company.html` | Added Division Management section (CSS + HTML + JS) |

---

## 7. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Division tagging on journal entry UI
- Dependency: journals.html journal entry form
- What was done now: Schema, API, and reporting are complete. Segment values can be
  created and managed. Division P&L report is functional.
- What still needs to be checked:
    journals.html does NOT yet have a segment value dropdown on journal lines.
    Users cannot tag lines to divisions from the journal entry form yet.
    This means division P&L will show all activity in "Untagged" until tagging is added.
- Risk if not added: Division P&L works technically but shows no data per division
  until journal lines have segment_value_id populated.
- Recommended next review point: When a client actively needs division reporting.
  Priority: HIGH for farming clients with the Farm Division segment seeded.
```

```
FOLLOW-UP NOTE
- Area: Division P&L performance for companies with many divisions
- Dependency: fetchAccountBalances called N+2 times
- What was done now: Each division/untagged/total makes a separate DB call.
  For 2-5 divisions this is fast. For 15+ divisions, latency grows linearly.
- What still needs to be checked:
    If any client has more than 10 divisions, refactor to: fetch all lines once,
    aggregate in-memory by segment_value_id.
- Risk if wrong: Slow report generation for large division counts (unlikely for current clients)
- Recommended next review point: When any company has more than 8 divisions
```

```
FOLLOW-UP NOTE
- Area: Division reporting — balance sheet and trial balance are not division-filtered
- Dependency: Design decision
- What was done now: Division filtering only applies to P&L (income/expense accounts).
  Balance sheet (asset/liability/equity) is company-level only.
- What still needs to be checked:
    Some clients may want divisional balance sheets (e.g. assets owned per division).
    This would require division tagging to extend to all journal lines, not just P&L.
- Risk if wrong: No risk for current implementation — standard SA practice for farming
  is division P&L only, not division balance sheet.
- Recommended next review point: Only if a client explicitly requests it.
```
