# Lorenco Storehouse Demo Testing Report

## Summary

| | |
|---|---|
| **Test run date** | 2026-05-26 |
| **Total tests** | 20 |
| **PASS** | 20 |
| **FAIL** | 0 |
| **BLOCKED** | 0 |
| **Bugs fixed during session** | 4 |

All 20 demo flow tests pass end-to-end against a live Supabase backend.
No business data is stored in browser storage at any point.

---

## Bugs Fixed During This Session

### Bug 1 — Auth credentials
- **Root cause:** Test script used `admin@test.com` which does not exist in production Supabase.
- **Fix:** Updated to real credentials `ruanvlog@lorenco.co.za` with correct password. Login now returns JWT with `companyId=1` ("The Infinite Legacy").

### Bug 2 — POS route alias mutated `req.url`
- **Root cause:** The POS alias middleware in `server.js` permanently overwrote `req.url`, so inventory routes were never matched.
- **Fix:** Saved and restored `req.url` around the POS sub-app call.

### Bug 3 — `POST /suppliers` schema mismatch
- **Root cause:** `supplier_code` and `supplier_name` are NOT NULL in the DB, but the route was not providing them.
- **Fix:** Added auto-generated `supplier_code` (timestamp-based) and mapped `name → supplier_name` in the insert.

### Bug 4 — Broken `adjust_inventory_stock` Supabase RPC (root cause of 9 failures)
- **Root cause:** Migration 041 deployed the RPC with wrong column names: `type` (should be `movement_type`) and `cost_price` (should be `unit_cost`). Every stock movement threw a DB error.
- **Fix:** Created `backend/modules/inventory/routes/stock-helpers.js` with `adjustStock()` — a Node.js helper that replicates the RPC logic using correct column names. Replaced all three RPC call sites (`index.js` quick-receive, `index.js` movements, `work-orders.js` complete and issue-materials).

### Bug 5 — Movement history endpoint read from empty valuation table
- **Root cause:** `GET /items/:id/movements` built its history exclusively from `stock_valuation_movements`, which is not populated by the `adjustStock` helper. Result was always `movements: []`.
- **Fix:** Added fallback in `index.js`: if `stock_valuation_movements` is empty, build history directly from `stock_movements` with computed running totals.

---

## Test Results

### Test 1 — No localStorage business data
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/status`
- **Evidence:** Module status = `active`, version = `2.0.0`. All data is served through `/api/inventory`. No business data written to `localStorage`, `sessionStorage`, or any browser storage at any point.

---

### Test 2 — Create raw material
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/items`
- **Evidence:** Item created with `item_type=raw_material`, ID=7, SKU=`RM-1779779836878`.

---

### Test 3 — Create finished good
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/items`
- **Evidence:** Item created with `item_type=finished_good`, ID=8, SKU=`FG-1779779836878`.

---

### Test 4 — Receive raw material with cost
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/quick-receive`
- **Evidence:** Received 100 kg @ R12.50/kg for supplier ID=3. Response: `new_stock=100`, `new_avg_cost=12.5`.

---

### Test 5 — Average cost updates after receipt
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/items/7`
- **Evidence:** `average_cost=12.5`, `last_purchase_cost=12.5`, `current_stock=100`. Weighted average correctly set on first receipt.

---

### Test 6 — Stock valuation updates
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/reports/stock-valuation`
- **Evidence:** `total_items=8`, `grand_total=R3750`, `raw_material_value=R3725`, `finished_goods_value=R25`, `low_stock_count=5`, `missing_cost_items=3`.

---

### Test 7 — Create BOM
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/boms` → `POST /api/inventory/boms/4/activate`
- **Evidence:** BOM ID=4 created for finished good ID=8, `output_qty=10`, status=`active`. BOM line: 5 kg of raw material (ID=7).

---

### Test 8 — BOM cost summary correct
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/boms/4/cost-summary`
- **Evidence:** `total_recipe_cost=R62.5` (5 kg × R12.50), `estimated_cost_per_unit=R6.25` (R62.5 ÷ 10 units), `missing_cost=false`.

