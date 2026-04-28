# Lorenco Storehouse — Database Structure
**Date:** April 24, 2026
**Source:** `accounting-ecosystem/database/schema.sql`, `database/migrations/014_inventory_manufacturing.sql`, backend code analysis

---

## Table Inventory

| Table | Defined In | Status |
|---|---|---|
| `inventory_items` | schema.sql + migration 014 | ACTIVE |
| `warehouses` | schema.sql + migration 014 | ACTIVE |
| `stock_movements` | schema.sql | ACTIVE |
| `suppliers` | schema.sql (POS section) | ⚠️ SCHEMA MISMATCH (see note below) |
| `purchase_orders` | schema.sql | ACTIVE |
| `purchase_order_items` | schema.sql | ACTIVE |
| `bom_headers` | migration 014 | ACTIVE |
| `bom_lines` | migration 014 | ACTIVE |
| `work_orders` | migration 014 | ACTIVE |
| `work_order_materials` | migration 014 | ACTIVE |

**Missing tables (required for complete system):**
- `lot_numbers` / `batch_records` — needed for lot/batch tracking
- `serial_numbers` — needed for serial tracking
- `stock_per_location` — needed for multi-location stock levels
- `cost_layers` / `inventory_lots` — needed for FIFO costing
- `goods_receipt_notes` (GRN) — needed for PO receiving flow
- `inventory_categories` — currently derived dynamically (no FK integrity)
- `warehouse_bins` / `rack_slots` — needed for bin-level location tracking

---

## Table: `inventory_items`

**Description:** Master item catalog. Holds all product/stock item definitions.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | Auto-increment |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) CASCADE | Multi-tenant isolation key |
| `name` | VARCHAR | NOT NULL | Item display name |
| `sku` | VARCHAR | | Stock keeping unit (unique per company, not enforced at DB level?) |
| `description` | TEXT | | Long description |
| `category` | VARCHAR | | Free-text category — not FK to categories table (no categories table exists) |
| `unit` | VARCHAR | DEFAULT 'unit' | Unit of measure (each, kg, litre, etc.) |
| `cost_price` | NUMERIC | | Purchase cost per unit |
| `sell_price` | NUMERIC | | Selling price per unit |
| `current_stock` | NUMERIC | DEFAULT 0 | ⚠️ Mutable counter — updated by movements and WO endpoints. No `CHECK (current_stock >= 0)` constraint. |
| `min_stock` | NUMERIC | | Added by migration 014 — reorder trigger level |
| `warehouse_id` | INTEGER | FK → warehouses(id) | ⚠️ SINGLE FK — item can only be in ONE location. No multi-location support. |
| `is_active` | BOOLEAN | DEFAULT true | Soft-delete flag |
| `item_type` | VARCHAR(30) | CHECK IN ('raw_material', 'finished_good', 'sub_assembly', 'consumable', 'service') | Added migration 014 |
| `barcode` | VARCHAR(100) | | Added migration 014 — stored but no scanning integration |
| `track_lots` | BOOLEAN | DEFAULT false | Added migration 014 — FLAG ONLY, no lot tracking logic implemented |
| `track_serials` | BOOLEAN | DEFAULT false | Added migration 014 — FLAG ONLY, no serial tracking logic implemented |
| `costing_method` | VARCHAR(20) | CHECK IN ('average', 'fifo', 'standard') | Added migration 014 — FLAG ONLY, no costing engine implemented |
| `lead_time_days` | INTEGER | | Added migration 014 — days from order to delivery |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes:** None documented in audit scope (may exist in Supabase natively for PK/FK)

**Risks:**
- No `CHECK (current_stock >= 0)` — stock can go negative silently
- `category` is free-text — no referential integrity to a categories table
- `warehouse_id` is a single FK — cannot model item stored across multiple locations
- `track_lots`, `track_serials`, `costing_method` are data fields with no supporting tables or logic

---

## Table: `warehouses`

**Description:** Warehouse and location master.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Multi-tenant key |
| `name` | VARCHAR | NOT NULL | Location display name |
| `address` | TEXT | | Physical address |
| `notes` | TEXT | | Free text notes |
| `is_active` | BOOLEAN | DEFAULT true | Soft-delete |
| `location_type` | VARCHAR(20) | CHECK IN ('warehouse', 'store', 'wip', 'quarantine', 'dispatch') | Added migration 014 |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Risks:**
- No `bin`, `rack`, or `zone` fields — no bin-level tracking
- No bin-to-bin transfers supported
- No area/zone hierarchy

---

## Table: `stock_movements`

