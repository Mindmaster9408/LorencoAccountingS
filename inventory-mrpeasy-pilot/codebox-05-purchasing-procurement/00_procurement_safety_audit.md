# Codebox 05 — Pre-Change Procurement Safety Audit

**Date:** 2026-05-26  
**Scope:** All procurement-related tables, routes, and frontend before Codebox 05 changes.

---

## 1. Existing Table State

### `purchase_orders` (from `007_inventory_practice.sql`)

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER NOT NULL | ✅ company scoped |
| supplier_id | INTEGER | FK to suppliers |
| po_number | TEXT | nullable |
| status | TEXT | CHECK: draft/sent/partial/received/cancelled |
| order_date | DATE | |
| expected_date | DATE | |
| notes | TEXT | |
| total_amount | NUMERIC(12,2) | |
| created_by | INTEGER | FK to users |
| created_at / updated_at | TIMESTAMPTZ | |

**Gaps identified:**
- `status` CHECK allows `partial` — but `index.js` uses `partial_receipt` in queries. Mismatch.
- No `approved_by`, `approved_at` columns — no approval workflow
- No `po_number` auto-generation or uniqueness constraint
- No `ordered` status (only draft/sent)
- No `fully_received` distinct from `received`
- No `closed` status
- No `currency_code` column
- No `subtotal` / `tax_amount` separation

### `purchase_order_items` (from `007_inventory_practice.sql`)

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| purchase_order_id | INTEGER NOT NULL | FK to purchase_orders |
| item_id | INTEGER | FK to inventory_items |
| description | TEXT NOT NULL | |
| quantity | NUMERIC(12,3) NOT NULL | |
| unit_cost | NUMERIC(12,2) NOT NULL DEFAULT 0 | |
| received_qty | NUMERIC(12,3) NOT NULL DEFAULT 0 | |
| line_total | GENERATED ALWAYS AS (quantity * unit_cost) STORED | |

**Gaps identified:**
- No `outstanding_qty` column (computed but not stored)
- No `supplier_sku` column
- No `expected_date` per line
- `description` NOT NULL but `item_id` is nullable — item could be lost
- No `notes` column per line
- `purchase_order_id` column (not `po_id`) — **critical**: `index.js` uses `po_id` everywhere → MISMATCH

### `suppliers` (from `007_inventory_practice.sql`)

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| company_id | INTEGER NOT NULL | ✅ company scoped |
| name | TEXT NOT NULL | |
| contact_name | TEXT | |
| email / phone / address / notes | TEXT | |
| is_active | BOOLEAN DEFAULT TRUE | |
| created_at / updated_at | TIMESTAMPTZ | |

**Gaps:** No `supplier_code`, `payment_terms`, `lead_time_days` columns.  
The backend `POST /suppliers` auto-generates `supplier_code` and sets `supplier_name = name` — but neither column exists in the base table. This works in production because the Supabase DB likely evolved past this migration. The backend also references `vat_number` which is absent from this migration but present in DB.

---

## 2. Backend Route Analysis

### `GET /purchase-orders`
- Selects from `purchase_orders` joining `suppliers:supplier_id(name)`
- Status filter by exact match
- ✅ company scoped
- **Gap:** Returns no enrichment (received %, outstanding qty)

### `GET /purchase-orders/:id`
- Fetches PO + lines from `purchase_order_items` using `.eq('po_id', po.id)`
- **CRITICAL GAP:** `purchase_order_items` table has column `purchase_order_id`, not `po_id`. This has been working only because the actual DB schema may have been adjusted separately from the migration file. Codebox 05 migration must ADD `po_id` or alias if needed — verify in migration.

### `POST /purchase-orders`
- Creates PO header + lines in `purchase_order_items` with `po_id` column
- No approval workflow
- No PO number auto-generation via sequence

### `PUT /purchase-orders/:id`
- Allows status changes without lifecycle validation — can transition from any status to any status including `cancelled` after receipt
- **Gap:** No guard preventing status downgrade after receipt

