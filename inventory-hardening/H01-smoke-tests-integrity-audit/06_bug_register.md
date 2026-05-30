# H01 — Bug Register

**Date:** 2026-05-30
**Status:** All CRITICAL/HIGH bugs fixed in H01. MEDIUM/LOW documented.

---

## BUG H01-001 — CRITICAL: procurement.js routes missing permission gates

**Severity:** HIGH (blocking)
**Module:** Procurement
**Files:** `backend/modules/inventory/routes/procurement.js`

**Error:** 4 routes (GET /suggestions, GET /supplier-history, POST /supplier-history/:id/set-preferred, GET /overdue-pos) had no `requirePerm()` middleware. Any authenticated user could access them.

**Reproduction:** `GET /api/inventory/procurement/suggestions` with a cashier JWT.
**Expected:** 403 Insufficient permissions.
**Actual (pre-fix):** 200 OK with procurement data.
**Cause:** Routes were not included in the CB11 permission sweep.

**Fix applied:** Added `requirePerm(PERM.REPORTS_VIEW)` to suggestions + overdue-pos, `requirePerm(PERM.COST_VIEW)` to supplier-history, `requirePerm(PERM.PO_APPROVE)` to set-preferred.

**Blocking pilot?** YES — cost data (supplier pricing) was accessible to all authenticated users.
**Status:** ✓ FIXED

---

## BUG H01-002 — CRITICAL: reservations.js routes missing permission gates

**Severity:** HIGH (blocking)
**Module:** Reservations
**Files:** `backend/modules/inventory/routes/reservations.js`

**Error:** All 7 routes had no permission middleware. `POST /manual-hold` allowed any authenticated user to create a stock hold (reducing available stock) without ADJUST permission.

**Reproduction:** `POST /api/inventory/reservations/manual-hold` with a cashier JWT → creates a stock hold.
**Expected:** 403.
**Actual (pre-fix):** 201 Created.
**Cause:** Routes were not included in the CB11 permission sweep.

**Fix applied:**
- All 5 GET routes: `requirePerm(PERM.VIEW)`
- `POST /reports/shortages`: `requirePerm(PERM.REPORTS_VIEW)`
- `POST /manual-hold`: `requirePerm(PERM.ADJUST)` (management only — stock hold is high-risk)
- `POST /:id/release`: `requirePerm(PERM.VIEW)`

**Blocking pilot?** YES — any user could create manual stock holds.
**Status:** ✓ FIXED

---

## BUG H01-003 — HIGH: warehouse-locations.js routes missing permission gates

**Severity:** HIGH
**Module:** Warehouse Locations
**Files:** `backend/modules/inventory/routes/warehouse-locations.js`

**Error:** All 5 routes (3 GET + 2 POST/PUT) had no permission middleware.

**Fix applied:**
- 3 GET routes: `requirePerm(PERM.VIEW)`
- POST (create location): `requirePerm(PERM.CONFIGURE)`
- PUT (update location): `requirePerm(PERM.CONFIGURE)`

**Blocking pilot?** YES — any user could create/modify warehouse bin locations.
**Status:** ✓ FIXED

---

## BUG H01-004 — MEDIUM: reservations.js manual-hold sourceId = companyId

**Severity:** MEDIUM
**Module:** Reservations
**Files:** `backend/modules/inventory/routes/reservations.js`, line 107 (pre-fix)

**Error:** `sourceId: req.companyId` in the manual-hold creation. The `sourceId` field is supposed to identify the source document (a WO id, SO id, or reference). Using company_id makes every manual hold have the same source_id as all other company records — breaking traceability.

**Impact:** Querying `GET /reservations/source/manual_hold/:companyId` would return ALL manual holds for the company rather than a specific one. Audit trail is degraded.

**Fix applied:** `sourceId: reference || null` — uses the caller-provided reference, which is the human-meaningful identifier.

**Blocking pilot?** NO — the hold is created correctly, only traceability is degraded.
**Status:** ✓ FIXED

---

## BUG H01-005 — MEDIUM: _tabLoaded stale cache pattern

**Severity:** MEDIUM
**Module:** Frontend
**Files:** `frontend-inventory/index.html`, `switchTab()` function

**Error:** The `_tabLoaded` dictionary caches whether a tab has been initialized. Once `_tabLoaded['workorders'] = true`, navigating away and back to the WO tab does NOT trigger `loadWorkOrders()`. If a WO was completed from a different flow, the WO list remains stale.

**Reproduction:**
1. Open Work Orders tab → WO list loads.
2. Navigate to Dashboard.
3. Complete a WO from another screen (e.g., via API).
4. Return to Work Orders tab → stale list, WO still shows "in_progress".

**Expected:** Tab refresh on return.
**Actual:** Stale data. User must manually click Refresh.

**Impact:** UX confusing, not a data corruption issue. Backend state is always correct.

**Mitigation in place:** Individual action handlers (complete, cancel, etc.) call `loadWorkOrders()` explicitly. Issue only affects external changes (e.g., another user completing a WO in a different tab).

**Recommended fix:** Reset `_tabLoaded['workorders']` = false after any WO mutation, or add auto-refresh on tab focus. Non-blocking for pilot.

**Blocking pilot?** NO.
**Status:** OPEN (low priority, documented)

---

## BUG H01-006 — LOW: Duplicate esc() function definition

**Severity:** LOW
**Module:** Frontend
**Files:** `frontend-inventory/index.html` lines 5151 and 5726

**Error:** `esc()` was defined twice. First at line 5151 (correct, includes `"` escaping), second at line 5726 inside an `if (typeof esc !== 'function')` guard. The guard prevented it from overriding the first. The second definition was weaker (missing `"` escaping).

**Fix applied:** Removed the second definition. Only the first (correct) definition remains.

**Blocking pilot?** NO.
**Status:** ✓ FIXED

---

## BUG H01-007 — LOW: No validation that actual_output_qty > 0 in WO complete

**Severity:** LOW
**Module:** Manufacturing
**Files:** `backend/modules/inventory/routes/work-orders.js`

**Error:** If a caller sends `actual_output_qty: 0` to the WO complete endpoint, the batch record will store `actual_output_qty: 0`. The `computeBatchOutputCost()` function handles this safely (returns `null` for cost_per_actual_unit when qty is 0), but no validation error is returned.

**Impact:** A batch could theoretically be recorded as producing 0 output units. Costing would show null. Not a corruption risk, just logically wrong.

**Recommended fix:** Add `if (actual_output_qty !== null && parseFloat(actual_output_qty) <= 0) return res.status(400).json({...})`.

**Blocking pilot?** NO — requires deliberate misuse.
**Status:** OPEN (future hardening)

---

## Summary

| Bug | Severity | Status | Blocking |
|---|---|---|---|
| H01-001: procurement.js no permissions | HIGH | ✓ FIXED | Was YES |
| H01-002: reservations.js no permissions | HIGH | ✓ FIXED | Was YES |
| H01-003: warehouse-locations.js no permissions | HIGH | ✓ FIXED | Was YES |
| H01-004: manual-hold sourceId=companyId | MEDIUM | ✓ FIXED | NO |
| H01-005: _tabLoaded stale cache | MEDIUM | OPEN | NO |
| H01-006: Duplicate esc() | LOW | ✓ FIXED | NO |
| H01-007: actual_output_qty no validation | LOW | OPEN | NO |
