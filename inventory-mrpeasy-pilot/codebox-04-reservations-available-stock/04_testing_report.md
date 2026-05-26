# Codebox 04 — Test Scenarios

## Pre-Requisites
- Migration 053 applied
- At least 2 inventory items with stock > 0
- At least 1 BOM and 1 work order in `draft` status

---

## TEST-RES-01: WO Release Creates Reservations
1. Open a WO in `draft` status with materials that have sufficient available stock
2. Click Release
3. **Expected:** WO transitions to `released`; response includes `reservations_created > 0`
4. **Verify:** `GET /api/inventory/reservations/source/work_order/:woId` returns reservations with status `active`
5. **Verify items table:** `reserved_qty` increases for each material; `available_stock` decreases accordingly

---

## TEST-RES-02: WO Release Blocked on Shortage
1. Manually reduce a material item's stock to 0 (or below the WO requirement)
2. Attempt to release the WO
3. **Expected:** HTTP 422 response with `{ error, shortages: [{ item_name, required_qty, available }] }`
4. **Frontend:** Toast shows shortage detail — item name, required vs available
5. **Verify:** No reservations are left in `active` status for this WO (compensation ran)

---

## TEST-RES-03: Available Stock Excludes Reserved Qty
1. Item A has `current_stock = 100`
2. WO is released requiring 60 units of Item A
3. **Expected:** `GET /api/inventory/availability/:itemId` returns `available_stock = 40`
4. **Expected:** Items table shows On Hand = 100, Reserved = 60, Available = 40
5. Attempt to release a second WO requiring 50 units of Item A
6. **Expected:** Blocked — only 40 available

---

## TEST-RES-04: WO Cancel Releases Reservations
1. Release a WO (creates reservations)
2. Cancel the WO
3. **Expected:** All `active` reservations for that WO are now `released`
4. **Expected:** `available_stock` for materials returns to pre-release values
5. **Verify:** Response includes `reservations_released` count

---

## TEST-RES-05: Issue Materials Consumes Reservation
1. Release a WO (creates reservations)
2. Issue materials for that WO
3. **Expected:** Stock deducted via `adjustStockTx` (stock movement created)
4. **Expected:** Matching reservation transitions to `consumed` (or `partially_released` if partial issue)
5. **Verify:** Net active qty for that reservation = 0 after full issue

---

## TEST-RES-06: Backward Compatibility — Pre-Codebox04 WO
1. Create a WO in `released` status manually (or use one existing from before migration 053)
2. Issue materials for that WO
3. **Expected:** Materials issued normally — `adjustStockTx` succeeds
4. **Expected:** No error thrown because reservation was not found (graceful skip)

---

## TEST-RES-07: Manual Hold Creates Reservation
1. Go to Reservations tab → Manual Hold
2. Select an item, enter a quantity, add reference
3. Submit
4. **Expected:** Reservation created with `source_type = 'manual_hold'`
5. **Expected:** Item's `available_stock` decreases in items table and dashboard

---

## TEST-RES-08: Manual Hold Release
1. Create a manual hold
2. In Reservations table, click Release
3. Confirm
4. **Expected:** Reservation status → `released`; available_stock returns to pre-hold value

---

## TEST-RES-09: Dashboard Shows Reservation Stats
1. Load dashboard
2. **Expected:** `Active Reservations` card shows correct count of active/partially_released reservations
3. **Expected:** `Reserved Stock Value` shows approximate monetary value
4. **Expected:** `Shortage Items` shows count of items where `reserved > current_stock`

---

## TEST-RES-10: Low Stock Uses Available Stock
1. Item with `current_stock = 5`, `min_stock = 3`
2. Create a reservation for 4 units (available = 1, below min of 3)
3. **Expected:** Low available stock badge visible on item in items table
4. **Expected:** Low stock count on dashboard reflects available-based threshold

---

## TEST-RES-11: Shortage Report
1. Ensure at least one item has `reserved > current_stock`
2. `GET /api/inventory/reservations/reports/shortages`
3. **Expected:** Returns `shortages[]` array sorted by shortage severity (most critical first)
4. Each shortage includes `shortage_qty`, `item_name`, `current_stock`, `total_reserved`

---

## TEST-RES-12: Partial Release
1. Create a reservation for 10 units
2. `POST /api/inventory/reservations/:id/release` with body `{ quantity: 4 }`
3. **Expected:** `quantity_released = 4`, status = `partially_released`
4. **Expected:** Net active qty = 6 (10 - 4)
5. Release remaining 6
6. **Expected:** `quantity_released = 10`, status = `released`

---

## TEST-RES-13: Partial Consume
1. Release a WO with a material line requiring 10 units
2. Issue 4 units
3. **Expected:** Reservation `quantity_consumed = 4`, status = `partially_released`
4. Issue remaining 6 units
5. **Expected:** `quantity_consumed = 10`, status = `consumed`

---

## TEST-RES-14: Multi-tenant Isolation
1. Company A creates reservations for Item X
2. `GET /api/inventory/reservations` (as Company B)
3. **Expected:** Company B sees no Company A reservations
4. **Expected:** `available_stock` for any shared item IDs is calculated only from Company B's own reservations

---

## TEST-RES-15: Reservations Tab Filter — Status
1. Open Reservations tab
2. Select Status = "Active"
3. **Expected:** Only `active` and `partially_released` reservations visible

Wait — the filter is an exact match on `active`. Check that `partially_released` is a separate option and filtering works per selection.

---

## TEST-RES-16: Reservations Tab Filter — Source Type
1. Filter by Source = "Work Orders"
2. **Expected:** Only `source_type = 'work_order'` reservations shown

---

## TEST-RES-17: No Browser Storage Used
1. Create a reservation
2. Inspect browser localStorage and sessionStorage
3. **Expected:** No reservation data present in any browser storage
4. **Expected:** Only auth token (`token`) present in localStorage ✅
