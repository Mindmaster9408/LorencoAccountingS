# 26 — RETAIL INVENTORY FOUNDATION VERIFIED
## Checkout Charlie — Workstream 7A Code Audit

**Date:** 2026-05-21
**Status:** ✅ Pilot-safe — 0 blocking bugs, 3 low-severity gaps
**Files Audited:**
- `accounting-ecosystem/backend/modules/pos/routes/inventory.js`
- `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js`
- `accounting-ecosystem/backend/config/pos-schema.js`
- `accounting-ecosystem/backend/config/permissions.js`
- `accounting-ecosystem/frontend-pos/index.html` (modals, JS functions, report sidebar, render functions)

---

## Audit Method

Full code read of all new routes, all new modal HTML, all new JS functions, all new render functions, and all wiring points. No running server required — all findings are from source code inspection.

---

## Checklist Results

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | New inventory tables exist and are company-scoped | ✅ PASS | All 6 tables have `company_id NOT NULL REFERENCES companies(id) ON DELETE CASCADE` |
| 2 | Stock take session creates correctly | ✅ PASS | `pos_stock_takes` header inserted before item loop; `product_count` and `variance_count` both stored |
| 3 | Stock take variance applies stock adjustment correctly | ✅ PASS | Sets exact `countedQty` (not clamped); writes `inventory_adjustments` with before/after/change/reason |
| 4 | Supplier receive updates stock correctly | ✅ PASS | `newQty = oldQty + qty` (no clamping — receive can never reduce); cost_price updated if provided |
| 5 | Transfer / wastage / spoilage updates stock correctly | ✅ PASS | `Math.max(0, oldQty - qty)` for wastage/spoilage; floor/backroom moves write transfer record but no stock change |
| 6 | Standardized adjustment reasons save correctly | ✅ PASS | 9-option `<select>` in modal; POSTed as `reason` field; backend validates `!reason` and returns 400 if missing |
| 7 | All operations create POS audit events | ✅ PASS | See detail below |
| 8 | `loadStock()` hits correct route and response field | ✅ PASS | `${API_URL}/pos/inventory?`, reads `result.inventory` |
| 9 | `submitStockAdjust()` hits correct route and payload | ✅ PASS | `POST /pos/inventory/adjust`, sends `{product_id, quantity_change, reason, notes}`, checks `response.ok` |
| 10 | Inventory report sidebar items render correctly | ✅ PASS | 3 items in new "Inventory" section; route through `loadInventoryHistoryReport()` → `renderReport()` → render function |
| 11 | Negative stock visibility still works | ✅ PASS | `displayStock()` unchanged — `stock_quantity < 0` → red badge "Negative Stock" still fires |
| 12 | No BOM / manufacturing / MRP logic added | ✅ PASS | No matches for `bom`, `manufacturing`, `work.order`, `mrp`, `production.job`, `assembly` in changed files |
| 13 | No localStorage / sessionStorage business truth added | ✅ PASS | All `localStorage.setItem()` calls in `index.html` write only `token` and `isSuperAdmin` — all in auth flows |

---

## Detailed Findings

### Check 1 — Schema: Table company scoping

**`pos_stock_takes`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE
```
Index: `idx_pos_stock_takes_company ON pos_stock_takes(company_id)` ✅

**`pos_stock_take_items`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id)
```
(No index — accessed via `stock_take_id` FK join) ✅

**`pos_supplier_receives`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE
```
Index: `idx_pos_supplier_receives_company ON pos_supplier_receives(company_id)` ✅

**`pos_supplier_receive_items`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id)
```

