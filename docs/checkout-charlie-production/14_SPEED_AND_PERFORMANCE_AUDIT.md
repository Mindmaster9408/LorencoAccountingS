# 14 — SPEED + CASHIER FLOW PERFORMANCE AUDIT
## Checkout Charlie — Workstream 5A

**Date:** 2026-05-12
**Status:** Audit complete — NO implementation in this workstream
**Scope:** Frontend rendering, API/network, offline/sync, backend query, memory/session, architecture risks
**Files audited:**
- `frontend-pos/index.html` (9,000+ lines — all relevant sections)
- `backend/modules/pos/routes/sales.js`
- `backend/modules/pos/routes/products.js`
- `backend/modules/pos/routes/reports.js`
- `backend/modules/pos/routes/inventory.js`
- `backend/config/pos-schema.js`

---

## Executive Summary

The checkout flow itself (the sale submission path) is sound. The atomic RPC, idempotency key, and offline queue design are all production-grade. The biggest cashier-speed problem is not in the sale — it is **what happens immediately after a successful sale**: a full product API fetch + full IndexedDB rewrite + two full DOM rebuilds. This happens on every single checkout, every time. It is the primary bottleneck and the highest-priority fix.

Secondary concerns are in the backend (no caching of company settings per sale, unlimited result sets in report queries) and in search/rendering (O(n) operations where O(1) lookups exist).

Nothing found is a correctness bug. All findings are performance and scaling risks.

---

## Section 1 — Frontend Rendering

### F1 — `loadProducts()` called after every successful checkout [CRITICAL]

**Location:** `frontend-pos/index.html` — `checkout()` success path (line ~4998)

**What happens on every successful sale:**
1. `await loadProducts()` — full API round-trip to `GET /api/pos/products`
2. `await cacheProducts(products)` — **blocking IndexedDB clear + N puts** (one put per product)
3. `displayProductsGrid(products)` — full DOM rebuild of product grid
4. `displayProductsTable(products)` — full DOM rebuild of product table

At 100 products, every checkout causes: 1 API fetch + 100 IndexedDB writes + 200+ DOM operations (grid + table). At 500 products this is unacceptable — the cashier cannot start the next sale until this completes because `loadProducts()` is awaited.

**Root cause:** The post-checkout refresh was added to keep the product grid up to date after stock changes. The intent is correct. The implementation — a full reload — is heavier than necessary.

**Correct approach (not implemented here):** After a successful sale, decrement the stock quantities in the in-memory `products[]` array using the sold cart items (the quantities are already known), then call `displayProductsGrid(products)` and `displayProductsTable(products)` directly. Skip the API fetch and IndexedDB write entirely. `loadProducts()` should only be called on: login, reconnect, manual refresh, or after a stock adjustment.

**Impact:** Slowest point in the entire cashier flow. Directly adds latency between every sale.

---

### F2 — `displayProductsGrid()` — full DOM rebuild, O(n) operations, per-tile closure allocation [HIGH]

**Location:** line 4556

```javascript
grid.innerHTML = '';                            // clear
products.forEach(product => {
    const tile = document.createElement('div'); // new element per product
    tile.onclick = () => addToCart(product);    // new closure per product
    grid.appendChild(tile);                     // O(n) appends
});
```

**Problems:**
- No virtualization. All N products are rendered at once, including those off-screen.
- `grid.innerHTML = ''` + `appendChild` per tile = N DOM insertions per render.
- Each render allocates N new function closures (`() => addToCart(product)`).
- Called on every `loadProducts()` (post-checkout, login, reconnect) and every `searchByName()` keystroke.

**At 200 products, every keystroke in the search box triggers 200 DOM insertions + 200 closure allocations (after 300ms debounce).**

**Correct approach:** Use a single `innerHTML` assignment with a template literal map (same as `displayStock()` already does). For search filtering, this alone cuts allocation cost significantly. Virtual scrolling is a future-workstream concern.

---

### F3 — `displayProductsTable()` — 5 × `JSON.stringify()` per product row [HIGH]

**Location:** line ~4606

```javascript
products.forEach(product => {
    const safeJson = JSON.stringify(product).replace(/"/g, '&quot;');
    // safeJson used in onclick of 5 separate columns:
    row.innerHTML = `
        <td onclick="selectProduct(${safeJson})">...</td>
        <td onclick="selectProduct(${safeJson})">...</td>
        <td onclick="selectProduct(${safeJson})">...</td>
        <td onclick="selectProduct(${safeJson})">...</td>
        <td onclick="selectProduct(${safeJson})">...</td>
    `;
    tbody.appendChild(row);
});
```

