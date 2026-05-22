-- ============================================================================
-- Migration 041: Inventory Costing Foundation (Phase 2A)
-- Date: 2026-05-22
-- ============================================================================
-- Changes:
--   1. Add costing columns to inventory_items
--      (average_cost, last_purchase_cost, standard_cost, cost_updated_at,
--       cost_source)
--   2. Create stock_valuation_movements — immutable forensic cost ledger
--   3. Create inventory_cost_layers — FIFO layer tracking
--   4. Create work_order_costs — per-WO material cost accumulator
--   5. Create item_cost_history — cost change audit trail
--   6. Performance indexes on all new tables
--   7. Replace adjust_inventory_stock() RPC with extended costing version
--      — adds p_source_type and p_source_id parameters (backward compatible)
--      — computes weighted average on every 'in' movement with known cost
--      — writes to stock_valuation_movements (immutable ledger)
--      — creates FIFO cost layer on stock-in movements
--      — appends to item_cost_history when average_cost changes
--      — returns new_avg_cost in response JSONB
-- ============================================================================
-- SAFETY NOTES:
--   All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS (re-run safe).
--   All CREATE TABLE statements use CREATE TABLE IF NOT EXISTS (re-run safe).
--   CREATE OR REPLACE FUNCTION replaces the existing function without data loss.
--   The new RPC signature adds two optional parameters with defaults at the END
--   of the parameter list — all existing callers continue to work unchanged.
--   Existing callers receive new_avg_cost = 0 (backfilled value) in the
--   response since they pass p_cost_price: null.
-- ============================================================================


-- ─── STEP 1: Add costing columns to inventory_items ──────────────────────────

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS average_cost        NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_purchase_cost  NUMERIC,
  ADD COLUMN IF NOT EXISTS standard_cost       NUMERIC,
  ADD COLUMN IF NOT EXISTS cost_updated_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cost_source         VARCHAR(50);

-- Backfill average_cost from existing cost_price for items that have one.
-- Only fills rows where average_cost is 0 or null and cost_price is populated.
-- Safe on re-run: COALESCE prevents overwrites of non-zero average_cost.
UPDATE inventory_items
SET average_cost = cost_price
WHERE cost_price IS NOT NULL
  AND (average_cost IS NULL OR average_cost = 0);


-- ─── STEP 2: stock_valuation_movements — immutable forensic cost ledger ──────
-- One row per stock event that carries cost data.
-- Append-only: no UPDATE or DELETE paths exist in the application.
-- Captures running_avg_cost and running_qty at moment of each movement.

CREATE TABLE IF NOT EXISTS stock_valuation_movements (
  id               BIGSERIAL     PRIMARY KEY,
  company_id       INTEGER       NOT NULL,
  item_id          INTEGER       NOT NULL REFERENCES inventory_items(id),
  movement_type    VARCHAR(50)   NOT NULL,
  qty              NUMERIC       NOT NULL,
  unit_cost        NUMERIC       NOT NULL DEFAULT 0,
  total_cost       NUMERIC       NOT NULL DEFAULT 0,  -- qty * unit_cost
  running_avg_cost NUMERIC,                           -- average_cost AFTER this event
  running_qty      NUMERIC,                           -- current_stock AFTER this event
  reference        VARCHAR(255),
  source_type      VARCHAR(50),   -- po_receive | wo_issue | wo_complete | manual | adjustment
  source_id        VARCHAR(255),  -- PO id, WO id, etc.
  movement_id      BIGINT,        -- FK to stock_movements.id (soft — avoids type mismatch risk)
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       INTEGER
);


-- ─── STEP 3: inventory_cost_layers — FIFO layer tracking ─────────────────────
-- One row per received batch.
-- remaining_qty is decremented as stock is issued (FIFO depletion).
-- remaining_qty = 0 means the layer is fully consumed.

CREATE TABLE IF NOT EXISTS inventory_cost_layers (
  id            BIGSERIAL     PRIMARY KEY,
  company_id    INTEGER       NOT NULL,
  item_id       INTEGER       NOT NULL REFERENCES inventory_items(id),
  received_qty  NUMERIC       NOT NULL,
  remaining_qty NUMERIC       NOT NULL,
  unit_cost     NUMERIC       NOT NULL,
  source_type   VARCHAR(50),
  source_id     VARCHAR(255),
  received_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by    INTEGER
);


-- ─── STEP 4: work_order_costs — per-WO material cost accumulator ─────────────
-- Accumulates material_cost as materials are issued to the WO.
-- Finalised at WO completion: unit_cost = total_cost / completed_qty.
-- UNIQUE on work_order_id — one cost record per WO.

CREATE TABLE IF NOT EXISTS work_order_costs (
  id             BIGSERIAL     PRIMARY KEY,
  company_id     INTEGER       NOT NULL,
  work_order_id  INTEGER       NOT NULL REFERENCES work_orders(id),
  material_cost  NUMERIC       NOT NULL DEFAULT 0,
  labor_cost     NUMERIC       NOT NULL DEFAULT 0,
  overhead_cost  NUMERIC       NOT NULL DEFAULT 0,
  completed_qty  NUMERIC,
  unit_cost      NUMERIC,                            -- set at finalization
  status         VARCHAR(20)   NOT NULL DEFAULT 'open',  -- open | finalized
  finalized_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(work_order_id)
);


