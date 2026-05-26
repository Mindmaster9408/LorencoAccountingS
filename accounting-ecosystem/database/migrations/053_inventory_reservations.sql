-- ============================================================================
-- Migration 053 — Inventory Reservations & Available Stock Control
-- Codebox 04 of 12 — LORENCO STOREHOUSE — MrEasy Pilot Path
-- ============================================================================
-- Purpose: Introduce reservation layer so committed stock is never
--          double-allocated. available_stock = current_stock − active_reserved.
--          Reservations are COMMITMENTS, not stock movements.
--          adjustStockTx() remains the sole path for actual stock changes.
-- ============================================================================

-- ─── Table: stock_reservations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_reservations (
  id                  BIGSERIAL          PRIMARY KEY,
  company_id          INTEGER            NOT NULL,
  item_id             INTEGER            NOT NULL,
  warehouse_id        INTEGER            NULL,
  source_type         VARCHAR(50)        NOT NULL,
  source_id           INTEGER            NOT NULL,
  source_line_id      INTEGER            NULL,
  reservation_status  VARCHAR(30)        NOT NULL DEFAULT 'active',
  quantity_reserved   NUMERIC(18,4)      NOT NULL,
  quantity_released   NUMERIC(18,4)      NOT NULL DEFAULT 0,
  quantity_consumed   NUMERIC(18,4)      NOT NULL DEFAULT 0,
  reference           VARCHAR(255)       NULL,
  reason              TEXT               NULL,
  created_by          INTEGER            NULL,
  released_by         INTEGER            NULL,
  consumed_by         INTEGER            NULL,
  created_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  released_at         TIMESTAMPTZ        NULL,
  consumed_at         TIMESTAMPTZ        NULL,
  updated_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_sr_qty_positive     CHECK (quantity_reserved > 0),
  CONSTRAINT chk_sr_released_nonneg  CHECK (quantity_released >= 0),
  CONSTRAINT chk_sr_consumed_nonneg  CHECK (quantity_consumed >= 0),
  CONSTRAINT chk_sr_total_check      CHECK (quantity_released + quantity_consumed <= quantity_reserved),

  CONSTRAINT chk_sr_source_type CHECK (source_type IN (
    'work_order',
    'sales_order_future',
    'manual_hold',
    'production_plan',
    'stock_count_hold',
    'other'
  )),

  CONSTRAINT chk_sr_status CHECK (reservation_status IN (
    'active',
    'partially_released',
    'released',
    'consumed',
    'cancelled'
  ))
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sr_company_item
  ON stock_reservations (company_id, item_id);

CREATE INDEX IF NOT EXISTS idx_sr_company_status
  ON stock_reservations (company_id, reservation_status);

CREATE INDEX IF NOT EXISTS idx_sr_company_source
  ON stock_reservations (company_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_sr_company_item_status
  ON stock_reservations (company_id, item_id, reservation_status);

-- ─── RPC: reserve_stock ──────────────────────────────────────────────────────
-- Atomic, row-locked reservation creation.
-- Acquires SELECT ... FOR UPDATE on inventory_items to prevent concurrent
-- over-reservation under simultaneous WO releases.
-- Returns JSONB:
--   success = true  → { reservation_id, current_stock, reserved_before,
--                        reserved_after, available_after }
--   success = false → { error, current_stock, reserved, available, requested }
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reserve_stock(
  p_company_id     INTEGER,
  p_item_id        INTEGER,
  p_quantity       NUMERIC,
  p_source_type    VARCHAR,
  p_source_id      INTEGER,
  p_source_line_id INTEGER,
  p_warehouse_id   INTEGER,
  p_reference      VARCHAR,
  p_reason         TEXT,
  p_created_by     INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_stock   NUMERIC;
  v_active_reserved NUMERIC;
  v_available       NUMERIC;
  v_reservation_id  BIGINT;
BEGIN
  -- Acquire row-level lock on the item to prevent concurrent over-reservation
  SELECT current_stock
    INTO v_current_stock
    FROM inventory_items
   WHERE id = p_item_id
     AND company_id = p_company_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item not found');
  END IF;

  -- Compute the total currently committed (active + partially_released)
  SELECT COALESCE(SUM(quantity_reserved - quantity_released - quantity_consumed), 0)
    INTO v_active_reserved
    FROM stock_reservations
   WHERE company_id      = p_company_id
     AND item_id         = p_item_id
     AND reservation_status IN ('active', 'partially_released');

  v_available := v_current_stock - v_active_reserved;

  IF p_quantity > v_available THEN
    RETURN jsonb_build_object(
      'success',       false,
      'error',         'Insufficient available stock',
      'current_stock', v_current_stock,
      'reserved',      v_active_reserved,
      'available',     v_available,
      'requested',     p_quantity
    );
  END IF;

  -- Insert the reservation record
  INSERT INTO stock_reservations (
    company_id,    item_id,       warehouse_id,
    source_type,   source_id,     source_line_id,
    reservation_status,
    quantity_reserved, quantity_released, quantity_consumed,
    reference,     reason,        created_by
  ) VALUES (
    p_company_id,    p_item_id,     p_warehouse_id,
    p_source_type,   p_source_id,   p_source_line_id,
    'active',
    p_quantity, 0, 0,
    p_reference,     p_reason,      p_created_by
  ) RETURNING id INTO v_reservation_id;

  RETURN jsonb_build_object(
    'success',         true,
    'reservation_id',  v_reservation_id,
    'current_stock',   v_current_stock,
    'reserved_before', v_active_reserved,
    'reserved_after',  v_active_reserved + p_quantity,
    'available_after', v_available - p_quantity
  );
END;
$$;

-- ─── Comment ─────────────────────────────────────────────────────────────────
COMMENT ON TABLE stock_reservations IS
  'Stock reservation commitments. Reservations do not move stock — they reduce '
  'available_stock (= current_stock − active_reserved) for allocation control. '
  'Only adjustStockTx() via adjust_inventory_stock() RPC may change current_stock.';
