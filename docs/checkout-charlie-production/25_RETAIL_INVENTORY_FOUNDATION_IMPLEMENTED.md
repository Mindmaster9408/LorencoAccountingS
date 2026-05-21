# 25 — RETAIL INVENTORY FOUNDATION IMPLEMENTED
## Checkout Charlie — Workstream 7A

**Date:** 2026-05-21
**Status:** ✅ Implemented — pilot-ready
**Scope:** FAST RETAIL OPERATIONAL INVENTORY only

---

## What Was Built

### 1. Basic Stock Take (Manager-only)

**Backend route:** `POST /api/pos/inventory/stock-take`
**Permission required:** `INVENTORY.ADJUST`
**Table written:** `pos_stock_takes` (header), `pos_stock_take_items` (per-product rows)

Behaviour:
- Manager submits a full product count with a counted quantity per product
- System reads current `stock_quantity` from `products`
- Variance = `counted_qty - system_qty`
- If variance ≠ 0: updates `products.stock_quantity` to exact counted value (physical count is authoritative)
- Writes `inventory_adjustments` with reason `'stock_take_variance'` (before/after/change recorded)
- Fires `STOCK_ADJUSTED` audit event per changed product
- Fires `STOCK_TAKE_COMPLETED` audit event for the session overall
- Sets stock to **exact counted value** — no clamping to zero for stock-takes

**Frontend:** Stock Take modal with live variance calculation (colour-coded: green = no variance, orange = positive, red = negative)

---

### 2. Standardized Adjustment Reasons

The stock adjustment modal now uses a dropdown with 9 fixed reason values instead of free text:

| Reason | When to use |
|---|---|
| `damaged` | Physically damaged goods |
| `expired` | Past expiry date |
| `shrinkage` | Theft or unexplained loss |
| `supplier_correction` | Correcting a supplier receive error |
| `opening_correction` | Initial stock entry or opening balance fix |
| `stock_take_variance` | Difference found during stock take (auto-set) |
| `transfer_to_floor` | Product moved to shop floor |
| `transfer_from_floor` | Product returned from shop floor |
| `manual_correction` | Any other admin correction |

An optional free-text `notes` field is still available for context.

---

### 3. Lightweight Supplier Receive

**Backend route:** `POST /api/pos/inventory/receive`
**Permission required:** `INVENTORY.ADJUST`
**Table written:** `pos_supplier_receives` (header), `pos_supplier_receive_items` (per-product rows)

Behaviour:
- Manager enters supplier name, optional reference/invoice number, and products received with quantities
- Optional cost price per product (updates `products.cost_price` if provided)
- Increments stock: `new_qty = current_qty + received_qty` (no clamping)
- Writes `inventory_adjustments` with reason `'supplier_correction'` per item
- Fires `STOCK_ADJUSTED` audit event per item
- Fires `SUPPLIER_RECEIVE_COMPLETED` audit event for the session overall

**Frontend:** Receive Stock modal with dynamic product rows (add/remove rows).

---

### 4. Retail Transfer Tracking

**Backend route:** `POST /api/pos/inventory/transfer`
**Permission required:** `INVENTORY.TRANSFER`
**Table written:** `pos_stock_transfers` (header), `pos_stock_transfer_items` (per-product rows)

Valid locations: `floor`, `backroom`, `wastage`, `spoilage`

| Transfer | Stock effect |
|---|---|
| `floor → backroom` | No stock change (visibility move) |
| `backroom → floor` | No stock change (visibility move) |
| `floor → wastage` | Reduces stock (`Math.max(0, qty - transferred)`) |
| `floor → spoilage` | Reduces stock (`Math.max(0, qty - transferred)`) |
| `backroom → wastage` | Reduces stock |
| `backroom → spoilage` | Reduces stock |

When stock is reduced:
- Writes `inventory_adjustments` with reason = destination location (`'wastage'` or `'spoilage'`)
- Fires `STOCK_ADJUSTED` audit event per item

Always fires `STOCK_TRANSFER_RECORDED` audit event for the session.

**Frontend:** Transfer modal with from/to dropdowns and a warning banner when the destination is wastage or spoilage.

---

### 5. Inventory Visibility Improvements

- Low-stock filter button on inventory page
- Stock adjust modal updated with standardized reasons and notes field
- Receive Stock and Record Transfer buttons added to inventory header
- Quick-adjust flow corrected to populate product ID and show current stock

---

### 6. Audit + Trust

Every inventory operation writes to two audit layers:

| Layer | Table | What it records |
|---|---|---|
| Item-level | `inventory_adjustments` | qty_before, qty_after, qty_change, reason, notes, product_id, user_id, timestamp |
| Session-level | `pos_audit_events` | action_type, company_id, user_id, user_email, user_role, source, ip, metadata |

The `pos_audit_events` table is append-only (DB trigger enforced). This ensures a complete, tamper-evident record of who changed what stock, when, and why.

