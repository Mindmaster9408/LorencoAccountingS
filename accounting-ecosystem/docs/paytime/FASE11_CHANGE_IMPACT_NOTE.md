# Fase 11 — Change Impact Note (Browser storage / KV clean-up)

> 2026-10-13 · Ruan: "gaan aan met res" · Spec: [spec/13](spec/13_TOEGANG_EN_SEKURITEIT.md) TS-05/06/07, [spec/03](spec/03_WERKNEMERS.md) WN-13 · Finding B11 · CLAUDE.md Part D

```text
CHANGE IMPACT NOTE — PAYROLL (frontend data layer)
─────────────────────────────────────────────────────────────
Inventory (live KV, 2026-10-13): emp_payroll_* 51 (still written), narrative_* 143,
audit_log_* 39, payruns_* 29, __storage_test__ 25, tax_config 17, recon_* 9 (empty),
employees_* 5, report_history_* 4, historical_* 2, plus old emp_overtime/short_time/current.

Changed:
  1. DataAccess 'cache_' copies (employees, salaries, leave, notes, payroll items, …) were
     written to the browser's localStorage and used silently when the API failed
     (TS-05/06, POPIA). Now page memory only; using one shows a red "could not reach the
     server" banner; existing cache_ keys are deleted on the next visit.
     (js/data-access.js — HIGH auto-trigger file; no calculation input involved.)
  2. Payslip page: salary + recurring items no longer written to KV (emp_payroll_*); a
     failed DB save of a recurring item used to fall back to "localStorage only" (shown on
     screen, ignored by payroll) → now an error and nothing is shown as saved. Same for
     variable amounts and deletes. The KV value is still READ once to move old
     browser-only items into the DB (3 employees still have items only in KV).
  3. Employee notes → database (employee_notes) via /api/payroll/employees/:id/notes
     (company-scoped, confidential filter, new DELETE, audited). Were KV only.
  4. Audit trail: frontend no longer keeps a KV copy (audit_log_*); reports' audit
     reports read GET /api/audit. report_history_* (written, never read) removed.
  5. Payslip explanation (narrative_*) — regenerated each time; now page memory only.
  6. Old recon KV writers retired (Fase 7 moved recon to the DB; recon_* rows are empty).
  7. Dashboard's unreachable in-page employee editor (KV only) → redirects to
     employee-management.
  8. storageAvailable() probe key stays local (was written to the KV table 25×).

Prepared, NOT run (data change — needs Ruan's "ja"):
  migration 031: copy the KV basic salary into employees.basic_salary for the 20
  employees (18 active, 11 companies) whose salary exists ONLY in KV today; audited.
  Dry run (rolled back): 20 rows. After it runs, the backend KV salary fallback in
  PayrollDataService is removed (11.3).

Not changed (tracked):
  - historical-import.html KV writes (emp_historical, payruns, import log) → with the
    import rebuild (roadmap).
  - payroll-items "hidden items" list (company setting, not personal) → SQL later.
  - tax_config KV mirror (legacy frontend pages) — written by the tax-tables route.
  - Old KV rows are left in place (inert); deleting them is a separate data clean-up.

Payroll risk: [x] MEDIUM (data layer of every Paytime page; no figure changes)
Confirmed: golden 0 diffs, core 15/15, full Jest 935 pass (6 known failing suites
unchanged), payroll-fase11 4/4, all changed JS files syntax-checked.
Rollback: git revert.
─────────────────────────────────────────────────────────────
```
