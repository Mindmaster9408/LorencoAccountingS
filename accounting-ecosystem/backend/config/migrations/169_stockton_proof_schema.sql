-- ============================================================================
-- Migration 169: Stockton Proof/Build tier scoping — schema additions
-- ============================================================================
-- Covers the schema needed for the Stockton gap-audit items being built
-- 2026-09-12: maker-checker (stock counts, BOM activation), period-end
-- immutable snapshots, labour/machine costing rates, lot/expiry tracking,
-- and production routings/phases. All additive — existing behaviour for
-- every company is unchanged until these new columns/tables are actually
-- used by a client.
--
-- Idempotent throughout (IF NOT EXISTS / DO guards), safe to re-run.
-- ============================================================================

-- ── Maker-checker: stock counts ──────────────────────────────────────────────
-- submitted_by lets approveCountSession() (stockCountService.js) block the
-- same person from both submitting and approving a count.
ALTER TABLE stock_count_sessions ADD COLUMN IF NOT EXISTS submitted_by INTEGER NULL REFERENCES users(id);

-- ── Maker-checker: BOM activation ────────────────────────────────────────────
-- activated_by/activated_at mirror created_by/created_at so a BOM's full
-- create-then-activate history is visible, not just its current status.
ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS activated_by INTEGER NULL REFERENCES users(id);
ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ NULL;

-- ── Period-end immutable snapshot ────────────────────────────────────────────
-- One row per company per closed period. Once inserted, a row is never
-- updated or deleted (enforced by trigger below) — the same "immutable
-- proof" pattern already used for pos_recon_snapshots (migration 029) and
-- pos_audit_events/audit_log (migrations 028/168).
CREATE TABLE IF NOT EXISTS inventory_period_snapshots (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_label        TEXT NOT NULL,               -- e.g. '2026-08'
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  total_stock_value   NUMERIC(18,4) NOT NULL,
  total_items_counted INTEGER NOT NULL,
  valuation_by_warehouse JSONB NOT NULL DEFAULT '[]', -- [{warehouse_id, warehouse_name, value}]
  open_work_orders    INTEGER NOT NULL DEFAULT 0,
  open_purchase_orders INTEGER NOT NULL DEFAULT 0,
  snapshot_data       JSONB NOT NULL DEFAULT '{}',  -- full item-level valuation detail
  closed_by_user_id   INTEGER NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_label)
);
CREATE INDEX IF NOT EXISTS idx_inv_period_snapshots_company ON inventory_period_snapshots (company_id, period_end DESC);

CREATE OR REPLACE FUNCTION prevent_inventory_period_snapshot_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'inventory_period_snapshots is append-only. A closed period cannot be modified or deleted. '
        'Action: % on row id=%', TG_OP, OLD.id;
END;
$$;
DROP TRIGGER IF EXISTS inv_period_snapshot_no_update ON inventory_period_snapshots;
CREATE TRIGGER inv_period_snapshot_no_update
    BEFORE UPDATE ON inventory_period_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_inventory_period_snapshot_modification();
DROP TRIGGER IF EXISTS inv_period_snapshot_no_delete ON inventory_period_snapshots;
CREATE TRIGGER inv_period_snapshot_no_delete
    BEFORE DELETE ON inventory_period_snapshots
    FOR EACH ROW EXECUTE FUNCTION prevent_inventory_period_snapshot_modification();

-- ── Labour / machine costing rates ───────────────────────────────────────────
-- No rate table existed anywhere — production_labour_entries.labour_cost and
-- production_machine_entries.machine_cost were hardcoded to 0 on every
-- insert. is_default=true rows are the fallback when a specific role/machine
-- has no rate of its own.
CREATE TABLE IF NOT EXISTS inventory_labour_rates (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'general',
  hourly_rate  NUMERIC(10,2) NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role)
);

-- machine_id uses the '__default__' sentinel rather than NULL for the
-- fallback rate — Postgres does not treat two NULLs as equal for UNIQUE
-- purposes, so UNIQUE(company_id, machine_id) would silently allow more
-- than one "default" row per company if NULL were used instead.
CREATE TABLE IF NOT EXISTS inventory_machine_rates (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id   TEXT NOT NULL DEFAULT '__default__',
  hourly_rate  NUMERIC(10,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, machine_id)
);

-- Add a role field to labour entries so a rate can actually be looked up —
-- previously there was no way to know which rate applied to a given entry.
ALTER TABLE production_labour_entries ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'general';

-- ── Lot / expiry tracking ─────────────────────────────────────────────────────
-- Lot-level (not full unit-serialization — that's a much larger feature and
-- wasn't what the gap asked for) tracking of received stock: a lot number,
-- an optional expiry date, and remaining quantity for FEFO-aware picking.
CREATE TABLE IF NOT EXISTS inventory_stock_lots (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL,
  warehouse_id      INTEGER NULL,
  lot_number        TEXT NOT NULL,
  expiry_date       DATE NULL,
  quantity_received NUMERIC(18,4) NOT NULL,
  quantity_remaining NUMERIC(18,4) NOT NULL,
  unit_cost         NUMERIC(18,4) NULL,
  supplier_id       INTEGER NULL,
  po_reference      TEXT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by       INTEGER NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, item_id, lot_number)
);
CREATE INDEX IF NOT EXISTS idx_inv_stock_lots_item ON inventory_stock_lots (company_id, item_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_inv_stock_lots_expiry ON inventory_stock_lots (company_id, expiry_date) WHERE quantity_remaining > 0;

-- ── Production routings / phases ─────────────────────────────────────────────
-- A BOM's routing is the ordered list of operations production should
-- follow; a work order's operations are that routing copied at release time
-- (edits to a BOM's routing later must not rewrite an already-released
-- work order's history — same snapshot principle used throughout this
-- ecosystem, e.g. Collector's period_items).
CREATE TABLE IF NOT EXISTS bom_routing_steps (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bom_id           INTEGER NOT NULL REFERENCES bom_headers(id) ON DELETE CASCADE,
  step_number      INTEGER NOT NULL,
  operation_name   TEXT NOT NULL,
  work_center      TEXT NULL,
  expected_minutes NUMERIC(10,2) NULL,
  notes            TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bom_id, step_number)
);

CREATE TABLE IF NOT EXISTS work_order_operations (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_order_id     INTEGER NOT NULL,
  step_number       INTEGER NOT NULL,
  operation_name    TEXT NOT NULL,
  work_center       TEXT NULL,
  expected_minutes  NUMERIC(10,2) NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','skipped')),
  started_at        TIMESTAMPTZ NULL,
  completed_at      TIMESTAMPTZ NULL,
  completed_by      INTEGER NULL REFERENCES users(id),
  actual_minutes    NUMERIC(10,2) NULL,
  notes             TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_wo_operations_wo ON work_order_operations (work_order_id, step_number);
