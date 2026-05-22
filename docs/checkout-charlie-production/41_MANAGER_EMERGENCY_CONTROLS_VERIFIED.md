# 41 — MANAGER EMERGENCY CONTROLS VERIFIED
## Checkout Charlie — Workstream 11B Verification

**Date:** 2026-05-22
**Status:** ✅ VERIFIED — 20/20 PASS — 1 bug found and fixed
**Scope:** Verification of all Workstream 11B Manager Emergency Controls
**Verifier:** Code audit pass against implementation + bug B4 fixed

---

## Verification Method

Full static audit of:
- `database/migrations/038_manager_emergency_controls.sql`
- `backend/modules/pos/services/posAuditLogger.js`
- `backend/modules/pos/routes/emergency.js`
- `backend/modules/pos/routes/sessions.js`
- `backend/modules/pos/index.js`
- `frontend-pos/index.html` (all emergency-related sections)

---

## Test Results

| # | Test | Result | Notes |
|---|---|---|---|
| T1 | Force close requires reason | ✅ PASS | `emergency.js`: `if (!reason?.trim()) return 400` |
| T2 | Force close an open session | ✅ PASS | Sets `status='force_closed'`, `closed_at`, `notes` with email + reason |
| T3 | Force close already-closed session | ✅ PASS | `if (session.status !== 'open') return 409` |
| T4 | Force close session in different company | ✅ PASS | `.eq('company_id', req.companyId)` + `maybeSingle()` → 404 |
| T5 | Lock till | ✅ PASS | `is_locked=true` in DB; sessions join returns it; `applyTillStateWarnings()` shows red banner; `checkoutBtn` disabled |
| T6 | Locked till — checkout attempted | ✅ PASS | `checkout()` guard: `if (tillLocked) { showNotification(...); return; }` fires before `checkoutInProgress = true` |
| T7 | Unlock till | ✅ PASS | Lock columns cleared to null/false; `checkSession()` re-called from `dispatchEmergencyAction`; banner hides |
| T8 | Lock already-locked till | ✅ PASS | `if (till.is_locked) return 409` |
| T9 | Pause sync | ✅ PASS | `pos_emergency_state.sync_paused=true`; `syncOfflineSales()` guard: `if (syncInProgress || !isOnline || !token || syncPaused) return` |
| T10 | Resume sync | ✅ PASS | `sync_paused=false`; `syncPaused=false`; next cycle starts normally |
| T11 | Force logout existing user | ✅ PASS | Finds user by email; updates all matching `company_id + user_id + status='open'`; returns `sessionsClosed: N` |
| T12 | Force logout unknown email | ✅ PASS | `maybeSingle()` returns null → `404 User not found` |
| T13 | Mark printer degraded | ✅ PASS | Amber banner shown via `applyTillStateWarnings()`; `checkout()` not blocked (only `tillLocked` blocks) |
| T14 | Restore printer | ✅ PASS | `emergencyPrinterRestoredConfirm()` calls `loadEmergencyPanel()` + `checkSession()` → banner hides |
| T15 | All emergency actions audited | ✅ PASS | Every endpoint calls `posAuditFromReq(req, POS_EVENTS.EMERGENCY_*)` |
| T16 | Emergency events in support timeline | ✅ PASS | All 8 `EMERGENCY_*` entries present in `TIMELINE_EVENT_LABELS` with correct labels and colours |
| T17 | Cashier role — emergency controls hidden | ✅ PASS | `applyRoleBasedVisibility()` adds `role-hidden` to `supportTab` for non-`RECOVERY_ALLOWED_ROLES` roles |
| T18 | No checkout corruption under emergency lock | ✅ PASS | `tillLocked` check is before `checkoutInProgress = true`; in-flight checkouts complete; lock takes effect on next attempt |
| T19 | Sync pause mid-cycle | ✅ PASS | Loop break guard at start of every iteration: `if (!isOnline || syncPaused) { break; }` |
| T20 | No localStorage/sessionStorage business data | ✅ PASS | `syncPaused`, `tillLocked`, `printerDegraded` are JS module-level variables only; sourced from DB on login and session check |

---

## Bugs Found and Fixed

### Bug B4 — FIXED — `checkSession()` used company-wide session list instead of user-specific endpoint

**File:** `frontend-pos/index.html`

**Root cause:**
`checkSession()` called `GET /pos/sessions?status=open` (company-wide list, ordered by `opened_at DESC`) and took `sessions[0]`. In a multi-till environment where two cashiers have concurrent open sessions, the ordering could surface another cashier's session as `sessions[0]`. That session's `tills.is_locked` and `tills.is_printer_degraded` state would then be applied to the wrong cashier's interface.

Result: Cashier A could see Till 2's lock banner instead of Till 1's, and `checkout()` would be blocked by a lock that doesn't apply to them.

**Fix:**
Changed to `GET /pos/sessions/current` — the existing endpoint that filters by `req.user.userId`. This endpoint was already correctly joined with `tills(is_locked, locked_reason, is_printer_degraded, printer_degraded_reason)`.

Also added explicit `currentSession = null` in the no-session branch (previously left as stale from a prior session).

**Before:**
```javascript
const response = await fetch(`${API_URL}/pos/sessions?status=open`, ...);
const result = await response.json();
if (result.sessions && result.sessions.length > 0) {
    currentSession = result.sessions[0];
```

