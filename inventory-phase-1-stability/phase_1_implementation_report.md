# Phase 1 Implementation Report — Lorenco Storehouse Stability Build

**Date:** 2026-04-24  
**Scope:** Lorenco Storehouse (frontend-inventory + backend/modules/inventory)  
**Phase:** 1 — Foundation Stability Only  
**Status:** COMPLETE

---

## Executive Summary

Seven critical stability issues were identified in the Lorenco Storehouse inventory module during the Phase 1 audit. All seven have been resolved. No Phase 2 features were introduced.

The changes span one new database migration, two backend files, and one frontend file.

---

## Changes by Risk Category

### 🔴 RISK-001 — Supplier Schema Mismatch (FIXED)

**Root cause:** The `suppliers` table in the database was created by the POS module with column names (`supplier_name`, `contact_email`, `contact_phone`, `tax_reference`) that did not match the inventory backend code, which used the canonical names (`name`, `email`, `phone`, `vat_number`). There was also no `notes` column. Every supplier read, create, and update through the inventory module was silently failing or writing to non-existent columns.

**Fix:** Migration `016_inventory_phase1_stability.sql` adds the five canonical columns (`name`, `email`, `phone`, `vat_number`, `notes`) to the `suppliers` table and backfills `name`, `email`, `phone`, `vat_number` from the legacy POS column values. Old columns are not dropped — backward compatibility is preserved. The `name` column is subsequently set `NOT NULL` to match the backend's requirement.

**Files changed:**
- `accounting-ecosystem/database/migrations/016_inventory_phase1_stability.sql` — migration Step 1

---

### 🔴 RISK-002 — Non-Atomic Stock Updates (FIXED)

**Root cause:** Three separate code paths performed stock mutations using a read-then-write pattern:
1. `POST /movements` in `index.js` — read `current_stock`, compute new value, write back
2. `POST /work-orders/:id/issue-materials` in `work-orders.js` — same pattern
3. `POST /work-orders/:id/complete` in `work-orders.js` — same pattern

In all three, a race condition between the read and write could corrupt `current_stock`. Additionally, in `POST /movements`, the movement record was inserted first — meaning a partial failure could create a movement record with no corresponding stock change, or vice versa.

**Fix:** A new Postgres function `adjust_inventory_stock()` is created by the migration. It executes atomically — within a single `UPDATE + INSERT` sequence — so that `current_stock` and `stock_movements` are always updated together or not at all. All three code paths now call this RPC instead of the read-then-write pattern.

**Files changed:**
- `accounting-ecosystem/database/migrations/016_inventory_phase1_stability.sql` — migration Step 4 (RPC function)
- `accounting-ecosystem/backend/modules/inventory/index.js` — `POST /movements` rewritten
- `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` — `complete` and `issue-materials` rewritten

---

### 🟠 RISK-003 — No Negative Stock Protection (FIXED)

**Root cause:** No database-level constraint prevented `current_stock` from going negative. The API also accepted negative quantities without rejection.

**Fix:**
1. Migration Step 2 adds `CHECK (current_stock >= 0) NOT VALID` to `inventory_items`. The `NOT VALID` flag means the constraint is enforced on new writes immediately but does not retroactively scan existing rows — safe for production tables.
2. The new `adjust_inventory_stock()` RPC includes `AND (current_stock + p_delta) >= 0` in its `UPDATE WHERE` clause. If this condition fails, the RPC returns `{ success: false, error: "Insufficient stock", available: <number> }` and the calling API returns HTTP 422 with the available quantity in the response body.
3. `POST /movements` now validates `qty > 0` and rejects non-positive quantities with HTTP 400.

**Files changed:**
- `accounting-ecosystem/database/migrations/016_inventory_phase1_stability.sql` — migration Steps 2 & 4
- `accounting-ecosystem/backend/modules/inventory/index.js` — `POST /movements` validation

---

### 🟠 RISK-004 — Silent Negative Clamp in issue-materials (FIXED)

**Root cause:** `POST /work-orders/:id/issue-materials` used `Math.max(0, current_stock - qty)` to clamp stock updates, silently allowing over-issue. A user could issue 100 units from an item with 10 in stock, and the system would record `issued_qty += 100` on the WO material line while quietly writing `current_stock = 0`. This corrupted the `issued_qty` ledger and masked the over-issue.

**Fix:** The route is completely rewritten as an all-or-nothing flow:
- **Phase 1 (validation):** All issues are pre-validated before any DB write. Each item's `current_stock` is read and compared. If any item has insufficient stock, the entire request is rejected with HTTP 422 including `available` and `requested` in the response body. No DB writes occur.
- **Phase 2 (apply):** All RPC calls execute only after all validations pass. The `Math.max(0, ...)` clamp is removed entirely.

**Files changed:**
- `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` — `issue-materials` rewritten

---

### 🟠 RISK-005 — No PO Receiving Flow (FIXED)

**Root cause:** The `purchase_orders` table had a `received_qty` field on `purchase_order_items` and a `status` field on `purchase_orders`, but there was no API endpoint to actually receive goods and no frontend UI to trigger it.