**`pos_stock_transfers`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE
```
Index: `idx_pos_stock_transfers_company ON pos_stock_transfers(company_id)` ✅

**`pos_stock_transfer_items`:**
```sql
company_id INTEGER NOT NULL REFERENCES companies(id)
```

All 6 tables: company-scoped at schema level + all queries filter by `req.companyId`. ✅

All routes use the shared `authenticateToken` + `requireCompany` middleware (line 23–24 of `inventory.js`). Cross-company data leakage is not possible. ✅

---

### Check 2/3 — Stock Take session creation and variance application

**Creation flow (lines 178–232):**

1. Validation: `items` array required; each item requires `product_id` and `counted_qty`
2. Insert `pos_stock_takes` header (gets `stockTake.id` back) ✅
3. Loop items sequentially:
   - Read `products.stock_quantity` for this company ✅
   - Compute `variance = countedQty - systemQty`
   - If `variance !== 0`:
     - Update `products.stock_quantity = countedQty` (exact set, no clamping) ✅
     - Insert `inventory_adjustments` with `reason: 'stock_take_variance'`, notes `Stock take #N` ✅
     - Fire `STOCK_ADJUSTED` audit event per changed product ✅
   - Insert `pos_stock_take_items` for ALL items regardless of variance ✅
4. Update header with final `variance_count` ✅
5. Fire `STOCK_TAKE_COMPLETED` audit event ✅

**Exact set is correct.** Physical count overrides system quantity — this is the intended retail stock take behaviour.

**`pos_stock_take_items` stores zero-variance rows too.** This is correct — the full count record is preserved for audit and future reference.

---

### Check 4 — Supplier Receive stock update

**Receive flow (lines 258–326):**

1. Validation: `supplier_name` required; `items` array required
2. Insert `pos_supplier_receives` header (captures `item_count`, `total_quantity`) ✅
3. Loop items:
   - Skip items with invalid `pid` or `qty <= 0` ✅
   - Read current `stock_quantity` from `products` for this company ✅
   - `newQty = oldQty + qty` (increment, no clamping) ✅
   - Update `products.stock_quantity`, optionally update `cost_price` if `item.cost_price` provided ✅
   - Insert `pos_supplier_receive_items` with `qty_before`/`qty_after` ✅
   - Insert `inventory_adjustments` with `reason: 'supplier_correction'`, notes `Receive #N: SupplierName / Ref` ✅
   - Fire `STOCK_ADJUSTED` per item ✅
4. Fire `SUPPLIER_RECEIVE_COMPLETED` overall ✅

No receive can reduce stock — no `Math.max()` clamp is applied, and `qty <= 0` items are skipped. ✅

---

### Check 5 — Transfer stock reduction logic

**Constants (lines 158–159):**
```javascript
const TRANSFER_LOCATIONS          = new Set(['floor', 'backroom', 'wastage', 'spoilage']);
const STOCK_REDUCING_DESTINATIONS = new Set(['wastage', 'spoilage']);
```

**Transfer flow (lines 347–419):**

1. Validation: both `from_location` and `to_location` must be in `TRANSFER_LOCATIONS` ✅
2. `affectsStock = STOCK_REDUCING_DESTINATIONS.has(to_location)` — stored on header record ✅
3. If `affectsStock`:
   - `newQty = Math.max(0, oldQty - qty)` — floored at zero ✅
   - Updates `products.stock_quantity` ✅
   - Inserts `inventory_adjustments` with `quantity_change: -qty`, `reason: to_location` ✅
   - Fires `STOCK_ADJUSTED` per item ✅
4. Always inserts `pos_stock_transfer_items` (even for non-stock moves) ✅
5. Fires `STOCK_TRANSFER_RECORDED` overall ✅

Floor↔backroom moves: `affectsStock = false` → no stock update, no `inventory_adjustments` insert, no `STOCK_ADJUSTED` event. Transfer record still written. ✅

---

### Check 6 — Standardized adjustment reasons

**Modal HTML (`adjustReason` select, lines 1786–1797):**
```html
<option value="">Select reason...</option>
<option value="damaged">Damaged / Broken</option>
<option value="expired">Expired / Spoilage</option>
<option value="shrinkage">Theft / Shrinkage</option>
<option value="supplier_correction">Supplier Correction</option>
<option value="opening_correction">Opening Count Correction</option>
<option value="stock_take_variance">Stock Take Variance</option>
<option value="transfer_to_floor">Transfer to Floor</option>
<option value="transfer_from_floor">Transfer from Floor</option>
<option value="manual_correction">Manual Correction</option>
```
9 values ✅

