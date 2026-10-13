# IT-10 — Employer contributions are never paid out (Change Impact Note)

> 2026-10-13 · Ruan: "gaan an" · Spec: [spec/04](spec/04_PAYROLL_ITEMS.md) IT-10 (owner decision, option a)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed: how a Payroll Item of type "employer_contribution" is calculated.

Files involved:
  backend/core/payroll-engine.js                 (CRITICAL)
  backend/modules/payroll/routes/items.js        (CRITICAL — assignment type mapping)

Why: an employer contribution was stored as an "earning" when assigned to an employee,
so the engine added it to gross, taxable income AND net pay — the employee was paid the
employer's contribution in cash.

Owner decision (IT-10, option a): employer contributions are never paid to the employee.
They show on the payslip under employer contributions. Where SARS treats the contribution
as a taxable fringe benefit (e.g. employer pension / medical contribution), it is added to
taxable income but NOT to net pay.

New behaviour (engine):
  - type 'employer_contribution' / 'company_contribution' (regular or current input):
      · never in gross, never in net, never in deductions
      · is_taxable !== false → taxable portion (taxable_percentage) added to taxable
        income (PAYE) and therefore to the SDL base (remuneration includes fringe benefits)
      · never in the UIF base (UIF Act: employer fund contributions are not remuneration)
      · payslip line in section 'employer' (kind 'employer_contribution')
      · new additive outputs: employer_contributions, fringe_benefits_taxable
  - Assignment (POST /api/payroll/items/employee): employer_contribution → DB type
    'company_contribution' (allowed by both table CHECKs — no migration).

Is this an explicitly authorised Paytime task?  [x] Yes (owner spec decision IT-10)
Payroll risk:      [x] CRITICAL (engine)  — but zero live exposure: no company has an
                   employer_contribution item (checked 2026-10-13: payroll_items_master,
                   payroll_items, employee_payroll_items).
Regression risk:   [x] Low — only rows of the new type take the new path; every other
                   item follows exactly the old code. Golden scenarios must show 0 diffs.
Tests: golden gate (0 diffs) + core + new tests/payroll-employer-contribution.test.js;
       TEST-PAY-01/03/04/05/10 covered by the golden set.
Rollback: git revert (no data written).

Confirmed safe:
  [x] Finalized snapshot read path not affected (snapshots are returned as stored)
  [x] Company context not affected
  [x] PAYE/UIF/SDL logic unchanged for every existing item type

Follow-ups (not in this change):
  - Leo payroll journal: employer contributions need their own expense / payable accounts
    (journal stays balanced today because they are outside gross/net).
  - IT-06/IT-07: employer retirement contribution is also deemed an employee contribution
    for the s11F deduction; employer medical contribution and the s6A credit — with the
    fringe-benefit work.
  - frontend-payroll/js/payroll-engine.js (only historical-import.html still calculates in
    the browser) is not changed — retired with the import rebuild.
─────────────────────────────────────────────────────────────
```
