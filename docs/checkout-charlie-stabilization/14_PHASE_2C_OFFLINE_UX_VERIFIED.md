# 14 — Checkout Charlie: Phase 2C Offline UX Verified
**Phase 2C Verification — Cashier Offline UX**
Date: 2026-05-11

---

## VERDICT SUMMARY

| Check | Result |
|---|---|
| Offline banner appears when offline | ✅ PASS |
| Pending/conflict/failed chips show correctly | ✅ PASS |
| Page reload still shows unresolved conflict warning | ✅ PASS |
| Syncing progress text updates ("Syncing N of M...") | ✅ PASS (bug found + fixed) |
| Product stock shows `~N (est.)` while offline | ✅ PASS |
| Online stock returns to confirmed `Stock: N` display | ✅ PASS |
| No localStorage/sessionStorage business data added | ✅ PASS |
| `current_stock` initialises from `stock_quantity` on first offline sale | ✅ PASS |
| `addToCart` guards against estimated stock when offline | ✅ PASS |
| Banner hidden when online + queue empty + no conflicts | ✅ PASS |

**Phase 2C is fully verified. One bug found and fixed during verification.**

---

## SECTION 1: VERIFICATION METHOD

This verification was conducted by code-review (static analysis) against the live implementation in `accounting-ecosystem/frontend-pos/index.html`. Each scenario was traced through the exact code path to confirm correct behaviour.

Browser-based verification was not performed (CLI environment). All scenarios were verified by tracing execution paths through:
- CSS class application
- `updateOfflineBanner()` state machine logic
- `displayProductsGrid()` stock display branch
- `addToCart()` guard logic
- `checkout()` `current_stock` initialisation
- `syncOfflineSales()` progress tracking
- `localStorage.setItem` call audit (complete enumeration)

---

## SECTION 2: SCENARIO TRACES

### Scenario 1 — Offline banner appears when offline

**Trigger path:**
```
window.addEventListener('offline', ...)
→ isOnline = false
→ updateOfflineBanner()
→ !isOnline → state = 'state-offline'
→ nPending = 0 → text = 'Offline — sales will be saved locally'
→ banner.className = 'offline-banner show state-offline'
→ CSS: .offline-banner.show { display: flex } → visible
→ CSS: .offline-banner.state-offline { background: #c62828 } → red
```

**With pending sales (e.g., 3 in queue):**
```
→ nPending = 3 → text = 'Offline — 3 sales saved locally'
→ chips: <span class="queue-chip chip-pending">3 pending</span>
```

**Result: ✅ PASS**

---

### Scenario 2 — Pending chip shows correctly

**Trigger path:**
```
saveOfflineSale(saleData)
→ store.add(sale) onsuccess → updateOfflineBanner()
→ IndexedDB read → nPending = 1
→ chips: '<span class="queue-chip chip-pending">1 pending</span>'
```

CSS: `.chip-pending { background: rgba(255,255,255,0.25) }` — translucent white chip on red/orange banner.

**With banner offline state:** chip is visible against the red background.
**With banner pending state (online):** chip is visible against the orange banner.

**Result: ✅ PASS**

---

### Scenario 3 — Conflict chip shows correctly

**Trigger path (post-sync, online, conflict record in IndexedDB):**
```
syncOfflineSales() finally
→ syncInProgress = false, syncProgress = {0,0}
→ await updateOfflineBanner()
→ isOnline = true, syncInProgress = false
→ nConflict = 1 (conflict_stock or conflict_session record)
→ state = 'state-warning'
→ text = 'Sale conflicts need review — notify manager'
→ chips: '<span class="queue-chip chip-conflict">1 conflict</span>'
→ banner.className = 'offline-banner show state-warning'
→ CSS: .state-warning { background: #e65100 } — amber
```

CSS: `.chip-conflict { background: rgba(200,30,30,0.55) }` — red-tinted chip on amber banner.

**Result: ✅ PASS**

---

### Scenario 4 — Failed chip shows correctly

