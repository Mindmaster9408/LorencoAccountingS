-- ============================================================================
-- Migration 022 — is_taxable flag for payroll_period_inputs
-- ============================================================================
-- Purpose:
--   Add is_taxable BOOLEAN column to payroll_period_inputs so that one-off
--   period inputs (Current Inputs) correctly honour the Taxable? setting
--   from payroll_items_master, independent of the Affects UIF? flag.
--
-- Root cause resolved:
--   payroll_period_inputs had no is_taxable column. The normalizer never
--   passed is_taxable to the engine for period inputs, so the engine always
--   defaulted them to taxable (undefined === false → false → onceOffTaxable).
--   Taxable=Yes items worked by accident; Taxable=No items were always
--   incorrectly included in PAYE taxable income.
--
-- affects_uif and is_taxable are INDEPENDENT:
--   is_taxable  controls PAYE taxable income only.
--   affects_uif controls UIF contribution base only.
--   Neither flag affects the other.
--
-- Default true: all existing records remain taxable, preserving current
--   PAYE calculation behaviour exactly.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================

ALTER TABLE payroll_period_inputs
  ADD COLUMN IF NOT EXISTS is_taxable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN payroll_period_inputs.is_taxable IS
  'Whether this one-off input is included in PAYE taxable income. '
  'Set at insert time from payroll_items_master.is_taxable (matched by description). '
  'Default true: taxable. false: excluded from PAYE base. '
  'Completely independent of affects_uif — does not control UIF.';
