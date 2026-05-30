-- ============================================================================
-- Migration 061: Add OFX to bank_transaction_staging import_source constraint
-- ============================================================================
-- Purpose:
--   Extends the import_source CHECK constraint on bank_transaction_staging to
--   include 'ofx' as a valid source value, enabling OFX/QFX bank statement
--   imports to be recorded with their correct origin.
--
-- Background:
--   Migration 020 created the staging table with:
--     CHECK (import_source IN ('pdf','image','csv','manual','api'))
--
--   PostgreSQL does not support extending a CHECK in-place, so we drop the
--   auto-generated constraint and recreate it with the new value — the same
--   pattern used in migration 031 for the match_status constraint.
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 020_bank_staging.sql must already be applied
-- Safe: DROP CONSTRAINT IF EXISTS is a no-op when constraint is absent
-- ============================================================================

-- Drop the existing auto-generated CHECK constraint for import_source
ALTER TABLE bank_transaction_staging
  DROP CONSTRAINT IF EXISTS bank_transaction_staging_import_source_check;

-- Recreate with 'ofx' included
ALTER TABLE bank_transaction_staging
  ADD CONSTRAINT bank_transaction_staging_import_source_check
  CHECK (import_source IN ('pdf', 'image', 'csv', 'manual', 'api', 'ofx'));

COMMENT ON COLUMN bank_transaction_staging.import_source IS
  'Source of the import: pdf, image, csv, manual, api, ofx';
