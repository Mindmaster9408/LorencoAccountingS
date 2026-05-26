# Codebox 04 — Database Changes

## Migration File

`accounting-ecosystem/database/migrations/053_inventory_reservations.sql`

Run after migrations 050, 051, 052.

---

## Table: `stock_reservations`

```sql
CREATE TABLE stock_reservations (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL,
  item_id              INTEGER NOT NULL,
  warehouse_id         INTEGER NULL,
  source_type          VARCHAR(50)  NOT NULL CHECK (source_type IN ('work_order','sales_order_future','manual_hold','production_plan','stock_count_hold','other')),
  source_id            INTEGER      NOT NULL,
  source_line_id       INTEGER      NULL,
  reservation_status   VARCHAR(30)  NOT NULL DEFAULT 'active' CHECK (reservation_status IN ('active','partially_released','released','consumed','cancelled')),
  quantity_reserved    NUMERIC(18,4) NOT NULL,
  quantity_released    NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_consumed    NUMERIC(18,4) NOT NULL DEFAULT 0,
  reference            VARCHAR(255) NULL,
  reason               TEXT         NULL,
  created_by           INTEGER      NULL,
  released_by          INTEGER      NULL,
  consumed_by          INTEGER      NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  released_at          TIMESTAMPTZ  NULL,
  consumed_at          TIMESTAMPTZ  NULL,
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_sr_qty_positive   CHECK (quantity_reserved > 0),
  CONSTRAINT chk_sr_released_nonneg CHECK (quantity_released >= 0),
  CONSTRAINT chk_sr_consumed_nonneg CHECK (quantity_consumed >= 0),
  CONSTRAINT chk_sr_total_check    CHECK (quantity_released + quantity_consumed <= quantity_reserved)
);
```

### Key Design Decisions

- `quantity_released` and `quantity_consumed` are tracked separately for audit purposes:  
  `released` = returned to available without physical movement  
  `consumed` = matched by a physical stock deduction (issue-materials)
- The `source_line_id` links a reservation to a specific `work_order_materials` row, enabling line-level consume tracking
- `company_id` is on every row — every query uses `.eq('company_id', companyId)` — multi-tenant safe

---

## Indexes

```sql
CREATE INDEX idx_sr_company_item         ON stock_reservations (company_id, item_id);
CREATE INDEX idx_sr_company_status       ON stock_reservations (company_id, reservation_status);
CREATE INDEX idx_sr_company_source       ON stock_reservations (company_id, source_type, source_id);
CREATE INDEX idx_sr_company_item_status  ON stock_reservations (company_id, item_id, reservation_status);
```

The `idx_sr_company_item_status` index is the hot path — used in every available-stock computation.

---

## RPC: `reserve_stock()`

```sql
CREATE OR REPLACE FUNCTION reserve_stock(
  p_company_id     INTEGER,
  p_item_id        INTEGER,
  p_quantity       NUMERIC,
  p_source_type    VARCHAR,
  p_source_id      INTEGER,
  p_source_line_id INTEGER DEFAULT NULL,
  p_warehouse_id   INTEGER DEFAULT NULL,
  p_reference      VARCHAR DEFAULT NULL,
  p_reason         TEXT    DEFAULT NULL,
  p_created_by     INTEGER DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_current_stock   NUMERIC;
  v_active_reserved NUMERIC;
  v_available       NUMERIC;
  v_reservation_id  BIGINT;
BEGIN
  -- Lock the inventory_items row to prevent concurrent over-reservation
  SELECT current_stock INTO v_current_stock
  FROM inventory_items
  WHERE id = p_item_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item not found');
  END IF;

  -- Compute net active reservations for this item
  SELECT COALESCE(SUM(quantity_reserved - quantity_released - quantity_consumed), 0)
  INTO v_active_reserved
  FROM stock_reservations
  WHERE company_id = p_company_id
    AND item_id    = p_item_id
    AND reservation_status IN ('active', 'partially_released');

  v_available := v_current_stock - v_active_reserved;

  IF v_available < p_quantity THEN
    RETURN jsonb_build_object(
      'success',   false,
      'error',     'Insufficient available stock',
      'available', v_available,
      'reserved',  v_active_reserved,
      'requested', p_quantity
    );
  END IF;

  -- Insert the reservation
  INSERT INTO stock_reservations (
    company_id, item_id, warehouse_id, source_type, source_id, source_line_id,
    quantity_reserved, reference, reason, created_by
  ) VALUES (
    p_company_id, p_item_id, p_warehouse_id, p_source_type, p_source_id, p_source_line_id,
    p_quantity, p_reference, p_reason, p_created_by
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
```

The `FOR UPDATE` lock is held until the transaction commits, preventing concurrent processes from reading stale available-stock values.
