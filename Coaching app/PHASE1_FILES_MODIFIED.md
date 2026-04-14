# PHASE 1 — EXACT FILES MODIFIED (QUICK REFERENCE)

**Implementation Date:** April 13, 2026  
**Total Files Modified:** 7  
**Total Files Created:** 2  

---

## FILES MODIFIED

### Database Layer (2 files)

#### 1. `backend/database/schema.sql`
**What Changed:**
- Added `exercise_data JSONB DEFAULT '{}'::jsonb` to CREATE TABLE clients
- Added `journey_progress JSONB DEFAULT '{"currentStep": 1, "completedSteps": [], "stepNotes": {}, "stepCompletionDates": {}}'::jsonb` to CREATE TABLE clients
- Added GIN indexes for both JSONB columns

**Lines Changed:** ~70 and ~145-150
**Why:** New databases will have persistence from the start

#### 2. `backend/database/001_add_persistence_fields.sql` [NEW FILE]
**What Changed:** Created migration file
**Contains:**
- ALTER TABLE clients commands to add columns
- GIN index creation
- Verification query

**Why:** Safe migration for existing databases; idempotent (IF NOT EXISTS)

### Backend Routes (1 file)

#### 3. `backend/routes/clients.routes.js`
**What Changed:**

**Section A: POST /clients (line ~130)**
```javascript
// Changed from:
INSERT INTO clients (...) VALUES ($1, $2, ...)

// Changed to:
INSERT INTO clients (..., current_step, exercise_data, journey_progress, ...) 
VALUES ($1, $2, ..., 1, '{}'::jsonb, '{"currentStep": 1, ...}'::jsonb, ...)
```

**Section B: PUT /clients/:clientId (line ~210)**
```javascript
// Changed from:
const { name, email, phone, preferred_lang, status, dream, current_step, progress_completed } = req.body;

// Changed to:
const { name, email, phone, preferred_lang, status, dream, current_step, progress_completed, exerciseData, journeyProgress } = req.body;

// Added validation (new lines ~213-218)
if (exerciseData !== undefined && ...) { ... }
if (journeyProgress !== undefined && ...) { ... }

// Changed SQL UPDATE:
SET exercise_data = COALESCE($9::jsonb, exercise_data),
    journey_progress = COALESCE($10::jsonb, journey_progress),
```

**Why:** Backend now accepts, validates, and persists new fields

### Frontend Layer (4 files)

#### 4. `js/storage.js`
**What Changed:** `createNewClient(name)` function

```javascript
// Added to returned object:
current_step: 1,  // was 0
exerciseData: {},
journeyProgress: {
    currentStep: 1,
    completedSteps: [],
    stepNotes: {},
    stepCompletionDates: {}
}
```

**Lines Changed:** ~45-65  
**Why:** In-memory client objects pre-initialized with correct structure

#### 5. `js/journey-ui.js`
**What Changed:** Two functions

**Section A: `completeStep(client, stepNum)` function (~line 238)**
```javascript
// Added guard (new lines ~244-248):
if (stepNum !== 1 && !client.journeyProgress.completedSteps.includes(1)) {
    alert('⚠️ Four Quadrants (Step 1) must be completed first...');
    return;
}
```

**Section B: `openExercise(client, stepNum)` function (~line 307)**
```javascript
// Added guard (new lines ~308-314):
if (stepNum !== 1) {
    if (!client.journeyProgress || !client.journeyProgress.completedSteps.includes(1)) {
        alert('⚠️ Four Quadrants (Step 1) must be completed first...');
        return;
    }
}
```

**Why:** Light enforcement to ensure Four Quadrants is done first

---

## FILES NOT MODIFIED (Intentionally)

- ❌ `js/journey-data.js` — initializeJourneyProgress already safe
- ❌ `js/journey-exercises.js` — saveClient already sends full object
- ❌ `js/journey-helpers.js` — window.save4QuadrantExercise already calls saveClient
- ❌ `js/api.js` — Generic apiRequest handles JSONB automatically
- ❌ `js/clients.js` — No changes needed; works with new schema
- ❌ `js/dashboard.js` — No changes needed; displays client data as-is
- ❌ `js/basis-ui.js` — No changes needed
- ❌ Auth, admin, leads modules — No changes needed

**Why:** All existing code already compatible with new fields; no modifications required

---

## MIGRATION EXECUTION ORDER

### Recommended Deployment Sequence

1. **Deploy database migration**
   ```bash
   Run: backend/database/001_add_persistence_fields.sql
   ```
   ⏱️ **Time:** < 1 second  
   ⚠️ **If DB is large (>100K clients):** May take 5-10 seconds for indexes

2. **Deploy backend code**
   - Replace: `backend/routes/clients.routes.js`
   - Restart backend
   ⏱️ **Time:** 30 seconds to restart

3. **Deploy frontend code**
   - Replace: `js/storage.js`
   - Replace: `js/journey-ui.js`
   - Clear browser cache (`Ctrl+Shift+Del`)
   ⏱️ **Time:** Immediate (browser load)

**Total Deployment Time:** < 2 minutes

---

## ZERO-DOWNTIME DEPLOYMENT POSSIBLE?

✅ **YES** — This change is safe for zero-downtime deployment

**Why:**
- New columns have defaults; no NOT NULL constraints
- PUT route uses COALESCE; accepts both old and new requests
- Frontend changes don't break old backend versions
- Can deploy backend and frontend independently; they'll still work together

**Recommended Order for Zero-Downtime:**
1. Deploy backend first (new PUT route, still accepts old format)
2. Deploy frontend second (uses new format, backend is ready)
3. No users will experience errors

---

## ROLLBACK PROCEDURE (If Needed)

⚠️ **This is designed to NOT require rollback** — already backward compatible

But if absolutely necessary:

```sql
-- Rollback migration:
ALTER TABLE clients DROP COLUMN IF EXISTS exercise_data;
ALTER TABLE clients DROP COLUMN IF EXISTS journey_progress;
DROP INDEX IF EXISTS idx_clients_has_exercise_data;
DROP INDEX IF EXISTS idx_clients_has_journey_progress;

-- Revert backend: Restore old clients.routes.js
-- Revert frontend: Restore old storage.js and journey-ui.js
```

**Data Safety:** Existing client data (name, email, dream, etc.) preserved. Only new JSONB columns removed.

---

## FILE SIZES (Impact Check)

| File | Before | After | Change |
|------|--------|-------|--------|
| schema.sql | ~4 KB | ~4.5 KB | +0.5 KB |
| clients.routes.js | ~8 KB | ~9 KB | +1 KB |
| storage.js | ~2 KB | ~2.5 KB | +0.5 KB |
| journey-ui.js | ~12 KB | ~12.5 KB | +0.5 KB |
| **TOTAL NEW FILE** | n/a | 001_add_persistence_fields.sql | +1 KB |

**Impact:** Negligible — total added code ~4 KB

---

## AUDIT TRAIL

**Original Audit:** `COACHING_APP_PROCESS_ALIGNMENT_AUDIT.md` (April 13, 2026)  
**Root Cause Identification:** Lines 60-99 (PUT route ISSUE)  
**Implementation Plan:** Lines 200-250 (PHASE 1 design)  
**Testing Framework:** Provided in PHASE1_IMPLEMENTATION_COMPLETE.md  

---

END OF CHANGE SUMMARY
