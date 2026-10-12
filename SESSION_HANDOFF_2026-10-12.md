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

## Open risks / follow-ups

- Fase 3b (month-order block on finalise) not yet built — finalising a month before the previous one is still possible.
- SDL on travel allowance is on 100% (should be 80%) — IT-15, Fase 2.
- Frontend pages (Payslips/payruns.html, Reports, Net-to-Gross) still use the old frontend engine — Fase 9.
