-- =============================================================================
-- Migration 171 — Historical Comparatives -> General Ledger posting
-- =============================================================================
-- Adds the tracking columns needed to post a FINALIZED Historical
-- Comparatives batch to the real GL as dated, posted journal entries
-- (historicalComparativeGlPostingService.js) — a deliberate, reviewed,
-- one-way bridge, not a relaxation of historicalComparativesService.js's own
-- "never writes to journals" rule (that module is untouched by this).
--
-- posted_to_gl_at/by on the batch: idempotency guard + "Posted to GL on..."
-- UI label, mirroring the existing finalized_at/finalized_by columns on the
-- same table (migration 042).
--
-- journals.historical_comparative_batch_id: mirrors journals.legacy_batch_id
-- (migration 032) so every journal created by this feature can always be
-- traced back to the batch it came from.
--
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
-- =============================================================================

ALTER TABLE historical_comparative_batches
  ADD COLUMN IF NOT EXISTS posted_to_gl_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_to_gl_by INTEGER;

ALTER TABLE journals
  ADD COLUMN IF NOT EXISTS historical_comparative_batch_id UUID
    REFERENCES historical_comparative_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journals_historical_comparative_batch
  ON journals(historical_comparative_batch_id)
  WHERE historical_comparative_batch_id IS NOT NULL;
