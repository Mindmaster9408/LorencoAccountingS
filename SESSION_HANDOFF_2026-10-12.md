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

## Fase 2 (fourth commit) — docs/paytime/FASE2_CHANGE_IMPACT_NOTE.md

- Multi-rate paid (was R0); once-off inputs inherit is_taxable / pre_tax; UIF exemption works; directors pay UIF; contractors no UIF/SDL; SDL on taxable remuneration only.
- "Set / Change bonus month" button on existing Bonus Spread entries (Ruan sets Bakmeester's himself).
- Migration 026 confirmed run by Ruan (46 strict ON, 7 OFF).

## Fase 7 (2026-10-13)

- `backend/modules/payroll/routes/recon.js`: period UIF = employee + employer (EMP201), split fields added; EMP501 employer UIF from snapshots (was 0); historical rows never double-count snapshotted months; historical SDL.
- `frontend-payroll/paye-reconciliation.html`: SARS/bank/finalized state from the DB only (all KV copies were empty), failed saves alert, UIF labels say employee + employer.
- `backend/tests/payroll-recon-uif.test.js`: 6 tests (real route over HTTP on an in-memory DB).
- Gate: Jest 167/167, core 15/15, 0 lint errors.

## Fase 1 (2026-10-13) — docs/paytime/FASE1_CHANGE_IMPACT_NOTE.md

- NEW `backend/migrations/027_payroll_tax_tables.sql`: one row per SARS tax year (2021/22–2026/27 seeded, all confirmed). **Ruan must run it in the Supabase SQL Editor.** Until then the backend keeps using KV `tax_config` (safe to deploy code first).
- NEW `services/taxTables.js` + `routes/tax-tables.js` (GET all users, PUT super user in the authority company, audited).
- calculate.js / payruns.js / voluntary-tax.js: each period loads its own year; missing/unconfirmed year → 422 `TAX_TABLES_MISSING`.
- Engine: code defaults = 2027; 2022/23 + 2023/24 rebates/medical fixed (W2); override only for its own year (W3); min = previous max (B10).
- `payroll-items.html` Tax Configuration: API-based, no "Set as Active Year", Save draft / Confirm / Unconfirm, no browser/KV writes.
- Tests: `tests/payroll-tax-tables.test.js` (25); golden harness loads per-period tables from the migration; core regression baselines moved to correct 2027 values (were on 2024/25 tables for April 2026).
- Gate: payroll Jest 183/183, core 15/15, 0 lint errors in changed files. Pre-existing, unrelated: 5 Sean suites + payroll-employee-sync (needs live pg) fail; lint parse error in sean/pdf-statement-parsers/nedbank-parser.js.

## Migrations + Supabase access (2026-10-13)

- Claude can now run SQL: `SUPABASE_DB_URL` in backend/.env (local only) + `backend/scripts/run-sql.js` (check / query read-only / file in one transaction).
- Ran (Ruan's go-ahead, verified): 167 jurisdiction (fixed POS serial-tracking flag + Stockton settings), 169/170 Stockton, 168 audit_log append-only, 166 Collector, 165 Commander, 026 QA, 019 coaching. 027 tax tables confirmed present.
- Ruan reset the Supabase DB password → Leo broke → fixed by updating `COACHING_DATABASE_URL` on Zeabur (Leo + Coaching use it). Any future reset must update it.

## Fase 6 (2026-10-13) — docs/paytime/FASE6_CHANGE_IMPACT_NOTE.md

- Payslip lines frozen in the snapshot (`payslip_lines`, `payslip_check`); preview + PDF print them; old snapshots rebuilt from frozen inputs; PDF blocked when lines don't add up.
- Input routes: finalized month → 423; atomic replace via `paytime_replace_period_rows` (migration 028, falls back before it runs).
- Replaced draft runs → "superseded" (needs 028); finalize of superseded/empty run → 409 RUN_SUPERSEDED.
- Tax table + sha256 frozen in `calculation_output._meta`.
- Gate: golden 0 diffs, payroll Jest 198/198, core 15/15. Migration 028 run + verified (function refuses locked month / bad table / other company; API sees it); 41 stale draft runs marked superseded (10 real drafts remain).

## Fase 5 (2026-10-13) — docs/paytime/FASE5_CHANGE_IMPACT_NOTE.md

- Pro-rata factor unrounded (B8); basic + fixed allowances pro-rated (ENJ-21); once-off/overtime/deductions not.
- services/payrollEligibility.js: hired after period → blocked with message (WN-10); terminated before → excluded (UF-02). Used by Execute Payroll, single payslip and golden harness.
- Golden: only S60/S62 changed as expected. No live employee affected in Oct 2026. Spec statuses for Fase 2–4 items brought up to date.
- Ruan decided: overtime/short time in a pro-rata month at the NORMAL (full-salary) hourly rate — done, golden S63.

## Fase 8 (2026-10-13) — docs/paytime/FASE8_CHANGE_IMPACT_NOTE.md

- Attendance moved from browser/KV to the `attendance` table; backend API was broken (wrong column names) and is rewritten.
- "Apply to Payroll" = server-side BCEA proposal → payroll user approves per employee → overtime/short-time rows with source=attendance (migration 029). Manual rows untouched; finalized month refused.
- Payslip shows "from attendance" badge; overtime/short-time descriptions reach the payslip lines.
- CLAUDE.md Part D: attendance_* KV follow-up marked done.
- Migration 029 run + verified 2026-10-13 (re-apply replaces only attendance rows; manual kept).

## Fase 9 (in progress, 2026-10-13)

- 9.1 Old Payslips page (payruns.html) retired: out of menu, redirects to Execute Payroll (?legacy=1 still opens it). Execute Payroll: payslip preview + bulk print from frozen lines (bulk print printed "Lorenco Accounting Services" for every company — fixed), new Bank File (generic CSV + FNB/ABSA/Standard/Nedbank) from finalized net pay, refuses when EFT bank details are missing. Not carried over yet: Xero/Sage export (→ Leo journal VU-04), Sean preflight button, payroll upload (Fase 12), Capitec format.
- 9.3 Net-to-Gross on the backend (`POST /api/payroll/calculate/net-to-gross`), allowances recurring by default (B12), period tax tables.

## Open risks / follow-ups

- Bakmeester: set `bonus_period` on the 3 Bonus Spread entries once Ruan confirms which month each employee's bonus is paid (May / October).
- VPA-05: target/deferral reason enforced on screen only, not yet on the backend.
- Migration 026: run and verified by Ruan (46 strict ON, 7 OFF).
- Migration 027 (tax tables): to be run by Ruan; then verify read-only that 6 confirmed rows exist.
- BT-08 February warning for next year's tables; BT-09 table hash in snapshot (Fase 6).
- Turn strict ON per company after its missing months are imported (Fase 12): `UPDATE companies SET payroll_strict_period_order = TRUE WHERE id = …`. A UI toggle for super users is a follow-up.
- SDL on travel allowance is on 100% (should be 80%) — IT-15, Fase 2.
- Frontend pages (Payslips/payruns.html, Reports, Net-to-Gross) still use the old frontend engine — Fase 9.
