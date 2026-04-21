-- ============================================================================
-- Migration 018 — Company SDL / UIF Registration Flags
-- ============================================================================
-- Purpose: Add company-level boolean flags to control whether SDL and UIF
--          are calculated for this company's payroll runs.
--
-- Default = true (registered) → backward compatible. Existing companies
-- continue to calculate SDL and UIF exactly as before unless explicitly
-- set to false.
--
-- SDL exempt: company with < R500 000 annual payroll is exempt from SDL
--   (Section 3(5) of Skills Development Levies Act). Set sdl_registered = false.
-- UIF exempt: certain categories of employer are not required to register
--   for UIF. Set uif_registered = false.
--
-- These flags flow through:
--   companies table → PayrollDataService → engine employeeOptions → engine output
--   Snapshots store the result at run time — finalized history is immutable.
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sdl_registered BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS uif_registered BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN companies.sdl_registered IS
  'true = SDL calculated at 1% of gross (default). false = SDL = 0 for all payroll runs.';
COMMENT ON COLUMN companies.uif_registered IS
  'true = UIF calculated at 1% of gross (default). false = UIF = 0 for all payroll runs.';
