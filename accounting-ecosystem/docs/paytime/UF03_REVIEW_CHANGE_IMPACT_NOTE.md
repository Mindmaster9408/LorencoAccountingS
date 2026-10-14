# UF-03 — Review before finalizing (Change Impact Note)

> 2026-10-14 · Ruan: "gaan an" · Spec: [spec/07](spec/07_UITVOER_EN_FINALISERING.md) UF-03

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area: Execute Payroll → Finalize dialog. Read-only addition; finalize logic unchanged.
Files: services/runReview.js (new), routes/payruns.js (new GET route only),
       frontend-payroll/js/payroll-api.js (getRunReview), payroll-execution.html (dialog)

GET /api/payroll/history/run/:run_id/review (PAYROLL.VIEW): this run's payslips vs last
month's finalized payslips. Flags per employee: net change > 10% and > R100, new (no
payslip last month), negative net, tax number / ID issues, items without an IRP5 code
(IT-05), and employees paid last month but not in this run. Confidential employees the
user may not see are left out (WN-15). Shows only — the user still decides to finalize.

Payroll risk: [x] LOW — read-only; no calculation, snapshot or finalize path touched.
Checks: tests/payroll-uf03-review.test.js (3); payroll gate + golden pass; live read-only
run on TEST (51) and company 2 gave sensible flags.
Rollback: git revert.
─────────────────────────────────────────────────────────────
```
