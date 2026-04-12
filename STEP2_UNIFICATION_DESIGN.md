# STEP 2: UNIFICATION DESIGN — FINAL METHOD STRUCTURE

**Date:** April 12, 2026  
**Status:** Design locked — ready for implementation  
**Next Action:** Execute implementation in Step 3  

---

## EXECUTIVE DECISION

**Primary Source:** Ecosystem engine at `accounting-ecosystem/frontend-payroll/js/payroll-engine.js`

**Why:** 
- Contains all features from Standalone
- Adds YTD PAYE (run-to-date method)
- Adds tax configuration override (Supabase KV)
- Includes itemization fields (overtimeAmount, shortTimeAmount)
- Better documentation

**Standalone Treatment:**
- DEPRECATED — will be converted to stub that calls unified engine
- OR REMOVED entirely (less maintenance surface)

---

## UNIFIED ENGINE METHOD STRUCTURE

**Destination:** `accounting-ecosystem/backend/core/payroll-engine.js`

### Final Unified Engine Structure (In Order):

```javascript
const PayrollEngine = {
    
    // === VERSION & METADATA (NEW) ===
    VERSION: '2026-04-12-v1',
    SCHEMA_VERSION: '1.0',
    
    // === TAX CONSTANTS (from Ecosystem, unchanged) ===
    TAX_YEAR: '2026/2027',
    BRACKETS: [...],
    PRIMARY_REBATE: 17235,
    SECONDARY_REBATE: 9444,
    TERTIARY_REBATE: 3145,
    UIF_RATE: 0.01,
    UIF_MONTHLY_CAP: 177.12,
    SDL_RATE: 0.01,
    HOURLY_DIVISOR: 173.33,
    MEDICAL_CREDIT_MAIN: 364,
    MEDICAL_CREDIT_FIRST_DEP: 364,
    MEDICAL_CREDIT_ADDITIONAL: 246,
    HISTORICAL_TABLES: { ... },
    
    // === TAX CONFIG (from Ecosystem) ===
    loadTaxConfig: function() { ... },
    saveTaxConfig: function(cfg) { ... },
    
    // === UTILITY FUNCTIONS ===
    r2: function(n) { ... },
    getAgeFromId: function(idNumber, atDate) { ... },
    calculateMedicalCredit: function(numMembers, tables) { ... },
    
    // === CORE TAX CALCULATION ===
    calculateAnnualPAYE: function(annualGross, age, tables) { ... },
    calculateMonthlyPAYE: function(monthlyGross, options, tables) { ... },
    calculateUIF: function(monthlyGross, tables) { ... },
    calculateSDL: function(monthlyGross, tables) { ... },
    
    // === PERIOD & TABLE NAVIGATION ===
    getTaxYearForPeriod: function(periodStr) { ... },
    getTablesForPeriod: function(periodStr) { ... },
    getTaxBracket: function(annualGross) { ... },
    
    // === HOURLY RATE & SCHEDULE ===
    calcWeeklyHours: function(workSchedule, hoursPerDay) { ... },
    calcHourlyRate: function(monthlySalary, workSchedule, hoursPerDay) { ... },
    
    // === YTD PAYE SUPPORT (from Ecosystem) ===
    getMonthInTaxYear: function(period) { ... },
    getTaxYearPriorPeriods: function(period) { ... },
    
    // === PURE CALCULATION FUNCTION (the main one) ===
    calculateFromData: function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, ytdData) {
        // Step 1: Get period-specific tax tables
        // Step 2: Calculate taxable gross from salary + allowances + OT - ST
        // Step 3: Calculate PAYE (either annualization-only or YTD run-to-date)
        // Step 4: Calculate UIF, SDL
        // Step 5: Return all fields (including itemization)
        // RETURNS: { gross, taxableGross, paye, uif, sdl, net, ..., overtimeAmount, shortTimeAmount }
    },
    
    // === OPTIONAL: YTD HELPER (NEW) ===
    // Note: getYTDData() and calculateMonthlyPAYE_YTD() will be moved here
    // from Ecosystem engine
    
};
```

