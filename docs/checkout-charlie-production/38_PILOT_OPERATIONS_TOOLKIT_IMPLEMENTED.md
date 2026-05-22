# 38 — PILOT OPERATIONS TOOLKIT IMPLEMENTED
## Checkout Charlie — Workstream 11A

**Date:** 2026-05-22
**Status:** ✅ Implemented — pilot-ready
**Scope:** Manager-only Support tab with 5 operational features for pilot store support
**Files changed:** `frontend-pos/index.html`, `backend/modules/pos/routes/support.js` (new), `backend/modules/pos/index.js`

---

## What Was Built

### Feature 1 — POS Health Panel

**Purpose:** Single-glance operational health summary for the pilot store.

**Data sources:**
| Metric | Source |
|---|---|
| Connectivity | `isOnline` module variable (updated by `online`/`offline` events) |
| Queued Sales | `getAllQueuedSales()` — IndexedDB offline queue count |
| Open Sessions | `GET /api/pos/sessions` — `sessions` or `open` array length |
| Stale Sessions | `GET /api/pos/sessions` — `stale` array length (> 16h idle) |
| Negative Stock | `GET /api/pos/support/negative-stock` (new endpoint) — active products below zero |
| Force Update | `forceUpdatePending` module variable (set by `onForceUpdateRequired`) |
| App Version | `GET /api/pos/status` — `version` field |
| Print Agent | Placeholder card — `N/A` (local agent not yet implemented) |

**Visual:** 8 cards in a responsive grid (`health-card-grid`). Each card has a status border:
- `status-ok` — green left border
- `status-warn` — amber left border
- `status-error` — red left border

**Functions:** `loadSupportHealth()` (async, fetches 3 sources in parallel) → `renderHealthPanel(h)` (pure render).

---

### Feature 2 — Pilot Warning Indicators

**Purpose:** Visible banners at the top of the Support tab for conditions requiring immediate attention.

**Warning conditions:**
| Condition | Level | Text |
|---|---|---|
| Offline | Critical (red) | "POS is currently OFFLINE. Queued sales are not syncing." |
| Force update pending | Critical (red) | "A forced update is pending. This till cannot process new sales until it is reloaded." |
| Stale sessions > 0 | Warning (amber) | "N stale till session(s) detected (> 16h idle). Review in the Recovery panel." |
| Queued sales > 0 | Warning (amber) | "N offline sale(s) queued for sync." |
| Negative stock > 0 | Warning (amber) | "N active product(s) at negative stock." |

**No warnings:** Container is hidden (`display:none`). No visual noise when everything is healthy.

**Function:** `renderWarningIndicators(h)` — pure render, called after `loadSupportHealth()`.

---

### Feature 3 — Support Event Timeline

**Purpose:** Operational audit event feed for support triage — newest first, last 50 events.

**Backend endpoint:** `GET /api/pos/support/events?limit=50`
- Filters `pos_audit_events` to operational categories only: `sale`, `session`, `sync`, `recovery`, `override`, `inventory`
- Auth events excluded — they add noise without pilot-ops value
- Ordered `created_at DESC`
- Max 200 events per request (default 50)

**Display:** Chronological rows with:
- Timestamp (short date + short time, `en-ZA` locale)
- Colour-coded badge for event type (e.g., "Sale" in green, "Sync Fail" in red)
- Username (local part before `@`)
- Note snippet (max 80 chars, truncated with `…`)

**Event label map:** `TIMELINE_EVENT_LABELS` constant covers 14 known event types. Unknown types fall back to raw `action_type` with grey colour.

**Functions:** `loadSupportTimeline()` (async fetch) → `renderSupportTimeline(events, container)` (pure render).

---

### Feature 4 — Fast Environment Verification

**Purpose:** On-demand environment check for support calls — verifies 7 conditions and renders inline results.