**Backend validation (line 65–67):**
```javascript
if (!reason) {
    return res.status(400).json({ error: 'reason is required for stock adjustments' });
}
```
Frontend validates `!reason` before submitting (line 7521). Backend rejects if missing. Double-validation. ✅

**Notes field:** `adjustNotes` input added (line 1801). JS reads it as `document.getElementById('adjustNotes')?.value?.trim() || null` (line 7518). Passed to backend as `notes`. ✅

---

### Check 7 — POS audit events

All 4 new event types verified in `posAuditLogger.js`:

| Event | Category | Where fired |
|---|---|---|
| `STOCK_ADJUSTED` (pre-existing) | `inventory` | Per-item in stock-take (variance), receive, transfer (wastage/spoilage), and manual adjust |
| `STOCK_TAKE_COMPLETED` (pre-existing) | `inventory` | Once per stock-take session |
| `SUPPLIER_RECEIVE_COMPLETED` | `inventory` | Once per receive session |
| `STOCK_TRANSFER_RECORDED` | `inventory` | Once per transfer session |

`SUPPLIER_RECEIVE_COMPLETED` and `STOCK_TRANSFER_RECORDED` added to both `POS_EVENTS` and `EVENT_CATEGORY` in `posAuditLogger.js`. ✅

All audit events are fire-and-forget (no `await`) — audit failure is silent and non-blocking, as required by the audit logger's design contract. ✅

---

### Check 8/9 — `loadStock()` and `submitStockAdjust()` URL fixes

**`loadStock()` (line 7426–7435):**
```javascript
let url = `${API_URL}/pos/inventory?`;
if (lowStockOnly) url += 'low_stock=true&';
// ...
displayStock(result.inventory || []);
```
URL: `/api/pos/inventory` ✅ (router mounted at `router.use('/inventory', inventoryRoutes)`)
Response field: `result.inventory` ✅ (backend returns `{ inventory: products }`)

