-- ============================================================================
-- Migration 059: Inventory Sales Orders & Demand Planning (Codebox 09)
-- Date: 2026-05-29
-- ============================================================================
-- Purpose:
--   Adds the sales order layer to Lorenco Storehouse, enabling:
--   - Customer demand tracking
--   - ATP (Available To Promise) calculations
--   - Demand-driven stock reservations
--   - Fulfilled vs. backlogged visibility
--
-- What this migration adds:
--   1. Extends stock_reservations.source_type CHECK to include 'sales_order'
--   2. Creates sales_orders — SO header
--   3. Creates sales_order_lines — per-item detail with allocation tracking
--   4. Creates sales_order_status_history — immutable status audit trail
--
-- Safety rules:
--   - All new tables:   CREATE TABLE IF NOT EXISTS
--   - All new indexes:  CREATE INDEX IF NOT EXISTS
--   - Constraint change: DROP CONSTRAINT IF EXISTS before re-adding
--   - Safe to re-run.
-- ============================================================================

-- ─── 1. Extend source_type to include 'sales_order' ─────────────────────────
-- The existing constraint only allowed 'sales_order_future'.
-- 'sales_order' is the confirmed, tracked SO allocation source type.

ALTER TABLE stock_reservations
  DROP CONSTRAINT IF EXISTS chk_sr_source_type;

ALTER TABLE stock_reservations
  ADD CONSTRAINT chk_sr_source_type CHECK (source_type IN (
    'work_order',
    'sales_order',
    'sales_order_future',
    'manual_hold',
    'production_plan',
    'stock_count_hold',
    'other'
  ));

-- ─── 2. sales_orders ─────────────────────────────────────────────────────────
-- Sales order header. One SO per customer request.
-- Each SO can contain multiple lines (items).
-- Status lifecycle: draft → confirmed → allocated → partially_fulfilled
--                                                 → fulfilled
--               (any pre-fulfilled status) → cancelled

CREATE TABLE IF NOT EXISTS sales_orders (
  id                BIGSERIAL       PRIMARY KEY,
  company_id        BIGINT          NOT NULL,
  so_number         TEXT            NOT NULL,
  customer_name     TEXT            NOT NULL,
  customer_email    TEXT,
  customer_phone    TEXT,
  customer_ref      TEXT,
  so_status         TEXT            NOT NULL DEFAULT 'draft'
                      CHECK (so_status IN (
                        'draft', 'confirmed', 'allocated',
                        'partially_fulfilled', 'fulfilled', 'cancelled'
                      )),
  required_date     DATE,
  delivery_address  TEXT,
  currency_code     TEXT            NOT NULL DEFAULT 'ZAR',
  notes             TEXT,
  total_amount      NUMERIC(15,4)   NOT NULL DEFAULT 0,
  created_by        BIGINT,
  confirmed_by      BIGINT,
  cancelled_by      BIGINT,
  cancelled_at      TIMESTAMPTZ,
  fulfilled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT so_number_company_unique UNIQUE (company_id, so_number)
);

CREATE INDEX IF NOT EXISTS so_company_idx        ON sales_orders (company_id);
CREATE INDEX IF NOT EXISTS so_status_idx         ON sales_orders (company_id, so_status);
CREATE INDEX IF NOT EXISTS so_required_date_idx  ON sales_orders (company_id, required_date);
CREATE INDEX IF NOT EXISTS so_customer_idx       ON sales_orders (company_id, customer_name);

-- ─── 3. sales_order_lines ─────────────────────────────────────────────────────
-- Per-item detail for each sales order.
-- Tracks ordered, allocated, and fulfilled quantities separately.

CREATE TABLE IF NOT EXISTS sales_order_lines (
  id                  BIGSERIAL       PRIMARY KEY,
  company_id          BIGINT          NOT NULL,
  so_id               BIGINT          NOT NULL,
  item_id             BIGINT          NOT NULL,
  line_number         INTEGER         NOT NULL DEFAULT 1,
  quantity_ordered    NUMERIC(15,4)   NOT NULL,
  quantity_allocated  NUMERIC(15,4)   NOT NULL DEFAULT 0,
  quantity_fulfilled  NUMERIC(15,4)   NOT NULL DEFAULT 0,
  unit_price          NUMERIC(15,4)   NOT NULL DEFAULT 0,
  line_total          NUMERIC(15,4)   GENERATED ALWAYS AS (quantity_ordered * unit_price) STORED,
  reservation_id      BIGINT,
  required_date       DATE,
  notes               TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT sol_qty_ordered_pos CHECK (quantity_ordered > 0),
  CONSTRAINT sol_qty_alloc_nonneg CHECK (quantity_allocated >= 0),
  CONSTRAINT sol_qty_fulfil_nonneg CHECK (quantity_fulfilled >= 0)
);

CREATE INDEX IF NOT EXISTS sol_so_idx       ON sales_order_lines (so_id);
CREATE INDEX IF NOT EXISTS sol_item_idx     ON sales_order_lines (company_id, item_id);
CREATE INDEX IF NOT EXISTS sol_company_idx  ON sales_order_lines (company_id);

-- ─── 4. sales_order_status_history ───────────────────────────────────────────
-- Immutable audit trail of every SO status change.

CREATE TABLE IF NOT EXISTS sales_order_status_history (
  id            BIGSERIAL       PRIMARY KEY,
  company_id    BIGINT          NOT NULL,
  so_id         BIGINT          NOT NULL,
  from_status   TEXT,
  to_status     TEXT            NOT NULL,
  changed_by    BIGINT,
  notes         TEXT,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sosh_so_idx      ON sales_order_status_history (so_id);
CREATE INDEX IF NOT EXISTS sosh_company_idx ON sales_order_status_history (company_id);

-- ─── End of migration 059 ─────────────────────────────────────────────────────