**Trigger path (3 server errors exhausted):**
```
updateOfflineSaleStatus(tempId, 'failed', ...)
→ sale.status = 'failed', sale.syncAttempts = 3

syncOfflineSales() finally
→ updateOfflineBanner()
→ nFailed = 1
→ state = 'state-warning'
→ text = 'Failed sales need attention — notify manager'
→ chips: '<span class="queue-chip chip-failed">1 failed</span>'
```

CSS: `.chip-failed { background: rgba(120,0,0,0.65) }` — dark red chip, visually heavier than conflict chip.

**Result: ✅ PASS**

---

### Scenario 5 — Page reload persists unresolved conflict warning

**Trigger path:**
```
window.addEventListener('load', ...)
→ await initIndexedDB()           // opens existing DB (conflict record still present)
→ isOnline = navigator.onLine     // true (device is online)
→ await updateOfflineBanner()
→ isOnline = true, syncInProgress = false
→ IndexedDB read → nConflict = 1
→ state = 'state-warning'         // amber banner shown immediately
→ banner visible before any cashier interaction
```

The banner is rendered in the `load` handler — before `completeLogin()`, before products are loaded, before the till interface is shown. The cashier sees the warning the moment the app is open.

**Result: ✅ PASS**

---

### Scenario 6 — Syncing progress text updates

**Bug found during verification:**

The initial call to `updateOfflineBanner()` at the top of the sync loop (before any sale is processed) had `syncProgress = { current: 0, total: N }`. The text logic was:
```javascript
text = total > 1 ? `Syncing ${current} of ${total}...` : 'Syncing...';
```
For `total = 3, current = 0` this rendered "Syncing 0 of 3..." — confusing and incorrect.

**Fix applied:**
```javascript
text = (total > 1 && current > 0) ? `Syncing ${current} of ${total}...` : 'Syncing...';
```

**Corrected sequence for a 3-sale sync:**
```
syncProgress = { current: 0, total: 3 } → updateOfflineBanner()
  → (total > 1 && current > 0) = false → "Syncing..."          ← initial state

fetch sale 1 returns → syncProgress.current = 1 → updateOfflineBanner()
  → (3 > 1 && 1 > 0) = true → "Syncing 1 of 3..."

fetch sale 2 returns → syncProgress.current = 2 → updateOfflineBanner()
  → "Syncing 2 of 3..."

fetch sale 3 returns → syncProgress.current = 3 → updateOfflineBanner()
  → "Syncing 3 of 3..."

finally: syncProgress = {0,0} → updateOfflineBanner() → final state
```

For a single-sale sync (`total = 1, current = 1`): `(1 > 1 && ...)` = false → "Syncing..." throughout. No "1 of 1" needed.

**Result after fix: ✅ PASS**

---

### Scenario 7 — Estimated stock shows while offline

**First offline sale (product never sold offline before):**
```
product = { stock_quantity: 10, current_stock: undefined }

displayProductsGrid() with !isOnline:
→ est = product.current_stock ?? product.stock_quantity ?? 0
→ est = undefined ?? 10 ?? 0 = 10
→ est > 0 → '<div class="stock-estimated">~10 (est.)</div>'
→ CSS: .stock-estimated { color: #f57c00; font-style: italic } — italic amber
```

**After cashier sells 3 units offline:**
```
checkout() offline path:
→ base = undefined ?? 10 ?? 0 = 10
→ product.current_stock = max(0, 10 - 3) = 7
→ cacheProducts(products)
→ displayProductsGrid(products)
→ est = 7 ?? 10 ?? 0 = 7
→ '<div class="stock-estimated">~7 (est.)</div>'
```

**After selling remaining 7 units offline (stock at 0):**
```
→ product.current_stock = max(0, 7 - 7) = 0
→ est = 0 ?? ... = 0
→ est <= 0 → '<div class="stock-zero-est">Out of stock (est.)</div>'
→ CSS: .stock-zero-est { color: #c62828; font-weight: 700 } — bold red
```

**Visual distinction confirmed:**
| State | HTML class | Color | Style |
|---|---|---|---|
| Online, stock 8 | `product-stock` | grey `#999` | normal |
| Offline, est. 7 | `stock-estimated` | amber `#f57c00` | italic |
| Offline, est. 0 | `stock-zero-est` | red `#c62828` | bold |

**Result: ✅ PASS**

---

