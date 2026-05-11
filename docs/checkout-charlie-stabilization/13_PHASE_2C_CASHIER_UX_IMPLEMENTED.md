# 13 — Checkout Charlie: Phase 2C Cashier Offline UX Implemented
**Phase 2C — Persistent Offline Banner + Conflict Visibility + Estimated Stock**
Date: 2026-05-11

---

## VERDICT SUMMARY

| Check | Result |
|---|---|
| Cashier can clearly see offline state | ✅ Full-width red banner persists while offline |
| Cashier can clearly see unresolved conflicts | ✅ Amber warning banner visible even while online |
| Cashier cannot mistakenly think failed sales synced | ✅ Failed chip shown; banner never disappears while unresolved |
| Offline estimated stock visually differs from confirmed stock | ✅ `~N (est.)` in italic amber vs black `Stock: N` |
| Pending/conflict/failed visually distinct in banner | ✅ Three separate chips with distinct background colours |
| Persistent warning if queue older than 30 min | ✅ `queue >30 min` chip appears automatically |
| Sync progress messaging ("Syncing N of M...") | ✅ Banner updates per-sale during sync cycle |
| No localStorage/sessionStorage business data added | ✅ All state from IndexedDB + module-level flags |
| Single source of truth for offline UI state | ✅ One function: `updateOfflineBanner()` |
| `current_stock` initialisation bug fixed | ✅ First offline sale now starts from `stock_quantity` |
| `addToCart` guards against estimated stock (not server stock) | ✅ Uses `current_stock ?? stock_quantity` when offline |

**Phase 2C is fully implemented.**

---

## SECTION 1: WHAT CHANGED

### File: `accounting-ecosystem/frontend-pos/index.html`

Ten targeted edits. No new files. No backend changes.

---

### Change 1 — CSS: `.offline-indicator` → `.offline-banner`

**Removed:** The floating pill (`.offline-indicator`) — `position: fixed; left: 50%; transform: translateX(-50%)`. It was a centred pill that appeared only during offline or syncing states and disappeared the moment connectivity was restored.

**Added:** A full-width persistent bar (`.offline-banner`):

```css
.offline-banner {
    position: fixed;
    top: 50px;            /* immediately below the 50px nav bar */
    left: 0;
    right: 0;             /* full width */
    display: none;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 7px 20px;
    font-size: 13px;
    font-weight: 600;
    color: white;
    z-index: 9990;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    min-height: 36px;
}
.offline-banner.show          { display: flex; }
.offline-banner.state-offline { background: #c62828; }   /* red     — offline */
.offline-banner.state-syncing { background: #1565c0; }   /* blue    — syncing */
.offline-banner.state-warning { background: #e65100; }   /* amber   — conflicts/failed (online) */
.offline-banner.state-pending { background: #f57c00; }   /* orange  — pending sync (online) */
```

**Queue status chips:**
```css
.queue-chip    { padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 700; }
.chip-pending  { background: rgba(255,255,255,0.25); }   /* translucent white */
.chip-conflict { background: rgba(200,30,30,0.55); }     /* red tint */
.chip-failed   { background: rgba(120,0,0,0.65); }      /* dark red */
.chip-stale    { background: rgba(0,0,0,0.35); }        /* dark — age warning */
```

**Estimated stock classes:**
```css
.stock-estimated { font-size: 11px; color: #f57c00; font-style: italic; margin-top: 5px; }
.stock-zero-est  { font-size: 11px; color: #c62828; font-weight: 700; margin-top: 5px; }
```

---

### Change 2 — HTML: `#offlineIndicator` → `#offlineBanner`

**Before:**
```html
<div id="offlineIndicator" class="offline-indicator">
    <span id="offlineIcon">⚠</span>
    <span id="offlineText">You are offline</span>
    <span id="syncCount" class="sync-count" style="display:none;">0 pending</span>
</div>
```

**After:**
```html
<!-- Offline Banner — persistent bar, visible for offline/pending/conflict/failed/syncing states -->
<div id="offlineBanner" class="offline-banner">
    <span id="bannerIcon" style="font-size:15px;flex-shrink:0;"></span>
    <span id="bannerText" class="banner-msg"></span>
    <span id="bannerChips" style="display:flex;gap:6px;flex-wrap:wrap;"></span>
</div>
```

