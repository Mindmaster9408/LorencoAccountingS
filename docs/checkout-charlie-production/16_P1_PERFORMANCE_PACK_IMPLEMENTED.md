# 16 — P1 PERFORMANCE PACK IMPLEMENTED
## Checkout Charlie — Workstream 5C

**Date:** 2026-05-12
**Status:** ✅ Implemented
**Files changed:** 3

| File | Change |
|---|---|
| `backend/modules/pos/routes/sales.js` | Company settings cache — eliminates 1 DB round-trip per sale |
| `backend/modules/pos/routes/products.js` | Cache-Control headers on GET /products |
| `frontend-pos/index.html` | Grid render, table render, barcode map |

---

## Fix 1 — Server-side company settings cache (`sales.js`)

### Problem
`POST /api/pos/sales` made 3 sequential DB round-trips per sale:
1. Products lookup — necessary (price validation)
2. `company_settings` fetch — `allow_negative_stock_sales` per companyId
3. `create_sale_atomic` RPC — necessary (atomic write)

Round-trip 2 fired on every sale. Company settings change rarely (a manager might change the negative-stock policy once a month). The live fetch was unnecessary for the hot path.

### Solution
Module-level `Map<companyId, { allowNegativeStock, cachedAt }>` with a 60-second TTL.

```javascript
const _settingsCache = new Map();
const SETTINGS_CACHE_TTL_MS = 60_000;

async function getCompanyStockPolicy(companyId) {
  const cached = _settingsCache.get(companyId);
  if (cached && (Date.now() - cached.cachedAt) < SETTINGS_CACHE_TTL_MS) {
    return cached.allowNegativeStock;
  }
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('allow_negative_stock_sales')
      .eq('company_id', companyId)
      .maybeSingle();
    const allow = data?.allow_negative_stock_sales ?? false;
    _settingsCache.set(companyId, { allowNegativeStock: allow, cachedAt: Date.now() });
    return allow;
  } catch {
    return false; // Fail safe: deny negative stock on DB or cache error
  }
}
```

The inline `company_settings` fetch in `POST /` is replaced with:
```javascript
const allowNegativeStock = await getCompanyStockPolicy(req.companyId);
```

### Properties
- **TTL:** 60 seconds per companyId. After 60 seconds the next sale triggers a fresh DB fetch.
- **Multi-company safe:** `Map` is keyed by `companyId`. Each company gets its own cached entry.
- **Fail-safe:** If the DB fetch throws or returns no data, the function returns `false` (deny negative stock). This is the safe default — it means the sale will fail if stock is insufficient, not silently permit negative stock when the policy state is unknown.
- **DB remains authoritative:** The cache is a 60-second read-ahead. It does not modify or control any write path. The RPC still enforces `p_allow_negative_stock` server-side.
- **Process-scoped:** The cache lives in Node.js process memory. On server restart it is empty (first sale fetches fresh). On Zeabur deployment with a single instance this is correct. If multiple instances are ever deployed, each has its own cache — all still within TTL accuracy.

---

## Fix 2 — Products endpoint cache headers (`products.js`)

### Problem
`GET /api/pos/products` had no `Cache-Control` header. Every browser fetch — on login, reconnect, manual tab switch — hit the DB fresh. If a cashier's tab reconnects after a brief offline period, it re-fetched all products even if nothing had changed.

### Solution
```javascript
res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
res.json({ products: data || [] });
```

| Directive | Meaning |
|---|---|
| `private` | Browser cache only. CDN/proxy must not cache (contains company-isolated data). |
| `max-age=60` | Browser may serve the cached response for up to 60 seconds without re-fetching. |
| `stale-while-revalidate=30` | For 30 seconds after `max-age` expires, browser may serve stale while revalidating in background. |

**Applied to:** `GET /api/pos/products` only.

**Not applied to:** `POST`, `PUT`, `DELETE` endpoints — mutations are never cached. `GET /api/pos/products/:id` is also not cached (not on the hot path).

### Boundary
The 60-second window means that after a stock adjustment via the manager's stock tab, cashier tiles may show the pre-adjustment value for up to 60 seconds. This is acceptable:
- The authoritative stock number is always in the DB.
- Post-checkout stock updates are applied locally (Workstream 5B P0 fix) without a re-fetch.
- A manager's stock adjustment is non-time-critical for the cashier's display.