**Problems:**
- `JSON.stringify(product)` called once per row, but `safeJson` is then inserted into 5 onclick attributes. The same serialization result is repeated 5 times in the HTML string.
- `tbody.appendChild(row)` inside the loop triggers N reflows.

**At 200 products:** 200 `JSON.stringify` calls + 5 × 200 innerHTML injections of the full product JSON + 200 DOM appends.

**Correct approach:** Build one string per row. Compute `safeJson` once. Use `tbody.innerHTML = rows.join('')` instead of per-row `appendChild`.

---

### F4 — `searchByName()` — full DOM rebuild on every keystroke [MEDIUM]

**Location:** line 4701

```javascript
function searchByName(query) {
    const filtered = products.filter(p =>
        p.product_name.toLowerCase().includes(query.toLowerCase())
    );
    displayProductsGrid(filtered);  // full DOM rebuild
}
```

With 300ms debounce this is acceptable for small catalogues. At 500+ products, each debounced keystroke triggers a 500-element DOM rebuild. The filter itself is O(n) which is unavoidable, but calling `displayProductsGrid()` (which recreates all DOM nodes) on every filtered result is wasteful.

**Correct approach:** When F2 is fixed to use a single `innerHTML` template write, the cost drops significantly. For larger catalogues, consider keeping a single rendered list and toggling `display: none` on non-matching tiles rather than rebuilding.

---

### F5 — Barcode lookup is O(n) linear scan [LOW]

**Location:** line 4690

```javascript
function searchByBarcode(barcode) {
    const product = products.find(p => p.barcode === barcode);
    ...
}
```

`Array.find()` is O(n). For a 10,000-product catalogue, every barcode scan traverses the full array. This is fast in practice for < 1,000 products but degrades at scale.

**Correct approach:** Build `const barcodeMap = new Map()` after every `loadProducts()` call. Barcode lookup becomes O(1).

---

### F6 — `updateCart()` — full cart DOM rebuild on every item change [LOW]

**Location:** line 4758

```javascript
function updateCart() {
    container.innerHTML = '';
    cart.forEach(item => {
        const el = document.createElement(...);
        container.appendChild(el);
    });
}
```

Called on every `addToCart()`. Cart is small (< 20 items in practice) so the absolute cost is low. However, the pattern of clearing `innerHTML` and rebuilding from scratch means every quantity change causes a full repaint of the cart.

**Not blocking cashier speed today. Acceptable for current scale.**

---

### F7 — `updateOfflineBanner()` reads all IndexedDB records per sync step [LOW]

**Location:** line 3566, called at line 3506 during sync cycle

```javascript
const all = db ? await new Promise(resolve => {
    const req = tx.objectStore('offlineSales').getAll();   // reads ALL records
    ...
}) : [];
const nPending  = all.filter(s => !s.status || s.status === 'pending').length;
const nConflict = all.filter(s => s.status === 'conflict_stock' || ...).length;
const nFailed   = all.filter(s => s.status === 'failed').length;
```

Called fire-and-forget (not awaited) during each sale in a sync cycle. In a 20-sale catch-up batch: 20 `getAll()` reads of IndexedDB. Since it's fire-and-forget it does not block the sync cycle, but it does generate 20 full IndexedDB reads that compete with sync writes.

**Correct approach (future):** Maintain a module-level counter `{ pending: 0, conflict: 0, failed: 0 }` updated on every queue state transition. Banner reads from the counter instead of IndexedDB.

---

### F8 — Modal DOM nodes: no accumulation risk [PASS]

`showOfflineSaleModal()` and `showSaleCompleteModal()` both create nodes via `document.createElement`. `closeSaleCompleteModal()` (line 5106) correctly calls `modal.remove()`. No DOM node accumulation. ✅

---

### F9 — Module-level arrays: no unbounded growth [PASS]

- `products[]` (line 3214): replaced entirely on every `loadProducts()`. No accumulation. ✅
- `cart[]` (line 3215): reset to `[]` on successful checkout. No accumulation. ✅
- `categories` (line 3216): `Set` rebuilt from products on every load. No accumulation. ✅

