# Checkout Charlie POS — Development TODO
> Generated from full audit — March 2026
> Priority order: CRITICAL → HIGH → MEDIUM → LOW
> Overall completeness: **~65%** — Core till/sales functional; several major features stubbed or missing

---

## SPRINT 1 — Stabilisation (Must fix before any real use)

### CRITICAL — Schema & Data Integrity

- [ ] **Fix `inventory_adjustments` table reference** in `backend/modules/pos/routes/inventory.js:80`
  - Code inserts into `inventory_adjustments` but schema defines the table as `stock_adjustments`
  - Every stock adjustment in the UI crashes with "relation not found"
  - Fix: rename table reference in `inventory.js:80` to `stock_adjustments`

- [ ] **Audit and fix field name mismatches between frontend, backend, and schema**
  - `selling_price` used in frontend/backend but schema column is `unit_price`
  - `reorder_level` used in backend but schema column is `min_stock_level`
  - `vat_inclusive` sent by frontend but schema has `requires_vat`
  - `unit` field referenced in frontend but no `unit` column in products schema
  - Fix: standardise all to schema column names; update frontend payloads and backend insert/update code
  - Files: `backend/modules/pos/routes/products.js`, `frontend-pos/index.html` (product form)

---

### CRITICAL — Stock & Sales Integrity

- [ ] **Add stock pre-check before completing a sale** in `backend/modules/pos/routes/sales.js`
  - Currently a sale can be recorded even if the item is out of stock
  - Logic: before creating the sale, query current `stock_quantity` for each cart item; if any item has insufficient stock, return 422 with which items are insufficient
  - This prevents overselling

- [ ] **Make stock decrement transactional** in `backend/modules/pos/routes/sales.js:156`
  - Sale record is created, then items inserted, then stock decremented in separate steps
  - If stock update fails, the sale and items already exist with no inventory movement
  - Fix: wrap sale creation + item inserts + stock decrements in a Supabase RPC or use a server-side `BEGIN ... COMMIT` pattern (pg transaction) so the whole thing rolls back on failure

---

### CRITICAL — Stub Removal

- [ ] **Implement daily discounts backend** — remove stub at `backend/modules/pos/index.js:34`
  - Stub always returns `{ discounts: [] }` — the feature is completely non-functional
  - Create `pos_daily_discounts` table: `id, company_id, product_id, discount_price, discount_percent, valid_from, valid_until, reason, created_by, created_at`
  - Routes: `GET /api/pos/daily-discounts`, `POST`, `PUT /:id`, `DELETE /:id`
  - Wire frontend discount modal to real data

---

## SPRINT 2 — Core Missing Workflows

### HIGH — Sale Returns / Refunds

- [ ] **Create `pos_returns` table** in schema
  - Columns: `id, company_id, original_sale_id, return_date, refund_amount, refund_method (cash/card/account), reason, items_json, status (pending/completed), processed_by_user_id, created_at`

- [ ] **Implement `POST /api/pos/sales/:id/return`** in `backend/modules/pos/routes/sales.js`
  - Validate sale exists and belongs to company
  - Validate return amount ≤ original sale amount
  - Insert into `pos_returns`
  - Reverse stock for returned items
  - Audit log the return
  - Frontend already calls this endpoint at `index.html:processReturn()`

---

### HIGH — Split Payment

- [ ] **Implement split payment recording** — new route or extend `sales.js`
  - Frontend has full split payment UI (cash + card + account method split)
  - Backend has no route for `/api/pos/sales/split-payment`
  - The `sale_payments` table needs to support multiple rows per sale (one per payment method)
  - Verify schema: `sale_payments` must have `(sale_id, method, amount)` — if single-row, extend to multi-row
  - Route: `POST /api/pos/sales/:id/payments` — accept array of `{ method, amount }` objects
  - Validate payments sum ≥ sale total

---

### HIGH — Loyalty Program

- [ ] **Create loyalty tables** in schema
  - `loyalty_programs`: `id, company_id, name, points_per_rand, redemption_rate, min_redemption_points, tier_rules_json, is_active`
  - `loyalty_transactions`: `id, company_id, customer_id, sale_id, type (earn/redeem/adjust), points, balance_after, created_at`

- [ ] **Implement loyalty endpoints** — new file `backend/modules/pos/routes/loyalty.js`
  - `GET /api/pos/loyalty/program` — get company's active program config
  - `GET /api/pos/customers/:id/loyalty` — balance + transaction history
  - `POST /api/pos/customers/:id/loyalty/earn` — record earned points from sale
  - `POST /api/pos/customers/:id/loyalty/redeem` — redeem points against a sale
  - `PUT /api/pos/loyalty/program` — update program config (admin only)

- [ ] **Wire loyalty frontend tabs** — currently calls non-existent endpoints
  - Files affected: `frontend-pos/index.html` (loyalty tab, customer detail modal)

---

### HIGH — Account Customer Payment

- [ ] **Create `customer_account_transactions` table** in schema
  - Columns: `id, company_id, customer_id, sale_id, type (charge/payment/adjustment), amount, balance_after, reference, created_at`

- [ ] **Implement account management endpoints** — extend `customers.js`
  - `GET /api/pos/customers/:id/account` — current balance + transaction history
  - `POST /api/pos/customers/:id/account/payment` — record payment against account balance
  - Credit limit enforcement: reject account sale if `current_balance + sale_total > credit_limit`
  - Update `customers.current_balance` after every account charge/payment

