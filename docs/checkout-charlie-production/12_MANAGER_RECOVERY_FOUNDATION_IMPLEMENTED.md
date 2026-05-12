# 12 — MANAGER RECOVERY + SUPERVISOR CONTROL FOUNDATION IMPLEMENTED
## Checkout Charlie — Workstream 4A

**Date:** 2026-05-12
**Status:** ✅ Implemented
**Files changed:** 4

---

## What Was Implemented

Three components: backend audit events, backend recovery routes, frontend Recovery tab.
No checkout flow changes. No localStorage/sessionStorage for business data.
No new database tables or migrations required.

---

## Files Changed

| File | Change |
|---|---|
| `backend/modules/pos/services/posAuditLogger.js` | 5 new event constants + 5 EVENT_CATEGORY entries |
| `backend/modules/pos/routes/recovery.js` | NEW — 5 recovery endpoints |
| `backend/modules/pos/index.js` | Mount `recoveryRoutes` at `/recovery` |
| `frontend-pos/index.html` | CSS, nav tab, recoveryLayout HTML, showTab updates, applyRoleBasedVisibility update, 10 JS functions |

---

## New Audit Events

Added to `POS_EVENTS` and `EVENT_CATEGORY`:

| Event | Category | When |
|---|---|---|
| `RECOVERY_RETRY_TRIGGERED` | `recovery` | Manager manually retries a queue item |
| `RECOVERY_MARKED_FAILED` | `recovery` | Manager marks a queue item as permanently unrecoverable |
| `RECOVERY_NOTE_ADDED` | `recovery` | Manager adds a recovery note to a queue item |
| `SUPERVISOR_OVERRIDE_GRANTED` | `override` | Supervisor records a manual override action |
| `ABANDONED_SESSION_DETECTED` | `session` | Session health check finds a session open > 8 hours |

All events write to `pos_audit_events` (append-only, migration 028). Failure is non-fatal per the existing logger guarantee.

---

## Backend: `/api/pos/recovery/*`

**Auth:** All endpoints require `requireCompany` + `requirePermission('SETTINGS.EDIT')` (management roles: `business_owner`, `practice_manager`, `administrator`).

### GET `/api/pos/recovery/sessions`

Returns session health in three buckets:

| Bucket | Condition | Notes |
|---|---|---|
| `stale` | `status = 'open'` AND open > 8 hours | Fires `ABANDONED_SESSION_DETECTED` per session found (fire-and-forget) |
| `open` | `status = 'open'` AND open ≤ 8 hours | Normal active sessions |
| `pending_cashup` | `status = 'closed'` | Closed but not yet cashed-up |

Each session record includes `age_hours` (for stale/open) or `closed_age_hours` (for pending_cashup).
Limit: 50 most recent qualifying sessions.

### POST `/api/pos/recovery/queue/retry`

Accepts: `{ temp_sale_number, item_count, previous_status, sync_attempts }`.
Action: fires `RECOVERY_RETRY_TRIGGERED` audit event. Does NOT process the sale — the frontend resets the IndexedDB item to `pending` and calls `syncOfflineSales()` directly.

### POST `/api/pos/recovery/queue/abandon`

Accepts: `{ temp_sale_number, item_count, previous_status, reason }`.
`reason` is required (400 if missing). Fires `RECOVERY_MARKED_FAILED` with reason in `notes` field.

### POST `/api/pos/recovery/queue/note`

Accepts: `{ temp_sale_number, note }`.
`note` is required (400 if missing). Fires `RECOVERY_NOTE_ADDED` with note in `notes` field.

### POST `/api/pos/recovery/override`

Accepts: `{ override_type, reason, target_id?, target_type? }`.
Both `override_type` and `reason` are required (400 if missing).
Allowed `override_type` values:
- `negative_stock_manual`
- `price_override`
- `session_force_close`
- `queue_item_cleared`
- `other`

Fires `SUPERVISOR_OVERRIDE_GRANTED` (awaited — response not sent until audit is confirmed).

---

## Frontend: Recovery Tab

### Nav tab

```html
<button class="nav-tab" onclick="showTab('recovery', event)">Recovery</button>
```

Placed after Settings tab. Hidden for `cashier` and `trainee` roles via `applyRoleBasedVisibility()`.

