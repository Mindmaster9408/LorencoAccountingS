# Codebox 05 — Database Changes

## Migration File

`accounting-ecosystem/database/migrations/055_inventory_procurement.sql`

---

## New Tables

### `purchase_receipts`
Immutable receipt header. One per receive action on a PO.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| company_id | UUID NOT NULL | Multi-tenant isolation |
| po_id | BIGINT NOT NULL | FK → purchase_orders |
| receipt_date | DATE NOT NULL DEFAULT CURRENT_DATE | |
| received_by | UUID | FK → auth.users |
| notes | TEXT | |
| total_qty | NUMERIC(15,4) | Sum of received lines |
| total_value | NUMERIC(15,2) | Sum of line values |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |

**Policy:** INSERT-only. No UPDATE or DELETE permitted.

---

### `purchase_receipt_lines`
Immutable receipt line. One per item per receive action.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| receipt_id | BIGINT NOT NULL | FK → purchase_receipts |
| po_item_id | BIGINT NOT NULL | FK → purchase_order_items |
| item_id | BIGINT NOT NULL | FK → inventory_items |
| qty_received | NUMERIC(15,4) NOT NULL | CHECK > 0 |
| unit_cost | NUMERIC(15,4) | CHECK >= 0 |
| line_value | NUMERIC(15,2) | qty × unit_cost |
| movement_id | BIGINT | FK → stock_movements (traceability) |
| warehouse_id | BIGINT | FK → warehouses |
| batch_ref | TEXT | Optional batch reference |

**Policy:** INSERT-only. No UPDATE or DELETE permitted.

---

### `supplier_item_history`
Supplier intelligence table. One row per (company, supplier, item) tuple.

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| company_id | UUID NOT NULL | |
| supplier_id | BIGINT NOT NULL | FK → suppliers |
| item_id | BIGINT NOT NULL | FK → inventory_items |
| last_purchase_cost | NUMERIC(15,4) | Most recent unit cost |
| average_supplier_cost | NUMERIC(15,4) | Weighted running average |
| lead_time_days | INTEGER | |
| preferred_supplier | BOOLEAN DEFAULT FALSE | One preferred per (company, item) |
| purchase_count | INTEGER DEFAULT 0 | Number of receipt lines |
| last_po_id | BIGINT | Most recent PO |
| last_receipt_date | DATE | |
| UNIQUE | (company_id, supplier_id, item_id) | |

---

## Extended Columns

### `purchase_orders` — new columns

| Column | Type |
|---|---|
| po_id | BIGINT (backfilled from purchase_order_id) |
| approved_by | UUID |
| approved_at | TIMESTAMPTZ |
| closed_at | TIMESTAMPTZ |
| currency_code | CHAR(3) DEFAULT 'ZAR' |
| subtotal | NUMERIC(15,2) |
| tax_amount | NUMERIC(15,2) DEFAULT 0 |
| supplier_ref | TEXT |

**Status CHECK updated to:** `draft / approved / ordered / partial_receipt / fully_received / closed / cancelled`

---

### `purchase_order_items` — new columns

| Column | Type |
|---|---|
| po_id | BIGINT (backfilled from purchase_order_id) |
| supplier_sku | TEXT |
| expected_date | DATE |
| notes | TEXT |
| line_total_calc | NUMERIC(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED |

---

### `suppliers` — new columns

| Column | Type |
|---|---|
| supplier_code | TEXT |
| vat_number | TEXT |
| lead_time_days | INTEGER |
| payment_terms | TEXT |
| currency_code | CHAR(3) DEFAULT 'ZAR' |

---

## Indexes Created

```sql
CREATE INDEX IF NOT EXISTS idx_purchase_orders_company_status ON purchase_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_expected ON purchase_orders(expected_date) WHERE status NOT IN ('cancelled','closed','fully_received');
CREATE INDEX IF NOT EXISTS idx_purchase_receipt_lines_receipt ON purchase_receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receipt_lines_movement ON purchase_receipt_lines(movement_id);
CREATE INDEX IF NOT EXISTS idx_supplier_item_history_item ON supplier_item_history(company_id, item_id);
```

---

## Sequence

```sql
CREATE SEQUENCE IF NOT EXISTS po_number_seq START 1;
```

Used to generate PO numbers in format `LPO-YYYY-NNNN`.
