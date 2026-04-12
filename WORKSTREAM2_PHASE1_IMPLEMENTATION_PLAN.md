# WORKSTREAM 2 — PHASE 1 IMPLEMENTATION PLAN

**Date:** April 12, 2026  
**Status:** LOCKED ARCHITECTURAL DECISIONS — READY FOR IMPLEMENTATION  
**Scope:** Engine Unification + Pro-Rata + Leave Hook Design  
**Duration:** Estimated 2-3 weeks  

---

## EXECUTIVE SUMMARY

PHASE 1 consolidates two diverging PayrollEngine implementations into a single unified engine with pro-rata calculation support and leave integration hooks. The Ecosystem version becomes the primary engine. Pro-rata calculations use schedule-based methodology. Leave integration is designed as hooks only (no full leave system until Phase 2).

**Key Principle:** Zero regression — all existing calculations must produce identical outputs. Pro-rata will only activate for employees with:
- Non-null `employment_date` field
- Period that includes mid-month start or termination

---

## PART 1: ENGINE UNIFICATION PLAN

### Current State (Two Engines)

**File A: Standalone** (`Payroll/Payroll_App/js/payroll-engine.js`)
- **Purpose:** Basic payroll calculations for Standalone Payroll app
- **Size:** ~650 lines
- **Core Methods:** `calculateFromData()`, `calculateMonthlyPAYE()`, `calculateUIF()`, `calculateSDL()`, `calcHourlyRate()`
- **Tax Config:** Hardcoded only
- **YTD Support:** No
- **Output Fields:** Basic (`gross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit`)

**File B: Ecosystem** (`accounting-ecosystem/frontend-payroll/js/payroll-engine.js`)
- **Purpose:** Advanced payroll calculations for Ecosystem Paytime
- **Size:** ~950 lines  
- **Core Methods:** All from Standalone + YTD-specific methods
- **Additional Methods:** `calculateMonthlyPAYE_YTD()`, `getMonthInTaxYear()`, `getTaxYearPriorPeriods()`, `getYTDData()`, `loadTaxConfig()`, `saveTaxConfig()`
- **Tax Config:** Hardcoded + Supabase KV override
- **YTD Support:** Yes (SARS run-to-date method)
- **Output Fields:** Enhanced (`gross, taxableGross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit`)

### UnificationStrategy

**Decision: Ecosystem version becomes PRIMARY engine. Standalone will:**
1. **Option A (RECOMMENDED):** Deprecate Standalone entirely — migrate Standalone app to use Ecosystem engine
2. **Option B (FALLBACK):** Keep Standalone but make it a thin wrapper that calls unified Ecosystem engine via import

**Rationale:**
- Ecosystem engine is more feature-complete
- No code duplication
- Single maintenance path
- Easier to add pro-rata and leave hooks to one engine
- Supabase KV means tax config is updatable without re-deployment

### Unified Engine Output Schema

**All calls to `calculateFromData()` will return:**

```javascript
{
    // === Gross Income ===
    gross:              number,              // Total income (taxable + non-taxable)
    taxableGross:       number,              // Taxable income only (for tax calcs)
    nonTaxableIncome:   number,              // Non-taxable allowances
    
    // === Deductions ===
    paye:               number,              // PAYE tax
    uif:                number,              // Unemployment insurance
    sdl:                number,              // Skills development levy
    deductions:         number,              // Sum of all other deductions
    
    // === Net ===
    net:                number,              // gross - paye - uif - sdl - deductions
    negativeNetPay:     boolean,             // Flag if net < 0
    
    // === Tax Credits & Items ===
    medicalCredit:      number,              // Monthly medical tax credit
    
    // === Itemization (NEW in unified) ===
    overtimeAmount:     number,              // Total overtime pay (hours × rate × multiplier)
    shortTimeAmount:    number,              // Total short-time deduction (hours × hourly_rate)
    multiRateAmount:    number,              // Total multi-rate pay
    
    // === Pro-Rata (NEW in unified) ===
    proRataFactor:      number,              // 0-1 (1.0 = full month, 0.5 = half month)
    proRataBasis:       string,              // 'schedule-based', 'calendar-days', 'working-days'
    
    // === Leave (NEW in unified — Phase 1 hook) ===
    unpaidLeaveHours:   number,              // Unpaid leave hours in period (to be deducted)
    
    // === YTD (Ecosystem feature retained) ===
    ytdTaxableGross:    number,              // Year-to-date taxable gross (if YTD mode active)
    ytdPAYE:            number               // Year-to-date PAYE (if YTD mode active)
}
```