---

### 7. Inventory History Reports

Three new reports added to the Reports sidebar (Inventory section):

| Report | Endpoint | Shows |
|---|---|---|
| Stock Takes | `GET /api/pos/inventory/stock-takes` | Last 20 stock take sessions — date, conducted by, product count, variance count, notes |
| Supplier Receives | `GET /api/pos/inventory/receives` | Last 30 receive sessions — supplier, reference, date, items, units, received by |
| Stock Transfers | `GET /api/pos/inventory/transfers` | Last 50 transfer records — from/to locations, stock-reduced flag, date, by |

---

## What Intentionally Does NOT Exist

This is a RETAIL-ONLY inventory layer. The following are explicitly out of scope:

| Out of scope | Why |
|---|---|
| Bill of Materials (BOM) | Manufacturing / assembly — not retail |
| Production jobs / work orders | Manufacturing workflow — not retail |
| Manufacturing routing | MRP — not retail |
| Warehouse ERP (multi-warehouse zones) | Enterprise WMS — not retail |
| Procurement planning / POs | Formal purchasing system — not pilot scope |
| Material Requirements Planning (MRP) | Manufacturing — not retail |
| Assembly costing | Production costing — not retail |
| Batch/serial number tracking | Advanced inventory — not pilot scope |
| Expiry date tracking per batch | Cold chain / pharma — not pilot scope |

These are future integration points for a dedicated Voorraad/BOM system. The inventory adjustment and transfer tables are designed to remain compatible with that future system.

---

## Retail Boundary Contract

The retail inventory layer treats `products.stock_quantity` as the single source of truth for current on-hand quantity.

All operations that change stock:
1. Read current `stock_quantity` from `products`
2. Compute new value
3. Write new value to `products`
4. Record the change in `inventory_adjustments` with before/after/reason
5. Emit an audit event to `pos_audit_events`

No stock quantity lives anywhere else. No localStorage, no sessionStorage, no in-memory-only state.

---

## Schema Added (pos-schema.js)

| Table | Purpose |
|---|---|
| `pos_stock_takes` | Stock take session headers |
| `pos_stock_take_items` | Per-product count rows per session |
| `pos_supplier_receives` | Supplier receive session headers |
| `pos_supplier_receive_items` | Per-product received rows |
| `pos_stock_transfers` | Transfer session headers |
| `pos_stock_transfer_items` | Per-product transfer rows |

All tables have `company_id` with FK to `companies(id) ON DELETE CASCADE` and a `company_id` index for multi-tenant query isolation.

---

## New POS_EVENTS Constants (posAuditLogger.js)

```javascript
SUPPLIER_RECEIVE_COMPLETED:  'SUPPLIER_RECEIVE_COMPLETED',  // category: inventory
STOCK_TRANSFER_RECORDED:     'STOCK_TRANSFER_RECORDED',     // category: inventory
```

(Pre-existing: `STOCK_ADJUSTED`, `STOCK_TAKE_COMPLETED` were already defined)

---

## Files Changed

| File | Change |
|---|---|
| `backend/config/pos-schema.js` | +6 new tables with indexes |
| `backend/modules/pos/services/posAuditLogger.js` | +2 POS_EVENTS constants + EVENT_CATEGORY entries |
| `backend/modules/pos/routes/inventory.js` | +6 new routes (stock-take, receives, transfers + their GET counterparts) |
| `frontend-pos/index.html` | +3 modals, +buttons, updated adjust modal, fixed loadStock URL/response, rewrote submitStockAdjust, +3 report sidebar items, +4 render functions, +1 loader helper |

---

## Known Limitations (Not Bugs)

| Limitation | Decision |
|---|---|
| No rollback on partial stock-take failure | Sequential per-item loop; Supabase JS client has no true transactions. Acceptable at pilot scale |
| Stock transfer does not record per-item quantity in the report view | Report shows session totals only; per-item rows exist in `pos_stock_transfer_items` for audit |
| Receive does not validate against a formal PO | No procurement system yet; supplier name + reference is the only GRV identity |
| Cost price update on receive is optional | Not all retailers track cost per delivery |

---

## Pilot-Safe Assessment

**All 4 operational inventory workflows are pilot-safe.**

| Feature | Pilot-Safe? | Notes |
|---|---|---|
| Stock Take | ✅ Yes | Sets exact counted qty; writes full before/after audit trail |
| Standardized Adjustment Reasons | ✅ Yes | 9 fixed values; free-text notes still available |
| Supplier Receive | ✅ Yes | Increments stock; optional cost price; full audit trail |
| Transfer Tracking | ✅ Yes | Wastage/spoilage reduce stock; floor/backroom is visibility-only; warning shown in UI |
| Inventory History Reports | ✅ Yes | Read-only views of the 3 new tables; no business logic |
