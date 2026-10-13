# Fase 10 — Change Impact Note (Security and required fields)

> 2026-10-13 · Ruan: "kies jy" (Fase 10 chosen) · Spec: [spec/07](spec/07_UITVOER_EN_FINALISERING.md) UF-10, [spec/13](spec/13_TOEGANG_EN_SEKURITEIT.md) TS-04, [spec/03](spec/03_WERKNEMERS.md) WN-01..04 · Findings B6, V6

```text
CHANGE IMPACT NOTE — PAYROLL + SHARED
─────────────────────────────────────────────────────────────
Files involved:
  backend/modules/payroll/routes/unlock.js       (rewritten)
  backend/shared/utils/saIdentity.js              NEW  SA ID / SARS tax number validation
  backend/shared/routes/employees.js              (SHARED — all apps) create/edit validation, duplicates
  backend/middleware/audit.js                     (SHARED — all apps) top-level context kept in metadata
  backend/modules/payroll/routes/payruns.js       (CRITICAL) run warnings
  backend/modules/payroll/routes/recon.js         EMP501 irp5_blocked flag
  backend/modules/payroll/routes/attendance.js    audit metadata
  backend/migrations/030_employee_tax_number_pending.sql  NEW
  frontend-payroll/employee-detail.html, employee-management.html, payroll-execution.html

1. Payslip unlock (B6) — found and fixed:
   - a manager of ANY company could approve (global users.role was checked) → now an
     active user_company_access role in THIS company (PAYSLIPS.UNLOCK list) or a super user;
   - self-approval was possible → refused;
   - unlimited password attempts → 5 failures per user per company per 15 minutes;
   - "credentials not recognized" vs "invalid credentials" revealed which e-mails exist →
     one generic answer (and a dummy bcrypt compare for unknown e-mails);
   - fail-open (a failed run check carried on) → every check fails closed (503, nothing unlocked);
   - audit went to `audit_logs`, a table that does not exist — no unlock was EVER recorded →
     audit_log; failures are recorded before the answer (needed for the limit);
   - the route had no auth middleware of its own (worked only because another router
     mounted at '/' ran first) → own authenticateToken + requireCompany.
2. Tax number required again (WN-02, owner option b) — switched off "for testing" on
   2026-04-20. Required on create unless "Not yet registered with SARS" is ticked
   (employees.tax_number_pending, migration 030). Validated: 10 digits, first digit
   0/1/2/3/9, Luhn check (219/223 live numbers pass; the 4 others are real errors).
3. ID / passport (WN-01/03): required on create; SA ID = 13 digits + valid birth date +
   Luhn (244/252 live pass); a value with letters is a passport (5–20 chars).
4. Duplicates (WN-04): no second ACTIVE employee with the same ID in a company.
5. Edits validate only fields that change — the 38 employees without a tax number and
   the few with invalid numbers can still be edited (the page itself now asks for the
   number or the tick).
6. Every pay run lists employees with a missing/invalid tax or ID number (warning, never a
   block); EMP501 marks them irp5_blocked with the reason.
7. Shared audit helper: context passed at the top level (period_key, totals, …) was
   dropped for every caller — e.g. payroll run/finalize/reverse rows had no period →
   now kept in metadata. Known fields unchanged.
8. Execute Payroll result cards subtracted SDL (employer cost) as a deduction → total
   deductions = gross − net; SDL shown as employer cost.

Before migration 030: everything works except ticking "not yet registered" for an
employee without a number (clear message: needs database update 030).

Payroll risk: [x] MEDIUM (no figure changes; access + validation)   Regression risk: [x] Low/Medium
Confirmed: golden 0 diffs, core 15/15, full Jest 931 pass (the 6 failing suites are the
known pre-existing Sean/OCR/PDF/employee-sync ones), payroll-fase10 18/18.
Rollback: git revert; 030 is one nullable-default column.
─────────────────────────────────────────────────────────────
```