### Scenario 8 — Online stock returns to confirmed display

**Trigger path after sync completes:**
```
online handler debounce fires (1000ms)
→ await syncOfflineSales()
→ await loadProducts()    ← fetches from server since isOnline = true
→ products = result.products  (fresh server data, no current_stock field)
→ displayProductsGrid(products) with isOnline = true
→ else branch: qty = product.stock_quantity ?? 0
→ '<div class="product-stock">Stock: 8</div>'
→ CSS: .product-stock { color: #999 } — normal grey
```

`current_stock` values from offline session are discarded when fresh server data replaces the products array. The server is the authoritative source; after sync `stock_quantity` is the confirmed state.

**Result: ✅ PASS**

---

### Scenario 9 — No localStorage/sessionStorage business data

**Full audit of `localStorage.setItem` calls in index.html:**

| Line | Key | Value | Category |
|---|---|---|---|
| 3709 | `'token'` | JWT string | Auth token — **permitted** |
| 3710 | `'isSuperAdmin'` | `'true'` | UI flag — **permitted** |
| 3718 | `'isSuperAdmin'` | `'true'` | UI flag — **permitted** |
| 3725 | `'token'` | JWT string | Auth token — **permitted** |
| 3737 | `'token'` | JWT string | Auth token — **permitted** |
| 3743 | `'token'` | JWT string | Auth token — **permitted** |
| 3802 | `'token'` | JWT string | Auth token — **permitted** |
| 7853 | `'token'` | JWT string | Auth token — **permitted** |
| 7880 | `'token'` | JWT string | Auth token — **permitted** |
| 8996 | `'token'` | JWT string | Auth token — **permitted** |

**`sessionStorage.setItem` calls: zero**

No sales data, product data, stock data, or any other business data is written to localStorage or sessionStorage. Phase 2C added zero new `localStorage.setItem` calls.

**Result: ✅ PASS**

---

### Scenario 10 — `addToCart` blocks over-selling against estimated stock

**Product with `stock_quantity = 10`, `current_stock = 3` (7 units already sold offline):**
```
addToCart(product)
→ availableStock = !isOnline
    ? (product.current_stock ?? product.stock_quantity ?? 0)
    : ...
→ availableStock = 3 ?? 10 ?? 0 = 3

// Cashier tries to add 4th unit (existing.quantity = 3):
→ existing.quantity < availableStock
→ 3 < 3 = false
→ showNotification('Not enough stock', 'error')
→ return (blocked)
```

Online path (unchanged): `availableStock = product.stock_quantity ?? 0` — server value.

**Result: ✅ PASS**

---

### Scenario 11 — `current_stock` initialises correctly from `stock_quantity`

**The pre-Phase-2C bug:**
```javascript
// Old code:
product.current_stock = Math.max(0, (product.current_stock || 0) - item.quantity);
// → product.current_stock || 0 = undefined || 0 = 0
// → First offline sale always set current_stock = max(0, 0 - qty) = 0
// → All subsequent sales showed "~0 (est.)" regardless of actual stock
```

**Phase 2C fix:**
```javascript
const base = product.current_stock ?? product.stock_quantity ?? 0;
product.current_stock = Math.max(0, base - item.quantity);
// → base = undefined ?? 10 ?? 0 = 10 (first offline sale)
// → base = 7 ?? 10 ?? 0 = 7 (second offline sale, after first sold 3)
```

`??` (nullish coalescing) only falls through on `null`/`undefined`. A product with `stock_quantity = 0` correctly starts at 0 and stays clamped at 0.

**Result: ✅ PASS**

---

## SECTION 3: BUG FOUND AND FIXED

### Bug — Progress Counter Shows "Syncing 0 of N..."

**Severity:** Minor (cosmetic) — incorrect text flashes briefly before the first sale is processed.

**Root cause:** `syncProgress.current` is 0 when `updateOfflineBanner()` is first called at the top of the sync loop. The condition `total > 1` was true, so `Syncing 0 of 3...` was rendered.

**Fix:**
```javascript
// Before:
text = total > 1 ? `Syncing ${current} of ${total}...` : 'Syncing...';

// After:
text = (total > 1 && current > 0) ? `Syncing ${current} of ${total}...` : 'Syncing...';
```

