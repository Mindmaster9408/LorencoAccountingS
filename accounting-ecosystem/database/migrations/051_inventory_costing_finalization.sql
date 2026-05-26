-- ============================================================================
-- Migration 051: Inventory Costing Finalization (Codebox 02)
-- Date: May 2026
-- ============================================================================
-- Purpose:
--   Codebox 01 hardened the stock mutation engine (atomic RPC, concurrency
--   safety, forensic valuation ledger). Codebox 02 finalises the costing model.
--
-- What this migration does:
--   1. Expand costing_method constraint to include 'last_cost'
--      (migration 014 constrained to 'average','fifo','standard' only)
--   2. Add non-negative CHECK constraints on average_cost, last_purchase_cost,
--      standard_cost — fail loud if application writes corrupt cost data
--   3. Add previous_average_cost + previous_stock to stock_valuation_movements
--      so each ledger row captures BEFORE and AFTER state
--   4. Update adjust_inventory_stock() RPC to populate the new columns
--   5. Add issue_unit_cost to work_order_materials — captures item's
--      average_cost at exact time of issue so WO summaries stay forensically
--      accurate even after future cost changes
--   6. Add accounting integration prep fields to inventory_items
--      (NO GL posting yet — fields reserved for future Codebox integration)
--   7. Performance indexes for costing queries
--
-- Safety:
--   All ADD COLUMN ... IF NOT EXISTS — re-run safe.
--   All ADD CONSTRAINT use NOT VALID where scanning existing rows could block.
--   CREATE OR REPLACE FUNCTION — no data loss.
-- ============================================================================


-- ─── STEP 1: Expand costing_method constraint to include 'last_cost' ─────────
--
-- Migration 014 added costing_method with CHECK ('average','fifo','standard').
-- PostgreSQL auto-names inline CHECK constraints; we find and drop it by
-- inspecting pg_constraint, then recreate with the expanded set.
--
-- 'last_cost': issue cost = last_purchase_cost for that item.
-- Required for service items and items received at varying prices where last
-- cost is the most relevant valuation basis.

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'inventory_items'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%costing_method%'
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE inventory_items DROP CONSTRAINT ' || quote_ident(v_conname);
    RAISE NOTICE 'Dropped old costing_method constraint: %', v_conname;
  ELSE
    RAISE NOTICE 'No existing costing_method constraint found — adding fresh.';
  END IF;
END $$;

ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_costing_method_check
  CHECK (costing_method IN ('average', 'fifo', 'standard', 'last_cost'));


-- ─── STEP 2: Non-negative cost constraints ────────────────────────────────────
--
-- Prevent application code from writing negative cost values to the DB.
-- Added NOT VALID to avoid scanning all existing rows during migration.
-- Run VALIDATE CONSTRAINT in a maintenance window once data is confirmed clean:
--
--   PRE-CHECK before validating:
--   SELECT id, name, average_cost, last_purchase_cost, standard_cost
--   FROM inventory_items
--   WHERE average_cost < 0
--      OR last_purchase_cost < 0
--      OR standard_cost < 0;

ALTER TABLE inventory_items
  ADD CONSTRAINT chk_average_cost_non_negative
  CHECK (average_cost IS NULL OR average_cost >= 0) NOT VALID;

ALTER TABLE inventory_items
  ADD CONSTRAINT chk_last_purchase_cost_non_negative
  CHECK (last_purchase_cost IS NULL OR last_purchase_cost >= 0) NOT VALID;

ALTER TABLE inventory_items
  ADD CONSTRAINT chk_standard_cost_non_negative
  CHECK (standard_cost IS NULL OR standard_cost >= 0) NOT VALID;


-- ─── STEP 3: Add previous-state columns to stock_valuation_movements ──────────
--
-- The ledger currently stores running_avg_cost (new avg after event) and
-- running_qty (new stock after event), but NOT the values BEFORE the event.
-- Adding previous_average_cost and previous_stock makes every ledger row
-- fully self-describing — the before/after pair is explicit on the row itself.
--
-- Existing rows will have NULL in these columns (pre-Codebox-02 movements).
-- All new movements will have them populated by the updated RPC below.

