# Paytime — Calculation Engine and Tax Reference

> Last updated: 2026-04-29  
> Audited from source: `backend/core/payroll-engine.js`, `PayrollCalculationService.js`, `PayrollDataService.js`

---

## 1. Engine Location and Authority

The canonical payroll calculation engine is:

```
accounting-ecosystem/backend/core/payroll-engine.js
```

**Engine Version:** `2026-04-12-v1`  
**Schema Version:** `1.0`

This is the **sole authoritative source** for all PAYE, UIF, and SDL calculations in the ecosystem. No other file may override, duplicate, or supersede it. The frontend mirror at `frontend-payroll/js/payroll-engine.js` is for UI preview only — it has no authority over stored values.

---

## 2. Engine Entry Points

The engine exposes two calculation functions:

### `PayrollEngine.calculateFromData(employee, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, taxOverride)`

Standard full-month calculation. Used when the employee works the full period with no proration needed.

### `PayrollEngine.calculateWithProRata(employee, startDate, endDate, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, taxOverride)`

Pro-rata calculation. Used when the employee started or terminated mid-period. The engine calculates working days in period vs actual working days for the employee's date range, then scales basic salary accordingly.

### `PayrollEngine.calculateNetToGross({ targetNet, items, employeeOptions, period, taxOverride, basicSalaryHi })`

Reverse calculation. Uses binary search (bisection) over basic salary space until `calculateFromData()` produces a net that matches the target within R0.01. Typically converges in 30–50 iterations. Returns `{ success, basic, result, iterations }`.

---

## 3. Engine Output Contract

The output is an object with the following named fields. **These fields are immutable — they must never be removed or renamed. New fields may only be appended after the last field.**

| Field | Type | Description |
|---|---|---|
| `gross` | number | Total earnings (taxable + non-taxable allowances) |
| `taxableGross` | number | Portion of gross subject to PAYE |
| `paye` | number | PAYE withheld (base + voluntary over-deduction) |
| `paye_base` | number | PAYE before any voluntary top-up |
| `voluntary_overdeduction` | number | Extra PAYE withheld at employee request (bonus-linked or fixed) |
| `uif` | number | UIF contribution (employee share only) |
| `sdl` | number | Skills Development Levy |
| `deductions` | number | Non-tax deductions (medical aid, pension, garnishee, etc.) |
| `net` | number | Take-home pay: gross − paye − uif − deductions |
| `negativeNetPay` | boolean | true if net < 0 (edge case: excessive deductions) |
| `medicalCredit` | number | Monthly medical tax credit (Section 6A/6B) |
| `overtimeAmount` | number | Overtime earnings component |
| `shortTimeAmount` | number | Short-time deduction component (negative impact on gross) |
| `preTaxDeductions` | number | Pre-PAYE deductions (pension, RA) — reduce taxableGross |
| `netOnlyDeductions` | number | Net-only deductions (medical aid, garnishee) — reduce net only |
| `periodicTaxableGross` | number | Recurring taxable gross (annualised × 12) |
| `onceOffTaxableGross` | number | Once-off taxable gross (never annualised) |
| `taxBeforeRebate` | number | Bracket tax before age rebates are applied |
| `rebate` | number | Total monthly age rebate (primary + secondary + tertiary) |
| `primary_rebate_annual` | number | Annual primary rebate from active tax tables |
| `secondary_rebate_annual` | number | Annual secondary rebate (age ≥ 65) |
| `tertiary_rebate_annual` | number | Annual tertiary rebate (age ≥ 75) |
| `uif_monthly_cap` | number | UIF monthly cap from active tax tables |
| `marginal_rate` | string | e.g. `"26%"` |
| `marginal_bracket` | string | e.g. `"R237,101 - R370,500"` |
| `tax_year` | string | Active tax year e.g. `"2026/2027"` |

**Additional fields added by `PayrollCalculationService`:**

| Field | Notes |
|---|---|
| `_meta.calculatedAt` | ISO-8601 timestamp |
| `_meta.engineVersion` | Engine version string |
| `_meta.schemaVersion` | Schema version string |
| `_meta.calculationMethod` | `"standard"` or `"prorata"` |
| `_meta.startDate` | Pro-rata start date (if applicable) |
| `_meta.endDate` | Pro-rata end date (if applicable) |
| `_meta.resolvedTaxYear` | SA tax year resolved from period key |