### Role visibility

```javascript
// In applyRoleBasedVisibility():
if (userRole === 'cashier' || userRole === 'trainee') {
    if (recoveryTab) recoveryTab.classList.add('role-hidden');
}
```

Management roles (`business_owner`, `practice_manager`, `administrator`, `store_manager`, `admin`) see the tab. Cashier and trainee do not.

**NOTE (corrected by doc 13 patch):** `store_manager` IS in `MANAGEMENT_ROLES` in `backend/config/permissions.js` and therefore already has `SETTINGS.EDIT`. The original follow-up note was based on a false assumption. No action required — store_manager has full backend access and sees the tab correctly.

### `showTab` changes

`recoveryLayout` is now included in the hide-all-sections block in both the original `showTab` and the stock override. The recovery case is handled in the original `showTab`:

```javascript
} else if (tab === 'recovery') {
    document.getElementById('recoveryLayout').style.display = 'block';
    loadRecovery();
}
```

### Offline Queue Panel

`getAllQueuedSales()` reads ALL IndexedDB records (not just pending — unlike `getPendingOfflineSales()`).

`renderQueueItems(items)` renders one card per queue item with:
- Status badge (Pending / Failed / Stock Conflict / Session Conflict / Abandoned)
- Sale number, item count, attempt count, payment method
- Last sync error (if any)
- Recovery note (if any)
- Action buttons: Retry, Mark Unrecoverable, Add Note (hidden once abandoned)

#### Retry flow

`retryQueueItem(tempId)`:
1. POSTs audit event to `/api/pos/recovery/queue/retry` (fire-and-forget)
2. Reads item from IndexedDB, resets `status = 'pending'` and `syncAttempts = 0` (fresh attempt budget)
3. Calls `syncOfflineSales()` — same sync path used on reconnect
4. Re-renders the recovery panel

`retryAllRetryable()` applies the same reset to all non-abandoned items, then triggers one `syncOfflineSales()` cycle.

**Critical:** `syncAttempts` is reset to `0` on manager retry. Without this, an item at 3 attempts would immediately re-fail on the next sync cycle (the sync path checks `attempts >= 3`).

#### Mark Unrecoverable flow

`promptAbandonItem()` — uses `prompt()` to require a reason before proceeding.
`markQueueItemAbandoned()`:
1. POSTs audit event to `/api/pos/recovery/queue/abandon` (awaited — reason required)
2. Writes `status = 'abandoned'`, `abandonedAt`, `recoveryNote` to IndexedDB
3. Calls `updateOfflineBanner()` to update the chip counts
4. Re-renders the recovery panel

Abandoned items show in the queue with their note and a greyed-out card. No action buttons are shown for abandoned items. They can be deleted from IndexedDB manually but the audit event is permanent.

#### Add Note flow

`promptAddNote()` — uses `prompt()` for the note text.
`addQueueNote()`:
1. POSTs audit event to `/api/pos/recovery/queue/note` (fire-and-forget)
2. Writes `recoveryNote` and `recoveryNoteAt` to IndexedDB
3. Re-renders the recovery panel

### Session Health Panel

`renderSessionHealth(data)` renders a single table with all stale, open, and pending-cashup sessions sorted stale-first. Each row shows: session ID, till name, cashier name, opened-at time, status badge, age.

Empty state: green "All sessions healthy" message.

### Supervisor Override Panel

`confirmOverride()`:
1. Validates: type selected, reason not empty
2. POSTs to `/api/pos/recovery/override` (awaited)
3. On success: shows confirmation notification, clears form
4. On failure: shows error from backend or connection message

The backend awaits the audit insert before responding, so the notification only fires after the audit event is confirmed written.

---

## Non-Blocking Guarantee

Recovery tooling does NOT touch the checkout flow:
- No changes to `checkout()`, `addToCart()`, `syncOfflineSales()`, `saveOfflineSale()`
- No changes to any sales, products, or session routes
- Recovery endpoints are read/audit-only — they do not modify DB data
- `syncOfflineSales()` called from `retryQueueItem()` uses the existing guard (`syncInProgress`) — if a sync is already running, the second call returns immediately

---

## What Was NOT Changed

