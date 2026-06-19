-- =============================================================================
-- Migration 063: Practice Management — Billing Pack Report Tracking
-- =============================================================================
-- Run in Supabase SQL Editor AFTER migration 062.
--
-- What this migration does:
--   Adds 3 optional tracking columns to practice_billing_packs so the system
--   can record when and by whom a billing report was last generated, and track
--   a report version counter for change detection.
--
-- Design rules:
--   - Only adds columns — no drops, no modifies
--   - ADD COLUMN IF NOT EXISTS — safe re-run
--   - All columns nullable except report_version (has default)
-- =============================================================================

BEGIN;

ALTER TABLE practice_billing_packs
    ADD COLUMN IF NOT EXISTS report_generated_at   TIMESTAMPTZ;

ALTER TABLE practice_billing_packs
    ADD COLUMN IF NOT EXISTS report_generated_by   INTEGER;

ALTER TABLE practice_billing_packs
    ADD COLUMN IF NOT EXISTS report_version        INTEGER NOT NULL DEFAULT 1;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'practice_billing_packs'
  AND column_name IN ('report_generated_at', 'report_generated_by', 'report_version')
ORDER BY column_name;
