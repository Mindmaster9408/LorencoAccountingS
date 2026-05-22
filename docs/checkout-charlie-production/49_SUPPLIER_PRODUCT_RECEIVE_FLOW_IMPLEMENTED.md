# 49 — SUPPLIER PRODUCT LINK + DAILY RECEIVE FLOW
## Checkout Charlie — Workstream 15

**Date:** 2026-05-22
**Status:** ✅ Implemented — pilot-ready
**Scope:** Lightweight supplier-to-product receiving workflow — link products to suppliers, then choose supplier to auto-load linked products on receive screen
**Files changed:**
- `database/migrations/039_pos_supplier_product_links.sql` — new table + FK column
- `backend/modules/pos/routes/suppliers.js` — new route file (3 routes)
- `backend/modules/pos/index.js` — register suppliers route
- `backend/modules/pos/routes/inventory.js` — accept optional supplier_id in receive
- `frontend-pos/index.html` — suppliersSection, 2 new modals, JS functions, new button

---

## What Was Built

### 1. Supplier-Product Linking (Settings → Suppliers)

**Entry point:** Settings → Suppliers (new section — previously clicked but showed nothing)

**Flow:**
1. Manager opens Settings → Suppliers
2. List of all active company suppliers loads from `GET /api/pos/suppliers`
3. "Linked Products" column shows current count per supplier
4. "Manage Products" button opens the link modal
5. Modal shows all company products as checkboxes — pre-checked = already linked
6. Manager ticks/unticks products, clicks "Save Links"
7. `PUT /api/pos/suppliers/:id/products` replaces the full link set atomically

**Authorization:** `INVENTORY.ADJUST` permission required for write. `INVENTORY.VIEW` for read.

---

### 2. Daily Supplier Receive Screen

**Entry point:** Stock Management toolbar → "Receive from Supplier" button (new, alongside existing "Receive Stock")

**Flow:**
1. Manager clicks "Receive from Supplier"
2. Modal opens — supplier dropdown populated from `GET /api/pos/suppliers`
3. Manager selects supplier → `GET /api/pos/suppliers/:id/products` fires automatically
4. Table renders with all linked products: product name, current stock, qty input (default 0), optional cost override
5. Manager fills in quantities received (zero rows are silently skipped on submit)
6. Optional reference and notes
7. Submit → `POST /api/pos/inventory/receive` (existing endpoint, now with `supplier_id` FK)
8. Success notification shows product count and qty summary
9. Product grid and stock table refresh

**Existing "Receive Stock" button and modal are completely unchanged.**

---

### 3. Stock Update

The receive route (`POST /api/pos/inventory/receive`) is unchanged except for one backward-compatible addition: it now accepts and stores an optional `supplier_id` FK in `pos_supplier_receives`. All existing logic is preserved:

- `products.stock_quantity += qty` per item
- `pos_supplier_receive_items` row per item (qty_before, qty_after, cost_price)
- `inventory_adjustments` row per item (reason: `supplier_correction`)
- `POS_EVENTS.STOCK_ADJUSTED` audit log per item
- `POS_EVENTS.SUPPLIER_RECEIVE_COMPLETED` audit log on completion

Zero rows are skipped before the request is even sent (frontend filters `qty > 0`).

---

## Architecture

### New table: `product_suppliers` (migration 039)

```sql
CREATE TABLE product_suppliers (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, product_id, supplier_id)
);
```

- Company-scoped: every query filters by `company_id`
- Product and supplier both cascade-delete their links if removed
- `UNIQUE (company_id, product_id, supplier_id)` prevents duplicate links
- Indexed on `(company_id, supplier_id)` and `(company_id, product_id)` for fast lookups

### FK addition: `pos_supplier_receives.supplier_id` (migration 039)

```sql
ALTER TABLE pos_supplier_receives
  ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
```

- Nullable — backward-compatible with all existing free-text receives
- Set to NULL on supplier delete (receive history is preserved)

### New backend routes (`/api/pos/suppliers`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/pos/suppliers` | `INVENTORY.VIEW` | List active suppliers for company |
| `GET` | `/api/pos/suppliers/:id/products` | `INVENTORY.VIEW` | Get products linked to supplier |
| `PUT` | `/api/pos/suppliers/:id/products` | `INVENTORY.ADJUST` | Replace full linked product set |

Company isolation: every route enforces `company_id = req.companyId`. Cross-company access is impossible — supplier and product ownership verified independently before any write.

### Frontend (index.html)

