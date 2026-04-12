# ENGINE OWNERSHIP MODEL — VISUAL SUMMARY & APPROVAL CHECKLIST

**Design Status:** COMPLETE AND READY FOR APPROVAL  
**Date:** April 12, 2026  

---

## 1. CURRENT PROBLEM (Why This Model Is Needed)

```
TODAY — TWO DIVERGING ENGINES:

Payroll/Payroll_App/js/payroll-engine.js  ← Engine A (Standalone)
    Consumers: Standalone Payroll App only
    Features: Basic PAYE, hourly rate, OT/ST
    Output: { gross, paye, uif, sdl, net }
    Tax Config: Hardcoded
    YTD: NO

accounting-ecosystem/frontend-payroll/js/payroll-engine.js  ← Engine B (Ecosystem)
    Consumers: Paytime UI only
    Features: All from A + YTD, tax override, field itemization
    Output: { gross, taxableGross, paye, uif, sdl, net, ... }
    Tax Config: Hardcoded + Supabase KV
    YTD: YES

PROBLEM:
  ❌ Same calculation produces different results
  ❌ Bug fixes must be applied twice
  ❌ Future apps (Accounting, Inventory, Sean) don't know which to use
  ❌ Compliance risk — SARS audit sees inconsistent payroll logic
```

---

## 2. PROPOSED SOLUTION (Engine Ownership Model)

```
TOMORROW — SINGLE SOURCE OF TRUTH:

accounting-ecosystem/backend/core/payroll-engine.js  ← PRIMARY UNIFIED ENGINE
    ├─ Consumers:
    │   ├─ Paytime UI (via API)
    │   ├─ Accounting module (direct import)
    │   ├─ Inventory labour costing (direct import)
    │   └─ Sean AI learning (snapshots)
    │
    ├─ Features:
    │   ├─ All A features
    │   ├─ All B features
    │   ├─ Pro-rata (NEW)
    │   └─ Leave deduction hook (NEW)
    │
    ├─ Output Schema:
    │   ├─ gross, taxableGross (unified)
    │   ├─ paye, uif, sdl (unified)
    │   ├─ net, negativeNetPay (unified)
    │   ├─ medicalCredit (unified)
    │   ├─ overtimeAmount, shortTimeAmount (new)
    │   └─ proRataFactor, unpaidLeaveHours (new)
    │
    ├─ Tax Config:
    │   ├─ Hardcoded defaults
    │   ├─ Supabase KV override
    │   └─ Historical tables (2021/22 - 2026/27)
    │
    ├─ YTD Support: YES
    │
    ├─ Version Metadata:
    │   ├─ engineVersion: "2026-04-12-v1"
    │   ├─ schemaVersion: "1.0"
    │   └─ calculatedAt: ISO timestamp
    │
    └─ Immutability:
        ├─ Finalized payslips NEVER recalculate
        ├─ Snapshots stored with version tags
        └─ Historical payroll is READ ONLY
```

---

## 3. ACCESS PATTERNS (How Apps Use The Engine)

### Pattern A: Backend (Direct Import)

**Used by:** Backend services, batch processing, reporting

```javascript
// backend/services/PayrollCalculationService.js
const PayrollEngine = require('../core/payroll-engine');

function calculatePayroll(data) {
    return PayrollEngine.calculateFromData(...);
}
```

✅ Fast (no network latency)  
✅ Secure (no exposure to browser)  
✅ Testable (unit tests)  

---

### Pattern B: Frontend (API Endpoint)

**Used by:** Paytime UI, future Accounting UI

```javascript
// frontend-payroll/payroll-api.js
async function calculatePayroll(payload) {
    const res = await fetch('/api/payroll/calculate', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    return res.json();
}
```

✅ Centralized (all logic on backend)  
✅ Auditable (API logs available)  
✅ Versioned (engine version in response)  

---

### Pattern C: Historical (Immutable Snapshots)

**Used by:** Audits, reports, recalculations (never allowed)

