-- ============================================================================
-- Migration 021: SEAN Transaction Store — Add Draft Save Fields
-- ============================================================================
-- Adds fields to support the "Save Draft" workflow for the Paytime Payroll
-- Item Learning Queue review modal.
--
-- GOVERNANCE (CLAUDE.md Part B — Rule B6/B9):
--   - SAVE ≠ APPROVE. These fields store in-progress reviewer edits only.
--   - draft_payload stores the reviewer's edits without overwriting the
--     original `payload` or touching `status`.
--   - `status` remains 'pending' after a draft save — no sync occurs.
--   - The full audit trail uses sean_sync_log with action='draft_saved'.
--
-- Run this in Supabase SQL Editor BEFORE deploying the matching backend code.
-- ============================================================================

-- Add draft payload column (reviewer's in-progress edits, does not replace payload)
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS draft_payload   JSONB;

-- Add reviewer notes column (internal notes from reviewer, not approval notes)
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS draft_notes     TEXT;

-- Add audit columns for draft save tracking
ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS last_edited_by  VARCHAR(255);

ALTER TABLE sean_transaction_store
    ADD COLUMN IF NOT EXISTS last_edited_at  TIMESTAMPTZ;

-- Widen the action column on sean_sync_log to accommodate detailed action names
-- (e.g. 'payroll_item_learning_draft_saved' = 36 chars)
ALTER TABLE sean_sync_log
    ALTER COLUMN action TYPE VARCHAR(60);

-- Index for finding items with in-progress drafts
CREATE INDEX IF NOT EXISTS idx_sean_ts_draft
    ON sean_transaction_store (last_edited_at)
    WHERE draft_payload IS NOT NULL;

-- ============================================================================
-- Summary of new columns on sean_transaction_store:
--
--   draft_payload   JSONB        — reviewer's in-progress edits (safe to read,
--                                  overwrite, or discard without data loss)
--   draft_notes     TEXT         — reviewer's working notes (internal only)
--   last_edited_by  VARCHAR(255) — email/id of who last saved draft
--   last_edited_at  TIMESTAMPTZ  — when draft was last saved
--
-- These fields are written only by PATCH /api/sean/store/:id/draft.
-- They do NOT affect status, proposed_value, payload, or sync logic.
-- ============================================================================
