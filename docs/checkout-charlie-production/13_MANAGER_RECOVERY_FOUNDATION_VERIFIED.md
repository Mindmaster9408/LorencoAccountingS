# 13 — MANAGER RECOVERY FOUNDATION VERIFIED + PATCHED
## Checkout Charlie — Workstream 4A Verification + Patch

**Date:** 2026-05-12
**Status:** ✅ Verified and patched — no blocking bugs remain
**Files changed by patch:** `frontend-pos/index.html` (3 edits), `12_MANAGER_RECOVERY_FOUNDATION_IMPLEMENTED.md` (2 doc corrections)

---

## Patch Summary

Four issues were identified in static analysis of Workstream 4A and fixed in this session.

| ID | Severity | Issue | Resolution |
|---|---|---|---|
| M1 | Medium | Recovery tab visible to intermediate roles lacking backend access | Fixed — allowlist in `applyRoleBasedVisibility()` |
| L1 | Low | `isConflict` dead variable in `renderQueueItems` | Fixed — removed |
| L2 | Low | XSS risk: free-text fields rendered via innerHTML without escaping | Fixed — `escHtml()` applied |
| D1 | Doc error | Doc 12 incorrectly stated `store_manager` lacks `SETTINGS.EDIT` | Fixed — doc 12 corrected |

---

## Fixes Applied

### Fix M1 — Role visibility aligned with backend MANAGEMENT_ROLES

**Location:** `frontend-pos/index.html` — `applyRoleBasedVisibility()`

**Before:**
```javascript
if (userRole === 'cashier' || userRole === 'trainee') {
    if (recoveryTab) recoveryTab.classList.add('role-hidden');
}
```

**After:**
```javascript
const RECOVERY_ALLOWED_ROLES = [
    'super_admin', 'business_owner', 'practice_manager', 'administrator',
    'accountant', 'corporate_admin', 'store_manager', 'payroll_admin', 'admin',
];
if (!RECOVERY_ALLOWED_ROLES.includes(userRole)) {
    if (recoveryTab) recoveryTab.classList.add('role-hidden');
}
```

`RECOVERY_ALLOWED_ROLES` is an exact copy of `MANAGEMENT_ROLES` from `backend/config/permissions.js`. Any role not on this list — including `shift_supervisor`, `senior_cashier`, `assistant_manager`, `leave_admin`, `trainee`, `cashier` — cannot see the Recovery tab. The backend `requirePermission('SETTINGS.EDIT')` enforces the same set server-side, so frontend visibility and backend access now align exactly.

**Why an allowlist over a blocklist:** The role set is open-ended. New roles added to the system in future would be hidden by default (safe) rather than visible by default (unsafe).

---

### Fix L1 — Dead `isConflict` variable removed

**Location:** `frontend-pos/index.html` — `renderQueueItems()`

**Removed:**
```javascript
const isConflict = st === 'conflict_stock' || st === 'conflict_session';
```

This variable was computed but never referenced. Conflict items were already handled correctly by `isRetryable = !isAbandoned` and `canAbandon = !isAbandoned`, which show all three action buttons for conflict items. Removing the variable has no functional effect.

---

### Fix L2 — HTML escaping for free-text fields in recovery panel

**Location:** `frontend-pos/index.html` — new `escHtml()` function + `renderQueueItems()`

**Added:**
```javascript
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
```

**Applied to all free-text fields rendered via innerHTML:**

| Field | Source | Previously | Now |
|---|---|---|---|
| `sale.tempSaleNumber` | `'OFFLINE-' + Date.now()` — safe, but escaped for consistency | Unescaped | `escHtml(...)` |
| `sale.lastSyncError` | Backend API error strings | Unescaped | `escHtml(...)` |
| `sale.recoveryNote` | `prompt()` user input | Unescaped | `escHtml(...)` |

Fields NOT escaped (correct — not user-controllable free text inserted into HTML):
- `sale.status` — used as CSS class name; value comes from a fixed set (`pending`, `failed`, `conflict_stock`, `conflict_session`, `abandoned`)
- `statusLabel[st]` — hardcoded string map; never from external data
- `sale.tempId` — IndexedDB autoincrement integer; used in `onclick` attribute only
- `safeNum` — already sanitised with `.replace(/'/g, '')` for onclick attribute safety

`escHtml()` is scoped to the recovery section. It is a simple function (5 replace calls) with no external dependencies and no side effects on the checkout path.

---

### Fix D1 — Doc 12 store_manager note corrected

**Location:** `docs/checkout-charlie-production/12_MANAGER_RECOVERY_FOUNDATION_IMPLEMENTED.md`

The original doc 12 contained a follow-up note asserting that `store_manager` is NOT in `MANAGEMENT_ROLES` and would receive 403 from recovery endpoints. This was false.

Confirmed from `backend/config/permissions.js`:
```javascript
const MANAGEMENT_ROLES = [
    'super_admin', 'business_owner', 'practice_manager', 'administrator',
    'accountant', 'corporate_admin', 'store_manager', 'payroll_admin', 'admin'
];
```

`store_manager` is in `MANAGEMENT_ROLES`. It therefore has `SETTINGS.EDIT` and full access to all recovery endpoints. Both the inline follow-up note and the end-of-doc follow-up note in doc 12 have been corrected.

---

## Verification Results (Post-Patch)

### Recovery tab visibility

| Role | Frontend tab | Backend access | Consistent |
|---|---|---|---|
| `super_admin` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `business_owner` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `practice_manager` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `administrator` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `accountant` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `corporate_admin` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `store_manager` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `payroll_admin` | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `admin` (legacy) | Visible | ✅ MANAGEMENT_ROLES | ✅ |
| `shift_supervisor` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |
| `assistant_manager` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |
| `leave_admin` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |
| `senior_cashier` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |
| `cashier` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |
| `trainee` | **Hidden** | ❌ Not in MANAGEMENT_ROLES | ✅ |