### Unified Engine Method Signature

```javascript
PayrollEngine.calculateFromData(
    payrollData,        // { basic_salary, regular_inputs[], workSchedule?, hours_per_day?, employment_date?, termination_date? }
    currentInputs,      // Current period additions/deductions
    overtime,           // OT entries { hours, rate_multiplier }
    multiRate,          // Multi-rate entries { hours, hourly_rate }
    shortTime,          // Short-time entries { hours_missed }
    employeeOptions,    // { age, medicalMembers, taxDirective }
    period,             // 'YYYY-MM' (for historical tax tables + pro-rata logic)
    ytdData,            // OPTIONAL { ytdTaxableGross, ytdPAYE } (for YTD PAYE)
    unpaidLeaveHours    // OPTIONAL (for leave deduction hook — Phase 1)
)
```

### Files Changed for Engine Unification

1. **Ecosystem engine** (`accounting-ecosystem/frontend-payroll/js/payroll-engine.js`)
   - Add pro-rata calculation method
   - Add unpaid leave hook
   - Ensure itemization exports (overtimeAmount, shortTimeAmount)
   - Mark for export to shared module (if applicable)

2. **Standalone engine** (`Payroll/Payroll_App/js/payroll-engine.js`)
   - **Option A:** Delete (migration to Ecosystem)
   - **Option B:** Replace with import stub that delegates to Ecosystem engine

3. **Standalone pay-run.html** (if kept)
   - Update to use unified engine output schema
   - Ensure overtime/short-time displays correctly

---

## PART 2: PRO-RATA CALCULATION DESIGN

### Definition

Pro-rata adjusts gross salary/allowances when an employee:
- **Starts mid-month** (employment_date after 1st)
- **Terminates mid-month** (termination_date before last day)
- **Is on partial-month assignment** (certain contract types)

### Formula (Schedule-Based)

```
proRataFactor = actualHoursWorked / expectedHoursInMonth

where:
  actualHoursWorked    = sum of expected hours from employment_date to termination_date (or end of period)
  expectedHoursInMonth = weeklyHours × 4.33

Example:
  - Employee hired Mar 15 in 4-week cycle = 40h/week
  - Expected Mar hours (15-31, ~2.3 weeks): 40 × 2.3 = 92h
  - Expected full month: 40 × 4.33 = 173.2h
  - proRataFactor = 92 / 173.2 = 0.531 (53.1%)
```

### Pro-Rata Scope (What Gets Multiplied)

**Apply pro-rata to:**
1. ✅ Basic salary (primary income)
2. ✅ Regular allowances that are NOT marked `prorate_exempt: true`
3. ✅ Hourly rate basis (for OT/ST calculations)

**DO NOT apply pro-rata to:**
1. ❌ Non-taxable allowances marked `is_taxable: false`
2. ❌ One-off allowances (bonuses, commissions)
3. ❌ Items marked `prorate_exempt: true`

### Employee Data Model (Required Fields)

```javascript
{
    id:                 "emp_123",
    company_id:         "co_456",
    basic_salary:       30000,
    employment_date:    "2026-03-15",      // When employee starts (null = ongoing)
    termination_date:   null,              // When employee leaves (null = ongoing)
    workSchedule:       [ { day: 'Mon', enabled: true, type: 'normal', partial_hours: null }, ... ],
    hours_per_day:      8
}
```