Three inner spans: icon (fixed width), message text (flex-grow), chip strip. Chips are built dynamically. No hardcoded text — all set by `updateOfflineBanner()`.

---

### Change 3 — JS: `syncProgress` module-level variable

```javascript
let syncProgress = { current: 0, total: 0 }; // Progress counter for banner display
```

Added alongside `syncInProgress` and `syncDebounceTimer`. Reset to `{ 0, 0 }` in the sync loop's `finally` block. Used by `updateOfflineBanner()` to render "Syncing N of M...".

---

### Change 4 — JS: `updateOfflineBanner()` (replaces both old functions)

`updateOfflineIndicator()` and `updateOfflineCount()` are removed and replaced by a single async function that is the sole source of truth for all offline UI state.

**Decision tree:**

```
updateOfflineBanner()
├── Reads: isOnline, syncInProgress, syncProgress, IndexedDB offlineSales
├── Computes: nPending, nConflict, nFailed, hasStalePending
│
├── !isOnline
│   └── state-offline (red)
│       text: "Offline — N sales saved locally" (or "...will be saved" if 0)
│
├── syncInProgress
│   └── state-syncing (blue)
│       text: "Syncing N of M..." (or "Syncing..." for single)
│
├── nConflict > 0 || nFailed > 0   ← PERSISTENT even when online
│   └── state-warning (amber)
│       text: "Sync issues — notify manager" (or specific variant)
│
├── nPending > 0
│   └── state-pending (orange)
│       text: "N sales pending sync"
│
└── else → banner hidden (className = 'offline-banner', no 'show')
```

**Chips rendered:**
- `nPending > 0` → `<span class="queue-chip chip-pending">N pending</span>`
- `nConflict > 0` → `<span class="queue-chip chip-conflict">N conflict</span>`
- `nFailed > 0` → `<span class="queue-chip chip-failed">N failed</span>`
- `hasStalePending` → `<span class="queue-chip chip-stale">queue >30 min</span>`

The stale check reads `s.createdAt` (ISO string, set in `saveOfflineSale`) and compares against `Date.now() - 1800000` (30 minutes). Only `pending` records trigger the stale warning — `conflict`/`failed` records are already flagged by their own chips.

---

### Change 5 — JS: `syncOfflineSales()` — progress tracking

**Before (Phase 2B):**
```javascript
updateOfflineIndicator(true, pendingSales.length);
// ... for loop with no progress update
// finally:
updateOfflineIndicator();
updateOfflineCount();
```

**After (Phase 2C):**
```javascript
syncProgress = { current: 0, total: pendingSales.length };
updateOfflineBanner();    // → "Syncing..." state immediately

for (const sale of pendingSales) {
    // ... fetch, handle response ...
    syncProgress.current++;
    updateOfflineBanner(); // → "Syncing 2 of 7..." (fire-and-forget, no await)
}

// finally:
syncInProgress = false;
syncProgress   = { current: 0, total: 0 };
await updateOfflineBanner();  // → final state (warning/pending/hidden)
```

The in-loop calls are not awaited — DOM updates are async but the banner renders quickly without blocking the next fetch. The `finally` block awaits the last call to ensure the correct end-state is fully rendered before any notification fires.

---

### Change 6 — JS: `saveOfflineSale` and `deleteOfflineSale`

Both functions' `onsuccess` callbacks previously called `updateOfflineCount()`. Changed to `updateOfflineBanner()`. These are fire-and-forget (no await in the callback context).

---

### Change 7 — JS: online/offline event handlers and load handler

All three callers replaced `updateOfflineIndicator()` / `updateOfflineCount()` with `updateOfflineBanner()`.

Load handler combined the two old calls into one:
```javascript
// Before:
updateOfflineIndicator();
await updateOfflineCount();

// After:
await updateOfflineBanner();
```

On page load, if IndexedDB contains conflict or failed records from a previous session, the banner immediately shows `state-warning` (amber). Cashiers are informed of unresolved issues the moment they open the app.

---

### Change 8 — JS: `displayProductsGrid()` — estimated stock display

**Before:** Always showed `product.stock_quantity` — the last confirmed server value, never updated for offline sales.