```javascript
// Retrieve finalized payslip
const payslip = await getPayslip(id);

// Always get the stored snapshot (immutable)
const calculation = payslip.getCalculation();

// FORBIDDEN: payslip.recalculate() ❌
// Throws error: "Finalized payslips are immutable"
```

✅ Compliance (historical payroll never changes)  
✅ Audit trail (timestamp + engine version preserved)  
✅ Tax safe (SARS can verify Feb payroll stayed in Feb tax rules)  

---

## 4. FILE STRUCTURE AFTER IMPLEMENTATION

```
accounting-ecosystem/
│
├── backend/
│   ├── core/
│   │   ├── payroll-engine.js              ← PRIMARY SOURCE OF TRUTH
│   │   ├── payroll-engine.test.js         ← Comprehensive tests
│   │   └── README.md                      ← Engine API docs
│   │
│   ├── services/
│   │   ├── PayrollCalculationService.js   ← Business logic wrapper
│   │   ├── PayrollFinalizationService.js  ← Immutability enforcement
│   │   └── TaxConfigService.js            ← Tax table management
│   │
│   ├── routes/
│   │   ├── payroll.js                     ← API endpoints
│   │   └── tests/
│   │       └── payroll-routes.test.js
│   │
│   └── models/
│       ├── PayslipRecord.js               ← Immutable record model
│       └── tests/
│           └── payslip-record.test.js
│
├── frontend-payroll/
│   ├── js/
│   │   └── payroll-engine.js              ← DEPRECATED (stub only)
│   │
│   ├── api/
│   │   ├── payroll-api.js                 ← Frontend API client
│   │   └── leave-integration.js           ← Leave hook placeholder
│   │
│   ├── pay-run.html                       ← Uses /api/payroll/calculate
│   │
│   └── tests/
│       └── payroll-integration.test.js
│
├── frontend-accounting/
│   ├── payroll-reports/
│   │   └── gl-generator.js                ← Uses snapshots (no recalc)
│   └── tests/
│       └── payroll-report.test.js
│
└── database/
    └── supabase/
        └── payslips_finalized.sql         ← Schema + audit columns
```

---

## 5. IMMUTABILITY GUARANTEE (Critical For Compliance)

### Principle: Historical Payroll Is LOCKED

**When a payslip is finalized:**

```javascript
{
    id: "ps_20260401_emp123",
    period: "2026-04",
    empId: "emp123",
    
    // *** IMMUTABLE SNAPSHOT ***
    calculationSnapshot: {
        gross: 25000,
        paye: 2851.25,
        uif: 177.12,
        sdl: 250,
        net: 21721.63,
        
        engineVersion: "2026-04-12-v1",      ← Engine version locked
        schemaVersion: "1.0",                ← Output schema version locked
        calculatedAt: "2026-04-01T10:30Z"   ← Timestamp locked
    },
    
    // *** METADATA FOR AUDIT ***
    finalizedBy: "user_456",
    finalizedAt: "2026-04-05T16:45Z",
    isFinalized: true,
    isMutable: false                        ← LOCKED
}
```

**What This Ensures:**

✅ **Tax Compliance:** Feb 2026 payroll uses Feb 2026 tax tables forever  
✅ **Audit Trail:** Exact calculation version + timestamp preserved  
✅ **No Surprise Changes:** If engine updates March 1, Feb payroll unchanged  
✅ **Historical Accuracy:** Reports generated 6 months later show original amounts  

---

## 6. ECOSYSTEM READY (All Future Apps Can Use It)

### Lorenco Accounting Module
```
Needs: Payroll calculations (GL entries)
Uses: /api/payroll/payslips/:period (immutable snapshots)
Never: Recalculates -- reads snapshot only
Benefit: All companies use identical engine logic
```

### Inventory Labour Costing
```
Needs: Hourly rate per employee per period
Uses: backend import → PayrollCalculationService.getHourlyRates()
Never: Modifies payroll data
Benefit: Labour costs always sync with payroll
```