---

## 4. Tax Tables

### Default Tables (2026/2027)

Hardcoded in `payroll-engine.js`. Used as fallback when no KV override is set.

**Brackets:**

| Min (R) | Max (R) | Base Tax (R) | Marginal Rate |
|---|---|---|---|
| 0 | 237,100 | 0 | 18% |
| 237,101 | 370,500 | 42,678 | 26% |
| 370,501 | 512,800 | 77,362 | 31% |
| 512,801 | 673,000 | 121,475 | 36% |
| 673,001 | 857,900 | 179,147 | 39% |
| 857,901 | 1,817,000 | 251,258 | 41% |
| 1,817,001 | ∞ | 644,489 | 45% |

**Rebates:**
- Primary: R17,235/year (all taxpayers)
- Secondary: R9,444/year (age ≥ 65)
- Tertiary: R3,145/year (age ≥ 75)

**Levies:**
- UIF rate: 1% (employee only)
- UIF monthly cap: R177.12
- SDL rate: 1% of gross
- Hourly divisor: 173.33 hrs/month

**Medical Tax Credits (Section 6A/6B):**
- Main member: R364/month
- First dependent: R364/month
- Additional dependents: R246/month each

### Historical Tables

The engine contains hardcoded historical tables for SA tax years from 2021/2022 through 2025/2026. When calculating for a period in a prior tax year, the engine automatically selects the correct historical table using `getTaxYearForPeriod(periodKey)`.

SA tax year mapping: March to February. Period `2023-07` → tax year `2023/2024`.

### Admin Override (Current Year)

Super-admins at Infinite Legacy can override the current year's tax tables via the Tax Configuration panel. The override is stored in KV store (`tax_config` key, `__global__` company) and loaded by `PayrollCalculationService.buildEffectiveTables()` before each calculation.

The override affects ONLY the current SA tax year. Historical calculations always use the hardcoded `HISTORICAL_TABLES`.

**How to update tax tables annually (every 1 March):**
1. Navigate to Payroll Items → Tax Configuration (super-admin only)
2. Enter the new brackets, rebates, and levy rates from SARS budget announcement
3. Save — tables are stored in Supabase and override the engine defaults immediately
4. Verify by running a test calculation
5. If code defaults also need updating: edit `BRACKETS` and `PRIMARY_REBATE` etc. in `payroll-engine.js` and update `TAX_YEAR` constant

---

## 5. Input Assembly — PayrollDataService

`PayrollDataService.fetchCalculationInputs(companyId, employeeId, periodKey, supabase)` assembles all engine inputs from the database. The normalized output structure:

```javascript
{
  // Core
  basic_salary: number,              // From employees.basic_salary (or KV fallback)
  regular_inputs: Array,             // Recurring payroll items (commission, allowances, etc.)
  workSchedule: Array,               // [{ day, enabled, type, partial_hours }]
  hours_per_day: number,             // Decimal (e.g. 8, 7.5)

  // Pro-Rata Context
  start_date: string|null,           // Employee hire_date → start_date
  end_date: string|null,             // Employee termination_date

  // Period Boundaries
  period_start_date: string|null,
  period_end_date: string|null,

  // Period-Specific Items
  currentInputs: Array,              // One-off period items (payroll_period_inputs)
  overtime: Array,                   // [{ hours, rate_multiplier }]
  shortTime: Array,                  // [{ hours_missed }]
  multiRate: Array,                  // [{ hours, rate_multiplier }]

  // Employee Options for Tax Calc
  employeeOptions: {
    age: number|null,                // Calculated from dob at tax year end date (SARS rule)
    medicalMembers: number,          // Count of medical aid dependents
    taxDirective: number|null,       // Fixed tax rate or null
    rebateCode: string,              // 'R' = resident (default)
    is_director: boolean,            // Directors exempt from UIF
    sdl_registered: boolean,         // Company SDL registration flag
    uif_registered: boolean          // Company UIF registration flag
  },

  // Period Key
  period: string,                    // 'YYYY-MM' — used by engine for tax year resolution
  ytdData: null                      // YTD data for cumulative tax method (not yet in use)
}
```

### Age Calculation Rule

