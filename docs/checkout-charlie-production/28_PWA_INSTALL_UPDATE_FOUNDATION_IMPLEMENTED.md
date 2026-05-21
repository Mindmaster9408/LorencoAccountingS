# 28 — PWA INSTALL + FORCED UPDATE FOUNDATION IMPLEMENTED
## Checkout Charlie — Workstream 8B

**Date:** 2026-05-21
**Status:** ✅ Implemented — pilot-ready
**Scope:** 7 critical gaps from Workstream 8A architecture audit

---

## What Was Fixed (All 7 Critical Gaps)

### Gap 1 — Real PWA Icon Files (no more `data:` URL)

**Files created:**
- `frontend-pos/icons/icon-192.svg`
- `frontend-pos/icons/icon-512.svg`

Both are proper SVG files at real paths — purple rounded rectangle with white "CC" text.

**Why this matters:** Chrome/Edge refuse to install a PWA when the manifest icon `src` is a `data:` URL. The app was uninstallable as a PWA on Windows before this fix.

---

### Gap 2 — Manifest `start_url` and `scope` Fixed

**File:** `frontend-pos/manifest.json`

| Field | Before | After |
|---|---|---|
| `start_url` | `"/"` | `"/pos/"` |
| `scope` | (missing) | `"/pos/"` |
| `icons[0].src` | `data:image/svg+xml,...` | `"/pos/icons/icon-192.svg"` |
| `icons[1]` | (missing) | `"/pos/icons/icon-512.svg"` (512×512) |
| `icons[0].purpose` | `"any maskable"` | `"any"` |
| `icons[1].purpose` | (missing) | `"any maskable"` |

**Why this matters:**
- `start_url: "/"` opened the ecosystem login screen, not the POS, when the PWA was launched from the Windows taskbar.
- Missing `scope` means clicking links outside `/pos/` would break out of the installed app into the browser.
- The 512×512 `maskable` icon is required for Android and Windows adaptive icon support.

---

### Gap 3 — Manifest Link Fixed in HTML

**File:** `frontend-pos/index.html` (line 9)

| Before | After |
|---|---|
| `href="/manifest.json"` | `href="/pos/manifest.json"` |

**Why this matters:** `/manifest.json` does not exist at the root. The manifest was served at `/pos/manifest.json` but never loaded by the browser because the HTML pointed to the wrong path. The PWA install prompt was therefore never triggered in Chrome/Edge.

---

### Gap 4 — Dead SW Cache API Queue Removed

**File:** `frontend-pos/service-worker.js`

**Removed:**
- `const SYNC_QUEUE = 'pos-sync-queue'` constant
- `async function queueRequest(request)` — wrote POST body to Cache API under `pos-sync-queue` key

**Changed:**
- POST/PUT/DELETE handler: was `try { fetch } catch { queueRequest(); return HTTP 202 }` → now `return fetch(request)`

**Why this matters — data loss path eliminated:**

The old code silently returned `HTTP 202 { queued: true, offline: true }` for all failed POST requests. The checkout function saw `response.ok = true` (202 is a success code) and proceeded as if the sale had succeeded — the sale was never saved to IndexedDB. In flaky-network scenarios (navigator.onLine = true but packets dropping), sales were lost with no error shown to the cashier.

The fix: SW does not catch POST errors. Network errors propagate as rejected promises → the app's `catch` block fires → `saveOfflineSale()` is called → sale goes into IndexedDB. IndexedDB is and remains the sole offline sale queue.

**Background sync `sync` event kept intact:** The `sync` event handler sends `SYNC_SALES` postMessage to the app, which triggers the IndexedDB-based sync loop. This is correct behaviour and was not changed.

---

### Gap 5 — `/api/version` Extended with `min_compatible_version` and `force_update`

**File:** `backend/server.js`

New env vars:
```
MIN_COMPATIBLE_VERSION=  # empty by default; set to a version string to signal minimum required version
FORCE_UPDATE=false        # set to 'true' to hard-block all stale clients immediately
```

Updated response:
```json
{
  "version": "abc123",
  "min_compatible_version": "",
  "force_update": false,
  "timestamp": "2026-05-21T..."
}
```

**Operational use:** Set `FORCE_UPDATE=true` in Zeabur environment variables when a breaking schema or API change has been deployed. All running POS sessions will be blocked from adding to cart within 5 minutes (the polling interval). Unset it after users have refreshed.

---

### Gap 6 — `update-check.js` Extended

**File:** `frontend-pos/js/update-check.js`

Two additions:

**a) `window.__posAppVersion` exposed:**
```javascript
window.__posAppVersion = null; // initialised at module level
// Set on first /api/version response
knownVersion = v;
window.__posAppVersion = v;
```
This allows `saveOfflineSale()` to stamp the running app version onto every IndexedDB record for audit purposes.

**b) `force_update` routing:**
```javascript
if (data.force_update) {
    triggerForcedUpdate(v);   // calls window.onForceUpdateRequired(v) + shows non-dismissible banner
    stopPolling();
} else {
    showUpdateBanner();       // existing soft (dismissible) banner
    stopPolling();
}
```

`triggerForcedUpdate()` shows a red non-dismissible banner AND calls `window.onForceUpdateRequired(v)` if defined. The POS defines this callback (see Gap 7).

---

### Gap 7 — `index.html` Force Update Gate + `app_version` Stamping

**File:** `frontend-pos/index.html`

**a) Module-level state variable:**
```javascript
let forceUpdatePending = false;
```

