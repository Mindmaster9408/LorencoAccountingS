# Workstream 78 — Supplier-Linked Products + Receive/Return Price Tracking
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests against the actual extracted HTML/JS — see doc 79)
**Date:** 2026-07-08
**Scope:** `product_suppliers` link table + price tracking, supplier-scoped receive/return flows. No purchase orders, no accounting integration, no BOM/manufacturing, no checkout changes — all per ticket.

---

## Audit — What Was There Before

- `product_suppliers` (base link table: `company_id`, `supplier_id`, `product_id`) already existed live in the database and was wired to two real routes in `suppliers.js` — `GET/PUT /api/pos/suppliers/:id/products` — but the `PUT` **deleted and re-inserted the entire link set on every save**, which would have destroyed any price-tracking columns added on top of it the moment a manager edited the link list.
- **The Settings → Suppliers screen was completely dead.** `showSettings('suppliers')` called `loadSettingsSuppliers()`, a function that did not exist anywhere in the file — and the `suppliersSection` div it was supposed to show did not exist either, so the section-lookup silently found nothing and the call was never reached. Clicking "Suppliers" in Settings rendered nothing.
- Compounding that, the *other* pre-existing supplier-list function (`loadSuppliers()`, wired to a separate, unreachable `#inventoryLayout` scaffold — see below) fetched `${API_URL}/suppliers`, which resolves to a **legacy stub in `server.js`** (`app.get('/api/suppliers', ...) => res.json({ suppliers: [] })`) that always returns an empty list. The real, working suppliers endpoint has always been `/api/pos/suppliers`.
- A large, entirely orphaned scaffold — `#inventoryLayout` with sub-tabs for Stock Levels / Transfers / **Purchase Orders** / Suppliers, plus `loadPurchaseOrders()`, `showNewPOModal()`, etc. — exists in the JS with zero HTML container and zero nav button that reaches it. It is unreachable dead code. **Left untouched**, per the ticket's "do not build purchase orders" instruction and the standing rule against blind rewrites of code outside the requested scope.
- The real, live "Receive Stock" flow (`POST /api/pos/inventory/receive`, `pos_supplier_receives`/`pos_supplier_receive_items` tables) already existed and works — free-text supplier name, arbitrary product rows, optional cost price that overwrites `products.cost_price`. It had no concept of supplier-linked products, no price history, and no price-increase detection.
- No supplier return flow existed anywhere (no table, no route, no UI).

**Root cause insight:** the two real gaps this ticket needed to close were (1) `product_suppliers` had no price-tracking columns and its save path would have destroyed them anyway, and (2) the entire "Suppliers" settings screen was silently broken. Everything else (supplier list API, receive plumbing, audit logger, stock-policy service) already existed and was reused rather than rebuilt.

---

## Schema Changes

All changes are additive, in `accounting-ecosystem/backend/config/pos-schema.js` (`ensurePosSchema`, runs safely on every server startup — no separate migration step required).

**`product_suppliers`** — defensive `CREATE TABLE IF NOT EXISTS` (the base table already existed live) plus new columns:

| Column | Type | Purpose |
|---|---|---|
| `supplier_sku` | VARCHAR(100) | Supplier's own code for the item |
| `last_purchase_price` | DECIMAL(10,2) | Tracked **per supplier-product pair**, not on the product globally — the same item can cost differently from different suppliers |
| `last_purchase_date` | TIMESTAMPTZ | When that price was last confirmed via a receive |
| `preferred_supplier` | BOOLEAN | Manager-set flag |
| `notes` | TEXT | Free text |
| `updated_at` | TIMESTAMPTZ | Set on every link-metadata edit |

New indexes on `company_id`, `(company_id, supplier_id)`, `(company_id, product_id)`.

**`pos_supplier_returns`** (new) — mirrors `pos_supplier_receives`: `company_id`, `supplier_id`, `supplier_name`, `reference`, `notes`, `item_count`, `total_quantity`, `total_value`, `returned_by`, `created_at`.

**`pos_supplier_return_items`** (new) — mirrors `pos_supplier_receive_items`: `return_id`, `company_id`, `product_id`, `quantity`, `unit_cost`, `reason`, `qty_before`, `qty_after`, `created_at`.

---

## Routes Added / Updated

### `accounting-ecosystem/backend/modules/pos/routes/suppliers.js`

- `GET /api/pos/suppliers/:id/products` — **extended.** Now returns each linked product with `supplier_sku`, `last_purchase_price`, `last_purchase_date`, `preferred_supplier`, `notes`, and `cost_price` alongside the existing product fields. One endpoint now serves three consumers (Manage Linked Products, Receive from Supplier, Return to Supplier) — same shape, no duplication.
- `PUT /api/pos/suppliers/:id/products` — **rewritten from delete-all-reinsert to a diff-based upsert.** Body is now `{ links: [{ product_id, supplier_sku, preferred_supplier, notes }] }`.
  - Products removed from the set → deleted → `SUPPLIER_PRODUCT_UNLINKED` audit event.
  - Products newly added → inserted → `SUPPLIER_PRODUCT_LINKED` audit event.
  - Products present before and after → only `supplier_sku`/`preferred_supplier`/`notes` are updated; **`last_purchase_price`/`last_purchase_date` are never touched by this route** — they're written exclusively by the receive flow. This was a deliberate fix: the old delete-all-reinsert would have silently wiped price history every time a manager edited an unrelated link.

