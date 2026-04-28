# Lorenco Storehouse — Risk Register
**Date:** April 24, 2026
**Source:** Full system audit of `frontend-inventory/index.html`, `backend/modules/inventory/`, `database/migrations/014_inventory_manufacturing.sql`, `database/schema.sql`

---

## Risk Rating Key

| Severity | Likelihood | Rating | Meaning |
|---|---|---|---|
| CRITICAL | HIGH | 🔴 IMMEDIATE | Data corruption or system failure likely under normal use |
| HIGH | HIGH | 🟠 URGENT | Significant gap, will cause problems in production at scale |
| HIGH | MEDIUM | 🟡 HIGH | Important gap, controllable short-term but must be addressed |
| MEDIUM | LOW | 🟢 MEDIUM | Real gap but manageable with workarounds |
| LOW | LOW | ⚪ LOW | Minor, cosmetic, or edge case |

---

## RISK-001 — Supplier Table Schema Mismatch

| Field | Value |
|---|---|
| **ID** | RISK-001 |
| **Rating** | 🔴 IMMEDIATE |
| **Area** | Backend / Database |
| **File** | `backend/modules/inventory/index.js` (suppliers routes), `database/schema.sql` (line 365) |
| **Severity** | CRITICAL |
| **Likelihood** | HIGH |

**Description:**
The `schema.sql` file defines a `suppliers` table with column names `supplier_name`, `contact_email`, `contact_phone`, and `tax_reference`. The inventory backend routes insert and query with `name`, `email`, `phone`, and `vat_number`. These column names do not match.

**Impact:**
- If the live Supabase schema matches `schema.sql`, ALL supplier create and update API calls will fail with column-not-found errors.
- Supplier functionality in the inventory module may be completely broken in production.

**Recommendation:**
1. Query live Supabase to confirm actual column names on the `suppliers` table.
2. Either update the backend to use the correct column names, OR apply a migration that renames/adds the expected columns.
3. Update `schema.sql` to reflect the actual live schema.

---

## RISK-002 — Non-Atomic Stock Updates (Race Condition)

| Field | Value |
|---|---|
| **ID** | RISK-002 |
| **Rating** | 🔴 IMMEDIATE |
| **Area** | Backend — Stock Movement Logic |
| **File** | `backend/modules/inventory/index.js` (POST /movements), `routes/work-orders.js` (complete, issue-materials) |
| **Severity** | CRITICAL |
| **Likelihood** | HIGH under concurrent usage |

**Description:**
All stock update operations follow the same pattern:
1. READ `current_stock` from `inventory_items`
2. Calculate new value in application code
3. WRITE new value back

There is no database transaction, no row lock, and no atomic operation. If two requests hit the same item simultaneously, both read the same `current_stock`, calculate separate deltas, and write conflicting results.

**Example:**
- Item A has 100 units
- Request 1: issues 30 → reads 100, writes 70
- Request 2: issues 20 → reads 100 (before Request 1 commits), writes 80
- Final stock: 80 (wrong — should be 50)

**This pattern exists in three places:**
- `POST /api/inventory/movements`
- `POST /api/inventory/work-orders/:id/complete`
- `POST /api/inventory/work-orders/:id/issue-materials`

**Impact:**
- Silent stock count corruption under any concurrent load
- Cannot be detected from audit log alone — movements appear valid but totals disagree

**Recommendation:**
Replace with a Supabase RPC function using `UPDATE ... SET current_stock = current_stock + delta WHERE id = X AND company_id = Y` — let the DB do the math atomically. No read-before-write needed.

---

## RISK-003 — No Negative Stock Protection

| Field | Value |
|---|---|
| **ID** | RISK-003 |
| **Rating** | 🟠 URGENT |
| **Area** | Database + Backend |
| **File** | `backend/modules/inventory/index.js` (POST /movements), database schema |
| **Severity** | HIGH |
| **Likelihood** | HIGH |

**Description:**
No database-level `CHECK (current_stock >= 0)` constraint exists on `inventory_items`. The `POST /movements` endpoint does not validate that an 'out' movement would exceed available stock. Stock can be driven to negative values silently.

**Impact:**
- Negative stock is physically impossible — it means more goods were issued than ever received
- All stock valuation and reorder calculations are invalidated
- Manufacturing work orders can issue materials beyond what exists in stock

