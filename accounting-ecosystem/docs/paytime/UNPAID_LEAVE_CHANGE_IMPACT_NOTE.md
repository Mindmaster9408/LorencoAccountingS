# Change Impact Note — Paytime: leave saving restored + unpaid leave deducted (2026-11-11)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  Leave (employee page → 🏖️ Leave) and its effect on the payslip.

Files involved:
  backend/migrations/037_paytime_unpaid_leave.sql            (new)
  backend/modules/payroll/services/unpaidLeave.js            (new)
  backend/modules/payroll/routes/attendance.js               (POST /leave restored; sync on POST/PUT/DELETE)
  backend/modules/payroll/routes/transactions.js             (short-time re-save keeps source 'leave')
  frontend-payroll/employee-detail.html                      ("from leave" badge; leave save shows payslip result)
  frontend-payroll/js/data-access.js                         (saveLeave/deleteLeave return the server result)

Why this change is needed:
  1. POST /api/payroll/attendance/leave was deleted by mistake in Fase 8 (369e52e,
     2026-10-13) together with the old attendance routes. Since then every
     "Save Leave" failed ("Failed to save leave record"); leave_records has 0 rows.
  2. Approved Unpaid Leave was never deducted: nothing turned it into short time,
     and the attendance proposal treats every approved leave type as "not absent".
     Ruan 2026-11-11: "maak dit reg".

Is this an explicitly authorised Paytime task?
  [x] Yes  — Ruan 2026-11-11

Payroll risk:
  [ ] CRITICAL  [x] HIGH  [ ] MEDIUM  [ ] LOW

Specific payroll areas that could be affected:
  - payroll_short_time rows (new source 'leave'); the engine already reads every
    short-time row regardless of source → reduces gross like any short time.
  - paytime_replace_period_rows (payslip re-save) must keep 'leave' rows' source.
  - Attendance proposal: unchanged. Approved unpaid leave days stay "leave" there,
    so the same day is never deducted twice (once by leave, once as absence).

Regression risk:
  [ ] High  [x] Medium  [ ] Low

Regression tests required:
  [x] TEST-PAY-01 basic payslip   [x] TEST-PAY-07 short time cascades
  [x] TEST-PAY-09 finalized immutable (locked month is never written: RPC refuses)
  [x] TEST-PAY-11/12 company context / multi-tenant (all queries company-scoped)
  [x] TEST-PAY-13 no browser storage
  Automated: backend/tests/golden, payroll-fase8, unpaid-leave (new), full suite.

Rollback strategy:
  Revert the commit. Migration 037 is additive (constraint widened, functions
  replaced with a superset); 'leave' rows can be removed with
  DELETE FROM payroll_short_time WHERE source = 'leave' (only open months).

Confirmed safe:
  [x] payroll-engine.js not affected
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected (locked months refused by RPC)
  [x] Company context not affected (req.companyId on every query)
  [x] PAYE/UIF/SDL logic not affected (short time flows through existing path)
─────────────────────────────────────────────────────────────
```

## Behaviour

- Leave type `unpaid`, status `approved` → for every month the leave touches, ONE
  short-time row `source = 'leave'`, hours = the employee's scheduled hours on the
  leave days (work schedule; default Mon–Fri 8 h), public holidays and days outside
  employment excluded. Description: `Unpaid leave: N day(s)`.
- Recomputed for the affected months whenever unpaid leave is added, approved,
  rejected, edited or deleted (old and new date ranges).
- Finalized month → not written; the API reports it so the user knows to correct
  it in the next open month or reverse the run.
- Rows typed by hand (`manual`) and attendance rows (`attendance`) are never touched.
- Leave balance is deducted only for approved leave (the old POST deducted pending leave too).