-- ─── STEP 5: item_cost_history — cost change audit trail ─────────────────────
-- Records every change to average_cost / last_purchase_cost / standard_cost.
-- Append-only audit trail — no rows are ever updated or deleted.

CREATE TABLE IF NOT EXISTS item_cost_history (
  id               BIGSERIAL     PRIMARY KEY,
  company_id       INTEGER       NOT NULL,
  item_id          INTEGER       NOT NULL REFERENCES inventory_items(id),
  previous_cost    NUMERIC,
  new_cost         NUMERIC       NOT NULL,
  cost_type        VARCHAR(50)   NOT NULL,   -- average_cost | last_purchase_cost | standard_cost
  change_source    VARCHAR(50)   NOT NULL,   -- po_receive | manual | wo_complete | adjustment
  source_reference VARCHAR(255),
  changed_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  changed_by       INTEGER
);


-- ─── STEP 6: Indexes ─────────────────────────────────────────────────────────

-- stock_valuation_movements — query by company+item and by date range
CREATE INDEX IF NOT EXISTS idx_svm_company_item
  ON stock_valuation_movements(company_id, item_id);

CREATE INDEX IF NOT EXISTS idx_svm_created_at
  ON stock_valuation_movements(company_id, created_at DESC);

-- inventory_cost_layers — find open layers for FIFO depletion
CREATE INDEX IF NOT EXISTS idx_icl_company_item
  ON inventory_cost_layers(company_id, item_id);

CREATE INDEX IF NOT EXISTS idx_icl_open_layers
  ON inventory_cost_layers(item_id, received_at)
  WHERE remaining_qty > 0;

-- work_order_costs — look up by WO
CREATE INDEX IF NOT EXISTS idx_woc_work_order
  ON work_order_costs(work_order_id);

CREATE INDEX IF NOT EXISTS idx_woc_company_status
  ON work_order_costs(company_id, status);

-- item_cost_history — look up cost history for one item
CREATE INDEX IF NOT EXISTS idx_ich_company_item
  ON item_cost_history(company_id, item_id, changed_at DESC);


-- ─── STEP 7: Replace adjust_inventory_stock() with costing-extended version ──
--
-- New parameters added at the end with DEFAULT NULL (fully backward compatible):
--   p_source_type  VARCHAR(50)   — 'po_receive','wo_issue','wo_complete','manual'
--   p_source_id    VARCHAR(255)  — PO id, WO id, etc.
--
-- New return fields added to JSONB response:
--   new_avg_cost   NUMERIC       — average_cost after this movement
--
-- Existing behaviour preserved exactly for all current callers:
--   - p_source_type/p_source_id default to NULL (no valuation trail gap — a
--     stock_valuation_movements row is still written with source_type = NULL)
--   - The negative stock guard logic is identical in effect
--   - stock_movements insert is identical
--
-- Costing logic added:
--   1. SELECT ... FOR UPDATE locks the item row to prevent concurrent
--      weighted-average races during simultaneous receives
--   2. Weighted average computed for 'in' movements with p_cost_price set
--   3. inventory_items updated atomically: current_stock + average_cost +
--      last_purchase_cost (for po_receive) + cost_updated_at + cost_source
--   4. stock_valuation_movements row inserted (immutable ledger)
--   5. inventory_cost_layers row inserted for stock-in with known cost (FIFO)
--   6. item_cost_history row inserted when average_cost changes

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
  -- Formula: newAvg = ((oldQty × oldAvg) + (inQty × inCost)) / (oldQty + inQty)
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
    company_id, item_id, warehouse_id, type, quantity,
    reference, notes, cost_price, created_by, created_at
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


-- ─── Verification queries ─────────────────────────────────────────────────────
-- Run after migration to confirm all objects created correctly:
--
-- 1. New columns on inventory_items:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'inventory_items'
--      AND column_name IN ('average_cost','last_purchase_cost','standard_cost',
--                          'cost_updated_at','cost_source');
--
-- 2. New tables:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('stock_valuation_movements','inventory_cost_layers',
--                         'work_order_costs','item_cost_history');
--
-- 3. Extended function signature (should show 11 arguments):
--    SELECT pronargs FROM pg_proc WHERE proname = 'adjust_inventory_stock';
--
-- 4. Backfill check:
--    SELECT COUNT(*) FROM inventory_items WHERE average_cost = 0 AND cost_price > 0;
--    -- Should return 0 after migration.
--
-- 5. Smoke test — call with source_type (new params) and without (old callers):
--    SELECT adjust_inventory_stock(1, 1, 10, 'in', NULL, 'TEST', NULL, 25.50,
--                                  NULL, 'po_receive', 'PO-TEST-1');
--    SELECT adjust_inventory_stock(1, 1, 1, 'out', NULL, 'TEST-OUT', NULL, NULL, NULL);