**Recommendation:**
1. Add DB constraint: `ALTER TABLE inventory_items ADD CONSTRAINT chk_current_stock_non_negative CHECK (current_stock >= 0);`
2. Add API-level check in `POST /movements`: before writing, validate `newStock >= 0`, return HTTP 422 with clear error if not.

---

## RISK-004 — Silent Negative Stock in Issue-Materials (Work Orders)

| Field | Value |
|---|---|
| **ID** | RISK-004 |
| **Rating** | 🟠 URGENT |
| **Area** | Backend — Work Order Module |
| **File** | `routes/work-orders.js` (POST /:id/issue-materials) |
| **Severity** | HIGH |
| **Likelihood** | HIGH |

**Description:**
The `issue-materials` endpoint uses `Math.max(0, current_stock - qty)` to calculate the new stock level. This means:
- If `qty` (quantity to issue) > `current_stock`, the code clamps to 0 rather than rejecting the request.
- `issued_qty` is still updated with the full `qty` value.
- `current_stock` is set to 0 but stock is still considered "issued" in the WO.

This creates a silent discrepancy: `issued_qty` reflects more than was actually in stock, but the stock movement records a different amount.

**Impact:**
- Work orders appear fully issued but actual raw material consumption was untracked
- Stock accuracy is permanently compromised for the affected item
- No error is surfaced to the user

**Recommendation:**
Reject the issue with HTTP 422 if `qty > current_stock`. Return `{ error: 'Insufficient stock', available: current_stock, requested: qty }`.

---

## RISK-005 — Purchase Order Receiving Flow Missing

| Field | Value |
|---|---|
| **ID** | RISK-005 |
| **Rating** | 🟠 URGENT |
| **Area** | Backend — Purchase Orders |
| **File** | `backend/modules/inventory/index.js` |
| **Severity** | HIGH |
| **Likelihood** | HIGH |

**Description:**
`purchase_order_items.received_qty` exists in the schema (always inserted as 0). There is no `POST /purchase-orders/:id/receive` endpoint. The only PO status endpoint (`PUT /purchase-orders/:id`) can set `status='received'` but creates no stock movements and updates no `received_qty` fields.

**Impact:**
- Stock can never be received via purchase orders
- POs are tracking documents only — not operational
- Received goods must be entered manually via a separate stock movement (no link to PO)
- No partial delivery support

**Recommendation:**
Implement `POST /api/inventory/purchase-orders/:id/receive` with payload `{ lines: [{ line_id, received_qty }] }` that:
1. Updates `purchase_order_items.received_qty` for each line
2. Creates `stock_movements` (type='in') for each received line
3. Optionally updates `inventory_items.current_stock`
4. Updates PO status to 'received' or 'partial_receipt' as appropriate

---

## RISK-006 — Work Order Completion Does Not Backflush Materials

| Field | Value |
|---|---|
| **ID** | RISK-006 |
| **Rating** | 🟠 URGENT |
| **Area** | Backend — Work Order Completion |
| **File** | `routes/work-orders.js` (POST /:id/complete) |
| **Severity** | HIGH |
| **Likelihood** | HIGH |

**Description:**
`POST /:id/complete` adds finished goods stock and closes the WO, but does NOT:
- Check whether all required materials were issued
- Auto-deduct raw materials from stock (backflush) if they weren't issued

A WO can be completed with `issued_qty = 0` for all materials. The system adds finished goods to stock with no corresponding raw material deduction — stock appears created from nothing.

**Impact:**
- Raw material stock is overstated (materials never deducted)
- Finished goods stock is correct in count but manufactured "for free"
- COGS is impossible to calculate
- No production accountability

**Recommendation:**
Two options:
1. **Backflush on complete:** Auto-deduct all `required_qty - issued_qty` from stock when WO is completed. Record as stock_out movements referencing the WO.
2. **Require pre-issue:** Block WO completion unless all materials show `issued_qty >= required_qty`. Force user to issue materials first.
Option 2 is safer for audit trail. Add a pre-completion check: `SELECT COUNT(*) FROM work_order_materials WHERE work_order_id = X AND issued_qty < required_qty`.

---

## RISK-007 — Partial Success Returns HTTP 200 in Issue-Materials

