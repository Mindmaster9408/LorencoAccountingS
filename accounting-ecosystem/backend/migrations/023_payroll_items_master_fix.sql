-- ============================================================================
-- Migration 023 — payroll_items_master: UI type values + display fields
-- ============================================================================
-- Purpose:
--   1. Relax the item_type CHECK constraint so the UI's display type values
--      (income, allowance, employer_contribution) can be stored directly.
--      The original constraint was copied from the engine table (payroll_items)
--      and is too narrow for the management table.
--   2. Add is_variable — whether the item amount changes each pay run.
--   3. Add frequency  — which "Add" list the item appears in on the payslip screen.
--
-- Background:
--   payroll_items_master is the UI CRUD management table (managed by /api/payroll/items).
--   payroll_items is the calculation engine table (managed by PayrollDataService).
--   They have different column naming and different item_type value sets.
--   This migration aligns payroll_items_master with the UI data contract so that
--   the frontend can read/write the API directly without a KV-store intermediary.
--
-- Idempotent: safe to re-run.
-- ============================================================================


-- ── 1. Relax item_type CHECK constraint ──────────────────────────────────────
-- PostgreSQL auto-names inline CHECK constraints as <table>_<column>_check.
-- Drop existing and replace with extended value set.

ALTER TABLE payroll_items_master
  DROP CONSTRAINT IF EXISTS payroll_items_master_item_type_check;

ALTER TABLE payroll_items_master
  ADD CONSTRAINT payroll_items_master_item_type_check
  CHECK (item_type IN (
    'earning', 'deduction', 'company_contribution',  -- engine-compatible values (legacy)
    'income', 'allowance', 'employer_contribution'   -- UI display values (current)
  ));

COMMENT ON COLUMN payroll_items_master.item_type IS
  'UI display type for grouping and rendering.
   income, allowance, employer_contribution → earning/contribution in engine
   deduction → deduction in engine
   The legacy engine values (earning, company_contribution) remain accepted for
   backwards compatibility with any existing rows.';


-- ── 2. Add is_variable ────────────────────────────────────────────────────────
-- Whether the amount changes each pay run (entered manually at pay-run time).
-- false = fixed amount pre-filled from default_amount.
-- true  = amount entered fresh each month.

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS is_variable BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll_items_master.is_variable IS
  'false: same amount every pay run (pre-filled from default_amount).
   true:  amount varies — user enters it at pay-run time.';


-- ── 3. Add frequency ─────────────────────────────────────────────────────────
-- Controls which "Add" list this item appears in on the employee payslip screen.
-- regular   = appears in Regular Inputs (monthly items)
-- once_off  = appears in Once-Off Inputs only
-- both      = appears in both lists

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS frequency VARCHAR(20) NOT NULL DEFAULT 'regular';

-- Add CHECK separately so IF NOT EXISTS on the column still works
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payroll_items_master'::regclass
    AND   conname  = 'payroll_items_master_frequency_check'
  ) THEN
    ALTER TABLE payroll_items_master
      ADD CONSTRAINT payroll_items_master_frequency_check
      CHECK (frequency IN ('regular', 'once_off', 'both'));
  END IF;
END $$;

COMMENT ON COLUMN payroll_items_master.frequency IS
  'Controls which input list this item appears in on the employee payslip screen.
   regular: regular monthly inputs.
   once_off: once-off inputs only.
   both: available in both lists.';
