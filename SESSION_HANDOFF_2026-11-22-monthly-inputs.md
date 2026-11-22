# Session handoff — 2026-11-22 — Paytime monthly inputs import

Authorised by Ruan ("ja doen jou voorstel"), Paytime stability lock respected (Change Impact Note given before coding).

## Why
Turkstra's November needed ~91 variable inputs across 32 employees (overtime, short time, advances, loans,
savings, Power of Finance). Paytime could only capture them one by one; the Import screen is for historical
months and Attendance works on daily entries.

## What changed
| File | Purpose |
|---|---|
| `backend/modules/payroll/services/bulkInputs.js` (new) | Pure planning (parse, suggest mapping, validate, merge with existing rows) + DB run |
| `backend/modules/payroll/routes/bulk-inputs.js` (new) | `GET /api/payroll/bulk-inputs/setup`, `POST /api/payroll/bulk-inputs` (dry_run / save), audit on save |
| `backend/modules/payroll/index.js` | mounts `/bulk-inputs` |
| `frontend-payroll/monthly-inputs.html` (new) | month → template → upload → map columns → Check (totals, errors, warnings) → Save |
| `frontend-payroll/js/sidebar.js` | "Monthly Inputs" link |
| `backend/tests/payroll-bulk-inputs.test.js` (new) | 8 unit tests |

## Rules
- A value in the file replaces that employee's value for the same item this month; other items stay; blank/0 = no change.
- Overtime / short-time hours replace hand-captured (`source='manual'`) rows; Attendance and unpaid-leave rows stay (warning shown).
- Writes go through the existing `periodInputs.replacePeriodRows` (one transaction per employee+table, refused for a finalized month) — exactly what the payslip screen writes. Payroll engine, calculation, snapshot/finalize path untouched. No migration.
- Nothing is saved when any row has an error. Re-importing the same file is idempotent (verified: same rows, same net pay).
- Employee number = `employees.employee_code`.

## Verified
- Unit 8/8; full suite 1540 pass; golden gate 56/56; lint 0 errors; inline script parses.
- E2E 9/9 in company 51 (period 2026-10, emptied again afterwards): mapping suggestions, error file saves nothing, totals, Attendance warning, save, existing Annual Bonus kept + Advance replaced, payslip calculates with imported inputs, re-import idempotent.

## Data (run 2026-11-22)
- Company 7 (Turkstra): new payroll item "Advance" (deduction, net_only, not taxable, no UIF) — same settings as Staff Loan.
- Company 51: test item "Advance" (same settings).

## Follow-ups
- Company 7 has "Savings" as both an earning and a deduction — the import suggests the deduction.
- Multi-rate inputs are not part of the import (not needed for Turkstra).