**Effect:** Shows "Syncing..." until the first sale completes, then switches to "Syncing 1 of N...". No "0 of N" state ever rendered.

**Status: ✅ FIXED**

---

## SECTION 4: STATE MACHINE VERIFICATION

The `updateOfflineBanner()` state priority was verified against all expected scenarios:

```
Priority 1: !isOnline
  → state-offline (red)
  → Cannot be masked by any other state
  → Correct: offline is the most critical state

Priority 2: syncInProgress
  → state-syncing (blue)
  → Masks conflict/pending chips during sync cycle
  → Correct: don't show "notify manager" while actively syncing

Priority 3: nConflict > 0 || nFailed > 0
  → state-warning (amber)
  → Persists after sync completes, after page reload, after reconnect
  → Correct: conflicts require human action and must not disappear silently

Priority 4: nPending > 0
  → state-pending (orange)
  → Temporary: disappears when sync succeeds
  → Correct: pending is normal transient state

Priority 0 (all clear): banner hidden
  → Correct: no false alarm when queue is clean
```

**Edge case: syncing when conflict records already exist**

During an active sync, `syncInProgress = true` takes priority over `nConflict > 0`. The banner shows "state-syncing" (blue, progress text). After sync finishes, `finally` clears `syncInProgress` and calls `updateOfflineBanner()`, which now shows `state-warning` (amber) if conflicts remain.

The cashier sees: blue "Syncing 2 of 3..." → amber "Sale conflicts need review — notify manager".

This is correct — the warning appears after the sync cycle, not during it.

---

## SECTION 5: KNOWN LIMITATIONS (NOT BUGS)

| Item | Behaviour | Classification |
|---|---|---|
| Banner overlaps page content by 36px | Fixed-position, not in document flow; content is still reachable by scrolling | Acceptable for POS |
| `current_stock` resets on `loadProducts()` after sync | By design — server is truth | Expected |
| Stale cache: `current_stock` estimates are per-session only | Resets after `loadProducts()` on reconnect | By design |
| Multi-tab estimate divergence | Tab A sells offline, Tab B shows stale estimate | Phase 2E scope |
| Unhandled rejection if `getPendingOfflineSales()` throws (IndexedDB error) | Pre-existing pattern; extremely unlikely | Pre-existing risk |

---

## SECTION 6: PHASE 2C VERIFICATION STATUS — COMPLETE

| Item | Status |
|---|---|
| CSS: `.offline-banner` + 4 state classes + chips + stock classes | ✅ Verified in file |
| HTML: `#offlineBanner` with icon/text/chips spans | ✅ Verified in file |
| `updateOfflineBanner()`: state machine logic, IndexedDB read, chip rendering | ✅ Verified correct |
| `syncOfflineSales()`: `syncProgress` tracking, per-sale banner update, `finally` reset | ✅ Verified correct |
| `displayProductsGrid()`: offline `~N (est.)` vs online `Stock: N` | ✅ Verified correct |
| `addToCart()`: `current_stock ?? stock_quantity` guard when offline | ✅ Verified correct |
| `checkout()`: `??` initialisation fix (`base = current_stock ?? stock_quantity ?? 0`) | ✅ Verified correct |
| Online/offline/load event handlers call `updateOfflineBanner()` | ✅ Verified correct |
| localStorage audit: zero business data in any `setItem` call | ✅ Verified (10 calls, all token/flag) |
| No remaining references to old `#offlineIndicator`, `updateOfflineIndicator`, `updateOfflineCount` | ✅ Verified (grep confirms single comment reference only) |
| Bug fixed: "Syncing 0 of N..." → "Syncing..." for pre-first-sale state | ✅ Fixed + verified |

**Phase 2C is verified. All checks pass. One bug found (cosmetic progress counter) and fixed before verification completed.**

---

*Phase 2A: idempotent sale creation*
*Phase 2B: send-queue discipline (delete on confirm, per-sale error classification)*
*Phase 2C: cashier offline UX (persistent banner, estimated stock, conflict warning) — ✅ VERIFIED*
*Next: Phase 2D — manager recovery screen (per-record conflict view, resolution actions)*
