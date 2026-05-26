# SESSION HANDOFF — Codebox 04: Reservations & Available Stock

**Date:** 2026-06  
**Codebox:** 04 of 12 — Reservations & Available Stock  
**Status:** COMPLETE

---

## What Was Changed

### New Files Created

| File | Purpose |
|---|---|
| `database/migrations/053_inventory_reservations.sql` | `stock_reservations` table + `reserve_stock()` RPC |
| `backend/modules/inventory/services/reservationService.js` | 6 reservation service functions |
| `backend/modules/inventory/routes/reservations.js` | 7 REST endpoints for reservation management |

### Files Modified

| File | Changes |
|---|---|
| `backend/modules/inventory/routes/work-orders.js` | Added reservationService import; replaced `/release` with reservation-creating version; replaced `/cancel` with reservation-releasing version; added `consumeReservation` call in issue-materials PHASE 2 |
| `backend/modules/inventory/index.js` | Mounted `/reservations` router; enriched GET /items with `reserved_qty` + `available_stock`; updated GET /demo-dashboard to compute available-based low stock and return reservation stats |
| `frontend-inventory/index.html` | CSS, nav tab, items table (3 stock columns), dashboard stat cards, releaseWo 422 handling, Reservations tab section + filters, Manual Hold modal, all JS functions |

---

## Root Causes Fixed

- **No reservation system existed** — stock could be double-committed across WOs with no system-level protection
- **Low stock threshold ignored reservations** — an item with `current_stock = 5` and `reserved = 4` would show as healthy; now correctly shows available = 1
- **No concurrency protection for stock commitment** — the `reserve_stock()` RPC with `SELECT FOR UPDATE` closes this gap

---

## What Was Confirmed Working (Not Broken)

- `adjustStockTx()` call signature unchanged — named param object pattern preserved in all existing call sites
- All existing work order operations (`/start`, `/complete`, `/reopen`, `GET`, `POST`) unchanged
- `stock_movements` table unaffected by reservations — confirmed no new rows are written on reserve/release
- Existing low-stock badge logic preserved (migrated to available_stock basis, not removed)
- Auth token localStorage usage unchanged — still the only permitted localStorage use

---

## What Was NOT Changed

- `adjustStockTx()` and `stockMutationService.js` — untouched
- BOM routes — untouched
- `work_order_materials` schema — untouched (no new columns)
- Purchase orders, suppliers, categories, warehouses routes — untouched
- Stock counts module — untouched
- Auth middleware, JWT, company context — untouched

---

## Deployment Steps Required

### 1. Run Migration 053
In Supabase SQL editor, run:
```
database/migrations/053_inventory_reservations.sql
```

**Pre-requisite:** Migrations 050, 051, 052 must be applied first.  
**Note on 052:** If migration 052 includes a `variance_reason` CHECK constraint, verify it matches what `stock-counts.js` writes before running. See FOLLOW-UP NOTE below.

### 2. Push Code to Zeabur

Deployment checklist:
- [ ] `accounting-ecosystem/zbpack.json` does NOT exist ← HARD RULE (see CLAUDE.md Part C)
- [ ] `accounting-ecosystem/Dockerfile` exists and untouched
- [ ] `accounting-ecosystem/.dockerignore` exists
- [ ] Zeabur Root Directory = `accounting-ecosystem` (not `accounting-ecosystem/backend`)
- [ ] Push to main branch

### 3. Smoke Test After Deploy
- Run migration 053
- Test: WO release creates reservations
- Test: items table shows On Hand / Reserved / Available
- Test: dashboard shows Active Reservations and Shortage Items
- Full regression: confirm TEST-RES-01 through TEST-RES-05

---

## Testing Required

Run all 17 scenarios documented in `04_testing_report.md`. Critical priority:
- TEST-RES-01 and TEST-RES-02 (WO release — success and shortage)
- TEST-RES-04 (WO cancel releases reservations)
- TEST-RES-05 (issue materials consumes reservation)
- TEST-RES-14 (multi-tenant isolation — company_id never leaked)
- TEST-RES-17 (no business data in browser storage)

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Migration 052 variance_reason CHECK constraint
- Dependency: 052_inventory_stock_counts.sql
- What was done now: Migration 053 created and ready
- What still needs to be checked: migration 052 must be confirmed applied and its variance_reason enum must match what stock-counts.js actually writes
- Risk if wrong: Migration 053 will fail to apply if 052 has not run
- Recommended next review point: Before first deployment of Codebox 04 to production
```

```
FOLLOW-UP NOTE
- Area: Partial issue + reservation consume edge case
- Dependency: work_order_materials, stock_reservations
- What was done now: consumeReservation() passes issued qty as partial consume
- What still needs to be checked: If a WO material is issued in multiple partial batches, each call queries for the matching reservation. If the first partial moves it to partially_released, the second call needs status IN ('active','partially_released') — confirmed this is what the query uses.
- Risk if wrong: Second partial issue wouldn't find the reservation (status would need to include partially_released) — already handled
- Recommended next review point: TEST-RES-13 (partial consume test)
```

---

## Next Codebox

Codebox 05 (when authorized): Ready to begin. Codebox 04 is fully complete and delivered.