**b) `app_version` stamped in offline sale records (`saveOfflineSale`):**
```javascript
const sale = {
    ...saleData,
    status: 'pending',
    syncAttempts: 0,
    createdAt: new Date().toISOString(),
    tempSaleNumber: 'OFFLINE-' + Date.now(),
    app_version: window.__posAppVersion || 'unknown'
};
```

**c) `addToCart` gate:**
```javascript
function addToCart(product) {
    if (forceUpdatePending) {
        showNotification('A required update is pending. Please refresh before continuing.', 'error');
        return;
    }
    // ... rest of addToCart
```

**d) `window.onForceUpdateRequired` callback (defined near SW registration):**
- Sets `forceUpdatePending = true`
- Injects a full-screen blocking modal overlay (dark background, "Required Update" heading, "Refresh Now" button, no dismiss)
- Logs warning to console

**Force update user experience:**
1. Cashier is mid-shift with POS open
2. Operator deploys breaking change, sets `FORCE_UPDATE=true` in Zeabur
3. Within 5 minutes, `update-check.js` polls `/api/version` and detects `force_update: true`
4. Blocking overlay appears — cashier cannot dismiss it
5. Cashier also cannot add to cart (gate at `addToCart` entry)
6. Cashier taps "Refresh Now" → page reloads on new version
7. Operator sets `FORCE_UPDATE=false` in Zeabur for next deployment

---

## What Was NOT Changed

| Intentionally unchanged | Reason |
|---|---|
| IndexedDB schema (`DB_VERSION = 1`) | No new object stores — `app_version` is a new field in existing records, not a schema change requiring migration |
| Offline sale sync logic (`syncOfflineSales`) | Only required changes were specified in 8A; sync rewrite was out of scope |
| SW cache strategies (network-first, stale-while-revalidate) | Correct and unchanged |
| SW `sync` event handler | Correct — triggers IndexedDB-based sync via postMessage |
| Checkout POST body | Server-side audit logging handles live sales; `app_version` only required for offline records |
| Print agent | Explicitly out of scope for 8B |
| Business logic (pricing, tax, stock) | Zero changes |

---

## Files Changed

| File | Change |
|---|---|
| `frontend-pos/icons/icon-192.svg` | NEW — real 192×192 SVG icon |
| `frontend-pos/icons/icon-512.svg` | NEW — real 512×512 SVG icon |
| `frontend-pos/manifest.json` | Fixed `start_url`, added `scope`, replaced `data:` URL icons with real paths |
| `frontend-pos/service-worker.js` | Removed `SYNC_QUEUE` constant + `queueRequest()` function; POST handler now passes through to network |
| `backend/server.js` | Added `MIN_COMPATIBLE_VERSION` + `FORCE_UPDATE` env vars; `/api/version` now returns both fields |
| `frontend-pos/js/update-check.js` | Exposes `window.__posAppVersion`; adds `triggerForcedUpdate()` + `force_update` routing in `checkVersion()` |
| `frontend-pos/index.html` | 4 edits: manifest href fixed, `forceUpdatePending` variable, `app_version` in `saveOfflineSale`, `addToCart` gate + `window.onForceUpdateRequired` handler |

---

## Test Criteria (from 8A spec)

| # | Test | Pass condition |
|---|---|---|
| T1 | PWA installs via Chrome/Edge on Windows | Install prompt appears; "Add to taskbar" works; launching opens `/pos/` not ecosystem login |
| T2 | Manifest loads correctly | DevTools → Application → Manifest shows correct `start_url`, `scope`, and real icon URLs |
| T3 | SW offline queue fix | With DevTools network throttled to "Offline" while tab is open: attempt checkout → sale appears in IndexedDB `offlineSales` store; NO HTTP 202 success shown |
| T4 | Soft update banner | Deploy new version (or change `BUILD_VERSION` env) → within 5 minutes a dismissible "New version available" banner appears at bottom of screen |
| T5 | Force update blocks addToCart | Set `FORCE_UPDATE=true` in server env → within 5 minutes: blocking overlay appears; tapping any product card shows error notification; overlay has no dismiss button |
| T6 | `app_version` on offline records | Save an offline sale; inspect IndexedDB in DevTools → `offlineSales` record has `app_version` field (not `'unknown'` if page has fetched `/api/version`) |
| T7 | `/api/version` response shape | `GET /api/version` returns `{ version, min_compatible_version, force_update, timestamp }` |

---

## Deployment Notes

### To enable forced update after a breaking deploy:

```bash
# In Zeabur environment variables:
FORCE_UPDATE=true
MIN_COMPATIBLE_VERSION=<new-version-string>
```

Redeploy. Running POS sessions will be blocked within 5 minutes.

After all cashiers have refreshed:
```bash
FORCE_UPDATE=false
```

Redeploy (or restart service — environment variable change triggers redeploy on Zeabur).

### Normal deployments (no breaking change):

No env var changes needed. `BUILD_VERSION` changes automatically (new container = new timestamp). SW detects new bytes → shows soft update banner → cashier refreshes at their convenience.

---

## Architecture Boundary Preserved

The IndexedDB `offlineSales` store (`CheckoutCharliePOS` DB, `DB_VERSION = 1`) remains the **sole offline sale queue**. No sale data passes through the Service Worker Cache API. The SW is a read cache only — it never owns write state.

```
Checkout attempt (offline)
    ↓
fetch() rejects (network error propagates)
    ↓
app catch block → saveOfflineSale() → IndexedDB offlineSales store
    ↓
background sync event → SYNC_SALES postMessage → syncOfflineSales()
    ↓
IndexedDB records → POST /api/pos/sales (with retry + conflict handling)
```

This is the only path. The Cache API `pos-sync-queue` path no longer exists.
