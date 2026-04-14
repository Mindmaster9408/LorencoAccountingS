# WORKSTREAM 2 STEP 6 — Backend Services Layer Verification Plan

**Status:** Implementation Complete (Core Services + Endpoint)  
**Completion Date:** 2026-04-12  
**Ready For:** Next Phase Testing & Database Integration

---

## SUMMARY

The backend services layer for unified payroll calculation is now complete and ready for verification. All three core services created, calculation endpoint implemented, and module index updated. Code is production-ready pending verification against live data and database schema implementation.

### Deliverables Completed

| Component | File | Status | Lines |
|-----------|------|--------|-------|
| Data Service | `PayrollDataService.js` | ✅ Complete | 450+ |
| Calculation Service | `PayrollCalculationService.js` | ✅ Complete | 200+ |
| History Service | `PayrollHistoryService.js` | ✅ Complete | 400+ |
| Calculation API | `calculate.js` | ✅ Complete | 320+ |
| Module Index | `index.js` | ✅ Updated | Registration added |

---

## IMMEDIATE NEXT STEPS

### Phase 1: Verification Testing (PRIORITY: URGENT)

**Goal:** Confirm services work correctly with real employee and period data.

**Test Scenario 1: Standard Calculation**
```javascript
// Test script locations to create:
tests/backend/payroll-calculation.test.js

// Test flow:
1. Select real employee + period from Paytime
2. Call PayrollDataService.fetchCalculationInputs()
   → Verify all required fields present
   → Verify decimal hours preserved (e.g., workSchedule.partial_hours = 0.75)
   → Compare normalized input shape against PayrollEngine.calculateFromData() signature
3. Call PayrollCalculationService.calculate(normalizedInputs, {})
   → Verify outputequals direct PayrollEngine call
   → Verify 13 locked fields present + 3 additive pro-rata fields
   → Confirm output validation passes
4. Call PayrollHistoryService.prepareSnapshot()
   → Verify snapshot contract complete (input + output + metadata)
   → Confirm no mutations to calculation output
5. Compare result with direct engine: MUST BE IDENTICAL
```

**Test Scenario 2: Pro-Rata Calculation**
```javascript
// Test with start_date + end_date
1. Select employee with partial month data
2. Call POST /api/payroll/calculate with start_date, end_date
   → Verify prorataFactor present in output
   → Verify expectedHoursInPeriod = days × 8 (or custom hours per day)
   → Verify workedHoursInPeriod = sum of partial_hours across days
   → Compare pro-rata calculation against manual sheet
3. Verify pro-rata fields flow through all services unchanged
```

**Test Scenario 3: Permission Scoping**
```javascript
// Test employee visibility filters
1. Test user with 'public' classification access
2. Test user with 'all' classification access
3. Test user with 'selected' classification (verify specific IDs only)
4. Test user without PAYROLL.VIEW permission (should 403)
5. Test user without payroll module access (should 403)
```

**Test Scenario 4: Error Cases**
```javascript
// Test error handling
1. Invalid employee_id → 400
2. Invalid period_key → 400
3. Employee not found → 404
4. Period not found → 404
5. Employee not visible to user → 403
6. Missing payroll permission → 403
7. Missing payroll module access → 403
8. Calculation service error → 500 with formatted error
```

**How to Execute Tests:**
```bash
# Option A: Manual testing via curl
curl -X POST http://localhost:3000/api/payroll/calculate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "employee_id": 123,
    "period_key": "2026-04",
    "include_snapshot": true
  }'

# Option B: Automated test runner (to be created)
npm test -- tests/backend/payroll-calculation.test.js
```

---

### Phase 2: Database Integration (PRIORITY: HIGH)

**Goal:** Implement snapshot persistence for history tracking and finalization.

