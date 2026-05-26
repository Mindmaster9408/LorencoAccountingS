# Codebox 02 — Database Changes

**Migration:** `051_inventory_costing_finalization.sql`  
**Date:** May 2026  
**Status:** Written, not yet applied to production

---

## Pre-Requisite

Migration 050 (`050_inventory_stock_engine_hardening.sql`) must be applied first.

---

## Step-by-Step Changes

### Step 1 — Expand costing_method Constraint

**Table:** `inventory_items`

**Problem:** Migration 014 created `costing_method` with CHECK `('average', 'fifo', 'standard')`. The value `'last_cost'` was missing, preventing items from being configured for last-purchase-cost valuation.

**Method:**
1. Find the auto-named CHECK constraint via `pg_constraint` (name is system-generated)
2. Drop it
3. Re-add with the expanded set

**New constraint name:** `inventory_items_costing_method_check`  
**New valid values:** `('average', 'fifo', 'standard', 'last_cost')`

---

### Step 2 — Non-Negative Cost Constraints

**Table:** `inventory_items`

**Added (all NOT VALID — do not scan existing rows):**
- `chk_average_cost_non_negative` — `average_cost IS NULL OR average_cost >= 0`
- `chk_last_purchase_cost_non_negative` — `last_purchase_cost IS NULL OR last_purchase_cost >= 0`
- `chk_standard_cost_non_negative` — `standard_cost IS NULL OR standard_cost >= 0`

**NOT VALID rationale:** Using NOT VALID avoids a full table scan during migration, preventing lock time on an active table. Validate separately in a maintenance window after confirming no existing negative values.

**Pre-validation check:**
```sql
SELECT id, name, average_cost, last_purchase_cost, standard_cost
FROM inventory_items
WHERE average_cost < 0 OR last_purchase_cost < 0 OR standard_cost < 0;
-- Must return 0 rows before running VALIDATE CONSTRAINT.
```

---

### Step 3 — Add Previous-State Columns to Valuation Ledger

**Table:** `stock_valuation_movements`

**Added:**
- `previous_average_cost NUMERIC` — average_cost BEFORE this movement
- `previous_stock NUMERIC` — current_stock BEFORE this movement

**Existing rows:** NULL in both columns (movements recorded before Codebox 02).  
**New rows (from Step 4 onwards):** Populated by the updated RPC.

**Before Codebox 02:**  
To reconstruct the before-state, you had to read the prior row ordered by `created_at`. This was fragile for concurrent environments.

**After Codebox 02:**  
Each row is self-describing. `previous_average_cost → running_avg_cost` shows the full before/after cost state on a single row.

---

### Step 4 — Update adjust_inventory_stock() RPC

**Function:** `adjust_inventory_stock` (PostgreSQL, LANGUAGE plpgsql)  
**Change type:** `CREATE OR REPLACE` — no data loss

**Single change from migration 050 version:**  
The `INSERT INTO stock_valuation_movements` now includes:
```sql
previous_average_cost = v_old_avg,
previous_stock        = v_old_stock,
```

Both values are already available in the function from the opening `SELECT ... FOR UPDATE`. No additional query is needed.

**All other logic is identical to migration 050:** weighted average formula, stock guard, stock_movements insert, FIFO layer insert, item_cost_history insert.

---

### Step 5 — issue_unit_cost on work_order_materials

**Table:** `work_order_materials`  
**Column:** `issue_unit_cost NUMERIC` (nullable)

**Purpose:** Records the item's cost per unit AT THE EXACT MOMENT materials are issued to a work order.

**Null semantics:**  
- `NULL` = material was issued before Codebox 02 was deployed, no frozen cost available
- `0` = zero-cost item explicitly
- `> 0` = cost frozen at issue time

**Populated by:** `POST /work-orders/:id/issue-materials` (Codebox 02 update to work-orders.js)