---

## Fix 3 — Barcode lookup Map (`frontend-pos/index.html`)

### Problem
`searchByBarcode()` used `products.find(p => p.product_code === barcode)` — an O(n) linear scan on every barcode scan. At 10,000 products this degrades.

### Solution

**Module-level variable (line ~3238):**
```javascript
let barcodeMap = new Map();   // O(1) barcode/product_code → product lookup; rebuilt after every products load
```

**`rebuildBarcodeMap()` function (added before `loadProducts()`):**
```javascript
function rebuildBarcodeMap() {
    barcodeMap = new Map();
    for (const p of products) {
        if (p.product_code) barcodeMap.set(p.product_code, p);
        if (p.barcode)      barcodeMap.set(p.barcode, p);
    }
}
```

Keyed by both `product_code` AND `barcode` field. The existing `searchByBarcode` matched on `product_code` — the map also indexes `barcode` (EAN/UPC) at no extra cost, so hardware barcode scanners that produce EAN-13 codes will also work.

**`loadProducts()` — calls `rebuildBarcodeMap()` after every product load**, including the fallback-to-cache path.

**Checkout success path (from Workstream 5B P0 fix) — calls `rebuildBarcodeMap()` after local stock update.** This is technically a no-op for map correctness (the map holds object references and the stock fields were mutated in place), but it keeps the map current if a product gained or lost a barcode during the session.

**`searchByBarcode()` updated:**
```javascript
function searchByBarcode(barcode) {
    const product = barcodeMap.get(barcode);   // O(1) — was O(n) find()
    ...
}
```

---

## Fix 4 — `displayProductsGrid()` — single innerHTML write + event delegation (`frontend-pos/index.html`)

### Problem
The previous implementation:
```javascript
grid.innerHTML = '';
productsToShow.forEach(product => {
    const tile = document.createElement('div');
    tile.onclick = () => addToCart(product);     // new closure per tile per render
    ...
    grid.appendChild(tile);                       // separate DOM insertion per tile
});
```

At N products this was:
- N `document.createElement()` calls
- N function closure allocations
- N separate `appendChild()` calls (N separate reflow-eligible DOM mutations)

Called on every product load, post-checkout re-render, and every search keystroke.

### Solution
```javascript
grid.innerHTML = productsToShow.map(product => {
    // build stockHtml (same logic, unchanged)
    return `<div class="product-tile" data-product-id="${product.id}">
        ...
    </div>`;
}).join('');
```

**One DOM write.** The entire grid content is replaced in a single `innerHTML` assignment. No per-tile `createElement`, no per-tile closure, no per-tile `appendChild`.

**Event delegation** — one handler on the grid element itself, set up once in `DOMContentLoaded`. Survives all subsequent `innerHTML` rewrites because the handler is on the grid container, not on the tiles:

```javascript
const productsGrid = document.getElementById('productsGrid');
if (productsGrid) {
    productsGrid.addEventListener('click', function(e) {
        const tile = e.target.closest('[data-product-id]');
        if (!tile) return;
        const productId = parseInt(tile.dataset.productId, 10);
        const product = products.find(p => p.id === productId);
        if (product) addToCart(product);
    });
}
```

`e.target.closest('[data-product-id]')` correctly handles clicks on child elements inside the tile (product-name div, price div, stock div) — any click within the tile bubbles up and is caught by the delegation handler.

### Behaviour preserved
- `addToCart(product)` called with the full product object — same as before
- All stock display logic (negative, zero, estimated, online/offline) — unchanged, same branches
- `searchByName()` calls `displayProductsGrid(filtered)` — still works (the map is on the grid element, not the tiles)
- Category filter calls `displayProductsGrid(filtered)` — still works for same reason

---

## Fix 5 — `displayProductsTable()` — single-write + safeJson computed once per row (`frontend-pos/index.html`)