**Schema Required:**
```sql
-- Create payroll_snapshots table
CREATE TABLE payroll_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  period_key VARCHAR(7) NOT NULL, -- "2026-04"
  
  -- Calculation data (stored as JSONB for flexibility)
  calculation_input JSONB NOT NULL, -- Full normalized input to engine
  calculation_output JSONB NOT NULL, -- Full output from engine (13 locked + 3 pro-rata)
  
  -- Metadata
  status VARCHAR(50) DEFAULT 'draft', -- 'draft' | 'approved' | 'finalized' | 'posted'
  engine_version VARCHAR(20) NOT NULL, -- e.g., "2026-04-12-v1"
  is_locked BOOLEAN DEFAULT FALSE, -- Immutable after finalization
  
  -- Audit trail
  calculated_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMP,
  approved_by INTEGER REFERENCES users(id),
  finalized_at TIMESTAMP,
  finalized_by INTEGER REFERENCES users(id),
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(company_id, employee_id, period_id),
  CONSTRAINT check_locked_immutable CHECK (
    is_locked = FALSE OR status = 'finalized'
  )
);

-- Indexes for query performance
CREATE INDEX idx_snapshots_company_period ON payroll_snapshots(company_id, period_key);
CREATE INDEX idx_snapshots_employee_period ON payroll_snapshots(employee_id, period_key);
CREATE INDEX idx_snapshots_status ON payroll_snapshots(status);
```

**PayrollHistoryService Updates Required:**
```javascript
// Implement in PayrollHistoryService:

async function storeSnapshot(snapshot, supabase) {
  // Insert snapshot into payroll_snapshots table
  // Return snapshot.id
}

async function markApproved(snapshotId, userId, supabase) {
  // Update status='approved', approved_at=NOW(), approved_by=userId
  // Return updated snapshot
}

async function finalize(snapshotId, userId, supabase) {
  // Update status='finalized', is_locked=true, finalized_at=NOW(), finalized_by=userId
  // Verify immutability rule enforced (no future edits possible)
  // Return updated snapshot
}

async function retrieveSnapshot(snapshotId, supabase) {
  // SELECT from payroll_snapshots WHERE id = snapshotId
  // Verify company context matches
  // Return full snapshot
}
```

**Calculate.js Updates Required:**
```javascript
// In STEP 5 (snapshot preparation), update to:
if (include_snapshot !== false) {
  snapshot = await PayrollHistoryService.prepareSnapshot(...);
  
  // NEW: Persist snapshot to database
  try {
    const storedSnapshot = await PayrollHistoryService.storeSnapshot(
      snapshot,
      supabase
    );
    snapshot._id = storedSnapshot.id; // Include DB ID in response
  } catch (err) {
    console.warn('Snapshot storage failed:', err.message);
    // Warning only, don't fail calculation
  }
}
```

---

### Phase 3: Batch Calculation (PRIORITY: MEDIUM)

**Goal:** Implement pay-run mode for calculating multiple employees in one period.

**Endpoint:** `POST /api/payroll/calculate/batch`

**Implementation Requirements:**
```javascript
// Replace 501 response in calculate.js with real implementation

async function batchCalculate(req, res) {
  // Input validation
  const { period_key, employee_ids, start_date, end_date } = req.body;
  
  // Verify all employee IDs visible to user (permission scoping)
  
  // Execute calculation for each employee (parallel or sequential)
  // Option 1: Parallel with Promise.all() (good for <100 employees)
  // Option 2: Sequential batches of 10 (good for <1000 employees)
  
  // Return array of results:
  // {
  //   success: true,
  //   data: [
  //     { employee_id, period_key, gross, net, paye, ... },
  //     { employee_id, period_key, gross, net, paye, ... },
  //     ...
  //   ],
  //   failed: [
  //     { employee_id, error: "Employee not found" },
  //     ...
  //   ],
  //   summary: { total: 50, succeeded: 49, failed: 1 }
  // }
}
```

---

### Phase 4: History Retrieval (PRIORITY: MEDIUM)

**Goal:** Retrieve finalized payroll snapshots.

**Endpoint:** `GET /api/payroll/calculate/history/:employee_id/:period_key`

**Implementation Requirements:**
```javascript
// Replace 501 response in calculate.js with:

async function retrieveHistory(req, res) {
  // Validate employee visibility
  
  // Query payroll_snapshots table
  // Filter: company_id, employee_id, period_key
  
  // Return full snapshot with:
  // - calculation_input
  // - calculation_output
  // - status (draft/approved/finalized/posted)
  // - timestamps + audit trail
  
  // If not found: 404
  // If access denied: 403
}
```

---

## RISK ASSESSMENT

### Critical Risks (Must Address Before Production)

