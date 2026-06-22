# Codebox 32 — Company Tax Draft Calculation Engine Foundation

**App:** Lorenco Practice Management
**Date:** 2026-06-21
**Status:** Implemented

---

## Purpose

Provides a draft/review-only company tax estimate from captured AFS inputs and adjustments.

**NOT SARS-final. NOT ITR14 submission. NOT eFiling integration. NOT tax advice.**
Every calculation screen shows: "DRAFT COMPANY TAX ESTIMATE — accountant review required."

---

## What Was Built

### Database (Migration 082)

| Table | Purpose |
|---|---|
| `practice_company_tax_calculations` | One row per calculation run per return. Stores all inputs, computed totals, warnings, lines, assumptions. |
| `practice_company_tax_calculation_events` | Audit event log — every run, submit-review, approve, reject recorded. |

### Backend (`company-tax-calculations.js`)

Standalone router mounted as fallthrough at `/api/practice/company-tax` (after `company-tax.js`).

| Endpoint | Purpose |
|---|---|
| `GET /calculations/:id/events` | Audit event log for a calculation |
| `POST /calculations/:id/submit-review` | Transition: draft/rejected → ready_for_review |
| `POST /calculations/:id/approve` | Transition: ready_for_review/reviewed → approved |
| `POST /calculations/:id/reject` | Transition: ready_for_review/reviewed → rejected (reason required) |
| `GET /calculations/:id` | Fetch single calculation (includes all JSONB fields) |
| `PUT /calculations/:id` | Update name/notes only (approved calcs blocked) |
| `GET /:returnId/calculations` | List all calculations for a return (newest first) |
| `POST /:returnId/calculations/run-draft` | Run draft calculation from DB data; store result |

### Calculation Logic

```
Input (all fetched server-side — frontend totals never trusted):

  accounting_profit_loss     ← from practice_company_tax_returns AFS capture
  assessed_loss_brought_forward ← from return
  assessed_loss_utilised     ← from return

  add_back_total    = sum(adjustments WHERE type = 'add_back')
  disallowance_total = sum(adjustments WHERE type = 'disallowance')
  deduction_total   = sum(adjustments WHERE type = 'deduction')
  allowance_total   = sum(adjustments WHERE type IN ('allowance','capital_allowance','section_24c','doubtful_debt','donation'))

Taxable income:
  taxable_pre_loss = profit + add_back + disallowance - deduction - allowance
  taxable_income_estimate = max(0, taxable_pre_loss - assessed_loss_utilised)

Company tax:
  company_tax_rate = 0.27 (PLACEHOLDER — 27% SA standard rate)
  normal_tax_estimate = round2(taxable_income × 0.27)

Provisional tax offset:
  If related_provisional_tax_plan_id exists:
    → query practice_provisional_tax_periods WHERE status IN ('submitted','paid')
    → sum amount_paid (or amount_submitted as fallback)
    → store as provisional_tax_paid
  Else → null + warning

Estimated payable / refund:
  If provisional_tax_paid not null:
    diff = normal_tax - provisional_tax_paid
    if diff >= 0: estimated_tax_payable = diff, estimated_refund = 0
    else:         estimated_tax_payable = 0,    estimated_refund = abs(diff)
```

### Warning Flags

| Flag | When raised |
|---|---|
| `DRAFT_COMPANY_TAX_REVIEW_REQUIRED` | Always |
| `COMPANY_TAX_RATE_REQUIRES_REVIEW` | Always (placeholder rate) |
| `MISSING_ACCOUNTING_PROFIT` | `accounting_profit_loss` is null/missing |
| `NO_TAX_ADJUSTMENTS_CAPTURED` | Zero adjustments on the return |
| `ASSESSED_LOSS_REQUIRES_REVIEW` | `assessed_loss_bf > 0` or `assessed_loss_utilised > 0` |
| `ASSESSED_LOSS_UTILISED_EXCEEDS_AVAILABLE` | `utilised > brought_forward` (when bf > 0) |
| `TAXABLE_INCOME_FLOORED_AT_ZERO` | Pre-loss taxable income was negative |
| `PROVISIONAL_TAX_OFFSET_NOT_LINKED` | No plan linked or no submitted/paid periods found |

### Calculation Lines (stored as JSONB)

13 lines in order:
1. Accounting Profit / (Loss)
2. Add: Add-back Adjustments
3. Add: Disallowances
4. Less: Deductions
5. Less: Allowances / Capital Allowances
6. Income Before Assessed Loss
7. Less: Assessed Loss Utilised
8. Taxable Income Estimate
9. Company Tax Rate (rate display, no amount)
10. Normal Tax Estimate
11. Less: Provisional Tax Paid
12. Estimated Tax Payable to SARS
13. Estimated Refund from SARS

