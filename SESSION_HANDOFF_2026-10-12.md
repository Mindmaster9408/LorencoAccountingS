# Session Handoff — 2026-10-12 — Paytime audit, spec, Fase 0, D.1/D.2, Fase 3a

## What was changed

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/core/payroll-engine.js` | Fase 3a: cumulative PAYE annualises over months with payroll data in the tax year (+ current), capped at the calendar month — fixes K2 (mid-year starters got R0 PAYE). Plus `/* global safeLocalStorage */` (lint only). |
| `accounting-ecosystem/backend/modules/payroll/services/PayrollDataService.js` | Default `PAYE_YTD_METHOD` → `cumulative` (owner-chosen method; production already set via Zeabur). Comments flag `projection_type` as do-not-use. |
| `accounting-ecosystem/backend/core/run-tests.js` | Removed unreachable line referencing undefined `testResults` (lint only). |
| `accounting-ecosystem/backend/tests/payroll-overtime-shorttime.test.js` | Points at the backend engine and uses the engine's rounded hourly rate → 26/26 pass (was 23/26). |
| `accounting-ecosystem/backend/tests/golden/*` | New golden regression gate: 49 scenarios through the real PayrollDataService → engine pipeline on an in-memory DB; baseline mirrors production behaviour. |
| `accounting-ecosystem/docs/paytime/spec/*` | New owner-confirmed behaviour spec (Afrikaans), sections 00–14. Source of truth for Paytime behaviour. |
| `accounting-ecosystem/docs/paytime/REGSTELPLAN_2026-10.md` | Dependency-ordered fix plan + finding codes (Bylae A). |
| `accounting-ecosystem/docs/paytime/FASE0_RESULTATE_2026-10-12.md`, `FASE3_CHANGE_IMPACT_NOTE.md`, `README.md` | Fase 0 results, Fase 3a impact note, index link. |

## Production changes made outside git (authorised by Ruan, 2026-10-12)

- **D.1** (done by Ruan in Zeabur): `PAYE_YTD_METHOD` `projection_type` → `cumulative`. Stops bonuses being taxed again in later months (P1) and voluntary PAYE being refunded (P2). Verified: Pennygrow emp 260 Sept draft R1 060,41 → R546,12.
- **D.2** (done by Claude via DB): all 17 KV tax-table copies (`tax_config`, `tax_years_v2`; global + 8 companies) set to SARS 2027 — bracket-4 base 125 599, medical credits 376/376/254. Turkstra (7) already correct, untouched. Backup of old values kept in the session scratchpad (`d2_backup_2026-10-12.json`).

## Root causes fixed

- P1/P2: production YTD method `projection_type` (switched off via D.1; code default now `cumulative`).
- P3: wrong 2027 bracket-4 base + stale medical credits in the global tax table (D.2).
- K2: cumulative method used the calendar month instead of months with data (Fase 3a).

## Confirmed working

- Golden 49/49, core engine 15/15, Jest payroll suites 127/127, payroll code 0 lint errors.
- Travel allowance: UIF on 80% only (golden S12a/S12b) — confirmed without code change.

## NOT changed (and why)

- Everything else in the REGSTELPLAN (Fase 1, 2, 3b, 4–12) — next steps, one phase at a time.
- `sean/pdf-statement-parsers/nedbank-parser.js` parse error — outside Paytime.
- Many unrelated uncommitted files in the working tree — not part of this work, left as-is.

## Testing required after deploy

- Run the next payroll for The Infinite Legacy emp 1 & 6 and Turkstra emp 274 (history starts after March): PAYE should now match a normal month on their salary.
- Bakmeester: 3 employees have a Bonus Spread to Feb 2027 — the bonus month currently deducts the bonus tax in full PLUS the spread (Fase 4 fixes this). Fase 4 must land before that bonus is paid.

## Fase 3b (second commit, same day)

| File | Purpose |
|---|---|
| `backend/modules/payroll/services/periodSequence.js` (new) | Shared month-order rules + company-scoped DB helpers. |
| `backend/modules/payroll/routes/payruns.js` | /run skips employees whose previous month is open (strict companies); /finalize: later month locked → block, open earlier months → block (strict) or confirm (others), acknowledgement audited; /reverse returns `later_periods_locked`. |
| `backend/modules/payroll/routes/calculate.js` | "Calculate payslip" refused with `PREVIOUS_MONTH_OPEN` for strict companies; locked months still returned. |
| `backend/migrations/026_payroll_strict_period_order.sql` | `companies.payroll_strict_period_order` (default TRUE; FALSE for 1, 7, 11, 38, 39, 40, 51). **Must be run in Supabase by Ruan.** Code treats a missing column as non-strict. |
| `frontend-payroll/js/payroll-api.js`, `payroll-execution.html`, `employee-detail.html` | Confirm dialog for open earlier months, reversal warning, visible calculate-block message; `showToast` fallback (it was never defined on the payslip page). |
| `backend/tests/payroll-period-sequence.test.js` | 24 tests incl. company switch and company scoping. |

## Fase 4 (third commit, same day) — docs/paytime/FASE4_CHANGE_IMPACT_NOTE.md

- Voluntary PAYE per spec 06 §E: Variable/Reduce inactive, Target never below statutory, optional dates, Bonus Spread linked to its bonus month (prepaid credited, deferred part collected later), calculator fixed (no ×12, uses global tax tables).
- Payslip preview + PDF: totals now from the backend; the medical credit was being subtracted twice so printed NET PAY was too high for every employee on a medical scheme.
- Engine output gains `voluntary_breakdown` and `voluntary_warnings` (additive).
- Golden: only S51/S52 changed (intended); new S54, S55, M09, M10, M11.

## Open risks / follow-ups

- Bakmeester: set `bonus_period` on the 3 Bonus Spread entries once Ruan confirms which month each employee's bonus is paid (May / October).
- VPA-05: target/deferral reason enforced on screen only, not yet on the backend.
- Migration 026 not yet run → until then every company is non-strict (finalize warns, calculate never blocks).
- Turn strict ON per company after its missing months are imported (Fase 12): `UPDATE companies SET payroll_strict_period_order = TRUE WHERE id = …`. A UI toggle for super users is a follow-up.
- SDL on travel allowance is on 100% (should be 80%) — IT-15, Fase 2.
- Frontend pages (Payslips/payruns.html, Reports, Net-to-Gross) still use the old frontend engine — Fase 9.
