# Suppliers / Accounts Payable Module — Architecture Reference

> Last updated: March 2026
> Status: Implemented (full CRUD + VAT inclusive/exclusive + aging)

---

## Overview

The Suppliers module covers the full Accounts Payable (AP) workflow for South African companies:

- **Supplier master** — create, edit, deactivate suppliers with bank details and default accounts
- **Supplier Invoices** — record supplier invoices with line items, supporting EX VAT and INC VAT entry modes
- **Purchase Orders** — draft → approved → sent → received workflow with line items
- **Supplier Payments** — record payments with optional invoice allocation (updates `amount_paid` and status)
- **Supplier Aging Report** — real-time bucketed overdue report (Current / 30 / 60 / 90 / 90+ days)
- **Dashboard Stats** — total payable, overdue, active supplier count, month payments

All data is fully company-scoped — no data bleeds between companies.

---

## Database Schema

### `suppliers`

| Column               | Type         | Notes                                              |
|---|---|---|
| id                   | SERIAL PK    |                                                    |
| company_id           | FK           | → companies.id — all queries scope to this         |
| code                 | VARCHAR(20)  | Auto-generated (SUP001, SUP002, …) if not provided |
| name                 | VARCHAR(255) | Required                                           |
| type                 | VARCHAR(20)  | `company` or `individual`                          |
| contact_name         | VARCHAR(255) |                                                    |
| email                | VARCHAR(255) |                                                    |
| phone                | VARCHAR(50)  |                                                    |
| vat_number           | VARCHAR(50)  | Supplier's VAT registration number                 |
| registration_number  | VARCHAR(50)  | Company registration (for companies)               |
| address / city / postal_code | TEXT/VARCHAR |                                         |
| payment_terms        | INTEGER      | Net days (0 = due on receipt, default 30)          |
| default_account_id   | FK           | → accounts.id — default expense account            |
| bank_name / bank_account_number / bank_branch_code | VARCHAR | For EFT payments |
| notes                | TEXT         |                                                    |
| is_active            | BOOLEAN      | Soft-delete / deactivation (default true)          |
| created_at / updated_at | TIMESTAMPTZ |                                               |

### `supplier_invoices`

| Column          | Type         | Notes                                              |
|---|---|---|
| id              | SERIAL PK    |                                                    |
| company_id      | FK           |                                                    |
| supplier_id     | FK           | → suppliers.id                                     |
| invoice_number  | VARCHAR(100) | Supplier's own invoice number (optional)           |
| reference       | VARCHAR(255) | Internal reference or PO number                    |
| invoice_date    | DATE         | Required                                           |
| due_date        | DATE         |                                                    |
| vat_inclusive   | BOOLEAN      | EX VAT (false) or INC VAT (true) — sets VAT mode  |
| subtotal_ex_vat | NUMERIC(12,2)|                                                    |
| vat_amount      | NUMERIC(12,2)|                                                    |
| total_inc_vat   | NUMERIC(12,2)|                                                    |
| amount_paid     | NUMERIC(12,2)| Updated when payments are allocated                |
| status          | VARCHAR(20)  | `unpaid` / `part_paid` / `paid` / `cancelled`     |
| notes           | TEXT         |                                                    |
| created_by_user_id | INTEGER   |                                                    |

### `supplier_invoice_lines`

| Column              | Type         | Notes                    |
|---|---|---|
| id                  | SERIAL PK    |                          |
| invoice_id          | FK           | → supplier_invoices.id   |
| description         | TEXT         |                          |
| account_id          | FK           | → accounts.id (nullable) |
| quantity            | NUMERIC(10,4)|                          |
| unit_price          | NUMERIC(12,4)|                          |
| line_subtotal_ex_vat| NUMERIC(12,2)|                          |
| vat_rate            | NUMERIC(5,2) | % (e.g. 15.00)           |
| vat_amount          | NUMERIC(12,2)|                          |
| line_total_inc_vat  | NUMERIC(12,2)|                          |
| sort_order          | INTEGER      |                          |

### `purchase_orders`

| Column         | Type         | Notes                                             |
|---|---|---|
| id             | SERIAL PK    |                                                   |
| company_id     | FK           |                                                   |
| supplier_id    | FK           | Optional — POs can be internal                    |
| po_number      | VARCHAR(50)  | Auto-generated `PO-YYYY-NNNN` if not provided     |
| po_date        | DATE         | Required                                          |
| expected_date  | DATE         | Expected delivery date                            |
| vat_inclusive  | BOOLEAN      |                                                   |
| subtotal_ex_vat / vat_amount / total_inc_vat | NUMERIC(12,2) |                  |
| status         | VARCHAR(20)  | `draft` → `approved` → `sent` → `received` / `cancelled` |
| notes          | TEXT         |                                                   |
| created_by_user_id | INTEGER  |                                                   |