| Field | Value |
|---|---|
| **ID** | RISK-007 |
| **Rating** | 🟡 HIGH |
| **Area** | Backend — API Contract |
| **File** | `routes/work-orders.js` (POST /:id/issue-materials) |
| **Severity** | HIGH |
| **Likelihood** | MEDIUM |

**Description:**
The issue-materials handler loops through materials, collects errors into an `errors[]` array, but returns HTTP 200 with `{ success: true, errors: [...] }` even when some materials failed to issue.

**Impact:**
- Frontend cannot distinguish full success from partial failure by HTTP status code
- UI shows "success" toast even if 3 of 5 materials failed
- Partial issue state is not visible to user

**Recommendation:**
- If any material in the batch fails: return HTTP 207 (Multi-Status) or HTTP 500
- Alternatively: use a transaction and roll back all on any failure
- At minimum: if `errors.length > 0`, return HTTP 207 with `{ success: false, errors }` so the frontend can show a warning

---

## RISK-008 — Raw Database Errors Exposed in API Responses

| Field | Value |
|---|---|
| **ID** | RISK-008 |
| **Rating** | 🟡 HIGH |
| **Area** | Backend — Error Handling |
| **File** | All inventory route files |
| **Severity** | HIGH |
| **Likelihood** | MEDIUM |

**Description:**
All catch blocks return `res.status(500).json({ error: error.message })`. This exposes raw Supabase/PostgreSQL error messages to the client, which can include table names, column names, constraint names, and query fragments.

**Impact:**
- OWASP A05 — Security Misconfiguration: schema information disclosure
- Leaks internal architecture details to any user (or attacker) who triggers an error
- In production, any validation failure exposes DB internals

**Recommendation:**
Implement a consistent error wrapper:
```js
function handleDbError(res, error, userMessage = 'An error occurred') {
  console.error('[INVENTORY ERROR]', error);
  res.status(500).json({ error: userMessage });
}
```
Log the real error server-side; return only a generic message to the client.

---

## RISK-009 — PO Creation Not Transactional

| Field | Value |
|---|---|
| **ID** | RISK-009 |
| **Rating** | 🟡 HIGH |
| **Area** | Backend — Purchase Order Creation |
| **File** | `backend/modules/inventory/index.js` (POST /purchase-orders) |
| **Severity** | HIGH |
| **Likelihood** | LOW |

**Description:**
`POST /purchase-orders` inserts the PO header first, then inserts line items in a loop. If any line insert fails (e.g., invalid `item_id`, network timeout), the PO header is left orphaned with partial or no line items. There is no cleanup or rollback.

**Impact:**
- Orphan PO records with missing lines
- Data inconsistency between `purchase_orders` and `purchase_order_items`

**Recommendation:**
Use a Supabase RPC function with a DB transaction, or wrap in try-catch that deletes the header if line inserts fail (as the BOM creation code correctly does).

---

## RISK-010 — No Role-Based Access Control Within Inventory

| Field | Value |
|---|---|
| **ID** | RISK-010 |
| **Rating** | 🟡 HIGH |
| **Area** | Backend — Permissions |
| **File** | `backend/modules/inventory/index.js`, all route files |
| **Severity** | HIGH |
| **Likelihood** | MEDIUM |

**Description:**
All inventory routes require only: valid JWT (`authenticateToken`) + company has inventory module (`requireModule('inventory')`). Any authenticated user with module access can:
- Delete inventory items
- Create and activate BOMs
- Release and complete work orders
- Create and cancel purchase orders

There is no check for `req.user.role` anywhere in the inventory module.

**Impact:**
- Any staff-level user can perform destructive inventory operations
- A data entry clerk can activate a BOM or cancel an in-progress work order
- No accountability for high-impact actions

**Recommendation:**
Define inventory permission tiers (e.g., `inventory_admin`, `inventory_manager`, `inventory_viewer`) and add role checks to write/delete operations.

---

## RISK-011 — Stock Transfer Cannot Encode Source and Destination

| Field | Value |
|---|---|
| **ID** | RISK-011 |
| **Rating** | 🟡 HIGH |
| **Area** | Database / Backend |
| **File** | `database/schema.sql` (stock_movements), `backend/modules/inventory/index.js` |
| **Severity** | HIGH |
| **Likelihood** | HIGH (if multi-location used) |

**Description:**
`stock_movements` has a single `warehouse_id` field. A `type='transfer'` movement cannot encode both the source warehouse and the destination warehouse. The transfer creates one ledger entry with one warehouse — direction is ambiguous.

