---
Type: Backend Architecture Audit
Date: April 12, 2026
Workstream: 2 (Backend Services Integration)
Step: 6 (Unified Payroll Engine Integration)
Status: AUDIT COMPLETE
---

# BACKEND STRUCTURE AUDIT — WORKSTREAM 2 STEP 6

## CURRENT STATE

### Directory Structure
```
backend/
  ├── core/
  │   ├── payroll-engine.js          ← UNIFIED ENGINE (production-ready)
  │   ├── payroll-engine.regression-tests.js
  │   └── run-tests.js
  │
  ├── modules/
  │   └── payroll/
  │       ├── index.js               ← Routes aggregator
  │       ├── routes/
  │       │   ├── employees.js       ← Employee CRUD
  │       │   ├── items.js           ← Payroll items CRUD
  │       │   ├── periods.js         ← Period management
  │       │   ├── transactions.js    ← Payslip listing
  │       │   ├── attendance.js      ← Attendance tracking
  │       │   ├── recon.js           ← Reconciliation
  │       │   ├── kv.js              ← Key-value store
  │       │   ├── unlock.js          ← Payslip unlock
  │       │   └── sean-integration.js
  │       └── services/
  │           └── paytimeAccess.js   ← Permission/visibility control ONLY
  │
  ├── services/
  │   └── documentParsers/           ← Non-payroll services
  │
  └── server.js                      ← Express app entry
```

### What Exists

✅ **Unified Engine**
- Location: `/backend/core/payroll-engine.js`
- Status: Production-ready, fully tested (10 regression + 5 pro-rata tests passing)
- Exports: PayrollEngine module with:
  - `calculateFromData()` — main calculation
  - `calculateWithProRata()` — pro-rata wrapper
  - Locked 13-field output contract + 3 additive pro-rata fields

✅ **Payroll Module Structure**
- Location: `/backend/modules/payroll/`
- Routes: employees, items, periods, transactions, attendance, recon, kv, unlock
- Services: paytimeAccess.js (access control only)

✅ **Database Tables** (inferred from routes)
- `payroll_periods` — pay period definitions
- `payroll_transactions` — payslip records
- `payroll_items` — payroll item master data
- `employees` — employee master data
- `paytime_user_config` — access control config
- `paytime_employee_access` — employee visibility rules
- `company_payroll_settings` — company-level settings

✅ **API Pattern**
- Base: `/api/payroll/`
- Auth: `authenticateToken` middleware
- Company isolation: `requireCompany` middleware
- Permissions: `requirePermission()` middleware

### What Does NOT Exist

❌ **PayrollDataService**
- No service to fetch and normalize calculation inputs
- Routes do not retrieve raw payroll data for calculations
- No input normalization (data → engine-ready format)

❌ **PayrollCalculationService**
- No service to orchestrate engine calls
- Unified engine is NOT being used by any route currently
- No calculation request handler

❌ **PayrollHistoryService**
- No snapshot preparation for finalized payroll
- No immutable snapshot storage structure defined
- No historical payroll retrieval service

❌ **Calculation API Endpoint**
- No POST /api/payroll/calculate endpoint
- No clean backend path for calculation execution
- Frontend likely handling calculations page-side (OBSERVATION)

❌ **Input Normalization Contract**
- No defined normalized input shape for the engine
- Data retrieval is scattered across multiple possible locations

❌ **Snapshot-Ready Output Contract**
- No defined structure for immutable payroll snapshots
- Snapshot preparation path not documented or wired

---

## RISKS & CONSTRAINTS

### Risk 1: Missing Calculation Triggering
The unified engine exists but is never called. Routes accept payroll data but don't run calculations.
- **Impact**: Paytime frontend likely has its own calculation logic (embedded)
- **Mitigation**: Introduce calculation service layer without breaking existing frontend

