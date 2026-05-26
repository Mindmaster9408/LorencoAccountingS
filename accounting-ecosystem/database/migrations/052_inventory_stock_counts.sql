-- ============================================================================
-- Migration 052 — Inventory Stock Counts & Variance Control
-- Codebox 03 of 12 — Lorenco Storehouse MrpEasy Pilot Path
-- ============================================================================
-- Prerequisite: migrations 050 and 051 must be applied first.
-- Creates:
--   stock_count_sessions  — count session header (per company, per count event)
--   stock_count_lines     — line-level count entries with system snapshot
--   stock_count_approvals — approval/rejection audit trail per session
-- ============================================================================

-- ─── stock_count_sessions ────────────────────────────────────────────────────
-- One row per count event. Tracks lifecycle from draft → applied.
-- blind_count: frontend hides system_quantity until submitted.
-- freeze_inventory: flag for future enforcement (deferred — see docs).
CREATE TABLE IF NOT EXISTS stock_count_sessions (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  session_number   VARCHAR(50) NOT NULL,           -- e.g. SC-20260601-4721
  warehouse_id     INTEGER NULL,                   -- NULL = all warehouses
  count_type       VARCHAR(30) NOT NULL DEFAULT 'full',
  status           VARCHAR(30) NOT NULL DEFAULT 'draft',
  started_by       INTEGER NULL,
  approved_by      INTEGER NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at     TIMESTAMPTZ NULL,
  approved_at      TIMESTAMPTZ NULL,
  applied_at       TIMESTAMPTZ NULL,
  notes            TEXT NULL,
  blind_count      BOOLEAN NOT NULL DEFAULT false,
  freeze_inventory BOOLEAN NOT NULL DEFAULT false, -- DEFERRED enforcement
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_scs_count_type CHECK (
    count_type IN ('full', 'cycle', 'spot', 'recount')
  ),
  CONSTRAINT chk_scs_status CHECK (
    status IN ('draft', 'in_progress', 'submitted', 'approved', 'rejected', 'applied', 'cancelled')
  ),
  CONSTRAINT uq_scs_session_number_company UNIQUE (company_id, session_number)
);

-- ─── stock_count_lines ───────────────────────────────────────────────────────
-- One row per item per count session.
-- system_quantity: snapshot of current_stock at session creation (immutable after insert).
-- counted_quantity: entered by the counter. NULL until counted.
-- variance_quantity / variance_value: calculated at submission time.
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  session_id        BIGINT NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL,
  system_quantity   NUMERIC(18,4) NOT NULL,         -- snapshot — never updated after insert
  counted_quantity  NUMERIC(18,4) NULL,              -- NULL = not yet counted
  variance_quantity NUMERIC(18,4) NULL,              -- counted - system (calculated on submit)
  average_cost      NUMERIC(18,4) NULL DEFAULT 0,   -- snapshot of avg cost at session creation
  variance_value    NUMERIC(18,4) NULL,              -- variance_quantity × average_cost
  variance_reason   VARCHAR(50) NULL,
  variance_notes    TEXT NULL,
  recounted         BOOLEAN NOT NULL DEFAULT false,
  recounted_by      INTEGER NULL,
  recounted_at      TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_scl_counted_qty_non_negative
    CHECK (counted_quantity IS NULL OR counted_quantity >= 0),

  CONSTRAINT chk_scl_variance_reason CHECK (
    variance_reason IS NULL OR variance_reason IN (
      'shrinkage', 'damage', 'theft', 'spoilage', 'production_loss',
      'counting_error', 'supplier_shortage', 'unknown', 'other'
    )
  )
);

-- ─── stock_count_approvals ───────────────────────────────────────────────────
-- Immutable audit trail of every approval action on a session.
-- Multiple rows possible if session is resubmitted after recount_required.
CREATE TABLE IF NOT EXISTS stock_count_approvals (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  session_id      BIGINT NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
  approved_by     INTEGER NOT NULL,
  approval_action VARCHAR(30) NOT NULL,
  approval_notes  TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_sca_action CHECK (
    approval_action IN ('approved', 'rejected', 'recount_required')
  )
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Sessions: list by company+status, company+date
CREATE INDEX IF NOT EXISTS idx_scs_company_id
  ON stock_count_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_scs_company_status
  ON stock_count_sessions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_scs_company_created
  ON stock_count_sessions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scs_company_warehouse
  ON stock_count_sessions(company_id, warehouse_id);

-- Lines: join from session, lookup by item
CREATE INDEX IF NOT EXISTS idx_scl_session_id
  ON stock_count_lines(session_id);
CREATE INDEX IF NOT EXISTS idx_scl_company_session
  ON stock_count_lines(company_id, session_id);
CREATE INDEX IF NOT EXISTS idx_scl_company_item
  ON stock_count_lines(company_id, item_id);

-- Approvals: join from session
CREATE INDEX IF NOT EXISTS idx_sca_session_id
  ON stock_count_approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_sca_company
  ON stock_count_approvals(company_id);

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run after migration to confirm tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('stock_count_sessions','stock_count_lines','stock_count_approvals');
-- Expected: 3 rows.