### Integration With calculateFromData()

**Pseudo-code flow:**

```javascript
calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData, unpaidLeaveHours) {
    
    // STEP 1: Calculate pro-rata factor (if employment_date exists)
    var proRataFactor = 1.0;  // Default: full month
    if (payrollData.employment_date || payrollData.termination_date) {
        proRataFactor = this.calculateProRataFactor(
            payrollData.employment_date,
            payrollData.termination_date,
            period,
            payrollData.workSchedule,
            payrollData.hours_per_day
        );
    }
    
    // STEP 2: Calculate base taxable gross (with pro-rata applied)
    var taxableGross = (payrollData.basic_salary || 0) * proRataFactor;
    var nonTaxableIncome = 0;
    
    // STEP 3: Add regular allowances (with pro-rata for non-exempt)
    (payrollData.regular_inputs || []).forEach(function(ri) {
        if (ri.type !== 'deduction') {
            var amt = parseFloat(ri.amount) || 0;
            // Apply pro-rata to regular non-exempt allowances
            if (ri.prorate_exempt !== true) {
                amt *= proRataFactor;
            }
            if (ri.is_taxable === false) {
                nonTaxableIncome += amt;
            } else {
                taxableGross += amt;
            }
        }
    });
    
    // STEP 4: Add current period inputs (with pro-rata where appropriate)
    // [similar logic]
    
    // STEP 5: Calculate hourly rate (already accounts for schedule, now apply pro-rata)
    var hourlyRate = this.calcHourlyRate(
        payrollData.basic_salary * proRataFactor,  // Use pro-rata'd salary for rate
        payrollData.workSchedule,
        payrollData.hours_per_day
    );
    
    // STEP 6: Add/subtract OT/ST (uses pro-rata'd hourly rate)
    // Overtime & short-time already use proRata'd hourlyRate
    // [existing logic unchanged]
    
    // STEP 7: Apply unpaid leave deduction (NEW hook)
    if (unpaidLeaveHours && unpaidLeaveHours > 0) {
        taxableGross -= (unpaidLeaveHours * hourlyRate);
    }
    
    // STEP 8: Calculate taxes (existing logic, unchanged)
    var paye = this.calculateMonthlyPAYE(taxableGross, opts, tables);
    // [UIF, SDL, deductions logic unchanged]
    
    // STEP 9: Return with pro-rata fields
    return {
        gross: taxableGross + nonTaxableIncome,
        taxableGross: taxableGross,
        nonTaxableIncome: nonTaxableIncome,
        paye: paye,
        uif: uif,
        sdl: sdl,
        deductions: deductions,
        net: net,
        negativeNetPay: negativeNetPay,
        medicalCredit: medicalCredit,
        overtimeAmount: overtimeAmount,
        shortTimeAmount: shortTimeAmount,
        multiRateAmount: multiRateAmount,
        proRataFactor: proRataFactor,
        proRataBasis: 'schedule-based',
        unpaidLeaveHours: unpaidLeaveHours || 0,
        // YTD fields (if applicable)
        ytdTaxableGross: ytdData ? ytdData.ytdTaxableGross : null,
        ytdPAYE: ytdData ? ytdData.ytdPAYE : null
    };
}
```

### Pro-Rata Helper Method