### Problem
```javascript
productsToShow.forEach(product => {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td onclick="editProduct(${JSON.stringify(product).replace(/"/g, '&quot;')})">...
        <td onclick="editProduct(${JSON.stringify(product).replace(/"/g, '&quot;')})">...
        <td onclick="editProduct(${JSON.stringify(product).replace(/"/g, '&quot;')})">...
        <td onclick="editProduct(${JSON.stringify(product).replace(/"/g, '&quot;')})">...
        <td onclick="editProduct(${JSON.stringify(product).replace(/"/g, '&quot;')})">...
    `;
    tbody.appendChild(row);   // per-row DOM insertion
});
```

`JSON.stringify(product).replace(...)` was a distinct expression evaluated 5 times per product row. At 200 products: 1,000 `JSON.stringify` calls per table render. `tbody.appendChild(row)` triggered a separate DOM mutation per row.

### Solution
```javascript
tbody.innerHTML = productsToShow.map(product => {
    const safeJson = JSON.stringify(product).replace(/"/g, '&quot;');
    return `<tr>
        <td onclick="editProduct(${safeJson})">...
        <td onclick="editProduct(${safeJson})">...
        <td onclick="editProduct(${safeJson})">...
        <td onclick="editProduct(${safeJson})">...
        <td onclick="editProduct(${safeJson})">...
        <td>...</td>
    </tr>`;
}).join('');
```

`safeJson` computed **once per product** (not once per column). Single `tbody.innerHTML` write — no per-row `createElement` or `appendChild`.

At 200 products: 200 `JSON.stringify` calls (was 1,000). One DOM write (was 200 `appendChild` calls).

### Behaviour preserved
- `editProduct(${safeJson})` onclick — identical behaviour, identical serialized value
- `showProductStockModal` button with `event.stopPropagation()` — unchanged
- Stock quantity display (`product.stock_quantity || product.current_stock || 0`) — unchanged

---

## What Was NOT Changed

- `checkout()` — only touched to add `rebuildBarcodeMap()` call alongside the P0 fix
- `addToCart()` — untouched; receives the same full product object as before
- `updateCart()` — untouched
- `syncOfflineSales()` — untouched
- All backend sale correctness logic — untouched (`create_sale_atomic` RPC, stock pre-check, idempotency)
- `company_settings` DB table — untouched; cache reads from it, does not write to it
- Report routes — untouched (P2, separate workstream)
- No `localStorage`/`sessionStorage` business data added

---

## Performance Impact Summary

| Fix | Before | After |
|---|---|---|
| Company settings per sale | 1 DB round-trip per sale | 1 DB fetch per 60 s per company |
| Product list browser fetch | Every reconnect/refresh | Cached 60 s; revalidates in background |
| Grid render | N `createElement` + N closures + N `appendChild` | 1 `innerHTML` write; 1 persistent delegation handler |
| Table render | 5× `JSON.stringify` per product + N `appendChild` | 1× `JSON.stringify` per product + 1 `innerHTML` write |
| Barcode lookup | O(n) `Array.find` per scan | O(1) `Map.get` per scan |

---

## Test Checklist

| Scenario | Expected | Passes? |
|---|---|---|
| Successful online sale | Sale completes, tiles update stock | Verify |
| Product tile click | Adds product to cart | Verify — delegation handler fires |
| Click on product name inside tile | Adds product to cart | Verify — `closest('[data-product-id]')` catches child click |
| Barcode scan (product_code) | Product added to cart | Verify — map keyed by product_code |
| Barcode scan (barcode field) | Product added to cart | Verify — map also keyed by barcode |
| Negative stock tile (online) | Red badge `Stock: -N ⚠` | Verify — stock display logic unchanged |
| Negative stock tile (offline estimate) | Amber `~-N (est.) ⚠` | Verify — offline branch unchanged |
| Offline sale | Cart clears, estimated stock decrements | Verify — offline path untouched |
| Product table — click row | `editProduct()` called with full product object | Verify — safeJson still serializes correctly |
| Product table — click Manage button | `showProductStockModal()` opens | Verify — stopPropagation still works |
| Login / reconnect | `loadProducts()` fetches fresh, barcodeMap rebuilt | Verify |
| Settings change (negative stock) | Takes effect within 60 s | Acceptable per fix design |
| No localStorage/sessionStorage business data | — | Confirmed: no storage writes added |
