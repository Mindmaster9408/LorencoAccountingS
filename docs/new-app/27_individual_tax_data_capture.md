# Codebox 27 — Individual Income Tax Data Capture Foundation

**Status:** Complete  
**Date:** 2026-06-21  
**Module:** Practice Management — `/api/practice/individual-tax`

---

## What This Is

Structured data capture for individual income tax (ITR12) per taxpayer profile per tax year.  
The practice captures income entries, deduction entries, and a readiness checklist — without any automatic tax calculation.

**This is NOT:**
- Final income tax calculation or ITR12 computation
- SARS eFiling integration
- Automatic ITR12 generation
- Tax engine (no brackets, no rebates applied)

**This IS:**
- One tax return record per taxpayer profile per tax year
- Structured income entries (salary, pension, interest, rental, capital gain, etc.)
- Structured deduction entries (medical, RA, travel, donations, home office, etc.)
- Document readiness checklist (IRP5, medical cert, RA cert, etc.)
- Readiness scoring: done/required × 100, blocked overrides
- Status flow: draft → collecting_docs → data_captured → ready_for_review → reviewed → submitted → completed
- Audit event log per return

---

## Database (Migration 077)

Run `accounting-ecosystem/backend/config/migrations/077_practice_individual_tax_data.sql` once in Supabase SQL Editor.

### Tables Created

| Table | Purpose |
|---|---|
| `practice_individual_tax_returns` | One return per taxpayer profile per tax year |
| `practice_individual_tax_items` | Document / checklist items with readiness status |
| `practice_individual_tax_income_entries` | Income source entries (type, gross, PAYE withheld) |
| `practice_individual_tax_deduction_entries` | Deduction entries (type, amount, reference) |
| `practice_individual_tax_events` | Audit event log per return |

### Indexes (21 total)

6 on `practice_individual_tax_returns` (company, client, profile, year, status, readiness)  
4 on `practice_individual_tax_items` (company, return, type, status)  
3 on `practice_individual_tax_income_entries` (company, return, type)  
3 on `practice_individual_tax_deduction_entries` (company, return, type)  
4 on `practice_individual_tax_events` (company, return, type, created_at DESC)

---

## Backend (individual-tax.js)

File: `accounting-ecosystem/backend/modules/practice/individual-tax.js`  
Mounted at: `/api/practice/individual-tax` via `practice/index.js`

### Routes (in registration order)

```
GET    /summary                                         Summary counts by status + readiness
GET    /                                                List returns (filters: client_id, taxpayer_profile_id, tax_year, status, readiness_status)
POST   /                                                Create a return

POST   /:id/generate-default-items                      Generate 9 default checklist items; ?force=true appends only missing types
POST   /:id/recalculate-readiness                       Compute readiness score from items; save to return row

GET    /:id/items                                       List checklist items + readiness snapshot
POST   /:id/items                                       Add a checklist item
PUT    /:id/items/:itemId                               Update item (status, amount, notes)
DELETE /:id/items/:itemId                               Hard delete

GET    /:id/income                                      List income entries + gross/withheld totals
POST   /:id/income                                      Add income entry
PUT    /:id/income/:incomeId                            Update income entry
DELETE /:id/income/:incomeId                            Hard delete

GET    /:id/deductions                                  List deduction entries + total
POST   /:id/deductions                                  Add deduction entry
PUT    /:id/deductions/:deductionId                     Update deduction entry
DELETE /:id/deductions/:deductionId                     Hard delete

GET    /:id/events                                      Event audit log (last 100)

GET    /:id                                             Get one return (full detail)
PUT    /:id                                             Update return (status, notes, links, reviewer)
DELETE /:id                                             Soft cancel (status = 'cancelled')
```

**Route ordering note:** All 3-segment and 4-segment literal routes registered before generic `/:id`, `PUT /:id`, `DELETE /:id` to prevent Express treating literal path segments as `:id` values.

### Readiness Logic