### `accounting-ecosystem/backend/modules/pos/routes/inventory.js`

- `POST /api/pos/inventory/receive` — **extended, not replaced.** All existing behaviour (stock increase, `pos_supplier_receives`/`items`, `cost_price` update, `STOCK_ADJUSTED`/`SUPPLIER_RECEIVE_COMPLETED` audit) is unchanged. New: when `supplier_id` is present and a line has a `cost_price`, the matching `product_suppliers` link (if one exists for that exact company/supplier/product) has its `last_purchase_price`/`last_purchase_date` updated, and if the new price is higher than the previously recorded one, a `SUPPLIER_PRICE_INCREASE_DETECTED` audit event fires with old price, new price, product, and supplier. **A receive against a product with no existing link leaves no price history** — the link is what defines "this supplier's price" for an item, so nothing is auto-created.
- `POST /api/pos/inventory/return` — **new.** Reduces stock for a supplier return.
  - Body: `{ supplier_name, supplier_id, reference, notes, override, items: [{ product_id, quantity, unit_cost, reason, notes }] }`.
  - Zero/blank-quantity rows are skipped (same rule as receive).
  - Reason must be one of `damaged | expired | wrong_item | over_supplied | credit_requested | supplier_collection | other`; anything else is coerced to `other`.
  - **All lines are validated before anything is written.** If any line's quantity exceeds current stock, the entire request is rejected with a `400` listing every offending product (`{ product_id, product_name, requested, current_stock }`) — no partial stock reduction from a request that would fail partway through. This is stricter than the existing receive/adjust routes (which process line-by-line and skip bad rows), which is intentional: reducing stock is the riskier direction.
  - The exceed-guard can be bypassed by the company's existing `allow_negative_stock_sales` policy (reused via the existing shared `stockPolicyCache` service — same policy the sales flow already respects) or by an explicit `override: true` on the request. The route is already `INVENTORY.ADJUST`-gated (management roles only), so an in-request override does not weaken the "management only" requirement — the requester *is* the authorized manager.
  - Writes `pos_supplier_returns`/`pos_supplier_return_items`, `inventory_adjustments` (reason `supplier_return`), `STOCK_ADJUSTED` per line, and `SUPPLIER_RETURN_COMPLETED` on completion (with `stock_override_used` in metadata when the override was actually needed).
- `GET /api/pos/inventory/returns` — new, lists the 30 most recent returns, mirrors `/receives`.

### `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js`

Four new `POS_EVENTS`, all mapped to the `inventory` action category: `SUPPLIER_PRODUCT_LINKED`, `SUPPLIER_PRODUCT_UNLINKED`, `SUPPLIER_RETURN_COMPLETED`, `SUPPLIER_PRICE_INCREASE_DETECTED`. `SUPPLIER_RECEIVE_COMPLETED` already existed and is unchanged.

---

## UI Flows

### Flow 1 — Manage Linked Products (Settings → Suppliers)

- Built the missing `suppliersSection` div (Settings sidebar → Suppliers now actually shows something) and `loadSettingsSuppliers()`, correctly pointed at `/api/pos/suppliers` (not the dead `/api/suppliers` stub).
- Each supplier row has a "Manage Linked Products" button opening `supplierLinkModal`.
- The modal searches the app's already-loaded in-memory `products` array (no new product-search endpoint needed) with a live text filter, shows a checkbox per product plus inline supplier SKU / preferred / notes fields, and pre-fills existing links from `GET /:id/products`.
- Save sends only the current checked set as `{ links: [...] }` to the diff-based `PUT`.

### Flow 2 — Receive from Supplier (Stock → "Receive from Supplier")

- New button next to the existing "Receive Stock" (free-text) button — **the old flow was kept, not replaced**, since it's still useful for ad-hoc receives from a supplier that hasn't been linked yet.
- Supplier dropdown → on select, loads that supplier's linked products via the same `GET /:id/products` endpoint used by Flow 1.
- Table columns exactly as specified: Product, Code, Supplier SKU, Current Stock, Last Price, New Price (input), price-change indicator (▲ red / ▼ green / – grey, computed live on input), Qty (input), Line Total (computed live).
- A live summary line ("N product(s) · N unit(s) · R total") updates as quantities are entered — the "summary before submit" requirement, without an extra confirmation step that would slow the screen down.
- Zero-quantity rows are excluded client-side before the request is even built.
- Submits to the existing `/inventory/receive` endpoint with `supplier_id` attached, which now also updates the price-tracking link and fires the price-increase event server-side.
- A supplier with zero linked products shows an honest static message pointing at Flow 1, not a fake empty table.