| Check | Method | Pass condition |
|---|---|---|
| Network connectivity | `navigator.onLine` | `true` |
| Service Worker active | `navigator.serviceWorker?.controller !== null` | Controller present |
| IndexedDB available | `indexedDB.open()` round-trip | Open + close without error |
| localStorage available | `setItem`/`removeItem` probe | No SecurityError |
| API reachable | `fetch /pos/status` with 5s `AbortSignal.timeout` | HTTP 200 |
| Notification permission | `Notification.permission` | `"granted"` (warns if not — not a hard fail) |
| Local print agent | Placeholder | N/A — always ⬜ |

**Icons:** ✅ pass, ⬜ not applicable, ⚠️ warning (soft fail), ❌ hard fail.

**localStorage probe:** Only reads/removes `_probe` key — does not write business data. Complies with Rule D1.

**Function:** `runEnvironmentChecks()` — triggered by "Run Checks" button. Results cached in `supportDataCache.envChecks` for export.

---

### Feature 5 — Diagnostics Snapshot Export

**Purpose:** One-click JSON export of all captured operational state for async remote support.

**Included in export:**
- `exportedAt` — ISO timestamp
- `appVersion` — from `/pos/status`
- `userRole` — current user's role
- `online` — `navigator.onLine` at export time
- `forceUpdate` — `forceUpdatePending` flag
- `health` — full health object from last `loadSupportHealth()` call
- `envChecks` — results from last `runEnvironmentChecks()` call
- `queuedSales` — count only (not item contents)
- `recentEvents` — last 20 events, 5 fields each (action_type, action_category, user_email, till_id, created_at)

**Explicitly excluded:**
- Auth token — never included
- Cart item details — only count included
- Full event metadata/notes — only essential fields

**Delivery:** `Blob` → `URL.createObjectURL` → programmatic `<a>` click. Filename: `pos-diagnostics-<ISO-timestamp>.json`. No server call required.

**Function:** `exportDiagnosticsSnapshot()` — synchronous except for `createObjectURL`. Self-cleaning: link removed after 1s, object URL revoked.

---

## Backend Changes

### New file: `backend/modules/pos/routes/support.js`

Two read-only endpoints, both protected by `requireCompany` + `requirePermission('SETTINGS.EDIT')`:

```
GET /api/pos/support/events?limit=N
  → pos_audit_events filtered to operational categories, newest first
  → max 200 events, default 50

GET /api/pos/support/negative-stock
  → COUNT of active products with stock_quantity < 0
  → returns { negative_stock_count: N }
```

No state changes. No audit events. No writes.

### Modified: `backend/modules/pos/index.js`

```javascript
const supportRoutes = require('./routes/support');
router.use('/support', supportRoutes);
```

---

## Frontend Changes

### New tab: "Support"

- Added after "Recovery" in nav tabs
- Same `role-hidden` visibility rule as Recovery: only `RECOVERY_ALLOWED_ROLES` can see it
- `applyRoleBasedVisibility()` hides both Recovery and Support together

### New layout: `supportLayout`

- `display:none` by default
- `showTab('support')` shows it and calls `loadSupportPanel()`
- `showTab()` hide block includes `supportLayout` — no bleed between tabs

### New CSS classes (added in Workstream 11A — already in index.html):

```css
.health-card-grid   — responsive card grid
.health-card        — individual metric card
.health-card.status-ok / .status-warn / .status-error — coloured left border
.health-card-label / .health-card-value / .health-card-sub — typography
.warning-banner     — amber alert banner
.warning-banner.warn-critical — red alert banner
.env-check-row      — environment check list row
.env-check-label    — fixed-width label
.timeline-row       — event timeline row
.timeline-time      — grey fixed-width timestamp
.timeline-badge     — coloured event type badge
```

### New globals:

```javascript
let supportDataCache = null;  // accumulates health, envChecks, events for export
```

### New functions:

