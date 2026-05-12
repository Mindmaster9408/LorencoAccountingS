# 11 — STOCK POLICY UX + OFFLINE REFRESH POLISH IMPLEMENTED
## Checkout Charlie — Workstream 3B

**Date:** 2026-05-12  
**Scope:** Three targeted follow-ups from Workstream 3A verification (doc 10)  
**Status:** ✅ Implemented  
**File changed:** `accounting-ecosystem/frontend-pos/index.html` only

---

## What Was Implemented

Three isolated changes. No backend changes. No new routes. No new DB objects. No new audit events.

---

### Change 1 — Policy refresh on reconnect

**Location:** `online` event handler, inside the debounced callback (~line 3575)

**Before:**
```javascript
syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    await syncOfflineSales();
    await loadProducts();
}, 1000);
```

**After:**
```javascript
syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    await syncOfflineSales();
    await loadCompanySettings();   // ← added
    await loadProducts();
}, 1000);
```

**Why this order matters:**
1. `syncOfflineSales()` — replays any queued offline sales first. These run against the current DB policy, so running before the policy refresh is correct: the sales were captured when the policy was whatever it was offline. The backend enforces the current policy on replay.
2. `loadCompanySettings()` — refreshes `companyStockPolicy.allowNegativeStock` from the API. Runs after sync so the synced sales are not affected by a freshly fetched policy.
3. `loadProducts()` — reloads the product grid. Runs last so the grid renders with the correct (now refreshed) policy for stock badge display.

**Fail-safe:** `loadCompanySettings()` is internally try/catch. If the API call fails (network still flaky after the `online` event), `companyStockPolicy.allowNegativeStock` stays at its previous value. It does not reset to `false`. This means:
- If it was `true` before going offline: it stays `true` on a failed refresh (safe — no silent downgrade)
- If it was `false` before going offline: it stays `false` (safe — strict mode preserved)
- Only a successful API response changes the in-memory value

---

### Change 2 — Offline product tile: negative-stock visual

**Location:** `displayProductsGrid()` offline branch (~line 4483)

**Before:** One branch for all non-positive estimated stock:
```javascript
if (est <= 0) {
    stockHtml = `<div class="stock-zero-est">Out of stock (est.)</div>`;
} else {
    stockHtml = `<div class="stock-estimated">~${est} (est.)</div>`;
}
```

**After:** Four distinct cases:
```javascript
if (est < 0) {
    // Estimate is already negative (offline sales drove it below zero)
    stockHtml = `<div class="stock-negative">~${est} (est.) ⚠</div>`;
} else if (est === 0 && companyStockPolicy.allowNegativeStock) {
    // At zero, policy allows further negative sales
    stockHtml = `<div class="stock-zero-neg">Out of stock (est., neg. allowed)</div>`;
} else if (est <= 0) {
    // Strict mode — zero or below (now only fires for est === 0 in strict mode)
    stockHtml = `<div class="stock-zero-est">Out of stock (est.)</div>`;
} else {
    stockHtml = `<div class="stock-estimated">~${est} (est.)</div>`;
}
```

**Case mapping:**

| `est` | `allowNegativeStock` | Class | Text | Colour |
|---|---|---|---|---|
| `< 0` | either | `.stock-negative` | `~-3 (est.) ⚠` | Red + bg |
| `=== 0` | `true` | `.stock-zero-neg` | `Out of stock (est., neg. allowed)` | Amber |
| `=== 0` | `false` | `.stock-zero-est` | `Out of stock (est.)` | Red (existing) |
| `> 0` | either | `.stock-estimated` | `~5 (est.)` | Amber italic (existing) |

**`est` source:** `product.current_stock ?? product.stock_quantity ?? 0`. `current_stock` is the locally-decremented estimate updated by offline checkout. If two offline sales have already sold 3 units below zero, `current_stock` will be negative and the red `⚠` badge appears immediately — not waiting for reconnect.

**Existing behaviour preserved:** `.stock-estimated` (amber italic) and `.stock-zero-est` (red, existing style) are unchanged for all cases where they previously applied.

---

### Change 3 — Inventory tab: negative stock highlight

**Location:** `displayStock()` function (~line 6684)

**New CSS classes added:**
```css
.stock-badge.negative { background: #b71c1c; color: #fff; font-weight: 700; }
.negative-stock { background: #fce4ec !important; }
```

