# Fase 2 — Change Impact Note (inputs reach the engine correctly)

> 2026-10-12 · Authorised by Ruan ("jy kan maar begin") · Spec: [03](spec/03_WERKNEMERS.md), [04](spec/04_PAYROLL_ITEMS.md), [05](spec/05_PERIODE_INSETTE.md)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Files involved:
  backend/core/payroll-engine.js                         (CRITICAL)
  backend/modules/payroll/services/PayrollDataService.js (CRITICAL)
  backend/core/payroll-engine.regression-tests.js        (scenario 8 expected SDL)
  frontend-payroll/employee-detail.html                  (contractor label; "Set bonus month" on Bonus Spread entries)

Changes:
  K4   Multi-rate: the rand hourly rate the screen stores (in rate_multiplier) now reaches
       the engine (hourly_rate). Was paid R0 while the payslip showed it.
  B1   Once-off (current) inputs inherit is_taxable from payroll_items_master.
  B2   Once-off inputs inherit tax_treatment (pre_tax) from payroll_items_master.
  B9   employee_payroll_setup.uif_exempt now reaches the engine → UIF 0 for exempt employees.
  WN-06 Directors pay UIF (owner decision) — the director flag no longer zeroes UIF.
  WN-08 Contractors: PAYE on tables, UIF 0, SDL 0.
  IT-15 SDL on leviable (taxable) remuneration before pre-tax deductions — excludes
       non-taxable reimbursements and the non-taxable 20% of a travel allowance.
  UI   Existing Bonus Spread entries get a "Set / Change bonus month" button, so the owner
       can link older entries (e.g. Bakmeester) without deleting them.
  Additive output fields: is_contractor, sdlLeviableGross.

Payroll risk: [x] CRITICAL   Regression risk: [x] Medium
Golden: changed only S12, S12a, S12b, S13, S21, S22, S32, S40, S41, S62, M04 — each verified
  against the expected rule; S45 (contractor) added. Core 15/15 (scenario 8 SDL 195 → 185,
  intended), Jest 161/161, 0 lint errors.

Real data affected from the next calculation (Fase 0.1 counts):
  - Lorenco Ecosystum: 1 multi-rate entry will now be paid.
  - Turkstra: 1 director will now have UIF deducted.
  - AGS van SA Baillie Park: 1 UIF-exempt employee will stop paying UIF.
  - Any employee with a travel allowance or non-taxable allowance: SDL slightly lower.
  - Locked (finalized) months are never recalculated.

Rollback: revert the commit.
─────────────────────────────────────────────────────────────
```

Not in this phase (still open): ENJ-21 pro-rata of fixed allowances, PI-06 backend lock on inputs,
PI-07 hard failure when inputs can't be loaded, PI-12 atomic save of current inputs, IT-10..13.
