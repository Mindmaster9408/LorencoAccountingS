# SESSION HANDOFF — Codebox 28 — Individual Income Tax Calculation Draft Engine

**Date:** 2026-06-21  
**Session:** CB28  
**Status:** COMPLETE — all files written, no commit performed

---

## What Was Built

CB28 adds a draft income tax calculation engine on top of the CB27 data capture foundation. Every output is explicitly a DRAFT ESTIMATE — not SARS-final, not eFiling, not tax advice. The accountant reviews, approves, or rejects each calculation.

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/078_practice_individual_tax_calculations.sql` | 2 tables, 10 indexes — ALREADY RUN IN SUPABASE |
| `accounting-ecosystem/backend/modules/practice/individual-tax-constants.js` | Versioned SA SARS tax tables 2023–2026, bracket helper |
| `accounting-ecosystem/backend/modules/practice/individual-tax-calculations.js` | 8-endpoint backend router, full draft calculation logic |
| `docs/new-app/28_individual_tax_calculation_draft_engine.md` | Feature documentation |
| `docs/new-app/SESSION_HANDOFF_codebox_28_individual_tax_calc.md` | This file |

---

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Dual-mount: `individual-tax-calculations.js` mounted at `/individual-tax` alongside CB27 router |
| `accounting-ecosystem/backend/frontend-practice/individual-tax.html` | Added CB28 CSS (draft warning, calc cards, status badges, warning chips, lines table); added 6th tab button (Calculations); added Calculations tab panel with DRAFT banner + "Run Draft Calculation" button + calc list; added Calculation Detail Modal (lines table, warning chips, assumptions, approve/reject/submit workflow); added reject reason modal |
| `accounting-ecosystem/backend/frontend-practice/js/individual-tax.js` | Updated `itSwitchTab()` panelMap + `loadCalculations()` trigger; added full calculations block: `loadCalculations()`, `itRunDraftCalc()`, `openCalcDetailModal()`, `closeCalcDetailModal()`, `_renderCalcDetail()`, `itSaveCalcNotes()`, `itSubmitCalcForReview()`, `itApproveCalc()`, `openCalcRejectModal()`, `closeCalcRejectModal()`, `itRejectCalc()`; all functions exported to `window.*` |

---

## What Was NOT Changed

- `individual-tax.js` (CB27 backend router) — untouched
- CB27 migration (077) — untouched
- `client-detail.html` and `client-detail.js` — untouched
- No payroll files, no shared auth files, no other modules

---

## Migration Status

**Migration 078 was confirmed run and successful.** Do NOT run it again.

---

## Testing Required

Before using in production, test the following:

### Backend
1. `POST /:returnId/calculations/run-draft` — creates a calculation with correct totals from income/deduction entries
2. GET list returns all calculations for a return
3. GET detail returns full calculation with lines, flags, assumptions
4. PUT updates provisional_tax_paid and notes
5. Status transitions: draft → ready_for_review → approved; ready_for_review → rejected
6. Multi-tenant isolation: calculation for Company A cannot be seen by Company B request

### Frontend
1. Calculations tab appears and loads on tab click
2. "Run Draft Calculation" button creates a calc and auto-opens detail modal
3. Calculation card shows correct status badge and amounts
4. Detail modal shows all lines, warning chips, and assumptions
5. Approve/reject/submit actions update status and refresh the list
6. Reject reason modal submits reason to backend
7. DRAFT ESTIMATE warning visible on all screens
8. Save Notes & Prov Tax persists correctly

---

## Known Limitations (Tracked for CB29)

| Gap | Location | CB to fix |
|---|---|---|
| RA deduction cap (15%, max R350,000) not enforced | `individual-tax-calculations.js` | CB29 |
| s18A donations cap (10% of taxable income) not enforced | `individual-tax-calculations.js` | CB29 |
| Secondary rebate (age 65+) not applied | `individual-tax-constants.js` | CB29 |
| Tertiary rebate (age 75+) not applied | `individual-tax-constants.js` | CB29 |
| Medical tax credits not applied (member count not captured) | `individual-tax-calculations.js` | CB29 |
| Tax constants hardcoded in JS file (not DB-managed) | `individual-tax-constants.js` | CB29 |
| Travel fixed-cost table not applied (logbook not integrated) | Future CB | Later |

All limitations are surfaced as warning flags and assumption strings on every calculation record.

---

## Tracked Cleanup

- Delete accidental doc at `accounting-ecosystem/backend/frontend-practice/docs/new-app/27_individual_tax_data_capture.md` (wrong path, correct file is at `docs/new-app/27_individual_tax_data_capture.md`)
- Delete accidental doc at `accounting-ecosystem/backend/frontend-practice/docs/new-app/28_individual_tax_calculation_draft_engine.md` (wrong path, correct file is at `docs/new-app/28_individual_tax_calculation_draft_engine.md`)

---

## Next Session

**Codebox 29 — Tax Constant Tables + SARS Tax Year Configuration Foundation**

Move tax constants from JS into versioned DB tables (`practice_tax_year_constants`, `practice_tax_brackets`). Add RA/s18A cap enforcement. Add secondary/tertiary rebates based on taxpayer profile age. Add medical tax credits based on member count. Add "recalculate all drafts for this return" endpoint.
