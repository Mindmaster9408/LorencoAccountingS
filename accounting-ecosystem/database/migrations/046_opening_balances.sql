-- =============================================================================
-- Migration 046 — Opening Balance / Prior Year Trial Balance Import Engine
-- =============================================================================
-- Creates the tables required for the Opening Balance Import feature:
--   1. opening_balance_batches   — one batch per prior-year TB import
--   2. opening_balance_lines     — individual account/amount rows within a batch
--   3. opening_balance_audit_log — immutable audit trail for all batch mutations
--
-- Design notes:
--   - company_id is INTEGER throughout (matches all other tables in this schema)
--   - user ids (created_by, finalized_by) are INTEGER (matches users.id SERIAL)
--   - journal_id is INTEGER FK to journals.id (SERIAL) — null until finalized
--   - UUIDs used for batch and line ids (consistent with historical_comparatives)
--   - debit/credit are separate columns (not signed amount) — consistent with
--     journal_lines convention
--   - variance = debit_total - credit_total is stored explicitly (not generated)
--     so it can be read by the service-role Supabase client without GENERATED
--     ALWAYS column compatibility concerns
--   - All writes go through the service layer; RLS added for safety but the
--     backend uses service-role key which bypasses RLS
-- =============================================================================

-- ─── 1. Opening Balance Batches ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opening_balance_batches (
  id                UUID        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id        INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by        INTEGER     NOT NULL,                          -- users.id
  source_type       TEXT        NOT NULL DEFAULT 'manual',        -- manual | csv_import | xero | sage | pastel | other
  source_name       TEXT        NOT NULL,                         -- human label e.g. "Xero TB 28 Feb 2024"
  effective_date    DATE        NOT NULL,                         -- TB cutoff date
  description       TEXT,
  status            TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'validated', 'finalized', 'archived')),
  debit_total       NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance          NUMERIC(18,2) NOT NULL DEFAULT 0,             -- debit_total - credit_total; updated by service
  finalized_at      TIMESTAMPTZ,
  finalized_by      INTEGER,                                      -- users.id
  journal_id        INTEGER,                                      -- journals.id — set on finalization
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ob_batches_company
  ON opening_balance_batches(company_id);

CREATE INDEX IF NOT EXISTS idx_ob_batches_company_status
  ON opening_balance_batches(company_id, status);

-- ─── 2. Opening Balance Lines ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opening_balance_lines (
  id                    UUID        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  batch_id              UUID        NOT NULL REFERENCES opening_balance_batches(id) ON DELETE CASCADE,
  company_id            INTEGER     NOT NULL,                         -- denormalized for fast queries
  source_account_code   TEXT,                                         -- code as it appeared in the source TB
  source_account_name   TEXT,                                         -- name as it appeared in the source TB
  mapped_account_id     INTEGER,                                      -- accounts.id — null if not yet mapped
  mapped_account_code   TEXT,                                         -- snapshot of code at time of mapping
  mapped_account_name   TEXT,                                         -- snapshot of name at time of mapping
  debit                 NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit                NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_status           TEXT        NOT NULL DEFAULT 'unmapped'
                        CHECK (line_status IN ('unmapped', 'mapped', 'excluded')),
  source_row_number     INTEGER,                                      -- original row in source file (for CSV imports)
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ob_lines_batch
  ON opening_balance_lines(batch_id);

CREATE INDEX IF NOT EXISTS idx_ob_lines_company
  ON opening_balance_lines(company_id);

CREATE INDEX IF NOT EXISTS idx_ob_lines_mapped_account
  ON opening_balance_lines(mapped_account_id)
  WHERE mapped_account_id IS NOT NULL;

-- ─── 3. Opening Balance Audit Log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opening_balance_audit_log (
  id            UUID        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id    INTEGER     NOT NULL,
  batch_id      UUID        NOT NULL REFERENCES opening_balance_batches(id) ON DELETE CASCADE,
  line_id       UUID        REFERENCES opening_balance_lines(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,                               -- line_created | line_updated | line_deleted | line_mapped | line_unmapped | line_excluded | batch_validated | batch_finalized | batch_archived
  old_value     JSONB,
  new_value     JSONB,
  performed_by  INTEGER     NOT NULL,                              -- users.id
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_ob_audit_batch
  ON opening_balance_audit_log(batch_id);

CREATE INDEX IF NOT EXISTS idx_ob_audit_company
  ON opening_balance_audit_log(company_id, performed_at DESC);

-- ─── RLS (service-role key bypasses; guards direct client access) ────────────
ALTER TABLE opening_balance_batches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_audit_log ENABLE ROW LEVEL SECURITY;

-- All access via service-role key only — no authenticated-user RLS policy needed
-- (backend enforces company scoping in every query)
