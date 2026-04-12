# ENGINE OWNERSHIP MODEL — LORENCO PAYROLL CALCULATION

**Status:** DESIGN PHASE (PRE-IMPLEMENTATION)  
**Date:** April 12, 2026  
**Authority:** Principal Payroll Engine Architect  
**Scope:** Single source of truth for all payroll calculations across Lorenco ecosystem  

---

## EXECUTIVE SUMMARY

The Lorenco ecosystem currently has TWO diverging PayrollEngine implementations with inconsistent features and output schemas. This creates:
- **Maintenance burden** (bug fixes must be applied twice)
- **Regression risk** (changes in one don't propagate)
- **Compliance risk** (same calculation produces different results)
- **Future dependency chaos** (Accounting, Inventory, Sean will have to choose which to use)

This document defines the **single source of truth** model that eliminates these risks.

---

## PART 1: CURRENT STATE ANALYSIS

### Two Engines Today

**Engine A: Standalone** (`Payroll/Payroll_App/js/payroll-engine.js`)
- Location: Local app directory
- Consumers: Standalone Payroll app ONLY
- Features: Basic PAYE, UIF, SDL, hourly rate, OT/ST
- Output: `{ gross, paye, uif, sdl, net, negativeNetPay, medicalCredit }`
- Tax Config: Hardcoded only
- YTD Support: No

**Engine B: Ecosystem** (`accounting-ecosystem/frontend-payroll/js/payroll-engine.js`)
- Location: Shared ecosystem directory
- Consumers: Paytime UI (Ecosystem Frontend)
- Features: All from A + YTD PAYE, voluntary tax, tax config override
- Output: `{ gross, taxableGross, paye, uif, sdl, net, negativeNetPay, medicalCredit }` (more fields)
- Tax Config: Hardcoded + Supabase KV override
- YTD Support: Yes

### Divergence Problems

| Issue | Impact | Severity |
|-------|--------|----------|
| Output schema differs (A missing `taxableGross`) | Accounting can't normalize reports | HIGH |
| YTD only in B | Standalone can't handle variable income | MEDIUM |
| Tax config override only in B | Standalone locked to hardcoded tables | MEDIUM |
| No shared dependency | Future apps must choose which to copy | CRITICAL |
| Bug fixes applied separately | Eventually they drift further | HIGH |

---

## PART 2: UNIFIED ENGINE OWNERSHIP MODEL

### 2.1 SINGLE SOURCE OF TRUTH LOCATION

**Primary Engine Location:**
```
accounting-ecosystem/backend/core/payroll-engine.js
```

**Rationale:**
- `backend/` = server-safe, not browser-only
- `core/` = shared across apps, not module-specific
- Not in `frontend-payroll/` (prevents perception it's payroll-app-only)
- Accessible to ALL consumers via clear import path

### 2.2 ENGINE MODULE STRUCTURE

```
accounting-ecosystem/
├── backend/
│   ├── core/
│   │   ├── payroll-engine.js                 ← PRIMARY UNIFIED ENGINE
│   │   ├── payroll-engine.test.js            ← Test suite
│   │   └── README.md                         ← Engine API documentation
│   │
│   └── services/
│       ├── PayrollCalculationService.js      ← Business logic layer
│       └── TaxConfigService.js               ← Tax table management
│
├── frontend-payroll/
│   ├── js/
│   │   └── payroll-engine.js                 ← DEPRECATED (stub → redirect to backend)
│   │
│   ├── api/
│   │   ├── leave-integration.js              ← Leave deduction hook
│   │   └── payroll-api.js                    ← Frontend API client
│   └── tests/
│       └── payroll-integration.test.js       ← Frontend-only tests
│
└── frontend-accounting/
    ├── payroll-reports/
    │   └── report-generator.js               ← Uses backend engine
    └── tests/
        └── payroll-report.test.js
```

### 2.3 ACCESS PATTERN (HOW APPS USE THE ENGINE)

#### Pattern A: Direct JavaScript Import (Node.js / Backend)

**Used by:** Backend services, batch processing, reporting

```javascript
// File: backend/services/PayrollCalculationService.js
const PayrollEngine = require('../core/payroll-engine');

function calculatePayroll(payrollData, currentInputs, options, period) {
    return PayrollEngine.calculateFromData(
        payrollData,
        currentInputs,
        options.overtime,
        options.multiRate,
        options.shortTime,
        options.employeeOptions,
        period,
        options.ytdData,
        options.unpaidLeaveHours
    );
}

module.exports = { calculatePayroll };
```

#### Pattern B: API Endpoint (Frontend → Backend → Engine)

**Used by:** Frontend UI apps (Paytime, Accounting, etc.)

```javascript
// File: backend/routes/payroll.js
const PayrollCalculationService = require('../services/PayrollCalculationService');

app.post('/api/payroll/calculate', async (req, res) => {
    try {
        const { payrollData, currentInputs, options, period } = req.body;
        
        // Validate company access (Workstream 1 responsibility)
        const result = PayrollCalculationService.calculatePayroll(
            payrollData,
            currentInputs,
            options,
            period
        );
        
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// File: frontend-payroll/js/payroll-api.js
async function calculatePayroll(payload) {
    const response = await fetch('/api/payroll/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return response.json();
}
```

#### Pattern C: Snapshot / Immutable Reference (Historical Payroll)

**Used by:** When accessing historical pay runs (immutability principle)

```javascript
// File: backend/models/PayslipRecord.js
class PayslipRecord {
    constructor(data) {
        this.id = data.id;
        this.period = data.period;
        this.calculationSnapshot = data.calculationSnapshot;  // Immutable snapshot
        this.engineVersion = data.engineVersion;              // E.g., "2026-04-12-v1"
        this.finalizedTimestamp = data.finalizedTimestamp;
    }
    
    /**
     * Return the exact calculation that produced this payslip.
     * Uses the snapshot (immutable) not the live engine.
     */
    getCalculation() {
        return this.calculationSnapshot;  // Never recalculated
    }
}
```

---

## PART 3: ECOSYSTEM READINESS (FUTURE CONSUMERS)

### 3.1 Integrated Consumer: Lorenco Accounting

**Current State:** Not yet integrated with payroll engine

**Future Use Case:** Generate GL entries from payroll calculations

**Access Pattern:**
```javascript
// File: frontend-accounting/payroll-reports/gl-generator.js
const PayrollAPI = require('../../api/payroll-api');

async function generateGLEntries(payrollRun) {
    // For each payslip in the run
    for (const payslip of payrollRun.payslips) {
        // The payslip already contains calculationSnapshot (immutable)
        const calc = payslip.getCalculation();
        
        // Map to GL entries
        const glEntry = {
            date: payrollRun.period,
            debit: { account: '1200', amount: calc.gross },        // Salary expense
            credit: { account: '2100', amount: calc.paye },        // PAYE payable
            credit: { account: '2200', amount: calc.uif },         // UIF payable
            credit: { account: '2300', amount: calc.net }          // Net wages payable
        };
    }
}
```

**Integration Point:** `/api/payroll/payslips/{period}` returns calculation snapshots

### 3.2 Integrated Consumer: Inventory Module (Labour Costing)

**Current State:** Not yet integrated

**Future Use Case:** Allocate labour cost to inventory based on payroll hours

**Access Pattern:**
```javascript
// File: frontend-inventory/costing/labour-allocation.js
const PayrollAPI = require('../../api/payroll-api');

async function allocateLabourCosts(period) {
    // Get payroll calculation for the period
    const payslips = await PayrollAPI.getPayslips(period);
    
    for (const payslip of payslips) {
        const calc = payslip.getCalculation();
        const hourlyRate = calc.hourlyRate;  // Available from calculation
        
        // Get employee's time entries for period
        const timeEntries = await TimeAPI.getEntries(payslip.empId, period);
        
        // Allocate cost to jobs/inventory
        for (const entry of timeEntries) {
            const cost = entry.hours * hourlyRate;
            await InventoryAPI.allocateCost({
                jobId: entry.jobId,
                cost: cost,
                source: 'payroll'
            });
        }
    }
}
```

**Integration Point:** Snapshots must include `hourlyRate` field (already in schema)

### 3.3 Integrated Consumer: Sean AI (Learning Layer)

**Current State:** Not yet implemented

**Future Use Case:** Learn IRP5 code → payroll item mappings from actual payroll data

**Access Pattern:**
```javascript
// File: sean-webapp/learning/payroll-learner.js
const SeanKnowledgeStore = require('../knowledge-store');

async function learnFromPayroll(period) {
    // Get all finalized payslips for period
    const payslips = await PayrollAPI.getPayslips(period, { finalized: true });
    
    for (const payslip of payslips) {
        const calc = payslip.getCalculation();
        
        // Learn: payroll_item_name → irp5_code mapping
        for (const input of calc.breakdown) {
            await SeanKnowledgeStore.recordMapping({
                source: 'paytime',
                itemName: input.name,
                irp5Code: input.irp5_code,
                frequency: 'monthly',
                period: period,
                confidence: 'finalized'  // High confidence — this was actually paid
            });
        }
    }
}
```

**Integration Point:** Calculation snapshots must include full `breakdown` of all payroll items (new field to add)

---

## PART 4: VERSION CONTROL & IMMUTABILITY STRATEGY

### 4.1 ENGINE VERSIONING (Backward Compatibility)

**Problem:** If we update the engine, historical payroll calculations must remain exact.

**Solution: Engine Versioning with Snapshots**

```javascript
// File: backend/core/payroll-engine.js (top)
const PayrollEngine = {
    // Engine version — increment when logic changes
    VERSION: '2026-04-12-v1',
    BUILD_DATE: '2026-04-12',
    
    // Schema version — increment when output fields change
    SCHEMA_VERSION: '1.0',
    
    // ... rest of engine
};
```

**When Payslip is Finalized:**

```javascript
// File: backend/services/PayrollFinalizationService.js
async function finalizePayslip(payslipData, calculationResult) {
    const record = {
        id: uuid(),
        period: payslipData.period,
        empId: payslipData.empId,
        companyId: payslipData.companyId,
        
        // Immutable snapshot of calculation AT THE TIME OF FINALIZATION
        calculationSnapshot: {
            ...calculationResult,
            engineVersion: PayrollEngine.VERSION,
            schemaVersion: PayrollEngine.SCHEMA_VERSION,
            calculatedAt: new Date().toISOString()
        },
        
        // Metadata for auditing
        finalizedBy: userId,
        finalizedAt: new Date().toISOString(),
        isFinalized: true,
        isMutable: false  // Can never be changed after finalization
    };
    
    // Store in Supabase (immutable record)
    await supabase
        .from('payslips_finalized')
        .insert(record)
        .throwOnError();
    
    return record;
}
```

### 4.2 IMMUTABILITY PRINCIPLE (Historical Payroll Must NOT Change)

**Core Rule:** Once a payslip is finalized, it can NEVER be recalculated with a different engine.

**Implementation:**

```javascript
// File: backend/models/PayslipRecord.js

class PayslipRecord {
    /**
     * Get the exact calculation that was used when this payslip was finalized.
     * Returns the immutable snapshot ALWAYS, never recalculates.
     */
    getCalculation() {
        if (!this.isFinalized) {
            throw new Error('Cannot get calculation of unfin payslip');
        }
        // Always return the snapshot stored at finalization time
        return this.calculationSnapshot;
    }
    
    /**
     * FORBIDDEN: Do not recalculate finalized payslips.
     * If engine changes, historical payslips keep their original calculation.
     */
    recalculate() {
        throw new Error('FORBIDDEN: Finalized payslips are immutable');
    }
}
```

**Why This Matters:**
- Tax year 2025/26 payroll is FIXED on 28 Feb 2026
- If SARS updates tax brackets in March 2026, we don't retroactively change Feb payslips
- Historical records must always match what was actually paid
- Audit trail depends on this immutability

### 4.3 FORWARD COMPATIBILITY (New Code Can Read Old Payslips)

**Scenario:** In June 2026, we add a new field to the engine output. Old payslips don't have it.

**Solution: Adapter Pattern**

```javascript
// File: backend/models/PayslipRecord.js

class PayslipRecord {
    /**
     * Get calculation with schema normalization.
     * If old payslip is missing a field, fill it in using backward-compatible logic.
     */
    getCalculationNormalized() {
        let calc = this.calculationSnapshot;
        
        // Schema v1.0 didn't have breakdown field; reconstruct it from summary
        if (!calc.breakdown && this.schemaVersion === '1.0') {
            calc.breakdown = this.reconstructBreakdownFromLegacy(calc);
        }
        
        // Future schema v2.0 might require new fields; add with defaults
        if (!calc.earnedLeaveProvision && this.schemaVersion < '2.0') {
            calc.earnedLeaveProvision = 0;  // Default for old records
        }
        
        return calc;
    }
    
    reconstructBreakdownFromLegacy(calc) {
        // For old v1.0 payslips, reconstruct the breakdown array
        return [
            { name: 'Basic Salary', amount: calc.basic || 0 },
            { name: 'Other Allowances', amount: (calc.gross || 0) - (calc.basic || 0) }
        ];
    }
}
```

---

## PART 5: HOW EACH APP USES THE ENGINE

### 5.1 Paytime (Current Primary Consumer)

**Current State:**
- Uses local `frontend-payroll/js/payroll-engine.js` (Engine B)

**Future State (After Implementation):**
- Calls `/api/payroll/calculate` endpoint
- Backend executes unified engine
- Returns calculation result to UI
- UI displays on payslip
- When finalized, snapshots stored with `engineVersion` metadata

**Code Path:**
```
frontend-payroll/pay-run.html
  ↓ (Calculate button clicked)
payroll-api.calculatePayroll()
  ↓ (fetch POST)
backend/routes/payroll.js
  ↓
PayrollCalculationService.calculatePayroll()
  ↓
PayrollEngine.calculateFromData()  ← SINGLE UNIFIED ENGINE
  ↓ (returns calculation)
PayslipRecord.create()  ← Stores snapshot
  ↓ (if finalized)
PayslipRecord.finalize()  ← Immutable
```

### 5.2 Standalone Payroll App (Deprecated Path)

**Current State:**
- Uses local `Payroll/Payroll_App/js/payroll-engine.js` (Engine A)

**Options:**

**Option A (RECOMMENDED): Full Migration**
- Standalone app converted to use same API as Paytime
- Or standalone app deprecated entirely

**Option B (FALLBACK): Compatibility Layer**
```javascript
// File: Payroll/Payroll_App/js/payroll-engine.js (converts from local to API)
const PayrollEngine = {
    // Redirect all calls to backend API
    calculateFromData: async function(payrollData, currentInputs, overtime, multiRate, shortTime, employeeOptions, period) {
        const response = await fetch('/api/payroll/calculate', {
            method: 'POST',
            body: JSON.stringify({
                payrollData, currentInputs, overtime, multiRate,
                shortTime, employeeOptions, period
            })
        });
        return response.json();
    }
};
```

### 5.3 Future: Accounting Module

**When accounting module is built:**
- Imports `PayrollCalculationService` directly (Node.js backend)
- Calls `getPayslips(period, companyId)` API
- Receives immutable snapshots with `calculationSnapshot` field
- Generates GL entries from snapshots (never recalculates)

### 5.4 Future: Inventory Labour Costing

**When labour costing is implemented:**
- Imports `PayrollCalculationService`
- Calls `getPayslips()` to get hourly rates
- Allocates labour to jobs/products based on time entries × hourly rate

### 5.5 Future: Sean AI Learning

**When Sean payroll learning activates:**
- Subscribes to finalized payslips
- Extracts payroll item → IRP5 code mappings
- Stores in Sean knowledge base
- Later: proposes standardization across clients

---

## PART 6: RISKS & MITIGATION

| Risk | Impact | Mitigation |
|------|--------|-----------|
| API latency for frontend calculations | Slow UI response | Implement caching; batch calculations |
| Backward compatibility breaks | Old payslips can't be recalculated/audited | Immutability + adapter pattern |
| Engine updates affect unfin payslips | Wrong calculations visible | Option: Freeze engine during pay run |
| Multiple engine versions in prod | Audit confusion | Version tagging in snapshot mandatory |
| Accidental schema drift | Apps fail parsing | Test schema against all 5 consumers |
| Standalone app forgotten in deprecation | Silent divergence | Add deprecation warning to console |
| Tax config override (KV) not accessible | Engine uses old tables | Move KV config fetch to backend service |

---

## PART 7: IMPLEMENTATION CHECKLIST (PRE-PHASE 1)

**Before engine unification code starts, this model must be:**

- [ ] Reviewed by stakeholders (SE, Finance, QA leads)
- [ ] Confirmed: Single source of truth location approved
- [ ] Confirmed: Access pattern (API endpoint design) approved
- [ ] Confirmed: Immutability strategy accepted
- [ ] Confirmed: Versioning approach locked
- [ ] File structure created (directories + placeholder files)
- [ ] Backend API `/api/payroll/calculate` endpoint scaffolded
- [ ] Supabase schema confirmed (payslips_finalized table + engine metadata)
- [ ] Documentation updated in `backend/core/payroll-engine.js` README

---

## PART 8: FILE OPERATIONS TO EXECUTE (If Model Approved)

If this ownership model is approved, I will:

1. Create directory structure:
   ```
   accounting-ecosystem/backend/core/payroll-engine.js  (move unified engine here)
   accounting-ecosystem/backend/services/PayrollCalculationService.js  (API layer)
   accounting-ecosystem/backend/routes/payroll.js  (endpoint)
   accounting-ecosystem/backend/core/README.md  (API docs)
   ```

2. Modify files:
   ```
   Payroll/Payroll_App/js/payroll-engine.js  (convert to stub OR deprecate)
   accounting-ecosystem/frontend-payroll/js/payroll-engine.js  (mark deprecated, redirect to API)
   ```

3. Add backend service layer:
   ```
   PayrollCalculationService.calculatePayroll()  ← Wrapper around engine
   PayrollFinalizationService.finalizePayslip()  ← Immutability logic
   ```

4. Add API endpoint:
   ```
   POST /api/payroll/calculate  ← Backend execution
   GET /api/payroll/payslips/:period  ← Historical retrieval
   ```

5. Schema updates:
   ```
   payslips_finalized table schema (add engineVersion, schemaVersion, calculationSnapshot fields)
   ```

---

## SUMMARY: ENGINE OWNERSHIP MODEL

| Aspect | Decision |
|--------|----------|
| **Primary Location** | `accounting-ecosystem/backend/core/payroll-engine.js` |
| **Schema Version** | `1.0` (updated when output fields change) |
| **Engine Version** | `2026-04-12-v1` (tag every production release) |
| **Access Pattern** | Direct import (backend) + API endpoint (frontend) |
| **Immutability** | Snapshots + forbidden recalculation after finalization |
| **Consumer Model** | All apps depend on single engine via clear import path |
| **Versioning Strategy** | Backward compatibility via schema adaptation + snapshots |
| **Historical Rule** | Finalized payslips NEVER recalculated, always use stored snapshot |
| **Future Consumers** | Accounting, Inventory, Sean ready to integrate safely |
| **Governance** | Engine updates require version increment + changelog |

---

*This design ensures the Lorenco payroll engine remains a single source of truth that can safely scale across all ecosystem applications.*
