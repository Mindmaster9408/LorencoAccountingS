# SESSION HANDOFF — 2026-05-07
## Payroll Snapshot Immutability Fix

---

## WHAT WAS FIXED

**Critical bug:** Finalized payroll periods were not staying truly frozen.

**Symptom:** March payroll finalized at R6,023 basic salary. After April salary was changed to R6,323, the March payslip (in `employee-detail.html`) displayed R6,323 instead of the frozen R6,023. Execute Payroll history snapshots also grouped incorrectly due to a missing field.

**Business rule enforced:** FINALIZED MEANS FROZEN — basic salary, allowances, deductions, UIF/PAYE/SDL/net must all remain at their finalized values forever after finalization.

---

## ROOT CAUSES IDENTIFIED

### Root Cause 1 — Cross-period localStorage key
`getPayrollKey()` returns `emp_payroll_{company}_{empId}` — no period component. Any salary edit (e.g., April) overwrites the same key used for all periods. When March is opened, `payrollData.basic_salary` reads R6,323 (April's value). This is architectural and cannot be "fixed" in the key itself. The fix is: never use `payrollData.basic_salary` as the salary source for finalized periods.

### Root Cause 2 — `getPayslipData()` ignored the period-specific localStorage snapshot
The old individual-finalize flow (button in `employee-detail.html`) wrote frozen snapshots under `emp_historical_{company}_{empId}_{period}` — a period-specific key. `getPayslipData()` was not reading this key at all. It jumped straight from `_snapshotBasicSalary` (only set for Execute Payroll-finalized employees) to `payrollData.basic_salary` (cross-period wrong value). Employees finalized via the old individual button had no protection.

### Root Cause 3 — No `_isLockedSnapshot` / `_snapshotLineItems` markers
`calculatePayslip()` received the locked snapshot from the backend but did not propagate the frozen line items (allowances/deductions) into the calculation context. `getPayslipData()` therefore used `payrollData.regular_inputs` (live current DB items) for frozen periods — meaning any post-finalization item changes leaked into historical payslip display.

### Root Cause 4 — UIF recalculated from current (live) allowances for all periods
`getPayslipData()` recalculated UIF from current allowances unconditionally, overriding the frozen UIF stored in finalized snapshots.

### Root Cause 5 — `payroll_run_id` missing from `formatForResponse()`
`PayrollHistoryService.formatForResponse()` did not include `payroll_run_id` in its return object. `payroll-execution.html` groups history snapshots by `snap.payroll_run_id`, so all snapshots fell into the `'no-run'` bucket.

---

## WHAT WAS NOT ROOT CAUSE (CONFIRMED CORRECT — DO NOT TOUCH)

- **`backend/modules/payroll/routes/calculate.js`**: Snapshot guard at lines 140-152 correctly returns the locked snapshot without recalculating for finalized periods. **No changes made.**
- **`backend/modules/payroll/routes/payruns.js`**: Finalized employee guard at line 236-244 skips already-locked employees. **No changes made.**
- **`backend/modules/payroll/services/PayrollDataService.js`**: `fetchCalculationInputs()` reads live `employees.basic_salary` correctly — this is only reached for DRAFT periods because locked periods return early via the snapshot guard. **No changes made.**
- **`frontend-payroll/payroll-execution.html`**: `openPayslipPreview(snap)` already reads from `snap.basic_salary` (frozen snapshot). **No changes made.**

---

## FILES CHANGED

### 1. `accounting-ecosystem/frontend-payroll/employee-detail.html` — 4 targeted edits

**Edit 1 — `calculatePayslip()` function (~line 2854): Store locked-snapshot markers on calc object**

After the existing `_snapshotBasicSalary` assignment, added:
```javascript
if (calc && calcResult.data.locked) {
    calc._isLockedSnapshot = true;
}
if (calc && calcResult.data.snapshot && Array.isArray(calcResult.data.snapshot.payslip_line_items)) {
    calc._snapshotLineItems = calcResult.data.snapshot.payslip_line_items;
}
```
Purpose: Propagates the frozen line items from the DB locked snapshot through to `getPayslipData()` so live items are never used for finalized periods.

---

**Edit 2 — `calculatePayslip()` function (~line 2929): Correct basic salary display after backend result**

After `_lastBackendCalc = calc`, added:
```javascript
if (calc && calc._isLockedSnapshot && calc._snapshotBasicSalary != null) {
    var _bsEl = document.getElementById('basicSalary');
    if (_bsEl) _bsEl.textContent = formatMoney(calc._snapshotBasicSalary);
}
```
Purpose: `renderPayroll()` runs before `calculatePayslip()` and has no locked-snapshot knowledge — it uses `payrollData.basic_salary` (cross-period, wrong). This correction fires after the backend result arrives and patches the displayed value to the frozen salary.

---

**Edit 3 — `getPayslipData()` function (~lines 2959-3029): 3-tier fallback chain**

Replaced the previous 2-tier fallback (DB snapshot → cross-period live) with a proper 3-tier chain:

```
Tier 1: backedCalc._snapshotBasicSalary       — DB locked snapshot (Execute Payroll finalized)
Tier 2: emp_historical_{co}_{emp}_{period}     — Old localStorage snapshot (individual finalize)
Tier 3: payrollData.basic_salary               — Live value (draft periods ONLY)
```

Applied the same 3-way branch to allowances and deductionsList:
- DB locked snapshot → use `backedCalc._snapshotLineItems` (frozen)
- Old localStorage snapshot → use stored frozen allowances/deductions
- Draft / no snapshot → use current live items

Purpose: The primary fix for the reported bug. Both finalization paths are now covered. Draft payroll still uses live data normally.

---

**Edit 4 — `getPayslipData()` function (~line 3094): Guard UIF recalculation for frozen periods**

```javascript
var _isFrozenPeriod = !!(backedCalc && backedCalc._isLockedSnapshot) || !!_frozenLocalSnap;
if ((calc.uif || 0) > 0 && !_isFrozenPeriod) {
    // UIF recalculation only for draft periods
}
```
Purpose: UIF was being recalculated from current allowances for all periods, overriding the correct frozen UIF in finalized snapshots.

---

### 2. `accounting-ecosystem/backend/modules/payroll/services/PayrollHistoryService.js` — 1 edit

**`formatForResponse()` — added `payroll_run_id` to return object:**
```javascript
payroll_run_id: snapshot.payroll_run_id || null,
```
Purpose: Without this, `payroll-execution.html` grouped all history snapshots under `'no-run'` because it reads `snap.payroll_run_id` for grouping.

---

## TESTING REQUIRED

All 7 scenarios below must be verified before considering this fix complete.

| # | Test | Expected Result |
|---|------|----------------|
| T1 | Open March payslip after April salary change | March shows R6,023 (frozen), not R6,323 |
| T2 | Execute Payroll history — March rows | Show R6,023, grouped under correct payroll run |
| T3 | Open April payslip | Shows R6,323 (new value correct for April) |
| T4 | Change overtime/allowance after March finalized, open March payslip | March shows original frozen overtime/allowance amounts |
| T5 | Change PAYE tax table after March finalized, open March payslip | March shows original PAYE/net, not recalculated |
| T6 | Backend calculate call for finalized March | Backend returns locked snapshot, does NOT recalculate |
| T7 | localStorage state | No finalized payroll data sourced purely from localStorage cross-period key |

**Test coverage note:** T6 and T7 are observable via browser devtools network tab and Application → Local Storage. T1-T5 are UI-visible.

---

## OPEN RISKS AND FOLLOW-UP NOTES

### FOLLOW-UP NOTE 1 — DB-level immutability enforcement
```
FOLLOW-UP NOTE
- Area: payroll_snapshots table
- Dependency: Supabase PostgreSQL
- What was done now: Application-layer guards (backend calculate.js + payruns.js) prevent recalculation/overwrite of locked snapshots
- What still needs to be checked: No database-level trigger exists to prevent UPDATE of payroll_snapshots WHERE is_locked = true
- Risk if not checked: A future code path that bypasses the application guard (e.g., a direct DB query, a new route, or a migration) could silently corrupt locked snapshots
- Recommended next review point: Before any payroll schema migration or any new payroll route is added
```
Recommended fix: Add a PostgreSQL trigger:
```sql
CREATE OR REPLACE FUNCTION prevent_locked_snapshot_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_locked = TRUE THEN
    RAISE EXCEPTION 'Cannot modify a locked payroll snapshot (id: %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_snapshot_immutability
BEFORE UPDATE ON payroll_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_locked_snapshot_update();
```

### FOLLOW-UP NOTE 2 — Old individual-finalize path (localStorage)
```
FOLLOW-UP NOTE
- Area: employee-detail.html — finalizePayslip() function
- Dependency: emp_historical_{company}_{empId}_{period} localStorage key
- What was done now: getPayslipData() now reads this key as the Tier 2 fallback
- What still needs to be checked: This localStorage key is device/browser-specific. An employee finalized on Machine A has no frozen snapshot on Machine B (unless they also used Execute Payroll which writes to DB)
- Risk if not checked: Users on different devices viewing old individually-finalized payslips will fall through to Tier 3 (live data) — incorrect for frozen periods
- Recommended next review point: When the old individual-finalize flow is deprecated in favour of Execute Payroll DB snapshots for all employees
```

### FOLLOW-UP NOTE 3 — UIF cap constant
```
FOLLOW-UP NOTE
- Area: getPayslipData() UIF recalculation block
- Dependency: South African UIF statutory ceiling
- What was done now: UIF recalculation guarded to draft periods only; frozen UIF used for finalized periods
- What still needs to be checked: The UIF ceiling constant used in draft recalculation — confirm it is updated whenever SARS/UIF publishes a new ceiling
- Risk if not checked: Draft payroll UIF calculations may be incorrect after a statutory change
- Recommended next review point: Annual SARS compliance review
```

---

## WHAT WAS CONFIRMED WORKING BEFORE THIS SESSION

(Do not regress these — from WORKING_FEATURES_REGISTRY.md context)

- Execute Payroll run → finalize flow writes correct locked snapshots to DB
- `payroll-execution.html` snapshot preview reads from frozen snapshot (not live data)
- Backend calculate endpoint returns locked snapshot for finalized periods without recalculating
- Multi-tenant company_id scoping on all payroll DB queries
- PAYE, UIF, SDL calculation logic in `PayrollCalculationService.js`

---

*Session engineer: Claude (Principal Engineer role per CLAUDE.md)*  
*Date: 2026-05-07*  
*Related sessions: Previous session (context limit reached mid-task)*