**Why this matters:**  
If an item's `average_cost` changes between issue and WO completion, the WO cost summary endpoint would show wrong per-component costs if re-reading current price. `issue_unit_cost` makes the per-component breakdown forensically accurate even months later.

---

### Step 6 — Accounting Prep Fields on inventory_items

**Table:** `inventory_items`  
**Columns (all nullable INTEGER, no FK constraint yet):**
- `inventory_asset_account_id`
- `cogs_account_id`
- `wip_account_id`

**Status:** Reserved for future accounting integration (Codebox accounting prep).  
**No GL posting logic exists in Codebox 02.** These fields accept assignments but are not yet read by any route.

---

### Step 7 — Performance Indexes

| Index Name | Table | Columns | Purpose |
|---|---|---|---|
| `idx_ii_company_costing_method` | `inventory_items` | `company_id, costing_method` | Filter items by costing method per company |
| `idx_ii_company_active_avg_cost` | `inventory_items` | `company_id, average_cost` WHERE `is_active=TRUE` | Stock valuation report hot path |
| `idx_woc_company_wo` | `work_order_costs` | `company_id, work_order_id` | WO cost lookup |
| `idx_ich_company_item_date` | `item_cost_history` | `company_id, item_id, changed_at DESC` | Cost audit trail per item |
| `idx_wom_work_order_id` | `work_order_materials` | `work_order_id` | Materials list per WO |

---

## Rollback Plan

This migration is additive only:
- All ADD COLUMN statements use IF NOT EXISTS
- All ADD CONSTRAINT statements use NOT VALID (no data modification)
- The RPC update is CREATE OR REPLACE (reverts to prior version if needed)

To roll back:
```sql
-- Remove new columns
ALTER TABLE stock_valuation_movements DROP COLUMN IF EXISTS previous_average_cost;
ALTER TABLE stock_valuation_movements DROP COLUMN IF EXISTS previous_stock;
ALTER TABLE work_order_materials DROP COLUMN IF EXISTS issue_unit_cost;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS inventory_asset_account_id;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS cogs_account_id;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS wip_account_id;

-- Restore costing_method constraint (drop new, add old)
ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_costing_method_check;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_costing_method_check
  CHECK (costing_method IN ('average', 'fifo', 'standard'));

-- Drop new cost constraints
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS chk_average_cost_non_negative;
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS chk_last_purchase_cost_non_negative;
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS chk_standard_cost_non_negative;

-- Replace RPC with migration 050 version
```

---

## Verification Checklist

After applying migration 051, run these verification queries:

```sql
-- 1. Expanded costing_method constraint
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'inventory_items'::regclass
  AND conname = 'inventory_items_costing_method_check';
-- Should include 'last_cost'

-- 2. Three cost non-negative constraints exist
SELECT conname FROM pg_constraint
WHERE conrelid = 'inventory_items'::regclass
  AND conname IN (
    'chk_average_cost_non_negative',
    'chk_last_purchase_cost_non_negative',
    'chk_standard_cost_non_negative'
  );
-- Should return 3 rows

-- 3. New valuation ledger columns
SELECT column_name FROM information_schema.columns
WHERE table_name = 'stock_valuation_movements'
  AND column_name IN ('previous_average_cost', 'previous_stock');
-- Should return 2 rows

-- 4. issue_unit_cost column on work_order_materials
SELECT column_name FROM information_schema.columns
WHERE table_name = 'work_order_materials'
  AND column_name = 'issue_unit_cost';
-- Should return 1 row

-- 5. Accounting prep columns on inventory_items
SELECT column_name FROM information_schema.columns
WHERE table_name = 'inventory_items'
  AND column_name IN ('inventory_asset_account_id', 'cogs_account_id', 'wip_account_id');
-- Should return 3 rows

-- 6. All 5 new indexes
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'idx_ii_company_costing_method',
  'idx_ii_company_active_avg_cost',
  'idx_woc_company_wo',
  'idx_ich_company_item_date',
  'idx_wom_work_order_id'
);
-- Should return 5 rows
```
