# Checkout Charlie POS — Feature Builder & Progress Tracker
> Master checklist for the full Charlie roadmap. Tick items off as they are built and tested.
> Last updated: May 2026
> Status legend: ✅ Done | ⚠️ Partial | ❌ Not built | 🔒 Blocked (dependency)

---

## MIGRATIONS TRACKER
> Run these first — features depend on the correct schema being live.

| # | Migration File | What It Creates | Status |
|---|---|---|---|
| 039 | `039_pos_supplier_product_links.sql` | `product_suppliers` junction table + `supplier_id` FK on `pos_supplier_receives` | ❌ Run against Supabase |
| 040 | `040_pos_transfer_codes.sql` | `pos_transfer_codes` + `pos_transfer_imports` + `pos_transfer_import_lines` tables | ❌ Not written yet |
| — | `pos_returns` table | Sale returns / refund schema | ❌ Not written yet |
| — | `pos_daily_discounts` table | Daily discount schema | ❌ Not written yet |
| — | `loyalty_programs` + `loyalty_transactions` tables | Loyalty program schema | ❌ Not written yet |
| — | `customer_account_transactions` table | Account customer balance schema | ❌ Not written yet |
| — | `gift_cards` table | Gift card schema | ❌ Not written yet |
| — | `pos_stock_transfers` table | Multi-location stock transfer schema | ❌ Not written yet |
| — | `employee_shifts` + `time_clock` tables | Shift / time clock schema | ❌ Not written yet |
| — | `stock_counts` + `stock_count_lines` tables | Stock take / physical count schema | ❌ Not written yet |

---

## SPRINT 1 — Stabilisation (Fix before any real use)

### Critical — Schema & Data Integrity

- [ ] **Fix `inventory_adjustments` table reference** — `backend/modules/pos/routes/inventory.js:80`
  - Code inserts into `inventory_adjustments` but schema defines the table as `stock_adjustments`
  - Every stock adjustment crashes with "relation not found"
  - Fix: rename the reference in `inventory.js:80` to `stock_adjustments`

- [ ] **Fix field name mismatches (frontend ↔ backend ↔ schema)**
  - `selling_price` used everywhere but schema column is `unit_price`
  - `reorder_level` used in backend but schema column is `min_stock_level`
  - `vat_inclusive` sent by frontend but schema has `requires_vat`
  - `unit` field referenced in frontend but no `unit` column in products schema
  - Fix: standardise all names to schema columns across `products.js` and `frontend-pos/index.html`

---

### Critical — Sales & Stock Integrity

- [ ] **Add stock pre-check before completing a sale** — `backend/modules/pos/routes/sales.js`
  - Query `stock_quantity` for each cart item before writing the sale
  - Return 422 with specific items if any have insufficient stock
  - Prevents overselling

- [ ] **Make stock decrement transactional** — `backend/modules/pos/routes/sales.js:156`
  - Wrap sale creation + item inserts + stock decrements in a single DB transaction
  - If any step fails the whole thing rolls back — no orphaned sale records with no stock movement

---

### Critical — Stub Removal

- [ ] **Implement daily discounts backend** — `backend/modules/pos/index.js:34`
  - Stub always returns `{ discounts: [] }`
  - Create `pos_daily_discounts` table (see Migrations Tracker above)
  - Routes: `GET /api/pos/daily-discounts`, `POST`, `PUT /:id`, `DELETE /:id`
  - Wire frontend discount modal to real data

---

## SPRINT 2 — Core Missing Workflows

### Sale Returns / Refunds

- [ ] **Create `pos_returns` schema** (see Migrations Tracker)
  - Columns: `id, company_id, original_sale_id, return_date, refund_amount, refund_method, reason, items_json, status, processed_by_user_id, created_at`

- [ ] **Implement `POST /api/pos/sales/:id/return`** — `sales.js`
  - Validate sale exists and belongs to company
  - Validate return amount ≤ original sale amount
  - Insert into `pos_returns`
  - Reverse stock for returned items
  - Write to audit log

