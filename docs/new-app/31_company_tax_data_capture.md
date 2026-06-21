# Codebox 31 — Company Tax Data Capture Foundation

**App:** Lorenco Practice Management
**Date:** 2026-06-21
**Status:** Implemented

---

## Purpose

Provides structured company tax data capture per client and tax year.
Tracks AFS placeholder figures, taxable income adjustments, assessed loss movements,
provisional tax links, document readiness, and review status.

**This is NOT company tax calculation. NOT ITR14 submission. NOT SARS integration.**
All figures are placeholders for accountant input only.

---

## What Was Built

### Database (Migration 081)

| Table | Purpose |
|---|---|
| `practice_company_tax_returns` | One row per company tax return per client per year. AFS figures, assessed loss, status, readiness score. |
| `practice_company_tax_adjustments` | Tax computation adjustments — add-backs, deductions, allowances, disallowances, assessed loss, capital allowances, etc. |
| `practice_company_tax_readiness_items` | Document and data readiness checklist per return. |
| `practice_company_tax_events` | Audit event log — every status change and material action recorded. |

### Backend (`company-tax.js`)

Standalone router mounted at `/api/practice/company-tax`.

| Endpoint | Purpose |
|---|---|
| `GET /` | List returns (filterable by client, profile, year, status, readiness) |
| `GET /:id` | Get single return |
| `POST /` | Create return |
| `PUT /:id` | Update return (AFS inputs, status, ownership, links) |
| `DELETE /:id` | Soft-cancel (status → cancelled; cannot cancel submitted/completed) |
| `POST /:id/generate-default-items` | Create 10 standard readiness items (skips existing by name) |
| `POST /:id/recalculate-readiness` | Compute score and status from current items; persist to return row |
| `GET /:id/adjustments` | List adjustments |
| `POST /:id/adjustments` | Add adjustment |
| `PUT /:id/adjustments/:adjustmentId` | Update adjustment |
| `DELETE /:id/adjustments/:adjustmentId` | Delete adjustment |
| `GET /:id/items` | List readiness items |
| `POST /:id/items` | Add readiness item |
| `PUT /:id/items/:itemId` | Update item (especially status) |
| `DELETE /:id/items/:itemId` | Remove item |
| `GET /:id/events` | Audit event log |

### Readiness Logic

```
Required items only (required = true).
Done statuses: received, captured, reviewed, waived.

Score = done / required × 100

Status:
  blocked   — if any required item has status = 'blocked'
  ready     — score ≥ 85
  partial   — score ≥ 50
  incomplete — score < 50
  unknown   — no required items exist
```

Readiness is NOT recalculated automatically on every item update to avoid performance
overhead. Use the `recalculate-readiness` endpoint explicitly, or trigger it through the
Generate Defaults flow (auto-recalculates after item generation).

**Note:** `ctUpdateItemStatus()` in the frontend calls `ctRecalculateReadiness()` after
every status change, so the UI stays current.

### Default Readiness Items (10 items)

| Type | Name | Required |
|---|---|---|
| afs | Signed Annual Financial Statements | Yes |
| trial_balance | Trial Balance | Yes |
| tax_computation | Tax Computation Support | Yes |
| sars_statement | SARS Statement of Account | Yes |
| provisional_tax | Provisional Tax History (IRP6) | Yes |
| assessed_loss | Assessed Loss Schedule | Yes |
| fixed_assets | Fixed Asset Register | No |
| loan_accounts | Loan Account Confirmations | No |
| supporting_document | Supporting Documents | No |
| review | Reviewer Sign-off | Yes |

6 required + 4 optional = 10 total.
To reach `ready` (≥85%), 6/6 required items must be done = 100%.
At 5/6: 83% = `partial`. At 4/6: 67% = `partial`. Below 3/6: `incomplete`.

### AFS Fields (Placeholder Captures)

**Income Statement:**
- `accounting_profit_loss` — IFRS/GAAP profit or loss before tax
- `turnover`
- `cost_of_sales`
- `gross_profit`
- `operating_expenses`
- `finance_costs`
- `other_income`

**Tax Estimates (Placeholder Only):**
- `taxable_income_estimate` — accountant's preliminary estimate
- `assessed_loss_brought_forward`
- `assessed_loss_utilised`
- `assessed_loss_carried_forward`

None of these are used in any calculation. They are data capture points for the accountant.

### Adjustment Types

| Type | Meaning |
|---|---|
| add_back | Expense disallowed — added back to accounting profit |
| deduction | Deduction allowed that wasn't in accounting profit |
| allowance | Capital/wear and tear allowance |
| disallowance | Item disallowed for tax purposes |
| assessed_loss | Assessed loss movement |
| capital_allowance | Section 11(e) / 12B etc. capital allowances |
| section_24c | Future expenditure allowance |
| doubtful_debt | Bad and doubtful debt provisions |
| donation | Section 18A approved donations |
| other | Any other adjustment |

