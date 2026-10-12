# Fase 4 — Change Impact Note (Voluntary PAYE + payslip totals)

> 2026-10-12 · Authorised by Ruan · Spec: [spec/06 §E](spec/06_BEREKENINGSENJIN.md), [spec/08](spec/08_PAYSLIPS.md)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  Voluntary PAYE adjustments (engine), bonus-spread calculator, voluntary PAYE
  screen, payslip preview + PDF totals.

Files involved:
  backend/core/payroll-engine.js                         (CRITICAL) voluntary block + 2 additive output fields
  backend/modules/payroll/services/PayrollDataService.js (CRITICAL) fetchYtdData: per-entry voluntary history
  backend/modules/payroll/routes/voluntary-tax.js        (CRITICAL) calculator rewritten
  frontend-payroll/employee-detail.html                  (HIGH)     voluntary UI, payslip preview totals
  frontend-payroll/js/pdf-branding.js                    (payslip PDF)

What changes:
  1. Variable and Reduce entries: inactive (hidden in UI, kept in config, never applied).
  2. Target PAYE: only adds; below statutory → statutory + TARGET_BELOW_STATUTORY warning.
  3. Fixed / Target: optional start_period / end_period.
  4. Bonus Spread: linked to bonus_period. Instalments before the bonus month are
     credited against the bonus tax in that month; a part planned after the bonus
     month is deferred (warning + confirmation + audit fields) and collected later,
     never more than owed. Statutory paye_base is never changed → cumulative YTD stays
     correct. Unlinked legacy entries: unchanged behaviour + BONUS_SPREAD_NOT_LINKED warning.
  5. Calculator: X = paye_base(with bonus) − paye_base(without), in the bonus month,
     with the global tax tables (it used code defaults before) — no ×12 (K5).
     Spread must lie inside the bonus month's tax year (ends by February), max 12.
  6. Engine output (additive, after the last field): voluntary_breakdown, voluntary_warnings.
  7. Payslip preview + PDF: gross / deductions / net now ALWAYS the backend figures.
     FOUND DURING THIS WORK: both re-derived totals from line items and subtracted the
     medical tax credit a second time, so NET PAY was overstated by the full credit
     for every employee on a medical scheme. Line items that don't add up to the
     calculated gross now show a visible note. Voluntary lines shown separately.
  8. Saving a voluntary entry waits for the DB; on failure the entry is not shown.

Payroll risk:     [x] CRITICAL
Regression risk:  [ ] High  [x] Medium  [ ] Low
Golden set: only S51 (reduce → statutory 2115) and S52 (target below → statutory 2115)
  changed; new scenarios S54/S55/M09/M10/M11 verified by hand (M09/M10 total bonus tax
  exactly R4 791,74). 160/160 Jest, core 15/15, 0 lint errors.

Real data affected:
  - No Reduce/Variable entries exist in production (Fase 0.1) → item 1 changes nobody today.
  - Bakmeester (3 employees) Bonus Spread entries have no bonus_period yet → keep current
    behaviour + warning until the bonus month is set (Ruan to confirm which month each).
  - Every employee with medical aid: printed payslip NET PAY was too high; now correct.
    Already-printed payslips from earlier months were wrong on paper — the underlying
    snapshot figures (and bank payments, if made from the run) were correct.

Rollback: revert the commit. Locked snapshots are never recalculated.

Confirmed safe:
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected
  [x] Company context not affected
  [x] PAYE/UIF/SDL statutory logic not affected (paye_base unchanged)
─────────────────────────────────────────────────────────────
```
