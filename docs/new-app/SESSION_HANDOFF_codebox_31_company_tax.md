# Session Handoff — Codebox 31: Company Tax Data Capture Foundation

**Date:** 2026-06-21
**Codebox:** 31 of ±80
**App:** Lorenco Practice Management

---

## What Was Changed

### Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/081_practice_company_tax_data.sql` | 4 new tables: `practice_company_tax_returns`, `practice_company_tax_adjustments`, `practice_company_tax_readiness_items`, `practice_company_tax_events` |
| `accounting-ecosystem/backend/modules/practice/company-tax.js` | New standalone router — 15 endpoints, readiness engine, audit event logging |
| `accounting-ecosystem/backend/frontend-practice/company-tax.html` | Full company tax page with return list, create modal, 5-tab detail modal |
| `accounting-ecosystem/backend/frontend-practice/js/company-tax.js` | Full company tax JS — IIFE, all functions, PracticeAPI.fetch only |
| `docs/new-app/31_company_tax_data_capture.md` | Technical documentation |

### Files Modified

| File | What Changed |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | `require('./company-tax')` + `router.use('/company-tax', companyTaxRouter)` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added `{ key: 'company-tax', label: 'Company Tax', href: '/practice/company-tax.html' }` |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Added `companyTaxSection` div; added `cdCreateCtReturnModal` |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Added `companyTaxSection.classList.remove('hidden')`, `ctViewAllLink` href, `loadClientCompanyTaxReturns()` call, and full company tax section at bottom of IIFE |

---

## Root Causes Fixed

None — this is greenfield feature work, not a bug fix.

---

## What Was Confirmed Working (by code audit)

- Router mounted at `/api/practice/company-tax` — no path collision with existing routes
- All DB queries scope to `company_id = req.companyId` — multi-tenant safe
- `verifyClientBelongsToCompany()` + `verifyProfileBelongsToCompany()` called before create
- `verifyReturnBelongsToCompany()` called before all `:id` sub-resource access
- Soft-cancel only — `completed` and `submitted` returns cannot be cancelled
- Readiness recalculation: blocked takes priority over score; unknown if no required items
- Default items: 10 items, skips by `item_name` if already exists (idempotent)
- `ctUpdateItemStatus()` auto-triggers `ctRecalculateReadiness()` to keep UI current
- AFS save uses single `PUT /:id` — no separate AFS endpoint (avoids duplication)
- Adjustment CRUD: full add/edit/delete, totals rendered in frontend
- Events tab: newest-first rendering (client-side `.slice().reverse()`)
- No `localStorage`/`sessionStorage`/KV for any company tax data — DB only
- `company-tax.html` nav key = `'company-tax'` → active state in layout works
- `client-detail.js` company tax section follows identical pattern to IT returns section

## What Was NOT Changed

- All CB27–CB30 individual-tax routes — untouched
- All existing client-detail sections — untouched (append-only additions)
- All existing layout.js nav entries — existing entries preserved
- No Paytime module changes

---

## Testing Required Before Using in Production

1. Run migration `081_practice_company_tax_data.sql` in Supabase SQL Editor — REQUIRED FIRST
2. Create a company taxpayer profile for a client (in Taxpayer Profiles)
3. Open Company Tax page → click + New Return → select client and profile
4. Open the return → click "Generate Defaults" on Readiness tab → 10 items should appear
5. Change item status to "Received" → readiness score should update
6. Switch to AFS Inputs tab → enter accounting profit → click Save AFS Inputs
7. Switch to Adjustments tab → add an add-back → add a deduction → verify totals
8. Switch to Overview tab → change status → Save Changes
9. Click Recalculate Readiness → verify score matches manual calculation
10. Open client detail → verify Company Tax Returns section shows the new return
11. Click + New Return from client detail → verify modal pre-loads profiles for that client
12. Verify cross-company isolation: switch company, confirm no returns from other company
13. Verify no localStorage/KV writes in browser DevTools → Application tab

---

## Open Risks

| Risk | Severity | Notes |
|---|---|---|
| Migration not yet applied | BLOCKER | Must run 081 in Supabase before any endpoint works |
| company-tax.html client filter | Low | URL param `?client_id=X` applied to list load but no UI client dropdown on the list page — acceptable for now; accountants use client-detail to filter |
| Readiness recalculate on every item update | Low | 2 API calls per item status change in readiness tab; acceptable at current scale |
| Assessed loss multi-year view | Low | No cross-year schedule view; fields are per-return only |

---

## Recommended Codebox 32

**Company Tax Draft Calculation Engine Foundation**

Reason: Company tax data capture now exists. The next natural layer is a draft/review-only
company tax estimate engine:
- Taxable income = accounting profit + adjustments (add-backs - deductions)
- Less: assessed loss utilised
- Draft taxable income estimate
- Apply company tax rate (from Tax Config or flat 27%)
- Warning flags (no AFS, unreconciled adjustments, unconfirmed assessed loss)
- Draft reconciliation display (not for SARS, not for submission)
- Parallel to individual-tax CB28 (calculations) structure

This is NOT ITR14 preparation. It is an internal draft estimate for accountant review only.
