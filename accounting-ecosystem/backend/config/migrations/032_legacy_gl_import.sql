-- =============================================================================
-- Migration 032: Legacy GL Import System (ACC-SIDEQUEST-001)
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Purpose: Creates the full staging and audit infrastructure for importing
--   historical General Ledger data from legacy accounting systems
--   (Sage, Xero, QuickBooks, Pastel, Excel/CSV exports).
--
-- Tables created:
--   1. legacy_gl_import_batches    — one row per uploaded file / import attempt
--   2. legacy_gl_import_lines      — one row per data row in the uploaded file
--   3. legacy_gl_account_mappings  — saved source→target account mappings (reused)
--
-- journals table extended:
--   4. is_locked      BOOLEAN NOT NULL DEFAULT FALSE
--   5. legacy_batch_id INTEGER NULL FK → legacy_gl_import_batches
--
-- Security notes:
--   - legacy_batch_id + is_locked on journals identifies and locks imported rows
--   - No automatic GL posting; import only proceeds after user approval
--   - No VAT period assignment for imported journals (historical data)
-- =============================================================================

BEGIN;

-- ─── 1. legacy_gl_import_batches ─────────────────────────────────────────────
-- One row per uploaded file. Tracks the full lifecycle from staging through import.

CREATE TABLE IF NOT EXISTS legacy_gl_import_batches (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- File identity
  file_name             TEXT NOT NULL,
  file_hash             TEXT NOT NULL,               -- SHA-256 of uploaded file
  source_system         TEXT NOT NULL DEFAULT 'other'
                          CHECK (source_system IN ('sage','xero','quickbooks','pastel','excel','csv','other')),
  import_period_start   DATE,                        -- optional: expected data date range
  import_period_end     DATE,

  -- Batch lifecycle status
  -- staged             → file uploaded, rows staged, column detection complete
  -- validation_failed  → validation run, errors found
  -- ready_for_approval → validation passed (may have warnings)
  -- approved           → authorised user has reviewed and approved
  -- importing          → import job in progress
  -- imported           → GL journals created, batch locked
  -- failed             → import job encountered a fatal error
  -- cancelled          → abandoned before import
  status                TEXT NOT NULL DEFAULT 'staged'
                          CHECK (status IN (
                            'staged','validation_failed','ready_for_approval',
                            'approved','importing','imported','failed','cancelled'
                          )),

  -- Detected column mapping (stored as JSONB for auditability)
  detected_columns      JSONB,

  -- Line counts (updated after staging and after mapping)
  total_lines           INTEGER NOT NULL DEFAULT 0,
  mapped_lines          INTEGER NOT NULL DEFAULT 0,
  unmapped_lines        INTEGER NOT NULL DEFAULT 0,
  skipped_lines         INTEGER NOT NULL DEFAULT 0,

  -- Validation results (updated when validate endpoint is called)
  validation_summary    JSONB,

  -- Import result
  journals_created      INTEGER NOT NULL DEFAULT 0,
  total_debits          NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_credits         NUMERIC(15,2) NOT NULL DEFAULT 0,
  import_error          TEXT,

  -- Governance
  notes                 TEXT,
  approved_by_user_id   INTEGER,
  approved_at           TIMESTAMPTZ,
  imported_by_user_id   INTEGER,
  imported_at           TIMESTAMPTZ,
  created_by_user_id    INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent re-importing the same file while a non-cancelled batch already exists
CREATE UNIQUE INDEX IF NOT EXISTS uq_legacy_gl_batch_hash
  ON legacy_gl_import_batches(company_id, file_hash)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_legacy_gl_batches_company
  ON legacy_gl_import_batches(company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_legacy_gl_batches_status
  ON legacy_gl_import_batches(company_id, status);

-- ─── 2. legacy_gl_import_lines ───────────────────────────────────────────────
-- One row per data row in the uploaded file.
-- Stores raw extracted values plus mapping/validation state.

CREATE TABLE IF NOT EXISTS legacy_gl_import_lines (
  id                    SERIAL PRIMARY KEY,
  batch_id              INTEGER NOT NULL REFERENCES legacy_gl_import_batches(id) ON DELETE CASCADE,
  company_id            INTEGER NOT NULL,            -- denormalised for query performance

  -- Source position
  source_row_number     INTEGER NOT NULL,            -- 1-based row in original file (excl. header)

  -- Raw extracted values
  transaction_date      DATE,
  source_account_code   TEXT,
  source_account_name   TEXT,
  source_description    TEXT,
  source_reference      TEXT,
  debit                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit                NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_currency       TEXT NOT NULL DEFAULT 'ZAR',

  -- Account mapping
  mapped_account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  mapping_source        TEXT CHECK (mapping_source IN ('auto','manual','saved')),
  mapping_status        TEXT NOT NULL DEFAULT 'unmapped'
                          CHECK (mapping_status IN ('unmapped','mapped','skipped')),

  -- Validation
  validation_status     TEXT NOT NULL DEFAULT 'pending'
                          CHECK (validation_status IN ('pending','pass','warning','fail')),
  validation_notes      TEXT,

  -- Import result (set after journals are created)
  journal_id            INTEGER,                     -- nullable; no FK (journals may be deleted)

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legacy_gl_lines_batch
  ON legacy_gl_import_lines(batch_id);

CREATE INDEX IF NOT EXISTS idx_legacy_gl_lines_company_batch
  ON legacy_gl_import_lines(company_id, batch_id);

CREATE INDEX IF NOT EXISTS idx_legacy_gl_lines_mapping_status
  ON legacy_gl_import_lines(batch_id, mapping_status);

CREATE INDEX IF NOT EXISTS idx_legacy_gl_lines_source_account
  ON legacy_gl_import_lines(company_id, source_account_code, source_account_name);

-- ─── 3. legacy_gl_account_mappings ───────────────────────────────────────────
-- Saved source account → target GL account mappings.
-- Automatically applied to new uploads for the same company.

CREATE TABLE IF NOT EXISTS legacy_gl_account_mappings (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_account_code   TEXT,
  source_account_name   TEXT,
  mapped_account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by_user_id    INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One saved mapping per (company, source_code, source_name) triple.
-- COALESCE('', ...) normalises NULLs so they participate in uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uq_legacy_gl_account_mappings
  ON legacy_gl_account_mappings(
    company_id,
    COALESCE(source_account_code, ''),
    COALESCE(source_account_name, '')
  );

CREATE INDEX IF NOT EXISTS idx_legacy_gl_mappings_company
  ON legacy_gl_account_mappings(company_id);

-- ─── 4. Extend journals table ─────────────────────────────────────────────────
-- is_locked:       TRUE for imported legacy journals; editing/reversal blocked
-- legacy_batch_id: links imported journals back to their import batch

ALTER TABLE journals
  ADD COLUMN IF NOT EXISTS is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS legacy_batch_id INTEGER REFERENCES legacy_gl_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journals_legacy_batch
  ON journals(legacy_batch_id)
  WHERE legacy_batch_id IS NOT NULL;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name IN (
  'legacy_gl_import_batches',
  'legacy_gl_import_lines',
  'legacy_gl_account_mappings'
)
ORDER BY table_name, ordinal_position;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'journals'
  AND column_name IN ('is_locked', 'legacy_batch_id')
ORDER BY column_name;