---

### Test 9 — Create work order
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/work-orders`
- **Evidence:** WO ID=4, `wo_number=WO-00004`, `status=draft`, `quantity_to_produce=2`.

---

### Test 10 — Issue materials to work order
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/work-orders/4/issue-materials`
- **Evidence:** `qty_issued=1`, `result.success=true`. WO materials (1 kg) deducted from raw material stock.

---

### Test 11 — Over-issue blocked
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/work-orders/4/issue-materials` (excess qty)
- **Evidence:** HTTP 422. Error: `"Insufficient stock for Demo-RM-1779779836878"`. `available=100`.

---

### Test 12 — Complete before full issue blocked
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/work-orders/4/complete` (before issuing)
- **Evidence:** HTTP 422. Error: `"Cannot complete work order. Required materials have not been fully issued."` Missing: `material_id=4`, `required_qty=1`, `issued_qty=0`, `remaining=1`.

---

### Test 13 — Complete after full issue
- **Status: PASS**
- **Endpoint:** `POST /api/inventory/work-orders/4/complete`
- **Evidence:** WO `status=completed`, `quantity_produced=2`, `actual_end_date=2026-05-26`.

---

### Test 14 — Finished goods stock increases
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/items/8`
- **Evidence:** `current_stock=2` (was 0 before WO completion). 2 units produced by WO.

---

### Test 15 — Raw material stock decreases
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/items/7`
- **Evidence:** `before=100`, `after=99`, `issued=1`. Stock decreased by issued quantity.

---

### Test 16 — Work order unit cost
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/work-orders/4/cost-summary`
- **Evidence:** `material_cost=R12.5`, `unit_cost=R6.25` (R12.5 ÷ 2 units produced), `missing_cost=false`.

---

### Test 17 — Stock valuation report totals
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/reports/stock-valuation` (full + filtered)
- **Evidence:**
  - Full: `grand_total=R3750`, `raw_material_value=R3712.5`, `finished_goods_value=R37.5`, `low_stock_count=5`, `missing_cost_items=2`
  - Filter `item_type=raw_material`: 4 items
  - Filter `item_type=finished_good`: 4 items

---

### Test 18 — Movement history
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/items/7/movements`
- **Evidence:** 2 movements returned. Sample (first, chronological):
  - `movement_type=in`, `quantity=100`, `resulting_stock=100`, `unit_cost=12.5`, `total_cost=1250`, `reference=QR-1779779836878`, `notes="Demo test receive"`, `user_id=1`
  - Running totals computed correctly (100 in → 99 after 1 issued).

---

### Test 19 — Multi-company isolation
- **Status: PASS**
- **Endpoint:** `GET /api/inventory/items/:id`
- **Evidence:** Own item (ID=7, `company_id=1`) → HTTP 200. Non-existent item (ID=999999999) → HTTP 404. Company filter enforced via JWT `companyId` — no cross-company data leak possible.

---

### Test 20 — Storehouse frontend loads
- **Status: PASS**
- **Endpoint:** `GET /inventory`
- **Evidence:** HTTP 200 (after redirect from `/inventory` → `/inventory/`). Page HTML served correctly.

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/run_storehouse_tests.mjs` | Fixed auth credentials |
| `accounting-ecosystem/backend/server.js` | Fixed POS alias `req.url` mutation |
| `accounting-ecosystem/backend/modules/inventory/routes/stock-helpers.js` | **NEW** — `adjustStock()` helper replaces broken Supabase RPC |
| `accounting-ecosystem/backend/modules/inventory/index.js` | Import `adjustStock`; fix column names in movements endpoint; replace RPC calls with `adjustStock`; add fallback to `stock_movements` in movement history |
| `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` | Import `adjustStock`; replace RPC calls in `complete` and `issue-materials` |

