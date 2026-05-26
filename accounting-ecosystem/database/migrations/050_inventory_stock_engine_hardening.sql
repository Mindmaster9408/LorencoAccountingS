-- ============================================================================
-- Migration 050: Inventory Stock Engine Hardening (Codebox 01)
-- Date: May 2026
-- ============================================================================
-- Root cause being fixed:
--   Migration 041 deployed adjust_inventory_stock() with the INSERT into
--   stock_movements using wrong column names:
--     "type"       → correct column is: movement_type
--     "cost_price" → correct column is: unit_cost
--
--   This caused every call to the RPC to fail with a PostgreSQL column error.
--   The Node.js adjustStock() helper in stock-helpers.js was created as a
--   temporary workaround. That helper is non-atomic (no row-level lock) and
--   does not write to the forensic cost tables.
--
-- What this migration does:
--   1. Replaces adjust_inventory_stock() with an identical function body
--      except the stock_movements INSERT uses correct column names.
--   2. Validates the chk_current_stock_non_negative constraint that was
--      added as NOT VALID in migration 016.
--   3. Adds a performance index on stock_movements(company_id, item_id)
--      for the movement history queries used in the inventory frontend.
--
-- After this migration:
--   - The Node.js adjustStock() helper is deprecated and throws on call
--   - All 5 stock-mutation call sites use stockMutationService.adjustStockTx()
--   - adjustStockTx() calls this fixed RPC via supabase.rpc()
--   - Every stock event now writes to stock_valuation_movements (forensic ledger)
--   - Every stock-in with known cost creates an inventory_cost_layers row (FIFO)
--   - Every average_cost change appends to item_cost_history
--   - Concurrent stock-outs are protected by SELECT ... FOR UPDATE
--
-- Safety: CREATE OR REPLACE — no data loss. Safe to re-run.
-- ============================================================================


-- ─── STEP 1: Fix adjust_inventory_stock() — correct column names ─────────────
--
-- The function body is IDENTICAL to migration 041 except:
--   Line ~268: "type"       → "movement_type"
--   Line ~272: "cost_price" → "unit_cost"
--
-- Everything else (SELECT FOR UPDATE, weighted average, UPDATE inventory_items,
-- INSERT stock_valuation_movements, INSERT inventory_cost_layers,
-- INSERT item_cost_history) is preserved without change.

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
  -- FIXED: column names corrected from migration 041 bug
  --   "type"       was wrong → "movement_type" is correct
  --   "cost_price" was wrong → "unit_cost"     is correct
  INSERT INTO stock_movements (
    company_id, item_id, warehouse_id, movement_type, quantity,
    reference, notes, unit_cost, created_by, created_at
  ) VALUES (
    p_company_id, p_item_id, p_warehouse_id, p_movement_type, ABS(p_delta),
    p_reference, p_notes, p_cost_price, p_created_by, NOW()
  ) RETURNING id INTO v_movement_id;

  -- ─── Immutable valuation ledger ────────────────────────────────────────────
  -- Written for every movement regardless of whether cost is known.
  -- unit_cost falls back to the pre-movement average when cost is unknown —
  -- this gives a best-effort cost even for costless out movements.
  INSERT INTO stock_valuation_movements (
    company_id, item_id, movement_type, qty,
    unit_cost, total_cost,
    running_avg_cost, running_qty,
    reference, source_type, source_id, movement_id,
    created_at, created_by
  ) VALUES (
    p_company_id, p_item_id, p_movement_type, ABS(p_delta),
    COALESCE(p_cost_price, v_old_avg),
    ABS(p_delta) * COALESCE(p_cost_price, v_old_avg),
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


-- ─── STEP 2: Validate chk_current_stock_non_negative ─────────────────────────
--
-- Added as NOT VALID in migration 016 — existing rows were never validated.
--
-- PRE-CHECK: Run this query before this migration in production to confirm
-- no rows would fail validation:
--
--   SELECT id, name, current_stock
--   FROM inventory_items
--   WHERE current_stock < 0;
--
-- If the above returns rows, correct those stock levels FIRST, then run this
-- migration. The VALIDATE CONSTRAINT call will fail (and roll back) if any
-- row has current_stock < 0 — this is the correct behaviour (fail loud).
--
-- In the Lorenco demo environment all stock was inserted correctly, so this
-- is expected to succeed cleanly.

ALTER TABLE inventory_items
  VALIDATE CONSTRAINT chk_current_stock_non_negative;


-- ─── STEP 3: Add missing performance index on stock_movements ─────────────────
--
-- The movement history endpoint queries stock_movements by (company_id, item_id)
-- ordered by created_at DESC. Without this index, the query degrades to a full
-- table scan as data grows.

CREATE INDEX IF NOT EXISTS idx_sm_company_item_created
  ON stock_movements(company_id, item_id, created_at DESC);


-- ─── Verification queries ─────────────────────────────────────────────────────
-- Run after migration to confirm all changes applied correctly:
--
-- 1. Confirm RPC uses correct column names (should NOT contain 'cost_price' or
--    the literal string ", type," in the function body):
--    SELECT prosrc FROM pg_proc WHERE proname = 'adjust_inventory_stock';
--    -- Inspect for: "movement_type" and "unit_cost"
--
-- 2. Confirm constraint is now valid (is_valid should be true):
--    SELECT conname, convalidated
--    FROM pg_constraint
--    WHERE conname = 'chk_current_stock_non_negative';
--
-- 3. Confirm new index exists:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'stock_movements'
--      AND indexname = 'idx_sm_company_item_created';
--
-- 4. Smoke test — successful stock-in:
--    SELECT adjust_inventory_stock(
--      <company_id>, <item_id>, 10, 'in', NULL,
--      'MIGRATION-050-TEST', NULL, 25.00, NULL, 'manual', NULL
--    );
--    -- Should return: {"success": true, "new_stock": <n+10>, "new_avg_cost": <x>}
--
-- 5. Smoke test — insufficient stock guard:
--    SELECT adjust_inventory_stock(
--      <company_id>, <item_id>, -99999, 'out', NULL, 'TEST-NEG', NULL, NULL, NULL
--    );
--    -- Should return: {"success": false, "error": "Insufficient stock", "available": <n>}
