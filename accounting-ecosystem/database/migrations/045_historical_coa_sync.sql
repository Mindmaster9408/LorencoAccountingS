-- ============================================================================
-- Migration 045 — Historical Comparatives: COA Sync Account List
-- ============================================================================
-- Adds a helper table that records which Chart of Accounts accounts are in
-- scope for a historical comparative batch. This allows the capture grid to
-- show accounts from the COA automatically without pre-creating 12 × N
-- monthly zero-value line rows.
--
-- Monthly line rows in historical_comparative_lines are only created when the
-- user actually enters a value. The batch_accounts table is the account list;
-- the lines table is the value store.
--
-- Also adds snapshot columns to historical_comparative_lines so that finalized
-- batches permanently record the account name/code/type that was captured,
-- even if the COA changes later.
--
-- Safe to re-run: CREATE TABLE uses IF NOT EXISTS; ADD COLUMN uses IF NOT EXISTS.
-- ============================================================================

-- ── TABLE: historical_comparative_batch_accounts ─────────────────────────────
-- One row per account in scope for a batch.
-- Populated by the sync-accounts endpoint.
-- Synced rows with is_postable = false are group/header rows only (not editable).
-- Synced rows with is_postable = true are editable capture rows.
CREATE TABLE IF NOT EXISTS historical_comparative_batch_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES historical_comparative_batches(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Reference to live COA account (nullable: may be null for freetext accounts)
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  account_code      TEXT NOT NULL,
  account_name      TEXT NOT NULL,
  account_type      TEXT NOT NULL,

  -- Parent account for grouping display (null = root level)
  parent_account_id INTEGER,

  -- Snapshot of postability at time of sync
  is_postable       BOOLEAN NOT NULL DEFAULT true,

  -- true = parent/header row, displayed for grouping only, no editable cells
  is_group_row      BOOLEAN NOT NULL DEFAULT false,

  -- Controls display ordering within the capture grid
  display_order     NUMERIC,

  -- When this account was last synced into the batch
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A batch can only include an account once
  CONSTRAINT uq_hcba_batch_account UNIQUE (batch_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_hcba_batch_id
  ON historical_comparative_batch_accounts (batch_id);

CREATE INDEX IF NOT EXISTS idx_hcba_company_id
  ON historical_comparative_batch_accounts (company_id);

CREATE INDEX IF NOT EXISTS idx_hcba_account_id
  ON historical_comparative_batch_accounts (account_id);

-- ── Snapshot columns on historical_comparative_lines ─────────────────────────
-- These columns are populated at line-save time and preserve the account's
-- name, code, and type as it was at the time of capture. Finalized batches
-- continue to show the original snapshot even if the COA account is renamed.

ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS parent_account_id      INTEGER;

ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS account_code_snapshot  TEXT;

ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS account_name_snapshot  TEXT;

ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS account_type_snapshot  TEXT;

-- true = this line was captured via a COA-synced account (not freetext)
ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS synced_from_coa        BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE historical_comparative_lines
  ADD COLUMN IF NOT EXISTS coa_synced_at          TIMESTAMPTZ;