### Sean AI Learning
```
Needs: Learn IRP5 mappings from actual payroll
Uses: Finalized payslips with full calculation breakdown
Never: Touches historical records
Benefit: Sean learns from real usage, not assumptions
```

---

## 7. RISKS MANAGED BY THIS MODEL

| Risk | Mitigation |
|------|-----------|
| **Engine divergence** | Single file, single deploy, single version |
| **Historical changes** | Immutable snapshots, version tagging, forbidden recalc |
| **Multi-app chaos** | Clear API contract, documented output schema |
| **Tax audit failure** | Versioning metadata proves which rules were used |
| **Silent bugs** | All consumers use same code path (not separated logic) |
| **Regression on update** | Comprehensive test suite (already planned Phase 1 Week 1) |
| **Future dependency hell** | Accounting/Inventory designed with this model from day 1 |

---

## 8. APPROVAL CHECKLIST (PRE-IMPLEMENTATION)

### ✅ Architectural Decisions

- [ ] **Location approved:** `accounting-ecosystem/backend/core/payroll-engine.js`
  - Reason: Shared location (not app-specific), backend security, clear import path

- [ ] **Access pattern approved:** Direct import (backend) + API (frontend) + Snapshots (historical)
  - Reason: Balances performance, security, and auditability

- [ ] **Immutability principle approved:** No recalculation of finalized payslips
  - Reason: Tax compliance, audit integrity, SARS safety

- [ ] **Versioning strategy approved:** engineVersion + schemaVersion tagging
  - Reason: Backward compatibility, schema evolution safety

- [ ] **Future consumers approved:** Accounting, Inventory, Sean ready to integrate
  - Reason: Prevents re-architecting later; saves 4-6 weeks future work

### ✅ File Structure

- [ ] Approved structure (backend/core, backend/services, routes)?
- [ ] Approved API endpoint design (/api/payroll/calculate)?
- [ ] Approved supabase schema updates (payslips_finalized)?

### ✅ Implementation Readiness

- [ ] Ownership model understood by stakeholders?
- [ ] No conflicts with Workstream 1 (validation/audit trail)?
- [ ] No conflicts with Workstream 3 (UI/UX)?
- [ ] Ready to proceed with Week 1 implementation?

---

## 9. NEXT STEPS (After Approval)

### Phase: Pre-Implementation (This Week)

**If ALL checkboxes approved:**

1. ✅ Create directory structure
2. ✅ Create placeholder files (README.md, etc.)
3. ✅ Scaffold API endpoints
4. ✅ Update Supabase schema

**Outcome:** Ready for Week 1 engine unification

### Phase 1 Week 1: Engine Unification

- Move Ecosystem engine to `backend/core/`
- Merge with Standalone engine logic
- Add Version + schema version metadata
- Test zero-regression on full-month scenarios

### Phase 1 Week 2: Pro-Rata Implementation

- Implement schedule-based pro-rata
- Integrate into calculateFromData()
- 15+ test cases, all passing

### Phase 1 Week 3: Leave Hook + Final Verification

- Add unpaidLeaveHours parameter
- Create leave-integration.js stub (Phase 2 ready)
- Full regression test suite passes

---

## 10. DECISION REQUIRED FROM USER

**Before code implementation begins, confirm:**

1. **Is this ownership model approved?**
   - Single source of truth location: `backend/core/payroll-engine.js` ✅ YES / ❌ REVISE
   - Access patterns (API + direct import + snapshots): ✅ YES / ❌ REVISE
   - Immutability principle (finalized = locked): ✅ YES / ❌ REVISE

2. **Are you comfortable with this file structure?**
   - backend/core/ (engine) ✅ YES / ❌ REVISE
   - backend/services/ (business logic) ✅ YES / ❌ REVISE
   - backend/routes/ (API) ✅ YES / ❌ REVISE

3. **Ready to lock this model and proceed with Week 1?**
   - ✅ YES — BEGIN IMPLEMENTATION
   - ❌ NO — DISCUSS REVISIONS

---

*This ownership model ensures the Lorenco payroll engine remains a single, auditable, immutable source of truth for all ecosystem applications.*