**Impact:**
- Inter-warehouse transfers cannot be tracked
- Cannot produce per-location stock reports
- Multi-location inventory management is incomplete

**Recommendation:**
Add `from_warehouse_id` and `to_warehouse_id` to `stock_movements`. Use `from_warehouse_id` for 'out' side and `to_warehouse_id` for 'in' side. A transfer should create TWO movements (one out from source, one in to destination), or add both fields to a single transfer record.

---

## RISK-012 — Application-Layer Search and Filter Will Not Scale

| Field | Value |
|---|---|
| **ID** | RISK-012 |
| **Rating** | 🟢 MEDIUM |
| **Area** | Backend — Items Endpoint |
| **File** | `backend/modules/inventory/index.js` (GET /items) |
| **Severity** | MEDIUM |
| **Likelihood** | LOW (current scale), HIGH (at 1,000+ items) |

**Description:**
`GET /api/inventory/items` fetches ALL active items for the company from the database and then filters in application-layer JavaScript using `.filter()`. This includes the `low_stock` flag filter and the full-text search filter.

**Impact:**
- Full table scan on every search/filter request
- Payload grows proportionally with item count — every filter request sends the entire catalog to the server and back
- Performance degrades significantly at 500+ items
- Frontend also caches `allItems[]` and re-filters client-side — dual filter responsibility

**Recommendation:**
Push all filters to the Supabase query:
```js
if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
if (low_stock) query = query.filter('current_stock', 'lte', supabase.raw('min_stock'));
```
Add DB indexes on `inventory_items(company_id, name)` and `inventory_items(company_id, current_stock, min_stock)`.

---

## RISK-013 — Lot/Serial Tracking Flags Without Implementation

| Field | Value |
|---|---|
| **ID** | RISK-013 |
| **Rating** | 🟢 MEDIUM |
| **Area** | Database / Backend |
| **File** | `database/migrations/014_inventory_manufacturing.sql` |
| **Severity** | MEDIUM |
| **Likelihood** | HIGH (when feature is expected) |

**Description:**
`inventory_items.track_lots` and `track_serials` are UI-settable boolean flags. There are no `lot_numbers`, `batch_records`, or `serial_numbers` tables. Enabling these flags has zero effect on any stock movement or PO receipt flow.

**Impact:**
- Users may enable lot tracking expecting it to work
- No lot numbers captured on receipts or issues
- Cannot produce lot traceability reports

**Recommendation:**
Either:
1. Remove the flags from the item form until lot tracking is implemented, OR
2. Create the supporting tables and intake flow: `lot_numbers (id, item_id, lot_reference, received_date, expiry_date, quantity)` + link to `stock_movements`

---

## RISK-014 — Costing Method Flags Without Implementation

| Field | Value |
|---|---|
| **ID** | RISK-014 |
| **Rating** | 🟢 MEDIUM |
| **Area** | Database / Backend |
| **File** | `database/migrations/014_inventory_manufacturing.sql` |
| **Severity** | MEDIUM |
| **Likelihood** | HIGH (when stock valuation is needed) |

**Description:**
`inventory_items.costing_method` accepts 'average', 'fifo', 'standard'. No costing engine exists. `cost_price` is a flat field on items — it does not update on receipt. `stock_movements.cost_price` is stored but never consumed by any valuation logic. There are no cost layers or cost history tables.

**Impact:**
- Stock valuation reports cannot be produced
- COGS cannot be calculated
- Balance sheet integration with accounting module is impossible
- Statutory financial reporting requirements cannot be met

**Recommendation:**
Phase 1: Implement average cost update on `POST /purchase-orders/:id/receive`:
```
new_avg_cost = (current_stock * old_cost_price + received_qty * unit_price) / (current_stock + received_qty)
UPDATE inventory_items SET cost_price = new_avg_cost
```
Phase 2: Build FIFO cost layers for items requiring `costing_method='fifo'`.

---

## RISK-015 — Tab Caching Causes Stale Data

| Field | Value |
|---|---|
| **ID** | RISK-015 |
| **Rating** | ⚪ LOW |
| **Area** | Frontend |
| **File** | `frontend-inventory/index.html` |
| **Severity** | LOW |
| **Likelihood** | HIGH (observable in normal usage) |