### Key Design Decisions:

**Decision A: Keep localStorage/history functions?**
- ❌ NO — Remove them
- **Why:** These are data access concerns, not calculation concerns
- **Where to move:** `backend/services/PayrollDataService.js`

**Decision B: Keep async/await in calculateEmployeePeriod?**
- ❌ NO — Pure calculation must be synchronous
- **Why:** Keeps the engine pure and testable
- **Where to move:** Use as controller layer (business logic)

**Decision C: Keep optional ytdData parameter in calculateFromData?**
- ✅ YES — Keep it (backward compatible, opt-in feature)
- **When provided:** Uses SARS run-to-date YTD PAYE method
- **When not provided:** Uses standard annualization method (same as Standalone)

**Decision D: Keep voluntary tax logic?**
- ✅ YES — Keep it (optional, doesn't hurt if not configured)
- **When configured:** Adds voluntary over-deduction to PAYE
- **When not configured:** Returns 0 (no-op)

**Decision E: Keep all output fields?**
- ✅ YES — Keep all 13 fields
- **Why:** Future-proofs for accounting/reporting/Sean integration
- **Benefit:** No need to refactor later

---

## WHAT WILL BE REMOVED (NOT Calculating Logic)

### FROM Unified Engine (Move to backend services):

```javascript
// ❌ REMOVE — Move to backend/services/PayrollDataService.js:
calculateEmployeePeriod()   // Data + calculation wrapper
getHistoricalRecord()       // Data access
hasHistoricalRecord()       // Data access
getHistoricalPeriods()      // Data access
getEmployeeHistory()        // Data access
deleteHistoricalRecord()    // Data access
undoImportBatch()          // Data access
getYTDData()               // Can stay (reads historical, but outputs pure data)
```

**Reason:** These are data access functions. The unified calculation engine should be pure (no side effects, no localStorage coupling).

---

## OUTPUT SCHEMA (UNIFIED)

**GUARANTEED RESULTS from `calculateFromData()`:**

```javascript
{
    // === Core Income ===
    gross:                  number,  // Total income (taxable + non-taxable)
    taxableGross:           number,  // Used for PAYE calculation
    nonTaxableIncome:       0,       // (optional, for clarity)
    
    // === Mandatory Deductions ===
    paye:                   number,  // PAYE tax (including any voluntary)
    paye_base:              number,  // PAYE before voluntary (for breakdown)
    voluntary_overdeduction:number,  // Voluntary tax added to PAYE
    uif:                    number,  // UIF contribution (1%, capped)
    sdl:                    number,  // SDL (1%)
    
    // === Other Deductions ===
    deductions:             number,  // Sum of all other deductions
    
    // === Net ===
    net:                    number,  // gross - paye - uif - sdl - deductions
    negativeNetPay:         boolean, // Flag if net < 0
    
    // === Tax Credits ===
    medicalCredit:          number,  // Monthly medical tax credit
    
    // === Itemization (NEW in unified) ===
    overtimeAmount:         number,  // Overtime hours × rate × multiplier
    shortTimeAmount:        number,  // Short-time hours × rate (reduction)
    
    // === Metadata ===
    engineVersion:          string,  // "2026-04-12-v1" (added by finalization service)
    schemaVersion:          string,  // "1.0" (added by finalization service)
    calculatedAt:           ISO string (added by finalization service)
}
```

**Always present:** gross, taxableGross, paye, uif, sdl, deductions, net, negativeNetPay, medicalCredit, overtimeAmount, shortTimeAmount

**Optional (depends on config):** paye_base, voluntary_overdeduction (when voluntary tax configured)

**Added at finalization (not by engine):** engineVersion, schemaVersion, calculatedAt

---

## CALCULATION FLOW (UNIFIED)

```

INPUT: payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period, [ytdData]
                   │
                   ↓
        ┌─────────────────────────┐
        │ Select tax tables for   │ (getTablesForPeriod → historical or current)
        │ the given period        │
        └────────────┬────────────┘
                   │
                   ↓
        ┌─────────────────────────┐
        │ Calculate hourly rate   │ (calcHourlyRate)
        │ from schedule           │
        └────────────┬────────────┘
                   │
                   ↓
        ┌─────────────────────────┐
        │ Build taxable gross     │
        │ salary + allowances +   │
        │ overtime - short-time   │
        │ (Mark OT & ST amounts)  │
        └────────────┬────────────┘
                   │
                   ↓
                ┌──────────┐
                │ YTD data │
                │ provided?│
                └──┬───────┘
                   │
        ┌──────────┴──────────┐
        │                     │
       YES                    NO
        │                     │
        ↓                     ↓
    calculateMonthlyPAYE_YTD  calculateMonthlyPAYE
    (SARS run-to-date)       (Annualization)
        │                     │
        └──────────┬──────────┘
                   │
                   ↓
        ┌─────────────────────────┐
        │ Apply voluntary tax     │ (if configured in employeeOptions)
        │ over-deduction (if any) │
        └────────────┬────────────┘
                   │
                   ↓
        ┌─────────────────────────┐
        │ Calculate UIF, SDL      │
        │ Medical credit (if any) │
        │ Other deductions        │
        └────────────┬────────────┘
                   │
                   ↓
        ┌─────────────────────────┐
        │ Calculate net pay       │
        │ Check if negative flag  │
        └────────────┬────────────┘
                   │
                   ↓
            RETURN: { gross, paye, uif, sdl, net, ..., overtimeAmount, shortTimeAmount }

```

---

## REGRESSION PRESERVATION

### For EVERY scenario WITHOUT YTD:

**Standalone calculation → Unified calculation must produce IDENTICAL results**

Verification protocol:
1. Record baseline (Standalone engine outputs)
2. After unification, run same inputs through unified engine
3. Compare: gross, paye, uif, sdl, net (tolerance ±0.01)
4. If mismatch: STOP, debug, fix
5. Only proceed if 100% match

---

## IMPLEMENTATION STEPS (STEP 3)

### Step 3.1: Create Directory Structure
```
accounting-ecosystem/backend/core/
├── payroll-engine.js          ← MAIN (copied + cleaned)
├── payroll-engine.test.js    ← Tests
└── README.md                 ← API docs
```

### Step 3.2: Copy & Clean Ecosystem Engine
- Copy from: `frontend-payroll/js/payroll-engine.js`
- Destination: `backend/core/payroll-engine.js`
- Remove: All localStorage/history functions
- Add: VERSION, SCHEMA_VERSION metadata
- Preserve: ALL calculation logic

### Step 3.3: Create Minimal Services Layer
```
accounting-ecosystem/backend/services/
├── PayrollDataService.js      ← History, localStorage functions
└── PayrollCalculationService.js  ← Wrapper around engine
```

### Step 3.4: Deprecate Standalone
- Option A: Delete `Payroll/Payroll_App/js/payroll-engine.js`
- Option B: Replace with stub that imports from `backend/core`

### Step 3.5: Run Regression Tests
- 10+ test scenarios
- All must pass (±0.01 tolerance)
- Document baseline vs unified outputs

---

## SUCCESS CRITERIA FOR STEP 2

✅ **Design decisions locked:** All 5 decisions (A-E) confirmed  
✅ **Method structure defined:** Exact list of methods to keep  
✅ **What to remove identified:** List of functions to move  
✅ **Output schema finalized:** Exact fields guaranteed  
✅ **Calculation flow mapped:** Visual diagram created  
✅ **Regression strategy defined:** How to verify zero regression  
✅ **Implementation steps clear:** Exact steps for Step 3  

---

*Design complete. Ready for Step 3 implementation.*
