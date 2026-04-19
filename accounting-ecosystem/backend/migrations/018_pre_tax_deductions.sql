-- ============================================================================
-- Migration 018 — Pre-Tax Deduction Support (SARS Compliance)
-- ============================================================================
-- Run in Supabase SQL Editor.
-- All statements are idempotent.
--
-- Purpose:
--   Adds explicit deduction tax_treatment metadata to payroll item tables so
--   that qualifying pre-tax deductions (pension fund, RA, etc.) can reduce
--   taxable income before PAYE is calculated, as required by SARS.
--
-- Tax treatment values:
--   net_only  — deduction reduces net pay only (default, backward-compatible)
--   pre_tax   — deduction reduces taxable income + net pay (SARS qualifying items)
--
-- Backward compatibility:
--   All existing deduction items default to 'net_only'.
--   Existing earning items retain NULL (tax_treatment is not meaningful for earnings).
--   No existing finalized payroll snapshots are affected.
--   The engine reads tax_treatment at calculation time; snapshots store the output.
--
-- Tables affected:
--   payroll_items_master   — used by /api/payroll/items backend route
--   payroll_items          — used by PayrollDataService via employee_payroll_items
-- ============================================================================


-- ── payroll_items_master ──────────────────────────────────────────────────────
-- This is the table used by the Paytime Items CRUD API.

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20)
    NOT NULL DEFAULT 'net_only'
    CHECK (tax_treatment IN ('net_only', 'pre_tax'));

COMMENT ON COLUMN payroll_items_master.tax_treatment IS
  'Deduction tax treatment for SARS compliance.
   net_only: deduction reduces net pay only (default).
   pre_tax:  deduction reduces taxable income before PAYE and also reduces net.
   Only meaningful for item_type = deduction. Earning items should remain net_only.';


-- ── payroll_items ─────────────────────────────────────────────────────────────
-- This is the table used by PayrollDataService via employee_payroll_items join.

ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20)
    NOT NULL DEFAULT 'net_only'
    CHECK (tax_treatment IN ('net_only', 'pre_tax'));

COMMENT ON COLUMN payroll_items.tax_treatment IS
  'Deduction tax treatment for SARS compliance.
   net_only: deduction reduces net pay only (default).
   pre_tax:  deduction reduces taxable income before PAYE and also reduces net.
   Only meaningful for item_type = deduction.';


-- ── Index for deduction treatment queries ────────────────────────────────────
-- Partial index: only deduction items have meaningful tax_treatment values.

CREATE INDEX IF NOT EXISTS idx_payroll_items_master_deduction_treatment
  ON payroll_items_master (company_id, tax_treatment)
  WHERE item_type = 'deduction';

CREATE INDEX IF NOT EXISTS idx_payroll_items_deduction_treatment
  ON payroll_items (company_id, tax_treatment)
  WHERE item_type = 'deduction';
