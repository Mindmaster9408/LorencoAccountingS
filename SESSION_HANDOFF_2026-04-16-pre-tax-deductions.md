# SESSION HANDOFF — 2026-04-16
## Pre-Tax Deduction SARS Compliance (Migration 018)

**Status:** COMPLETE — all 7 implementation layers done, 10 tests passing.

---

## What Was Changed

### Layer 1 — Database Migration
**File:** `accounting-ecosystem/backend/migrations/018_pre_tax_deductions.sql`
- Adds `tax_treatment VARCHAR(20) NOT NULL DEFAULT 'net_only' CHECK (IN ('net_only','pre_tax'))` to `payroll_items_master`
- Adds same column to `payroll_items`
- Adds partial indexes on `(company_id, tax_treatment) WHERE item_type = 'deduction'`
- **Status:** MUST BE RUN IN SUPABASE BEFORE DEPLOYING** — run via the Supabase SQL editor or migration runner.

### Layer 2 — Backend Items Route
**File:** `accounting-ecosystem/backend/modules/payroll/routes/items.js`
- POST: accepts `tax_treatment`, validated against allowed values, stored only for deduction items
- PUT: supports updating `tax_treatment` with validation

### Layer 3 — Payroll Data Service
**File:** `accounting-ecosystem/backend/modules/payroll/services/PayrollDataService.js`
- `fetchRecurringPayrollItems`: selects `tax_treatment` from `payroll_items` join
- `fetchPeriodInputs`: selects `tax_treatment` from `payroll_items` join
- `normalizeCalculationInput`: maps `tax_treatment` onto `regularInputs` and `normalizedPeriodInputs`

### Layer 4 — Backend Engine (CRITICAL)
**File:** `accounting-ecosystem/backend/core/payroll-engine.js` — `calculateFromData()`
- Pre-tax deduction split calculated AFTER `gross` is captured (so UIF/SDL are unchanged)
- `taxableGross` reduced by `preTaxDeductions` before PAYE
- PAYE now correctly calculated on reduced `taxableGross`
- `deductions = preTaxDeductions + netOnlyDeductions` (backward-compatible net formula preserved)
- Two new additive output fields: `preTaxDeductions`, `netOnlyDeductions`

### Layer 5 — Frontend Engine (identical change)
**File:** `accounting-ecosystem/frontend-payroll/js/payroll-engine.js` — `calculateFromData()`
- Same change as backend engine, applied identically

### Layer 6 — Frontend UI
**File:** `accounting-ecosystem/frontend-payroll/payroll-items.html`
- `#taxTreatmentGroup` div with `<select id="taxTreatment">` added to modal form
- Visible only when item type = deduction (toggled by `updateTaxTreatmentVisibility(type)`)
- `openAddItemModal()`, `editStandardItem()`, `editItem()` all updated to show/hide group and set value
- `saveItem()` captures `tax_treatment` and stores it in item data
- `createItemCard()` shows a purple `PRE-TAX` badge for `pre_tax` deduction items

### Layer 7 — Frontend Helper
**File:** `accounting-ecosystem/frontend-payroll/js/payroll-items-helper.js`
- `enrichInput()` now includes `tax_treatment` in the returned input data
- Defaults to `'net_only'` for non-deduction items and for legacy items without the field

---

## Test Results

**File:** `accounting-ecosystem/tests/payroll-pre-tax-deductions.test.js`

```
PASS  tests/payroll-pre-tax-deductions.test.js
  √ T01: No deductions — gross equals basic salary, deductions zero
  √ T02: net_only deduction does NOT reduce taxableGross
  √ T03: pre_tax deduction reduces taxableGross and PAYE
  √ T04: mixed pre_tax and net_only deductions — correct split
  √ T05: pre_tax deduction exceeding taxableGross clamps to zero
  √ T06: missing tax_treatment on deduction defaults to net_only
  √ T07: pre_tax deduction in currentInputs reduces taxableGross
  √ T08: pre_tax deduction with taxable allowance present
  √ T09: all 13 locked output fields present after migration 018
  √ T10: net formula invariant holds for all deduction type combinations

Tests: 10 passed, 10 total
```

---

## What Was NOT Changed (Preserved)

- All 13 locked output fields from `calculateFromData` — no removals, no renames
- `gross` calculation position (captured before pre-tax reduction — UIF/SDL correct)
- `voluntary_overdeduction` logic — unchanged, still stacks on PAYE after pre-tax reduction
- `negativeNetPay` flag — still fires when net < 0
- Existing items in localStorage/DB without `tax_treatment` default to `'net_only'` — no regression
- `PayrollCalculationService.validateOutput` — not changed (checks 13 locked fields, no breakage)
- All other payroll engine functions (overtime, multi-rate, short-time, proration wrappers, YTD)

---

## Deployment Requirements

**CRITICAL:** Run migration `018_pre_tax_deductions.sql` in Supabase BEFORE server restart.

Without the migration:
- DB column `tax_treatment` does not exist → Supabase queries that select it will fail if `payroll_items` is queried with the new join
- Backend engine handles missing `tax_treatment` gracefully (defaults to `net_only`) — no crash
- Frontend localStorage items without `tax_treatment` also default to `net_only` — no crash

**Recommended deployment order:**
1. Run migration 018 in Supabase
2. Deploy backend (engine + routes + DataService changes active)
3. Deploy frontend files

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Payroll snapshots / IRP5 reporting
- Dependency: payroll_snapshots table stores calculation output
- Confirmed now: New output fields (preTaxDeductions, netOnlyDeductions) are additive —
  existing snapshot records are unaffected. New snapshots will include the new fields.
- Not yet confirmed: Whether IRP5 report generator reads taxableGross from the snapshot
  (it should) or recalculates it. If it recalculates, verify it uses the post-reduction
  taxableGross value from the snapshot (not a fresh recalculation on raw inputs).
- Risk if not checked: IRP5 certificates could show wrong taxable income if report reads
  stale/wrong taxableGross
- Recommended next check: Audit IRP5 report generator against snapshot field usage

FOLLOW-UP NOTE
- Area: YTD PAYE recalculation when pre-tax deductions change mid-year
- Dependency: calculateMonthlyPAYE_YTD uses ytdTaxableGross to smooth tax over the year
- Confirmed now: Engine passes reduced taxableGross to the YTD PAYE function — YTD is
  based on the correct post-deduction taxable income for each period
- Not yet confirmed: Whether ytdTaxableGross in snapshotted YTD data was captured
  before or after pre-tax reduction for already-processed periods (migration 018 is new,
  so all pre-existing snapshots had no pre-tax deductions → all net_only → no impact)
- Risk if not checked: Low risk for new periods; no risk for historical periods
- Recommended next check: Verify at end of first tax year that YTD PAYE reconciles cleanly

FOLLOW-UP NOTE
- Area: Payroll item master list sync (DB-backed vs localStorage)
- Dependency: Two item stores exist — payroll_items_master (DB) and localStorage payroll_items_{companyId}
- Confirmed now: Both stores now support tax_treatment. DB migration adds column to both tables.
  localStorage items gain tax_treatment via saveItem() in payroll-items.html.
- Not yet confirmed: Whether any existing sync/migration utility exists to push DB items
  to localStorage or vice versa. If such a utility exists, it must also pass tax_treatment.
- Recommended next check: Search for any sync/import utility that copies payroll_items
  from DB to localStorage and confirm it includes tax_treatment in the mapping.
```