Age is calculated at the END of the SA tax year (28/29 February), not at today's date. This is the SARS-required reference point for rebate tier determination. An employee who turns 65 on 15 January within the tax year gets the secondary rebate for the full year.

If `dob` is not stored but a South African ID number exists, age is derived from the ID: `PayrollEngine.getAgeFromId(idNumber, taxYearEndDate)`.

### KV Store Fallback for basic_salary (DEPRECATED PATH)

If `employees.basic_salary` is null or missing, `PayrollDataService` falls back to the KV store key `emp_payroll_{companyId}_{employeeId}`. This path exists for backward compatibility with employees created before the April 2026 schema migration. It is a best-effort fallback — a missing KV entry is not an error.

**New employees created after April 2026 must have `basic_salary` set on the `employees` row.** The KV fallback path will eventually be removed.

---

## 6. Pre-Tax vs Net-Only Deductions

Payroll items carry a `tax_treatment` field:

| Value | Effect |
|---|---|
| `pre_tax` | Deduction reduces `taxableGross` before PAYE is calculated (pension fund, retirement annuity) |
| `net_only` | Deduction does not affect PAYE; reduces net pay only (medical aid, garnishee) |

Default for items without `tax_treatment`: `net_only` (backward compatible).

Pre-tax deductions are reflected in the `preTaxDeductions` output field. Net-only deductions are in `netOnlyDeductions`.

---

## 7. PAYE Calculation Logic (Summary)

1. Compute periodic taxable gross (recurring income, annualised)
2. Compute once-off taxable gross (bonus, once-off items — never annualised)
3. Add together → total annual taxable income basis
4. Apply SARS bracket table → annual tax before rebates
5. Subtract rebates (primary mandatory, secondary if age ≥ 65, tertiary if age ≥ 75)
6. Subtract medical tax credit (Section 6A: members × credit rates)
7. Divide by 12 → monthly PAYE base
8. Add voluntary over-deduction if configured
9. Result: `paye` field

**UIF:**
- 1% of gross (employee share only — employer share is not tracked in engine)
- Capped at `UIF_MONTHLY_CAP` (R177.12/month)
- Zero if: employee `is_director === true` OR company `uif_registered === false`

**SDL:**
- 1% of gross
- Zero if company `sdl_registered === false`

---

## 8. Pro-Rata Calculation

When `start_date` or `end_date` falls within the current period, the engine uses `calculateWithProRata()`:

1. Count total expected working days in the period (from work schedule)
2. Count actual working days the employee was present (hire date → period end, or period start → termination date)
3. Pro-rata factor = actual days / expected days
4. Scale basic salary by pro-rata factor before calculation
5. Store `prorataFactor`, `expectedHoursInPeriod`, `workedHoursInPeriod` in output

**Decision logic in `PayrollCalculationService`:**
- `useProRata = options.useProRata !== false && (options.startDate || options.endDate || normalizedInputs.start_date)`
- If no pro-rata trigger → standard full-month path

---

## 9. Decimal Hours Standard

All time values throughout the engine use **decimal hours**:

| Time | Decimal |
|---|---|
| 15 minutes | 0.25 |
| 30 minutes | 0.50 |
| 45 minutes | 0.75 |
| 1 hour 30 minutes | 1.50 |

Do NOT use HH:MM as the calculation basis. `partial_hours` in work schedules, `hours` in overtime, `hours_missed` in short-time — all are decimal. The engine's hourly rate = `basic_salary / HOURLY_DIVISOR` (default 173.33).

---

## 10. Period Key and Tax Year Resolution

Period keys use format `YYYY-MM` (e.g. `2026-04`).

`PayrollEngine.getTaxYearForPeriod('2026-04')` → `'2026/2027'`

SA tax year rule: month ≥ 3 (March) → current year starts a new tax year. Month < 3 → belongs to previous year's tax year.

**Critical note:** Period keys must NOT be derived from `new Date(startDate).getMonth()` on UTC-negative servers. `new Date('2026-03-01')` is UTC midnight → `getMonth()` returns 1 (February) on UTC-1 servers. Always parse the period string directly: `periodKey.split('-')[1]`.

---

## Related Documents

- [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) — System structure and request flow
- [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md) — Snapshot structure and immutability
- [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md) — How to run payroll end-to-end
