-- ============================================================================
-- Migration 025 — source column for payroll_snapshots
-- ============================================================================
-- Purpose:
--   Add a nullable `source` VARCHAR(50) column to payroll_snapshots so a
--   snapshot can be tagged with where its figures came from (e.g.
--   'simplepay_import') instead of always implicitly meaning "calculated by
--   the Paytime engine". Mirrors the existing payroll_historical.source
--   column (schema.sql:607-619), which already uses this exact free-text
--   pattern for the same purpose.
--
-- Why this is needed:
--   PayrollHistoryService.saveSnapshot() has no field distinguishing an
--   engine-calculated snapshot from a hand-built one — see
--   PayrollHistoryService.js:396-424. Historical payslip imports (figures
--   taken as-is from an external system, e.g. SimplePay, never recalculated
--   by PayrollEngine) need to be identifiable in the data for audit purposes,
--   per CLAUDE.md Rule A7 (document assumptions) and Rule E6 (finalized
--   payroll must never be silently re-derived).
--
-- NULL = calculated by the Paytime engine via the normal Execute Payroll
--   path (POST /api/payroll/run) — the default and by far the most common
--   case, so no backfill of existing rows is needed or desired.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================

ALTER TABLE payroll_snapshots
  ADD COLUMN IF NOT EXISTS source VARCHAR(50);

COMMENT ON COLUMN payroll_snapshots.source IS
  'Where this snapshot''s figures came from. NULL = calculated by the '
  'Paytime engine via the normal Execute Payroll flow (default). Any other '
  'value (e.g. ''simplepay_import'') means the figures were taken as-is from '
  'an external system and were never recalculated by PayrollEngine — see '
  'migration 025 and CLAUDE.md Part E.';
