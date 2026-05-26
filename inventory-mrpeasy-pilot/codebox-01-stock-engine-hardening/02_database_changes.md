# Codebox 01 — Database Changes
**Migration:** `050_inventory_stock_engine_hardening.sql`  
**Date:** May 2026  

---

## 1. What Changed

### Function: `adjust_inventory_stock()` — corrected column names

**Problem:** The `INSERT INTO stock_movements` block in both migration 016 and migration 041 used wrong column names. The function would fail with a PostgreSQL "column not found" error on every call.

| Column reference in RPC | Actual column in table | Status |
|------------------------|----------------------|--------|
| `type` | `movement_type` | Fixed in 050 |
| `cost_price` | `unit_cost` | Fixed in 050 |

**Method:** `CREATE OR REPLACE FUNCTION` — replaces the broken function body without data loss. All other logic is identical to migration 041.

### Constraint: `chk_current_stock_non_negative` — validated

Added as `NOT VALID` in migration 016. Migration 050 calls `VALIDATE CONSTRAINT` to enforce it against all existing rows.

**Pre-condition:** All `inventory_items.current_stock` values must be `>= 0`. The migration fails loudly if any row violates this, which is the correct behaviour.

### Index: `idx_sm_company_item_created` — new

```sql
CREATE INDEX IF NOT EXISTS idx_sm_company_item_created
  ON stock_movements(company_id, item_id, created_at DESC);
```

The movement history endpoint queries `stock_movements` by `(company_id, item_id)` ordered by `created_at DESC`. This index prevents full table scans as data grows.

---

## 2. What Is NOT Changed

The following objects from migration 041 are untouched — no schema changes:

| Object | Status |
|--------|--------|
| `stock_valuation_movements` table | Unchanged |
| `inventory_cost_layers` table | Unchanged |
| `work_order_costs` table | Unchanged |
| `item_cost_history` table | Unchanged |
| `inventory_items` costing columns | Unchanged |
| All indexes from migrations 016 and 041 | Unchanged |
| All POS RPCs | Unchanged |

---

## 3. How to Apply

1. Open Supabase dashboard → SQL Editor
2. Run the diagnostic pre-check first:
   ```sql
   SELECT id, name, current_stock
   FROM inventory_items
   WHERE current_stock < 0;
   ```
   If any rows are returned: correct them before proceeding.

3. Paste and run `050_inventory_stock_engine_hardening.sql`

4. Run the verification queries at the bottom of the migration file.

---

## 4. Rollback

If the migration needs to be reversed (e.g., the constraint validation fails):

```sql
-- Re-deploy the broken version from migration 041 (DO NOT do this in production)
-- The broken function will be restored on next deploy from migration history.
-- To temporarily unblock: mark constraint back to NOT VALID (no data loss):
ALTER TABLE inventory_items
  DROP CONSTRAINT chk_current_stock_non_negative;
ALTER TABLE inventory_items
  ADD CONSTRAINT chk_current_stock_non_negative
  CHECK (current_stock >= 0) NOT VALID;
```

In practice, if the constraint validation fails it means there is a data integrity problem that must be fixed — not bypassed.
