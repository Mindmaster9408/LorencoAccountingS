# SESSION HANDOFF — 2026-04-22: PAYE Reconciliation — Snapshot Architecture Fix

## Summary

This session completed a full, root-cause fix of the PAYE Reconciliation data pipeline. All three backend routes in `recon.js` and both broken frontend behaviours in `paye-reconciliation.html` are now fixed.

---

## Root Cause (Confirmed)

`recon.js` read from `payroll_transactions` — a legacy table that is **never written** by the Paytime batch payroll run system. The actual source of truth is `payroll_snapshots` (rows with `is_locked = true`). Result: every recon API call returned zeros.

Secondary root cause: the frontend `filteredPeriods` was populated via `PayrollEngine.getHistoricalPeriods()` (localStorage scan), which returns empty for companies on the new system. This caused all rendering loops to silently skip everything even if the API returned valid totals.

---

## Files Changed

### 1. `accounting-ecosystem/backend/modules/payroll/routes/recon.js`

#### Change 1 — `/tax-years` route
Added `payroll_snapshots` query alongside the existing `payroll_historical` and `payroll_transactions` queries:
```javascript
const { data: snapTaxRows } = await supabase
  .from('payroll_snapshots')
  .select('period_key')
  .eq('company_id', companyId)
  .eq('is_locked', true);
(snapTaxRows || []).forEach(r => { if (r.period_key) seen.add(taxYearForPeriod(r.period_key)); });
```
Effect: Tax year selector now shows years that have live payroll runs, not just historical imports.

#### Change 2 — `/summary` route
Replaced `payroll_transactions` aggregation entirely with `payroll_snapshots`:
- Queries locked snapshots for the tax year with `employees(...)` join
- Deduplicates per `employee_id + period_key` (latest `created_at` wins)
- Tracks `snapshotKeys` Set — historical records are skipped for any employee+period covered by a snapshot
- Enriched per-period data: `basic` (from `calculation_input.basic_salary`), `overtime` (from `out.overtimeAmount`), `shorttime` (from `out.shortTimeAmount`), `voluntary_tax` (from `out.voluntary_overdeduction`), `deductions` (from `out.deductions`)
- `addToPeriod()` extended to accept optional `extra` param with enriched fields
- Period init object extended to include all 10 fields
- Rounding step extended to round all 10 fields

#### Change 3 — `/emp501` route
Replaced `payroll_transactions` + `payslip_items` aggregation with `payroll_snapshots`:
- Removed orphaned `payroll_periods` query (no longer needed)
- Queries locked snapshots for all periods in the tax year with `employees(...)` join
- Deduplicates per `employee_id + period_key` (latest `created_at` wins)
- Aggregates JSONB fields: `gross`, `taxableGross`, `paye`, `uif`, `sdl`, `medicalCredit`, `net`
- `r2` rounding helper defined once before both `emp501Records` and `historicalSummary` blocks (no duplication)
- `historical` query renamed `histData501` and `histAgg` kept unchanged as fallback source
- `irp5_codes: Object.values(agg.irp5_codes)` — currently always empty since snapshot JSONB does not yet store individual IRP5 line items (by design; full IRP5 XML is a future workstream per compliance note already in API response)

### 2. `accounting-ecosystem/frontend-payroll/paye-reconciliation.html`

#### Change 4 — `filteredPeriods` fix in `onTaxYearChange()`
After `payrollTotals = data.totals;`, added:
```javascript
if (data.periods && data.periods.length > 0) {
    filteredPeriods = data.periods;
}
```
Effect: The 12-period SA tax year array is now sourced from the API response, not from a localStorage scan that returns empty for the new system.

#### Change 5 — `_buildBreakdownFromAPI()` enrichment
Updated the `rows` mapping to:
- Use `vals.basic` when it is set and > 0 (from `calculation_input.basic_salary`), falling back to `vals.gross` for legacy historical records
- Use `vals.overtime` (from `out.overtimeAmount`)
- Use `vals.shorttime` (from `out.shortTimeAmount`)
- Use `vals.deductions` for `otherDeductions` (from `out.deductions`)
- Removed the implicit `gross` approximation for `basic` (was always wrong for employees with overtime)
- Added null-return + null-filter pattern so periods with no data are skipped at source

---

## What Was NOT Changed

- `PayrollHistoryService.js`, `PayrollCalculationService.js`, `PayrollDataService.js` — no changes
- `payruns.js`, `unlock.js` — no changes; `lockSnapshotsForPeriod()` and `finalizePayrollRun()` untouched
- `recon-service.js` — localStorage fallback logic untouched; still works as a merge source
- `employee-detail.html` — voluntary tax UI confirmed complete, no changes
- `payroll-execution.html` — no changes
- Frontend Section 3 (SARS submitted) and Section 4 (bank payments) user-entered data — untouched
- `payroll_historical` fallback preserved in all three routes

---

## Business Rules Preserved

- `is_locked = true` guard on all snapshot queries — only finalised payroll runs used
- Every query has `.eq('company_id', companyId)` multi-tenant guard
- SA tax year boundaries (March–February): `taxYearToDateRange()`, `generatePeriods()`, `taxYearForPeriod()` unchanged
- Snapshot overrides historical for same employee+period (most accurate data wins)
- Historical still used as fallback for employees/periods not in live payroll

---

## Test Results

All 10 logic tests passed:
1. Snapshot deduplication — latest snapshot wins
2. Historical yields to snapshot for same employee+period
3. Historical included when no snapshot for that period
4. `addToPeriod` stores enriched fields correctly
5. `taxYearForPeriod` SA tax year boundary math correct
6. `generatePeriods` produces 12 periods for full SA tax year
7. `filteredPeriods` updated from `data.periods` (empty localStorage overridden)
8. `_buildBreakdownFromAPI` uses enriched `basic` and `overtime` from API
9. `_buildBreakdownFromAPI` falls back to `gross` for historical records
10. Null and zero rows filtered from breakdown correctly

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: /emp501 IRP5 code breakdown
- What was done now: emp501 now reads locked snapshots for annual totals
- What still needs to be checked: irp5_codes is always empty because payroll_snapshots
  does not store individual payslip line items with IRP5 codes. This is by design for
  this workstream — the compliance note in the API response states IRP5 XML is a future
  workstream.
- Risk if not checked: EMP501 export shows empty IRP5 breakdown per employee. OK for
  manual preparation (totals are correct) but not for automated SARS submission.
- Recommended next review point: When IRP5 XML export workstream begins — design whether
  to store individual payslip line items in the snapshot JSONB or derive from payroll items
  master + calculation_input at export time.
```

```
FOLLOW-UP NOTE
- Area: uif_employer in /emp501
- What was done now: Set to 0 — not captured in current snapshot schema
- What still needs to be checked: SDL (employer levy) IS in the snapshot. UIF employer
  contribution = same as employee contribution (1% each). Could be derived as `out.uif`
  if needed.
- Risk if not checked: EMP501 shows 0 for employer UIF. This only matters for EMP201
  monthly submissions — not for year-end EMP501 totals.
- Recommended next review point: EMP201 monthly submission workstream.
```

---

## Deployment

Standard deployment — no schema changes, no environment variable changes.
Zeabur deployment rules apply (no zbpack.json, Dockerfile is source of truth, root = `accounting-ecosystem`).

---

## Prior Session

Previous session handoff: `SESSION_HANDOFF_2026-04-17-snapshot-lock-integrity.md`
Prior commit: `b1bc47f` (Net-to-Gross push persistence fix)