ALTER TABLE stock_valuation_movements
  ADD COLUMN IF NOT EXISTS previous_average_cost NUMERIC,  -- avg_cost BEFORE this movement
  ADD COLUMN IF NOT EXISTS previous_stock         NUMERIC;  -- current_stock BEFORE this movement


-- ─── STEP 4: Update adjust_inventory_stock() — populate previous-state fields ─
--
-- This is a CREATE OR REPLACE of the same function fixed in migration 050.
-- The only change: the INSERT into stock_valuation_movements now includes
-- previous_average_cost = v_old_avg  and  previous_stock = v_old_stock.
--
-- Both v_old_avg and v_old_stock are already computed by the SELECT FOR UPDATE
-- at the top of the function, so no additional query is needed.
--
-- Everything else (concurrency lock, weighted average formula, UPDATE inventory_items,
-- INSERT stock_movements, INSERT inventory_cost_layers, INSERT item_cost_history)
-- is carried through UNCHANGED from migration 050.

CREATE OR REPLACE FUNCTION adjust_inventory_stock(
  p_company_id    INTEGER,
  p_item_id       INTEGER,
  p_delta         NUMERIC,
  p_movement_type VARCHAR(50),
  p_warehouse_id  INTEGER      DEFAULT NULL,
  p_reference     VARCHAR(255) DEFAULT NULL,
  p_notes         TEXT         DEFAULT NULL,
  p_cost_price    NUMERIC      DEFAULT NULL,
  p_created_by    INTEGER      DEFAULT NULL,
  p_source_type   VARCHAR(50)  DEFAULT NULL,
  p_source_id     VARCHAR(255) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_stock   NUMERIC;
  v_old_avg     NUMERIC;
  v_new_stock   NUMERIC;
  v_new_avg     NUMERIC;
  v_movement_id BIGINT;
BEGIN
  -- Lock the item row for the duration of this transaction.
  -- Prevents concurrent receives from computing stale weighted averages.
  SELECT current_stock, COALESCE(average_cost, 0)
  INTO v_old_stock, v_old_avg
  FROM inventory_items
  WHERE id = p_item_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item not found');
  END IF;

  -- Guard: prevent negative stock for outbound movements
  IF p_delta < 0 AND (v_old_stock + p_delta) < 0 THEN
    RETURN jsonb_build_object(
      'success',   false,
      'error',     'Insufficient stock',
      'available', v_old_stock
    );
  END IF;

  -- ─── Weighted average cost ─────────────────────────────────────────────────
  -- Only computed for inbound movements (p_delta > 0) with a known cost.
  -- Formula: newAvg = ((oldQty * oldAvg) + (inQty * inCost)) / (oldQty + inQty)
  -- Edge case: if current stock is zero or negative, new avg = incoming cost.
  v_new_avg := v_old_avg;
  IF p_delta > 0 AND p_cost_price IS NOT NULL THEN
    IF v_old_stock <= 0 THEN
      v_new_avg := p_cost_price;
    ELSE
      v_new_avg := ROUND(
        ((v_old_stock * v_old_avg) + (p_delta * p_cost_price)) / (v_old_stock + p_delta),
        6
      );
    END IF;
  END IF;

  -- ─── Atomic inventory update ───────────────────────────────────────────────
  UPDATE inventory_items
  SET
    current_stock      = current_stock + p_delta,
    average_cost       = v_new_avg,
    last_purchase_cost = CASE
                           WHEN p_source_type = 'po_receive' AND p_cost_price IS NOT NULL
                           THEN p_cost_price
                           ELSE last_purchase_cost
                         END,
    cost_updated_at    = CASE
                           WHEN p_cost_price IS NOT NULL THEN NOW()
                           ELSE cost_updated_at
                         END,
    cost_source        = COALESCE(p_source_type, cost_source),
    updated_at         = NOW()
  WHERE id         = p_item_id
    AND company_id = p_company_id
  RETURNING current_stock INTO v_new_stock;

  -- ─── Stock movement record ─────────────────────────────────────────────────
  INSERT INTO stock_movements (
    company_id, item_id, warehouse_id, movement_type, quantity,
    reference, notes, unit_cost, created_by, created_at
  ) VALUES (
    p_company_id, p_item_id, p_warehouse_id, p_movement_type, ABS(p_delta),
    p_reference, p_notes, p_cost_price, p_created_by, NOW()
  ) RETURNING id INTO v_movement_id;

  -- ─── Immutable valuation ledger ────────────────────────────────────────────
  -- CODEBOX 02: now includes previous_average_cost and previous_stock
  -- so every row is fully self-describing (before/after pair explicit).
  INSERT INTO stock_valuation_movements (
    company_id, item_id, movement_type, qty,
    unit_cost, total_cost,
    previous_average_cost, previous_stock,
    running_avg_cost, running_qty,
    reference, source_type, source_id, movement_id,
    created_at, created_by
  ) VALUES (
    p_company_id, p_item_id, p_movement_type, ABS(p_delta),
    COALESCE(p_cost_price, v_old_avg),
    ABS(p_delta) * COALESCE(p_cost_price, v_old_avg),
    v_old_avg, v_old_stock,
    v_new_avg, v_new_stock,
    p_reference, p_source_type, p_source_id, v_movement_id,
    NOW(), p_created_by
  );

  -- ─── FIFO cost layer (stock-in with known cost only) ──────────────────────
  IF p_delta > 0 AND p_cost_price IS NOT NULL THEN
    INSERT INTO inventory_cost_layers (
      company_id, item_id,
      received_qty, remaining_qty, unit_cost,
      source_type, source_id, received_at, created_by
    ) VALUES (
      p_company_id, p_item_id,
      p_delta, p_delta, p_cost_price,
      p_source_type, p_source_id, NOW(), p_created_by
    );
  END IF;

  -- ─── Cost history (only when average_cost changed) ────────────────────────
  IF v_new_avg IS DISTINCT FROM v_old_avg THEN
    INSERT INTO item_cost_history (
      company_id, item_id,
      previous_cost, new_cost, cost_type,
      change_source, source_reference,
      changed_at, changed_by
    ) VALUES (
      p_company_id, p_item_id,
      v_old_avg, v_new_avg, 'average_cost',
      COALESCE(p_source_type, p_movement_type), p_reference,
      NOW(), p_created_by
    );
  END IF;

  RETURN jsonb_build_object(
    'success',      true,
    'new_stock',    v_new_stock,
    'new_avg_cost', v_new_avg
  );
END;
$$;


-- ─── STEP 5: Add issue_unit_cost to work_order_materials ─────────────────────
--
-- Records the item's average_cost AT THE EXACT MOMENT materials are issued
-- to a work order.
--
-- Why this matters:
--   If an item's average cost changes AFTER issue but BEFORE WO completion,
--   the WO cost summary would show incorrect per-component costs if re-querying
--   the current price. issue_unit_cost freezes the valuation reference.
--
-- Populated by: POST /work-orders/:id/issue-materials (Codebox 02 update)
-- Nullable: NULL means the material was issued before Codebox 02 was deployed.

ALTER TABLE work_order_materials
  ADD COLUMN IF NOT EXISTS issue_unit_cost NUMERIC;  -- cost per unit at time of issue

COMMENT ON COLUMN work_order_materials.issue_unit_cost IS
  'The item average_cost captured at the time this material was issued to the WO. '
  'Populated from Codebox 02 onwards. NULL for pre-Codebox-02 issues. '
  'Used by the WO cost summary for forensic-grade per-component cost accuracy.';


-- ─── STEP 6: Accounting integration prep fields on inventory_items ───────────
--
-- These fields are RESERVED for future GL integration (Codebox accounting prep).
-- NO posting logic exists yet. They exist so the schema can accept account
-- assignments before the accounting module is wired up.
--
-- inventory_asset_account_id: Debit account for stock receipt (typically an asset)
-- cogs_account_id:            Debit account for stock issued to production / sold
-- wip_account_id:             WIP debit account for materials in open work orders
--
-- All nullable — items without account assignments will use company-level defaults
-- when GL posting is activated in a future Codebox.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS inventory_asset_account_id INTEGER,
  ADD COLUMN IF NOT EXISTS cogs_account_id            INTEGER,
  ADD COLUMN IF NOT EXISTS wip_account_id             INTEGER;

COMMENT ON COLUMN inventory_items.inventory_asset_account_id IS
  'FUTURE USE: GL account for inventory asset postings. Null = use company default.';
COMMENT ON COLUMN inventory_items.cogs_account_id IS
  'FUTURE USE: GL account for COGS / material issue postings. Null = use company default.';
COMMENT ON COLUMN inventory_items.wip_account_id IS
  'FUTURE USE: GL account for WIP postings during work order production. Null = use company default.';


-- ─── STEP 7: Performance indexes ─────────────────────────────────────────────

-- Query: find items by costing method within a company
CREATE INDEX IF NOT EXISTS idx_ii_company_costing_method
  ON inventory_items(company_id, costing_method);

-- Query: stock valuation report — active items with non-zero value (hot path)
CREATE INDEX IF NOT EXISTS idx_ii_company_active_avg_cost
  ON inventory_items(company_id, average_cost)
  WHERE is_active = TRUE;

-- Query: work_order_costs lookups by company + WO
CREATE INDEX IF NOT EXISTS idx_woc_company_wo
  ON work_order_costs(company_id, work_order_id);

-- Query: item_cost_history — recent changes per item
CREATE INDEX IF NOT EXISTS idx_ich_company_item_date
  ON item_cost_history(company_id, item_id, changed_at DESC);

-- Query: work_order_materials — all materials for a WO
CREATE INDEX IF NOT EXISTS idx_wom_work_order_id
  ON work_order_materials(work_order_id);


-- ─── Verification queries ─────────────────────────────────────────────────────
-- Run after migration to confirm all changes applied correctly:
--
-- 1. Confirm expanded costing_method constraint:
--    SELECT conname, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid = 'inventory_items'::regclass
--      AND conname = 'inventory_items_costing_method_check';
--    -- Must include 'last_cost' in the definition.
--
-- 2. Confirm cost non-negative constraints exist:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'inventory_items'::regclass
--      AND conname IN (
--        'chk_average_cost_non_negative',
--        'chk_last_purchase_cost_non_negative',
--        'chk_standard_cost_non_negative'
--      );
--    -- Must return 3 rows.
--
-- 3. Confirm previous-state columns exist on stock_valuation_movements:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'stock_valuation_movements'
--      AND column_name IN ('previous_average_cost', 'previous_stock');
--    -- Must return 2 rows.
--
-- 4. Confirm RPC now inserts previous-state values — smoke test:
--    SELECT adjust_inventory_stock(
--      <company_id>, <item_id>, 5, 'in', NULL,
--      'MIGRATION-051-TEST', NULL, 30.00, NULL, 'manual', NULL
--    );
--    -- Then verify the new row in stock_valuation_movements:
--    SELECT previous_average_cost, previous_stock, running_avg_cost, running_qty
--    FROM stock_valuation_movements
--    WHERE reference = 'MIGRATION-051-TEST'
--    ORDER BY created_at DESC LIMIT 1;
--    -- previous_average_cost should be the OLD avg, running_avg_cost the new avg.
--
-- 5. Confirm issue_unit_cost column exists on work_order_materials:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'work_order_materials'
--      AND column_name = 'issue_unit_cost';
--
-- 6. Confirm accounting prep columns exist on inventory_items:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'inventory_items'
--      AND column_name IN (
--        'inventory_asset_account_id', 'cogs_account_id', 'wip_account_id'
--      );
--    -- Must return 3 rows.
--
-- 7. Confirm new indexes exist:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename IN ('inventory_items', 'work_order_costs', 'item_cost_history', 'work_order_materials')
--      AND indexname IN (
--        'idx_ii_company_costing_method',
--        'idx_ii_company_active_avg_cost',
--        'idx_woc_company_wo',
--        'idx_ich_company_item_date',
--        'idx_wom_work_order_id'
--      );
--    -- Must return 5 rows.
