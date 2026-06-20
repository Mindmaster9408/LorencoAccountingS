-- ============================================================================
-- Migration 066: Practice Engagement → Workflow Generation (Codebox 15)
-- Date: 2026-06-20
-- Purpose:
--   Extend four existing tables to support traceable, manual workflow generation
--   from a client engagement. Adds generation tracking on engagements and
--   engagement/service traceability columns on runs, deadlines, and tasks.
-- Safety:
--   - ADD COLUMN IF NOT EXISTS throughout — safe to re-run
--   - No table drops, no column drops, no type changes
--   - All new columns are nullable (except generation_count with DEFAULT 0)
--   - Partial indexes used where column is frequently null
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extend practice_client_engagements
--    Track the last generation attempt and a running count.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_client_engagements
  ADD COLUMN IF NOT EXISTS last_generated_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_generated_workflow_run_id BIGINT,
  ADD COLUMN IF NOT EXISTS last_generated_deadline_id     INTEGER,
  ADD COLUMN IF NOT EXISTS generation_count               INTEGER NOT NULL DEFAULT 0;

-- Index to quickly look up the workflow run that was last generated from an engagement
CREATE INDEX IF NOT EXISTS idx_engagements_last_run
  ON practice_client_engagements(last_generated_workflow_run_id)
  WHERE last_generated_workflow_run_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Extend practice_workflow_runs
--    Store the engagement + service catalog IDs that triggered this run.
--    generation_source differentiates HOW the run was created:
--      manual             — triggered directly from the workflow page
--      engagement         — triggered via generate-workflow from an engagement
--      workflow_template  — triggered from the template editor / preview
--      future_scheduler   — reserved for future cron/queue integration
--    Note: source_type (existing) captures the broad trigger class (manual/scheduled/api).
--          generation_source captures the specific UI/context origin.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS engagement_id     INTEGER,
  ADD COLUMN IF NOT EXISTS service_id        INTEGER,
  ADD COLUMN IF NOT EXISTS generation_source TEXT;

CREATE INDEX IF NOT EXISTS idx_pwr_engagement_id
  ON practice_workflow_runs(engagement_id)
  WHERE engagement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pwr_service_id
  ON practice_workflow_runs(service_id)
  WHERE service_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Extend practice_deadlines
--    Link generated deadlines back to the engagement and service catalog entry.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS engagement_id INTEGER,
  ADD COLUMN IF NOT EXISTS service_id    INTEGER;

CREATE INDEX IF NOT EXISTS idx_pd_engagement_id
  ON practice_deadlines(engagement_id)
  WHERE engagement_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Extend practice_tasks
--    Link generated tasks back to the engagement and service catalog entry.
--    (workflow_run_id and deadline_id already exist from migration 059)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS engagement_id INTEGER,
  ADD COLUMN IF NOT EXISTS service_id    INTEGER;

CREATE INDEX IF NOT EXISTS idx_pt_engagement_id
  ON practice_tasks(engagement_id)
  WHERE engagement_id IS NOT NULL;

COMMIT;


-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run after migration to confirm all columns and indexes were created.
--
-- SELECT table_name, column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name IN (
--   'practice_client_engagements',
--   'practice_workflow_runs',
--   'practice_deadlines',
--   'practice_tasks'
-- )
--   AND column_name IN (
--     'last_generated_at', 'last_generated_workflow_run_id', 'last_generated_deadline_id',
--     'generation_count', 'engagement_id', 'service_id', 'generation_source'
--   )
-- ORDER BY table_name, column_name;
--
-- SELECT indexname, tablename FROM pg_indexes
-- WHERE indexname IN (
--   'idx_engagements_last_run',
--   'idx_pwr_engagement_id', 'idx_pwr_service_id',
--   'idx_pd_engagement_id',
--   'idx_pt_engagement_id'
-- )
-- ORDER BY tablename, indexname;
-- Expect: 5 rows
