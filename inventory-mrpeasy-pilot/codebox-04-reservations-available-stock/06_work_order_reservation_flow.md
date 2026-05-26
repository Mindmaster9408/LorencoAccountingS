# Codebox 04 — Work Order Reservation Flow

## Overview

Reservations are tightly integrated into the work order lifecycle. The integration has 3 hooks:

1. **Release** — creates reservations (commits stock)
2. **Cancel** — releases reservations (frees stock)
3. **Issue Materials** — consumes reservations (matches physical movement)

---

## Flow 1: Work Order Release

```
User clicks "Release WO"
        │
        ▼
GET work_order_materials WHERE work_order_id = wo.id
        │
        ▼
For each material line:
  ┌─────────────────────────────────────────────────────────────────┐
  │  reserve_stock() RPC (SELECT FOR UPDATE on inventory_items)     │
  │                                                                 │
  │  available = current_stock - active_reserved                   │
  │                                                                 │
  │  available >= required_qty?                                     │
  │      YES ─────→ INSERT stock_reservations (status: active)      │
  │                 record reservation_id                           │
  │                                                                 │
  │      NO ──────→ add to shortages[]                              │
  └─────────────────────────────────────────────────────────────────┘
        │
  Any shortages?
  ├── YES → releaseReservation() for all already-created reservations
  │         Return HTTP 422 { error, shortages[] }
  │         WO status UNCHANGED (stays draft)
  │
  └── NO → UPDATE work_orders SET status = 'released'
            Return { work_order, reservations_created }
```

**Key guarantee:** Either ALL materials are reserved OR none are. Partial commitment is prevented by the compensation loop.

---

## Flow 2: Work Order Cancel

```
User clicks "Cancel WO" (or cancel action from modal)
        │
        ▼
GET stock_reservations
  WHERE company_id = req.companyId
    AND source_type = 'work_order'
    AND source_id = wo.id
    AND status IN ('active', 'partially_released')
        │
        ▼
For each active reservation:
  releaseReservation(supabase, r.id, companyId, null, userId)
  → quantity_released = quantity_reserved - quantity_consumed
  → status = 'released'
  → available_stock for the item increases
        │
        ▼
UPDATE work_orders SET status = 'cancelled'
Return { work_order, reservations_released }
```

**Why release before cancel?** If cancel ran first, the WO would show cancelled but reservations would still be holding stock committed to it — making that stock invisible to other WOs. Release-then-cancel ensures stock is immediately available.

---

## Flow 3: Issue Materials (consume reservation)

```
User issues materials for WO (issue-materials endpoint)
        │
PHASE 1: Validate all issues (stock available, qty valid)
        │
PHASE 2: For each { mat, qty, itemRow }:
  ┌────────────────────────────────────────────────────────────────┐
  │  adjustStockTx() → deducts stock, creates stock_movement row  │
  │                                                                │
  │  SELECT id FROM stock_reservations                             │
  │    WHERE company_id = req.companyId                            │
  │      AND source_type = 'work_order'                            │
  │      AND source_id = wo.id                                     │
  │      AND source_line_id = mat.id                               │
  │      AND status IN ('active', 'partially_released')            │
  │    ORDER BY created_at DESC LIMIT 1                            │
  │                                                                │
  │  Found? ─→ consumeReservation(supabase, r.id, cid, qty, uid) │
  │              quantity_consumed += qty                          │
  │              status = 'consumed' if fully issued               │
  │                                                                │
  │  Not found? ─→ continue (backward compat for pre-CB04 WOs)    │
  └────────────────────────────────────────────────────────────────┘
        │
  Update work_order_materials.issued_qty
  Accumulate material cost on WO cost record
```

**Why consume matches to `source_line_id`?** A WO has multiple materials. Each material line has its own reservation. The `source_line_id = mat.id` ensures the right reservation is consumed when each material is issued — even if the same item appears in multiple lines.

---

## Status Summary After Each WO Action

| WO Action | WO Status After | Reservation Status After |
|---|---|---|
| Created | `draft` | — (no reservations) |
| Released (success) | `released` | `active` for all materials |
| Released (shortage) | `draft` (unchanged) | — (compensated = released) |
| Issue materials (partial) | `in_progress` | `partially_released` or `consumed` per line |
| Issue materials (full) | `in_progress` | `consumed` for all lines |
| Complete WO | `completed` | All reservations should be `consumed` |
| Cancel WO | `cancelled` | All previously `active` → `released` |