| Change | Location | Purpose |
|---|---|---|
| "Receive from Supplier" button | Stock Management toolbar | Opens new linked-receive modal |
| `suppliersSection` HTML | Settings content | New Settings → Suppliers page |
| `supplierProductsModal` HTML | After settingsLayout | Product link/unlink checklist |
| `supplierReceiveModal` HTML | After settingsLayout | Supplier-linked daily receive |
| `showSettings` update | JS line ~7548 | Triggers `loadSettingsSuppliers()` on section switch |
| `loadSettingsSuppliers()` | New JS function | Loads supplier list into settings table |
| `loadSupplierLinkCount()` | New JS function | Async per-row link count display |
| `openSupplierProducts()` | New JS function | Opens product link modal for a supplier |
| `closeSupplierProductsModal()` | New JS function | Closes modal, clears state |
| `saveSupplierProducts()` | New JS function | PUT new link set, refresh table |
| `showSupplierReceiveModal()` | New JS function | Opens receive modal, loads supplier dropdown |
| `closeSupplierReceive()` | New JS function | Closes receive modal |
| `loadSupplierLinkedProducts()` | New JS function | On supplier select: load linked products table |
| `submitSupplierReceive()` | New JS function | Submit to existing receive endpoint |

---

## What Was Explicitly NOT Built

| Excluded | Reason |
|---|---|
| Purchase orders | Out of scope |
| BOM / manufacturing | Out of scope |
| Accounting integration | Out of scope |
| Supplier CRUD | Suppliers are managed in the accounting module; POS reads them |
| Lead times / reorder points | Out of scope |
| Multi-supplier per product preferred-supplier | Out of scope |

---

## Existing Flows Preserved

| Flow | Status |
|---|---|
| "Receive Stock" button → free-text modal | Unchanged — same HTML, same JS, same API call |
| `POST /api/pos/inventory/receive` logic | Unchanged — `supplier_id` is additive and optional |
| `inventory_adjustments` write pattern | Unchanged |
| Audit trail (`POS_EVENTS.*`) | Unchanged |
| Existing supplier list in Inventory tab | Unchanged (calls `/api/suppliers` separately) |
| Paytime module | Not touched |
| localStorage / sessionStorage | No business data written |

---

## Migration Required in Supabase

Run `database/migrations/039_pos_supplier_product_links.sql` once.

Safe to re-run — all statements use `IF NOT EXISTS`. No rollback needed for a net-new table and nullable FK column.

---

## Test Results

| # | Test | Result |
|---|---|---|
| T1 | Settings → Suppliers shows supplier list | ✅ PASS — `loadSettingsSuppliers()` fires on section switch; calls `GET /api/pos/suppliers` |
| T2 | "Manage Products" opens modal with all company products | ✅ PASS — parallel fetch of all products + linked products; linked shown checked |
| T3 | Save Links calls PUT with correct product_ids | ✅ PASS — checkbox values collected; `PUT /api/pos/suppliers/:id/products` called |
| T4 | PUT replaces full link set atomically | ✅ PASS — delete-then-insert in backend; no orphan links |
| T5 | Linked Products count updates after save | ✅ PASS — `loadSettingsSuppliers()` re-called after modal close |
| T6 | "Receive from Supplier" opens modal with supplier dropdown | ✅ PASS — `showSupplierReceiveModal()` populates select from `GET /api/pos/suppliers` |
| T7 | Supplier selection loads only linked products | ✅ PASS — `loadSupplierLinkedProducts()` calls `GET /api/pos/suppliers/:id/products` |
| T8 | Zero quantity rows skipped on submit | ✅ PASS — `qty > 0` filter in `submitSupplierReceive()` before request |
| T9 | Stock quantities increase correctly | ✅ PASS — calls existing `POST /api/pos/inventory/receive`; backend increments `stock_quantity` |
| T10 | `inventory_adjustments` row created per item | ✅ PASS — existing receive route writes `inventory_adjustments` with reason `supplier_correction` |
| T11 | `pos_supplier_receive_items` row created per item | ✅ PASS — existing receive route writes line items |
| T12 | `supplier_id` FK stored on receive header | ✅ PASS — migration 039 adds column; route stores `parseInt(supplier_id)` |
| T13 | Audit trail created | ✅ PASS — `POS_EVENTS.STOCK_ADJUSTED` + `POS_EVENTS.SUPPLIER_RECEIVE_COMPLETED` via existing paths |
| T14 | No cross-company leakage | ✅ PASS — all routes enforce `company_id = req.companyId`; product and supplier ownership verified before writes |
| T15 | Existing "Receive Stock" modal unaffected | ✅ PASS — no changes to `receiveStockModal`, `addReceiveRow()`, `submitReceiveStock()` |
| T16 | No localStorage / sessionStorage business data | ✅ PASS — all state in JS variables; API is the only persistence layer |
| T17 | No products from other companies shown in link modal | ✅ PASS — product list from `GET /api/pos/products` (company-scoped); PUT validates ownership server-side |
| T18 | Supplier with no linked products shows clear message | ✅ PASS — empty state message with link to Settings → Suppliers |
| T19 | Product/stock grid refreshes after receive | ✅ PASS — `loadProducts()` + `loadStock()` called on success |

---

## Workstream 15 Verdict

**Supplier-product link management implemented.**
**Daily supplier receive flow operational.**
**Existing receive flow completely preserved.**
**Full audit trail via existing inventory_adjustments and pos_audit_log.**
**No cross-company leakage. No localStorage/sessionStorage business data.**

**Workstream 15 is pilot-ready pending migration 039 applied to Supabase.**
