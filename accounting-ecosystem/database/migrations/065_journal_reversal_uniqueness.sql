-- ============================================================================
-- Migration 065: Journal Reversal Uniqueness Constraint
-- ============================================================================
-- Purpose:
--   Prevents two reversal journals from referencing the same original journal.
--   This is the database-level enforcement against concurrent double-reversal.
--
-- Context:
--   journals.reversal_of_journal_id is already present (schema 012).
--   No unique constraint exists — two concurrent reversal requests could both
--   INSERT a reversal journal for the same original, then both UPDATE the
--   original's reversed_by_journal_id (last-write-wins → orphaned first reversal,
--   accounting double-reversed).
--
--   This constraint catches the race at the INSERT step:
--   - First reversal: INSERT with reversal_of_journal_id = X → succeeds
--   - Second reversal: INSERT with reversal_of_journal_id = X → 23505 unique violation
--   The second transaction rolls back immediately. No double-reversal.
--
-- Design (mirrors the idempotency pattern from migration 026 and 064):
--   - Partial UNIQUE INDEX: only non-null reversal_of_journal_id participates.
--   - Normal (non-reversal) journals retain reversal_of_journal_id = NULL → unaffected.
--   - A reversal of a reversal is still permitted (it points to the reversal journal,
--     not the original — a different value in the index).
--
-- Combined with the conditional UPDATE guard added to JournalService.reverseJournal
-- (AND status='posted' AND reversed_by_journal_id IS NULL), this provides two
-- independent layers of concurrent double-reversal protection:
--   Layer 1 (application): conditional UPDATE → rowCount=0 → ROLLBACK
--   Layer 2 (database):    unique INSERT violation → ROLLBACK
-- Either layer alone is sufficient; both together eliminate the race completely.
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 012_accounting_schema.sql (journals table with reversal_of_journal_id)
-- Safe: CREATE UNIQUE INDEX IF NOT EXISTS — no data change, no row removal
--       Only fails if duplicate reversal_of_journal_id already exists (data corruption).
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_reversal_source
  ON journals (reversal_of_journal_id)
  WHERE reversal_of_journal_id IS NOT NULL;

COMMENT ON INDEX idx_journals_reversal_source IS
  'Prevents two reversal journals from pointing to the same original journal. '
  'Database-level enforcement against concurrent double-reversal.';

-- ============================================================================
-- Verification query (run after applying):
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'journals'
--     AND indexname = 'idx_journals_reversal_source';
--
-- Expected: one row returned showing the partial unique index.
-- ============================================================================
