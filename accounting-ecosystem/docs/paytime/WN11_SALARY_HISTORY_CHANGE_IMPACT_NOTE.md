# WN-11 — Salary history with an effective month (Change Impact Note)

> 2026-10-14 · Ruan's decisions (spec 03 WN-11): effective from a MONTH; finalized month →
> back pay as a once-off in the first open month; increases may be scheduled ahead.

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area: where the calculation gets the basic salary; how a salary change is saved.
Files: migrations/034_employee_salary_history.sql (NOT RUN — needs "ja 034"),
       services/salaryHistory.js (new), services/PayrollDataService.js (CRITICAL),
       routes/employees.js (payroll, CRITICAL), shared/routes/employees.js,
       frontend-payroll/employee-detail.html (HIGH)

Calculation: salary of a month = latest history row effective on or before that month;
before the first row → its previous_salary; no rows → employees.basic_salary (as today).
A history read failure stops the calculation (PI-07).

Saving (payslip page → Edit Basic Salary): amount + effective month + reason.
  POST /api/payroll/employees/:id/salary-change (preview first)
  - effective month already finalized → back pay = Σ (new − paid salary) × pro-rata factor
    over the finalized months, added as ONE once-off earning "Back pay — salary from
    YYYY-MM" to the month after the last finalized one (existing inputs kept; taxed
    once-off). Finalized payslips are not touched. The user confirms the amount first.
  - a retroactive DECREASE is refused (reverse those months instead) — not in Ruan's
    decision; flagged below.
  - future month → scheduled; employees.basic_salary changes only when the effective month
    is the current month or earlier.
  GET /api/payroll/employees/:id/salary-history — shown in the dialog.
  The old PUT …/salary and PUT /api/employees/:id also write a history row (effective
  current month) so the history stays complete.

Until 034 runs: nothing changes (dialog saves the old way; calculation as before).

Payroll risk: [x] CRITICAL files; behaviour unchanged until history rows exist.
Checks: golden 0 diffs, core 15/15, payroll gate pass, tests/payroll-wn11-salary-history
(8), live read-only load of 40 employees: 0 errors.
Open for Ruan: retroactive decrease (refused now); IRP5 code for "Back pay" (IT-05 will
warn until a "Back pay" Payroll Item with a code exists); percentage items based on the
salary are not back-paid.
Rollback: git revert (034 is additive).
─────────────────────────────────────────────────────────────
