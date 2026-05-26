-- ============================================================================
-- Migration 056 — Manufacturing Execution & Production Control (Codebox 06)
-- Lorenco Storehouse — MrEasy Pilot Path
-- ============================================================================
-- Purpose:
--   1. Extend work_orders — add paused/closed status + production tracking columns.
--   2. Create production_batches — immutable production run records.
--   3. Create production_wastage — per-batch wastage forensics.
--   4. Create production_variances — per-batch material variance records.
--   5. Create production_labour_entries — placeholder for future MES.
--   6. Create production_machine_entries — placeholder for future MES.
--
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Run AFTER migration 055.
-- ============================================================================


-- ─── STEP 1: Extend work_orders status constraint ────────────────────────────

-- Drop the existing status constraint (any name variant from prior migrations).
-- Previous codebox constraint name: chk_wo_status or work_orders_status_check.
DO $$
BEGIN
  BEGIN
    ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS chk_wo_status;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Add Codebox 06 status set
  BEGIN
    ALTER TABLE work_orders
      ADD CONSTRAINT chk_wo_status_cb06 CHECK (status IN (
        'draft',
        'released',
        'in_progress',
        'paused',
        'completed',
        'closed',
        'cancelled'
      ));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$$;

-- ─── STEP 2: Extend work_orders columns ─────────────────────────────────────

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS actual_yield_percent  NUMERIC(8,4)  NULL,
  ADD COLUMN IF NOT EXISTS total_wastage_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS batch_count           INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_at             TIMESTAMPTZ   NULL,
  ADD COLUMN IF NOT EXISTS closed_by             INTEGER       REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN work_orders.actual_yield_percent IS
  'Computed at WO completion: (quantity_produced / quantity_to_produce) * 100. '
  'Null until first batch is completed.';

COMMENT ON COLUMN work_orders.total_wastage_qty IS
  'Sum of all production_wastage.wastage_qty for this WO. Updated on batch completion.';

COMMENT ON COLUMN work_orders.batch_count IS
  'Count of production_batches created for this WO.';


-- ─── STEP 3: Create production_batches ──────────────────────────────────────
-- One row per production run / batch event on a WO.
-- Immutable after status = completed.
-- Tracks yield, wastage, cost at batch level.

