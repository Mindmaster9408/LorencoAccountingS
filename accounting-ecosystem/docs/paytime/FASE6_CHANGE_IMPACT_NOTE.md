# Fase 6 — Change Impact Note (Snapshot and payslip immutable)

> 2026-10-13 · Authorised by Ruan ("begin fase 6 asb") · Spec: [spec/07](spec/07_UITVOER_EN_FINALISERING.md) UF-06, [spec/08](spec/08_PAYSLIPS.md) PS-02/03, [spec/02](spec/02_BELASTINGTABELLE.md) BT-09 · Findings B3, B7, V5

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  What a finalized payslip prints, whether a finalized month's inputs can change,
  how period inputs are saved, and what happens to replaced draft runs.

Files involved:
  backend/core/payroll-engine.js                          (CRITICAL) additive output: payslip_lines, payslip_check
                                                                     + pure buildPayslipLines / checkPayslipLines
  backend/modules/payroll/services/PayrollCalculationService.js (CRITICAL) _meta.taxTable + taxTableHash
  backend/modules/payroll/services/PayrollHistoryService.js     (CRITICAL) payslipLinesFor, markSupersededRuns
  backend/modules/payroll/services/periodInputs.js        NEW  lock check + atomic replace
  backend/modules/payroll/routes/transactions.js          (CRITICAL) 4 input routes use periodInputs
  backend/modules/payroll/routes/payruns.js               (CRITICAL) superseded marking + finalize guards
  backend/migrations/028_paytime_fase6_inputs_and_runs.sql NEW function + run status 'superseded'
  frontend-payroll/employee-detail.html                   (HIGH) payslip preview/PDF from the lines; PS-03 PDF block
  frontend-payroll/payroll-execution.html                 (HIGH) RUN_SUPERSEDED message, badge

What changes:
  1. B3 / PS-02: the payslip preview and PDF built their allowances, deductions and
     overtime from the employee's CURRENT items, even for a finalized month (only the
     basic salary came from the snapshot). The engine now returns every payslip line
     (basic, regular, current, overtime, multi-rate, short time, PAYE, voluntary PAYE,
     UIF, employer UIF, SDL) with the exact amounts it used; they are stored in
     calculation_output and printed from there. Snapshots from before Fase 6 have their
     lines rebuilt from their own FROZEN calculation_input (flagged
     'rebuilt_from_frozen_inputs'); totals always come from the snapshot.
  2. PS-03: payslip_check = do the lines add up to gross / deductions / net. If not,
     the PDF is not generated (message instead). 112/112 golden calculations add up.
  3. 6.1: saving current inputs / overtime / short time / multi-rate for a month that is
     finalized for that employee → HTTP 423 PERIOD_LOCKED, nothing changes. A reversed
     month is open again. Another company's employee → 404.
  4. All-or-nothing save: the old routes deleted first and inserted after (a failed
     insert lost the inputs, and the delete error was ignored). With migration 028 the
     replace runs in one DB transaction (paytime_replace_period_rows, which also
     re-checks the lock). Before 028: old method, but lock check + errors checked.
  5. UF-06: after a new run, older DRAFT runs of that month that no longer own any open
     payslip are marked 'superseded' (needs 028). Finalizing a superseded run, or a
     draft run without open payslips → 409 RUN_SUPERSEDED (it used to "finalize"
     nothing and mark stale totals as final).
  6. BT-09 / step 1.4: calculation_output._meta.taxTable (brackets, rebates, medical
     credits, UIF, SDL actually used) + _meta.taxTableHash (sha256). The prepared
     tax_context was never saved (no such column) — finding confirmed.

Payroll risk:     [x] CRITICAL (engine + snapshot output)   Regression risk: [ ] High [x] Medium [ ] Low

Confirmed safe:
  [x] No PAYE/UIF/SDL/net figure changes — golden set 0 differences, core 15/15
  [x] Engine output is additive only (new fields after the last field)
  [x] Finalized snapshot read path: figures still returned unchanged from the row
  [x] Company context: every new query filters company_id; RPC checks employee ∈ company

Regression tests:
  golden S01–S72/M01–M11 (0 diffs), core 15/15, tests/payroll-fase6.test.js (15),
  tax-tables, period-sequence, recon-uif, overtime-shorttime, launch-blockers — 198/198.

Rollback: git revert; migration 028 is additive (function + nullable columns + wider CHECK).
─────────────────────────────────────────────────────────────
```

## Deployment order
1. Code (safe before 028 — legacy save path, no superseded marking).
2. Migration 028 (Ruan's go-ahead).
3. One-off: mark the existing draft runs without any payslip as superseded (41 of 51 on 2026-10-13) — data change, Ruan's go-ahead.

## Open after Fase 6
- PS-05 YTD totals on the payslip; PS-07 PDF hash; PS-06/09/10 old Payslips page (Fase 9).
- Overtime hourly rate is taken from the PRO-RATED basic salary in a pro-rata month (existing behaviour, not changed) — ask Ruan whether overtime should use the full monthly rate.
- Locked-month inputs panel on employee-detail still lists live current inputs for display (figures/PDF are frozen) — cosmetic, Fase 9 page work.
