# Codebox 05 — Session Handoff

**Session:** Codebox 05 — Purchasing & Procurement  
**Date completed:** May 2026  
**Status:** FULLY COMPLETE ✅

---

## What Was Changed (per file)

### `database/migrations/055_inventory_procurement.sql` — CREATED
- New tables: `purchase_receipts`, `purchase_receipt_lines`, `supplier_item_history`
- Extended: `purchase_orders` (new status set, new columns), `purchase_order_items`, `suppliers`
- Sequence `po_number_seq` for auto-numbering
- Performance indexes

### `backend/modules/inventory/services/procurementService.js` — CREATED
- Reorder recommendations (items at/below min_stock, adjusted for open POs and reservations)
- Shortage recommendations (work order material shortfalls)
- Preferred supplier lookup
- Supplier item history updater with weighted average cost

### `backend/modules/inventory/routes/purchase-orders.js` — CREATED
- Full PO lifecycle: create, approve, mark-ordered, receive (forensic), close, cancel
- Immutable receipt writing per receive
- `adjustStockTx()` called per receipt line
- `updateSupplierItemHistory()` called after each receive
- Status transition guard (`STATUS_TRANSITIONS` map)

### `backend/modules/inventory/routes/procurement.js` — CREATED
- Procurement suggestions (merged reorder + shortage)
- Supplier history API with preferred supplier management
- Overdue POs endpoint

### `backend/modules/inventory/index.js` — MODIFIED
- Added `require` and `router.use` for both new route files
- Removed all inline PO routes (were conflicting with new sub-router)
- Updated demo-dashboard PO status filter to new status set

### `frontend-inventory/index.html` — MODIFIED
- Added `🧾 Procurement` nav tab
- Updated PO status filter to 7-status set
- Added `+ Create PO` button
- Added `tab-procurement` section with suggestions + overdue POs
- Added `createPoModal` (full form with supplier + line items)
- Added `poDetailModal` (PO summary + receipt history)
- Rewrote `loadOrders()` with full lifecycle action buttons + overdue badge
- Updated `openReceivePoModal()` to include unit_cost per line
- Updated `submitPoReceive()` to send unit_cost to backend
- Added 14 new JS functions for PO lifecycle + procurement suggestions

---

## Root Causes Fixed

1. **Old inline PO routes conflicted with new sub-router** — removed inline routes, sub-router takes over
2. **`purchase_order_id` vs `po_id` column mismatch** — migration adds `po_id` and backfills it; new code inserts both
3. **No immutable receipt audit trail** — created `purchase_receipts` + `purchase_receipt_lines` tables (INSERT-only)
4. **No supplier intelligence** — `supplier_item_history` table + service created
5. **Old status set didn't match new workflow** — migration drops old CHECK, adds new 7-status set
6. **Receive button showed for wrong statuses** — updated to `['approved','ordered','partial_receipt']`

---

## What Was NOT Changed

- `payroll-engine.js` — not touched ✅
- `PayrollCalculationService.js` — not touched ✅
- Finalization paths — not touched ✅
- PAYE/UIF/SDL logic — not touched ✅
- Auth middleware — not touched ✅
- Existing supplier inline routes (`GET /suppliers`, `POST /suppliers`, `PUT /suppliers/:id`) — kept as-is ✅
- `GET /quick-receive` (POST) — kept as-is ✅

---

## Testing Required Before Go-Live

Run all 17 PCT tests in `04_testing_checklist.md`.

Critical: run migration `055_inventory_procurement.sql` against Supabase before deploying backend.

---

## Open Follow-Ups

| Item | Priority | Notes |
|---|---|---|
| Run migration 055 in Supabase | HIGH | Must happen before first receive in production |
| Add RLS policies to new tables | MEDIUM | `purchase_receipts`, `purchase_receipt_lines`, `supplier_item_history` |
| Supplier intelligence UI | LOW | `GET /procurement/supplier-history` endpoint is ready — UI not built yet |
| `set-preferred` supplier button in UI | LOW | Backend route exists, no UI yet |
| `modal-xl` CSS class | LOW | Used in new modals — confirm it exists in existing stylesheet or add it |

---

## Deployment Checklist

- [ ] `accounting-ecosystem/zbpack.json` does NOT exist
- [ ] `accounting-ecosystem/Dockerfile` exists unchanged
- [ ] Migration 055 run against Supabase
- [ ] No `localStorage` writes for procurement/receipt business data
- [ ] Zeabur Root Directory = `accounting-ecosystem`
