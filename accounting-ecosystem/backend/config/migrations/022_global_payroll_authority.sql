-- =============================================================================
-- Migration 022: is_global_payroll_authority — Formal Authority Marker
-- =============================================================================
-- Adds a formal database-level declaration that exactly one company is the
-- global payroll authority (The Infinite Legacy).
--
-- BEFORE this migration:
--   Global tax publish access was gated only on is_super_admin role + business_owner
--   role — meaning any super admin from any company context could write the global
--   tax standard. There was no company-identity check.
--
-- AFTER this migration:
--   Global tax publish requires BOTH:
--     1. is_super_admin = true (role check, unchanged)
--     2. req.companyId must be the company with is_global_payroll_authority = true
--
-- The DB-level unique partial index enforces that at most ONE company can ever
-- hold this flag. The application layer also enforces this, but the DB constraint
-- is the hard floor.
--
-- After this migration runs, the authority is identified ONLY by this flag.
-- Company name, company ID, and role alone are no longer sufficient.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS
-- are safe to re-run.
--
-- Run in Supabase SQL Editor.
-- =============================================================================

-- Step 1: Add the column
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_global_payroll_authority BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.is_global_payroll_authority IS
  'Exactly one company is the global payroll authority (The Infinite Legacy). '
  'Only this company context may publish global tax tables and global payroll standards. '
  'Enforced at DB level by unique partial index (idx_companies_single_global_authority). '
  'Enforced at API level by isGlobalPayrollAuthority() helper in shared/utils/globalAuthority.js. '
  'Set via migration 022. Do NOT update this flag outside of a controlled migration.';

-- Step 2: DB-level uniqueness — at most ONE authority may exist
-- A unique partial index on (is_global_payroll_authority) WHERE value = true
-- means the second attempt to set another company's flag to true will raise a
-- unique constraint violation before the application layer is even consulted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_single_global_authority
  ON companies (is_global_payroll_authority)
  WHERE is_global_payroll_authority = true;

-- Step 3: Mark The Infinite Legacy as global authority
-- Using ILIKE for the one-time migration identification. After this runs,
-- the system identifies the authority by this flag alone — name is never
-- used again for authority checks.
UPDATE companies
SET
  is_global_payroll_authority = true,
  updated_at                  = NOW()
WHERE company_name ILIKE '%Infinite Legacy%'
  AND is_global_payroll_authority = false;

-- Step 4: Safety verification
-- Raise an exception if the result is not exactly one authority row.
-- If this check fails, the entire migration is rolled back automatically
-- (Supabase runs each SQL block transactionally in the SQL editor).
DO $$
DECLARE
  v_count INTEGER;
  v_name  TEXT;
  v_id    INTEGER;
BEGIN
  SELECT COUNT(*), MAX(company_name), MAX(id)
  INTO v_count, v_name, v_id
  FROM companies
  WHERE is_global_payroll_authority = true;

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'Migration 022 FAILED: No company was marked as global payroll authority. '
      'Expected exactly 1. '
      'Ensure a company named like "%%Infinite Legacy%%" exists and re-run migration 022.';
  END IF;

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'Migration 022 FAILED: % companies were marked as global payroll authority. '
      'Expected exactly 1. The unique partial index should have prevented this. '
      'Manually inspect the companies table and resolve before re-running.',
      v_count;
  END IF;

  RAISE NOTICE
    'Migration 022 SUCCESS: Global payroll authority = "%" (company_id = %). Exactly 1 row confirmed.',
    v_name, v_id;
END $$;

-- =============================================================================
-- Verification query — run this after migration to confirm result
-- =============================================================================
SELECT
  id,
  company_name,
  is_global_payroll_authority,
  is_active,
  updated_at
FROM companies
WHERE is_global_payroll_authority = true;
