-- ============================================================================
-- Migration 014: Inventory Manufacturing Foundation — Phase 1
-- ============================================================================
-- Adds manufacturing-grade fields to existing inventory tables and creates
-- the core manufacturing tables: BOMs, Work Orders, and Work Order Materials.
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fix min_stock column naming (schema has reorder_level, code uses min_stock)
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS min_stock NUMERIC(12,3) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Extend inventory_items with manufacturing-grade fields
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS item_type VARCHAR(30) NOT NULL DEFAULT 'finished_good'
    CHECK (item_type IN ('raw_material', 'finished_good', 'sub_assembly', 'consumable', 'service')),
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(100),
  ADD COLUMN IF NOT EXISTS track_lots    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS track_serials BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(20) NOT NULL DEFAULT 'average'
    CHECK (costing_method IN ('average', 'fifo', 'standard')),
  ADD COLUMN IF NOT EXISTS lead_time_days INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. Extend warehouses with location type
-- ---------------------------------------------------------------------------
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS location_type VARCHAR(20) NOT NULL DEFAULT 'warehouse'
    CHECK (location_type IN ('warehouse', 'store', 'wip', 'quarantine', 'dispatch'));

-- ---------------------------------------------------------------------------
-- 4. Bill of Materials — Header
--    One BOM per finished product (or sub-assembly). Multiple versions allowed.
--    Only one BOM per product should be 'active' at a time (enforced at app level).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_headers (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  name         VARCHAR(200) NOT NULL,
  version      VARCHAR(20)  NOT NULL DEFAULT '1.0',
  status       VARCHAR(20)  NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'active', 'inactive')),
  output_qty   NUMERIC(12,3) NOT NULL DEFAULT 1,    -- how many finished units this BOM produces
  scrap_percent NUMERIC(5,2) NOT NULL DEFAULT 0,    -- overall wastage allowance %
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bom_headers_company ON bom_headers(company_id);
CREATE INDEX IF NOT EXISTS idx_bom_headers_item    ON bom_headers(item_id);

-- ---------------------------------------------------------------------------
-- 5. Bill of Materials — Component Lines
--    Each line = one raw material / sub-assembly component.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_lines (
  id            SERIAL PRIMARY KEY,
  bom_id        INTEGER NOT NULL REFERENCES bom_headers(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity      NUMERIC(12,4) NOT NULL,         -- qty needed per BOM output_qty
  scrap_percent NUMERIC(5,2)  NOT NULL DEFAULT 0,
  notes         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bom_lines_bom  ON bom_lines(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_lines_item ON bom_lines(item_id);

-- ---------------------------------------------------------------------------
-- 6. Work Orders
--    One work order = one production run for a specific item.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_orders (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wo_number            VARCHAR(50) NOT NULL,
  item_id              INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  bom_id               INTEGER REFERENCES bom_headers(id) ON DELETE SET NULL,
  quantity_to_produce  NUMERIC(12,3) NOT NULL,
  quantity_produced    NUMERIC(12,3) NOT NULL DEFAULT 0,
  status               VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'released', 'in_progress', 'completed', 'cancelled')),
  planned_start_date   DATE,
  planned_end_date     DATE,
  actual_start_date    DATE,
  actual_end_date      DATE,
  notes                TEXT,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, wo_number)
);

CREATE INDEX IF NOT EXISTS idx_work_orders_company ON work_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_item    ON work_orders(item_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status  ON work_orders(status);

-- ---------------------------------------------------------------------------
-- 7. Work Order Material Requirements
--    Auto-populated from BOM on WO creation. Tracks required vs issued qty.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order_materials (
  id             SERIAL PRIMARY KEY,
  work_order_id  INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  required_qty   NUMERIC(12,4) NOT NULL,
  issued_qty     NUMERIC(12,4) NOT NULL DEFAULT 0,
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_wo_materials_wo   ON work_order_materials(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_materials_item ON work_order_materials(item_id);