### `purchase_order_lines`

| Column              | Type         | Notes          |
|---|---|---|
| id                  | SERIAL PK    |                |
| po_id               | FK           |                |
| description         | TEXT         |                |
| quantity            | NUMERIC(10,4)|                |
| unit_price          | NUMERIC(12,4)|                |
| line_subtotal_ex_vat| NUMERIC(12,2)|                |
| vat_rate            | NUMERIC(5,2) |                |
| vat_amount          | NUMERIC(12,2)|                |
| line_total_inc_vat  | NUMERIC(12,2)|                |
| sort_order          | INTEGER      |                |

### `supplier_payments`

| Column         | Type         | Notes                                              |
|---|---|---|
| id             | SERIAL PK    |                                                    |
| company_id     | FK           |                                                    |
| supplier_id    | FK           |                                                    |
| payment_date   | DATE         | Required                                           |
| payment_method | VARCHAR(50)  | `bank_transfer` / `cash` / `cheque` / `credit_card`|
| reference      | VARCHAR(255) | Bank reference or cheque number                    |
| amount         | NUMERIC(12,2)| Required, > 0                                      |
| notes          | TEXT         |                                                    |
| created_by_user_id | INTEGER  |                                                    |
| created_at     | TIMESTAMPTZ  |                                                    |

### `supplier_payment_allocations`

| Column     | Type         | Notes                                          |
|---|---|---|
| id         | SERIAL PK    |                                                |
| payment_id | FK           | → supplier_payments.id                         |
| invoice_id | FK           | → supplier_invoices.id                         |
| amount     | NUMERIC(12,2)|                                                |
| created_at | TIMESTAMPTZ  |                                                |

When a payment allocation is inserted, the route also runs:
```sql
UPDATE supplier_invoices
   SET amount_paid = amount_paid + $1,
       status = CASE
         WHEN amount_paid + $1 >= total_inc_vat THEN 'paid'
         WHEN amount_paid + $1 > 0 THEN 'part_paid'
         ELSE status END
 WHERE id = $2 AND company_id = $3
```

---

## VAT Logic

### `calcLineVAT(quantity, unitPrice, vatRate, vatInclusive)`

Located in `backend/modules/accounting/routes/suppliers.js` (top of file).

| Mode | `vatInclusive` | Behaviour |
|---|---|---|
| EX VAT | `false` | Entered price is base. VAT = `entered × rate/100`. Total = `entered + VAT`. |
| INC VAT | `true`  | Entered price includes VAT. Subtotal = `entered / (1 + rate/100)`. VAT = `Total - Subtotal`. |

**Important:** `vatRate` uses `|| 15` as a falsy fallback — passing `0` will default to 15%. For explicitly 0% lines, this is a known limitation.

Returns: `{ subtotalExVat, vatAmount, totalIncVat }` — all rounded to 2dp.

The frontend `calcLineVAT()` in `suppliers.html` mirrors this logic exactly for live calculation in the invoice/PO modals.

---

## API Endpoints

All mounted at `/api/accounting/suppliers`.

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Dashboard stats: totalPayable, overdue, overdueCount, totalSuppliers, monthPayments |
| GET | `/` | List suppliers (`?search=&status=active/inactive`) |
| POST | `/` | Create supplier |
| GET | `/:id` | Get single supplier with balance_owing |
| PUT | `/:id` | Update supplier (name, contact, bank details, isActive, etc.) |
| GET | `/invoices` | List invoices (`?supplierId=&status=&fromDate=&toDate=`) |
| POST | `/invoices` | Create invoice with lines (VAT calculated server-side) |
| GET | `/invoices/:id` | Get invoice with lines |
| PUT | `/invoices/:id` | Update invoice (not allowed if `status = 'paid'`) |
| GET | `/orders` | List purchase orders (`?supplierId=&status=`) |
| POST | `/orders` | Create purchase order with lines |
| GET | `/orders/:id` | Get PO with lines |
| PUT | `/orders/:id/status` | Update PO status (draft/approved/sent/received/cancelled) |
| GET | `/payments` | List payments (`?supplierId=&fromDate=&toDate=`) |
| POST | `/payments` | Record payment (with optional invoice allocations) |
| GET | `/aging` | Supplier aging report (bucketed by days overdue from due_date) |

### Invoice POST body

```json
{
  "supplierId": 1,
  "invoiceNumber": "SINV-0012",
  "reference": "PO-2026-0001",
  "invoiceDate": "2026-01-15",
  "dueDate": "2026-02-14",
  "vatInclusive": false,
  "lines": [
    { "description": "Office Supplies", "accountId": 123, "quantity": 1, "unitPrice": 500, "vatRate": 15 },
    { "description": "Delivery", "accountId": 124, "quantity": 1, "unitPrice": 100, "vatRate": 15 }
  ],
  "notes": "Optional"
}
```