The `negative` badge uses solid dark red with white text — visually distinct from `.out` (light red background, dark text). The row background `.negative-stock` uses a soft pink `#fce4ec` (slightly different from `.out-of-stock`'s `#ffebee`) to remain readable while still signalling a problem.

**Before:** `stock_quantity <= 0` mapped to `statusClass = 'out'` — negative stock and zero stock were indistinguishable:
```javascript
if (item.stock_quantity <= 0) {
    statusClass = 'out';
    statusText = 'Out of Stock';
}
```

**After:** Three distinct status levels:
```javascript
if (item.stock_quantity < 0) {
    statusClass = 'negative';
    statusText = 'Negative Stock';
} else if (item.stock_quantity === 0) {
    statusClass = 'out';
    statusText = 'Out of Stock';
} else if (item.stock_quantity <= item.min_stock_level) {
    statusClass = 'low';
    statusText = 'Low Stock';
}
```

**Row template — two additions:**
1. `negative-stock` row class when `statusClass === 'negative'`
2. `qtyStyle` inline style on the stock qty `<td>` when `stock_quantity < 0`:

```javascript
const qtyStyle = item.stock_quantity < 0 ? ' style="color:#b71c1c;font-weight:700;"' : '';
// ...
<td${qtyStyle}>${item.stock_quantity}</td>
```

This makes the negative number itself bold red, not just the badge — the quantity cell is the first column a manager scans when looking at stock levels.

**Full status table after change:**

| `stock_quantity` | Row class | Badge class | Badge text | Qty cell |
|---|---|---|---|---|
| `< 0` | `.negative-stock` (pink) | `.negative` (solid dark red, white text) | `Negative Stock` | Bold red |
| `=== 0` | `.out-of-stock` (light red) | `.out` (light red, dark text) | `Out of Stock` | Normal |
| `> 0` and `≤ min_stock_level` | `.low-stock` (amber) | `.low` (amber) | `Low Stock` | Normal |
| `> min_stock_level` | none | `.ok` (green) | `OK` | Normal |

**Existing behaviour preserved:** `stock_quantity === 0` still maps to `.out` / `Out of Stock` — only the previously collapsed `<= 0` condition is split. No change to low-stock logic.

---

## What Was NOT Changed

- `decrement_stock_v2` — untouched
- `create_sale_atomic` — untouched
- `posAuditLogger.js` — untouched
- `sales.js` — untouched
- `settings.js` — untouched
- `addToCart` / `updateQty` — untouched
- Online product grid display (the `else` branch in `displayProductsGrid`) — untouched
- No new API endpoints
- No new database objects
- No localStorage / sessionStorage

---

## Verification

### Policy refresh on reconnect

| Scenario | Expected | Verified |
|---|---|---|
| Device online → offline → manager enables negative stock → device reconnects | `loadCompanySettings()` runs inside debounced reconnect callback; `companyStockPolicy.allowNegativeStock` becomes `true` | ✅ Code path confirmed |
| `loadCompanySettings()` API call fails on reconnect | Previous in-memory policy value retained; no reset to `false` | ✅ try/catch in `loadCompanySettings()` swallows error, value unchanged |
| Reconnect event fires multiple times (network flap) | Debounce timer clears and restarts; `loadCompanySettings()` runs once at the end | ✅ `syncDebounceTimer` debounce covers `loadCompanySettings()` inside the same callback |
| Order: sync → policy → products | Sales replayed against current DB policy, then policy refreshed, then grid rendered with refreshed policy | ✅ Sequential awaits confirmed |

### Offline tile negative-stock visual

| Scenario | Expected | Verified |
|---|---|---|
| `est < 0`, either policy | `.stock-negative` (red + ⚠) | ✅ First branch, checked before zero cases |
| `est === 0`, `allowNegativeStock = true` | `.stock-zero-neg` (amber, "neg. allowed") | ✅ Second branch |
| `est === 0`, `allowNegativeStock = false` | `.stock-zero-est` (existing red, "Out of stock (est.)") | ✅ Third branch (`est <= 0` catches `est === 0` here) |
| `est > 0`, either policy | `.stock-estimated` (amber italic) — unchanged | ✅ Final branch |
| `est === -3` | `~-3 (est.) ⚠` | ✅ Template literal uses `est` directly |

**Branch ordering is correct:** `est < 0` is checked before `est === 0 && policy` before `est <= 0`. No case overlaps or falls through incorrectly.

### Inventory tab negative stock highlight

| Scenario | Expected | Verified |
|---|---|---|
| `stock_quantity = -5` | Row: `.negative-stock` (pink) / Badge: `Negative Stock` (solid dark red) / Qty: bold red `-5` | ✅ `< 0` branch |
| `stock_quantity = 0` | Row: `.out-of-stock` / Badge: `Out of Stock` — unchanged | ✅ `=== 0` branch |
| `stock_quantity = 2`, `min_stock = 5` | Row: `.low-stock` / Badge: `Low Stock` — unchanged | ✅ `<= min_stock_level` branch |
| `stock_quantity = 10`, `min_stock = 5` | No row class / Badge: `OK` — unchanged | ✅ Default `ok` |
| `qtyStyle` injected correctly | `<td style="color:#b71c1c;font-weight:700;">-5</td>` | ✅ Template literal `<td${qtyStyle}>` — attribute-safe when value is a string |

**No localStorage / sessionStorage used** — `displayStock` reads from the API response object passed as `stockItems`. `companyStockPolicy` is a module-level JS object never persisted to browser storage.

---

## Follow-Up Notes from Workstream 3A — Status After 3B

| Follow-up | Status |
|---|---|
| Refresh policy on reconnect (L5) | ✅ Resolved — `loadCompanySettings()` added to `online` handler |
| Offline tiles negative visual (L2) | ✅ Resolved — four-branch offline display added |
| Inventory tab negative highlight (Risk R3) | ✅ Resolved — `negative` status class + row highlight + bold qty cell |
| Offline sync replay conflict after policy change | Open — documented, no code change (onboarding/operational guidance) |
| `store_manager` can change stock policy (L4) | Open — by design of existing `MANAGEMENT_ROLES`; business decision |
