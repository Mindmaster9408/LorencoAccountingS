# Codebox 04 — Reservation Architecture

## Core Principle

**A reservation is a commitment, NOT a stock movement.**

| Concept | Stored Where | Updated By |
|---|---|---|
| On Hand (`current_stock`) | `inventory_items.current_stock` | `adjustStockTx()` only |
| Active Reserved | Computed from `stock_reservations` | `reserve_stock()` RPC or service functions |
| Available Stock | **Never stored** — computed at query time | `available = current_stock - active_reserved` |

`available_stock` is always dynamic. It is never written to `inventory_items`. This ensures it is always accurate without risk of stale cached values.

---

## Stock Quantity Model

```
On Hand (current_stock)
  ├─ Active Reserved  ← committed to WOs, orders, manual holds (not yet moved)
  └─ Available Stock  ← can still be reserved or sold
```

`available_stock = max(0, current_stock - active_reserved)`

`active_reserved = SUM(quantity_reserved - quantity_released - quantity_consumed)`
  where `reservation_status IN ('active', 'partially_released')`

---

## Reservation Lifecycle

```
                        reserve_stock() RPC
                              │
                         [active] ────────────────────────────────┐
                              │                                    │
               ┌──────────────┴──────────────┐                    │
               ▼                             ▼                    │
    Issue materials (consume)       Cancel / excess release        │
    consumeReservation()            releaseReservation()           │
               │                             │                    │
      [consumed]                   [released]                     │
                                                        partially issued
                                                       [partially_released]
```

### Status Meanings

| Status | Meaning | Net Active Qty |
|---|---|---|
| `active` | Fully uncommitted, all quantity still held | `quantity_reserved` |
| `partially_released` | Some released (WO qty reduced), some still held | `reserved - released - consumed` |
| `released` | Fully released — no stock movement occurred | 0 |
| `consumed` | Stock physically moved (issued to WO) | 0 |
| `cancelled` | Abandoned without issue | 0 |

---

## Concurrency Design

**Problem:** Two WO releases might simultaneously see the same available stock and both succeed, over-committing the same units.

**Solution:** `reserve_stock()` PostgreSQL RPC acquires `SELECT FOR UPDATE` on the `inventory_items` row for the target item. PostgreSQL serializes concurrent calls at the row level. The second caller blocks until the first commits, then sees the updated active_reserved total.

No application-level locking is needed. The database enforces isolation.

---

## Source Types

| `source_type` | Created When | Released/Consumed When |
|---|---|---|
| `work_order` | WO status → `released` | Consumed on issue-materials; released on WO cancel |
| `manual_hold` | User creates via Reservations UI | User manually releases |
| `sales_order_future` | Reserved for future deliveries | On order fulfillment / cancellation |
| `production_plan` | MRP-planned productions | On production release |
| `stock_count_hold` | During active stock count | On count completion/abandon |
| `other` | Catch-all | Manual release |

---

## Valuation Note

**Reserved stock is still valued the same as unreserved stock.**  
Reservations do not affect `inventory_items.average_cost`, `current_stock`, or any costing inputs.  
The reserved quantity is subtracted from the **available** quantity only — the physical and valuation reality is unchanged until `adjustStockTx()` is called at issue time.
