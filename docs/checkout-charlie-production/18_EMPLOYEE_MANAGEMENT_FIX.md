# 18 — EMPLOYEE MANAGEMENT FIX
## Paytime — Employee Filter + End of Service

**Date:** 2026-05-12
**Status:** ✅ Implemented
**Protected module change:** Yes — Paytime employee lifecycle

**Files changed:**

| File | Change |
|---|---|
| `backend/shared/routes/employees.js` | Default `is_active=true` filter + `POST /end-service` endpoint |
| `frontend-payroll/js/data-access.js` | `getEmployees` supports `includeInactive` option; `endEmployeeService` added |
| `frontend-payroll/employee-management.html` | End Service button + modal; Show Inactive toggle; inline filter works on clean list |

---

## Audit Findings

### Task 1 — Filter/Search Root Cause

The `filterEmployees()` function was logically correct. The root cause of unreliable search was:

- `GET /employees` returned ALL employees with no `is_active` filter by default.
- Terminated/inactive employees appeared in the employee list.
- Users searched and got unexpected results that included employees they expected to be gone.
- Field aliasing (`employee_number: emp.employee_number || emp.employee_code || ''`) was correct and functional.

### Task 2 — End of Service Current State (Before Fix)

- "Delete" button called `DataAccess.deactivateEmployee()` → `DELETE /api/employees/:id`
- The DELETE endpoint already did soft-delete (`is_active=false`, `employment_status='terminated'`) — no data was ever physically deleted. ✅
- BUT: `termination_date` was NOT captured. ❌
- Termination reason was NOT captured. ❌
- After deactivation, employee still appeared in list (no `is_active` filter). ❌
- Button still said "Delete" (misleading). ❌

**DB columns confirmed:**
- `is_active` ✅
- `employment_status` ✅
- `termination_date` ✅ (already in schema, referenced by payroll employment-dates endpoint)
- `termination_reason` ❌ — stored in `employee_notes` table with `note_type='termination_reason'` (avoids schema migration risk)

---

## Changes Implemented

### 1. `backend/shared/routes/employees.js`

**GET `/api/employees`** — Added `is_active=true` default filter:
```javascript
// Default: active employees only. Pass ?include_inactive=true to include terminated/inactive.
if (include_inactive !== 'true') {
    query = query.eq('is_active', true);
}
```

**DELETE `/api/employees/:id`** — Now also captures `termination_date` (today) so the existing soft-delete path is complete.

**POST `/api/employees/:id/end-service`** — New endpoint:
- Requires `termination_date` (validated)
- Sets `is_active=false`, `employment_status='terminated'`, `termination_date`
- If `termination_reason` provided: inserts into `employee_notes` with `note_type='termination_reason'`
- Rejects if employee is already inactive (409)
- Full audit log
- Company-scoped (multi-tenant safe)

### 2. `frontend-payroll/js/data-access.js`

**`getEmployees(companyId, options)`** — Added `options.includeInactive`:
- Appends `?include_inactive=true` to the GET request when needed
- Only caches the active-only result (offline fallback stays clean)

**`endEmployeeService(id, termination_date, termination_reason)`** — New function:
- `POST /employees/:id/end-service`

### 3. `frontend-payroll/employee-management.html`

**State added:**
```javascript
let showInactive = false;
let endServiceTargetId = null;
```

**Search bar:** Added "Show Inactive" toggle button. Clicking toggles `showInactive` and reloads the employee list. Button turns active (grey filled) when showing inactive employees.

**Employee row actions:** Replaced:
- OLD: `<button class="btn-delete" onclick="deleteEmployee(...)">Delete</button>`
- NEW: `<button class="btn-end-service" onclick="openEndServiceModal(...)">End Service</button>` for active employees; `<span class="inactive-badge">Ended</span>` for already-terminated employees (visible only in Show Inactive mode).

**End of Service modal:** New modal with:
- Employee name displayed in confirmation message
- Service end date (date picker, pre-filled to today, required)
- Reason dropdown (Resignation / Retrenchment / Dismissal / Contract Expired / Retirement / Death / Other — optional)
- Confirmation that historical payslips are preserved
- Cancel / Confirm buttons
- Error display on failure

**New functions:**
- `toggleShowInactive()` — toggles state, updates button, reloads list
- `openEndServiceModal(id)` — permission check, populates modal, opens
- `closeEndServiceModal()` — closes modal, clears target
- `confirmEndService()` — validates, calls `DataAccess.endEmployeeService()`, reloads list

---

## Payroll Impact

| Area | Impact |
|---|---|
| `GET /api/payroll/employees` | Not changed — already had `is_active=true` filter |
| `GET /api/employees` (shared) | Now filters `is_active=true` by default — active-only |
| `payroll-execution.html` uses `DataAccess.getEmployees()` | Now gets active-only employees — CORRECT, terminated employees excluded from payroll runs |
| `payroll_snapshots` / historical records | Not touched — all history preserved |
| `payroll-engine.js` | Not touched |
| Finalized snapshots | Not touched — immutable |

---

## Testing Required

| Test | Expected |
|---|---|
| Search by employee number | Filter shows only matching active employees |
| Search by first name | Case-insensitive match on `first_name` field |
| Search by surname | Case-insensitive match on `last_name` field |
| Clear search | Full active employee list restored |
| Company A employees in Company B session | Not shown (company_id scoping unchanged) |
| Click "End Service" on active employee | Modal opens with employee name, today's date pre-filled |
| Submit End Service without date | Validation error shown, no API call |
| Submit End Service with date only | Employee deactivated, disappears from active list |
| Submit End Service with date + reason | Deactivated, reason stored in employee_notes |
| Reload after End Service | Employee no longer in list (is_active filter) |
| Click "Show Inactive" | Toggle turns active, terminated employees appear with "Ended" badge |
| Click "Hide Inactive" | Toggle resets, active employees only |
| Payroll execution after End Service | Terminated employee does not appear in payroll run employee list |
| Historical payslips after End Service | Still accessible via payruns/reports (query payroll_snapshots, not employees) |
| End Service on already-inactive employee | 409 error from backend — cannot double-end |

---

## Regression Tests Required (Paytime Gate)

| Test | Confirmed safe |
|---|---|
| TEST-PAY-09 Finalized snapshot immutable | ✅ Not touched |
| TEST-PAY-12 Multi-tenant no cross-company | ✅ company_id scoping unchanged |
| TEST-PAY-13 No payroll data in browser storage | ✅ No storage writes added |

---

## What Was NOT Changed

- `payroll-engine.js` — untouched
- `backend/modules/payroll/routes/employees.js` — untouched (already has `is_active=true`)
- `payroll-execution.html` — untouched (benefits from backend filter change automatically)
- `payroll_snapshots` table — untouched
- `employee_payroll_items` table — untouched
- Physical delete path — does not exist (never did; confirmed safe)
