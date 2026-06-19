-- =============================================================================
-- Migration 058: Practice Compliance Calendar + Deadline Engine Foundation
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Design rules:
--   - Only adds new columns/tables — does NOT drop or modify existing columns
--   - All new columns use ADD COLUMN IF NOT EXISTS for safe re-run
--   - Existing data is fully preserved
--   - Soft-delete pattern: is_active = false (not hard delete)
--
-- What this migration does:
--   A. Extends practice_deadlines with compliance, assignment, and audit fields
--   B. Creates practice_compliance_rules (rule foundation — no automation yet)
--   C. Creates practice_deadline_events (status audit trail per deadline)
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Extend practice_deadlines
-- Existing columns (DO NOT re-add): id, company_id, client_id, title, type,
--   due_date, status, notes, created_at, updated_at
-- ─────────────────────────────────────────────────────────────────────────────

-- Compliance categorisation (groups deadline types into SARS / CIPC / etc.)
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS compliance_area TEXT;

-- Extended deadline type vocabulary (replaces CHECK constraint expansion in 011)
-- The new deadline_type column stores the precise document type
-- The old `type` column remains for backward compatibility with existing data
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS deadline_type TEXT;

-- Tax period coverage
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS period_start DATE;

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS period_end DATE;

-- Reminder date (separate from due date — when to start chasing)
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS reminder_date DATE;

-- Assignment
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS responsible_team_member_id INTEGER
    REFERENCES practice_team_members(id) ON DELETE SET NULL;

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS reviewer_team_member_id INTEGER
    REFERENCES practice_team_members(id) ON DELETE SET NULL;

-- Priority
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';

-- Extended status support (previously only: pending, submitted, completed, missed)
-- The application layer validates the full allowed set; CHECK is not added here
-- to avoid migration failure on Supabase — validated at route level.

-- Submission tracking (the app already writes submitted_at via PUT handler;
-- this column must exist in the DB)
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS submission_reference TEXT;

-- Completion tracking
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS completed_by INTEGER;

-- Internal vs client-facing notes
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- Linkage to workflow runs (future — nullable now)
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS workflow_run_id INTEGER
    REFERENCES practice_workflow_runs(id) ON DELETE SET NULL;

-- Task linkage (future)
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS task_id INTEGER
    REFERENCES practice_tasks(id) ON DELETE SET NULL;

-- Soft-delete / cancellation support
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Governance
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS created_by INTEGER;

ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS updated_by INTEGER;

-- Extended settings blob for future extensibility
ALTER TABLE practice_deadlines
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';

-- ─── Indexes on practice_deadlines new columns ────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pd_compliance_area
  ON practice_deadlines(company_id, compliance_area)
  WHERE compliance_area IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pd_deadline_type
  ON practice_deadlines(company_id, deadline_type)
  WHERE deadline_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pd_responsible
  ON practice_deadlines(company_id, responsible_team_member_id)
  WHERE responsible_team_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pd_is_active
  ON practice_deadlines(company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_pd_workflow_run
  ON practice_deadlines(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pd_reminder_date
  ON practice_deadlines(company_id, reminder_date)
  WHERE reminder_date IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Compliance Rule Foundation
-- Stores what recurring compliance obligations a practice manages.
-- This is a reference/definition table — no automation is built yet.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_compliance_rules (
  id                   INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  rule_name            TEXT NOT NULL,
  compliance_area      TEXT NOT NULL,
  deadline_type        TEXT NOT NULL,

  -- Which client type this rule applies to (null = all types)
  client_type          TEXT,

  -- JSON conditions for when this rule applies
  -- e.g. {"vat_registered": true} or {"provisional_taxpayer": true}
  applies_when         JSONB NOT NULL DEFAULT '{}',

  -- Day of month the deadline falls (e.g. 25 for VAT201)
  due_day              INTEGER,
  -- Month of year (for annual items like CIPC, ITR14)
  due_month            INTEGER,
  -- Offset in days from the period basis date
  due_offset_days      INTEGER,
  -- Basis for calculating due date
  -- Allowed: period_end, period_start, financial_year_end, tax_year_end, custom_anchor
  due_offset_basis     TEXT,

  -- How often this recurs
  -- Allowed: monthly, bi_monthly, quarterly, biannual, annual, once_off, custom
  recurrence_type      TEXT,

  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes                TEXT,
  settings             JSONB NOT NULL DEFAULT '{}',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           INTEGER,
  updated_by           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pcr_company
  ON practice_compliance_rules(company_id);

CREATE INDEX IF NOT EXISTS idx_pcr_compliance_area
  ON practice_compliance_rules(company_id, compliance_area);

CREATE INDEX IF NOT EXISTS idx_pcr_deadline_type
  ON practice_compliance_rules(company_id, deadline_type);

CREATE INDEX IF NOT EXISTS idx_pcr_client_type
  ON practice_compliance_rules(client_type)
  WHERE client_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pcr_is_active
  ON practice_compliance_rules(company_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Deadline Events (Status Audit Trail)
-- Append-only log of status changes and significant events per deadline.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_deadline_events (
  id             INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deadline_id    INTEGER NOT NULL REFERENCES practice_deadlines(id) ON DELETE CASCADE,

  -- Event type examples: status_changed, created, submitted, completed,
  --   cancelled, note_added, assigned, reminder_set
  event_type     TEXT NOT NULL,
  event_note     TEXT,

  old_status     TEXT,
  new_status     TEXT,

  actor_user_id  INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  metadata       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pde_company
  ON practice_deadline_events(company_id);

CREATE INDEX IF NOT EXISTS idx_pde_deadline_id
  ON practice_deadline_events(deadline_id);

CREATE INDEX IF NOT EXISTS idx_pde_event_type
  ON practice_deadline_events(company_id, event_type);

CREATE INDEX IF NOT EXISTS idx_pde_created_at
  ON practice_deadline_events(company_id, created_at DESC);

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
  'practice_deadlines',
  'practice_compliance_rules',
  'practice_deadline_events'
)
ORDER BY table_name, ordinal_position;