```javascript
/**
 * Calculate pro-rata factor for a pay period based on employment/termination dates.
 * Schedule-based: counts actual expected hours vs full month expected hours.
 *
 * @param {string} employmentDate - 'YYYY-MM-DD' or null
 * @param {string} terminationDate - 'YYYY-MM-DD' or null
 * @param {string} period - 'YYYY-MM'
 * @param {Array} workSchedule - Work schedule array
 * @param {number} hoursPerDay - Hours per normal day (default 8)
 * @returns {number} 0.0-1.0 (1.0 = full month, 0.5 = half month, etc.)
 */
calculateProRataFactor: function(employmentDate, terminationDate, period, workSchedule, hoursPerDay) {
    
    // If no employment_date and no termination_date, full month
    if (!employmentDate && !terminationDate) return 1.0;
    
    // Extract period bounds
    var parts = period.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var periodStart = new Date(year, month - 1, 1);  // First day of month
    var periodEnd = new Date(year, month, 0);        // Last day of month
    
    // Determine active date range
    var activeStart = employmentDate ? new Date(employmentDate) : periodStart;
    var activeEnd = terminationDate ? new Date(terminationDate) : periodEnd;
    
    // Clamp to period bounds
    if (activeStart < periodStart) activeStart = periodStart;
    if (activeEnd > periodEnd) activeEnd = periodEnd;
    
    // If no overlap, return 0
    if (activeStart > activeEnd) return 0.0;
    
    // Count expected hours in active date range
    var actualHours = 0;
    var date = new Date(activeStart);
    while (date <= activeEnd) {
        var dayOfWeek = date.getDay();
        var dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];
        
        // Find matching schedule entry
        var scheduleDay = (workSchedule || []).find(function(s) {
            return s.day === dayName || s.day.toLowerCase() === dayName.toLowerCase();
        });
        
        if (scheduleDay && scheduleDay.enabled) {
            if (scheduleDay.type === 'partial' && scheduleDay.partial_hours != null) {
                actualHours += parseFloat(scheduleDay.partial_hours);
            } else if (scheduleDay.type !== 'non-working') {
                actualHours += (hoursPerDay || 8);
            }
        }
        
        date.setDate(date.getDate() + 1);
    }
    
    // Expected fullmonth hours
    var weeklyHours = this.calcWeeklyHours(workSchedule, hoursPerDay);
    var expectedFullMonthHours = weeklyHours * 4.33;
    
    // Pro-rata factor
    return expectedFullMonthHours > 0 ? (actualHours / expectedFullMonthHours) : 1.0;
}
```

### Edge Cases Handled

| Scenario | Behavior | Pro-Rata Factor |
|----------|----------|-----------------|
| Employee starts Mar 15, works to Mar 31 | Count only Mar 15-31 hours | 0.5-0.6 |
| Employee terminates Mar 20, works from Mar 1 | Count only Mar 1-20 hours | 0.6-0.7 |
| Employee starts Mar 1, terminates Mar 31 | Full month | 1.0 |
| Employee starts Feb 28, period is Mar | No overlap, zero hours | 0.0 |
| Zero hours in period (e.g., unpaid leave entire month) | Manual override leaves it to unpaidLeaveHours hook | 0.0 → flag |

### Pro-Rata Testing Strategy

**Test file:** `accounting-ecosystem/frontend-payroll/tests/pro-rata.test.js` (NEW)

