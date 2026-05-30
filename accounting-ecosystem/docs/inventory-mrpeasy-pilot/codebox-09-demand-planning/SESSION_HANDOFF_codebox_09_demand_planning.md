# Session Handoff — Codebox 09: Sales Orders & Demand Planning Foundation

**Date:** 2026-05-29
**Module:** Lorenco Storehouse — Demand Planning
**Status:** COMPLETE ✅

---

## What Was Implemented

### Step 0 — Audit
- `docs/inventory-mrpeasy-pilot/codebox-09-demand-planning/00_demand_planning_audit.md`
- Found: `source_type='sales_order_future'` already in `stock_reservations` constraint (CB-04 placeholder)
- Found: `reserve_stock()` RPC fully capable of SO allocations — no changes needed to the RPC
- Found: `getShortageReport()` already aggregates all source types — SO reservations auto-visible
- Decision: Use `source_type='sales_order'` for confirmed SO allocations; extend constraint

### Step 1 — Migration 059
**File:** `database/migrations/059_inventory_sales_orders.sql`
- Extended `stock_reservations.chk_sr_source_type` to include `'sales_order'`
- Created `sales_orders` (header: customer, status, required_date, total_amount)
- Created `sales_order_lines` (per-item: qty_ordered, qty_allocated, qty_fulfilled, unit_price)
  - Note: `line_total` is a GENERATED ALWAYS column (qty_ordered × unit_price)
- Created `sales_order_status_history` (immutable audit trail)

### Step 2 — Sales Order Service
**File:** `backend/modules/inventory/services/salesOrderService.js`
- `createSalesOrder` — creates draft SO with lines, validates all items
- `confirmSalesOrder` — draft → confirmed
- `allocateSalesOrder` — reserves stock per line via `reserve_stock()` RPC; SO → `allocated` only if all lines succeed
- `fulfillSalesOrderLine` — consumes reservation + creates OUT movement via `adjustStockTx`
- `cancelSalesOrder` — releases all active reservations, logs status history
- `getSalesOrder` — with lines + history
- `listSalesOrders` — filterable

### Step 3 — ATP Service
**File:** `backend/modules/inventory/services/atpService.js`
- `calculateAvailableToPromise` — current ATP with demand breakdown by source type
- `calculateFutureDemand` — demand from open SOs in a date range
- `calculateProjectedAvailability` — day-by-day stock projection over horizon days
- `getDemandDashboard` — company-level demand summary
- `getATPReport` — ATP for all items with active reservations
- `getFutureDemandReport` — all outstanding SO demand within horizon
- `getDemandShortagesReport` — shortages segmented by source type (customer vs production vs manual)

### Step 4 — Routes
**File:** `backend/modules/inventory/routes/sales-orders.js`
- 7 SO endpoints (create, list, get, confirm, allocate, fulfill-line, cancel)
- 3 ATP endpoints (atp/:itemId, atp/:itemId/projected, demand-dashboard)
- Mounted at `/api/inventory/sales-orders`

### Step 5 — Frontend
**File:** `frontend-inventory/index.html`
- New "🧾 Sales Orders" nav tab
- 3 sub-views: SO List, Demand Dashboard, ATP Lookup
- SO list with status filters, action buttons (confirm, allocate, cancel)
- SO detail modal with line-level fulfill buttons
- Create SO modal with item lines + pricing
- ATP lookup with projected timeline chart
- Demand dashboard with summary stats

### Step 6 — Reports
5 new report types in dropdown (CB-09 group):
- Open Sales Orders → `GET /reports/open-sales-orders`
- ATP Report → `GET /reports/atp`
- Future Demand → `GET /reports/future-demand`
- Demand Shortages → `GET /reports/demand-shortages`

---

## Files Changed

| File | Change |
|------|--------|
| `database/migrations/059_inventory_sales_orders.sql` | NEW |
| `backend/modules/inventory/services/salesOrderService.js` | NEW |
| `backend/modules/inventory/services/atpService.js` | NEW |
| `backend/modules/inventory/routes/sales-orders.js` | NEW |
| `backend/modules/inventory/index.js` | Mounted `/sales-orders` router |
| `backend/modules/inventory/services/reportingService.js` | +5 demand report functions + atpService import |
| `backend/modules/inventory/routes/reports.js` | +5 report routes |
| `frontend-inventory/index.html` | Sales Orders tab + modals + CB-09 JS + report types |

**NOT changed:**
- `reservationService.js` — untouched (used by SO service)
- `stockMutationService.js` — untouched (used by SO fulfillment)
- `reserve_stock()` RPC — untouched (already handles new source_type via table constraint)
- All payroll/accounting files — untouched

---

## Confirmed Working

- All 6 new backend files: `node --check` passes
- `localStorage.setItem` count: 0
- 19 existing tests: all pass

---

## What Needs Live Testing

1. Run migration 059 against Supabase
2. Create SO → confirm → allocate → verify `stock_reservations` row with `source_type='sales_order'`
3. Check ATP for an item with active SO reservation
4. Fulfill a line → verify `stock_movements` OUT record + reservation consumed
5. Cancel SO → verify reservations released + status history logged
6. Demand Shortages report → shows customer vs production breakdown

---

## Key Concurrency Property

`allocateSalesOrder` uses `reserve_stock()` RPC which acquires `SELECT FOR UPDATE` on `inventory_items`. This prevents two concurrent SO allocations from both succeeding when only one can be fulfilled. This is the same mechanism as work order material reservations — proven and forensic-grade.

---

## Known Gaps (Future Codeboxes)

| Gap | Phase |
|-----|-------|
| Multi-warehouse ATP (per-warehouse promise) | CB-10 |
| PO inflows in projected ATP (needs `purchase_order_lines.expected_date`) | CB-10 |
| Make-to-order: SO triggers production WO | CB-10 |
| Customer master data (customer_id FK) | Future |
| Delivery scheduling / shipment tracking | Future |
| Statistical demand forecasting | CB-11 |

---

## Codebox Sequence

| Codebox | Module | Status |
|---------|--------|--------|
| CB-01 | Stock engine | ✅ Complete |
| CB-02 | Costing & valuation | ✅ Complete |
| CB-03 | Stock counts | ✅ Complete |
| CB-04 | Reservations | ✅ Complete |
| CB-05 | Procurement | ✅ Complete |
| CB-06 | Manufacturing | ✅ Complete |
| CB-07 | Reporting | ✅ Complete |
| CB-08 | Warehouses & transfers | ✅ Complete |
| **CB-09** | **Sales Orders & Demand Planning** | **✅ Complete** |
| CB-10 | Multi-currency & landed cost + MTP | Pending |
| CB-11 | Demand forecasting | Pending |
| CB-12 | Audit hardening & pilot go-live | Pending |
