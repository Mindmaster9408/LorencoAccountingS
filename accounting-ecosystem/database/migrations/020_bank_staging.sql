-- ============================================================================
-- Migration 020: Bank Transaction Staging + Transfer Detection
-- ============================================================================
-- Purpose:
--   Creates a pre-confirmation staging buffer for imported bank transactions.
--   Transactions sit in staging until the user reviews and confirms them.
--   Only confirmed transactions move into bank_transactions (the live reconciliation table).
--
--   Transfer detection metadata is stored directly on staging rows so the
--   frontend can surface detected pairs before the user commits anything.
--
-- Tables created:
--   bank_transaction_staging  — pre-confirmation buffer (PDF/image/OCR imports)
--   bank_transfer_links       — detected interbank transfer pairs
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 019_year_end_close.sql must already be applied
-- ============================================================================

-- ── bank_transaction_staging ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transaction_staging (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  bank_account_id   INTEGER,           -- may be NULL if user hasn't matched yet
  date              DATE NOT NULL,
  description       TEXT NOT NULL,
  amount            NUMERIC(15,2) NOT NULL,
  reference         TEXT,
  external_id       TEXT,              -- stable hash from parser (for dedup)
  balance           NUMERIC(15,2),     -- running balance from statement (informational)

  -- Transfer detection results
  detected_type     VARCHAR(20) DEFAULT NULL
                    CHECK (detected_type IS NULL OR detected_type IN (
                      'TRANSFER','PAYMENT','RECEIPT','PETTY_CASH'
                    )),
  match_status      VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
                    CHECK (match_status IN (
                      'UNMATCHED',        -- not yet reviewed
                      'TRANSFER_DETECTED',-- system found a probable counterpart
                      'REVIEW_REQUIRED',  -- ambiguous — user must decide
                      'CONFIRMED',        -- moved to bank_transactions
                      'REJECTED'          -- user dismissed / will not import
                    )),
  confidence_score  NUMERIC(4,3)
                    CHECK (confidence_score IS NULL OR
                           (confidence_score >= 0 AND confidence_score <= 1)),

  -- Transfer pairing — points at the OTHER side of the transfer within staging
  transfer_pair_staging_id INTEGER REFERENCES bank_transaction_staging(id) ON DELETE SET NULL,

  -- Batch grouping — all rows from a single PDF/image upload share one UUID
  import_batch_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  import_source     VARCHAR(20) DEFAULT 'pdf'
                    CHECK (import_source IN ('pdf','image','csv','manual','api')),

  -- Link back to confirmed bank_transaction after confirmation
  confirmed_txn_id  INTEGER,           -- references bank_transactions(id), no FK to avoid cross-migration coupling

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── bank_transfer_links ───────────────────────────────────────────────────────
-- Tracks detected (and confirmed) interbank transfer pairs.
-- When a transfer is confirmed the accountant creates a Dr/Cr journal;
-- journal_id is recorded here for the audit trail.
CREATE TABLE IF NOT EXISTS bank_transfer_links (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,

  -- FROM side = the staging row where money LEFT the account (negative amount)
  staging_id_from INTEGER NOT NULL REFERENCES bank_transaction_staging(id) ON DELETE CASCADE,
  -- TO side = the staging row where money ARRIVED (positive amount)
  staging_id_to   INTEGER NOT NULL REFERENCES bank_transaction_staging(id) ON DELETE CASCADE,

  confidence      NUMERIC(4,3),        -- detection confidence at time of proposal
  detection_layer SMALLINT,            -- 1=keyword, 2=exact-amount, 3=fuzzy

  confirmed       BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_by    INTEGER,             -- user id who confirmed
  confirmed_at    TIMESTAMPTZ,

  -- Journal created when transfer is confirmed (Dr receiving account, Cr sending account)
  journal_id      INTEGER,             -- references journals(id), no FK to avoid cross-migration coupling

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bts_company_id
  ON bank_transaction_staging(company_id);
CREATE INDEX IF NOT EXISTS idx_bts_batch
  ON bank_transaction_staging(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_bts_bank_account
  ON bank_transaction_staging(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bts_match_status
  ON bank_transaction_staging(match_status);
CREATE INDEX IF NOT EXISTS idx_bts_date
  ON bank_transaction_staging(date);
CREATE INDEX IF NOT EXISTS idx_bts_external_id
  ON bank_transaction_staging(external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_btl_company_id
  ON bank_transfer_links(company_id);
CREATE INDEX IF NOT EXISTS idx_btl_staging_from
  ON bank_transfer_links(staging_id_from);
CREATE INDEX IF NOT EXISTS idx_btl_staging_to
  ON bank_transfer_links(staging_id_to);

-- ── updated_at auto-trigger ───────────────────────────────────────────────────
-- Only create the trigger function if it doesn't already exist (idempotent).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bts_updated_at ON bank_transaction_staging;
CREATE TRIGGER bts_updated_at
  BEFORE UPDATE ON bank_transaction_staging
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