- `syncOfflineSales()` — untouched; retry just resets IndexedDB state and calls it
- `getPendingOfflineSales()` — untouched; still filters for pending-only
- `updateOfflineBanner()` — untouched; still reads all queue records inline
- `decrement_stock_v2`, `create_sale_atomic` — untouched
- `sessions.js` route — untouched
- No new database tables or migrations
- No localStorage/sessionStorage for any business data

---

## Verification

### Backend

| Scenario | Expected | Verified |
|---|---|---|
| Cashier POSTs to `/recovery/override` | 403 (no SETTINGS.EDIT) | ✅ `requirePermission('SETTINGS.EDIT')` applied at router level |
| `POST /recovery/override` with no reason | 400 `{ error: 'override_type and reason are both required' }` | ✅ Input validation before audit write |
| `POST /recovery/queue/abandon` with no reason | 400 `{ error: 'reason is required...' }` | ✅ Input validation before audit write |
| Invalid `override_type` | 400 with allowed types listed | ✅ Whitelist check |
| `GET /sessions` with stale sessions | `stale` array populated, `ABANDONED_SESSION_DETECTED` fired per session | ✅ `> STALE_SESSION_HOURS` branch |
| `GET /sessions` — all sessions healthy | `{ open: [], stale: [], pending_cashup: [] }` | ✅ Empty arrays on no match |

### Frontend

| Scenario | Expected | Verified |
|---|---|---|
| Cashier logs in | Recovery tab hidden | ✅ `applyRoleBasedVisibility()` adds `role-hidden` |
| Manager logs in | Recovery tab visible | ✅ No `role-hidden` added for management roles |
| Navigate to Recovery tab | `loadRecovery()` called; queue and session health loaded | ✅ `showTab('recovery')` case |
| Navigate away from Recovery | `recoveryLayout` hidden by original `showTab` hide block | ✅ Added to hide-all section |
| Navigate to Stock | `recoveryLayout` hidden by stock override's explicit hide list | ✅ Added to stock branch |
| Queue empty | Green "Queue is empty" message | ✅ `items.length === 0` branch |
| Retry item — resets attempts | `syncAttempts = 0` in IndexedDB before sync call | ✅ Explicit reset in `retryQueueItem` |
| Mark unrecoverable — no reason | `showNotification` error, no API call | ✅ `prompt()` return value checked |
| Override — no reason | `showNotification` error, no API call | ✅ Client-side validation before fetch |
| Sessions all healthy | Green "All sessions healthy" message | ✅ Empty data check in `renderSessionHealth` |

---

## Remaining Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Manager PIN confirmation for override
- What was done: Override requires reason text — no PIN/password re-entry
- Rationale: Pattern does not yet exist in the codebase (MANAGER_OVERRIDE_USED event
             was pre-defined but route was never wired)
- Risk if not added: Logged-in manager could record overrides without re-authenticating
- Recommended next: Wire PIN re-entry or session re-auth before POST /recovery/override
```

```
FOLLOW-UP NOTE
- Area: Abandoned queue items — permanent removal
- What was done: Abandoned items stay in IndexedDB with status='abandoned'
- Risk: IndexedDB grows unbounded if many items are abandoned over time
- Recommended next: Add a "Clear Abandoned" button that deletes abandoned items from IndexedDB
                    after confirming the audit trail exists (always does — POST /queue/abandon
                    fires before IndexedDB write)
```

```
FOLLOW-UP NOTE
- Area: Cross-device offline queue visibility
- What was done: Recovery panel reads from IndexedDB — device-local only
- Risk: Manager on Device B cannot see Device A's offline queue
- This is inherent to IndexedDB architecture — not a regression
- Recommended next: Future workstream could mirror offline queue state to a
                    server-side table on each sync attempt for cross-device visibility
```

```
FOLLOW-UP NOTE
- Area: Session force-close (override type exists, action does not)
- What was done: 'session_force_close' is a valid override_type — records the audit event
- Not yet confirmed: No backend action to actually close an abandoned session remotely
- Risk if not added: Manager records the override but must manually close the session
                     via the database or the till device
- Recommended next: Wire a POST /api/pos/sessions/:id/force-close endpoint that
                    transitions status from 'open' to 'closed' with SUPERVISOR_OVERRIDE
                    audit event, accessible only with SETTINGS.EDIT permission
```
