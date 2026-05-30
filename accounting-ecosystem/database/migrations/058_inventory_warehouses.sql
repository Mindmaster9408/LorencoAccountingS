-- ============================================================================
-- Migration 058: Inventory Warehouse Structure & Location Control (Codebox 08)
-- Date: 2026-05-29
-- ============================================================================
-- Purpose:
--   Extends Lorenco Storehouse from single-level warehouse support into
--   a full warehouse-and-location (bin-level) model with forensic-grade
--   warehouse-to-warehouse transfer tracking.
--
-- What this migration adds:
--   1.  Extends warehouses table with warehouse_code, warehouse_type,
--       is_default, address fields, contact fields, notes (also fixes the
--       pre-existing bug where routes expected address/notes that didn't exist).
--   2.  Creates warehouse_locations  — bins/shelves/zones within a warehouse.
--   3.  Creates inventory_stock_locations — per (item × warehouse × location)
--       quantity summary. Movement-sourced. NOT a new source of truth.
--   4.  Extends stock_movements with location_id, to_location_id (nullable).
--   5.  Extends stock_reservations with location_id (nullable).
--   6.  Creates warehouse_transfers   — transfer header.
--   7.  Creates warehouse_transfer_lines — per-item transfer detail.
--
-- Safety rules:
--   - All new columns: ADD COLUMN IF NOT EXISTS
--   - All new tables:  CREATE TABLE IF NOT EXISTS
--   - All new indexes: CREATE INDEX IF NOT EXISTS
--   - Safe to re-run on a database that already has partial state.
--   - No existing data is modified.
--   - No existing columns are renamed or removed.
-- ============================================================================

-- ─── 1. Extend warehouses ────────────────────────────────────────────────────
-- The routes at /api/inventory/warehouses expected address and notes fields
-- that never existed. This adds them plus the CB-08 warehouse control fields.

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS warehouse_code   TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_type   TEXT NOT NULL DEFAULT 'main'
                             CHECK (warehouse_type IN ('main','production','quarantine','transit','retail','overflow','other')),
  ADD COLUMN IF NOT EXISTS is_default       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS address_line1    TEXT,
  ADD COLUMN IF NOT EXISTS address_line2    TEXT,
  ADD COLUMN IF NOT EXISTS city             TEXT,
  ADD COLUMN IF NOT EXISTS postal_code      TEXT,
  ADD COLUMN IF NOT EXISTS contact_name     TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone    TEXT,
  ADD COLUMN IF NOT EXISTS contact_email    TEXT,
  ADD COLUMN IF NOT EXISTS notes            TEXT;

-- Unique warehouse_code per company (sparse — only when code is provided)
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_code_company_uidx
  ON warehouses (company_id, warehouse_code)
  WHERE warehouse_code IS NOT NULL;

-- Only one default warehouse per company
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_default_company_uidx
  ON warehouses (company_id, is_default)
  WHERE is_default = true;

-- ─── 2. warehouse_locations ──────────────────────────────────────────────────
-- Bins, shelves, zones, staging areas — sub-locations within a warehouse.

CREATE TABLE IF NOT EXISTS warehouse_locations (
  id              BIGSERIAL        PRIMARY KEY,
  company_id      BIGINT           NOT NULL,
  warehouse_id    BIGINT           NOT NULL,
  location_code   TEXT             NOT NULL,
  location_name   TEXT             NOT NULL,
  location_type   TEXT             NOT NULL DEFAULT 'bin'
                    CHECK (location_type IN ('shelf','bin','bulk','staging','quarantine','production','dispatch','other')),
  max_capacity    NUMERIC(15,4),
  capacity_unit   TEXT,
  is_active       BOOLEAN          NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT wl_company_warehouse_code_unique UNIQUE (company_id, warehouse_id, location_code)
);

CREATE INDEX IF NOT EXISTS wl_warehouse_idx   ON warehouse_locations (warehouse_id);
CREATE INDEX IF NOT EXISTS wl_company_idx     ON warehouse_locations (company_id);

-- ─── 3. inventory_stock_locations ────────────────────────────────────────────
-- Per (item × warehouse × location) quantity summary.
--
-- Architecture note:
--   This is a DENORMALIZED SUMMARY TABLE — not the source of truth.
--   Source of truth: inventory_items.current_stock (company-total).
--   This table is updated by the transfer engine and movement service.
--   If it ever drifts, it can be rebuilt from stock_movements history.
--
-- The UNIQUE constraint uses NULLS NOT DISTINCT (Postgres 15+, supported by
-- Supabase) so that (item, warehouse, NULL location) is treated as a unique
-- combination (one row per item per warehouse when no location is specified).

CREATE TABLE IF NOT EXISTS inventory_stock_locations (
  id                BIGSERIAL   PRIMARY KEY,
  company_id        BIGINT      NOT NULL,
  item_id           BIGINT      NOT NULL,
  warehouse_id      BIGINT      NOT NULL,
  location_id       BIGINT,
  quantity_on_hand  NUMERIC(15,4) NOT NULL DEFAULT 0,
  quantity_reserved NUMERIC(15,4) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT isl_unique_slot
    UNIQUE NULLS NOT DISTINCT (company_id, item_id, warehouse_id, location_id)
);

CREATE INDEX IF NOT EXISTS isl_item_wh_idx  ON inventory_stock_locations (company_id, item_id, warehouse_id);
CREATE INDEX IF NOT EXISTS isl_wh_idx       ON inventory_stock_locations (warehouse_id);
CREATE INDEX IF NOT EXISTS isl_company_idx  ON inventory_stock_locations (company_id);

-- ─── 4. Extend stock_movements ───────────────────────────────────────────────
-- Add from-location and to-location for bin-level movement tracking.
-- Nullable — backward compatible with all existing movements.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS location_id    BIGINT,
  ADD COLUMN IF NOT EXISTS to_location_id BIGINT;

-- ─── 5. Extend stock_reservations ────────────────────────────────────────────
-- Allow reservations to be scoped to a specific bin/shelf.

ALTER TABLE stock_reservations
  ADD COLUMN IF NOT EXISTS location_id BIGINT;

-- ─── 6. warehouse_transfers ──────────────────────────────────────────────────
-- Forensic transfer header. Every warehouse transfer is a permanent record.

CREATE TABLE IF NOT EXISTS warehouse_transfers (
  id                 BIGSERIAL   PRIMARY KEY,
  company_id         BIGINT      NOT NULL,
  transfer_number    TEXT        NOT NULL,
  from_warehouse_id  BIGINT      NOT NULL,
  to_warehouse_id    BIGINT      NOT NULL,
  from_location_id   BIGINT,
  to_location_id     BIGINT,
  transfer_status    TEXT        NOT NULL DEFAULT 'draft'
                       CHECK (transfer_status IN ('draft','approved','in_transit','received','cancelled')),
  requested_by       BIGINT,
  approved_by        BIGINT,
  approved_at        TIMESTAMPTZ,
  shipped_at         TIMESTAMPTZ,
  received_at        TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wt_number_company_unique UNIQUE (company_id, transfer_number)
);

CREATE INDEX IF NOT EXISTS wt_company_idx        ON warehouse_transfers (company_id);
CREATE INDEX IF NOT EXISTS wt_from_wh_idx        ON warehouse_transfers (from_warehouse_id);
CREATE INDEX IF NOT EXISTS wt_to_wh_idx          ON warehouse_transfers (to_warehouse_id);
CREATE INDEX IF NOT EXISTS wt_status_idx         ON warehouse_transfers (company_id, transfer_status);

-- ─── 7. warehouse_transfer_lines ─────────────────────────────────────────────
-- Per-item detail for each transfer. Shipped and received quantities tracked
-- independently — partial receipt is supported.

CREATE TABLE IF NOT EXISTS warehouse_transfer_lines (
  id                  BIGSERIAL   PRIMARY KEY,
  company_id          BIGINT      NOT NULL,
  transfer_id         BIGINT      NOT NULL,
  item_id             BIGINT      NOT NULL,
  quantity_requested  NUMERIC(15,4) NOT NULL,
  quantity_shipped    NUMERIC(15,4),
  quantity_received   NUMERIC(15,4),
  from_location_id    BIGINT,
  to_location_id      BIGINT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wtl_transfer_idx ON warehouse_transfer_lines (transfer_id);
CREATE INDEX IF NOT EXISTS wtl_item_idx     ON warehouse_transfer_lines (company_id, item_id);
CREATE INDEX IF NOT EXISTS wtl_company_idx  ON warehouse_transfer_lines (company_id);

-- ─── End of migration 058 ─────────────────────────────────────────────────────
