-- =============================================================================
-- Migration 024: Payroll Run Reversal Workflow
-- =============================================================================
-- Adds 'reversed' status to payroll_runs and payroll_snapshots,
-- adds reversal audit columns, and converts the unconditional unique
-- index on payroll_snapshots to a conditional one that excludes reversed rows.
--
-- This enables the Safe Pay Run Reversal workflow:
--   1. A finalized pay run is reversed (status → 'reversed')
--   2. Its snapshots are unlocked (is_locked → false, status → 'reversed')
--   3. A new run + new finalization can then be created for the same period
--   4. The conditional unique index allows reversed + new snapshots to coexist
--   5. Reversed rows are NEVER deleted — preserved for full audit trail
--
-- STATUS TRANSITIONS:
--   payroll_runs:      draft → finalized → reversed
--   payroll_snapshots: draft → finalized → reversed
--
-- Run in Supabase SQL Editor. Idempotent — safe to re-run.
-- =============================================================================

-- ── Step 1: Extend payroll_runs.status to include 'reversed' ─────────────────
-- PostgreSQL inline CHECK constraints are auto-named {table}_{column}_check.
-- Must DROP + ADD because ALTER CONSTRAINT only changes deferrability, not the expression.

DO $$
BEGIN
    ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_status_check;
    ALTER TABLE payroll_runs
        ADD CONSTRAINT payroll_runs_status_check
        CHECK (status IN ('draft', 'finalized', 'reversed'));
EXCEPTION WHEN others THEN
    RAISE NOTICE 'payroll_runs status constraint update skipped: %', SQLERRM;
END;
$$;

-- ── Step 2: Add reversal audit columns to payroll_runs ────────────────────────

ALTER TABLE payroll_runs
    ADD COLUMN IF NOT EXISTS reversed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by     INTEGER,
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- ── Step 3: Extend payroll_snapshots.status to include 'reversed' ────────────

DO $$
BEGIN
    ALTER TABLE payroll_snapshots DROP CONSTRAINT IF EXISTS payroll_snapshots_status_check;
    ALTER TABLE payroll_snapshots
        ADD CONSTRAINT payroll_snapshots_status_check
        CHECK (status IN ('draft', 'finalized', 'reversed'));
EXCEPTION WHEN others THEN
    RAISE NOTICE 'payroll_snapshots status constraint update skipped: %', SQLERRM;
END;
$$;

-- ── Step 4: Add reversal audit columns to payroll_snapshots ──────────────────

ALTER TABLE payroll_snapshots
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by INTEGER;

-- ── Step 5: Convert unconditional unique index to conditional ─────────────────
-- The original idx_payroll_snapshots_unique is unconditional, which prevents
-- inserting a new snapshot for the same (company_id, employee_id, period_key)
-- after reversal. The conditional index (WHERE status != 'reversed') only
-- enforces uniqueness among active snapshots — reversed rows are excluded,
-- allowing a corrected pay run to create new snapshots for the same period.

DROP INDEX IF EXISTS idx_payroll_snapshots_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_snapshots_active_unique
    ON payroll_snapshots (company_id, employee_id, period_key)
    WHERE status != 'reversed';

-- ── Notify PostgREST to reload schema ────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verification query — run after migration to confirm changes applied
-- =============================================================================
SELECT
    'payroll_runs reversal columns' AS check_name,
    COUNT(*) AS columns_present
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'payroll_runs'
  AND column_name IN ('reversed_at', 'reversed_by', 'reversal_reason')

UNION ALL

SELECT
    'payroll_snapshots reversal columns' AS check_name,
    COUNT(*) AS columns_present
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'payroll_snapshots'
  AND column_name IN ('reversed_at', 'reversed_by')

UNION ALL

SELECT
    'idx_payroll_snapshots_active_unique' AS check_name,
    COUNT(*) AS columns_present
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_payroll_snapshots_active_unique'

UNION ALL

SELECT
    'old idx_payroll_snapshots_unique dropped' AS check_name,
    (1 - COUNT(*)) AS columns_present
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_payroll_snapshots_unique';