### Flow 3 — Return to Supplier (Stock → "Return to Supplier")

- New modal, same supplier-select → linked-products-table pattern.
- Per-row: current stock, quantity, unit cost (pre-filled from `last_purchase_price`, editable), reason dropdown (all 7 ticket reasons), notes.
- A `manager-only`-gated "Allow exceeding current stock" checkbox maps to the `override` flag — visible only to managers, consistent with the existing `manager-only` CSS/JS convention used elsewhere in the app.
- Submits to the new `/inventory/return` endpoint. A stock-exceed rejection surfaces the exact offending products and quantities back to the user via the standard notification, rather than a generic failure message.

---

## Price Tracking Logic

- Tracked on `product_suppliers`, one row per supplier-product pair — the same item correctly carries different `last_purchase_price` values under different suppliers.
- Only updated by a receive that (a) specifies `supplier_id`, (b) includes a `cost_price` for the line, and (c) has an existing link row for that exact company/supplier/product. No link is auto-created by a receive.
- `product.cost_price` continues to be updated by the receive route exactly as before this workstream (existing, unchanged behaviour: it's set to the latest cost price entered on *any* receive, regardless of supplier) — this workstream does not change how `cost_price` itself behaves, only adds the parallel per-supplier tracking on top of it.
- A price increase (new > last recorded) fires `SUPPLIER_PRICE_INCREASE_DETECTED` with both values. A decrease or unchanged price does not fire an event (only the receive's normal `STOCK_ADJUSTED`/`SUPPLIER_RECEIVE_COMPLETED` events do), matching the ticket's "detected" framing to increases specifically.

---

## Return Flow Detail

- Stock is only reduced after **every** line in the request has been validated against current stock (or the override/policy bypass) — an all-or-nothing write, not a partial one.
- `inventory_adjustments` gets one row per line (`reason: 'supplier_return'`, negative `quantity_change`) so returns show up in the existing stock-adjustment history alongside every other adjustment type.
- Reason is a closed enum server-side (invalid values coerce to `other`) so audit and reporting data stays clean even if a client sends something unexpected.

---

## Audit Coverage

| Event | Fired when |
|---|---|
| `SUPPLIER_PRODUCT_LINKED` | A product is newly linked to a supplier via the diff-based `PUT` |
| `SUPPLIER_PRODUCT_UNLINKED` | A product is removed from a supplier's link set |
| `SUPPLIER_RECEIVE_COMPLETED` | Unchanged, pre-existing |
| `SUPPLIER_PRICE_INCREASE_DETECTED` | A receive's new price for a linked product exceeds the previously recorded price |
| `SUPPLIER_RETURN_COMPLETED` | A return is successfully processed, includes `stock_override_used` |
| `STOCK_ADJUSTED` | Per-line, for both receive (existing) and return (new), same as every other inventory-affecting action |

All events carry user/company context automatically via `posAuditFromReq`, consistent with every other POS audit call in the codebase.

---

## Security / Company Isolation

- Every route requires `authenticateToken` + `requireCompany` (router-level, unchanged) and `requirePermission('INVENTORY.ADJUST')` for all writes / `INVENTORY.VIEW` for reads — both map to `MANAGEMENT_ROLES`/`SUPERVISOR_ROLES` respectively in `permissions.js`, satisfying "management only" for linking, receiving, and returning.
- Every query filters on `req.companyId`; product/supplier ID ownership is explicitly re-verified server-side before any write (rejects cross-company IDs with a 400, doesn't silently ignore them).
- No new browser storage of any kind — verified via diff (see doc 79).

---

## Remaining Limitations (documented, not hidden)

- Supplier creation itself remains the existing "coming soon" stub (`showNewSupplierModal()`) — out of scope; the ticket asked for linking, receiving, and returns against *existing* suppliers, not supplier CRUD.
- The orphaned `#inventoryLayout`/Purchase-Orders scaffold (dead, unreachable code) was left exactly as found. It is not part of this workstream and the ticket explicitly excludes purchase orders.
- `product.cost_price` remains a single global value updated by whichever receive happened most recently, regardless of supplier — this is pre-existing behaviour, unchanged by this workstream. Per-supplier price is now visible and tracked separately in `product_suppliers.last_purchase_price`, but the ticket did not ask for `cost_price` itself to become supplier-aware, and changing that would affect the sale/profit-report cost basis used elsewhere (`gross-profit` reports, Workstream 71) — out of scope here, flagged for a future decision if needed.

FOLLOW-UP NOTE
- Area: Product costing
- Dependency: `products.cost_price` is a single global field; profit reports (Workstream 71) join to it directly
- Confirmed now: per-supplier price history exists and is visible on the receive/return/link screens
- Not yet confirmed: whether the business wants `cost_price` itself to become supplier-aware (e.g. "cost = last price from preferred supplier") for profit reporting
- Risk if wrong: none currently — this workstream changes nothing about how `cost_price`/profit reports behave
- Recommended next review point: if/when a product is regularly received from more than one supplier at different prices and gross-profit accuracy becomes a concern