### `POST /purchase-orders/:id/receive`
- Over-receive prevention: ✅ validated
- adjustStockTx with `sourceType: 'po_receive'` ✅
- Valuation movement created ✅
- No immutable receipt record created — **CRITICAL GAP for Codebox 05**
- No `supplier_item_history` update — **Gap**
- Status transitions to `partial_receipt` or `received` ✅

---

## 3. Procurement Gaps

| Gap | Severity | Codebox 05 Fix |
|---|---|---|
| No immutable receipt history | CRITICAL | Create `purchase_receipts` + `purchase_receipt_lines` |
| No supplier item intelligence | HIGH | Create `supplier_item_history` |
| No procurement recommendations | HIGH | Create `procurementService.js` |
| No shortage → PO flow | HIGH | Procurement Suggestions UI |
| No PO approval workflow | MEDIUM | Add `approved_by`/`approved_at` to POs |
| No `ordered` status | MEDIUM | Extend status CHECK in migration 055 |
| status mismatch: `partial` vs `partial_receipt` | HIGH | Standardize in migration 055 |
| No `po_id` / `purchase_order_id` column consistency | HIGH | Clarify in migration 055 |
| No receipt per-line unit_cost tracking | HIGH | Receipts capture cost at receive time |
| No overdue PO detection | MEDIUM | Backend report + frontend badge |
| No "Create PO from shortage" flow | MEDIUM | Frontend suggestion → create PO |

---

## 4. Frontend Audit

### Existing tabs using PO/supplier data
- `tab-suppliers` — Suppliers list with add/edit ✅
- `tab-orders` — PO list with status filter + receive modal ✅
- No "Create PO" button on orders tab
- No PO detail view
- No receipt history view per PO
- No procurement suggestions tab

### localStorage Scan (procurement-specific)
- `_suppliersCache = []` — in-memory JS variable, NOT localStorage ✅
- `_poReceiveId`, `_poReceiveLinesData` — in-memory JS variables, NOT localStorage ✅
- No procurement business data in localStorage ✅

---

## 5. Company Isolation Audit

All existing PO/supplier routes use `.eq('company_id', req.companyId)` ✅  
Receive route verifies PO ownership before receipt ✅  
`purchase_order_items` is NOT company-scoped directly — relies on PO ownership check ✅ (acceptable — lines always accessed through verified PO)

---

## 6. Valuation Interaction Audit

Current receive flow:
1. Validates over-receive ✅
2. Calls `adjustStockTx()` with `po_receive` source type ✅
3. `adjust_inventory_stock()` RPC: updates `inventory_items.last_purchase_cost` for `po_receive` ✅
4. Creates `stock_valuation_movements` row ✅
5. Creates `inventory_cost_layers` row (FIFO) ✅
6. Updates weighted average cost ✅

**Missing from current flow:**
- No `purchase_receipts` row created (no receipt audit trail)
- No `supplier_item_history` update
- Status mismatch (`partial_receipt` vs `partial` in DB CHECK)

---

## 7. Planned Architecture for Codebox 05

### New Tables (migration 055)
1. **Extend `purchase_orders`** — add columns: `po_number` sequence, `po_status` standardization, `approved_by`, `approved_at`, `closed_at`, `currency_code`, `subtotal`, `tax_amount`, status CHECK updated
2. **Extend `purchase_order_items`** — add: `supplier_sku`, `expected_date`, `notes`; clarify `po_id` vs `purchase_order_id`
3. **`purchase_receipts`** — immutable receipt header (one per receive action)
4. **`purchase_receipt_lines`** — one per item received; links to movement_id
5. **`supplier_item_history`** — intelligence table per supplier+item per company

### New Service
- `procurementService.js` — shortage recommendations, reorder recommendations, preferred supplier logic

### New Routes
- `routes/purchase-orders.js` — full PO lifecycle + approval + receipt history
- Route mounted at `/api/inventory/purchase-orders` (replacing inline index.js routes)

### Frontend Updates
- Purchase Orders tab: "Create PO" button, overdue badge, received %, outstanding
- PO Detail modal: lines, receipt history, approve/order/close/cancel actions
- New "Procurement Suggestions" tab
- Supplier tab: add lead_time, payment_terms display
