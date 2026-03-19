-- ============================================================================
-- Migration 009: Add vat_number column to companies table
-- ============================================================================
-- Root cause: vat_number was defined in the suppliers table schema but was
-- never added to the companyColumns list in accounting-schema.js.
-- The PUT /api/accounting/company/:id route tried to update companies.vat_number
-- → Supabase threw 500 because the column did not exist.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
-- ============================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_number VARCHAR(50);
