-- ============================================================================
-- Migration 057: Practice Workflow Templates (Codebox 06)
-- Date: 2026-05-30
-- Purpose:
--   Add workflow template tables and workflow run table for Lorenco Practice.
--   Ensure generated workflow tasks are recorded in `practice_tasks` with
--   a lightweight source reference (source_type, source_id) added to that table.
-- Safety:
--   - Use IF NOT EXISTS for tables and ADD COLUMN IF NOT EXISTS for columns
--   - Safe to re-run on partially migrated DB
--   - All new tables include company_id for multi-tenant scoping
-- ============================================================================

-- ─── 1. Add source columns to practice_tasks (nullable) ──────────────────────
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id   BIGINT;

CREATE INDEX IF NOT EXISTS idx_practice_tasks_source ON practice_tasks (company_id, source_type, source_id);


-- ─── 2. Workflow templates ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_workflow_templates (
  id            BIGSERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'general'
                 CHECK (category IN ('general','tax','payroll','audit','annual','onboarding','client_intake','other')),
  priority      TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','urgent')),
  recurrence    TEXT DEFAULT NULL
                 CHECK (recurrence IN ('none','weekly','monthly','quarterly','annually','custom')),
  version       INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  settings      JSONB DEFAULT '{}',
  created_by    BIGINT,
  updated_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wft_company ON practice_workflow_templates (company_id);
CREATE INDEX IF NOT EXISTS idx_wft_slug_company ON practice_workflow_templates (company_id, slug);


-- ─── 3. Workflow template steps ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_workflow_template_steps (
  id             BIGSERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL,
  template_id    BIGINT NOT NULL REFERENCES practice_workflow_templates(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,
  description    TEXT,
  task_type      TEXT DEFAULT 'general',
  priority       TEXT DEFAULT 'medium',
  assigned_role  TEXT, -- e.g. 'staff','partner' or a team role name
  assigned_user_id BIGINT, -- optional team member user id hint
  due_offset_days INTEGER, -- number of days after run start when task is due
  estimated_hours NUMERIC(8,2),
  is_required    BOOLEAN NOT NULL DEFAULT true,
  settings       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wfts_company_template_ordinal UNIQUE (company_id, template_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_wfts_template ON practice_workflow_template_steps (template_id);


-- ─── 4. Workflow runs (instances of a template being executed) ────────────
CREATE TABLE IF NOT EXISTS practice_workflow_runs (
  id             BIGSERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL,
  template_id    BIGINT REFERENCES practice_workflow_templates(id) ON DELETE SET NULL,
  run_number     TEXT, -- human-friendly identifier (optional)
  source_type    TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','scheduled','api')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  requested_by   BIGINT,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  metadata       JSONB DEFAULT '{}',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wfr_company ON practice_workflow_runs (company_id);
CREATE INDEX IF NOT EXISTS idx_wfr_template ON practice_workflow_runs (template_id);


-- ─── 5. Optional: snapshot of template steps for a run (lightweight) ──────
CREATE TABLE IF NOT EXISTS practice_workflow_run_steps (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES practice_workflow_runs(id) ON DELETE CASCADE,
  template_step_id BIGINT NOT NULL, -- reference to original template step id
  ordinal       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  task_type     TEXT,
  priority      TEXT,
  assigned_role TEXT,
  assigned_user_id BIGINT,
  due_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wfrs_run ON practice_workflow_run_steps (run_id);

-- End migration 057
