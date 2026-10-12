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

## Fase 3b (later, aparte stap)

Maand-volgorde-blok by finalisering (UF-04) en waarskuwing by omkeer van 'n vroeër maand (UF-09) — raak `routes/payruns.js` (HIGH). Eie Change Impact Note.
