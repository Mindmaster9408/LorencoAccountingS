# SESSION HANDOFF — 2026-04-23 — Payslip Screen Backend Alignment

## Root Cause Fixed

The payslip screen used the **frontend `PayrollEngine`** (hardcoded tax tables in `js/payroll-engine.js`) for all calculations, while Execute Payroll used the **backend engine** (`backend/core/payroll-engine.js`) with tax tables read from the Supabase KV `tax_config` key. This caused PAYE to differ between the two screens for the same employee and period.

Three mismatch dimensions resolved:
1. **Tax tables**: frontend hardcoded `PRIMARY_REBATE: 17235` vs. backend KV-configured value
2. **Calculation engine**: browser JS vs. Node.js backend engine
3. **Input source**: KV blobs vs. `payroll_period_inputs` / `employee_payroll_items` DB tables

## Files Changed

### `accounting-ecosystem/frontend-payroll/js/payroll-api.js`
- Added `calculate(employeeId, periodKey)` method → `POST /api/payroll/calculate`

### `accounting-ecosystem/frontend-payroll/employee-detail.html`
- Added module-level `var _lastBackendCalc = null` — caches last backend result for synchronous `getPayslipData()`
- Added `_lastBackendCalc = null` reset in `loadPayrollData()` when period changes
- **`calculatePayslip()`** (line ~2453) — FULLY REPLACED:
  - Removed: frozen KV snapshot branch (`emp_historical_...`) — it contained wrong frontend-engine values
  - Removed: `PayrollEngine.calculateFromData()` call
  - Added: Step 1 — `PayrollAPI.getEmployeePeriodHistory()` → `snapshot.calculation_output`
  - Added: Step 2 — `PayrollAPI.calculate()` → `snapshot.calculation_output` (falls back to `data`)
  - Sets `_lastBackendCalc = calc` before returning
  - Passes `calc` (full backend object) as 6th param to `generateNarrative()`
- **`getPayslipData()`** — REPLACED:
  - Numbers come from `_lastBackendCalc` (backend values)
  - Itemized `allowances[]` and `deductionsList[]` still built from KV (display-only for PDF)
  - Fallback to frozen KV blob only if `_lastBackendCalc` is null (user hasn't clicked Calculate yet)
- **`calculatePeriodSilent(period)`** — REPLACED:
  - Uses `PayrollAPI.getEmployeePeriodHistory()` for previous-period narrative comparison
  - Returns `null` if no backend snapshot exists (narrative skips comparison gracefully)
- **`generateNarrative(gross, paye, uif, deductions, net, fullCalc)`** — UPDATED:
  - Added `fullCalc` 6th parameter
  - Merges `fullCalc` into `currentCalc` so narrative-generator.js receives `primary_rebate_annual`, `marginal_rate`, `tax_year`, etc.
  - `overtimeAmount` still falls back to KV calculation if backend didn't return it

## What Was NOT Changed

- `loadPayrollData()`, `savePayrollData()`, `saveCurrentInput()`, `saveOvertime()` — input entry, out of scope
- `finalizePayslip()` — unchanged structurally; it calls `calculatePayslip()` (now fixed) so frozen snapshot written to KV will contain correct backend values going forward
- `unfinalizePayslip()` — unchanged
- `isPayrunLockedForPeriod()` — unchanged
- All backend files — they were already correct
- Execute Payroll page — untouched

## API Response Shapes (confirmed)

- `GET /api/payroll/calculate/history/:emp/:period`
  → `{ success, snapshot: { calculation_output: {...all fields...}, is_locked, ... }, timestamp }`
  
- `POST /api/payroll/calculate`
  → `{ success, data: {...13 locked fields...}, snapshot: { calculation_output: {...all fields...} }, locked?, timestamp }`
  - For locked period: same shape, `locked: true`
  - `snapshot.calculation_output` includes display fields: `primary_rebate_annual`, `secondary_rebate_annual`, `tertiary_rebate_annual`, `uif_monthly_cap`, `marginal_rate`, `marginal_bracket`, `tax_year`

## Testing Required

1. Open employee-detail.html for an employee, select a period that has been run via Execute Payroll
2. Click "Calculate Payslip"
3. Verify: PAYE in payslip summary matches PAYE shown in payroll-execution.html for same period
4. Click "View Payslip" → PDF preview should show same PAYE
5. Click "Download PDF" → same PAYE
6. Finalize payslip → status bar shows finalized; values should still match
7. Unfinalize → returns to draft; click Calculate → still matches backend
8. Change period to one NOT yet run → should still calculate via POST /calculate (backend engine)
9. Check narrative card appears and doesn't error

## Known Limitation / Follow-Up

- Old `emp_historical_...` KV blobs written BEFORE this fix contain wrong frontend-engine values.
  These are used as a last-resort fallback in `getPayslipData()` only when `_lastBackendCalc` is null.
  After the user clicks "Calculate Payslip" once per session per period, the correct value is used.
  The old blobs do NOT affect the payslip summary panel (which now always calls the backend).
  The old blobs will gradually become irrelevant as payslips are recalculated.
  A one-time migration to clear old `emp_historical_...` KV blobs could be done via admin script if needed.

## Commit Recommendation

```
feat(payroll): align payslip screen to backend engine — fix PAYE mismatch

Replace frontend PayrollEngine calls in calculatePayslip(), getPayslipData(),
and calculatePeriodSilent() with backend API calls. Payslip screen now uses
the identical calculation engine and tax_config as Execute Payroll, eliminating
PAYE differences between the two screens.

Files: frontend-payroll/employee-detail.html, frontend-payroll/js/payroll-api.js
```
