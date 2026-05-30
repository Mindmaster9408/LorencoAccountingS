-- ============================================================================
-- Migration 062: SEAN Transaction Store — Add Teach Sean fields
-- ============================================================================
-- Purpose:
--   Adds three fields to sean_transaction_store to support the Teach Sean
--   → Paytime Learning Proposals flow:
--
--   source_channel  — identifies HOW the item entered the store:
--                     'teach_sean' | 'paytime_event' | 'api' | NULL (legacy)
--
--   confidence      — parser/extraction confidence score (0.0–1.0).
--                     0.95 = CSV with known IRP5 code
--                     0.50 = item name only, no IRP5 code
--
--   import_batch_id — UUID linking all items from a single Teach Sean session.
--                     Allows the review queue to group and filter by import.
--
-- GOVERNANCE (CLAUDE.md Part B):
--   These fields are read/write by the Teach Sean parse + propose routes.
--   They are INFORMATIONAL only — they do NOT affect approval or sync logic.
--   All existing store items retain NULL for these new fields (safe, backward-
--   compatible).
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 020/021 migrations already applied
-- Safe: ADD COLUMN IF NOT EXISTS — no data loss, no existing rows affected
-- ============================================================================

-- source_channel: how the item entered the store
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS source_channel  VARCHAR(30);

COMMENT ON COLUMN sean_transaction_store.source_channel IS
  'Entry channel: teach_sean | paytime_event | api | NULL for legacy items';

-- confidence: parser extraction confidence (0.0–1.0)
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS confidence      NUMERIC(4,3)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

COMMENT ON COLUMN sean_transaction_store.confidence IS
  'Extraction confidence score (0.0 = uncertain, 1.0 = verified)';

-- import_batch_id: groups items from a single Teach Sean import session
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS import_batch_id UUID;

COMMENT ON COLUMN sean_transaction_store.import_batch_id IS
  'UUID grouping all items from one Teach Sean import session';

-- Index for filtering by teach session
CREATE INDEX IF NOT EXISTS idx_sean_ts_teach_batch
    ON sean_transaction_store (import_batch_id)
    WHERE import_batch_id IS NOT NULL;

-- Index for filtering by source channel
CREATE INDEX IF NOT EXISTS idx_sean_ts_source_channel
    ON sean_transaction_store (source_channel)
    WHERE source_channel IS NOT NULL;

-- ============================================================================
-- Summary of new columns on sean_transaction_store:
--
--   source_channel  VARCHAR(30)  — 'teach_sean', 'paytime_event', 'api', NULL
--   confidence      NUMERIC(4,3) — 0.0–1.0, parser confidence
--   import_batch_id UUID         — groups items from one Teach Sean session
--
-- All columns are nullable — no default required.
-- All existing rows are unaffected (remain NULL for new columns).
-- ============================================================================
