# IT-06 / IT-07 — Fringe benefits and the retirement deduction limit (Change Impact Note)

> 2026-10-14 · Ruan: build both now; company car with a calculator per employee.
> Spec: [spec/04](spec/04_PAYROLL_ITEMS.md) IT-06, IT-07

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Files: core/payroll-engine.js (CRITICAL), services/PayrollDataService.js (CRITICAL),
       routes/employees.js (payroll, CRITICAL), services/companyCar.js (new),
       services/irp5ItemCheck.js, migrations/035_employee_company_cars.sql (RUN 2026-10-14, Ruan: "ja"),
       employee-detail.html (HIGH), js/pdf-branding.js

IT-06 (s11F): retirement deduction = employee pre-tax deductions + employer retirement
  contribution (IRP5 3817, deemed paid by the employee), limited per month to 27.5% of
  this month's remuneration and R350 000 / 12. Below the limit it is exactly the old
  "subtract all pre-tax deductions". The full amount is still deducted from net pay; only
  the tax deduction is limited. SDL stays on total remuneration (never reduced by
  retirement contributions — unchanged). New outputs: retirement_contributions,
  retirement_deduction_allowed, retirement_cap_monthly.

IT-07:
  - employer retirement contribution (3817): taxable fringe benefit (IT-10 path) AND in
    the IT-06 deduction → no extra PAYE within the limit (it was over-taxed before; no
    company uses such an item yet).
  - employer medical contribution (3810): taxable fringe benefit via IT-10; the medical
    tax credit stays per member (unchanged).
  - company car (para 7): table employee_company_cars (migration 035). Per car: determined
    value, maintenance plan, business use ≥ 80%, from/to month. Monthly value = 3.5%
    (2.5% with plan); PAYE on 80% (20%); IRP5 3802; never in gross or net; in SDL; not in
    UIF. Pro-rated in a pro-rata month like other regular items. Payslip line in the
    employer section (kind 'fringe_benefit'). A car cannot start in a finalized month;
    once in a finalized payslip it can only be ended, not deleted.
  - the IRP5 code now travels with each input (calculation_input.irp5_code, additive).

Payroll risk: [x] CRITICAL; behaviour changes only for (a) pre-tax deductions above 27.5%
  of remuneration, (b) items coded 3817, (c) company cars after 035.
Checks: golden 0 diffs, core 15/15, payroll gate pass, tests/payroll-it06-it07-benefits
  (8), live read-only load of 40 employees: 0 errors; live cap check: see handoff.

FOLLOW-UP NOTE
- Area: UIF on the company car benefit
- Confirmed now: not in the UIF base (same as other non-cash benefits in this engine)
- Not yet confirmed: whether the UIF Act's "remuneration" includes the car benefit
- Risk if wrong: UIF slightly under-deducted for employees with a company car
- Recommended next check: Ruan to confirm; one constant in companyCar.js (affects_uif)
  plus the engine's non-cash path if it must be included.
- Not built: the s11F excess carried forward (assessment matter, not payroll); car
  reductions for employee-paid fuel/maintenance (assessment); determined-value reduction
  for older cars is entered by the user as the determined value.
─────────────────────────────────────────────────────────────
```