---

### HIGH — Input Validation Hardening

- [ ] **Add validation middleware to all POS routes**
  - Products: non-negative price/stock, barcode format check, SKU uniqueness per company
  - Sales: payment total ≥ sale total; at least one item; till session open; customer exists if account sale
  - Sessions: till exists; no existing open session for that till; non-negative opening balance
  - Inventory adjustments: reason is required; adjusted quantity can't result in negative stock without explicit "allow negative" flag

---

## SPRINT 3 — Features & Polish

### MEDIUM — Printer Configuration

- [ ] **Replace stub printer endpoints** in `backend/modules/pos/routes/receipts.js`
  - `GET /api/pos/receipts/printers` — returns fake hardcoded data
  - `POST /api/pos/receipts/printers/:id/test` — returns success without doing anything
  - `PUT /api/pos/receipts/printers/:id` — accepts data but doesn't persist
  - Fix: store printer config in `company_settings` JSONB field under key `pos_printers`
  - At minimum: persist name, connection type (usb/network/browser), ip_address, port, paper_width

### MEDIUM — Receipt Delivery (Email)

- [ ] **Implement `POST /api/pos/receipts/deliver/:saleId`**
  - Currently just logs "delivering receipt" — no actual send
  - Wire to an email service (the ecosystem already uses email somewhere — check for shared mailer)
  - Fallback: queue the delivery and log if no mailer configured

### MEDIUM — Manager Authorisation Flow

- [ ] **Complete manager authorisation modal** in frontend + backend
  - UI exists at `index.html` but validation is incomplete
  - Required for: void sale, large discount override, price override > threshold
  - Backend: `POST /api/pos/manager-auth` — verify manager password, return short-lived auth token for the action
  - Log every manager authorisation to audit trail

### MEDIUM — Variance Analysis / Cash-Up Reporting

- [ ] **Add variance analysis to cash-up** in `sessions.js`
  - After `complete-cashup`, compare `expected_cash = opening_balance + cash_sales` vs `actual_closing_balance`
  - Store `variance` and `variance_reason` columns on the session record
  - Return variance info in the close response so the UI can show it
  - Dashboard report: sessions with variance > threshold

### MEDIUM — Offline Sync Error Handling

- [ ] **Harden `syncOfflineSales()` in `frontend-pos/index.html`**
  - No error handling — if sync fails mid-queue, remaining items are dropped
  - Add retry logic: failed items stay in queue, successful items are removed
  - Add duplicate detection: check if `offline_ref` already exists server-side before inserting
  - Log sync failures to the console and surface count in UI
  - Add `offline_ref` field to offline sale payload (timestamp + random) so server can deduplicate

---

## SPRINT 4 — Advanced / Future

### LOW — Gift Card Support

- [ ] **Create `gift_cards` table**: `id, company_id, code, balance, initial_value, customer_id, expiry_date, is_active`
- [ ] **Implement gift card endpoints**: issue, check balance, redeem against sale
- [ ] Wire to the existing payment method button in the checkout UI

### LOW — Multi-Location Stock Transfers

- [ ] **Add `location_id` to product stock** (currently single-location)
- [ ] Create `pos_stock_transfers` table
- [ ] Implement `POST /api/pos/transfers` — move stock between locations
- [ ] Update inventory report to filter by location

### LOW — Shift / Time Clock

- [ ] The frontend calls `/api/scheduling/time/clock-in`, `/clock-out`, `/status`, `/shifts` — all unimplemented
- [ ] Create `employee_shifts` and `time_clock` tables
- [ ] Implement clock-in/clock-out linked to till session open/close
- [ ] Hours report per employee per period

### LOW — Loss Prevention Alerts

- [ ] Frontend calls `/api/loss-prevention/alerts` — not implemented
- [ ] Monitor for: high void rate per cashier, large discounts, returns without original sale, identical sales close together
- [ ] Store alerts in a table, surface in dashboard with severity

### LOW — Stock Take / Physical Count

- [ ] Create `stock_counts` table: `id, company_id, count_date, status, created_by, completed_at`
- [ ] Create `stock_count_lines` table: `stock_count_id, product_id, expected_qty, counted_qty, variance`
- [ ] Implement count entry (scan barcode → enter quantity)
- [ ] Auto-create stock adjustment records from count variances

### LOW — VAT Rate per Product

- [ ] Currently VAT is hardcoded at 15% in frontend (`index.html:4520`)
- [ ] Schema has `requires_vat` and `vat_rate` on products — wire these into the checkout calculation
- [ ] Backend sale creation should use the product's `vat_rate`, not a global 15%
- [ ] Affects: checkout total, receipt line items, VAT report

---

## Reference: File Locations

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

---

## Completeness Tracker

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
| Audit Trail | ✅ Done | — |
| Receipt Preview | ✅ Done | — |
| Inventory table ref (`inventory_adjustments` bug) | ❌ Broken | 1 |
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
| Multi-location transfers | ❌ Not started | 4 |
| Shift / Time Clock | ❌ Not started | 4 |
| Loss Prevention Alerts | ❌ Not started | 4 |
| Stock Take / Physical Count | ❌ Not started | 4 |
| VAT rate per product | ⚠️ Schema exists, not wired | 4 |
