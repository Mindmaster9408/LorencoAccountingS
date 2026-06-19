-- =============================================================================
-- Migration 061: Practice Time Entries — Billing Readiness Foundation
-- =============================================================================
-- Run in Supabase SQL Editor AFTER migration 060.
--
-- Design rules:
--   - Only adds columns and tables — no drops, no modifies, safe re-run
--   - ADD COLUMN IF NOT EXISTS throughout
--   - Existing columns preserved: billable (boolean), rate (NUMERIC 10,2)
--   - billable boolean kept for backward compatibility
--   - time_type is the new canonical classification field
--   - rate kept for backward compat; new fields are standard_rate / override_rate / effective_rate
--
-- What this migration does:
--   A. Add workflow_run linkage to practice_time_entries
--   B. Add time classification (time_type)
--   C. Add billing rate fields (standard_rate, override_rate, effective_rate)
--   D. Add billing value fields (recoverable_value, billed_value, writeoff_value)
--   E. Add billing lifecycle fields (billing_status, review timestamps, approved_by)
--   F. Add notes fields (billing_notes, internal_notes)
--   G. Add supporting indexes
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Workflow run linkage
-- Allows time entries to be linked to a specific workflow run (e.g. client VAT run).
-- BIGINT to match practice_workflow_runs.id which is BIGSERIAL.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT
    REFERENCES practice_workflow_runs(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Time classification
-- time_type replaces the billable boolean as the canonical classification.
-- billable boolean is kept for backward compatibility.
-- Allowed values: billable | non_billable | internal | admin
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS time_type TEXT NOT NULL DEFAULT 'billable';
-- Allowed: billable | non_billable | internal | admin

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Rate fields
-- standard_rate: the team member's or engagement's standard hourly rate
-- override_rate: a per-entry manual rate override (maps to old 'rate' semantically)
-- effective_rate: computed = COALESCE(override_rate, standard_rate)
--                (stored for query performance — avoids CASE in reporting queries)
-- The old 'rate' column remains and is treated as a legacy override_rate fallback.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS standard_rate     NUMERIC(12,2);

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS override_rate     NUMERIC(12,2);

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS effective_rate    NUMERIC(12,2);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Billing value fields
-- recoverable_value: hours × effective_rate (what we could bill)
-- billed_value:      what was actually invoiced (set when invoice is raised — future)
-- writeoff_value:    amount written off (set during WIP management — future)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS recoverable_value NUMERIC(12,2);

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS billed_value      NUMERIC(12,2);

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS writeoff_value    NUMERIC(12,2);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Billing lifecycle
-- billing_status drives the WIP and billing workflow.
-- Allowed: unbilled | pending_review | approved | rejected | billed | written_off
-- submitted_for_review_at: when the staff member submitted the entry for approval
-- approved_at / approved_by: when and by whom the entry was approved for billing
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS billing_status          TEXT NOT NULL DEFAULT 'unbilled';
-- Allowed: unbilled | pending_review | approved | rejected | billed | written_off

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMPTZ;

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS approved_at             TIMESTAMPTZ;

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS approved_by             INTEGER;
-- user_id from JWT — not FK enforced to avoid cascade complexity

-- ─────────────────────────────────────────────────────────────────────────────
-- F. Notes
-- billing_notes: visible to billing admin / partner (what to bill for)
-- internal_notes: internal staff notes, not surfaced in billing output
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS billing_notes   TEXT;

ALTER TABLE practice_time_entries
  ADD COLUMN IF NOT EXISTS internal_notes  TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- G. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pte_workflow_run_id
  ON practice_time_entries(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pte_billing_status
  ON practice_time_entries(company_id, billing_status);

CREATE INDEX IF NOT EXISTS idx_pte_time_type
  ON practice_time_entries(company_id, time_type);

CREATE INDEX IF NOT EXISTS idx_pte_approved_by
  ON practice_time_entries(approved_by)
  WHERE approved_by IS NOT NULL;

-- Compound: WIP queries (unbilled billable time per client)
CREATE INDEX IF NOT EXISTS idx_pte_company_client_billing
  ON practice_time_entries(company_id, client_id, billing_status, time_type);

-- Compound: date-range reporting
CREATE INDEX IF NOT EXISTS idx_pte_company_date
  ON practice_time_entries(company_id, date DESC);

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'practice_time_entries'
  AND column_name IN (
    'workflow_run_id', 'time_type',
    'standard_rate', 'override_rate', 'effective_rate',
    'recoverable_value', 'billed_value', 'writeoff_value',
    'billing_status', 'submitted_for_review_at', 'approved_at', 'approved_by',
    'billing_notes', 'internal_notes'
  )
ORDER BY ordinal_position;
