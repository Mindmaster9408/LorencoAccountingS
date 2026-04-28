-- =============================================================================
-- Migration 011: Practice Module — Phase 1 Enum Fixes
-- =============================================================================
-- Fixes enum mismatches identified during Phase 1 architecture review.
-- Run in Supabase SQL Editor BEFORE any Phase 2+ schema changes.
--
-- Changes:
--   1. practice_tasks.type     — add 'management_accounts' (was missing)
--   2. practice_deadlines.type — expand to full SARS/CIPC type set;
--                                remove 'company_registration' (replaced by 'cipc_annual_return')
--   3. practice_deadlines.status — add 'submitted' (needed for edit modal status flow)
-- =============================================================================

BEGIN;

-- ─── 1. practice_tasks.type ──────────────────────────────────────────────────
-- Current: ('general','vat_return','tax_return','annual_financial',
--           'payroll','audit','bookkeeping','secretarial','other')
-- Target:  add 'management_accounts'

ALTER TABLE practice_tasks
  DROP CONSTRAINT IF EXISTS practice_tasks_type_check;

ALTER TABLE practice_tasks
  ADD CONSTRAINT practice_tasks_type_check
  CHECK (type IN (
    'general',
    'vat_return',
    'tax_return',
    'annual_financial',
    'management_accounts',
    'payroll',
    'audit',
    'bookkeeping',
    'secretarial',
    'other'
  ));

-- ─── 2. practice_deadlines.type ──────────────────────────────────────────────
-- Current: ('general','vat_return','tax_return','paye','uif',
--           'annual_financial','company_registration','other')
-- Target:  full SARS/CIPC type set per architecture; 'company_registration'
--          replaced by 'cipc_annual_return'
--
-- SAFE: existing rows with 'company_registration' will be migrated below
--       before the constraint is added.

-- Migrate any existing 'company_registration' rows to 'cipc_annual_return'
UPDATE practice_deadlines
  SET type = 'cipc_annual_return'
  WHERE type = 'company_registration';

ALTER TABLE practice_deadlines
  DROP CONSTRAINT IF EXISTS practice_deadlines_type_check;

ALTER TABLE practice_deadlines
  ADD CONSTRAINT practice_deadlines_type_check
  CHECK (type IN (
    'general',
    'vat_return',
    'tax_return',
    'paye',
    'uif',
    'sdl',
    'annual_financial',
    'provisional_tax_p1',
    'provisional_tax_p2',
    'provisional_tax_top_up',
    'cipc_annual_return',
    'beneficial_ownership',
    'other'
  ));

-- ─── 3. practice_deadlines.status ────────────────────────────────────────────
-- Current: ('pending','completed','missed')
-- Target:  add 'submitted' (deadline marked submitted-to-SARS before confirmed)

ALTER TABLE practice_deadlines
  DROP CONSTRAINT IF EXISTS practice_deadlines_status_check;

ALTER TABLE practice_deadlines
  ADD CONSTRAINT practice_deadlines_status_check
  CHECK (status IN ('pending', 'submitted', 'completed', 'missed'));

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run this SELECT to confirm constraints were applied correctly:
SELECT
  tc.table_name,
  tc.constraint_name,
  cc.check_clause
FROM information_schema.table_constraints tc
JOIN information_schema.check_constraints cc
  ON tc.constraint_name = cc.constraint_name
WHERE tc.table_name IN ('practice_tasks', 'practice_deadlines')
  AND tc.constraint_type = 'CHECK'
  AND cc.check_clause NOT LIKE '% IS NOT NULL%'
ORDER BY tc.table_name, tc.constraint_name;