### Frontend

**`company-tax.html`** — Standalone page with:
- Summary cards (total, active, ready, blocked)
- Filter bar (status, readiness, tax year)
- Return cards list (click to open detail)
- Create Return modal
- Return Detail modal with 5 tabs:
  - **Overview** — status, financial year, responsible/reviewer, notes, save/cancel controls
  - **AFS Inputs** — income statement placeholders + tax estimate placeholders
  - **Adjustments** — add/edit/delete adjustments with type, amount, totals
  - **Readiness** — checklist with inline status dropdowns; Generate Defaults / Recalculate buttons
  - **Events** — audit event log (newest first)

**`js/company-tax.js`** — Full IIFE with:
- `loadReturns()`, `renderSummaryCards()`
- Create return flow with client/profile picker and auto-name
- `openDetailModal()`, `ctSwitchTab()` with lazy tab loading
- `ctSaveOverview()`, `ctCancelReturn()`, `ctRecalculateReadiness()`
- `ctSaveAfs()` — saves all AFS inputs in a single PUT
- `loadCtAdjustments()`, `openAddAdjModal()`, `openEditAdjModal()`, `submitAdj()`, `deleteAdj()`
- `loadCtReadiness()`, `ctUpdateItemStatus()`, `ctGenerateDefaultItems()`
- `loadCtEvents()`

**`client-detail.html`** — Added:
- `companyTaxSection` — Company Tax Returns panel with View All link + New Return button
- `cdCreateCtReturnModal` — lightweight create modal (profile, year, name, notes)

**`js/client-detail.js`** — Added:
- `loadClientCompanyTaxReturns()` — loads 6 most recent non-cancelled returns
- `openCdCreateCtReturnModal()`, `closeCdCreateCtReturnModal()`, `submitCdCreateCtReturn()`
- `cdCtAutoName()` — auto-fills ITR14 {year}

**`js/layout.js`** — Added:
- `{ key: 'company-tax', label: 'Company Tax', href: '/practice/company-tax.html' }`

---

## Status Lifecycle

```
draft → collecting_docs → data_captured → ready_for_review → reviewed → submitted → completed
                                                            ↓
                                                        cancelled (soft, via DELETE)
```

Cancel is blocked if status is `submitted` or `completed`.
General status update is through `PUT /:id` — the frontend Overview tab has a status dropdown.

---

## Multi-Tenant Safety

- All routes filter on `company_id = req.companyId`
- `verifyClientBelongsToCompany()` validates `client_id` before create/update
- `verifyProfileBelongsToCompany()` validates `taxpayer_profile_id` before create/update
- `verifyReturnBelongsToCompany()` validates return ownership before all sub-resource access
- No cross-company data can appear in any query

## No Browser Storage

No `localStorage`, `sessionStorage`, or KV bridge used for any company tax data.
All data flows through `/api/practice/company-tax/*` → Supabase DB.

---

## Audit Logging

| Event | Trigger |
|---|---|
| `company_tax_return_created` | POST / |
| `company_tax_return_updated` | PUT /:id |
| `company_tax_return_cancelled` | DELETE /:id |
| `company_tax_items_generated` | POST /:id/generate-default-items |
| `company_tax_readiness_recalculated` | POST /:id/recalculate-readiness |
| `company_tax_adjustment_added` | POST /:id/adjustments |
| `company_tax_adjustment_updated` | PUT /:id/adjustments/:adjustmentId |

---

## Known Limitations / Follow-up Notes

```
FOLLOW-UP NOTE
- Area: Assessed loss multi-year tracking
- What was done: Single-row fields (bf, utilised, cf) per return
- Not yet confirmed: Whether a full year-by-year assessed loss schedule view is needed
- Risk if not checked: Accountants may need to cross-reference multiple years
- Recommended next review: After first real company tax return is captured

FOLLOW-UP NOTE
- Area: Adjustment totals and taxable income reconciliation
- What was done: Frontend shows add-back totals and deduction totals separately
- Not yet implemented: Draft taxable income = accounting profit + add-backs - deductions
- Risk if not checked: Accountants may expect to see a draft reconciliation
- Recommended next review: Codebox 32 — Company Tax Draft Calculation Engine

FOLLOW-UP NOTE
- Area: company-tax.html URL-based client filter
- What was done: client_id read from URL params; filter applied to list load
- Not yet confirmed: Whether the filter dropdowns should pre-populate the client selector
- Recommended next check: Test company-tax.html?client_id=X path after migration applied

FOLLOW-UP NOTE
- Area: Readiness auto-recalculation performance
- What was done: ctUpdateItemStatus() calls recalculate-readiness on every item status change
- Risk: If a return has many items, this is 2 API calls per checkbox. Acceptable for now.
- Recommended: If performance becomes a concern, batch with a debounce or recalculate on tab close
```
