# CB-09 — Demand Planning Audit

**Date:** 2026-05-29
**Module:** Lorenco Storehouse — Sales Orders & Demand Planning

---

## 1. Existing Demand Infrastructure (Pre CB-09)

### What already exists
| Feature | Status | Notes |
|---------|--------|-------|
| `stock_reservations` table | ✅ | Full reservation engine with RPC row-locking |
| `source_type = 'sales_order_future'` | ✅ | Already allowed in CHECK constraint |
| `reserve_stock()` RPC | ✅ | Atomic, FOR UPDATE locked — safe for concurrent SO allocation |
| `getAvailableStock()` | ✅ | Returns current_stock − active_reserved |
| `getShortageReport()` | ✅ | Aggregates across ALL source_types |
| `createReservation()` | ✅ | Delegates to reserve_stock() RPC |
| `releaseReservation()` | ✅ | Full and partial release supported |
| `consumeReservation()` | ✅ | Full and partial consume supported |
| `procurement suggestions` | ✅ | Reorder and shortage triggers |

### What does NOT exist (CB-09 will build)
| Feature | Status |
|---------|--------|
| `sales_orders` table | ❌ |
| `sales_order_lines` table | ❌ |
| `sales_order_status_history` table | ❌ |
| `source_type = 'sales_order'` | ❌ (only `sales_order_future` exists) |
| ATP calculation service | ❌ |
| Sales order allocation flow | ❌ |
| Demand-driven shortage segmentation | ❌ |
| Future demand projection | ❌ |

---

## 2. Reservation Engine Assessment

The existing `reserve_stock()` RPC is the correct path for SO allocations:
- Acquires SELECT FOR UPDATE on inventory_items — prevents concurrent over-reservation
- Validates available stock atomically — no race condition possible
- Returns structured JSONB result for success/failure handling

**CB-09 will use `createReservation()` with `source_type='sales_order'`** for SO line allocations.

The `chk_sr_source_type` constraint will be updated to include `'sales_order'`.

---

## 3. Shortage Report Impact

The existing `getShortageReport()` aggregates ALL source types. When sales order reservations are added:
- They automatically appear in the shortage report
- Items over-committed to customers will surface as shortages
- No changes needed to `getShortageReport()` for basic functionality

CB-09 adds a **demand-segmented** view that breaks shortages by source type (production vs. customer demand vs. manual holds).

---

## 4. Company Isolation Audit

All existing reservation infrastructure is company-scoped (`company_id = $1`). CB-09 tables follow the same pattern. The `source_id` for SO reservations is `sales_orders.id` which itself is scoped to `company_id`.

---

## 5. Frontend Storage Audit

No sales order state will be stored in browser storage. All SO data goes to the DB via API.

---

## 6. Key Design Decisions

### ATP Algorithm
```
Simple ATP (immediate):
  ATP = current_stock - SUM(active reservations)
  (This is the existing getAvailableStock() result)

Future ATP (at a target date):
  Future ATP = current_stock
             - active reservations (not yet consumed)
             + expected PO inflows (open POs with expected_date <= target_date)
             - confirmed SO demand (SO lines with required_date <= target_date, not yet fulfilled)
```

### Sales Order Status Flow
```
draft → confirmed → allocated → partially_fulfilled → fulfilled
      ↘ cancelled (from any state before fulfilled)
```

### Allocation rule
- One reservation per SO line (per item)
- `source_type = 'sales_order'`, `source_id = so.id`, `source_line_id = line.id`
- If partial allocation: lines that succeed are reserved, SO moves to `confirmed` (not `allocated`)
- `allocated` status only when ALL lines have full qty_allocated = qty_ordered

### Fulfillment rule
- `consumeReservation()` is called when a line is marked fulfilled
- `adjustStockTx(OUT)` is called when physical stock is dispatched
- Both happen together — fulfillment is a two-step: consume reservation → adjust stock

---

## 7. Gaps Not Addressed in CB-09 (Future Work)

| Gap | Phase |
|-----|-------|
| Delivery scheduling / shipment tracking | CB-10 or future |
| Customer master data (customer_id FK) | Future |
| Pricing / quotations | Future |
| Sales order to production trigger (make-to-order) | CB-10 |
| ATP for multi-warehouse per-location | CB-10 |
| Demand forecasting (statistical) | CB-11 |
