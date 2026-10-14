# PS-05 — Year-to-date totals on the payslip (Change Impact Note)

> 2026-10-14 · Ruan: "gaan an" · Spec: [spec/08](spec/08_PAYSLIPS.md) PS-05

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area: payslip display. No figure changes.
Files: services/PayrollDataService.js (fetchYtdData also sums display totals — CRITICAL),
       services/PayrollCalculationService.js (additive output field `ytd`),
       payroll-execution.html (preview + bulk print), employee-detail.html (payslip),
       js/pdf-branding.js (PDF)

ytd = finalized payslips of earlier months in the same tax year + this payslip:
  months, gross, taxable, PAYE, UIF (employee + employer), SDL, deductions, net, medical
  credit. Stored in calculation_output, so it is frozen with the snapshot — a finalized
  payslip always shows the same YTD. Payslips calculated before 2026-10-14 have none;
  the block is simply not shown for them.
Also: employer contributions (IT-10) now listed under Company Contributions on the
employee payslip screen and the PDF (they were only on Execute Payroll's preview).

Payroll risk: [x] MEDIUM (CRITICAL files touched), behaviour risk LOW — additive field;
PAYE inputs unchanged. Checks: golden 0 diffs, core 15/15, payroll gate pass,
tests/payroll-ps05-ytd.test.js (2), live read-only calculation on TEST (employee 270,
2026-08: 6 months, figures consistent).
Rollback: git revert.
─────────────────────────────────────────────────────────────
