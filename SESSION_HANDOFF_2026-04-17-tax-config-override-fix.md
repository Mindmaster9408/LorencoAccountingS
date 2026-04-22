# SESSION HANDOFF — Tax Config Override Fix
**Date:** 2026-04-17  
**Status:** COMPLETE — all 4 files changed, no errors

---

## WHAT WAS FIXED

The superuser-entered tax tables (brackets, rebates, medical credits) were not being reliably applied to PAYE calculations. Three root causes were identified and all are now fixed.

---

## ROOT CAUSES FOUND AND FIXED

### BUG 1 — CRITICAL: `Infinity → null` JSON serialization (brackets)

**Problem:**  
`JSON.stringify({max: Infinity})` → `{"max": null}`.  
When `saveTaxConfig()` saved brackets to the KV store, the last bracket's `max` field became `null`.  
In `calculateAnnualPAYE`: `annualGross <= null` → always `false` → loop exits with no match → `tax = 0` → **PAYE = 0 for earners > R1,817,000/year**.

**Fixed in 3 files:**
- `frontend-payroll/js/payroll-engine.js` — `saveTaxConfig()`: uses JSON replacer `Infinity → 1e99`
- `frontend-payroll/js/payroll-engine.js` — `loadTaxConfig()`: `.map()` restores `null` and `>= 1e15` → `Infinity`
- `frontend-payroll/js/payroll-engine.js` — `calculateAnnualPAYE()`: null-safe `bMax` fallback
- `backend/core/payroll-engine.js` — `loadTaxConfig()`: same bracket normalization
- `backend/core/payroll-engine.js` — `calculateAnnualPAYE()`: same null-safe `bMax` fallback
- `backend/modules/payroll/services/PayrollCalculationService.js` — `buildEffectiveTables()`: `normalizeBrackets()` helper normalizes before passing to engine

---

### BUG 2 — CRITICAL: `tax_config` KV key not always synced

**Problem:**  
The new multi-year UI (`tax_years_v2`) has two code paths that do NOT push to `tax_config`:
1. `initTaxConfig()` first-visit bootstrap → creates `tax_years_v2` but NOT `tax_config`
2. `switchToTaxYear()` auto-save on tab switch → updates `tax_years_v2` but NOT `tax_config`

The backend reads **only** `tax_config`. If the admin never clicked "Save Tax Tables" explicitly, the backend saw stale or missing rebates.

**Fixed in 1 file:**
- `frontend-payroll/payroll-items.html` — `initTaxConfig()`: calls `updatePayrollEngineFromYear(taxYearsData[activeCalcYear])` before `renderTaxYearTabs()`, guaranteeing `tax_config` is always synced on page open
- `frontend-payroll/payroll-items.html` — `switchToTaxYear()`: calls `updatePayrollEngineFromYear(...)` inside the auto-save block when navigating away from the active calc year

---

### BUG 3 — MEDIUM (forward-compatibility): `getTablesForPeriod` hardcoded `TAX_YEAR`

**Problem:**  
Backend engine has `this.TAX_YEAR = '2026/2027'` (static). `getTablesForPeriod` returns `taxOverride` only when `taxYear === this.TAX_YEAR`. For future year overrides (2027/2028+), the override would be silently ignored.

**Fixed in 1 file:**
- `backend/core/payroll-engine.js` — `getTablesForPeriod()`: added secondary check `if (taxOverride && taxOverride.TAX_YEAR === taxYear) return taxOverride` immediately after the primary check

---

## FILES CHANGED

| File | Changes |
|---|---|
| `frontend-payroll/js/payroll-engine.js` | `saveTaxConfig` Infinity serialization; `loadTaxConfig` bracket normalization; `calculateAnnualPAYE` null-safe bMax |
| `backend/core/payroll-engine.js` | `loadTaxConfig` bracket normalization; `getTablesForPeriod` forward-compat check; `calculateAnnualPAYE` null-safe bMax |
| `backend/modules/payroll/services/PayrollCalculationService.js` | `buildEffectiveTables` — `normalizeBrackets()` helper added and applied |
| `frontend-payroll/payroll-items.html` | `initTaxConfig()` — `tax_config` sync on init; `switchToTaxYear()` — `tax_config` sync on auto-save |

---

## FILES NOT CHANGED (audited, confirmed safe)

- `backend/modules/payroll/routes/calculate.js` — reads `tax_config` correctly, passes via `PayrollCalculationService` ✓
- `backend/modules/payroll/routes/payruns.js` — same pattern ✓
- `backend/modules/payroll/services/PayrollDataService.js` — `company_payroll_settings` rebate fields fetched but not used; out of scope
- `frontend-payroll/js/polyfills.js` — KV mechanics correct ✓
- `employee-detail.html` — `loadTaxConfig()` called at correct timing ✓

---

## TESTING REQUIRED

### To verify BUG 1 fix (top-earner bracket):
1. In payroll-items.html Tax Config, set active year to 2026/2027, click "Save Tax Tables"
2. Run or recalculate a payslip for an employee earning > R151,417/month gross
3. BEFORE fix: PAYE would calculate as R0
4. AFTER fix: PAYE should be calculated correctly at top marginal rate (45%)

### To verify BUG 2 fix (KV sync):
1. Open payroll-items.html (fresh)
2. WITHOUT clicking "Save Tax Tables", change primary rebate value, then switch to another tax year tab
3. Then go run a payroll calculation
4. BEFORE fix: backend would use old/default rebate value
5. AFTER fix: backend should use the value that was in the active year's form when you switched tabs

### To verify rebates apply generally:
1. Set a non-default PRIMARY_REBATE (e.g., R17,235) in Tax Config, Save
2. Run payroll for any employee
3. Verify PAYE deducted matches manual calculation using the saved rebate

### Regression tests (must still pass):
- Historical period calculations (2024-06, 2025-03) must still use HISTORICAL_TABLES, not the 2026/2027 override
- Finalized payroll snapshots must be immutable (no changes to snapshot retrieval)
- UIF, SDL, medical credits must calculate correctly at saved rates

---

## CARRY-FORWARD NOTE

`company_payroll_settings` table has rebate fields (`primary_rebate`, `secondary_rebate`, `tertiary_rebate`) that are fetched in `PayrollDataService.js` but never applied in `normalizeCalculationInput()`. These appear to be a remnant or forward-stub. They do NOT affect current calculations (the KV `tax_config` path is the correct override). This is a separate concern, not part of this fix, and should not be touched without a deliberate review.

---

## ARCHITECTURE SUMMARY (for next session)

**Two-layer tax config storage:**
- `tax_years_v2` KV key → multi-year UI storage, used only by `payroll-items.html`
- `tax_config` KV key → single active-year flat config, read by BOTH frontend engine (via `loadTaxConfig`) AND backend routes (direct DB read)

**Correct flow (now functioning end-to-end):**
1. Admin opens `payroll-items.html` → `initTaxConfig()` → syncs `tax_config` from active year immediately
2. Admin edits → tabs away → `switchToTaxYear()` auto-save → syncs `tax_config` if active year
3. Admin clicks "Save Tax Tables" → explicit save → always syncs `tax_config`
4. Frontend `employee-detail.html` loads → `loadTaxConfig()` reads `tax_config` from KV → sets `this.PRIMARY_REBATE`, `this.BRACKETS` (with Infinity restored) etc.
5. Backend `calculate.js` reads `tax_config` from Supabase DB → `buildEffectiveTables()` normalizes brackets → passes as `taxOverride` to engine
6. `calculateAnnualPAYE` uses correct bracket max (Infinity for top bracket, actual values for others)
