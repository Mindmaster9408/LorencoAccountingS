# Phase 1 Next Steps — Lorenco Storehouse

**Date:** 2026-04-24  
**Status:** Phase 1 complete. All 7 stability issues resolved.

---

## Open Risks from Phase 1 (Must Monitor)

### OPEN-001 — `purchase_order_items.description` is NOT NULL

**Risk level:** 🟠 Medium  
**Area:** PO creation backend  
**Detail:** The `purchase_order_items` table was created in migration 007 with `description VARCHAR(255) NOT NULL`. The Phase 1 receive endpoint reads `description` but does not write it. However, when the PO _creation_ backend creates a line, it must include a `description` value or the insert will fail.

**Why not fixed in Phase 1:** PO creation was not reported as broken. Phase 1 was stability-only for receiving.

**Action required:** Audit `POST /purchase-orders` (PO creation endpoint) to confirm it passes `description` on every `purchase_order_items` insert. If it does not, add a fallback (e.g., `description = item.name`).

---

### OPEN-002 — Existing POs with status `partial` (pre-migration)

**Risk level:** 🟡 Low  
**Area:** `purchase_orders` table  
**Detail:** Migration 016 updates the status constraint from `'partial'` to `'partial_receipt'`. Any existing PO rows with `status = 'partial'` will violate the new constraint when next updated. They will not fail at read time but will fail if the backend tries to update them.

**Action required:** After applying migration 016, run:
```sql
SELECT id, status FROM purchase_orders WHERE status = 'partial';
```
If any rows exist:
```sql
UPDATE purchase_orders SET status = 'partial_receipt' WHERE status = 'partial';
```

---

### OPEN-003 — Items with Negative Stock Pre-Dating the Constraint

**Risk level:** 🟡 Low  
**Area:** `inventory_items` table  
**Detail:** The `NOT VALID` flag on the new `CHECK (current_stock >= 0)` constraint means it does not retroactively validate existing rows. Any items already at negative stock will not be caught by the constraint but will not be able to be further reduced.

**Action required:** Run the diagnostic query from the migration comments:
```sql
SELECT id, name, sku, current_stock FROM inventory_items WHERE current_stock < 0;
```
Correct any negative values manually before enabling full constraint validation:
```sql
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_current_stock_non_negative;
```

---

### OPEN-004 — PO Detail Endpoint Returns inventory_items Join

**Risk level:** 🟢 Low  
**Area:** `GET /purchase-orders/:id`  
**Detail:** The new endpoint joins `purchase_order_items` with `inventory_items` using a foreign key column named `item_id`. If any `purchase_order_items` rows have a null or invalid `item_id`, the join will silently return null item data. The frontend handles this gracefully with `l.inventory_items?.name || 'Unknown Item'`, but it's a data quality signal.

---

## Phase 2 Readiness Checklist

The following represents the assessed readiness for Phase 2 development based on Phase 1 outcomes.

### READY ✅
- Atomic stock mutations via `adjust_inventory_stock()` RPC — any Phase 2 feature that changes stock uses this function
- Negative stock is protected at both DB and API layers
- Supplier schema is clean — any feature requiring supplier lookup will work
- PO receiving flow is established — Phase 2 costing can build on `received_qty` and `unit_cost` data
- WO completion integrity is ensured — Phase 2 job costing has trustworthy finished-goods data

### NEEDS WORK BEFORE PHASE 2 🟠
- Open-001: Confirm PO creation passes `description` on line items
- Open-002: Clean up any legacy `partial` status rows
- Open-003: Validate the stock constraint after cleaning up negative rows

---

## Recommended Phase 2 Priorities (Ordered)

> Note: These are recommendations for planning purposes only. Phase 2 has not been authorized to start.

| Priority | Feature | Depends On |
|----------|---------|------------|
| 1 | PO unit cost recording on receive | Phase 1 PO receive flow complete ✅ |
| 2 | Average cost calculation on stock-in | Phase 1 atomic RPC ✅ |
| 3 | FIFO / WAC costing method per item | Priority 1 + 2 above |
| 4 | WO job costing (material + labour cost rollup) | Phase 1 WO integrity ✅ |
| 5 | Sales Orders | Stable inventory state ✅ |
| 6 | Stock valuation report | Costing engine (priorities 1-3) |
| 7 | Lot / serial number tracking | Clean stock mutation model ✅ |
| 8 | GL integration (COGS, inventory asset) | Accounting GL engine + costing engine |

---

## Session Handoff Reference

For the complete change record from this session, see:  
`SESSION_HANDOFF_2026-04-24-inventory-phase1-stability.md` (at repo root — to be created at end of session)

---

## Files Changed Summary (Phase 1 Complete)

| File | Change |
|------|--------|
| `database/migrations/016_inventory_phase1_stability.sql` | Created — all DB changes |
| `backend/modules/inventory/index.js` | Updated — atomic movements, GET PO detail, POST PO receive |
| `backend/modules/inventory/routes/work-orders.js` | Updated — materials pre-check on complete, all-or-nothing issue-materials |
| `frontend-inventory/index.html` | Updated — colour palette, statusBadge fix, PO filter, PO receive modal + JS |