---

### F10 — `displayStock()` — efficient innerHTML pattern [PASS]

```javascript
tbody.innerHTML = stockItems.map(item => `<tr>...</tr>`).join('');
```

Single DOM write. This is the correct pattern. The products grid and table should match this approach. ✅

---

## Section 2 — API and Network

### N1 — `GET /api/pos/products`: no pagination, no limit, no cache headers [HIGH]

**Location:** `backend/modules/pos/routes/products.js`

```javascript
const { data, error } = await supabase
    .from('products')
    .select('*, categories(name)')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('product_name');      // full-table sort on every call
```

- No `.limit()` — returns all active products in one response
- No `Cache-Control` headers on the response — every reconnect fetches fresh
- `order('product_name')` — full-table sort on every request (mitigated by DB-side index if it exists)
- JOIN with categories on every call

**At 5,000 products:** large JSON payload, slow sort, uncached. Every reconnect, every `loadProducts()` after checkout, hits this endpoint fresh.

**Quick wins:**
- Add `Cache-Control: max-age=60` on the response — browser caches for 60 seconds
- Add `ETag` based on a product-list version number or `MAX(updated_at)` — enables 304 Not Modified responses on unchanged data
- Long term: add pagination (`?page=1&limit=100`)

---

### N2 — `POST /api/pos/sales`: 3 sequential DB round-trips per sale [MEDIUM]

**Location:** `backend/modules/pos/routes/sales.js`

```javascript
// Round-trip 1: products validation
const { data: productRows } = await supabase
    .from('products').select(...).in('id', productIds)...

// Round-trip 2: company_settings — SEPARATE QUERY ON EVERY SALE
const { data: companySettings } = await supabase
    .from('company_settings').select('allow_negative_stock_sales')
    .eq('company_id', req.companyId).maybeSingle();

// Round-trip 3: atomic RPC
const { data: rpcResult } = await supabase.rpc('create_sale_atomic', {...});
```

The `company_settings` fetch (round-trip 2) runs on every single sale. Company settings change rarely (a manager might change the negative-stock policy once a month). Fetching it fresh on every sale adds one Supabase network round-trip.

**Fix:** Cache company settings server-side. A module-level `Map<companyId, { settings, cachedAt }>` with a 60-second TTL eliminates this round-trip entirely for normal trading.

**Impact:** At 200 sales/day: 200 unnecessary `company_settings` queries. At 2,000 sales/day with multiple tills: significant.

---

### N3 — `GET /api/reports/sales-summary`: unlimited row fetch [HIGH RISK AT SCALE]

**Location:** `backend/modules/pos/routes/reports.js` line 30–57

```javascript
const { data: sales, error } = await supabase
    .from('sales')
    .select('total_amount, vat_amount, discount_amount, status, created_at, payment_method')
    .eq('company_id', req.companyId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);
    // No .limit() — fetches ALL sales in the date range
```

All aggregation (totals, payment breakdown, void count) is done in JavaScript on the Node.js server after fetching all rows. For a business with 3 years of data and no date filter: this query returns every sale record ever, loads all of them into memory, and performs in-process aggregation.

**Risk:** Memory spike + long response time for large date ranges. This is a hidden time bomb.

**Fix:** Move aggregation to the DB (`GROUP BY`, `SUM()` in PostgreSQL) or add mandatory `LIMIT` + date-range cap. The query should never return more than a few thousand rows.

---

### N4 — `GET /api/reports/top-products`: fetches ALL sale_items in date range [HIGH RISK AT SCALE]

**Location:** `backend/modules/pos/routes/reports.js` line 74–103

```javascript
const { data } = await query;   // ALL sale_items matching date range, no limit

const productMap = {};
(data || []).forEach(item => {
    // in-process aggregation
});
```

The `sale_items` JOIN through `sales!inner(company_id, status, created_at)` with no `.limit()` can return millions of rows for a high-volume business over any significant date range. In-process aggregation on Node.js with millions of rows causes memory pressure and long CPU hold time.

**Fix:** Use a `GROUP BY product_id, product_name` with `SUM(quantity)` and `SUM(line_total)` in the DB query. Let PostgreSQL do the aggregation.

---

### N5 — `GET /api/pos/inventory`: no pagination [MEDIUM]

**Location:** `backend/modules/pos/routes/inventory.js` line 34–39