**Description:** Immutable ledger of all stock changes. Every stock update must create a record here.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Multi-tenant key |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | Which item moved |
| `warehouse_id` | INTEGER | FK → warehouses(id), nullable | Location context — optional |
| `type` | VARCHAR | CHECK IN ('in', 'out', 'transfer', 'adjustment', 'return') | Movement direction/reason |
| `quantity` | NUMERIC | NOT NULL | Absolute movement quantity (backend applies sign via delta logic) |
| `reference` | VARCHAR | | Document reference (PO number, WO number, etc.) |
| `notes` | TEXT | | Free text notes |
| `cost_price` | NUMERIC | | Stored but NOT consumed by any costing engine |
| `created_by` | INTEGER | FK → users(id) | Audit user |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Risks:**
- No `to_warehouse_id` — `type='transfer'` cannot encode source and destination
- `cost_price` is stored but never used in calculations
- No `updated_at` — movements are append-only ✅ (this is correct/intended for an audit ledger)
- No DB-level protection against zero or negative `quantity`

---

## Table: `suppliers`

> **⚠️ SCHEMA MISMATCH — CRITICAL RISK**

**Description:** Supplier master. Used by inventory module for purchase orders.

### What `schema.sql` defines (POS-era table):
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `company_id` | INTEGER NOT NULL FK → companies | |
| `supplier_code` | VARCHAR(50) NOT NULL | POS-era unique identifier |
| `supplier_name` | VARCHAR(255) NOT NULL | ⚠️ Name is `supplier_name` |
| `contact_name` | VARCHAR(255) | |
| `contact_email` | VARCHAR(255) | ⚠️ Email is `contact_email` |
| `contact_phone` | VARCHAR(50) | ⚠️ Phone is `contact_phone` |
| `address` | TEXT | |
| `payment_terms` | INTEGER | |
| `tax_reference` | VARCHAR(50) | |
| `bank_name`, `bank_account`, `bank_branch_code` | VARCHAR | |
| `is_active` | BOOLEAN | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

### What `backend/modules/inventory/index.js` inserts/reads:
| Column Used in Backend | Mismatch |
|---|---|
| `name` | ❌ schema.sql has `supplier_name` |
| `email` | ❌ schema.sql has `contact_email` |
| `phone` | ❌ schema.sql has `contact_phone` |
| `contact_name` | ✅ matches |
| `vat_number` | ❌ schema.sql has `tax_reference` |
| `notes` | ❌ schema.sql has no `notes` column |
| `address` | ✅ matches |
| `is_active` | ✅ matches |

**Conclusion:** Either the live Supabase schema differs from `schema.sql` (a migration or manual alter was done), or all supplier API calls are currently broken. This must be verified and resolved before the inventory module can be considered production-ready.

---

## Table: `purchase_orders`

**Description:** Purchase order header.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | |
| `supplier_id` | INTEGER | NOT NULL, FK → suppliers(id) | |
| `status` | VARCHAR | CHECK IN ('draft', 'sent', 'received', 'cancelled') | No 'partial_receipt' or 'approved' status |
| `total_amount` | NUMERIC | | Passed by frontend — not recalculated server-side |
| `notes` | TEXT | | |
| `expected_date` | DATE | | |
| `created_by` | INTEGER | FK → users(id) | |
| `created_at`, `updated_at` | TIMESTAMPTZ | | |

**Risks:**
- No `po_number` field — no human-readable reference number (unlike WOs which have `WO-00001`)
- No `approved_by` or `approved_at` — no approval workflow
- `status='received'` can be set manually but receiving creates no stock movement
- No `partial_receipt` status — cannot model partial deliveries

---

## Table: `purchase_order_items`

**Description:** Purchase order line items.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `po_id` | INTEGER | NOT NULL, FK → purchase_orders(id) CASCADE DELETE | |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | |
| `quantity` | NUMERIC | NOT NULL | Ordered quantity |
| `unit_price` | NUMERIC | | Price at time of order |
| `received_qty` | NUMERIC | DEFAULT 0 | ⚠️ EXISTS but never updated by any backend endpoint |

**Risks:**
- `received_qty` is a dead column — no `POST /purchase-orders/:id/receive` endpoint
- No partial receipt tracking (cannot receive 50 of 100 ordered)
- Cannot update line items after PO creation (no `PUT /purchase-orders/:id/lines` endpoint)
- No line-level notes or reference fields

---

## Table: `bom_headers`

**Description:** Bill of Materials header — defines recipe for producing an item.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) CASCADE | |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | Finished item this BOM produces |
| `name` | VARCHAR | NOT NULL | BOM name (e.g., "Assembly v2") |
| `version` | INTEGER | DEFAULT 1 | Version number |
| `status` | VARCHAR | CHECK IN ('draft', 'active', 'inactive') | Only one active per item enforced in backend |
| `output_qty` | NUMERIC | DEFAULT 1 | How many units this BOM produces per run |
| `scrap_percent` | NUMERIC | DEFAULT 0 | Waste percentage applied to all components |
| `notes` | TEXT | | |
| `created_by` | INTEGER | FK → users(id) | |
| `created_at`, `updated_at` | TIMESTAMPTZ | | |

