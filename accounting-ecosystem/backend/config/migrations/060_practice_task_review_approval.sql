-- =============================================================================
-- Migration 060: Practice Task Review / Approval Flow Foundation
-- =============================================================================
-- Run in Supabase SQL Editor AFTER migration 059.
--
-- Design rules:
--   - Only adds columns and tables — no drops, no modifies, safe re-run
--   - ADD COLUMN IF NOT EXISTS throughout
--   - CREATE TABLE IF NOT EXISTS throughout
--   - Existing task status values (open/in_progress/review/completed/cancelled)
--     are NOT changed — review_status / approval_status / qa_status are separate
--     columns so the existing task status lifecycle is fully preserved
--
-- What this migration does:
--   A. Extend practice_tasks with 21 review/approval columns
--   B. Extend practice_workflow_template_steps with requires_review / requires_approval
--   C. Create practice_task_review_events (append-only audit table)
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Extend practice_tasks
--
-- Three tiers of accountability:
--   preparer   → does the work
--   reviewer   → checks the work (first line QA)
--   approver   → signs off (partner/manager approval)
--
-- Two separate state machines:
--   review_status   → not_required | pending | in_review | approved | rejected
--   approval_status → not_required | pending | approved | rejected
--
-- QA status — aggregate signal:
--   none | required | pending_review | rejected | approved | locked
-- ─────────────────────────────────────────────────────────────────────────────

-- Assignment: who prepares, who reviews, who approves
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS preparer_team_member_id  INTEGER
    REFERENCES practice_team_members(id) ON DELETE SET NULL;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS reviewer_team_member_id  INTEGER
    REFERENCES practice_team_members(id) ON DELETE SET NULL;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approver_team_member_id  INTEGER
    REFERENCES practice_team_members(id) ON DELETE SET NULL;

-- Control flags
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS review_required   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Review state machine
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'not_required';
-- Allowed: not_required | pending | in_review | approved | rejected

-- Approval state machine
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required';
-- Allowed: not_required | pending | approved | rejected

-- Timestamps
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS ready_for_review_at TIMESTAMPTZ;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

-- Who performed actions (user_id from JWT, not team member id)
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS reviewed_by  INTEGER;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approved_by  INTEGER;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS rejected_by  INTEGER;

-- Notes and reasons
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS review_notes    TEXT;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS approval_notes  TEXT;

ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- QA aggregate status
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS qa_status TEXT NOT NULL DEFAULT 'none';
-- Allowed: none | required | pending_review | rejected | approved | locked

-- QA lock: prevents casual editing once QA-approved
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS qa_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Indexes on new columns
CREATE INDEX IF NOT EXISTS idx_pt_preparer_id
  ON practice_tasks(preparer_team_member_id)
  WHERE preparer_team_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pt_reviewer_id
  ON practice_tasks(reviewer_team_member_id)
  WHERE reviewer_team_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pt_approver_id
  ON practice_tasks(approver_team_member_id)
  WHERE approver_team_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pt_review_status
  ON practice_tasks(company_id, review_status);

CREATE INDEX IF NOT EXISTS idx_pt_approval_status
  ON practice_tasks(company_id, approval_status);

CREATE INDEX IF NOT EXISTS idx_pt_qa_status
  ON practice_tasks(company_id, qa_status);

CREATE INDEX IF NOT EXISTS idx_pt_qa_locked
  ON practice_tasks(qa_locked)
  WHERE qa_locked = TRUE;

-- Compound: useful for "my pending reviews" queries
CREATE INDEX IF NOT EXISTS idx_pt_reviewer_review_status
  ON practice_tasks(company_id, reviewer_team_member_id, review_status)
  WHERE reviewer_team_member_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Extend practice_workflow_template_steps
--
-- When a workflow run is generated, the generated tasks inherit these flags
-- so review/approval requirements are set automatically from the template.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_workflow_template_steps
  ADD COLUMN IF NOT EXISTS requires_review   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE practice_workflow_template_steps
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Create practice_task_review_events
--
-- Append-only audit table. Never hard-deleted.
-- task_id is nullable with SET NULL so review history is preserved even if
-- the parent task is deleted via the DELETE /tasks/:id route.
-- company_id is NOT NULL — events are always scoped to a company for isolation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_task_review_events (
  id                   INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  company_id           INTEGER NOT NULL,
  task_id              INTEGER,  -- nullable: preserves history if task is deleted
  event_type           TEXT NOT NULL,
  -- Allowed: ready_for_review | review_started | review_approved | review_rejected
  --          approval_approved | approval_rejected | qa_locked | qa_unlocked
  --          review_fields_updated
  old_status           TEXT,
  new_status           TEXT,
  old_review_status    TEXT,
  new_review_status    TEXT,
  old_approval_status  TEXT,
  new_approval_status  TEXT,
  actor_user_id        INTEGER,        -- user_id from JWT (auth system)
  actor_team_member_id INTEGER,        -- practice_team_members.id if resolvable
  notes                TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on practice_task_review_events
CREATE INDEX IF NOT EXISTS idx_ptre_company_id
  ON practice_task_review_events(company_id);

CREATE INDEX IF NOT EXISTS idx_ptre_task_id
  ON practice_task_review_events(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ptre_event_type
  ON practice_task_review_events(event_type);

CREATE INDEX IF NOT EXISTS idx_ptre_created_at
  ON practice_task_review_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ptre_actor_member
  ON practice_task_review_events(actor_team_member_id)
  WHERE actor_team_member_id IS NOT NULL;

-- Compound: all review events for a company, sorted newest first
CREATE INDEX IF NOT EXISTS idx_ptre_company_task
  ON practice_task_review_events(company_id, task_id, created_at DESC);

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
  'practice_tasks',
  'practice_workflow_template_steps',
  'practice_task_review_events'
)
  AND column_name IN (
    'preparer_team_member_id', 'reviewer_team_member_id', 'approver_team_member_id',
    'review_required', 'approval_required',
    'review_status', 'approval_status',
    'ready_for_review_at', 'reviewed_at', 'approved_at', 'rejected_at',
    'reviewed_by', 'approved_by', 'rejected_by',
    'review_notes', 'approval_notes', 'rejection_reason',
    'qa_status', 'qa_locked',
    'requires_review', 'requires_approval',
    'id', 'event_type', 'actor_user_id', 'metadata'
  )
ORDER BY table_name, ordinal_position;