Same pattern as products endpoint — fetches all active products with categories JOIN, no limit, no cache headers.

---

## Section 3 — Offline / Sync

### O1 — `syncOfflineSales()`: sequential processing [DESIGN CHOICE — documented]

**Location:** line 3461

Sales are processed one at a time:
```javascript
for (const sale of pendingSales) {
    response = await fetch(...)   // sequential: await each sale before starting next
    ...
}
```

This is intentional — serial processing avoids race conditions in the atomic RPC (concurrent sales from the same device could conflict on stock). It is a safe, correct design.

**Trade-off:** A 20-sale offline backlog takes 20 sequential round-trips to sync. With ~200ms round-trip latency: ~4 seconds for 20 sales. Acceptable.

**Future option (not now):** A safe parallel batch of 3 concurrent sales (separate `Promise.all` groups) would reduce sync time while maintaining acceptable conflict risk. Flag for future consideration only.

---

### O2 — `cacheProducts()`: full clear + N puts on every call [MEDIUM]

**Location:** line 3285

```javascript
const tx = db.transaction('products', 'readwrite');
await store.clear();                          // clears all products
for (const product of productList) {
    store.put(product);                       // one put per product
}
```

This is called inside `loadProducts()` on every checkout success. At 500 products: 500 IndexedDB write operations per sale. The `await` before `store.clear()` makes this blocking for the transaction duration.

**Impact linked to F1:** Fix F1 (remove `loadProducts()` from checkout success path) and O2 is no longer triggered after every sale.

**Remaining concern:** On login or reconnect, `cacheProducts()` correctly runs once. The clear-and-reinsert pattern is safe but inefficient for large catalogues. A smarter approach would be to diff and update only changed products (using `updated_at` comparison). Not urgent until F1 is fixed.

---

### O3 — `updateOfflineBanner()` during sync: full IndexedDB read per sale [LOW]

Covered in F7. Non-blocking due to fire-and-forget pattern. Low priority.

---

### O4 — Offline queue design: correct and safe [PASS]

- `syncInProgress` guard: only one sync cycle runs at a time ✅
- `syncDebounceTimer`: prevents hammering on network flap ✅
- Mid-cycle offline detection: `if (!isOnline) break` stops cleanly ✅
- `idempotencyKey`: prevents duplicate sales on retry ✅
- `syncAttempts` tracking + 3-attempt threshold before `failed` ✅
- Manager retry resets `syncAttempts = 0` and `status = 'pending'` ✅

---

## Section 4 — Backend Performance

### B1 — `create_sale_atomic` RPC: correct and atomic [PASS]

The RPC handles stock decrement + sale creation in a single PostgreSQL transaction. No partial-commit risk. Correct. ✅

---

### B2 — Database indexes: partially visible, gaps possible [RISK FLAG]

From `pos-schema.js`, new tables have indexes:
- `inventory_adjustments(company_id)` ✅
- `pos_daily_discounts(company_id)` ✅
- `pos_returns(company_id)`, `pos_returns(original_sale_id)` ✅
- `loyalty_transactions(company_id, customer_id)` ✅
- `customer_account_transactions(company_id, customer_id)` ✅

**Not visible in audited files** — indexes on core tables (`products`, `sales`, `sale_items`, `till_sessions`). These exist in the main `schema.sql` which was not audited in this workstream.

**Required indexes for performance at scale (confirm in next DB audit):**

| Table | Index needed | Used by |
|---|---|---|
| `products` | `(company_id, is_active)` | Products endpoint, reports |
| `sales` | `(company_id, created_at)` | All reports, dashboard |
| `sales` | `(company_id, status)` | Reports filters |
| `sale_items` | `(product_id)` | Top-products report |
| `till_sessions` | `(company_id, status, opened_at)` | Recovery sessions endpoint |
| `pos_audit_events` | `(company_id, event_type, created_at)` | Audit queries |

```
FOLLOW-UP NOTE
- Area: Core table DB indexes
- What was done: Indexes confirmed on new POS schema tables in pos-schema.js
- Not yet confirmed: Indexes on products, sales, sale_items, till_sessions, pos_audit_events
- Risk if wrong: Full table scans on core POS queries at scale — report queries will be very slow
- Recommended next: Run EXPLAIN ANALYZE on sales-summary, top-products, and GET /products
                    queries in Supabase dashboard; add missing indexes
```

