# PI-07 / B4 — Input load failures stop the calculation (Change Impact Note)

> 2026-10-13 · Ruan: "gaan an" · Spec: [spec/05](spec/05_PERIODE_INSETTE.md) PI-07 · Finding B4

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area: loading the calculation inputs (PayrollDataService) — CRITICAL.
Files: backend/modules/payroll/services/PayrollDataService.js, routes/calculate.js

Why: a failed database read was logged and the calculation carried on WITHOUT that input,
producing a normal-looking but wrong payslip:
  once-off inputs / overtime / short time / multi-rate → treated as none
  regular items → none            item settings (taxable, UIF, %) → old KV settings
  year-to-date snapshots → silently switched to the monthly PAYE method
  work schedule → default week (wrong hourly rate for overtime/short time)
  company SDL/UIF registration → "registered"
Now each of these throws INPUTS_UNAVAILABLE with a plain message. Pay runs list it per
employee (as before for other errors); /api/payroll/calculate returns 503 with the message.

Unchanged on purpose: "nothing saved" is still normal (no schedule → standard week, no
inputs → none, no prior months → no YTD); company_payroll_settings defaults (not used in
any figure); the legacy KV fallback when a company has no payroll_items_master rows.
Also: once-off inputs are read with is_deleted = false — the same rows the Payslip screen
shows (all 33 live rows are false today; deletes are hard deletes).

Payroll risk: [x] CRITICAL file, Low behaviour risk — figures only change when a read fails.
Checks: golden 0 diffs, core 15/15, payroll gate pass (only the known live-pg suite fails),
tests/payroll-pi07-load-errors.test.js (10), live read-only load of 40 employees in
companies 1/2/7/11/51 for 2026-10: 40 ok, 0 errors.
Rollback: git revert.
─────────────────────────────────────────────────────────────
```