```
DONE_STATUSES = ['received', 'captured', 'reviewed', 'waived']

required_items = items WHERE item_status != 'not_applicable'

if required_items.length == 0 → status = 'unknown', score = null
if any required_items.item_status == 'blocked' → status = 'blocked'
elif done_count / required_items.length * 100 >= 85 → status = 'ready'
elif done_count / required_items.length * 100 >= 50 → status = 'partial'
else → status = 'incomplete'
```

Readiness is **never auto-recalculated**. Practice clicks "Recalc Readiness" or calls `POST /:id/recalculate-readiness`.

### Default Checklist Items (generated by `generate-default-items`)

| Type | Label |
|---|---|
| `irp5` | IRP5 / IT3(a) Certificate |
| `medical` | Medical Aid Tax Certificate |
| `retirement_annuity` | Retirement Annuity Certificate (IT3f) |
| `investment` | Investment Certificates (IT3b/IT3c) |
| `rental` | Rental Income Schedule |
| `travel` | Travel Logbook / Allowance Record |
| `donations` | Donations Certificate (s18A) |
| `capital_gain` | Capital Gains Support Documents |
| `document` | Bank Details Confirmation |

`?force=true` appends only item types not already present. Returns 409 if all types exist and force not passed.

### Validation

- `tax_year` must be 2000–2099
- `gross_amount`, `tax_withheld`, `amount` must be >= 0
- `income_type`, `deduction_type`, `item_type`, `item_status`, `status` enums enforced
- `company_id` sourced from JWT only — never accepted from request body
- `client_id` and `taxpayer_profile_id` verified to belong to this company before insert

---

## Frontend (individual-tax.html + js/individual-tax.js)

### Summary Cards

| Card | Shows |
|---|---|
| Total Active | All non-cancelled returns |
| Draft / Collecting | draft + collecting_docs |
| Ready for Review | ready_for_review count |
| Reviewed / Done | reviewed + submitted + completed |
| Readiness: Ready | readiness_status = ready |
| Readiness: Blocked | readiness_status = blocked |

### Return List Table

Columns: Tax Year, Client, Return Name, Status, Readiness, Score, Actions

### Create Return Modal

- Client selector + Taxpayer Profile selector (loads after client selected)
- Tax Year + Return Name (auto-generates `ITR12 [Year]`)
- Optional: Link to Provisional Tax Plan ID, Compliance Pack ID
- Notes

### Return Detail Modal — 5 Tabs

**Overview:** Status + readiness display, update status, recalc readiness, generate checklist, notes fields  
**Checklist:** Inline status dropdowns per item, add/delete items  
**Income:** Gross + withheld totals, entry cards with edit modal  
**Deductions:** Total deductions bar, entry cards with edit modal  
**History:** Lazy-loaded event log

### nav/layout.js

`Individual Tax` added as nav tab after `Provisional Tax`.

---

## Client Detail Page (Section 20)

`individualTaxSection` added after section 19 (Provisional Tax Plans).  
Shows up to 6 active returns: tax year, return name, status, readiness label + score.  
"+ New Return" opens `cdCreateItReturnModal` — lightweight modal that loads profiles async when opened.

---

## Multi-Tenant Safety

Every query scoped to `company_id = req.companyId` from JWT.  
`client_id` and `taxpayer_profile_id` verified against `company_id` before insert.  
No user-supplied `company_id` accepted in any route.

---

## No Browser Storage

Zero use of `localStorage`, `sessionStorage`, or `safeLocalStorage` for business data.  
All individual tax data is stored in Supabase PostgreSQL exclusively.

---

## Recommended Next Codebox

**Codebox 28 — Individual Income Tax Calculation Draft Engine Foundation**

With structured data capture now in place, build a draft tax calculation engine:
- Apply SA tax brackets (based on tax year) to total taxable income
- Primary rebate, secondary rebate (65+), tertiary (75+)
- Medical tax credits (monthly contributions × members)
- RA deduction cap (15% of non-retirement income, capped at R350,000)
- s18A donations deduction cap (10% of taxable income)
- Travel allowance deemed expenditure (SARS fixed cost tables)
- All output clearly marked **DRAFT — NOT FOR SARS SUBMISSION**
- No eFiling, no auto-submission, no SARS API