| Risk | Current State | Mitigation | Timeline |
|------|---------------|-----------|----------|
| **Decimal Hours Corruption** | Services preserve decimals, but need verification | Test Scenario 2 validates decimal flow | Phase 1 |
| **Multi-Tenant Isolation Breach** | All services use explicit company_id, but needs verification | Permission scoping tests (Scenario 3) | Phase 1 |
| **Calculation Output Mutation** | Services preserve 13 locked fields, validation present | Test output against direct engine call | Phase 1 |
| **Snapshot Immutability Violation** | Logic designed, but no DB enforcement yet | Implement schema constraints (Phase 2) | Phase 2 |
| **Missing Employee/Period Data** | Error handling present in services | Test error cases (Scenario 4) | Phase 1 |
| **Performance Under Load** | Untested with many concurrent calculations | Batch mode implementation (Phase 3) | Phase 3 |

### Design Decisions Documented

| Decision | Rationale | Location |
|----------|-----------|----------|
| Snapshot stores COMPLETE data | Avoid reconstruction complexity for finalization | PayrollHistoryService |
| Snapshot status enum (draft/approved/finalized) | Track payroll lifecycle | Database schema |
| Decimal hours enforced at all layers | Pro-rata calculation accuracy | PayrollDataService |
| Employee visibility filters baked into calculate | Permission safety first | calculate.js |
| Service layer never modifies engine output | Calculation integrity | PayrollCalculationService |

---

## CHECKLIST FOR PHASE 1 VERIFICATION

- [ ] **Setup:** Create test database state with known employee/period
- [ ] **Test 1:** Run standard calculation test scenario
- [ ] **Test 1 Validation:**
  - [ ] All decimal hours preserved through pipeline
  - [ ] Normalized input shape matches engine signature
  - [ ] Output matches direct engine call exactly
  - [ ] 13 locked fields present
- [ ] **Test 2:** Run pro-rata test scenario
- [ ] **Test 2 Validation:**
  - [ ] prorataFactor calculated correctly
  - [ ] expectedHoursInPeriod correct
  - [ ] workedHoursInPeriod sum correct
  - [ ] Pro-rata fields flow through services
- [ ] **Test 3:** Run permission scope tests
  - [ ] Public classification access works
  - [ ] All classification access works
  - [ ] Selected classification respects IDs
  - [ ] Missing permission returns 403
- [ ] **Test 4:** Run error case tests
  - [ ] Invalid employee_id returns 400
  - [ ] Invalid period_key returns 400
  - [ ] Missing employee returns 404
  - [ ] Missing period returns 404
  - [ ] Inaccessible employee returns 403
- [ ] **Snapshot:** Verify snapshot contract complete
- [ ] **Documentation:** Update frontend integration docs
- [ ] **Sign-off:** Confirm all tests passing, ready for Phase 2

---

## FILES TO CREATE FOR VERIFICATION

**Test File:** `tests/backend/payroll-calculation.test.js`
- Standard calculation test
- Pro-rata calculation test
- Permission scope tests
- Error case tests

**Integration Doc:** `docs/payroll-backend-integration.md`
- API endpoint reference
- Response schemas
- Error codes and handling
- Frontend integration guide

**Database Migration:** `database/migrations/001_create_payroll_snapshots.sql`
- payroll_snapshots table schema
- Indexes
- Constraints

---

## RELATED DOCUMENTS

- **Audit Document:** `WORKSTREAM2_STEP6_AUDIT.md` (findings, risks, strategy)
- **Working Features Registry:** `WORKING_FEATURES_REGISTRY.md` (to be updated with new services)
- **Architecture Doc:** `docs/ecosystem-architecture.md` (backend sequence diagrams)
- **Engine Spec:** `backend/core/payroll-engine.js` TOP COMMENTS (TIME INPUT STANDARD)

---

## APPROVAL & SIGN-OFF

**Implementation Approved By:** Completing WORKSTREAM 2 STEP 6 requirements (audit, services, endpoints)

**Next Authority:** User approval for Phase 1 verification testing (may proceed autonomously if confirmed)

**Escalation Point:** If Phase 1 tests reveal significant deviations, escalate to CLAUDE.md PART A AUDIT rules

---

*This document is the verification roadmap for backend services layer completion. Keep it updated as testing progresses.*
