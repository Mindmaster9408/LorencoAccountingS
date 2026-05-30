# Session Handoff — Codebox 08: Warehouse Structure & Location Control

**Date:** 2026-05-29
**Module:** Lorenco Storehouse — Warehouse Infrastructure
**Status:** COMPLETE ✅

---

## What Was Implemented

### Step 0 — Audit
- `docs/inventory-mrpeasy-pilot/codebox-08-warehouses/00_warehouse_safety_audit.md`
- Found pre-existing bug: `address`/`notes` fields in warehouse routes never existed in DB
- Confirmed: `warehouse_id` already on `stock_movements`, `stock_reservations`, `stock_count_sessions`
- Confirmed: no new migrations for CB-08 required in payroll or accounting

### Step 1 — Migration 058
**File:** `database/migrations/058_inventory_warehouses.sql`
- Extended `warehouses`: `warehouse_code`, `warehouse_type`, `is_default`, address fields, contact fields, `notes` (also fixes address/notes pre-existing bug)
- Created `warehouse_locations` (bins/shelves within a warehouse)
- Created `inventory_stock_locations` (per item × warehouse × location summary)
- Extended `stock_movements` with `location_id`, `to_location_id`
- Extended `stock_reservations` with `location_id`
- Created `warehouse_transfers` + `warehouse_transfer_lines`

### Step 2 — Location-aware Stock Engine
- `inventory_stock_locations` maintained by `warehouseTransferService.upsertStockLocation()`
- Existing `adjustStockTx` RPC unchanged — backward compatible
- Location tracking is supplementary; `inventory_items.current_stock` remains source of truth

### Step 3 — Warehouse Availability
- `warehouseTransferService.getWarehouseStock()` — stock per warehouse/location
- `warehouseTransferService.getWarehouseAvailability()` — grouped by warehouse with value + low-stock flags

### Step 4 — Transfer Engine
**File:** `backend/modules/inventory/services/warehouseTransferService.js`
- `createTransfer` — create draft with lines, validates both warehouses + all items belong to company
- `approveTransfer` — draft → approved
- `shipTransfer` — approved/draft → in_transit; calls `adjustStockTx OUT` for each line
- `receiveTransfer` — in_transit → received; calls `adjustStockTx IN` for each line
- `cancelTransfer` — can cancel draft or approved only (not in_transit)
- `listTransfers`, `getTransferById` — read operations

### Step 5 — Frontend UI
**File:** `frontend-inventory/index.html`
- Warehouses tab: sub-views (Warehouse List / Location Bins / Availability)
- Extended warehouse modal: code, type, address, contact, default flag
- New Location modal: code, name, type, capacity
- New Transfers tab: list, create, view, approve, ship, receive, cancel
- New transfer detail modal with line-level quantities

### Step 6 — Reports
Three new report endpoints and frontend panels:
- `GET /reports/warehouse-stock` → "Warehouse Stock" in report dropdown
- `GET /reports/transfer-history` → "Transfer History" in report dropdown
- `GET /reports/warehouse-shortages` → "Warehouse Shortages" in report dropdown

### Step 7 — Backend Routes
- `backend/modules/inventory/routes/warehouse-transfers.js` — CRUD + workflow
- `backend/modules/inventory/routes/warehouse-locations.js` — location CRUD + warehouse stock
- `backend/modules/inventory/index.js` — mounted `/transfers` router, warehouse location router

---

## Files Changed

| File | Change |
|------|--------|
| `database/migrations/058_inventory_warehouses.sql` | NEW |
| `backend/modules/inventory/services/warehouseTransferService.js` | NEW |
| `backend/modules/inventory/routes/warehouse-transfers.js` | NEW |
| `backend/modules/inventory/routes/warehouse-locations.js` | NEW |
| `backend/modules/inventory/index.js` | Extended warehouse CRUD, mounted new routers |
| `backend/modules/inventory/services/reportingService.js` | +3 warehouse report functions |
| `backend/modules/inventory/routes/reports.js` | +3 warehouse report routes |
| `frontend-inventory/index.html` | Warehouses/Locations/Transfers/Reports UI |

**NOT changed:**
- `stockMutationService.js` (forensic RPC) — untouched
- All payroll files — untouched
- All accounting files — untouched
- Existing report functions — untouched
- All existing inventory routes — untouched

---

## Confirmed Working

- `node --check` passes on all 6 modified/new backend files
- `localStorage.setItem` count: 0
- 19 existing tests: all pass (dashboard-action-queue + hardening)
- All warehouse routes company-scoped
- No stock teleportation: transfer ship creates OUT movement, receive creates IN movement

---

## What Needs Live Testing

1. Run migration 058 against Supabase (Zeabur will need a DB migration run)
2. Create a warehouse → verify warehouse_code unique constraint
3. Create locations within warehouse → verify location_code unique per warehouse
4. Create a transfer → verify transfer_number generated correctly
5. Ship transfer → verify stock_movements OUT record created, inventory_items.current_stock reduced
6. Receive transfer → verify IN record, stock increased at destination
7. Cancel mid-flow → verify in_transit cannot be cancelled
8. Warehouse Availability view → will be empty until transfers run

---

## Known Gap: `inventory_stock_locations` Population

`inventory_stock_locations` is only populated by the transfer engine (`upsertStockLocation`). Existing stock already in warehouses before CB-08 will not appear in the location ledger until a transfer or new movement is processed. This is a known design trade-off — populating it retroactively requires reading all historical movements per warehouse, which is a CB-09+ task.

The Warehouse Availability tab will show "No stock data" for warehouses that haven't had CB-08 transfers yet. The operational workaround: Storehouse's Operational Dashboard and stock valuation still show company-total figures correctly.

---

## Codebox Sequence Reference

| Codebox | Module | Status |
|---------|--------|--------|
| CB-01 | Core items, movements, warehouses, suppliers | ✅ Complete |
| CB-02 | Costing: FIFO/avg, stock valuation | ✅ Complete |
| CB-03 | Stock counts, variance | ✅ Complete |
| CB-04 | Reservations, shortage/overcommit | ✅ Complete |
| CB-05 | Purchase orders, procurement | ✅ Complete |
| CB-06 | Manufacturing execution | ✅ Complete |
| CB-07 | Reporting & dashboards | ✅ Complete |
| **CB-08** | **Warehouse structure & location control** | **✅ Complete** |
| CB-09 | Lot/serial tracking | Pending |
| CB-10 | Multi-currency & landed cost | Pending |
| CB-11 | Demand planning | Pending |
| CB-12 | Audit hardening & pilot go-live | Pending |
