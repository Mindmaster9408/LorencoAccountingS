# Paytime Hardening — End of Service Safety Fixes

**Date:** 2026-05-28
**Module:** Paytime Payroll — Employee lifecycle
**Status:** COMPLETE ✅
**Source:** PAYTIME HARDENING CODEBOX — End of Service Safety Fixes

---

## 1. Summary

Five targeted safety fixes based on the End of Service audit. No payroll calculations were changed. No hard deletes. No snapshot mutations. All payroll history is preserved.

---

## 2. Fixes Implemented

### Fix 1 — Server-side active employee guard in `POST /api/payroll/run`

**File:** `backend/modules/payroll/routes/payruns.js`

**Before:** The `for (const empId of visibleIds)` loop had no independent `is_active` check. A terminated employee ID passed directly in the request body bypassed the visibility filter and got calculated.

**After:** Before the snapshot check, a DB lookup verifies `is_active` and `termination_date` for each `empId`. The new pure function `isEligibleForPayroll(empRow, periodStart, periodEnd)` implements the guard:

- Active employee → passes (normal case)
- Inactive, no termination_date → blocked
- Inactive, terminated before period → blocked
- Inactive, terminated within period → **passes** (final pro-rata pay — correct behaviour)
- Null empRow (not found or cross-company) → blocked

The function is exported on the router (`router.isEligibleForPayroll`) for unit testing without a live server.

**Pro-rata safety:** Termination-month processing is preserved. An employee terminated on May 15 who was end-serviced before the May payroll run will have `is_active=false` but `termination_date='2026-05-15'` within the period — the guard lets them through and the existing auto-proration logic fires.

---

### Fix 2 — Align `DELETE /api/payroll/employees/:id` with End Service metadata

**File:** `backend/modules/payroll/routes/employees.js`

**Before:** The payroll-module DELETE route updated only `{ is_active: false }` — no `employment_status`, no `termination_date`.

**After:** The update now sets:
```javascript
{
  is_active:         false,
  employment_status: 'terminated',
  termination_date:  new Date().toISOString().split('T')[0],
  updated_at:        new Date().toISOString(),
}
```

This matches the shared End Service route's behaviour. The `PayrollDataService.fetchCalculationInputs()` function maps `termination_date → end_date` for pro-rata auto-detection, so terminated employees deactivated via this route also get correct final-period processing.

---

### Fix 3 — Permission hardening for End Service

**File:** `backend/shared/routes/employees.js`

**Before:** `POST /:id/end-service` used `requirePermission('EMPLOYEES.EDIT')` — allowed by `store_manager` and `payroll_admin` roles.

**After:** `POST /:id/end-service` uses `requirePermission('EMPLOYEES.DELETE')` — restricted to `super_admin`, `business_owner`, `practice_manager`, `administrator` only.

The frontend already used `data-permission="DELETE_EMPLOYEES"` and checked `Permissions.require('DELETE_EMPLOYEES')` in `openEndServiceModal()`. The backend was misaligned. This fix aligns the API to the frontend's intent. A `store_manager` or `payroll_admin` could previously bypass the frontend guard by calling the API directly — that gap is now closed.

---

### Fix 4 — Remove orphaned `deleteEmployee()` function

**File:** `frontend-payroll/employee-management.html`

**Before:** A `deleteEmployee()` function existed at lines ~1220–1246. No button or event handler called it — it was dead code left over from an earlier implementation. It also contained legacy localStorage logic (`emp.id.indexOf('emp-') === 0`) that is incompatible with the current DB-backed architecture.

**After:** Function removed. Associated `.btn-delete` CSS class (`.btn-delete`, `.btn-delete:hover`) also removed as it was only referenced by the dead function.

---

### Fix 5 — Confirm history safety

**Confirmed:** None of the above changes touch:
- `payroll_snapshots` table or read path
- `payroll_runs` table (write path is unaffected)
- `payroll_historical` table
- PAYE reconciliation
- Finalized payslip read path
- PayrollEngine or PayrollCalculationService

The `is_active` guard only adds a read before calculation — it does not modify snapshot immutability or finalization logic.

---

## 3. Files Changed

| File | Change |
|------|--------|
| `backend/modules/payroll/routes/payruns.js` | Added `isEligibleForPayroll` pure function + guard in run loop + router export |
| `backend/modules/payroll/routes/employees.js` | DELETE route update payload: added `employment_status`, `termination_date`, `updated_at` |
| `backend/shared/routes/employees.js` | End Service permission: `EMPLOYEES.EDIT` → `EMPLOYEES.DELETE` |
| `frontend-payroll/employee-management.html` | Removed orphaned `deleteEmployee()` function and `.btn-delete` CSS |
| `backend/tests/end-of-service-hardening.test.js` | New — 9 unit tests |

**Files NOT changed:**
- `PayrollCalculationService.js` — untouched
- `PayrollEngine.js` — untouched
- `PayrollDataService.js` — untouched
- `PayrollHistoryService.js` — untouched
- `payroll-engine.js` (frontend) — untouched
- Any snapshot or finalization logic — untouched
- Any PAYE/UIF/SDL formula — untouched

---

## 4. Tests

**Test file:** `backend/tests/end-of-service-hardening.test.js`

```
PASS tests/end-of-service-hardening.test.js
  Paytime Hardening — End of Service Safety Fixes
    TEST-EOS-01: active employee passes the payroll guard
      ✓
    TEST-EOS-02: inactive employee with no termination_date is blocked
      ✓
    TEST-EOS-03: inactive employee terminated before the period is blocked
      ✓
    TEST-EOS-04: inactive employee terminated within the period passes (final pro-rata month)
      ✓
    TEST-EOS-05: null empRow (employee not found or cross-company) is blocked
      ✓
    TEST-EOS-06: inactive employee terminated after the period end is blocked
      ✓
    TEST-EOS-07: EMPLOYEES.DELETE is restricted to senior management only
      ✓
    TEST-EOS-08: EMPLOYEES.EDIT includes store_manager and payroll_admin — confirming End Service is now gated on the tighter DELETE permission
      ✓
    TEST-EOS-09: deleteEmployee() function and .btn-delete CSS are not present in employee-management.html
      ✓

Tests: 9 passed, 9 total
```

---

## 5. Risks Addressed

| Risk | Severity (from audit) | Status |
|------|-----------------------|--------|
| Terminated employee processed in payroll run if ID passed directly | MEDIUM | FIXED (Fix 1) |
| Payroll DELETE route missing `employment_status` and `termination_date` | MEDIUM | FIXED (Fix 2) |
| End Service uses `EMPLOYEES.EDIT` — too permissive | MEDIUM | FIXED (Fix 3) |
| Orphaned `deleteEmployee()` contains legacy localStorage logic | LOW | FIXED (Fix 4) |
| Pro-rata processing for termination-month employees | LOW | CONFIRMED SAFE — guard allows terminated-in-period employees through |
| Payroll history preserved after End Service | LOW | CONFIRMED SAFE — no changes to snapshots, runs, or historical records |

---

## 6. Final Safety Check

- [x] No posting logic changed
- [x] No PAYE/UIF/SDL formula changed
- [x] No snapshot immutability changed
- [x] No finalization logic changed
- [x] No hard delete added
- [x] All queries company-scoped (`company_id = req.companyId`)
- [x] Pro-rata termination-month processing preserved
- [x] `isEligibleForPayroll` is a pure function — no side effects
- [x] TEST-EOS-01 through TEST-EOS-09 all pass
- [x] Dashboard action queue tests (10) all pass
- [x] Paytime launch blocker tests (52) all pass