CREATE TABLE IF NOT EXISTS production_batches (
  id                  BIGSERIAL       PRIMARY KEY,
  company_id          INTEGER         NOT NULL,
  work_order_id       INTEGER         NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
  batch_number        VARCHAR(50)     NOT NULL,

  -- Quantities
  expected_qty        NUMERIC(18,4)   NOT NULL,
  produced_qty        NUMERIC(18,4)   NOT NULL,
  wastage_qty         NUMERIC(18,4)   NOT NULL DEFAULT 0,
  yield_percent       NUMERIC(8,4)    NULL,     -- produced_qty / expected_qty * 100

  -- Costing
  total_material_cost NUMERIC(15,4)   NOT NULL DEFAULT 0,
  total_labour_cost   NUMERIC(15,4)   NOT NULL DEFAULT 0,
  total_machine_cost  NUMERIC(15,4)   NOT NULL DEFAULT 0,
  unit_cost           NUMERIC(15,4)   NULL,     -- (material + labour + machine) / produced_qty

  -- Execution
  status              VARCHAR(20)     NOT NULL DEFAULT 'completed',
  started_at          TIMESTAMPTZ     NULL,
  completed_at        TIMESTAMPTZ     NULL,
  executed_by         INTEGER         REFERENCES users(id) ON DELETE SET NULL,
  approved_by         INTEGER         REFERENCES users(id) ON DELETE SET NULL,

  -- Traceability
  movement_id         BIGINT          NULL,     -- stock_movements.id for finished goods receipt
  notes               TEXT            NULL,
  operator_notes      TEXT            NULL,

  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pb_produced_positive   CHECK (produced_qty > 0),
  CONSTRAINT chk_pb_wastage_nonneg      CHECK (wastage_qty >= 0),
  CONSTRAINT chk_pb_status              CHECK (status IN ('completed'))
  -- Only 'completed' batches exist currently.
  -- Future: add 'in_progress' when multi-batch execution is built.
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pb_batch_number ON production_batches (company_id, work_order_id, batch_number);
CREATE INDEX IF NOT EXISTS idx_pb_company           ON production_batches (company_id);
CREATE INDEX IF NOT EXISTS idx_pb_company_wo        ON production_batches (company_id, work_order_id);
CREATE INDEX IF NOT EXISTS idx_pb_completed_at      ON production_batches (company_id, completed_at);

COMMENT ON TABLE production_batches IS
  'Immutable production batch records. One row per completion event on a WO. '
  'Tracks yield, wastage, and cost at the batch level. '
  'Never updated after creation.';


-- ─── STEP 4: Create production_wastage ──────────────────────────────────────
-- One row per wastage event within a batch.
-- Immutable after creation — forensic audit trail.

CREATE TABLE IF NOT EXISTS production_wastage (
  id                BIGSERIAL       PRIMARY KEY,
  company_id        INTEGER         NOT NULL,
  batch_id          BIGINT          NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  work_order_id     INTEGER         NOT NULL,

  -- What was wasted
  item_id           INTEGER         NULL,       -- null = finished-good wastage (yield loss)
  wastage_qty       NUMERIC(18,4)   NOT NULL,
  wastage_reason    VARCHAR(50)     NOT NULL DEFAULT 'unknown',
  estimated_value   NUMERIC(15,4)   NOT NULL DEFAULT 0,
  notes             TEXT            NULL,

  -- Audit
  created_by        INTEGER         REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pw_qty_positive CHECK (wastage_qty > 0),
  CONSTRAINT chk_pw_reason CHECK (wastage_reason IN (
    'spoilage',
    'damage',
    'trimming_loss',
    'process_loss',
    'machine_error',
    'operator_error',
    'unknown',
    'other'
  ))
);

CREATE INDEX IF NOT EXISTS idx_pw_company          ON production_wastage (company_id);
CREATE INDEX IF NOT EXISTS idx_pw_company_batch    ON production_wastage (company_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_pw_company_wo       ON production_wastage (company_id, work_order_id);
CREATE INDEX IF NOT EXISTS idx_pw_company_item     ON production_wastage (company_id, item_id);

COMMENT ON TABLE production_wastage IS
  'Immutable wastage records linked to a production batch. '
  'Never updated after creation. Each row records one wastage event with reason.';


-- ─── STEP 5: Create production_variances ────────────────────────────────────
-- Computed at batch completion — one row per material per batch.
-- Records expected vs actual material consumption.
-- Immutable after creation.

CREATE TABLE IF NOT EXISTS production_variances (
  id                    BIGSERIAL       PRIMARY KEY,
  company_id            INTEGER         NOT NULL,
  batch_id              BIGINT          NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  work_order_id         INTEGER         NOT NULL,
  item_id               INTEGER         NOT NULL,

  -- Expected vs actual
  required_qty          NUMERIC(18,4)   NOT NULL,   -- from work_order_materials
  actual_qty            NUMERIC(18,4)   NOT NULL,   -- issued_qty at completion
  variance_qty          NUMERIC(18,4)   NOT NULL,   -- actual_qty - required_qty (positive = over-used)
  variance_direction    VARCHAR(20)     NOT NULL DEFAULT 'none',

  -- Valuation
  unit_cost             NUMERIC(15,4)   NOT NULL DEFAULT 0,
  variance_value        NUMERIC(15,4)   NOT NULL DEFAULT 0,  -- variance_qty * unit_cost

  notes                 TEXT            NULL,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pv_variance_direction CHECK (variance_direction IN ('over', 'under', 'none'))
);

CREATE INDEX IF NOT EXISTS idx_pv_company        ON production_variances (company_id);
CREATE INDEX IF NOT EXISTS idx_pv_company_batch  ON production_variances (company_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_pv_company_wo     ON production_variances (company_id, work_order_id);
CREATE INDEX IF NOT EXISTS idx_pv_company_item   ON production_variances (company_id, item_id);

COMMENT ON TABLE production_variances IS
  'Immutable material variance records computed at batch completion. '
  'One row per material per batch. Positive variance_qty = over-consumed vs BOM.';


-- ─── STEP 6: Create production_labour_entries (placeholder) ─────────────────

CREATE TABLE IF NOT EXISTS production_labour_entries (
  id                BIGSERIAL       PRIMARY KEY,
  company_id        INTEGER         NOT NULL,
  batch_id          BIGINT          NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  work_order_id     INTEGER         NOT NULL,

  duration_minutes  INTEGER         NOT NULL DEFAULT 0,
  labour_cost       NUMERIC(15,4)   NOT NULL DEFAULT 0,
  notes             TEXT            NULL,

  created_by        INTEGER         REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ple_duration_nonneg CHECK (duration_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ple_company_batch ON production_labour_entries (company_id, batch_id);

COMMENT ON TABLE production_labour_entries IS
  'Placeholder for future MES labour tracking. '
  'Basic fields only — duration and cost per batch. No scheduling in Codebox 06.';


-- ─── STEP 7: Create production_machine_entries (placeholder) ─────────────────

CREATE TABLE IF NOT EXISTS production_machine_entries (
  id                BIGSERIAL       PRIMARY KEY,
  company_id        INTEGER         NOT NULL,
  batch_id          BIGINT          NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
  work_order_id     INTEGER         NOT NULL,

  machine_id        VARCHAR(100)    NULL,
  duration_minutes  INTEGER         NOT NULL DEFAULT 0,
  machine_cost      NUMERIC(15,4)   NOT NULL DEFAULT 0,
  notes             TEXT            NULL,

  created_by        INTEGER         REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pme_duration_nonneg CHECK (duration_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pme_company_batch ON production_machine_entries (company_id, batch_id);

COMMENT ON TABLE production_machine_entries IS
  'Placeholder for future MES machine tracking. '
  'Basic fields only — duration and cost per batch. No scheduling in Codebox 06.';


-- ─── STEP 8: Performance indexes ─────────────────────────────────────────────

-- Index for production dashboard queries (recent completions)
CREATE INDEX IF NOT EXISTS idx_pb_company_status
  ON production_batches (company_id, status, completed_at DESC);

-- Index for yield report queries
CREATE INDEX IF NOT EXISTS idx_wo_yield
  ON work_orders (company_id, status, actual_yield_percent)
  WHERE status IN ('completed', 'closed');
