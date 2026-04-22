# SESSION HANDOFF — 2026-04-17 — Payroll Snapshot Lock Integrity

## What Was Done

### Workstream: Finalized Payslip Snapshot Lock Integrity

**Problem Solved:** After a backend batch payrun (`POST /api/payroll/run` + `POST /api/payroll/finalize`) locked a snapshot in `payroll_snapshots` (setting `is_locked = true`), the `employee-detail.html` page had NO mechanism to detect this. It would recalculate live data using current DB state — meaning changes to employee setup, salary, payroll items etc. AFTER the finalization date would retroactively change what appeared on a "finalized" historical payslip. This violated the core compliance requirement that finalized payslips must be immutable.

---

## Files Changed

### 1. `backend/modules/payroll/services/PayrollHistoryService.js`
**Change:** `formatForResponse()` now exposes `basic_salary` from `calculation_input`.

**Why:** The frontend `emp_historical_` KV format requires `basic_salary` to correctly display the frozen basic salary. The `calculation_output` does not include `basic_salary` (it is an input field). Without this, backend-synced snapshots would show `basic_salary: 0` in the payslip display even when the actual frozen salary was non-zero.

**Breaking risk:** None. New field added to an existing object — all existing callers are unaffected.

---

### 2. `backend/modules/payroll/routes/unlock.js`
**Change:** Added snapshot reset step BEFORE deleting KV keys.

```javascript
// NEW: Reset payroll_snapshots.is_locked = false, status = 'draft'
await supabase.from('payroll_snapshots')
  .update({ is_locked: false, status: 'draft' })
  .eq('company_id', companyId)
  .eq('employee_id', parseInt(empId))
  .eq('period_key', String(period))
  .eq('is_locked', true);
```

**Why:** Without this, after server-side unlock deletes the KV keys, the new `_syncSnapshotFromBackend()` function on the frontend would immediately re-read the still-locked backend snapshot and re-populate the KV keys on next page load — permanently undoing the unlock.