**After:**
```javascript
if (!isOnline) {
    const est = product.current_stock ?? product.stock_quantity ?? 0;
    if (est <= 0) {
        stockHtml = `<div class="stock-zero-est">Out of stock (est.)</div>`;   // bold red
    } else {
        stockHtml = `<div class="stock-estimated">~${est} (est.)</div>`;       // italic amber
    }
} else {
    stockHtml = `<div class="product-stock">Stock: ${qty}</div>`;              // normal grey
}
```

**Visual distinction:**
| State | Display | Style |
|---|---|---|
| Online, stock > 0 | `Stock: 8` | Grey, normal |
| Offline, estimated > 0 | `~6 (est.)` | Amber, italic |
| Offline, estimated = 0 | `Out of stock (est.)` | Red, bold |

The `~` prefix is a universal signal for "approximate". The `(est.)` suffix removes ambiguity.

---

### Change 9 — JS: `addToCart()` — estimated stock guard

**Before:** Guard compared `existing.quantity < product.stock_quantity`. When offline, stock_quantity was the pre-offline-sales server value, so the cart would allow quantities that had already been "sold" offline.

**After:**
```javascript
const availableStock = !isOnline
    ? (product.current_stock ?? product.stock_quantity ?? 0)
    : (product.stock_quantity ?? 0);

if (existing.quantity < availableStock) {
    existing.quantity++;
} else {
    showNotification('Not enough stock', 'error');
    return;
}
```

The guard now reflects the locally-adjusted estimate, consistent with what the tile shows. If a cashier already sold 3 units offline and the tile shows `~2 (est.)`, the cart correctly blocks adding a 6th unit.

---

### Change 10 — JS: `checkout()` — `current_stock` initialisation fix

**Before (bug):**
```javascript
product.current_stock = Math.max(0, (product.current_stock || 0) - item.quantity);
```
`product.current_stock || 0` resolved to `0` for the first offline sale (field not set). So after the first offline sale, `current_stock` was `0 - qty`, clamped to `0`. All subsequent sales showed `~0 (est.)` regardless of actual stock.

**After (fixed):**
```javascript
const base = product.current_stock ?? product.stock_quantity ?? 0;
product.current_stock = Math.max(0, base - item.quantity);
```

`??` (nullish coalescing) falls through only on `null`/`undefined`, not on `0`. The first offline sale initialises from `stock_quantity` (server value). Each subsequent offline sale decrements from the previous estimate. The estimate stays accurate across multiple offline sales in the same session.

---

## SECTION 2: BANNER STATES — FULL SPECIFICATION

| Scenario | Banner state | Background | Text | Chips |
|---|---|---|---|---|
| Offline, 0 queued | `state-offline` | Red | "Offline — sales will be saved locally" | none |
| Offline, N queued | `state-offline` | Red | "Offline — N sales saved locally" | N pending |
| Online, syncing (single) | `state-syncing` | Blue | "Syncing..." | — |
| Online, syncing (multi) | `state-syncing` | Blue | "Syncing 3 of 7..." | — |
| Online, pending only | `state-pending` | Orange | "N sales pending sync" | N pending |
| Online, conflicts only | `state-warning` | Amber | "Sale conflicts need review — notify manager" | N conflict |
| Online, failed only | `state-warning` | Amber | "Failed sales need attention — notify manager" | N failed |
| Online, conflicts + failed | `state-warning` | Amber | "Sync issues — notify manager" | N conflict, N failed |
| Online, pending + conflict | `state-warning` | Amber | (conflict message wins) | N pending, N conflict |
| Online, stale pending | adds chip | (any pending state) | — | + `queue >30 min` |
| Online, queue empty, no conflicts | hidden | — | — | — |

**State priority (highest to lowest):**
1. `!isOnline` → offline (always shown while offline)
2. `syncInProgress` → syncing
3. `nConflict > 0 || nFailed > 0` → warning (persists after reconnect)
4. `nPending > 0` → pending
5. All clear → hidden

---

## SECTION 3: ESTIMATED STOCK DESIGN DECISIONS

**Why `current_stock` and not a separate adjustment map?**

`current_stock` already existed in the products array — it was being written during offline checkout but never read. Correcting the read path (in `displayProductsGrid` and `addToCart`) was simpler and less error-prone than introducing a new data structure.

**Why `??` not `||` for the initialisation fix?**