**Test cases (minimum 20):**
1. Employee starts mid-month (Mar 15 start)
2. Employee terminates mid-month (Mar 20 term)
3. Employee starts & terminates same period (Mar 10-20)
4. Full month (no dates)
5. Zero hours (no enabled schedule)
6. Partial schedule days (Fri half-day)
7. 4-day work week
8. 5-day work week
9. Contract with `prorate_exempt: true` allowance (should NOT be pro-rata'd)
10. Non-taxable allowance (should NOT be pro-rata'd)
11. Overtime with pro-rata'd hourly rate
12. Short-time with pro-rata'd hourly rate
13. Pro-rata with medical credit (credit should NOT be pro-rata'd)
14. Pro-rata with negative net pay flag
15. YTD PAYE with pro-rata (if applicable)

---

## PART 3: LEAVE INTEGRATION HOOK DESIGN

### Scope (Phase 1 Only)

This phase ONLY defines the integration point. Full leave system (fetching, auto-deduction, tracking) is **Phase 2**.

### Leave Hook Input

**Parameter:** `unpaidLeaveHours` (optional, passed to `calculateFromData()`)

```javascript
unpaidLeaveHours: 16  // Unpaid leave hours in this period
```

### Leave Hook in calculateFromData()

Inside `calculateFromData()`, after all gross income calculations but before PAYE:

```javascript
// STEP 7: Apply unpaid leave deduction (Phase 1 hook)
if (unpaidLeaveHours && unpaidLeaveHours > 0) {
    taxableGross -= (unpaidLeaveHours * hourlyRate);
}
```

**Effect:**
- Unpaid leave reduces **taxable gross** (affects PAYE, not UIF/SDL — per SARS rules)
- Uses pro-rata'd hourly rate
- Returned in output for audit trail

### Leave Data Model (Future Phase 2)

```javascript
// Phase 2 will fetch leave balance from leave system
{
    emp_id:               "emp_123",
    period:               "2026-03-01",
    leave_type:           "annual",
    unpaid_hours:         16,
    approved:             true,
    approval_timestamp:   "2026-03-01T09:00:00Z"
}
```

### Leave API Hook Placeholder

**File:** `accounting-ecosystem/frontend-payroll/api/leave-integration.js` (NEW — Phase 2)

```javascript
/**
 * PLACEHOLDER: Fetch unpaid leave hours for employee in a period.
 * Phase 1: Returns 0 (no-op)
 * Phase 2: Will call external leave system
 */
const LeaveIntegration = {
    getUnpaidLeaveHours: function(companyId, empId, period) {
        // Phase 1: Return 0 (no leave deducted)
        return 0;
        
        // Phase 2: Uncomment and integrate
        // return fetch(`/api/leave/${companyId}/${empId}/${period}`)
        //     .then(r => r.json())
        //     .then(d => d.unpaid_hours || 0);
    }
};

module.exports = LeaveIntegration;
```

### No Full Leave System in Phase 1

**Phase 1 explicitly does NOT:**
- Fetch leave data from leave system
- Auto-calculate unpaid hours
- Create leave approval workflows
- Track leave balances
- Validate leave approvals

**Operators will:**
- Manually calculate unpaid leave hours (if any)
- Pass `unpaidLeaveHours` to `calculateFromData()` when running pay
- (Phase 2 will automate this)

---

## PART 4: VERIFICATION & REGRESSION CHECKING

### Before Implementation

1. ✅ Audit existing Standalone engine calculations (already done)
2. ✅ Audit existing Ecosystem engine calculations (already done)
3. ✅ Identify 5-10 test scenarios with known outputs
4. ✅ Document expected behavior (complete in audit)

### During Implementation

**Regression Check Protocol:**

For each test scenario:
1. Run calculation in CURRENT engine (Standalone or current Ecosystem)
2. Note output: `{ gross, paye, uif, sdl, net }`
3. After unification + pro-rata, run SAME calculation in unified engine with:
   - `employment_date: null` (full month behavior)
   - `unpaidLeaveHours: 0` (no leave impact)
4. Compare outputs:
   - ✅ `gross` must be identical (±0.01 for rounding)
   - ✅ `paye` must be identical
   - ✅ `uif` must be identical
   - ✅ `sdl` must be identical
   - ✅ `net` must be identical
5. If any mismatch: **STOP** and debug before proceeding

### Test Scenarios (Known Outputs)

**Scenario 1: Full-month, salary only**
```javascript
Input:
  basic_salary: 25000
  employment_date: null
  termination_date: null
  currentInputs: []
  overtime: []
  multiRate: []
  shortTime: []
  employeeOptions: { age: 35, medicalMembers: 1 }

Expected Output (current engine):
  gross: 25000
  taxableGross: 25000
  paye: 2851.25
  uif: 177.12 (capped)
  sdl: 250
  deductions: 0
  net: 21721.63
  medicalCredit: 364
```

**Scenario 2: Mid-month start**
```javascript
Input:
  basic_salary: 25000
  employment_date: '2026-03-15'  // Half month
  termination_date: null
  period: '2026-03'
  workSchedule: standard 40h/week, 5-day
  currentInputs: []
  overtime: []
  multiRate: []
  shortTime: []

Expected after pro-rata:
  proRataFactor: ~0.53 (Mar 15-31 ≈ 2.3 weeks out of ~4.3)
  gross: 13250 (25000 × 0.53)
  paye: ~1510 (prorated)
  uif: ~133 (25000 × 0.01 × 0.53, not capped)
  sdl: ~133 (prorated)
  net: ~11574
```

**Scenario 3: With overtime (full month)**
```javascript
Input:
  basic_salary: 25000
  workSchedule: 40h/week
  employment_date: null
  currentInputs: []
  overtime: [{ hours: 8, rate_multiplier: 1.5 }]
  multiRate: []
  shortTime: []
  
Expected:
  hourlyRate: 25000 / (40 × 4.33) ≈ 144.41/hr
  overtimeAmount: 8 × 144.41 × 1.5 ≈ 1732.92
  gross: 26732.92
  paye: ~3080 (includes OT)
  net: ~22659
```

### Post-Implementation Verification

1. ✅ Run all 5-10 test scenarios in unified engine
2. ✅ Compare outputs with "Expected" from current engine
3. ✅ Pro-rata scenarios produce expected factors
4. ✅ Leave hook doesn't break non-leave scenarios
5. ✅ YTD PAYE still works (if Ecosystem already has it)

---

## PART 5: IMPLEMENTATION ROADMAP

### Week 1: Engine Unification & Structure

**Goal:** Consolidate both engines into unified PayrollEngine

**Tasks:**
- [ ] Review both engine files 100% (lines 1-end)
- [ ] Identify all method differences systematically
- [ ] Create side-by-side method comparison document
- [ ] Merge YTD methods into final engine
- [ ] Add pro-rata helper methods (skeleton)
- [ ] Add leave hook parameter to `calculateFromData()` signature
- [ ] Test with full-month scenarios (0% pro-rata) — ensure no regression
- [ ] Commit: "Unified PayrollEngine with YTD and hooks"

**Files to change:**
- `accounting-ecosystem/frontend-payroll/js/payroll-engine.js` (main engine, add methods)
- `Payroll/Payroll_App/js/payroll-engine.js` (deprecate or replace with stub)

### Week 2: Pro-Rata Implementation & Testing

**Goal:** Implement working pro-rata calculation with full edge case handling

**Tasks:**
- [ ] Implement `calculateProRataFactor()` method
- [ ] Integrate pro-rata into `calculateFromData()`
- [ ] Add pro-rata to salary calculation
- [ ] Add pro-rata to regular non-exempt allowances
- [ ] Add pro-rata to hourly rate (for OT/ST)
- [ ] Test with 5 pro-rata scenarios (mid-start, mid-term, etc.)
- [ ] Verify OT/ST calculations use pro-rata'd hourly rate
- [ ] Create test file: `pro-rata.test.js` with 15+ test cases
- [ ] All tests pass ✅
- [ ] Commit: "Pro-rata calculation fully implemented and tested"

**Files to change:**
- `accounting-ecosystem/frontend-payroll/js/payroll-engine.js` (add pro-rata methods & logic)
- `accounting-ecosystem/frontend-payroll/tests/pro-rata.test.js` (NEW)

### Week 3: Leave Hook & Final Verification

**Goal:** Add leave integration hook; verify all scenarios (full-month + pro-rata + leave)

**Tasks:**
- [ ] Add `unpaidLeaveHours` parameter to `calculateFromData()`
- [ ] Implement leave deduction logic (subtract from taxableGross)
- [ ] Ensure leave deduction uses pro-rata'd hourly rate
- [ ] Create placeholder `leave-integration.js` stub
- [ ] Test: full-month + no leave (unchanged)
- [ ] Test: full-month + unpaid leave (new)
- [ ] Test: pro-rata + no leave (pro-rata still works)
- [ ] Test: pro-rata + unpaid leave (both applied)
- [ ] Verify output schema includes new fields
- [ ] Document output schema in JSDoc
- [ ] Create regression test suite (all 10+ scenarios)
- [ ] All regression tests pass ✅
- [ ] Commit: "Leave hook integrated; full regression testing passed"

**Files to change:**
- `accounting-ecosystem/frontend-payroll/js/payroll-engine.js` (final refinements)
- `accounting-ecosystem/frontend-payroll/api/leave-integration.js` (NEW stub)
- `accounting-ecosystem/frontend-payroll/tests/regression-full.test.js` or update existing

---

## PART 6: DELIVERABLES & SUCCESS CRITERIA

### Deliverables

1. ✅ **Unified PayrollEngine** (`accounting-ecosystem/frontend-payroll/js/payroll-engine.js`)
   - Single source of truth for all payroll calculations
   - Pro-rata methods integrated
   - Leave hook parameters added
   - Full JSDoc documentation

2. ✅ **Pro-Rata Calculation Method** (`calculateProRataFactor()`)
   - Schedule-based methodology
   - Edge cases handled
   - Integrated into gross calculation

3. ✅ **Leave Integration Stub** (`accounting-ecosystem/frontend-payroll/api/leave-integration.js`)
   - Placeholder for Phase 2 full implementation
   - No-op return (0 hours) for Phase 1

4. ✅ **Comprehensive Test Suite** (`pro-rata.test.js`, `regression-full.test.js`)
   - 20+ pro-rata test cases
   - 10+ regression test cases
   - All passing

5. ✅ **Documentation**
   - Updated architecture guide
   - Engine method reference
   - Pro-rata algorithm explanation
   - Leave integration plan (Phase 2)

### Success Criteria

- [ ] **Zero Regression:** All existing full-month scenarios produce identical output
- [ ] **Pro-Rata Works:** Mid-month start/termination produces correct factor and gross
- [ ] **Leave Hook Ready:** Parameter accepted, deduction calculated correctly
- [ ] **Output Schema:** Returns all required fields including new ones
- [ ] **Tests Pass:** 100% of regression + pro-rata tests pass
- [ ] **Code Quality:** All calculations rounded via `r2()`, no penny drift
- [ ] **Edge Cases Handled:** Zero hours, negative net, zero salary all handled safely
- [ ] **Documentation:** All methods documented with parameters, returns, examples

---

## PART 7: RISKS & MITIGATION

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Pro-rata breaks OT/ST calculations | Test OT with pro-rata immediately; verify hourly rate propagates | Engineer |
| Rounding introduces penny drift | Use centralized `r2()` for all calculations; audit totals | Engineer |
| Medical credit calculated incorrectly with pro-rata | Medical credit is NOT pro-rata'd (Phase 2 decision); test explicitly | Engineer |
| Leave deduction calculated on wrong basis | Leave deduction uses taxableGross (not UIF/SDL base) per SARS; test | Engineer |
| Regression in existing PAYE | Run full regression suite every commit; freeze master if any fail | Engineer |
| YTD PAYE breaks during merge | YTD methods already in Ecosystem; ensure no overwrites during unify | Engineer |

---

## PART 8: NEXT STEPS AFTER PHASE 1

**Phase 2 (Leave Integration — after Phase 1 stable):**
- Fetch leave data from leave system
- Auto-calculate unpaid hours per period
- Build leave approval workflow
- Remove stub, implement full `leave-integration.js`

**Phase 3 (Optimization — after Phase 2):**
- Performance profiling for large payrolls
- Cache calculations
- Batch processing improvements

---

*This plan is LOCKED. All changes must conform to these architectural decisions. Next session: BEGIN IMPLEMENTATION.*
