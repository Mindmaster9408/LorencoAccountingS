# Codebox 26 — Provisional Tax Planning + Tax Calendar Foundation

**Status:** Complete  
**Date:** 2026-06-21  
**Module:** Practice Management — `/api/practice/provisional-tax`

---

## What This Is

A structured planning layer for provisional tax (IRP6) per client per tax year.  
The practice can record estimated taxable income, planning due dates, period-by-period submission tracking, and review status — without any automatic tax calculation.

**This is NOT:**
- Final income tax calculation
- SARS eFiling integration
- Automatic IRP6 generation
- A provisional tax engine (no PAYE/tax brackets applied)

**This IS:**
- One plan per taxpayer profile per tax year
- Period 1 / Period 2 / Top-up tracking rows
- Editable due dates (SA planning defaults pre-populated for individual taxpayers)
- Estimated taxable income + estimated tax due (entered by practice, not computed)
- Actual amounts submitted/paid once the period is complete
- Status flow: draft → collecting_info → ready_for_review → reviewed → submitted → completed
- Audit event log per plan

---

## Database (Migration 076)

Run `accounting-ecosystem/backend/config/migrations/076_practice_provisional_tax_planning.sql` once in Supabase SQL Editor.

### Tables Created

| Table | Purpose |
|---|---|
| `practice_provisional_tax_plans` | One plan per taxpayer profile per tax year — estimates, due dates, review status |
| `practice_provisional_tax_periods` | Period 1, Period 2, and Top-up rows per plan — individual tracking |
| `practice_provisional_tax_events` | Audit event log per plan and period |

### Key Design Decisions

- `period_1_due_date`, `period_2_due_date`, `topup_due_date` are editable fields — planning defaults only, not legal authority.
- For **individual taxpayers** (Feb year-end), defaults are: P1 = 31 Aug prior to tax year end; P2 = 28 Feb; Top-up = 30 Sep.
- For **companies**, all due dates are null by default — financial year-end varies per company, practice fills in manually.
- `estimated_tax_due` on periods is a placeholder entered by the practice — **no tax is computed**.
- Soft cancel: DELETE sets `status = 'cancelled'`, no row removed.
- `related_compliance_pack_id`, `related_deadline_id`, `related_workflow_run_id` are reference-only cross-links (no FK constraints).

---

## Backend (provisional-tax.js)

File: `accounting-ecosystem/backend/modules/practice/provisional-tax.js`  
Mounted at: `/api/practice/provisional-tax` via `practice/index.js`

### Routes (in registration order)

```
GET    /summary                                   Summary counts + upcoming P1/P2 counts
GET    /                                          List plans (filters: client_id, tax_year, status, taxpayer_profile_id)
POST   /                                          Create a plan (auto-populates default due dates for individuals)

GET    /:id                                       Get one plan + its periods
PUT    /:id                                       Update plan fields
DELETE /:id                                       Soft-cancel (status = 'cancelled')

POST   /:id/create-periods                        Create period_1, period_2, topup rows (409 if all already exist)
PUT    /:id/periods/:periodId/status              Update period status only (registered before general PUT)
PUT    /:id/periods/:periodId                     Update all period fields (due date, estimates, actuals, references)
POST   /:id/review                                Mark plan as reviewed (must be in ready_for_review or reviewed status)
GET    /:id/events                                Event audit log for this plan
```

### Due Date Default Logic

```javascript
// For individuals (Feb year-end — tax_year = 2026 means Mar 2025 – Feb 2026):
period_1_due_date = `${taxYear - 1}-08-31`  // 31 Aug before year-end
period_2_due_date = `${taxYear}-02-28`       // 28 Feb (year-end)
topup_due_date    = `${taxYear}-09-30`       // 30 Sep after year-end

// For companies: null — practice sets manually
```

**These are planning defaults, not legal determinations. SARS dates are subject to change.**

### Validation

- `tax_year` must be 2000–2099
- `amount_*` and `estimated_*` fields must be >= 0
- `company_id` sourced from JWT only — never accepted from request body
- `client_id` and `taxpayer_profile_id` verified to belong to this company before insert
- Status enums enforced for both plans and periods

---

## Frontend (provisional-tax.html + js/provisional-tax.js)

### Summary Cards

| Card | Shows |
|---|---|
| Total Plans | All non-cancelled plans |
| Draft / Collecting | Plans in draft + collecting_info |
| Ready for Review | Plans in ready_for_review |
| Reviewed / Done | reviewed + submitted + completed |
| P1 Upcoming | Plans where period_1_due_date >= today |
| P2 Upcoming | Plans where period_2_due_date >= today |

### Plan List Table

Columns: Tax Year, Client/Plan Name, Status, P1 Due (with overdue/soon badge), P2 Due, Actions

Due date badge colouring:
- Overdue (past today): red
- Due within 30 days: amber
- Future: plain

### Create Plan Modal

- Client selector (loads from `/api/practice/clients`)
- Taxpayer Profile selector (loads from `/api/practice/taxpayer-profiles?client_id=X` after client selected)
- Tax Year + Plan Name (auto-names as `[Type] IRP6 [Year]`)
- Prior year taxable income + current estimate
- P1 / P2 due dates (pre-populated by auto-name trigger; editable)
- Notes

### Plan Detail Modal — 3 Tabs

**Overview**
- Key fields grid (tax year, status, estimates, due dates, reviewed at)
- Editable: estimate basis, risk notes
- Actions: Save Changes, Update Status dropdown, Mark Reviewed, Create Periods

**Periods**
- One expandable row per period (P1, P2, Top-up)
- Per period: due date, estimated taxable income, estimated tax due, amount submitted, amount paid, submission ref, notes
- Per-period status change (inline select + Update Status button)
- Save button per period row

**History**
- Event log loaded on tab open — shows event type, status transition, timestamp, notes

### nav/layout.js

`Provisional Tax` added as nav tab after `Taxpayer Profiles`.

---

## Client Detail Page (Section 19)

**Section 19** (`provisionalTaxSection`) added after section 18 (Taxpayer Profiles):
- Shows up to 6 active plans for the client
- "View All →" link (pre-filtered to this client)
- "+ New Plan" button (lightweight create modal)

**Create Plan Modal** (`cdCreatePlanModal`):
- Fields: Taxpayer Profile (loaded for this client), Tax Year, Plan Name (auto-generated), Notes
- On open: loads taxpayer profiles async for the current client
- On submit: POST `/api/practice/provisional-tax` with `client_id` from URL

---

## Multi-Tenant Safety

Every query includes `.eq('company_id', req.companyId)`.  
`req.companyId` sourced from JWT only.  
Client and taxpayer profile ownership verified before plan creation.  
No user-supplied `company_id` accepted.

---

## No Browser Storage

Zero use of `localStorage`, `sessionStorage`, or `safeLocalStorage` for business data.  
All provisional tax data is stored in Supabase PostgreSQL exclusively.

---

## Recommended Next Codebox

**Codebox 27 — Individual Income Tax Data Capture Foundation**

Build the structured individual tax data capture layer:
- IRP5 income entries per taxpayer profile + tax year
- Medical expense declarations (medical aid contributions, out-of-pocket)
- Retirement annuity contributions
- Travel allowance / logbook records
- Rental income and expense capture
- Investment income (interest, dividends)
- Donations (s18A)
- Capital gains events

No tax calculation yet — just structured capture and readiness tracking.  
Feeds into a future ITR12 capture workflow.