- [ ] **Wire frontend return flow** — `frontend-pos/index.html`
  - Frontend already calls the endpoint at `processReturn()` — confirm it sends correct payload

---

### Split Payment

- [ ] **Verify `sale_payments` table supports multiple rows per sale**
  - Schema must allow: `(sale_id, method, amount)` multi-row
  - If single-row today, extend to multi-row

- [ ] **Implement `POST /api/pos/sales/:id/payments`** — `sales.js`
  - Accept array of `{ method, amount }` objects
  - Validate payments sum ≥ sale total
  - Backend currently has no route for `/api/pos/sales/split-payment`

---

### Loyalty Program

- [ ] **Create loyalty schema** (see Migrations Tracker)
  - `loyalty_programs`: id, company_id, name, points_per_rand, redemption_rate, min_redemption_points, tier_rules_json, is_active
  - `loyalty_transactions`: id, company_id, customer_id, sale_id, type (earn/redeem/adjust), points, balance_after, created_at

- [ ] **Implement loyalty endpoints** — new file `backend/modules/pos/routes/loyalty.js`
  - `GET /api/pos/loyalty/program` — get active program config
  - `GET /api/pos/customers/:id/loyalty` — balance + history
  - `POST /api/pos/customers/:id/loyalty/earn` — earn from sale
  - `POST /api/pos/customers/:id/loyalty/redeem` — redeem against sale
  - `PUT /api/pos/loyalty/program` — update program (admin only)

- [ ] **Wire loyalty frontend tabs** — `frontend-pos/index.html` loyalty tab + customer detail modal

---

### Account Customer Balance

- [ ] **Create `customer_account_transactions` schema** (see Migrations Tracker)
  - Columns: `id, company_id, customer_id, sale_id, type (charge/payment/adjustment), amount, balance_after, reference, created_at`

- [ ] **Implement account endpoints** — extend `customers.js`
  - `GET /api/pos/customers/:id/account` — balance + transaction history
  - `POST /api/pos/customers/:id/account/payment` — record payment against balance
  - Credit limit enforcement: reject account sale if `balance + sale_total > credit_limit`
  - Update `customers.current_balance` after every charge/payment

---

### Input Validation Hardening

- [ ] **Add validation middleware to all POS routes**
  - Products: non-negative price/stock, barcode format check, SKU uniqueness per company
  - Sales: payment total ≥ sale total; at least one item; till session open; customer exists if account sale
  - Sessions: till exists; no open session for that till; non-negative opening balance
  - Inventory adjustments: reason required; adjusted qty can't result in negative stock without explicit flag

---

## SPRINT 3 — Features & Polish

### Printer Configuration

- [ ] **Replace stub printer endpoints** — `backend/modules/pos/routes/receipts.js`
  - `GET /api/pos/receipts/printers` — returns fake hardcoded data today
  - `POST /api/pos/receipts/printers/:id/test` — returns success without doing anything today
  - `PUT /api/pos/receipts/printers/:id` — accepts data but doesn't persist today
  - Fix: store printer config in `company_settings` JSONB under key `pos_printers`
  - Persist: name, connection type (usb/network/browser), ip_address, port, paper_width

### Receipt Delivery (Email)

- [ ] **Implement `POST /api/pos/receipts/deliver/:saleId`**
  - Currently just logs "delivering receipt" — no send
  - Wire to ecosystem shared mailer (check if one exists)
  - If no shared mailer: queue the delivery and log

### Manager Authorisation Flow

- [ ] **Complete manager authorisation modal** — `frontend-pos/index.html` + backend
  - Required for: void sale, large discount override, price override > threshold
  - Backend: `POST /api/pos/manager-auth` — verify manager password, return short-lived action token
  - Log every manager auth to audit trail

