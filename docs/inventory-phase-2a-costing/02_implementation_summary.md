# Phase 2A — Implementation Summary
**Status:** Implemented  
**Date:** 2026-05-22  
**Phase:** 2A — Forensic-Grade Costing, Valuation & Inventory Intelligence Foundation

---

## What Was Built

### 1. Database Foundation (`041_inventory_costing_foundation.sql`)

**New columns on `inventory_items`:**
| Column | Purpose |
|--------|---------|
| `average_cost` | Running weighted average cost — auto-maintained by RPC on every receive |
| `last_purchase_cost` | Most recent PO receive cost — updated on `po_receive` events |
| `standard_cost` | Fixed budgeted cost — manual entry for standard costing method |
| `cost_updated_at` | Timestamp of last cost update |
| `cost_source` | What triggered the last cost update |

**New tables:**
| Table | Purpose |
|-------|---------|
| `stock_valuation_movements` | Immutable forensic cost ledger — one row per stock event |
| `inventory_cost_layers` | FIFO layers — received batches with remaining qty for FIFO depletion |
| `work_order_costs` | Per-WO material cost accumulation, finalised at WO completion |
| `item_cost_history` | Audit trail of every `average_cost` change per item |

**Extended `adjust_inventory_stock()` RPC:**
- Two new optional parameters: `p_source_type`, `p_source_id` (backward compatible)
- Computes weighted average on every `in` movement with known cost
- Writes to `stock_valuation_movements` (immutable) on every call
- Creates FIFO cost layer for `in` movements with known cost
- Appends to `item_cost_history` when `average_cost` changes
- Returns `new_avg_cost` in response JSONB
- Uses `SELECT FOR UPDATE` to prevent concurrent weighted-average races

### 2. Costing Service (`backend/modules/inventory/services/costingService.js`)

Centralised costing logic — the only place costing calculations live.

| Function | Purpose |
|----------|---------|
| `computeWeightedAverage()` | Pure formula: `((oldQty × oldAvg) + (inQty × inCost)) / (oldQty + inQty)` |
| `computeWorkOrderUnitCost()` | Pure: total cost / completed qty |
| `getItemAverageCost()` | Read current average_cost for an item |
| `getItemCostingState()` | Read current_stock + average_cost for weighted average calc |
| `accumulateWorkOrderMaterialCost()` | Upsert material cost delta onto work_order_costs |
| `finalizeWorkOrderCost()` | Compute unit_cost = total / qty, set status = 'finalized' |
| `getStockValuation()` | Return all items with qty × average_cost valuation |

### 3. PO Receive Cost Capture (`backend/modules/inventory/index.js`)

**Before:** `p_cost_price: null` — PO unit price was ignored.  
**After:** `p_cost_price: parseFloat(poItem.unit_price)` — weighted average updates on every receipt.

`unit_price` added to the PO items select. `p_source_type: 'po_receive'` and `p_source_id` passed for audit traceability.

### 4. Manual Movement Costing (`backend/modules/inventory/index.js`)

`p_source_type: 'manual'` added to manual in/out movements. `cost_price` from request body was already being forwarded — now properly tagged in the valuation ledger.

### 5. Work Order Material Issue Costing (`backend/modules/inventory/routes/work-orders.js`)

**Before:** `p_cost_price: null` — materials issued at zero cost.  
**After:** Uses `average_cost || cost_price` from the item row at time of issue.

`accumulateWorkOrderMaterialCost()` called after each successful issue to build the running WO cost record.

### 6. Work Order Completion Costing (`backend/modules/inventory/routes/work-orders.js`)

**Before:** `p_cost_price: null` — finished goods entered stock at zero cost.  
**After:** `finalizeWorkOrderCost()` called first to compute `unit_cost = totalMaterial / qtyProduced`, then passed to the RPC so finished goods enter stock with a proper cost basis.

### 7. Reporting Endpoints (`backend/modules/inventory/routes/reports.js`)

| Endpoint | Description |
|----------|-------------|
| `GET /api/inventory/reports/stock-valuation` | Current stock value per item (qty × average_cost) |
| `GET /api/inventory/reports/cost-history/:itemId` | Cost change history for one item (from `item_cost_history`) |
| `GET /api/inventory/reports/valuation-movements` | Forensic cost ledger for date range (from `stock_valuation_movements`) |
| `GET /api/inventory/reports/work-order-cost-summary` | WO cost breakdown (from `work_order_costs`) |

All endpoints company-scoped via `req.companyId`.

### 8. Frontend (`frontend-inventory/index.html`)

**Items table updated:**
- Column renamed "Cost" → "Avg Cost" (shows weighted average with fallback to cost_price)
- New "Value" column added: `avgCost × current_stock` per row

**New 📊 Reports tab:**
- Three report types: Stock Valuation, Valuation Movements, Work Order Costs
- Date range filter (shown/hidden by report type)
- Summary banner with key totals
- Table output rendered in-page
- No business data written to browser storage

---

## Weighted Average Formula

```
newAvg = ((currentQty × currentAvg) + (incomingQty × incomingCost)) / (currentQty + incomingQty)
if currentQty ≤ 0: newAvg = incomingCost
```

Computed in SQL inside the extended RPC using `SELECT FOR UPDATE` row locking.  
Also available as a pure JavaScript function in `costingService.computeWeightedAverage()`.

---

## Data Integrity Guarantees

1. **RPC atomicity**: `adjust_inventory_stock()` updates `current_stock`, `average_cost`, and inserts all costing records in one database transaction. Partial failure rolls back everything.
2. **Immutable ledger**: `stock_valuation_movements` is append-only. No update/delete path exists.
3. **Backward compatibility**: New RPC parameters have defaults — all existing callers work unchanged.
4. **Multi-tenant isolation**: All tables and queries are `company_id` scoped.
5. **No browser storage**: All costing data stored in SQL tables, never in localStorage/sessionStorage.

---

## Files Modified / Created

| File | Change |
|------|--------|
| `database/migrations/041_inventory_costing_foundation.sql` | NEW — schema + extended RPC |
| `backend/modules/inventory/services/costingService.js` | NEW — centralised costing logic |
| `backend/modules/inventory/routes/reports.js` | NEW — 4 reporting endpoints |
| `backend/modules/inventory/index.js` | Modified — PO receive cost capture, movement source_type, reports router mount |
| `backend/modules/inventory/routes/work-orders.js` | Modified — issue-materials and complete costing |
| `frontend-inventory/index.html` | Modified — average_cost column, Value column, Reports tab |
