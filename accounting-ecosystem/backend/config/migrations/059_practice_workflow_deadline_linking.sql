-- =============================================================================
-- Migration 059: Practice Workflow-to-Deadline Linking
-- =============================================================================
-- Run in Supabase SQL Editor AFTER migration 058.
--
-- Design rules:
--   - Only adds columns — no drops, no modifies, safe re-run
--   - ADD COLUMN IF NOT EXISTS throughout
--   - practice_deadlines.workflow_run_id already exists (migration 058) — NOT re-added
--   - practice_deadlines.task_id already exists (migration 058) — NOT re-added
--   - practice_tasks.source_type / source_id already exist (migration 057) — NOT re-added
--
-- What this migration does:
--   A. Extends practice_workflow_templates with compliance/deadline defaults
--   B. Extends practice_workflow_runs with client_id + deadline link + compliance context
--   C. Extends practice_tasks with proper deadline_id FK and workflow_run_id FK
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Extend practice_workflow_templates
-- Templates can now carry default compliance metadata so the generate flow
-- can pre-fill deadline fields and optionally auto-create a deadline.
-- Note: practice_workflow_templates.id is BIGSERIAL; company_id is BIGINT.
-- ─────────────────────────────────────────────────────────────────────────────

-- Whether generating this template should prompt for / auto-create a deadline
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS creates_compliance_deadline BOOLEAN NOT NULL DEFAULT FALSE;

-- Default compliance categorisation carried by the template
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_compliance_area TEXT;

-- Default precise document type (vat201, emp201, irp6, itr14, etc.)
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_deadline_type TEXT;

-- Default title to use when generating a deadline from this template
-- (overridden by the generate payload; falls back to template name)
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_deadline_title TEXT;

-- Default priority for generated deadlines
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_deadline_priority TEXT;

-- How many days from the anchor_date the deadline due_date falls
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_deadline_offset_days INTEGER;

-- Basis used to calculate due date when offset_days is set
-- Allowed: anchor_date, period_start, period_end, financial_year_end, tax_year_end
ALTER TABLE practice_workflow_templates
  ADD COLUMN IF NOT EXISTS default_deadline_offset_basis TEXT;

-- Index: quickly find templates that produce compliance deadlines
CREATE INDEX IF NOT EXISTS idx_pwt_creates_deadline
  ON practice_workflow_templates(creates_compliance_deadline)
  WHERE creates_compliance_deadline = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Extend practice_workflow_runs
-- Runs now store the client they were generated for, any linked deadline,
-- and the compliance context for that run.
-- Note: practice_workflow_runs.id is BIGSERIAL; company_id is BIGINT.
-- ─────────────────────────────────────────────────────────────────────────────

-- Client this run was generated for (generate handler accepts client_id but
-- the original schema never persisted it on the run row — fixing that gap)
ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS client_id INTEGER
    REFERENCES practice_clients(id) ON DELETE SET NULL;

-- Reverse link to the compliance deadline that was created (or linked) for
-- this run. Forward link practice_deadlines.workflow_run_id was added in 058.
ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS deadline_id INTEGER
    REFERENCES practice_deadlines(id) ON DELETE SET NULL;

-- Compliance context snapshotted at generation time
ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS compliance_area TEXT;

ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS deadline_type TEXT;

ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS period_start DATE;

ALTER TABLE practice_workflow_runs
  ADD COLUMN IF NOT EXISTS period_end DATE;

-- Indexes on practice_workflow_runs new columns
CREATE INDEX IF NOT EXISTS idx_pwr_client_id
  ON practice_workflow_runs(client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pwr_deadline_id
  ON practice_workflow_runs(deadline_id)
  WHERE deadline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pwr_compliance_area
  ON practice_workflow_runs(compliance_area)
  WHERE compliance_area IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pwr_deadline_type
  ON practice_workflow_runs(deadline_type)
  WHERE deadline_type IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Extend practice_tasks
-- Tasks generated from workflows can now carry a direct, typed FK to both
-- the compliance deadline and the workflow run that created them.
-- source_type / source_id already exist (migration 057) for loose coupling.
-- These columns add proper typed FK columns for reliable JOINs.
-- ─────────────────────────────────────────────────────────────────────────────

-- Direct typed FK to the compliance deadline this task supports
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS deadline_id INTEGER
    REFERENCES practice_deadlines(id) ON DELETE SET NULL;

-- Direct typed FK to the workflow run this task was generated from
-- (BIGINT because practice_workflow_runs.id is BIGSERIAL/BIGINT)
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT
    REFERENCES practice_workflow_runs(id) ON DELETE SET NULL;

-- Indexes on practice_tasks new columns
CREATE INDEX IF NOT EXISTS idx_pt_deadline_id
  ON practice_tasks(deadline_id)
  WHERE deadline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pt_workflow_run_id
  ON practice_tasks(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name IN (
  'practice_workflow_templates',
  'practice_workflow_runs',
  'practice_tasks'
)
  AND column_name IN (
    'creates_compliance_deadline','default_compliance_area','default_deadline_type',
    'default_deadline_title','default_deadline_priority','default_deadline_offset_days',
    'default_deadline_offset_basis',
    'client_id','deadline_id','compliance_area','deadline_type','period_start','period_end',
    'workflow_run_id'
  )
ORDER BY table_name, ordinal_position;