### Variance Analysis / Cash-Up Reporting

- [ ] **Add variance analysis to cash-up** — `sessions.js`
  - After `complete-cashup`: compare `expected_cash = opening_balance + cash_sales` vs `actual_closing_balance`
  - Store `variance` and `variance_reason` columns on session record
  - Return variance info in close response for UI display
  - Dashboard report: sessions with variance > threshold

### Offline Sync Error Handling

- [ ] **Harden `syncOfflineSales()` in `frontend-pos/index.html`**
  - No error handling today — if sync fails mid-queue remaining items are dropped
  - Add retry logic: failed items stay in queue, successful items removed
  - Add `offline_ref` (timestamp + random) to offline sale payload for server-side deduplication
  - Surface failed sync count in UI

---

## SPRINT 4 — Advanced / Future

### Gift Cards

- [ ] **Create `gift_cards` schema** (see Migrations Tracker)
  - Columns: `id, company_id, code, balance, initial_value, customer_id, expiry_date, is_active`
- [ ] **Implement gift card endpoints**: issue, check balance, redeem against sale
- [ ] **Wire to payment method button** in checkout UI

### Multi-Location Stock Transfers

- [ ] **Add `location_id` to product stock** (currently single-location assumed)
- [ ] **Create `pos_stock_transfers` schema** (see Migrations Tracker)
- [ ] **Implement `POST /api/pos/transfers`** — move stock between locations
- [ ] **Update inventory report** to filter by location

### Shift / Time Clock

- [ ] **Create `employee_shifts` + `time_clock` schema** (see Migrations Tracker)
- [ ] **Implement clock-in/clock-out** — link to till session open/close
  - Frontend calls `/api/scheduling/time/clock-in`, `/clock-out`, `/status`, `/shifts` — all unimplemented
- [ ] **Hours report per employee per period**

### Loss Prevention Alerts

- [ ] **Implement `/api/loss-prevention/alerts`** — frontend already calls it, returns nothing
- [ ] **Monitor for:** high void rate per cashier, large discounts, returns without original sale, identical sales close together
- [ ] **Store alerts in a table** — surface in dashboard with severity

### Stock Take / Physical Count

- [ ] **Create `stock_counts` + `stock_count_lines` schema** (see Migrations Tracker)
  - `stock_counts`: id, company_id, count_date, status, created_by, completed_at
  - `stock_count_lines`: stock_count_id, product_id, expected_qty, counted_qty, variance
- [ ] **Implement count entry**: scan barcode → enter quantity → confirm
- [ ] **Auto-create stock adjustment records** from count variances

### VAT Rate per Product

- [ ] **Wire product `vat_rate` into checkout calculation** — currently hardcoded at 15% in `index.html:4520`
- [ ] **Backend sale creation** must use product's own `vat_rate`, not global 15%
- [ ] **Update:** checkout total, receipt line items, VAT report

---

## SPRINT 5 — Transfer Code / Smart Supplier Receive System
> **DO NOT BUILD until explicitly authorised.**
> Full spec was agreed May 2026. This section is the build checklist once the green light is given.

### Overview
A completed sale in Charlie generates a signed transfer QR code. The buyer (another Charlie user) scans it, previews the imported items, confirms receipt — stock increases and a supplier receive record is created. All without manual data entry.

**Core rule: NEVER auto-receive. Always: Scan → Preview → Confirm.**

---

### Phase 5.1 — Database Schema

- [ ] **Run Migration 039** — `039_pos_supplier_product_links.sql`
  - Creates `product_suppliers` junction table (company_id, product_id, supplier_id)
  - Adds `supplier_id` FK to `pos_supplier_receives`

