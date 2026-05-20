-- ============================================================================
-- Migration 020 — PAYE Projection Type for Payroll Items
-- ============================================================================
-- Run in Supabase SQL Editor.
--
-- Adds paye_projection_type metadata to payroll item master tables so that
-- the YTD PAYE projection formula can classify each recurring item as:
--
--   FIXED_RECURRING  — item repeats monthly; project current amount forward
--                      for remaining months in the tax year (e.g. basic salary,
--                      fixed monthly allowance, travel allowance)
--
--   VARIABLE_AVERAGE — item fluctuates; project using YTD average × 12
--                      (e.g. commission, variable bonus, shift allowance)
--
--   ONCE_OFF         — item occurs once only; include actual amount once,
--                      never annualise (e.g. annual bonus, signing bonus,
--                      performance bonus, once-off allowance)
--
-- Default: VARIABLE_AVERAGE
--   Conservative safe default — if type is not yet set for an item, it is
--   averaged rather than projected forward.  This prevents over-projection
--   for new or uncategorised items.
--
-- NOTE: Basic salary, overtime, and short-time are HARDCODED in the engine
--   (FIXED_RECURRING, VARIABLE_AVERAGE, VARIABLE_AVERAGE respectively).
--   This column controls PAYROLL ITEMS only (regular_inputs and current_inputs).
--
-- Applies to:
--   payroll_items_master  — managed by items route (GET/POST/PUT /api/payroll/items)
--   payroll_items         — used by PayrollDataService fetchRecurringPayrollItems
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================

-- payroll_items_master (items route + UI)
ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS paye_projection_type VARCHAR(30)
    NOT NULL DEFAULT 'VARIABLE_AVERAGE'
    CHECK (paye_projection_type IN ('FIXED_RECURRING', 'VARIABLE_AVERAGE', 'ONCE_OFF'));

COMMENT ON COLUMN payroll_items_master.paye_projection_type IS
  'Controls how this item is treated in the YTD PAYE projection formula. '
  'FIXED_RECURRING: project current amount forward for remaining months. '
  'VARIABLE_AVERAGE: average over YTD and project × 12. '
  'ONCE_OFF: include once only, never annualise. '
  'Default VARIABLE_AVERAGE is the conservative safe choice for uncategorised items.';

-- payroll_items (used by employee_payroll_items FK + PayrollDataService)
ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS paye_projection_type VARCHAR(30)
    NOT NULL DEFAULT 'VARIABLE_AVERAGE'
    CHECK (paye_projection_type IN ('FIXED_RECURRING', 'VARIABLE_AVERAGE', 'ONCE_OFF'));

COMMENT ON COLUMN payroll_items.paye_projection_type IS
  'Controls YTD PAYE projection treatment for this item. See payroll_items_master comment.';

-- Helpful index for projection-type filtering in analytics/reporting
CREATE INDEX IF NOT EXISTS idx_payroll_items_master_projection_type
  ON payroll_items_master (company_id, paye_projection_type)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_payroll_items_projection_type
  ON payroll_items (company_id, paye_projection_type)
  WHERE is_active = true;