| Function | Purpose |
|---|---|
| `loadSupportPanel()` | Entry point — parallel loads health + timeline |
| `loadSupportHealth()` | Fetches 3 parallel sources, builds health object |
| `renderHealthPanel(h)` | Pure render of 8 health cards |
| `renderWarningIndicators(h)` | Pure render of warning banners |
| `TIMELINE_EVENT_LABELS` | Const: 14 event types → label + color |
| `loadSupportTimeline()` | Fetches /support/events, calls render |
| `renderSupportTimeline(events, container)` | Pure render of timeline rows |
| `runEnvironmentChecks()` | 7 async checks → inline results |
| `exportDiagnosticsSnapshot()` | Builds and downloads JSON blob |

---

## Architecture Boundaries Preserved

- No business data written to `localStorage`, `sessionStorage`, or `indexedDB`
- `localStorage` probe (`_probe` key) is a pure capability test — not business data
- All data sourced from server-authoritative API endpoints or module variables
- Read-only throughout — no state changes, no mutations
- All event data sanitised before export (no auth tokens, no cart item contents)
- Paytime module not touched
- Zeabur deployment rules not affected
- Checkout, sale creation, stock decrement, session flows untouched

---

## Test Criteria

| # | Test | Expected Result |
|---|---|---|
| T1 | Open Support tab as manager | Panel loads; health cards visible; no stale sessions on fresh install |
| T2 | Open Support tab as cashier | Tab not visible (role-hidden) |
| T3 | Go offline, switch to Support | Connectivity card shows "Offline"; red warning banner appears |
| T4 | Force update pending, open Support | Force Update card shows "Pending"; red banner appears |
| T5 | Stale session exists, open Support | Stale Sessions card > 0; amber banner appears |
| T6 | Negative stock products exist | Negative Stock card > 0; amber banner appears |
| T7 | All healthy | No warning banners shown; health cards all green |
| T8 | Click "Run Checks" | 7 checks run; pass/warn/fail icons displayed; timestamp shown |
| T9 | API unreachable during env check | "API reachable" shows ❌; other checks complete normally |
| T10 | Click "Export Snapshot" before loading | Export works; `health: null` in JSON; no crash |
| T11 | Click "Export Snapshot" after loading | JSON file downloads; contains health, envChecks, recentEvents; no token present |
| T12 | Timeline loads | Events appear newest-first; coloured badges; timestamps in en-ZA locale |
| T13 | Timeline — unknown event type | Falls back to raw `action_type` with grey badge — no crash |
| T14 | Timeline — empty | "No operational events found." message |
| T15 | ↺ Refresh button | Re-runs `loadSupportPanel()`; updates all sections |
| T16 | No localStorage/sessionStorage business data | DevTools → Application: only `token` and `isSuperAdmin` |
| T17 | Switching tabs from Support to Till | `supportLayout` hidden; `tillInterface` shown; barcode input focused |

---

## Known Limitations (Not Blocking for Pilot)

| Item | Notes |
|---|---|
| Print agent detection | Placeholder card — "N/A". Local print agent architecture defined in Workstream 8C docs; detection hook not yet built. |
| SW check on first load | `navigator.serviceWorker?.controller` is `null` until second load in some browsers (SW installs on first load, activates on second). Expected — not a bug. |
| Export requires prior load | If manager exports before health/env checks have run, those fields are `null` in the JSON. A note would improve UX but is not required for pilot. |

---

## Workstream 11A Pilot-Safe Verdict

**Health Panel:** ✅ 8 metric cards from live data — no stale state  
**Warning Indicators:** ✅ Critical and amber banners from same health data — no duplication  
**Event Timeline:** ✅ Last 50 operational events from `pos_audit_events` via new backend endpoint  
**Environment Checks:** ✅ 7 checks including API reachability with 5s timeout  
**Diagnostics Export:** ✅ Auth-token-free JSON snapshot; browser-native download; no server call  

**Workstream 11A is pilot-safe.**