- [ ] **Write + run Migration 040** — `040_pos_transfer_codes.sql`
  - `pos_transfer_codes` table:
    ```
    id, seller_company_id, sale_id, transfer_token (signed, unique),
    status (pending | used | expired | cancelled),
    expires_at, created_at, used_at, used_by_company_id
    ```
  - `pos_transfer_imports` table (immutable once written):
    ```
    id, buyer_company_id, seller_company_id, transfer_code_id,
    imported_at, confirmed_by_user_id, items_json (snapshot at time of import), created_at
    ```
  - `pos_transfer_import_lines` table:
    ```
    id, import_id, original_product_code, original_product_name,
    matched_product_id (nullable), qty, cost_price,
    match_method (barcode | product_code | supplier_link | manual | unmatched)
    ```
  - Duplicate protection: `UNIQUE (buyer_company_id, transfer_code_id)` on `pos_transfer_imports`

---

### Phase 5.2 — Backend — Token Generation (Seller Side)

- [ ] **`POST /api/pos/transfer-codes`** — generate transfer code for a completed sale
  - Auth: seller must be authenticated; sale must belong to seller's company
  - Validates: sale exists and is completed (`status = completed`)
  - Creates a signed transfer token: `HMAC(seller_company_id + sale_id + expiry, SECRET)`
  - Inserts row into `pos_transfer_codes` (status = pending)
  - Returns: `{ transferToken, expiresAt, qrPayload }` — QR payload contains ONLY the token reference, not raw invoice data
  - Expiry: configurable per company or system default (e.g. 48 hours)

- [ ] **Token signing implementation**
  - Use HMAC-SHA256 or short JWT
  - Payload: `{ transferId, sellerCompanyId, saleId, exp }`
  - Secret stored in environment variable — never hardcoded
  - Token is short — suitable for QR code encoding

---

### Phase 5.3 — Backend — Transfer Fetch & Receive (Buyer Side)

