# Codebox 04 — Pre-Change Safety Audit

**Date:** 2026-06  
**Scope:** All files modified for Codebox 04 reservation and available-stock system.

---

## 1. `adjustStockTx` Signature Confirmed

`accounting-ecosystem/backend/modules/inventory/services/stockMutationService.js`

```javascript
await adjustStockTx(supabase, {
  companyId, itemId, delta, movementType,
  warehouseId, reference, notes, unitCost, createdBy, sourceType, sourceId
});
```

- Uses **named object parameters** (refactored in Codebox 02 — not positional)
- Calls `adjust_inventory_stock()` PostgreSQL RPC
- All new code in Codebox 04 uses the correct named-param pattern ✅

---

## 2. Work Order Routes — Existing Behaviour Audited

`accounting-ecosystem/backend/modules/inventory/routes/work-orders.js`

### `/release` (before Codebox 04)
- Called `transitionStatus(req, res, 'released')` — simple status transition
- No material commitment / reservation logic
- **Gap:** Stock could be promised to a WO without any system-level lock

### `/cancel` (before Codebox 04)
- Called `transitionStatus(req, res, 'cancelled')` — simple status transition
- No cleanup of any associated reservations (none existed)

### `/issue-materials` PHASE 2 (before Codebox 04)
- Validates stock availability (`current_stock >= qty`) in PHASE 1
- Calls `adjustStockTx` (correct named params) to deduct stock
- Updates `issued_qty` and `issue_unit_cost` on `work_order_materials`
- Calls `accumulateWorkOrderMaterialCost`
- **No reservation consume logic** (none existed — added in Codebox 04)

---

## 3. Items Endpoint — Low Stock Logic

`GET /items` in `index.js` (before Codebox 04):
- Low stock filter: `current_stock <= min_stock` — used raw on-hand quantity
- **Gap:** Items with heavy reservations could look in-stock but actually be fully committed
- **Fix in Codebox 04:** Low stock filter and display now use `available_stock = current_stock - active_reserved`

---

## 4. Dashboard — Low Stock Count

`GET /demo-dashboard` (before Codebox 04):
- Used Supabase `.filter('current_stock', 'lte', 'min_stock')` — DB-side filter
- **Gap:** Same as above — ignored reservations
- **Fix in Codebox 04:** Post-processes all items against reservation map; uses `available_stock` for threshold comparison

---

## 5. Frontend — localStorage Compliance

`frontend-inventory/index.html`:
- `localStorage.getItem('token')` — line 949 — **auth token only** ✅
- No business data in localStorage ✅
- No reservation data will be added to localStorage ✅

---

## 6. company_id Data Type

`company_id` is `INTEGER` across all inventory tables (consistent with migrations 050–052).  
Migration 053 uses `INTEGER` for `company_id` — **consistent** ✅

---

## 7. No RBAC in Inventory Routes

No inventory routes use permission checks — consistent with all other inventory modules. Reservation routes follow the same pattern (auth + company context only, no RBAC layer).

---

## 8. Concurrency Risk Assessment

The critical concurrency risk for reservations is:
> Two simultaneous WO releases could both see the same available stock and both succeed, over-committing it.

**Mitigation:** `reserve_stock()` PostgreSQL RPC uses `SELECT FOR UPDATE` on the `inventory_items` row. PostgreSQL serialises concurrent calls for the same item. No application-level locking required.
