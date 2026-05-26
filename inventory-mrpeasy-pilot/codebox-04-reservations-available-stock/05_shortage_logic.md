# Codebox 04 — Shortage Logic

## What Is a Shortage?

A shortage occurs when the quantity of active reservations for an item exceeds its current on-hand stock:

```
shortage = active_reserved > current_stock
shortage_qty = active_reserved - current_stock
```

This means stock was committed that doesn't actually exist — either because:
- Stock was consumed (issued) after a reservation was created but the reservation wasn't consumed
- Stock was written off or adjusted down
- Physical stock was less than system stock at time of reservation (this shouldn't happen with the reservation gate)

---

## Shortage Detection Flow

`reservationService.getShortageReport(supabase, companyId)`:

1. Fetches all `active` and `partially_released` reservations for the company
2. Aggregates `net_reserved = SUM(qty_reserved - qty_released - qty_consumed)` per `item_id`
3. Fetches `current_stock`, `average_cost`, `name`, `sku` for each item with active reservations
4. For each item: computes `shortage_qty = net_reserved - current_stock`
5. Returns only items where `shortage_qty > 0`
6. Sorted by `shortage_qty` descending (most critical first)
7. Also returns `total_shortage_items` and `total_reserved_value`

---

## Shortage Report API

```
GET /api/inventory/reservations/reports/shortages
```

Response:
```json
{
  "success": true,
  "total_shortage_items": 2,
  "total_reserved_value": 1500.00,
  "shortages": [
    {
      "item_id": 42,
      "item_name": "Steel Rod 10mm",
      "sku": "SR-010",
      "unit": "kg",
      "current_stock": 50,
      "net_reserved": 80,
      "shortage_qty": 30,
      "reserved_value": 600.00
    }
  ]
}
```

---

## Recommended Actions for Shortage Items

| Shortage Cause | Recommended Action |
|---|---|
| Purchase order not received yet | Expedite PO; check PO awaiting receipt |
| Over-released to WOs | Review which WOs hold the reservations; consider cancelling lowest-priority WO |
| Physical stock discrepancy | Initiate a spot stock count for the item |
| Stock written off post-reservation | Adjust reservation quantities to match reality |

---

## Dashboard Indicator

The `Shortage Items` stat card on the dashboard (Codebox 04) shows the count of items where `active_reserved > current_stock`. Clicking it navigates to the Reservations tab where the user can review and act.

---

## Prevention

The WO release gate prevents new shortages from being created at release time:
- `reserve_stock()` RPC checks `available = current_stock - active_reserved` before inserting
- If `available < requested`, the RPC returns `success: false` without inserting
- The backend compensates (releases any already-created reservations for that WO) and returns HTTP 422

This ensures the system doesn't create shortages through normal WO operations. Shortages can only arise from post-reservation stock adjustments (write-offs, corrections, data migration).