### Status Lifecycle

```
draft → ready_for_review → reviewed → approved
      ↑                              ↓
      ←←←←←← rejected ←←←←←←←←←←←←
```

- `submit-review`: draft/rejected → ready_for_review
- `approve`: ready_for_review/reviewed → approved
- `reject`: ready_for_review/reviewed → rejected (reason required)
- Approved calculations cannot be edited via PUT

### Versioning

Each `run-draft` call increments `calculation_version` per return. Latest version = highest version number. No auto-archival of previous versions — all stored.

### Frontend (`company-tax.html` + `js/company-tax.js`)

**Added tab:** Calculations (6th tab in the detail modal).

**Features:**
- Permanent "DRAFT COMPANY TAX ESTIMATE" warning banner — cannot be dismissed
- "Run Draft Calculation" button — calls `POST /:returnId/calculations/run-draft`
- Calculation list (newest first) — click to open inline detail
- Calculation detail: lines table, warning flags, assumptions, action buttons
- Submit for Review / Approve / Reject buttons per status
- Reject reason modal (inline, requires non-empty reason)
- `ctCalcRejectModal` — separate overlay modal

**State vars added:**
- `_CALC_BASE` = `/api/practice/company-tax`
- `_calcSubmitting` — double-submit guard for run-draft
- `_calcRejectId` — tracks which calcId is being rejected
- `_calcDetailId` — tracks which calcId detail is open

**Functions added:**
- `loadCtCalcs()` — fetch and render calculation list
- `ctRunDraft()` — POST run-draft, auto-open result
- `ctOpenCalcDetail(calcId)` — fetch + render calc detail inline
- `ctCloseCalcDetail()` — hide inline detail, clear card highlight
- `ctSubmitForReview(calcId)` — POST submit-review
- `ctApproveCalc(calcId)` — POST approve
- `ctOpenRejectModal(calcId)` — show reject modal
- `ctCloseRejectModal()` — hide reject modal
- `ctConfirmReject()` — POST reject with reason

---

## Multi-Tenant Safety

- All routes filter on `company_id = req.companyId`
- `verifyReturnBelongsToCompany()` validates return before run-draft and list
- `verifyCalcBelongsToCompany()` validates calculation before all `:id` operations
- Profile and client ownership validated on run-draft
- Provisional tax plan validated: `company_id = cid` before reading periods

## No Browser Storage

Zero `localStorage`, `sessionStorage`, or KV writes for any calculation data.
All results persisted to `practice_company_tax_calculations` via `/api/practice/company-tax/*`.

## No Silent Finalization

- `run-draft` does NOT change company tax return status
- `approve` does NOT mark the return as submitted or completed
- No ITR14, no SARS file, no eFiling call anywhere in this codebox

## Audit Logging

| Event | Trigger |
|---|---|
| `company_tax_calculation_run` | POST run-draft |
| `company_tax_calculation_submitted_review` | POST submit-review |
| `company_tax_calculation_approved` | POST approve |
| `company_tax_calculation_rejected` | POST reject |

---

## Known Limitations / Follow-up Notes

```
FOLLOW-UP NOTE
- Area: Company tax rate configuration
- What was done: Flat 27% placeholder; warning always raised
- Not yet implemented: Company-specific or tax-year-specific configurable rate
- Risk if not checked: Accountant may use wrong rate without noticing
- Recommended next review: CB33 or add rate config to Tax Year Configuration (CB29)

FOLLOW-UP NOTE
- Area: SBC and other entity type rates
- What was done: Only standard 27% applied
- Not yet implemented: Small Business Corporation progressive rates, micro-business rules
- Risk: SBCs paying different rates will get incorrect estimates
- Recommended: Add entity_type flag to taxpayer profile and rate lookup table

FOLLOW-UP NOTE
- Area: Assessed loss carry-forward schedule
- What was done: Single-year utilised field; multi-year schedule not enforced
- Not yet implemented: Year-by-year loss tracking, ring-fenced loss rules
- Risk: Carry-forward limits not validated
- Recommended next review: After first real company tax return

FOLLOW-UP NOTE
- Area: CGT, dividends tax, STC credits
- What was done: Not applied
- Risk: Returns with significant CGT will have incorrect estimates
- Recommended: Flag on taxpayer profile if CGT applies; add warning
```
