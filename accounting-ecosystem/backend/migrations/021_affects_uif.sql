-- ============================================================================
-- Migration 021 — affects_uif flag for payroll items
-- ============================================================================
-- Purpose:
--   Add affects_uif BOOLEAN column to both payroll item tables so that
--   individual payroll items can be excluded from the UIF contribution base
--   without affecting PAYE or SDL.
--
-- Why two tables:
--   payroll_items_master — CRUD management table used by /api/payroll/items
--   payroll_items        — Calculation table used by PayrollDataService
--   Both must carry the flag so the engine receives it at calculation time.
--
-- Default true:
--   All existing items default to UIF-applicable, preserving current
--   calculation behaviour exactly.  Only items explicitly set to false
--   (e.g. non-UIF commission, reimbursements) are excluded from the UIF base.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================


-- ── payroll_items_master ──────────────────────────────────────────────────────
-- CRUD management table used by the Paytime Items UI (/api/payroll/items).

ALTER TABLE payroll_items_master
  ADD COLUMN IF NOT EXISTS affects_uif BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN payroll_items_master.affects_uif IS
  'Whether this payroll item is included in the UIF contribution base. '
  'true (default): item earnings are added to UIF-applicable gross. '
  'false: item earnings are excluded from UIF calculation '
  '       (e.g. non-UIF commission, travel reimbursements, director fees). '
  'Does NOT affect PAYE taxability — is_taxable controls PAYE separately.';


-- ── payroll_items ─────────────────────────────────────────────────────────────
-- Calculation table used by PayrollDataService via employee_payroll_items join.
-- Engine reads affects_uif from this table at calculation time.

ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS affects_uif BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN payroll_items.affects_uif IS
  'Whether this payroll item is included in the UIF contribution base. '
  'true (default): item earnings are added to UIF-applicable gross. '
  'false: item earnings are excluded from UIF calculation. '
  'Synced from payroll_items_master by /api/payroll/items PUT and '
  '/api/payroll/items/employee POST (at item creation time).';


-- ── Helpful index ─────────────────────────────────────────────────────────────
-- Partial index for analytics: quickly find items that are UIF-excluded.

CREATE INDEX IF NOT EXISTS idx_payroll_items_master_uif_excluded
  ON payroll_items_master (company_id)
  WHERE affects_uif = false AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_payroll_items_uif_excluded
  ON payroll_items (company_id)
  WHERE affects_uif = false AND is_active = true;
