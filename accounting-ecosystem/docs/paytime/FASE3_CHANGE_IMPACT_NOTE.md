# Fase 3a — Change Impact Note (Paytime)

> 2026-10-12 · Gemagtig deur Ruan ("ek gee jou toestemming om alles reg te maak", 2026-10-12)
> Spesifikasie: [spec/06_BEREKENINGSENJIN.md](spec/06_BEREKENINGSENJIN.md) §B (ENJ-01/02/03), [spec/12](spec/12_HISTORIESE_INVOER.md) HI-02/03

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  PAYE run-to-date (cumulative) method — the number of months used to
  annualise and pro-rate the liability. Default YTD method in code.

Files involved:
  backend/core/payroll-engine.js                         (CRITICAL)
    calculateFromData() → cumulative_ytd branch only
  backend/modules/payroll/services/PayrollDataService.js (CRITICAL)
    fetchYtdData() → default PAYE_YTD_METHOD 'average_taxable' → 'cumulative'

Why this change is needed:
  K2 — an employee with fewer months of payroll history in the tax year than
  the calendar month number (mid-year starter, or a company that joined
  Paytime mid-year) is annualised over the wrong number of months, so PAYE
  collapses to R0 for months 2–3 (golden M02). Since D.1 (production on
  `cumulative`) this affects 3 real employees.
  Fix: annualise over the months the employee actually has payroll data for
  in this tax year (locked snapshots, including imported months) + the
  current month, capped at the calendar month number. With complete
  history this is identical to today's calculation.
  Default change: production already runs `cumulative` (Zeabur, step D.1);
  making it the code default means removing the env var can never silently
  switch production back to a broken method.

Is this an explicitly authorised Paytime task?
  [x] Yes  [ ] No

Payroll risk:
  [x] CRITICAL  [ ] HIGH  [ ] MEDIUM  [ ] LOW

Specific payroll areas that could be affected:
  PAYE for any employee whose locked months in the tax year < month number.
  Medical credit to date (multiplied by the same month count).

Regression risk:
  [ ] High  [x] Medium  [ ] Low
  Mitigation: golden set. Expected changes ONLY in M02 (mid-year starter) and
  M06 (scenario whose history starts in September). Every other scenario,
  including all single-period ones and M01/M03/M04/M05/M07/M08, must be
  byte-identical.

Regression tests required:
  [x] TEST-PAY-01, 03, 08, 09, 10, 14 (PAYE, voluntary, snapshot, recon totals)
      → covered by golden set + core run-tests + Jest payroll suites

Rollback strategy:
  Revert the commit. Zeabur env PAYE_YTD_METHOD=cumulative keeps the
  pre-change cumulative behaviour (month-number based) after revert.
  Locked snapshots are never recalculated, so no data repair is needed.

Confirmed safe:
  [ ] payroll-engine.js not affected        → AFFECTED (cumulative branch only)
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected
  [x] Company context not affected
  [x] PAYE/UIF/SDL logic: UIF/SDL untouched; PAYE only in the cumulative branch
─────────────────────────────────────────────────────────────
```

## Fase 3b — FINAL behaviour (supersedes the "Behaviour" block below)

After the real-data check (blocking would have stopped Turkstra's 35 employees, Bakmeester,
Lorenco, le Grange, …), Ruan chose (2026-10-12):

- `services/periodSequence.js` (new, shared): month-order rules + DB helpers.
- **Calculate** (`POST /api/payroll/calculate`, `POST /api/payroll/run`): refused per employee when
  the previous month (same tax year) is not locked — **only** for companies with
  `companies.payroll_strict_period_order = TRUE` (migration 026). First Paytime month this tax year
  and months before hire are exempt. Locked months are still viewable.
- **Finalize**: later month already locked → always refused. Open earlier months → refused for strict
  companies; otherwise 422 `OPEN_EARLIER_MONTHS` + confirm dialog, then `acknowledge_open_months`
  (recorded in the audit log).
- **Reverse**: response lists `later_periods_locked`; screen shows a warning.
- Migration 026: column default TRUE; set FALSE for companies 1, 7, 11, 38, 39, 40, 51. Missing
  column = non-strict, so the code is safe before the migration runs.
- Also fixed: `employee-detail.html` called `showToast()` without defining it (Voluntary PAYE
  validation messages threw instead of showing) — alert-based fallback added.
- Tests: `tests/payroll-period-sequence.test.js` (24). Gate: 155/155 Jest, core 15/15, 0 lint errors.

## Fase 3b — Change Impact Note (original)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  POST /api/payroll/finalize — new month-order guard (UF-04).
  POST /api/payroll/reverse  — new warning when later months are locked (UF-09).
  Execute Payroll screen — shows that warning after a reversal.

Files involved:
  backend/modules/payroll/routes/payruns.js   (CRITICAL — backend/modules/payroll/**)
  frontend-payroll/payroll-execution.html     (HIGH)

Why this change is needed:
  YTD PAYE only counts LOCKED prior months. Finalising April while March is
  open (or with a gap) locks April on incomplete YTD, permanently. Ruan's
  decision (spec 07, UF-04): block.

Behaviour:
  Finalize is refused (422, code PERIOD_SEQUENCE, nothing locked) when, for
  any employee in the run:
    (a) a LATER month in the same tax year is already locked, or
    (b) the employee already has a locked month earlier in this tax year and
        a month between that first locked month and this one — in which the
        employee was employed (hire date on/before month end) — is not locked.
  Not blocked: the employee's first locked month in Paytime this tax year
  (otherwise a company that joins mid-year could never finalise its first
  month). March is never blocked by (b).
  Reverse: unchanged behaviour; response gains `later_periods_locked` listing
  employees with locked later months, and the screen shows a warning.

Is this an explicitly authorised Paytime task?   [x] Yes
Payroll risk:        [ ] CRITICAL  [x] HIGH  (blocks an action; never changes a figure)
Regression risk:     [ ] High  [x] Medium  [ ] Low
  Risk: a legitimate finalise is refused (e.g. a gap month in which the
  employee was genuinely not paid). The message names the employee and the
  open month(s); the fix is to run/finalise that month (a R0 month is fine).

Regression tests: TEST-PAY-09 (locked immutable), TEST-PAY-11/12 (company
  scoping on the new queries); new unit tests for the pure rule function;
  golden set must be unchanged (no figure changes).

Rollback strategy: revert the commit — guard disappears, no data touched.

Confirmed safe:
  [x] payroll-engine.js not affected
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected
  [x] Company context not affected — every new query filters company_id
  [x] PAYE/UIF/SDL logic not affected
─────────────────────────────────────────────────────────────
```