---

### B3 — `GET /api/pos/inventory` low_stock filter: done in JavaScript [LOW]

**Location:** `inventory.js` line 44–46

```javascript
if (low_stock === 'true') {
    products = products.filter(p => p.stock_quantity <= (p.min_stock_level ?? 10));
}
```

Fetches all products from the DB, then filters in JavaScript. Should be a DB-side `.lte()` filter to avoid fetching all products when only low-stock ones are needed. Low priority — inventory page is manager-only and not on the checkout hot path.

---

## Section 5 — Memory and Session

### M1 — No unbounded module-level array growth [PASS]

- `products[]`: replaced on every `loadProducts()` — GC'd correctly ✅
- `cart[]`: replaced on every successful checkout — no growth ✅
- `categories` Set: rebuilt on every load — no growth ✅

### M2 — Multiple module-level `let` declarations mid-script [NOTE]

Scattered `let` declarations across the file (lines 4165, 4169, 4837, 4901, 5766, 6419, 6715, 6899, 7159, 8226, 8458, 8789, 9579, 9580, 9584). These are feature-scoped state variables added as features were built. No memory risk — they are all bounded values. But they signal the file is growing in complexity. Architecture concern, not a performance concern today.

### M3 — No dynamic event listener accumulation [PASS]

Static event listeners set up at load time. No dynamic listeners added per-sale. ✅

---

## Section 6 — Architecture and Future Readiness

### A1 — Single-file frontend: 9,000+ lines [ARCHITECTURAL RISK]

Every cashier page load downloads and parses 9,000+ lines of inline JavaScript. No code splitting, no lazy loading, no minification in production. As features are added (coaching tab, new POS modules), this grows.

**Current impact:** Acceptable on modern devices and connections. On low-end Android tablets on 3G connections (common in South African retail environments), first-load parse time may be noticeable.

**Future workstream (not now):** Split into feature modules. Lazy-load non-till tabs (reports, settings, recovery, stock) on first navigation.

---

### A2 — No HTTP caching strategy [MEDIUM]

`GET /api/pos/products` and `GET /api/pos/inventory` return no `Cache-Control` or `ETag` headers. Every request fetches fresh from the DB. On reconnect or tab refresh, full data is fetched even if unchanged.