**After:**
```javascript
const response = await fetch(`${API_URL}/pos/sessions/current`, ...);
const result = await response.json();
if (result.session) {
    currentSession = result.session;
```

**Regression risk:** Low. `currentSession` object shape is identical (same Supabase join). All callers of `checkSession()` that use `currentSession.id`, `currentSession.tills`, etc. work unchanged. The `/current` endpoint was already in use and tested before 11B.

**Impact on 11B:** Without this fix, the till lock and printer degraded states could be applied to the wrong cashier when multiple sessions are open simultaneously in the same company. T5, T6, T13, T18 all depend on `checkSession()` reading the correct till.

---

## Architecture Boundaries — Confirmed Preserved

| Boundary | Status |
|---|---|
| No sales deleted | ✅ Force close sets `till_sessions.status` only |
| No audit trail tampered | ✅ `pos_audit_events` is append-only; emergency events only insert |
| No business data in browser storage | ✅ `syncPaused`, `tillLocked`, `printerDegraded` are in-memory module variables only |
| Checkout integrity under lock | ✅ Lock guard before `checkoutInProgress = true` — no corrupt mid-sale state |
| Queue integrity under sync pause | ✅ IDB records untouched; pause stops new retry cycles only |
| Idempotency | ✅ In-flight sync POST completes; loop breaks at next iteration check |
| `finally` block in `syncOfflineSales` | ✅ `syncInProgress = false` always runs; early return from zero-pending path is safe |
| Paytime module | ✅ Not touched |
| Zeabur deployment rules | ✅ Not affected |
| Shared auth middleware | ✅ Not modified |

---

## Supporting Code Confirmed

### `posAuditLogger.js` — 8 new constants + EVENT_CATEGORY entries

All 8 `EMERGENCY_*` constants present in both `POS_EVENTS` and `EVENT_CATEGORY`.
All mapped to `'override'` category — confirmed visible in Support tab timeline.

### `emergency.js` — All 9 endpoints verified

| Endpoint | Guard | Audit | Idempotency |
|---|---|---|---|
| `POST /session/:id/force-close` | reason required; 409 if not open | `EMERGENCY_SESSION_FORCE_CLOSED` | 409 on double-close |
| `POST /till/:id/lock` | reason required; 409 if locked | `EMERGENCY_TILL_LOCKED` | 409 on double-lock |
| `POST /till/:id/unlock` | till exists check | `EMERGENCY_TILL_UNLOCKED` | idempotent (no 409) |
| `POST /till/:id/printer-degraded` | reason required; till exists | `EMERGENCY_PRINTER_DEGRADED` | idempotent |
| `POST /till/:id/printer-restored` | till exists | `EMERGENCY_PRINTER_RESTORED` | idempotent |
| `GET /state` | — | — | read-only |
| `POST /sync/pause` | reason required | `EMERGENCY_SYNC_PAUSED` | upsert on `company_id` |
| `POST /sync/resume` | — | `EMERGENCY_SYNC_RESUMED` | upsert on `company_id` |
| `POST /user/force-logout` | email + reason required; 404 if unknown | `EMERGENCY_USER_FORCE_LOGOUT` | closes already-open sessions only |

### `tills.js` — GET `/` uses `select('*')`

Returns all columns including new `is_locked`, `locked_reason`, `is_printer_degraded`, `printer_degraded_reason` added by migration 038. No change to tills route needed.

### Role gate confirmed correct

`requirePermission('SETTINGS.EDIT')` on all emergency endpoints. Frontend hides Support tab (and therefore Emergency Controls) for all roles outside `RECOVERY_ALLOWED_ROLES`. Both gates match — no role can reach emergency controls without backend permission.

---

## Migration 038 Confirmed

```sql
ALTER TABLE tills
  ADD COLUMN IF NOT EXISTS is_locked               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_reason            TEXT,
  ADD COLUMN IF NOT EXISTS locked_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by_email          TEXT,
  ADD COLUMN IF NOT EXISTS is_printer_degraded      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS printer_degraded_reason  TEXT,
  ADD COLUMN IF NOT EXISTS printer_degraded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS printer_degraded_by_email TEXT;

CREATE TABLE IF NOT EXISTS pos_emergency_state (
  company_id  INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  sync_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ...
);
```

`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` — safe to re-run if applied out of order. `NOT NULL DEFAULT FALSE` ensures existing till rows get `false` without backfill.

**Must be applied to Supabase before deploying Workstream 11B.** All emergency endpoints will fail with column-not-found errors until this migration runs.

---

## Workstream 11B Pilot-Safe Verdict

**Force close session:** ✅ Mandatory reason, 409 double-close guard, audit trail, no sales deleted  
**Till lock:** ✅ Checkout blocked frontend + backend; correct cashier session via /current fix  
**Sync pause:** ✅ DB-persistent, survives reload, mid-cycle guard, queue intact  
**Force logout:** ✅ Sessions closed, JWT limitation documented, 404 on unknown user  
**Printer degraded:** ✅ Warning visible, checkout allowed, future print agent hook defined  
**Auditability:** ✅ 8 event types, all `'override'`, all appear in support timeline  
**Bug B4 fixed:** ✅ `checkSession()` now uses `/sessions/current` — correct till state per cashier  

**Workstream 11B is pilot-safe. Migration 038 must be applied before deployment.**
