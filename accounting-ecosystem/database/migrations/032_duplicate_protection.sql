-- ============================================================================
-- Migration 032: Duplicate Protection Columns
-- ============================================================================
-- Purpose:
--   Adds structured duplicate-detection tracking to bank_transaction_staging
--   so the staging review UI can warn accountants about suspected duplicate
--   imports before they confirm transactions into bank_transactions.
--
-- Changes:
--   1. bank_transaction_staging — add duplicate tracking columns:
--        normalized_description TEXT        — lowercased, stripped description for fuzzy match
--        duplicate_status VARCHAR(20)        — NONE|POSSIBLE|CONFIRMED|OVERRIDDEN
--        duplicate_confidence NUMERIC(4,3)   — 0.0-1.0 confidence score
--        duplicate_reason TEXT               — human-readable reason for the flag
--        duplicate_group_id UUID             — groups related suspected-duplicate rows
--        source_file_hash TEXT               — SHA-256 of the source file (PDF/CSV)
--        override_user_id INTEGER            — user who overrode the duplicate warning
--        override_reason TEXT                — free-text override justification
--        override_at TIMESTAMPTZ             — timestamp of override
--
-- Safety: all changes are additive (ADD COLUMN IF NOT EXISTS).
-- Run in: Supabase SQL Editor
-- Prerequisite: 031_bank_staging_hardening.sql must already be applied
-- ============================================================================

-- ── 1. Add duplicate tracking columns to bank_transaction_staging ────────────

ALTER TABLE bank_transaction_staging
  ADD COLUMN IF NOT EXISTS normalized_description TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_status       VARCHAR(20) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS duplicate_confidence   NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS duplicate_reason       TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_group_id     UUID,
  ADD COLUMN IF NOT EXISTS source_file_hash       TEXT,
  ADD COLUMN IF NOT EXISTS override_user_id       INTEGER,
  ADD COLUMN IF NOT EXISTS override_reason        TEXT,
  ADD COLUMN IF NOT EXISTS override_at            TIMESTAMPTZ;

-- ── 2. Add CHECK constraint for duplicate_status ─────────────────────────────

ALTER TABLE bank_transaction_staging
  DROP CONSTRAINT IF EXISTS bank_transaction_staging_duplicate_status_check;

ALTER TABLE bank_transaction_staging
  ADD CONSTRAINT bank_transaction_staging_duplicate_status_check
  CHECK (duplicate_status IN (
    'NONE',        -- no duplicate detected
    'POSSIBLE',    -- fuzzy amount+date match found — user must review
    'CONFIRMED',   -- accountant confirmed this IS a duplicate (will not import)
    'OVERRIDDEN'   -- accountant reviewed and explicitly approved import despite match
  ));

COMMENT ON COLUMN bank_transaction_staging.duplicate_status IS
  'Duplicate detection result: NONE|POSSIBLE|CONFIRMED|OVERRIDDEN';
COMMENT ON COLUMN bank_transaction_staging.normalized_description IS
  'Lowercased, punctuation-stripped description used for fuzzy duplicate matching';
COMMENT ON COLUMN bank_transaction_staging.source_file_hash IS
  'SHA-256 hash of the source file (PDF/image) — used for whole-batch duplicate detection';
COMMENT ON COLUMN bank_transaction_staging.duplicate_group_id IS
  'Groups staging rows that are suspected duplicates of each other';

-- ── 3. Performance indexes for duplicate detection ───────────────────────────

-- Normalized description search (for description-based dedup)
CREATE INDEX IF NOT EXISTS idx_bts_normalized_desc
  ON bank_transaction_staging (company_id, bank_account_id, normalized_description)
  WHERE normalized_description IS NOT NULL AND match_status NOT IN ('REJECTED');

-- File hash search (for whole-batch dedup)
CREATE INDEX IF NOT EXISTS idx_bts_source_file_hash
  ON bank_transaction_staging (company_id, source_file_hash)
  WHERE source_file_hash IS NOT NULL;

-- Duplicate group lookup
CREATE INDEX IF NOT EXISTS idx_bts_dup_group
  ON bank_transaction_staging (duplicate_group_id)
  WHERE duplicate_group_id IS NOT NULL;

-- Duplicate status filter (for staging UI tab counts)
CREATE INDEX IF NOT EXISTS idx_bts_dup_status
  ON bank_transaction_staging (company_id, duplicate_status)
  WHERE duplicate_status != 'NONE';
