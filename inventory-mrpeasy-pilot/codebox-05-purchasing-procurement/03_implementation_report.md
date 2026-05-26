# Codebox 05 — Implementation Report

## Summary

Forensic-grade purchasing and supplier procurement built into Lorenco Storehouse. All code lives inside the existing app — no new service, no new localhost port.

**Session dates:** April–May 2026 (multi-session)  
**Status:** COMPLETE — frontend, backend, database, documentation

---

## What Was Built

### Backend

#### `routes/purchase-orders.js` (new)
Full PO lifecycle route handler mounted at `/api/inventory/purchase-orders`.

| Route | Purpose |
|---|---|
| GET / | List all POs with supplier, overdue flag, receipt summary |
| GET /:id | Full PO detail with lines + receipt history |
| POST / | Create PO — generates `LPO-YYYY-NNNN` number via sequence |
| PUT /:id | Update PO (blocked unless status = 'draft') |
| POST /:id/approve | draft → approved |
| POST /:id/mark-ordered | approved → ordered |
| POST /:id/receive | Forensic receive — validates, writes immutable receipt, calls adjustStockTx per line |
| POST /:id/close | fully_received → closed |
| POST /:id/cancel | Cancels PO if no receipts exist |
| GET /:id/receipts | Immutable receipt history with nested lines |

#### `routes/procurement.js` (new)
Procurement intelligence mounted at `/api/inventory/procurement`.

| Route | Purpose |
|---|---|
| GET /suggestions | Merged reorder + shortage recommendations |
| GET /supplier-history | Supplier item history with filters |
| POST /supplier-history/:id/set-preferred | Set preferred supplier for an item |
| GET /overdue-pos | POs past expected date and still open |

#### `services/procurementService.js` (new)
- `generateReorderRecommendations()` — items at/below min_stock; subtracts open reservations + open PO quantities before triggering
- `generateShortageRecommendations()` — open work order materials with stock shortfall
- `getPreferredSupplier()` — preferred_supplier flag → lowest last_purchase_cost → most recent
- `updateSupplierItemHistory()` — upsert with running weighted average cost

#### `index.js` (modified)
- Removed all inline PO routes (was causing route conflict)
- Added `router.use('/purchase-orders', purchaseOrderRoutes)`
- Added `router.use('/procurement', procurementRoutes)`
- Updated demo-dashboard PO status filter to new status set

---

### Database

Migration `055_inventory_procurement.sql`:
- New tables: `purchase_receipts`, `purchase_receipt_lines`, `supplier_item_history`
- Extended: `purchase_orders`, `purchase_order_items`, `suppliers`
- New status CHECK: `draft/approved/ordered/partial_receipt/fully_received/closed/cancelled`
- Sequence `po_number_seq` for `LPO-YYYY-NNNN` auto-numbering
- Performance indexes

---

### Frontend (`frontend-inventory/index.html`)

**Navigation:**
- Added `🧾 Procurement` nav tab

**tab-orders section (enhanced):**
- Status filter updated to full 7-status set
- `+ Create PO` button added to toolbar
- `loadOrders()` rewritten: action buttons per status, overdue badge, received% column, PO number column

**tab-procurement section (new):**
- Procurement suggestions table (shortage + reorder merged, shortage prioritised)
- Summary bar showing counts
- Overdue POs table
- "Create PO from suggestion" action (pre-fills createPoModal)

**New modals:**
- `createPoModal` — supplier dropdown, expected date, line items with qty + unit price, running total
- `poDetailModal` — PO summary grid + order lines + full receipt history

**New JS functions (17 total):**
`approvePO`, `markOrdered`, `closePO`, `cancelPO`, `viewPoDetail`, `_buildReceiptHistoryHtml`, `openCreatePoModal`, `addPoLine`, `removePoLine`, `recalcPoTotal`, `submitCreatePo`, `loadProcurementSuggestions`, `createPOFromSuggestion`, `loadOverduePOs`

**Receive modal enhanced:**
- Added unit_cost input per line
- `submitPoReceive()` now passes `unit_cost` per line to backend

---

## Key Safety Guarantees

| Rule | Implementation |
|---|---|
| Over-receive impossible | Backend validates `requested ≤ remaining` per line |
| Receipts immutable | INSERT-only pattern, no UPDATE/DELETE on receipt tables |
| All stock changes traced | `adjustStockTx()` called per line, `movement_id` stored on receipt line |
| Multi-tenant isolation | Every query: `.eq('company_id', req.companyId)` |
| No browser storage for business data | No localStorage/sessionStorage write for any PO/receipt/supplier data |
| Audit trail | `auditFromReq()` called on all mutations |
| Status transitions controlled | `STATUS_TRANSITIONS` map + `canTransition()` helper in routes |