**Order matters:** DB reset FIRST, then KV delete. If DB fails → error returned, KV untouched. If KV delete fails → DB is already unlocked, which is the safe direction (next sync won't re-lock since `is_locked: false`).

**Breaking risk:** Low. Existing unlock flow still deletes KV keys as before. The only change is an additional DB update that previously didn't exist.

**Note — Limitation:** After an individual employee unlock, the `payroll_runs` record for the period remains `status: 'finalized'`. The `POST /api/payroll/run` endpoint blocks re-runs for finalized periods (period-level check). After correcting the employee's data post-unlock, the accountant must use the frontend `finalizePayslip()` flow (in `employee-detail.html`) to re-lock the KV state. A new batch re-run path for individual corrective runs in finalized periods is NOT yet implemented — tracked as follow-up (see below).

---

### 3. `frontend-payroll/employee-detail.html`

#### (a) NEW: `_syncSnapshotFromBackend()` async function
**Purpose:** Bridges the gap between backend `payroll_snapshots` DB records and the frontend KV store (`payroll_kv_store_eco` via `safeLocalStorage`).

**Logic:**
1. If `emp_historical_` KV key already exists → returns immediately (local data takes priority)
2. Calls `GET /api/payroll/calculate/history/{empId}/{period}` to read backend snapshot
3. If `is_locked: true` → maps `calculation_output` to `emp_historical_` format, writes both:
   - `emp_historical_{companyId}_{empId}_{period}` — frozen calculation data
   - `emp_payslip_status_{companyId}_{empId}_{period}` — `{ status: 'finalized', source: 'backend_snapshot', ... }`
4. Calls `updatePayslipUI()` + `renderPayroll()` to show the locked state
5. Idempotent — safe to call multiple times

**Key field:** `source: 'backend_snapshot'` in the status object. This marker is used by `updatePayslipUI()` and `unfinalizePayslip()` to distinguish batch-payrun-locked payslips from user-directly-finalized ones.

#### (b) CHANGED: `loadPayrollData()`
```javascript
renderPayroll();
updatePayslipUI();
// NEW: Fire-and-forget sync
_syncSnapshotFromBackend();
```
Called whenever the period select changes or on page load. The sync runs async — the UI shows "draft" briefly until the sync completes (< 1s), then updates to "locked" if a backend snapshot exists.

#### (c) CHANGED: `calculatePayslip()`
```javascript
// NEW: Safety net before live calculation
if (!frozen) {
    await _syncSnapshotFromBackend();
    frozen = safeLocalStorage.getItem(histKey);
}
```
Prevents the race condition where a user clicks "Calculate" before the fire-and-forget `loadPayrollData()` sync completes. The await here guarantees frozen data is used if available.

#### (d) CHANGED: `updatePayslipUI()`
```javascript
// WAS:
if (lockedRun && psStatus.status === 'finalized') { ... "Request Unlock" }

// NOW:
var isBackendLocked = psStatus.source === 'backend_snapshot';
if ((lockedRun || isBackendLocked) && psStatus.status === 'finalized') { ... "Request Unlock" }
```
Backend-snapshot-locked periods now show the "Request Unlock" button (manager auth required) instead of the free "Unfinalize" button.

#### (e) CHANGED: `unfinalizePayslip()`
```javascript
// NEW guard at top:
var ps = getPayslipStatus();
if (ps && ps.source === 'backend_snapshot') {
    requestManagerAuth();  // redirect to locked flow
    return;
}
```
Prevents accidental free-unfinalize of a batch-payrun-locked payslip.

#### (f) CHANGED: `verifyManagerAuth()` (success path)
```javascript
// NEW: after unlock succeeds, reload KV cache from server
if (typeof safeLocalStorage.reload === 'function') {
    await safeLocalStorage.reload();
}
loadPayrollData();
updatePayslipUI();
```
Critical: Without `safeLocalStorage.reload()`, the in-memory `_cache` in polyfills.js still has the `emp_historical_` and `emp_payslip_status_` keys even after the server deletes them from `payroll_kv_store_eco`. The reload forces a full re-read from the server, ensuring stale keys are cleared before the payslip re-renders as editable.

---

## Confirmed Working (Behaviours That Must NOT Regress)

- [x] Frontend `finalizePayslip()` flow (single employee, no batch run) — UNCHANGED: writes KV with `source: 'finalized'` (not 'backend_snapshot'), free Unfinalize still available
- [x] `unfinalizePayslip()` for user-directly-finalized payslips — UNCHANGED: only guarded for `source === 'backend_snapshot'`
- [x] `calculatePayslip()` reading from frozen KV — UNCHANGED: first check is still `safeLocalStorage.getItem(histKey)`
- [x] `getPayslipData()` reading from frozen KV — UNCHANGED: same first-check pattern, not modified (relies on `calculatePayslip()` having already populated the KV cache)
- [x] Live calculation for draft periods — UNCHANGED: only reached if KV cache is empty AND backend has no locked snapshot
- [x] KV sensitive key guard in `kv.js` — UNCHANGED
- [x] `payroll_snapshots` single-record-per-employee-period constraint — UNCHANGED (unlock resets to draft, not delete)

---

## What Was NOT Changed (And Why)

- **`payruns.html` batch finalization flow** — Does not write `emp_historical_` KV keys; still relies on the old frontend-only payruns list. `_syncSnapshotFromBackend()` handles the bridge retroactively. Not changed to avoid regression.
- **`GET /api/payroll/history` endpoint** — Still returns snapshots without `basic_salary`. Only the single-employee `/calculate/history/:id/:period` was the consumer needing `basic_salary`. The batch history list does not need it.
- **`POST /api/payroll/run`** period-level finalization block — Unchanged. Individual corrective re-runs in finalized periods require a follow-up workstream (see below).
- **`PayrollCalculationService.js`** — No changes; not involved in snapshot display.
- **`payruns.js` finalize endpoint** — No changes; locking logic correct as-is.
- **`transactions.js`, `recon.js`** — Read from live `payroll_transactions` / `payroll_period_inputs` tables. These are NOT involved in the historical payslip display — no changes needed.

---

## Testing Required

### Test 1: Batch payrun → employee-detail.html shows frozen data
1. Open company with employees
2. Run `POST /api/payroll/run` for period "2026-04" and employee E
3. Run `POST /api/payroll/finalize` for the run  
4. Open `employee-detail.html` for employee E, select period 2026-04
5. **Expected:** Page shows 🔒 Locked status with "Request Unlock" button within 1 second
6. Verify displayed gross/net/paye matches the batch run totals — NOT live recalculation

### Test 2: Locked payslip values are frozen after setup change
1. Open employee E for period 2026-04 (already finalized above) and note displayed gross
2. Change employee E's basic salary in employee-edit page
3. Come back to employee-detail.html for period 2026-04
4. **Expected:** Shows the SAME frozen gross as before the salary change

### Test 3: Manager unlock clears lock state correctly
1. Open locked payslip for employee E, period 2026-04
2. Click "Request Unlock", enter valid manager credentials
3. **Expected:** Payslip shows "Draft" state, "Finalize Payslip" button visible
4. Verify clicking calculate uses LIVE data (the new post-unlock salary)
5. Reload the page — **Expected:** still shows "Draft" (lock does not re-apply)

### Test 4: Frontend-only finalize still works
1. Open a NEW period (not in any batch run) for any employee
2. Enter basic salary, calculate
3. Click "Finalize Payslip"  
4. **Expected:** Shows "✅ Payslip finalized on ... by ..." with "↩ Unfinalize" button (NOT "Request Unlock")
5. Click "↩ Unfinalize" — **Expected:** Returns to Draft state without manager auth prompt

### Test 5: Race condition safety — Calculate without waiting for sync
1. Open employee E for a batch-finalized period 2026-04 on a slow connection
2. Within 1 second (before sync completes), click "Calculate"
3. **Expected:** `calculatePayslip()` awaits `_syncSnapshotFromBackend()` → returns frozen data

---

## Follow-Up Items (Not Implemented — Tracked)

```
FOLLOW-UP NOTE
- Area: Corrective re-run path for individual employees in finalized periods
- Dependency: payruns.js POST /run blocks the entire period when payroll_runs.status = 'finalized'
- What was done now: Unlock resets payroll_snapshots.is_locked = false, status = 'draft'
- What still needs to be checked: After individual unlock, how does the accountant create a
  corrected backend snapshot? Current options:
  (a) Frontend finalizePayslip() — re-locks the KV state (frontend record only, not a new DB snapshot)
  (b) A new endpoint: POST /api/payroll/run/corrective that allows single-employee re-run
      in a finalized period (bypasses the period-level finalized-run check)
- Risk if not checked: Corrected payslips after manager unlock are only in the KV store
  (frontend record), not in a new payroll_snapshots DB record. The backend audit trail
  would show the old draft snapshot (reset to draft by unlock) but no new final version.
- Recommended next review point: Before next compliance audit or IRP5 generation workstream
```

```
FOLLOW-UP NOTE
- Area: Employee identity not frozen in payslip snapshot
- Dependency: emp_historical_ KV format does not include employee_name, employee_number
- What was done now: Nothing — employee identity is served from live currentEmployee object
- What still needs to be checked: If employee's legal name changes (e.g. marriage), historical
  payslips for prior periods would show the new name. For IRP5 compliance this may not matter
  (tax numbers are the authoritative identity), but for printed payslips it could be confusing.
- Risk if not checked: Low for current use. Only a display issue — not a calculation integrity issue.
- Recommended next review point: Before implementing IRP5 generation or extended payslip history
```

---

## Deployment Notes

- No new DB migrations required for this workstream
- No environment variable changes  
- Frontend changes: `frontend-payroll/employee-detail.html` (deploy via Zeabur/Dockerfile as usual)
- Backend changes: `backend/modules/payroll/services/PayrollHistoryService.js` + `backend/modules/payroll/routes/unlock.js`

---

*Session: 2026-04-17 | Workstream: Snapshot Lock Integrity*