---

## Table: `bom_lines`

**Description:** Individual component rows in a BOM.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `bom_id` | INTEGER | NOT NULL, FK → bom_headers(id) CASCADE DELETE | |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | Component item |
| `quantity` | NUMERIC | NOT NULL | Quantity needed per BOM output_qty |
| `scrap_percent` | NUMERIC | DEFAULT 0 | Component-level scrap override |
| `notes` | TEXT | | |
| `sort_order` | INTEGER | DEFAULT 0 | Display ordering |

---

## Table: `work_orders`

**Description:** Production run definition — produces finished goods from a BOM.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | |
| `wo_number` | VARCHAR | UNIQUE(company_id, wo_number) | Auto-generated: WO-00001 |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | Item being produced |
| `bom_id` | INTEGER | FK → bom_headers(id) | BOM used (nullable for non-BOM WOs) |
| `quantity_to_produce` | NUMERIC | NOT NULL | Planned quantity |
| `quantity_produced` | NUMERIC | DEFAULT 0 | Actual produced (set on complete) |
| `status` | VARCHAR | CHECK IN ('draft', 'released', 'in_progress', 'completed', 'cancelled') | 5-state machine |
| `planned_start_date` | DATE | | |
| `planned_end_date` | DATE | | |
| `actual_start_date` | DATE | | Set by `POST /:id/start` |
| `actual_end_date` | DATE | | Set by `POST /:id/complete` |
| `notes` | TEXT | | |
| `created_by` | INTEGER | FK → users(id) | |
| `created_at`, `updated_at` | TIMESTAMPTZ | | |

**Risks:**
- No `assigned_to` — cannot assign WO to a production person
- No `priority` field
- Completing a WO does not verify all materials have been issued

---

## Table: `work_order_materials`

**Description:** Materials required for a work order (auto-populated from BOM at WO creation).

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | SERIAL | PK | |
| `work_order_id` | INTEGER | NOT NULL, FK → work_orders(id) CASCADE DELETE | |
| `item_id` | INTEGER | NOT NULL, FK → inventory_items(id) | Material item |
| `required_qty` | NUMERIC | NOT NULL | Calculated from BOM line * (WO qty / BOM output_qty) * scrap |
| `issued_qty` | NUMERIC | DEFAULT 0 | Updated by `POST /:id/issue-materials` |
| `notes` | TEXT | | |

**Risks:**
- No `actual_qty_used` separate from `issued_qty` — cannot track waste vs plan
- No `lot_id` — cannot track which lot was consumed

---

## Entity Relationship Summary

```
companies
    │
    ├── inventory_items  ──────────────────────────────────────────────┐
    │       ├── stock_movements (item_id)                              │
    │       ├── purchase_order_items (item_id)                         │
    │       ├── bom_headers (item_id = finished item)                  │
    │       │       └── bom_lines (item_id = component item) ──────────┤
    │       ├── work_orders (item_id = finished item)                  │
    │       │       └── work_order_materials (item_id = material) ─────┘
    │       └── warehouse_id ──────┐
    │                              │
    ├── warehouses ─────────────────┘
    │       └── stock_movements (warehouse_id)
    │
    ├── suppliers
    │       └── purchase_orders (supplier_id)
    │               └── purchase_order_items (po_id)
    │
    └── users
            └── [created_by on all tables]
```

---

## Missing Tables Required for Complete System

| Table Name | Purpose | Priority |
|---|---|---|
| `stock_per_location` | Multi-location stock levels (item × warehouse → qty) | HIGH |
| `lot_numbers` | Batch/lot tracking records per item | HIGH |
| `serial_numbers` | Individual serial number tracking | MEDIUM |
| `cost_layers` / `inventory_lots` | FIFO cost stacks per item | HIGH |
| `goods_receipt_notes` | PO receive records (GRN) | HIGH |
| `grn_lines` | Individual GRN line items | HIGH |
| `inventory_categories` | Proper category master (vs free-text) | MEDIUM |
| `po_approvals` | PO approval workflow records | MEDIUM |
| `warehouse_bins` | Bin/rack/zone locations within warehouses | LOW |
| `stock_counts` | Physical count records | MEDIUM |
| `stock_count_lines` | Individual count line items | MEDIUM |
| `inventory_adjustments` | Formal stock adjustment records with reason codes | MEDIUM |