**`submitStockAdjust()` (lines 7513–7550):**
```javascript
const response = await fetch(`${API_URL}/pos/inventory/adjust`, {
    method: 'POST',
    body: JSON.stringify({ product_id: parseInt(productId), quantity_change, reason, notes })
});
if (response.ok) { ... }
```
URL: `/api/pos/inventory/adjust` ✅
Payload: `{ product_id, quantity_change, reason, notes }` — matches backend expectation exactly ✅
Response check: `response.ok` (HTTP 2xx) ✅ (previously was `result.success` which doesn't exist)

**`quantity_change` computation (lines 7527–7530):**
```javascript
if (adjustType === 'add')         quantity_change = quantityRaw;
else if (adjustType === 'remove') quantity_change = -quantityRaw;
else                              quantity_change = quantityRaw - currentQty;  // set
```
Correct: `set` converts absolute qty to delta against current in-memory value. ✅

---

### Check 10 — Inventory report sidebar and render

**Sidebar (lines 2032–2035):**
```html
<h3 ...>Inventory</h3>
<div class="settings-menu-item" onclick="showReport('stock-takes', event)">Stock Takes</div>
<div class="settings-menu-item" onclick="showReport('stock-receives', event)">Supplier Receives</div>
<div class="settings-menu-item" onclick="showReport('stock-transfers', event)">Stock Transfers</div>
```
✅ Three items added under a new "Inventory" heading, separate from "Operational".

**`loadCurrentReport()` special-case routing (lines 5994–6007):**
```javascript
if (currentReport === 'stock-takes')    { loadInventoryHistoryReport('stock-takes',    '/pos/inventory/stock-takes', container); return; }
if (currentReport === 'stock-receives') { loadInventoryHistoryReport('stock-receives', '/pos/inventory/receives',    container); return; }
if (currentReport === 'stock-transfers'){ loadInventoryHistoryReport('stock-transfers','/pos/inventory/transfers',   container); return; }
```
These `return` before the standard `/reports/${reportType}` path, preventing 404s. ✅

**`loadInventoryHistoryReport()` URL composition (line 6097):**
```javascript
`${API_URL}${apiPath}`  // → https://host/api/pos/inventory/stock-takes
```
`API_URL = window.location.origin + '/api'` (line 3364) ✅

**Response field names — cross-checked against backend:**

| Report | apiPath | Backend response key | Render reads |
|---|---|---|---|
| stock-takes | `/pos/inventory/stock-takes` | `{ stock_takes: [...] }` | `data.stock_takes` ✅ |
| stock-receives | `/pos/inventory/receives` | `{ receives: [...] }` | `data.receives` ✅ |
| stock-transfers | `/pos/inventory/transfers` | `{ transfers: [...] }` | `data.transfers` ✅ |

**User name resolution — nested Supabase join:**
Backend uses Supabase `select('*, users:conducted_by(username, full_name)')` pattern which returns `users: { username, full_name }` as a nested object.

All three render functions correctly dereference: `(s.users && (s.users.full_name || s.users.username)) || 'Unknown'` ✅

---

### Check 11 — Negative stock visibility

`displayStock()` (lines 7449–7452) unchanged:
```javascript
if (item.stock_quantity < 0) {
    statusClass = 'negative';
    statusText = 'Negative Stock';
}
```
After any stock operation, `loadStock()` is called (lines 7612, 7681, 7752) which refreshes the display. Negative products continue to show the red "Negative Stock" badge. ✅

The existing Negative Stock Report (`GET /api/reports/negative-stock`) is unchanged — still queries `products WHERE stock_quantity < 0` live. ✅

---

### Check 12 — No BOM / manufacturing / MRP logic

Grep results across all modified files:
- Pattern `bom|bill.of.material|manufacturing|work.order|production.job|mrp|assembly|procurement.plan` → **0 matches** ✅

The system is RETAIL-ONLY. Stock quantities represent finished goods on hand. No concept of raw materials, subassemblies, production runs, or bill of materials was introduced. ✅

**Voorraad/BOM boundary is preserved and clean.** The `inventory_adjustments` table (used by all stock operations) is the natural integration point for any future manufacturing/BOM system. It records what changed, when, why, and who — a future BOM system could write to this table using its own reasons (e.g., `production_consumption`). No architectural rework required.

---

### Check 13 — No localStorage / sessionStorage business data

All `localStorage.setItem()` calls in `index.html`:

| Line | Key | What it stores |
|---|---|---|
| 3960 | `token` | JWT auth token |
| 3961 | `isSuperAdmin` | Session UI flag |
| 3969 | `isSuperAdmin` | Session UI flag |
| 3976 | `token` | JWT auth token |
| 3988 | `token` | JWT auth token |
| 3994 | `token` | JWT auth token |
| 4053 | `token` | JWT auth token |
| 9279 | `token` | JWT auth token |
| 9306 | `token` | JWT auth token |
| 10422 | `token` | JWT auth token |

**All writes are auth tokens or session UI state.** No stock quantities, no adjustment data, no inventory operation results. Fully compliant with Part D Rule D1. ✅

---

## Bugs Found

**None.** No blocking or pilot-blocking bugs found in the Workstream 7A implementation.

---

## Low-Severity Gaps (Not Bugs)

### Gap 1 — `from_location === to_location` not validated

| Field | Value |
|---|---|
| Route | `POST /api/pos/inventory/transfer` |
| Severity | LOW |
| Pilot-blocking | No |

A transfer from `floor` to `floor` passes backend validation (both values are in `TRANSFER_LOCATIONS`) and would be recorded as a no-op (visibility move, no stock change). The UI has no client-side guard against this.

**Fix when needed:**
```javascript
if (from_location === to_location) {
    return res.status(400).json({ error: 'from_location and to_location must be different' });
}
```

---

### Gap 2 — Inventory reports ignore the date range filter

| Field | Value |
|---|---|
| Routes | `GET /pos/inventory/stock-takes`, `/receives`, `/transfers` |
| Severity | LOW |
| Pilot-blocking | No |

The Reports section has a start/end date picker. That picker is only used by the `/api/reports/*` routes. The inventory history routes (`/pos/inventory/stock-takes` etc.) don't accept date parameters — they return the most recent N records unconditionally.

A manager opening these reports and setting a date range will see no filtering effect.

**Fix when needed:** Add `?startDate=&endDate=` query parameter support to the three GET routes, and pass the date values from `loadInventoryHistoryReport()`.

---

### Gap 3 — Category filter in `loadStock()` is built but backend ignores it

| Field | Value |
|---|---|
| Location | `frontend-pos/index.html` line 7428 |
| Severity | LOW — pre-existing, not introduced by 7A |
| Pilot-blocking | No |

`loadStock()` appends `category=X` to the URL when a category dropdown value is selected. The backend `GET /api/pos/inventory` selects all products and doesn't read the `category` query parameter. The backend already returns category data on each product row — client-side filtering can be added if needed without a backend change.

---

## Remaining Retail Inventory Gaps (Deferred)

These are out of scope for the pilot but represent the natural roadmap for a full retail inventory system:

| Gap | Notes |
|---|---|
| Date filter on inventory history reports | Gap 2 above — low effort to add |
| Per-session item detail in reports | Reports show session headers only; line items are in DB but not rendered |
| Barcode scan into stock take | Manual qty entry is sufficient for pilot |
| Automatic reorder point alerts | `min_stock_level` column exists — alert logic not yet wired |
| Stock take scheduled / recurring | One-off on demand is sufficient for pilot |
| Partial receive against a formal PO | No PO system yet — supplier name + reference is the GRV identity |
| Multi-location stock levels (separate quantities per location) | Single `stock_quantity` column covers one location; multi-location requires schema change |
| Cost price history / FIFO/LIFO | Optional cost price per receive is stored; no cost method logic |

---

## Voorraad / BOM Boundary Confirmation

**The retail inventory layer does NOT touch, implement, or reference any manufacturing concept.**

The clean integration boundary for a future Voorraad/BOM system is:

```
Voorraad/BOM system:
  → POST /api/pos/inventory/adjust
      reason: 'production_consumption' | 'production_output' | 'assembly_write-off'
      quantity_change: (negative for consumed, positive for produced)
      
  ← GET /api/pos/inventory
      stock_quantity: current on-hand quantity
```

The `inventory_adjustments` table already supports any `reason` string and captures `before/after/change/who/when`. No schema change is needed to integrate a future BOM system at the stock-movement level.

---

## Pilot-Safe Assessment

**All 7 Workstream 7A features are pilot-safe.**

| Feature | Pilot-Safe? | Confidence |
|---|---|---|
| Basic Stock Take | ✅ Yes | HIGH — exact count, full before/after audit trail, session record |
| Standardized Adjustment Reasons | ✅ Yes | HIGH — 9 values enforced by UI select; backend rejects missing reason |
| Supplier Receive | ✅ Yes | HIGH — increments stock, optional cost price, full audit trail |
| Transfer Tracking (floor/backroom) | ✅ Yes | HIGH — visibility-only, transfer record written, no false stock changes |
| Transfer Tracking (wastage/spoilage) | ✅ Yes | HIGH — `Math.max(0, ...)` prevents negative stock, UI warning shown |
| Inventory History Reports | ✅ Yes | HIGH — read-only, correct response field mapping, correct user join |
| `loadStock()` / `submitStockAdjust()` fixes | ✅ Yes | HIGH — correct URLs, correct payload, correct response checks |

**0 blocking bugs found. 3 low-severity gaps identified and deferred — none affect pilot operations.**