**Description:**
Tabs are lazy-loaded on first visit and marked with `_tabLoaded.X = true`. Subsequent visits do not reload. If another user updates data while you are on the same session, your view is stale. If you create a BOM then navigate away and back, you may not see it until reload.

**Impact:**
- Minor UX inconsistency
- Can confuse users in shared multi-user environments

**Recommendation:**
Clear `_tabLoaded[tab] = false` after any mutation that affects that tab. Or implement a lightweight background poll on the current tab.

---

## RISK-016 — No Accounting Integration

| Field | Value |
|---|---|
| **ID** | RISK-016 |
| **Rating** | 🟢 MEDIUM |
| **Area** | Integration |
| **File** | Ecosystem-wide |
| **Severity** | MEDIUM |
| **Likelihood** | HIGH (when accounting integration is needed) |

**Description:**
No GL account linkage exists on inventory items. No journal entries are created when:
- Stock is received (debit Inventory, credit AP or GR/IR)
- Stock is issued to a WO (debit WIP, credit Inventory)
- Finished goods are received (debit FG Inventory, credit WIP)
- Stock is sold (debit COGS, credit Inventory)

**Impact:**
- Accounting app cannot reflect inventory movements in the general ledger
- Balance sheet has no inventory asset figure from Lorenco Storehouse
- Financial statements are incomplete without this integration

**Recommendation:**
Add `gl_account_id` fields to `inventory_items` (asset account) and `stock_movements` (expense account override). When a movement is created, emit an event or directly call the accounting journal entry API to record the double-entry.

---

## RISK-017 — No PO Number Field

| Field | Value |
|---|---|
| **ID** | RISK-017 |
| **Rating** | ⚪ LOW |
| **Area** | Database / Backend |
| **File** | `backend/modules/inventory/index.js` (POST /purchase-orders) |
| **Severity** | LOW |
| **Likelihood** | HIGH (visible to users) |

**Description:**
`purchase_orders` has no `po_number` field. Unlike work orders (which auto-generate `WO-00001`), POs have only an internal integer ID. Users cannot reference a PO by a meaningful number when communicating with suppliers.

**Impact:**
- No human-readable PO reference for supplier communication
- No traceability by PO reference on stock movements

**Recommendation:**
Add `po_number VARCHAR UNIQUE(company_id, po_number)` and auto-generate in the same style as WO numbers: `PO-00001`.

---

## Risk Summary Table

| Risk ID | Description | Rating | Status |
|---|---|---|---|
| RISK-001 | Supplier table schema mismatch | 🔴 IMMEDIATE | OPEN |
| RISK-002 | Non-atomic stock updates (race condition) | 🔴 IMMEDIATE | OPEN |
| RISK-003 | No negative stock protection | 🟠 URGENT | OPEN |
| RISK-004 | Silent negative stock in issue-materials | 🟠 URGENT | OPEN |
| RISK-005 | PO receiving flow missing | 🟠 URGENT | OPEN |
| RISK-006 | WO completion does not backflush materials | 🟠 URGENT | OPEN |
| RISK-007 | Partial success returns HTTP 200 | 🟡 HIGH | OPEN |
| RISK-008 | Raw DB errors exposed in responses | 🟡 HIGH | OPEN |
| RISK-009 | PO creation not transactional | 🟡 HIGH | OPEN |
| RISK-010 | No role-based access control | 🟡 HIGH | OPEN |
| RISK-011 | Transfer movements cannot encode source/destination | 🟡 HIGH | OPEN |
| RISK-012 | Application-layer search/filter won't scale | 🟢 MEDIUM | OPEN |
| RISK-013 | Lot/serial tracking flags without implementation | 🟢 MEDIUM | OPEN |
| RISK-014 | Costing method flags without implementation | 🟢 MEDIUM | OPEN |
| RISK-015 | Tab caching causes stale data | ⚪ LOW | OPEN |
| RISK-016 | No accounting GL integration | 🟢 MEDIUM | OPEN |
| RISK-017 | No PO number field | ⚪ LOW | OPEN |

---

## localStorage / sessionStorage Scan Result

| Finding | Status |
|---|---|
| `localStorage.getItem('token')` at line 651 in `frontend-inventory/index.html` | ✅ CLEARED — Auth token read-only. Approved pattern per ecosystem architecture. No business data. |

**No critical localStorage misuse detected in the inventory module.**
