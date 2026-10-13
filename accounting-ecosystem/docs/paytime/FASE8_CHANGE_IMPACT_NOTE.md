# Fase 8 — Change Impact Note (Attendance → payroll)

> 2026-10-13 · Authorised by Ruan ("8", "go") · Spec: [spec/05](spec/05_PERIODE_INSETTE.md) PI-08 (option b, owner-confirmed), PI-09 · Finding V1 · CLAUDE.md Part D (`attendance_*` KV → SQL)

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  The Attendance page and how attendance reaches the payslip.

Found in the audit:
  - The whole attendance module lived in browser/KV storage (records AND the
    employee list). "Apply to Payroll" wrote emp_overtime_/emp_short_time_ KV keys
    that the backend never reads — attendance never reached a payslip (V1).
  - The backend attendance API read a `date` column that does not exist
    (`attendance_date`) and employees.full_name — it never worked. 0 rows in prod;
    no attendance_* KV data exists, so nothing to migrate.
  - Overtime was "> 8 hours a day"; absences ignored leave and public holidays.

Files involved:
  backend/migrations/029_paytime_attendance_to_payroll.sql   NEW  source column + paytime_apply_attendance
  backend/modules/payroll/services/attendanceProposal.js     NEW  pure BCEA proposal + SA public holidays
  backend/modules/payroll/routes/attendance.js       (rewritten GET/POST/DELETE, NEW proposal + apply; leave routes unchanged)
  backend/modules/payroll/routes/transactions.js     (CRITICAL) period inputs return + keep `source`
  backend/modules/payroll/services/periodInputs.js   legacy path strips `source`
  backend/modules/payroll/services/PayrollDataService.js (CRITICAL) overtime/short-time description → payslip line
  frontend-payroll/js/attendance.js                  rewritten on the API — no browser storage
  frontend-payroll/attendance.html                   proposal window, summary columns
  frontend-payroll/employee-detail.html              "from attendance" badge; re-save keeps source

What changes:
  1. Attendance is stored in the `attendance` table (one row per employee per day);
     hours are calculated on the server from clock in/out (overnight allowed).
     Confidential employees stay hidden from restricted users (paytimeAccess filter).
  2. "Apply to Payroll" shows a PROPOSAL (nothing written): per employee overtime
     1.5× (beyond roster + ordinary hours over 45/week), Sunday 2× (when not rostered),
     public holiday worked +1×, absent days (rostered, no attendance, not approved
     leave, not a public holiday, not before start / after leaving, not in the future).
  3. The payroll user ticks employees and approves. Only then: their 'attendance'
     overtime/short-time rows for the month are replaced in one DB transaction
     (paytime_apply_attendance); rows typed in by hand are never touched; a finalized
     month is refused per employee. Figures are recalculated on the server.
  4. On the payslip the rows show "from attendance", can be deleted like any row,
     and keep their source when the list is re-saved.

Payroll risk:     [x] HIGH (new path into payroll inputs; engine untouched)
Regression risk:  [ ] High [ ] Medium [x] Low — companies that don't use attendance see no change

Confirmed safe:
  [x] Engine unchanged except overtime/short-time description now reaches the line text
  [x] Golden 0 diffs, payslip lines add up 113/113, core 15/15, payroll Jest 236
  [x] Manual overtime/short time unaffected (source 'manual'; RPC keeps it)
  [x] Before migration 029: payslip page works (source read is tolerant); apply → 409

Assumptions (BCEA defaults — the payroll user reviews each proposal):
  - Partial days (worked < roster) are shown, not deducted.
  - Night work / standby allowances are not derived from attendance.
  - Old emp_overtime_* / emp_short_time_* KV keys (13 + 8, April 2026) are left as is —
    the backend never read them.

Rollback: git revert; 029 is additive (column default 'manual', functions).
─────────────────────────────────────────────────────────────
```