**Fix:**
1. `GET /purchase-orders/:id` — new endpoint fetches a single PO with its supplier and all line items (including inventory item name, SKU, unit).
2. `POST /purchase-orders/:id/receive` — new endpoint receives goods against a PO:
   - Validates PO belongs to this company, is not cancelled, and is not already fully received
   - Pre-validates all lines: checks for valid `received_qty`, checks that over-receiving is not attempted
   - Updates `received_qty` on each PO line
   - Calls `adjust_inventory_stock()` RPC for each line to record stock-in atomically
   - Determines new PO status (`partial_receipt` or `received`) by re-querying all lines post-update
   - Writes audit log entry
3. Frontend `openReceivePoModal(poId)` function: fetches PO detail, renders a form with remaining quantity pre-populated as default for each receivable line
4. Frontend `submitPoReceive()` function: collects entered quantities, calls the receive endpoint, refreshes PO list and dashboard
5. PO table updated: added Actions column with Receive button for `draft`, `sent`, and `partial_receipt` status POs

**Files changed:**
- `accounting-ecosystem/backend/modules/inventory/index.js` — added `GET /purchase-orders/:id` and `POST /purchase-orders/:id/receive`
- `accounting-ecosystem/frontend-inventory/index.html` — modal HTML, JS functions, table Actions column

---

### 🟠 RISK-006 — WO Completion Without Materials (FIXED)

**Root cause:** `POST /work-orders/:id/complete` performed no check that required materials had been issued before completing the WO and receiving finished goods into stock. A user could complete a WO that had 0 materials issued, causing stock to increase without materials being consumed.

**Fix:** A pre-completion safety check is now the first action in the complete route (after WO status validation):
- Queries `work_order_materials` for this WO
- Filters to materials where `issued_qty < required_qty`
- If any are found, returns HTTP 422 with `{ error: "...", missing_materials: [...] }` including `material_id`, `item_name`, `required_qty`, `issued_qty`, and `remaining` per missing material
- WOs with no materials (no BOM) are not blocked — the check only applies when materials exist

**Files changed:**
- `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` — `complete` route

---

### 🟢 RISK-007 — Colour Alignment with Ecosystem (FIXED)

**Root cause:** The Storehouse used its own isolated colour palette (dark navy `#0a0e1a`, generic cyan) rather than the Lorenco ecosystem visual identity (deep indigo backgrounds, stronger border treatment, ecosystem-consistent token names).

**Fix:** The `:root {}` CSS block is replaced with the full ecosystem palette. Existing CSS variable names (`--bg`, `--surface`, `--accent`, `--danger`, etc.) are preserved as mapped aliases so no other CSS rules need changing. Modal backgrounds (previously hardcoded `#0d1b2a`) now use `var(--eco-panel)`.

**Additional fixes bundled:**
- `statusBadge()`: added `partial_receipt: 'badge-warning'` mapping
- `statusBadge()`: fixed `replace('_', ' ')` → `replace(/_/g, ' ')` for multi-underscore status strings like `in_progress` and `partial_receipt`
- PO filter dropdown: added `<option value="partial_receipt">Partial Receipt</option>`
- Updated `purchase_orders` status constraint in migration to include `partial_receipt` (was missing, only had `partial`)

**Files changed:**
- `accounting-ecosystem/frontend-inventory/index.html` — `:root`, `body`, `.modal`, `.modal-header`, `statusBadge()`, PO filter

---

## Database Migration Summary

**File:** `accounting-ecosystem/database/migrations/016_inventory_phase1_stability.sql`

| Step | Change | Type |
|------|--------|------|
| 1 | Add canonical columns to `suppliers` table; backfill; set `name NOT NULL` | Additive — old columns not dropped |
| 2 | Add `chk_current_stock_non_negative` constraint to `inventory_items` with `NOT VALID` | Non-blocking new writes |
| 3 | Drop old `purchase_orders` status constraint; add new one including `partial_receipt` | Constraint update |
| 4 | Create `adjust_inventory_stock()` Postgres function (atomic stock + movement) | New function |

---

## What Was NOT Changed

- No Phase 2 features introduced (no sales orders, no full costing engine, no lot/serial tracking, no GL integration)
- No existing BOM routes changed
- No existing WO routes changed except `complete` and `issue-materials` (both backward-compatible API contracts)
- No localStorage usage introduced for business data
- No `zbpack.json` created (Zeabur deployment rules preserved — CLAUDE.md Rule C1)
- `WORKDIR /app` unchanged in Dockerfile
- All multi-tenant scoping (`company_id`) preserved on every new DB query
- Old supplier columns (`supplier_name`, `contact_email`, `contact_phone`, `tax_reference`) not dropped — POS module backward compatibility maintained

---

## Deployment Order

1. Run migration `016_inventory_phase1_stability.sql` on Supabase (SQL editor or migration runner)
2. Verify: check the 4 SQL verification queries in the migration file comments
3. Deploy updated backend (Zeabur auto-deploys on git push)
4. Clear Zeabur build cache if needed (see CLAUDE.md Rule C5)
5. Test using the test plan in `phase_1_testing_report.md`
