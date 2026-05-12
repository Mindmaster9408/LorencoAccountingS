-- ============================================================================
-- Migration 031: Bank Staging Hardening
-- ============================================================================
-- Purpose:
--   Production hardening for the bank staging pipeline.
--   Adds rejection tracking to transfer links, adds DUPLICATE_SUSPECTED status
--   to the staging match_status enum, and adds performance indexes for
--   duplicate detection queries.
--
-- Changes:
--   1. bank_transfer_links  — add rejected/rejected_by/rejected_at/rejection_reason
--   2. bank_transaction_staging — extend match_status CHECK to include DUPLICATE_SUSPECTED
--   3. New index on bank_transaction_staging(company_id, bank_account_id, date, amount)
--      for efficient fuzzy duplicate detection
--   4. New index on bank_transactions(company_id, bank_account_id, date, amount)
--      for cross-table duplicate checks
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 020_bank_staging.sql must already be applied
-- Safe: all changes are additive (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
-- ============================================================================

-- ── 1. Add rejection tracking columns to bank_transfer_links ─────────────────
ALTER TABLE bank_transfer_links
  ADD COLUMN IF NOT EXISTS rejected         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rejected_by      INTEGER,       -- user ID who rejected
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

COMMENT ON COLUMN bank_transfer_links.rejected         IS 'TRUE when user dismisses this transfer suggestion';
COMMENT ON COLUMN bank_transfer_links.rejected_by      IS 'ID of the user who rejected this link';
COMMENT ON COLUMN bank_transfer_links.rejected_at      IS 'Timestamp when the link was rejected';
COMMENT ON COLUMN bank_transfer_links.rejection_reason IS 'Optional free-text reason provided by user';

-- ── 2. Extend match_status CHECK on bank_transaction_staging ─────────────────
-- Postgres does not support ALTER CONSTRAINT to extend the allowed values,
-- so we drop the inline CHECK and recreate it with the new value.
-- The auto-generated constraint name is bank_transaction_staging_match_status_check.

ALTER TABLE bank_transaction_staging
  DROP CONSTRAINT IF EXISTS bank_transaction_staging_match_status_check;

ALTER TABLE bank_transaction_staging
  ADD CONSTRAINT bank_transaction_staging_match_status_check
  CHECK (match_status IN (
    'UNMATCHED',           -- not yet reviewed
    'TRANSFER_DETECTED',   -- system found a probable counterpart
    'REVIEW_REQUIRED',     -- ambiguous — user must decide
    'CONFIRMED',           -- moved to bank_transactions
    'REJECTED',            -- user dismissed / will not import
    'DUPLICATE_SUSPECTED'  -- amount+date matches an existing or staged transaction
  ));

COMMENT ON COLUMN bank_transaction_staging.match_status IS
  'Workflow status: UNMATCHED|TRANSFER_DETECTED|REVIEW_REQUIRED|CONFIRMED|REJECTED|DUPLICATE_SUSPECTED';

-- ── 3. Performance index for duplicate detection ─────────────────────────────
-- Enables efficient CHECK: does this (company, account, date, amount) already exist?
CREATE INDEX IF NOT EXISTS idx_bts_dedup
  ON bank_transaction_staging (company_id, bank_account_id, date, amount)
  WHERE match_status NOT IN ('REJECTED');

-- ── 4. Matching index on bank_transactions for cross-table duplicate check ───
CREATE INDEX IF NOT EXISTS idx_bt_dedup
  ON bank_transactions (company_id, bank_account_id, date, amount);

-- ── 5. Index on bank_transfer_links for rejected flag ────────────────────────
CREATE INDEX IF NOT EXISTS idx_btl_rejected
  ON bank_transfer_links (company_id, rejected)
  WHERE rejected = FALSE;