### Risk 2: Calculation Data Scattered
Payroll data lives across multiple endpoints and sources:
- employees (master data)
- items (payroll item definitions)
- periods (period context)
- transactions (current inputs?)
- attendance (time-based inputs?)
- No single source for "fetch everything needed to run engine"
- **Impact**: Normalization is complex; easy to miss required fields
- **Mitigation**: Define clear normalized input contract; build service to assemble it

### Risk 3: Immutability Contract Undefined
No design for snapshot-ready payroll storage and retrieval.
- **Impact**: Future finalization work will be difficult without snapshot architecture
- **Mitigation**: Design snapshot contract NOW; implement storage hooks even if full finalization is later

### Risk 4: Decimal Hours Must Be Preserved
Service layer must NOT convert decimal hours to HH:MM or lose precision.
- **Impact**: Pro-rata calculations depend on accurate hourly inputs
- **Mitigation**: Document decimal-hour handling; validate in service data fetch

### Risk 5: Multi-Tenant Safety
Every service call must respect company_id context.
- **Impact**: Cross-company data leakage if not careful
- **Mitigation**: Service methods must accept company_id explicitly; no implicit context

### Risk 6: Existing Routes Must Not Break
Paytime frontend may be relying on existing route patterns.
- **Impact**: Changes to existing routes could break running system
- **Mitigation**: Add NEW calculation services; do NOT refactor existing routes

---

## AUDIT FINDINGS SUMMARY

| Area | Status | Finding |
|------|--------|---------|
| Engine Location | ✅ Clear | `/backend/core/payroll-engine.js` |
| Engine Quality | ✅ Good | Unified, tested, production-ready |
| Module Structure | ✅ Good | Payroll module exists, routes organized |
| Calculation Service | ❌ Missing | Engine not integrated into routes |
| Data Service | ❌ Missing | No unified data fetch/normalization |
| History Service | ❌ Missing | No snapshot preparation |
| Calc API | ❌ Missing | No calculation trigger endpoint |
| Input Normalization | ❌ Missing | No defined contract |
| Snapshot Contract | ❌ Missing | No immutable output structure |
| Multi-Tenant Safety | ✅ Good | Middleware in place; company_id enforced |
| Decimal Hours | ✅ Preserved | Engine configured correctly |
| Pro-Rata | ✅ Ready | Hours-based, fully tested |

**Readiness for Step 6:** Backend structure is READY for services layer integration.

---

## INTEGRATION STRATEGY

### Insertion Points (Safe)
1. **New services files** in `/backend/modules/payroll/services/`
   - PayrollDataService.js
   - PayrollCalculationService.js
   - PayrollHistoryService.js
   - Do NOT modify existing paytimeAccess.js

2. **New routes** in `/backend/modules/payroll/routes/` OR add to `/backend/modules/payroll/index.js`
   - POST /api/payroll/calculate (new calculation endpoint)
   - Do NOT modify existing route files unless absolutely necessary

3. **Engine integration** in calculation service
   - Import PayrollEngine from `/backend/core/payroll-engine.js`
   - Call engine methods within calculation service
   - Engine remains pure and untouched

### Transitional Risks (Low)
- Existing routes remain unchanged → no regression risk
- New services are additive → no breaking changes
- Frontend can gradually migrate to new calculation endpoint
- Old page-level logic can coexist temporarily

### Adoption Path (Phased)
**Phase 1 (This step):** Implement calculation service layer
- Create services, define contracts
- Wire new /api/payroll/calculate endpoint
- Verify outputs match engine directly

**Phase 2 (Later step):** Frontend integration
- Paytime frontend calls new endpoint
- Phase out page-level calculation logic
- Gradually migrate to backend authority

**Phase 3 (Finalization step):** Snapshot persistence
- Implement finalization snapshot storage
- Full immutable payroll history

---

## NEXT STEP

Proceed to STEP 2 (Plan) then STEP 3 (Implement):

1. Design normalized input contract
2. Design snapshot-ready output contract
3. Implement three services
4. Implement calculation endpoint
5. Verify calculations produce engine output
6. Verify no regressions in unlock/existing logic

---

*Audit completed: April 12, 2026*
*Ready to proceed to Implementation Phase*