### Payment POST body

```json
{
  "supplierId": 1,
  "paymentDate": "2026-01-20",
  "paymentMethod": "bank_transfer",
  "reference": "FNB-2026011234",
  "amount": 690,
  "notes": null,
  "allocations": [
    { "invoiceId": 10, "amount": 690 }
  ]
}
```

---

## Frontend — suppliers.html

Located at `frontend-accounting/suppliers.html`.

### Tabs

| Tab | Content | Data Source |
|---|---|---|
| Supplier List | Searchable/filterable table | `GET /api/accounting/suppliers` |
| Supplier Invoices | All invoices with Pay shortcut | `GET /api/accounting/suppliers/invoices` |
| Purchase Orders | POs with status workflow buttons | `GET /api/accounting/suppliers/orders` |
| Payments | Payment history | `GET /api/accounting/suppliers/payments` |
| Aging Report | Color-coded aging buckets | `GET /api/accounting/suppliers/aging` |

### New Invoice Modal

- Supplier dropdown (active suppliers only)
- Invoice number, reference, invoice date, due date
- **VAT Mode toggle**: EX VAT / INC VAT — live recalculation of all lines as mode changes
- Line items: description, account, qty, unit price, VAT %, line total (live-calculated)
- Invoice totals: subtotal ex VAT, VAT amount, total inc VAT
- Notes

### New PO Modal

Same structure as invoice — supplier (optional), PO number (auto-generated if blank), PO/delivery dates, VAT mode, line items with live totals.

### New Payment Modal

- Supplier dropdown (on change: loads unpaid/part-paid invoices for that supplier)
- Payment date, amount, method, reference
- Optional invoice allocation — pre-fills balance amount when selected
- Notes

### Auth Pattern

Uses `localStorage.getItem('token')` (not `eco_token`) — same as all accounting module pages.

---

## Aging Report Logic

The aging query calculates `(CURRENT_DATE - due_date::date) AS days_overdue` for all unpaid/part-paid invoices.

Buckets:

| Bucket   | days_overdue |
|---|---|
| Current  | ≤ 0 (due today or future) |
| 30 Days  | 1–30 |
| 60 Days  | 31–60 |
| 90 Days  | 61–90 |
| 90+ Days | > 90 |

Results are grouped by supplier and summed per bucket. The frontend colors each column (green → yellow → orange → red → dark red).

---

## Company Isolation

Every query in suppliers.js includes `company_id = req.companyId` from the ECO auth middleware. There is no way to access another company's suppliers, invoices, POs, or payments. The supplier ownership check before creating invoices or payments is:

```sql
SELECT id FROM suppliers WHERE id = $1 AND company_id = $2
```

---

## Navigation

All supplier menu items in the top nav (`navigation.js`) link to `suppliers.html` with query params:

| Nav Item | URL |
|---|---|
| Supplier List | `/accounting/suppliers.html` |
| New Supplier | `/accounting/suppliers.html?new=supplier` |
| Purchase Orders | `/accounting/suppliers.html?tab=orders` |
| Supplier Invoices | `/accounting/suppliers.html?tab=invoices` |
| Supplier Payments | `/accounting/suppliers.html?tab=payments` |
| Supplier Aging | `/accounting/suppliers.html?tab=aging` |

---

## Tests

`backend/tests/suppliers.test.js` — 30 tests covering:

- `calcLineVAT` EX VAT: unit price × qty, multi-line, rounding, non-standard rates
- `calcLineVAT` INC VAT: extraction, EX/INC parity, subtotal + vat = total
- Company isolation: SQL scoping rules verified for all table queries
- Invoice aggregation: multi-line totals
- Aging buckets: all 5 bucket boundaries verified
- Supplier INSERT: company_id parameter position, auto-code generation
- Payment validation: amount > 0, allocation insert
- PO status: allowed statuses, workflow order, invalid status rejection

---

## Known Limitations / Future Work

- **0% VAT**: The `calcLineVAT` helper uses `|| 15` fallback, so passing `vatRate = 0` defaults to 15%. Explicitly zero-rated lines require a fix to use `vatRate != null ? vatRate : 15` pattern in the helper (currently only applied at the route level before calling the helper).
- **Invoice editing**: PUT `/invoices/:id` is implemented but not exposed in the frontend UI yet.
- **PO → Invoice conversion**: Not yet implemented. Future work: "Convert PO to Invoice" button on a received PO.
- **Supplier statement**: No PDF statement generation yet.
- **Debit notes**: Credit notes / debit notes against supplier invoices not yet implemented.
- **Bulk payments**: Payment modal handles one invoice allocation at a time. Future: multi-invoice allocation in one payment.
