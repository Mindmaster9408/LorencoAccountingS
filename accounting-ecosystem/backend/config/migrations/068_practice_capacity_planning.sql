-- =============================================================================
-- Migration 068: Practice Capacity Planning Foundation
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Design rules:
--   - All DDL uses ADD COLUMN IF NOT EXISTS — safe to re-run
--   - No existing columns removed or modified
--   - No existing data affected
--
-- What this migration does:
--   A. Extends practice_team_members with weekly/daily capacity fields
--   B. Extends practice_tasks with estimated_hours for workload calculation
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Capacity fields on practice_team_members
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE practice_team_members
  ADD COLUMN IF NOT EXISTS weekly_capacity_hours NUMERIC(12,2) NULL;

ALTER TABLE practice_team_members
  ADD COLUMN IF NOT EXISTS daily_capacity_hours NUMERIC(12,2) NULL;

ALTER TABLE practice_team_members
  ADD COLUMN IF NOT EXISTS capacity_notes TEXT NULL;

-- capacity_is_active controls whether this member is included in capacity
-- calculations (separate from is_active which controls login/task access)
ALTER TABLE practice_team_members
  ADD COLUMN IF NOT EXISTS capacity_is_active BOOLEAN NOT NULL DEFAULT true;

-- Index to quickly find members included in capacity calculations
CREATE INDEX IF NOT EXISTS idx_ptm_capacity_active
  ON practice_team_members(company_id, capacity_is_active)
  WHERE capacity_is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Estimated hours on practice_tasks
-- ─────────────────────────────────────────────────────────────────────────────

-- Optional field — null means "unknown". Used for workload calculation:
-- utilization = SUM(estimated_hours of open tasks) / weekly_capacity_hours × 100
ALTER TABLE practice_tasks
  ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,2) NULL;

-- Index on estimated_hours for tasks that have it set (partial — avoids
-- indexing the majority of rows that are null)
CREATE INDEX IF NOT EXISTS idx_pt_estimated_hours
  ON practice_tasks(company_id, preparer_team_member_id, estimated_hours)
  WHERE estimated_hours IS NOT NULL;

COMMIT;
