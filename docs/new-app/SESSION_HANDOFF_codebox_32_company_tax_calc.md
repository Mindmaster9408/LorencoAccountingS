# Session Handoff — Codebox 32: Company Tax Draft Calculation Engine Foundation

**Date:** 2026-06-21
**Codebox:** 32 of ±80
**App:** Lorenco Practice Management

---

## What Was Changed

### Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/082_practice_company_tax_calculations.sql` | 2 new tables: `practice_company_tax_calculations`, `practice_company_tax_calculation_events` |
| `accounting-ecosystem/backend/modules/practice/company-tax-calculations.js` | Standalone calculation router — 8 endpoints, draft calc engine, audit logging |
| `docs/new-app/32_company_tax_draft_calculation.md` | Technical reference |
| `docs/new-app/SESSION_HANDOFF_codebox_32_company_tax_calc.md` | This file |

### Files Modified

| File | What Changed |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added fallthrough mount: `router.use('/company-tax', companyTaxCalcRouter)` after existing companyTaxRouter |
| `accounting-ecosystem/backend/frontend-practice/company-tax.html` | Added Calculations tab button; added `#ctTabCalc` panel with draft warning, run button, list, inline detail; added `#ctCalcRejectModal`; added calc CSS (20+ classes) |
| `accounting-ecosystem/backend/frontend-practice/js/company-tax.js` | Added `calculations` to `_ctPanelMap`; added lazy-load trigger in `ctSwitchTab`; added full calculations section with 9 functions + exports |

---

## Root Causes Fixed

None — this is greenfield feature work.

---

## What Was Confirmed (by audit)

- `company-tax-calculations.js` mounted as fallthrough after `company-tax.js` — same pattern as `individual-tax-calculations.js` after `individual-tax.js`
- Route ordering correct: 3-segment paths (`/calculations/:id/events`, `/calculations/:id/submit-review`, `/calculations/:id/approve`, `/calculations/:id/reject`) registered BEFORE 2-segment paths (`/calculations/:id`, `/:returnId/calculations`)
- `runCompanyTaxDraftCalc()` fetches all inputs from DB — frontend totals never trusted
- `max(0, ...)` enforced on taxable income — never goes below zero for tax estimate
- Provisional tax: safe try/catch around plan lookup; null + warning if anything fails
- `verifyReturnBelongsToCompany()`, `verifyCalcBelongsToCompany()`, profile and client ownership all validated
- No `localStorage`/`sessionStorage`/KV for any calculation data
- No ITR14, no SARS file, no eFiling call — hard rule observed
- `approve` does NOT change the company tax return's status — no silent finalization
- `_currentReturn` already existed at line 318 of company-tax.js — no duplicate declaration
- `_CALC_BASE = '/api/practice/company-tax'` (same as `_BASE`) but kept separate for clarity
- Draft warning banner hardcoded in HTML — cannot be dismissed by user
- Reject modal requires non-empty reason — validated both client and server side

## What Was NOT Changed

- CB27–CB31 individual-tax and company-tax data capture routes — untouched
- `company-tax.js` (CB31 router) — untouched; fallthrough only
- Paytime module — untouched
- No Zeabur config changes

---

## Testing Required Before Using in Production

1. Run migration `082_practice_company_tax_calculations.sql` in Supabase SQL Editor — **REQUIRED FIRST**
2. Open a company tax return that has AFS inputs and at least one adjustment
3. Click the Calculations tab → verify "DRAFT COMPANY TAX ESTIMATE" warning shows
4. Click "Run Draft Calculation" → verify new calc card appears
5. Click the calc card → verify lines table renders with correct amounts
6. Verify warning flags appear (at minimum: DRAFT_COMPANY_TAX_REVIEW_REQUIRED, COMPANY_TAX_RATE_REQUIRES_REVIEW)
7. Verify taxable income = profit + add_backs + disallowances - deductions - allowances - assessed_loss_utilised
8. Verify normal tax = taxable_income × 0.27
9. Click "Submit for Review" → status changes to ready_for_review
10. Click "Approve" → status changes to approved; verify action buttons disappear
11. Run another draft on same return → version increments to 2
12. Create return with no AFS inputs → verify MISSING_ACCOUNTING_PROFIT warning
13. Verify no localStorage/KV writes in browser DevTools → Application tab
14. Switch company → verify no calculations from other company visible
15. Verify company tax return status is NOT changed by running or approving a calculation

---

## Open Risks

| Risk | Severity | Notes |
|---|---|---|
| Migration not yet applied | BLOCKER | Must run 082 in Supabase before any calculation endpoint works |
| 27% placeholder rate | HIGH | Always raises warning; accountant must verify SARS rate for tax year |
| No SBC rates | MEDIUM | SBCs qualifying for lower rates will get incorrect estimates |
| Multi-year assessed loss schedule | LOW | Only current-year utilised field; carry-forward rules not enforced |
| CGT not applied | LOW | Returns with capital gains will have incomplete estimates |
| Calculation re-run creates new row | LOW | Previous versions remain; no auto-archival. Consider pagination if many versions accumulate. |

---

## Recommended Codebox 33

**Company Tax Review Pack + Draft Company Tax Report PDF**

Reason: After draft company tax calculation exists, the natural next step is a review pack PDF:
- Return summary (client, tax year, financial year)
- AFS inputs captured
- Adjustments schedule
- Draft calculation lines (with rate caveat)
- Warning flags
- Assumptions
- Reviewer sign-off section
- Footer: "DRAFT COMPANY TAX ESTIMATE — Not SARS-final"

Parallel to individual tax CB30 (Individual Tax Review Pack + PDF).