`product.current_stock || 0` treats `0` as falsy, so a product with zero confirmed stock would incorrectly reinitialise to 0 rather than advancing the estimate. `??` only falls through on `null`/`undefined`. A product with `stock_quantity = 0` correctly starts at 0 and stays at 0 (already at minimum).

**Why show the stale chip on the offline state too?**

When offline with pending records, the cashier cannot sync. If the queue is building up past 30 minutes, the `queue >30 min` chip signals that connectivity has been lost for an extended period. The cashier (or manager) should investigate before continuing to take sales.

**Why is the stale threshold 30 minutes?**

30 minutes is a reasonable shift-incident threshold for a retail POS: short enough to be actionable, long enough that normal brief outages (router restart, mobile data dead zone) don't trigger it. This constant is `STALE_MS = 30 * 60 * 1000` in `updateOfflineBanner()` and can be changed in one place.

---

## SECTION 4: WHAT IS NOT IN PHASE 2C

| Feature | Reason not included | Phase |
|---|---|---|
| Cashier-dismissible conflict UI / per-record detail view | Manager-level recovery, not cashier UX | Phase 2D |
| Manager recovery screen (review/resolve conflict/failed records) | Explicitly excluded from Phase 2C | Phase 2D |
| Automatic conflict resolution (retry with reduced qty, etc.) | Explicitly excluded — no automatic resolution | Phase 2D |
| Multi-tab `navigator.locks` | Separate Phase 2E task | Phase 2E |
| Retry button for failed records | Requires manager flow | Phase 2D |
| Conflict detail (which product, which sale number) | Requires per-record UI — manager scope | Phase 2D |

---

## SECTION 5: OPEN RISKS

| Risk | Phase 2C status | Phase |
|---|---|---|
| Cashier has no way to see which specific sale is in conflict | Banner counts only | Phase 2D |
| Failed/conflict records persist forever until manager clears | OPEN | Phase 2D |
| Banner overlaps content by 36px (fixed, not in document flow) | Acceptable for POS — content still reachable | Phase 2D optional |
| `current_stock` resets to `stock_quantity` on `loadProducts` after sync | Correct (server is truth) | By design |
| Estimated stock may be wrong if products cached offline differ from server | Acknowledged — stale cache limitation | Phase 2D |
| Multi-tab estimate divergence (tab A sells offline, tab B shows old estimate) | Out of scope until Phase 2E | Phase 2E |

---

## SECTION 6: PHASE 2C STATUS — COMPLETE

| Item | Status |
|---|---|
| `.offline-banner` CSS (full-width, 4 colour states, chip styles, estimated stock styles) | ✅ Done |
| `#offlineBanner` HTML (icon + message + chips strip) | ✅ Done |
| `syncProgress` module-level variable | ✅ Done |
| `updateOfflineBanner()` — single source of truth, reads IndexedDB + module state | ✅ Done |
| `syncOfflineSales()` — progress tracking, banner update per sale | ✅ Done |
| `saveOfflineSale` / `deleteOfflineSale` → call `updateOfflineBanner()` | ✅ Done |
| Online/offline event handlers → `updateOfflineBanner()` | ✅ Done |
| Load handler → `await updateOfflineBanner()` (shows conflicts from previous session) | ✅ Done |
| `displayProductsGrid()` — estimated stock `~N (est.)` vs confirmed `Stock: N` | ✅ Done |
| `addToCart()` — stock guard uses `current_stock ?? stock_quantity` when offline | ✅ Done |
| `checkout()` — `current_stock` initialisation fixed (`??` not `\|\|`) | ✅ Done |
| Old `updateOfflineIndicator()` and `updateOfflineCount()` removed | ✅ Done |
| Zero remaining references to `#offlineIndicator`, `#syncCount`, old function names | ✅ Verified |

**Phase 2C is complete. Cashiers can unambiguously see offline state, pending/conflict/failed counts, estimated stock while offline, and sync progress. Unresolved conflicts persist in the banner after reconnect. No business data in localStorage. Single source of truth for all offline UI state.**

---

*Phase 2A: duplicate-safe sales (idempotency key)*
*Phase 2B: send-queue discipline (delete on confirm, per-sale error classification)*
*Phase 2C: cashier-visible offline UX (persistent banner, estimated stock, conflict warning)*
*Next: Phase 2D — manager recovery screen (per-record conflict view, resolution actions)*