**Quick win:** Add `Cache-Control: max-age=60, stale-while-revalidate=30` to both endpoints. The browser caches the response for 60 seconds and serves stale while refreshing in the background. Eliminates redundant fetches for the most common case (a cashier's tab that has been open for hours).

---

### A3 — `DB_VERSION = 1`: no upgrade path defined [LOW — FUTURE RISK]

**Location:** line 3235

If a future release needs to add a new IndexedDB object store or index (e.g., for cached customers, session data), `DB_VERSION` must be incremented and an `onupgradeneeded` upgrade handler must be provided. Currently `DB_VERSION = 1` with a single initial create handler. This is a future maintenance risk, not a today problem.

---

## Section 7 — What Is Already Good

| Area | Detail |
|---|---|
| `syncInProgress` guard | Prevents concurrent sync cycles — correct ✅ |
| `syncDebounceTimer` | Prevents network-flap hammering ✅ |
| Mid-cycle offline detection | `break` on `!isOnline` mid-sync ✅ |
| `idempotencyKey` | Prevents duplicate sales on retry ✅ |
| `syncAttempts` + 3-attempt threshold | Prevents infinite retry loops ✅ |
| `create_sale_atomic` RPC | Atomic stock + sale — no partial commits ✅ |
| `closeSaleCompleteModal()` | `modal.remove()` — no DOM node accumulation ✅ |
| `displayStock()` innerHTML pattern | Single DOM write — efficient ✅ |
| IndexedDB for offline queue | Not localStorage — correct per CLAUDE.md Part D ✅ |
| Recovery endpoints fire-and-forget | Do not block checkout flow ✅ |
| `escHtml()` on recovery panel | XSS protection applied ✅ |
| `pos-schema.js` auto-migration | Safe `IF NOT EXISTS` — runs on startup ✅ |
| `companyStockPolicy` from API | Not from localStorage — correct ✅ |
| `checkAndClearStaleCaches()` | Clears IndexedDB on company switch — correct ✅ |

---

## Priority-Ranked Optimization Plan

### P0 — Blocking cashier speed today

| # | Action | File | Benefit |
|---|---|---|---|
| 1 | **Remove `await loadProducts()` from checkout success path** | `frontend-pos/index.html` — `checkout()` | Eliminates API fetch + 500 IndexedDB writes + 2× DOM rebuild after every sale. Biggest single win. |

**Correct pattern:** After successful checkout, decrement stock quantities in the in-memory `products[]` array from the known cart items, then call `displayProductsGrid()` and `displayProductsTable()` directly. No API call needed.

---

### P1 — High value, low risk

| # | Action | File | Benefit |
|---|---|---|---|
| 2 | Cache `company_settings` server-side (60s TTL per companyId) | `backend/modules/pos/routes/sales.js` | Removes 1 DB round-trip per sale |
| 3 | Add `Cache-Control: max-age=60` to `GET /products` | `backend/modules/pos/routes/products.js` | Browser serves cached product list for 60s; eliminates redundant fetches |
| 4 | Fix `displayProductsGrid()`: use `innerHTML = map().join('')` | `frontend-pos/index.html` | Eliminates per-tile closure allocation; matches the efficient `displayStock()` pattern |
| 5 | Fix `displayProductsTable()`: compute `safeJson` once per row; use `tbody.innerHTML = rows.join('')` | `frontend-pos/index.html` | Eliminates 4× redundant JSON.stringify per row; eliminates per-row DOM append reflow |

---

### P2 — Medium priority

| # | Action | File | Benefit |
|---|---|---|---|
| 6 | Barcode lookup: `Map<barcode, product>` built after loadProducts | `frontend-pos/index.html` | O(n) → O(1) barcode scan |
| 7 | Add `LIMIT` + DB-side aggregation to `/reports/sales-summary` | `backend/modules/pos/routes/reports.js` | Prevents memory spike on large date ranges |
| 8 | Add DB-side `GROUP BY` to `/reports/top-products` | `backend/modules/pos/routes/reports.js` | Prevents millions-of-rows in-process aggregation |
| 9 | Move low-stock filter to DB in `GET /api/pos/inventory` | `backend/modules/pos/routes/inventory.js` | Fetch only needed rows when low-stock filter is active |
| 10 | Confirm core DB indexes exist (products, sales, sale_items, till_sessions) | Supabase dashboard | Prevent full-table scans at scale |

---

### P3 — Architectural (future workstream)

| # | Action | Benefit |
|---|---|---|
| 11 | `updateOfflineBanner()`: maintain module-level count instead of IndexedDB getAll | Eliminate 20+ full IndexedDB reads in a sync catch-up cycle |
| 12 | Lazy-load non-till tabs (reports, settings, recovery, stock) | Reduce initial parse time on low-end devices |
| 13 | Parallel offline sync (batch of 3) | Reduce catch-up time for large offline queues |
| 14 | `cacheProducts()`: diff-based update using `updated_at` | Avoid full clear + reinsert for product caches (only relevant after P0 is fixed) |

---

## Summary Table

| Finding | Area | Severity | Fix Priority |
|---|---|---|---|
| `loadProducts()` on every checkout | Frontend | **Critical** | P0 |
| `displayProductsGrid()` closure allocation per tile | Frontend | High | P1 |
| `displayProductsTable()` 5× JSON.stringify per row | Frontend | High | P1 |
| No HTTP cache headers on products endpoint | API | High | P1 |
| `company_settings` fetched on every sale | Backend | Medium | P1 |
| `searchByName()` full DOM rebuild per keystroke | Frontend | Medium | P1 (fixed by F2 fix) |
| `/reports/sales-summary` unlimited row fetch | Backend | High risk at scale | P2 |
| `/reports/top-products` in-process aggregation | Backend | High risk at scale | P2 |
| Barcode lookup O(n) scan | Frontend | Low | P2 |
| DB indexes unconfirmed on core tables | Database | Risk flag | P2 |
| `updateOfflineBanner()` full IndexedDB read per sync step | Offline | Low | P3 |
| Single-file 9,000-line frontend | Architecture | Medium (future) | P3 |
| Sequential sync (by design) | Offline | Trade-off | P3 |

---

## What Was NOT Changed

This is an audit workstream only. No code was modified. No new features were added. No optimizations were implemented.

All implementation is deferred to subsequent workstreams, reviewed and approved one item at a time.