All roles are now consistent: visible ↔ has backend access, hidden ↔ gets backend 403. No role sees a broken panel.

---

### Queue item display

| Status | Card border | Badge | Retry | Abandon | Note |
|---|---|---|---|---|---|
| `pending` / null | Blue left | Pending | ✅ | ✅ | ✅ |
| `failed` | Red left | Failed | ✅ | ✅ | ✅ |
| `conflict_stock` | Amber left | Stock Conflict | ✅ | ✅ | ✅ |
| `conflict_session` | Amber left | Session Conflict | ✅ | ✅ | ✅ |
| `abandoned` | Grey left, 0.7 opacity | Abandoned | — | — | — |

Free-text fields (`tempSaleNumber`, `lastSyncError`, `recoveryNote`) all HTML-escaped before insertion. ✅

---

### Retry action

1. `RECOVERY_RETRY_TRIGGERED` audit event fires (fire-and-forget). ✅
2. `syncAttempts` reset to `0` in IndexedDB — fresh 3-attempt budget. ✅
3. `status` reset to `'pending'` — picked up by `getPendingOfflineSales()`. ✅
4. `syncOfflineSales()` called — uses existing `syncInProgress` guard. ✅

---

### Mark Unrecoverable

- Frontend `prompt()` enforces non-empty reason. ✅
- Backend `POST /queue/abandon` enforces non-empty reason (400 if missing). ✅
- `RECOVERY_MARKED_FAILED` fired with reason in `notes` field. ✅
- IndexedDB `status = 'abandoned'`, `abandonedAt`, `recoveryNote` written. ✅
- `updateOfflineBanner()` called — chip counts update. ✅

---

### Add Note

- Frontend `prompt()` enforces non-empty note. ✅
- Backend `POST /queue/note` enforces non-empty note (400 if missing). ✅
- `RECOVERY_NOTE_ADDED` fired. ✅
- Note persists in IndexedDB; renders on next `loadRecovery()`. ✅

---

### Supervisor Override

- Client-side: type and reason both required before fetch. ✅
- Backend: type whitelist + empty-reason check. ✅
- `SUPERVISOR_OVERRIDE_GRANTED` is **awaited** — notification only fires after DB write confirmed. ✅
- Form cleared on success. ✅

---

### Session Health

- Stale sessions (open > 8 hours): correctly bucketed to `stale[]`, rendered first with amber badge. ✅
- `ABANDONED_SESSION_DETECTED` fires per stale session (fire-and-forget). ✅
- Pending cashup (status = `closed`): correctly bucketed to `pending_cashup[]`, pink badge. ✅
- Normal open sessions: `open[]`, green badge. ✅
- All-healthy empty state: green "All sessions healthy" message. ✅

---

### Checkout flow

No changes to `checkout()`, `addToCart()`, `syncOfflineSales()`, `saveOfflineSale()`, `getPendingOfflineSales()`, `deleteOfflineSale()`, `updateOfflineSaleStatus()`, or any sales/session/products API routes.

The `showTab` hide block has one additional `getElementById('recoveryLayout')` call per tab switch — O(1) DOM lookup, negligible. ✅

---

### localStorage / sessionStorage

Zero new business data written to browser storage. All recovery state is either:
- In `pos_audit_events` (append-only DB table — permanent record)
- In IndexedDB queue items as transient metadata (`recoveryNote`, `abandonedAt`) — display-only, not source of truth for confirmed sales

✅ Rule D1 (CLAUDE.md Part D) is satisfied.

---

## Open Follow-Up Notes

These are not bugs. They are tracked gaps with no blocking risk.

```
FOLLOW-UP NOTE
- Area: ABANDONED_SESSION_DETECTED audit volume
- What was done: Event fires on every GET /recovery/sessions call for each stale session
- Risk: A session abandoned for days generates one event per manager health-check view
- Recommended next: If audit log volume becomes a concern, add a deduplication
                    check (e.g. suppress if an event was already fired in the last 1h
                    for the same session_id)
```

```
FOLLOW-UP NOTE
- Area: Manager PIN / re-auth for supervisor override
- What was done: Override requires reason text but no credential re-entry
- Risk: A logged-in manager can record overrides without re-authenticating
- Recommended next: Wire credential confirmation (password or PIN) to POST /recovery/override
                    once the pattern is established elsewhere in the codebase
```

```
FOLLOW-UP NOTE
- Area: Abandoned queue item cleanup
- What was done: Abandoned items remain in IndexedDB indefinitely with status='abandoned'
- Risk: IndexedDB grows over time with unremovable abandoned items
- Recommended next: Add a "Clear Abandoned" bulk delete button that removes
                    abandoned items from IndexedDB after confirming audit events exist
```

```
FOLLOW-UP NOTE
- Area: Cross-device offline queue visibility
- What was done: Recovery panel reads from local device's IndexedDB only
- Inherent architectural constraint: IndexedDB is per-device, per-browser
- Recommended next: Future workstream could mirror queue state to a server-side
                    table on each sync attempt for cross-device manager visibility
```

```
FOLLOW-UP NOTE
- Area: Session force-close backend action
- What was done: 'session_force_close' override type records an audit event only
- Not yet implemented: No endpoint to actually close an abandoned session remotely
- Recommended next: POST /api/pos/sessions/:id/force-close restricted to SETTINGS.EDIT,
                    transitions status 'open' → 'closed', fires SUPERVISOR_OVERRIDE_GRANTED
```