- [ ] **`GET /api/pos/transfer-codes/:token`** — fetch transfer data for preview
  - Auth: buyer must be authenticated
  - Validates token signature
  - Validates token not expired
  - Validates token status = pending (not already used)
  - Validates buyer company ≠ seller company (can't receive your own transfer)
  - Fetches sale items from seller's company context
  - Runs product matching logic (see below)
  - Returns: seller details, item list with match status, cost prices, qtys — does NOT write anything

- [ ] **`POST /api/pos/transfer-codes/:token/receive`** — confirm stock receive
  - Auth: buyer must be authenticated
  - Re-validates token (same checks as GET — defence in depth)
  - Duplicate check: reject if `(buyer_company_id, transfer_code_id)` already exists in `pos_transfer_imports`
  - Accepts buyer's product match overrides from the preview step
  - Writes to `pos_transfer_imports` (immutable record)
  - Writes to `pos_transfer_import_lines` (one row per item)
  - Creates `pos_supplier_receives` header record
  - Creates `pos_supplier_receive_items` rows
  - Increments `stock_quantity` on matched products in buyer's company
  - Marks `pos_transfer_codes` status = `used`, sets `used_at` + `used_by_company_id`
  - Writes audit log entries: one for generate (seller), one for receive (buyer)
  - Returns: supplier receive ID, items received, stock changes

- [ ] **Product matching logic** — run during GET preview step
  - Step 1: barcode match — `products WHERE barcode = item.barcode AND company_id = buyer_company_id`
  - Step 2: product_code match — `products WHERE product_code = item.product_code AND company_id = buyer_company_id`
  - Step 3: supplier-linked match — `product_suppliers WHERE supplier_id = matched_supplier_id AND company_id = buyer_company_id` (requires Migration 039)
  - Step 4: manual fallback — mark as `unmatched`, buyer selects from dropdown in preview UI
  - Return match_method for each line so UI shows the buyer how each product was matched

---

### Phase 5.4 — Frontend — Seller Side (Generate & Print)

- [ ] **"Generate Transfer Code" button on completed sale screen**
  - Only enabled when sale `status = completed`
  - Calls `POST /api/pos/transfer-codes` — gets back token + QR payload

- [ ] **QR code generation modal**
  - Render QR from `qrPayload` using a client-side QR library (e.g. qrcode.js — no external service)
  - Show: QR code, transfer reference number, seller name, date, expiry
  - Print button: printable format (full-page or receipt-width)
  - Copy-to-clipboard button for the transfer token string

- [ ] **Printable transfer code page**
  - Clean print layout: QR large and centred, sale summary (items, total), seller name + date, "Expires: X" warning
  - CSS `@media print` rules

---

### Phase 5.5 — Frontend — Buyer Side (Scan, Preview, Confirm)

- [ ] **Transfer Code tab / entry point in Supplier Receive module**
  - Input field: paste token OR scan QR → auto-calls `GET /api/pos/transfer-codes/:token`
  - Camera scan option (if device supports it — use `getUserMedia` / QR scanner lib, graceful fallback)

- [ ] **Preview panel**
  - Show: seller company name + date of original sale
  - Item table: product name (seller's name), matched product name (buyer's), qty, cost price, match method badge
  - Unmatched items highlighted — show product search dropdown for manual match
  - Validation: all items must be matched (or explicitly marked as "skip") before Confirm is enabled

- [ ] **Manual product match dropdown**
  - Search buyer's product catalogue for unmatched items
  - Select product — updates match_method to `manual` for that line
  - "Skip item" option — marks the line as excluded from receive

- [ ] **Confirm Receive button**
  - Calls `POST /api/pos/transfer-codes/:token/receive` with match overrides
  - On success: show confirmation panel — stock changes per product, supplier receive ID, link to receive record
  - On duplicate: clear error message "This transfer code has already been received"
  - On expired: "This transfer code has expired"
  - On same company: "Cannot receive your own transfer code"

---

### Phase 5.6 — Audit & Safety

- [ ] **Append-only audit log per transfer**
  - Event: `transfer_generated` — seller, sale_id, token, timestamp
  - Event: `transfer_scanned` — buyer_company_id, token, timestamp (written on GET preview)
  - Event: `transfer_received` — buyer_company_id, supplier_receive_id, items_count, timestamp
  - Event: `transfer_duplicate_blocked` — buyer_company_id, token, timestamp
  - Event: `transfer_expired_blocked` — token, timestamp

- [ ] **Immutability gate on `pos_transfer_imports`**
  - No UPDATE or DELETE routes for import records
  - If a receive was wrong, a return/credit note flow handles it (Sprint 2 — Sale Returns)
  - Backend must reject any attempt to modify an existing import

- [ ] **Token expiry enforcement**
  - `GET /api/pos/transfer-codes/:token` must check `expires_at < NOW()` and return 410 Gone if expired
  - `POST /api/pos/transfer-codes/:token/receive` same check before writing anything
  - Background job (optional, Sprint 6+): mark expired tokens automatically in DB

- [ ] **Company isolation enforcement**
  - Every route that reads transfer data must verify the requesting company is the correct party (seller for generation, any company for receive EXCEPT seller)
  - No cross-company data leakage — buyer never sees seller's full product catalogue or pricing history

---

### Phase 5.7 — Out of Scope (DO NOT BUILD in this sprint)

The following are explicitly excluded. If requested, treat as a new future sprint:

- ❌ Automatic stock receive without Scan → Preview → Confirm
- ❌ Auto accounting / GL journal posting from transfer
- ❌ VAT / tax calculation on imported items
- ❌ Creditor / accounts payable auto-posting
- ❌ BOM / manufacturing / component breakdown
- ❌ Cross-platform transfers (Charlie → non-Charlie system)
- ❌ Transfer amendment after confirmation (use returns flow instead)

---

## SPRINT 6 — Future (Unspecified)

> Placeholder for features identified but not yet spec'd.

- [ ] TBD

---

## Overall Completeness Tracker

| Feature Area | Status | Sprint |
|---|---|---|
| Till / Cart / Checkout | ✅ Done | — |
| Product CRUD | ✅ Done | — |
| Sales Recording | ✅ Done | — |
| Stock Management (basic) | ✅ Done | — |
| Customer CRUD | ✅ Done | — |
| Till Sessions | ✅ Done | — |
| Barcode Generation | ✅ Done | — |
| Sales Reports | ✅ Done | — |
| Audit Trail (core) | ✅ Done | — |
| Receipt Preview | ✅ Done | — |
| Inventory table ref bug (`inventory_adjustments`) | ❌ Broken | 1 |
| Field name mismatches (selling_price, unit etc.) | ❌ Broken | 1 |
| Stock pre-check on sale | ❌ Missing | 1 |
| Transactional stock decrement | ❌ Missing | 1 |
| Daily Discounts | ❌ Stub | 1 |
| Sale Returns / Refunds | ❌ Not started | 2 |
| Split Payment backend | ❌ UI only | 2 |
| Loyalty Program | ❌ Not started | 2 |
| Account Customer balance | ❌ Not started | 2 |
| Input validation middleware | ⚠️ Minimal | 2 |
| Printer Config (persist) | ❌ Stub | 3 |
| Receipt Delivery (email) | ❌ Stub | 3 |
| Manager Auth flow | ⚠️ Partial | 3 |
| Variance Analysis (cash-up) | ❌ Missing | 3 |
| Offline Sync error handling | ⚠️ Partial | 3 |
| Gift Cards | ❌ Not started | 4 |
| Multi-location stock transfers | ❌ Not started | 4 |
| Shift / Time Clock | ❌ Not started | 4 |
| Loss Prevention Alerts | ❌ Not started | 4 |
| Stock Take / Physical Count | ❌ Not started | 4 |
| VAT rate per product | ⚠️ Schema exists, not wired | 4 |
| Migration 039 — Supplier-Product Links | ❌ Not run | 5 |
| Migration 040 — Transfer Code Tables | ❌ Not written | 5 |
| Transfer Code — Token Generation (backend) | ❌ Not started | 5 |
| Transfer Code — Fetch/Receive endpoints (backend) | ❌ Not started | 5 |
| Transfer Code — Product Matching Logic | ❌ Not started | 5 |
| Transfer Code — Seller UI (generate + print QR) | ❌ Not started | 5 |
| Transfer Code — Buyer UI (scan + preview + confirm) | ❌ Not started | 5 |
| Transfer Code — Audit & Safety (immutability, expiry, isolation) | ❌ Not started | 5 |

---

## File Reference

| Area | Path |
|---|---|
| POS route index | `backend/modules/pos/index.js` |
| Products routes | `backend/modules/pos/routes/products.js` |
| Sales routes | `backend/modules/pos/routes/sales.js` |
| Sessions routes | `backend/modules/pos/routes/sessions.js` |
| Inventory routes | `backend/modules/pos/routes/inventory.js` |
| Customers routes | `backend/modules/pos/routes/customers.js` |
| Categories routes | `backend/modules/pos/routes/categories.js` |
| Tills routes | `backend/modules/pos/routes/tills.js` |
| Receipts routes | `backend/modules/pos/routes/receipts.js` |
| Reports routes | `backend/modules/pos/routes/reports.js` |
| Barcodes routes | `backend/modules/pos/routes/barcodes.js` |
| KV store routes | `backend/modules/pos/routes/kv.js` |
| Frontend (all tabs) | `frontend-pos/index.html` |
| Service worker | `frontend-pos/service-worker.js` |
| Supplier-product migration | `accounting-ecosystem/migrations/039_pos_supplier_product_links.sql` |
| This tracker | `accounting-ecosystem/docs/CHECKOUT_CHARLIE_FEATURE_BUILDER.md` |
| Legacy TODO (archived) | `accounting-ecosystem/docs/CHECKOUT_CHARLIE_TODO.md` |
