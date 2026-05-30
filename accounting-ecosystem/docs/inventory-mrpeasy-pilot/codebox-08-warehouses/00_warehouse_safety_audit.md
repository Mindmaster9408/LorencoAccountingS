# CB-08 — Warehouse Safety Audit

**Date:** 2026-05-29
**Module:** Lorenco Storehouse — Warehouse Structure & Location Control

---

## 1. Current State (Pre CB-08)

### Existing warehouse support
| Feature | Status |
|---------|--------|
| `warehouses` table exists | ✅ (migration 007 + 014) |
| `warehouse_id` on `inventory_items` | ✅ |
| `warehouse_id` on `stock_movements` | ✅ |
| `warehouse_id` on `stock_reservations` | ✅ (nullable) |
| `warehouse_id` on `stock_count_sessions` | ✅ (nullable) |
| `adjustStockTx` accepts `warehouseId` | ✅ |
| `getAvailableStock` accepts `warehouseId` | ✅ |
| Per-location (bin-level) tracking | ❌ None |
| Warehouse transfers | ❌ None |
| `inventory_stock_locations` table | ❌ None |
| `warehouse_locations` table | ❌ None |

### Pre-existing bug: `address` / `notes` mismatch
- Routes in `index.js` used `address` and `notes` fields on the `warehouses` table
- Migration 014 added `location_type` — but never added `address` or `notes`
- Result: `POST/PUT /warehouses` silently failed to persist address/notes data
- **Fixed in CB-08**: Migration 058 adds `address_line1`, `address_line2`, `city`, `postal_code`, `contact_*`, `notes`

---

## 2. Company Isolation Audit

| Surface | company_id present | Status |
|---------|-------------------|--------|
| `warehouses` | YES | ✅ |
| `warehouse_locations` (new) | YES, NOT NULL | ✅ |
| `inventory_stock_locations` (new) | YES, NOT NULL | ✅ |
| `warehouse_transfers` (new) | YES, NOT NULL | ✅ |
| `warehouse_transfer_lines` (new) | YES, NOT NULL | ✅ |
| Transfer service: all queries `.eq('company_id', companyId)` | YES | ✅ |
| Warehouse-location routes: verify warehouse belongs to company before any operation | YES | ✅ |

Cross-tenant leakage risk: **None identified**.

---

## 3. Stock Engine Impact

### `adjustStockTx` — unchanged
The `adjust_inventory_stock` RPC is not modified. All transfer movements go through the existing forensic stock engine. The transfer service calls `adjustStockTx` exactly as other parts of the system do.

### `inventory_stock_locations` — supplementary only
`inventory_stock_locations` is a **denormalized summary table**, not a new source of truth. The source of truth for company-total stock remains `inventory_items.current_stock`. The stock location ledger is updated by `upsertStockLocation()` called from the transfer service after `adjustStockTx` succeeds.

If `upsertStockLocation()` fails, it logs a warning and does not fail the transfer — the primary stock record is already committed.

### No silent stock changes
Every transfer that removes stock from the source warehouse creates a real `movement_type='transfer'` record in `stock_movements` with `source_type='warehouse_transfer'`. Every receive creates another. No stock can move between warehouses without an audit trail.

---

## 4. Frontend Storage Audit

| Check | Result |
|-------|--------|
| `localStorage.setItem` in index.html | 0 occurrences |
| `sessionStorage.setItem` in index.html | 0 occurrences |
| Transfer state in browser storage | None — all state in DB |
| Warehouse selection state | In-memory JS variable only |

Only `localStorage.getItem('token')` — auth token read permitted by Rule D2.

---

## 5. Identified Gaps (Tracked for Future Codeboxes)

| Gap | Severity | Phase |
|-----|----------|-------|
| `inventory_stock_locations` is not populated by existing movements (only by transfers and new movements) | LOW | CB-09 or future |
| Location-level reservation (reserve at specific bin) not yet enforced | LOW | CB-09 |
| Partial transfer receipt: per-line quantity override via PUT /ship and /receive | MEDIUM | Already supported via `lines` body |
| Warehouse capacity enforcement (max_capacity alert) | LOW | Future |
| Concurrent transfer race condition (two transfers for the same item, both ship simultaneously) | MEDIUM | Mitigated by RPC row locks on `adjustStockTx`; full warehouse-level locking deferred |

---

## 6. Planned Architecture (Implemented in CB-08)

```
warehouses
  └── warehouse_locations (bins/shelves)
        └── inventory_stock_locations (qty per item × warehouse × location)

warehouse_transfers
  └── warehouse_transfer_lines (per-item detail)

On SHIP:
  adjustStockTx(OUT, source_warehouse) → stock_movements audit record
  upsertStockLocation(source, -qty)    → supplementary location ledger

On RECEIVE:
  adjustStockTx(IN, dest_warehouse)    → stock_movements audit record
  upsertStockLocation(dest, +qty)      → supplementary location ledger
```
