# Codebox 05 — Procurement Architecture

## Overview

Codebox 05 implements forensic-grade purchasing and supplier procurement directly into the existing Lorenco Storehouse cloud app. All changes are built INTO the existing single-page app (`frontend-inventory/index.html`) and Express backend (`backend/modules/inventory/`).

---

## Architecture Diagram

```
frontend-inventory/index.html (SPA)
  │
  ├── tab-orders        → Full PO lifecycle (Draft → Approved → Ordered → Received → Closed)
  ├── tab-procurement   → Procurement suggestions + overdue POs
  └── Modals:
        poReceiveModal   → Line-by-line stock receipt with unit cost
        createPoModal    → Create new PO with supplier + line items
        poDetailModal    → PO detail + immutable receipt history

                ↓  apiFetch()  ↓

backend/modules/inventory/
  ├── routes/purchase-orders.js   (mounted at /api/inventory/purchase-orders)
  ├── routes/procurement.js       (mounted at /api/inventory/procurement)
  └── services/procurementService.js
                ↓
  stockMutationService.adjustStockTx()   ← ONLY stock mutation path
                ↓
  Supabase PostgreSQL
    ├── purchase_orders            (lifecycle state)
    ├── purchase_order_items       (ordered lines)
    ├── purchase_receipts          (IMMUTABLE receipt headers)
    ├── purchase_receipt_lines     (IMMUTABLE receipt lines, linked to movements)
    ├── stock_movements            (audit trail via adjustStockTx)
    └── supplier_item_history      (supplier intelligence)
```

---

## Status Lifecycle

```
draft → approved → ordered → partial_receipt → fully_received → closed
                                                              ↘ cancelled (only if no receipts)
```

| Status | Meaning |
|---|---|
| draft | Created, not yet reviewed |
| approved | Reviewed and authorised by approver |
| ordered | Sent to supplier |
| partial_receipt | Some lines received, not all |
| fully_received | All ordered quantities received |
| closed | Manually closed (post-receipt) |
| cancelled | Voided — only allowed if zero receipts exist |

---

## Key Design Decisions

### 1. `adjustStockTx()` is the only stock mutation path
Every `purchase_receipt_lines` row triggers `adjustStockTx()` with `sourceType: 'po_receive'` and `sourceId: receiptId`. No direct INSERT to `stock_levels` is ever performed.

### 2. Immutable receipt records
`purchase_receipts` and `purchase_receipt_lines` are INSERT-only tables. No UPDATE or DELETE is permitted post-receipt. This satisfies GAAP and SARS audit requirements.

### 3. Over-receive is impossible
Backend validates `qty_requested ≤ remaining_qty` per line before writing any receipt record. Exceeding the ordered quantity returns a 400 error.

### 4. Strict multi-tenant isolation
Every query includes `.eq('company_id', companyId)` from `req.companyId` (set by JWT middleware). No cross-company data leakage is possible.

### 5. No browser storage for business data
All PO, receipt, and supplier data lives in PostgreSQL. Frontend uses in-memory variables (`_suppliersCache`, `_poReceiveLinesData`, `_poLineCount`) only. No `localStorage` or `sessionStorage` write for business data.

---

## Files Modified / Created

| File | Change |
|---|---|
| `database/migrations/055_inventory_procurement.sql` | New — schema migration |
| `backend/modules/inventory/services/procurementService.js` | New — procurement intelligence |
| `backend/modules/inventory/routes/purchase-orders.js` | New — full PO lifecycle routes |
| `backend/modules/inventory/routes/procurement.js` | New — suggestions + supplier history |
| `backend/modules/inventory/index.js` | Modified — mount new routes, remove inline PO routes |
| `frontend-inventory/index.html` | Modified — full PO lifecycle UI + procurement tab |
