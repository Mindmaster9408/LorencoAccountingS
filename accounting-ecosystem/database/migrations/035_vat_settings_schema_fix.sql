-- ============================================================================
-- Migration 035: Complete vat_settings schema fix + companies VAT columns
-- ============================================================================
--
-- ROOT CAUSE BEING FIXED:
--   Migration 034 ran CREATE TABLE IF NOT EXISTS vat_settings (...) but the
--   table ALREADY EXISTED from schema.sql with the OLD single-row-per-company
--   design. PostgreSQL's IF NOT EXISTS skipped the CREATE entirely. The only
--   changes 034 applied were two ALTER TABLE statements that added is_capital
--   and is_active.
--
--   Missing columns that were never added to the existing table:
--     code, name, rate, effective_from, effective_to, sort_order, created_at
--
--   Additionally:
--     - is_vat_registered lived on the OLD vat_settings table (one row per
--       company). The new schema moves this flag to companies instead.
--     - companies.is_vat_registered, vat_cycle_type, vat_registered_date
--       do not exist on companies and must be added here.
--
-- EFFECT OF THIS MISSING SCHEMA:
--   GET /api/accounting/vat-settings/active queries:
--     .select('id, code, name, rate, is_capital, effective_from, ...')
--   PostgreSQL returns "column vat_settings.code does not exist" → Supabase
--   JS client returns this as an error object → throw error → outer catch →
--   HTTP 500. The bank page loadVatSettings() sees !res.ok and returns early,
--   leaving _companyIsVatRegistered = false → VAT dropdown hidden ("—").
--
-- RUN THIS MANUALLY IN THE SUPABASE SQL EDITOR.
-- This is NOT auto-run by the server on startup.
-- ============================================================================

-- ── Step 1: Add missing columns to vat_settings ──────────────────────────────

ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS code           VARCHAR(30);
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS name           VARCHAR(100);
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS rate           NUMERIC(5,2)  DEFAULT 0;
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS effective_from DATE;
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS effective_to   DATE;
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS sort_order     INTEGER       DEFAULT 0;
ALTER TABLE vat_settings ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ   DEFAULT NOW();

-- ── Step 2: Add VAT registration columns to companies ────────────────────────
-- These were incorrectly placed on vat_settings in the original schema.
-- The source of truth for company-level VAT status belongs on companies.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_vat_registered   BOOLEAN  DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_cycle_type      VARCHAR(30);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_registered_date DATE;

-- ── Step 3: Migrate is_vat_registered from old vat_settings rows → companies ─
-- Old schema had one row per company with is_vat_registered on that row.
-- Move it to companies so it survives the deletion of old rows in Step 6.

UPDATE companies c
SET    is_vat_registered = true
WHERE  EXISTS (
    SELECT 1
    FROM   vat_settings vs
    WHERE  vs.company_id       = c.id
    AND    vs.is_vat_registered = true
);

-- ── Step 4: Migrate vat_number from old vat_settings rows → companies ────────
-- vat_number already exists on companies (from base schema.sql line 28).
-- Copy value from vat_settings where companies row is still empty.

UPDATE companies c
SET    vat_number = vs.vat_number
FROM   vat_settings vs
WHERE  vs.company_id  = c.id
AND    vs.vat_number  IS NOT NULL
AND    vs.vat_number  <> ''
AND    (c.vat_number  IS NULL OR c.vat_number = '');

-- ── Step 5: Drop old UNIQUE(company_id) constraint ────────────────────────────
-- This constraint permits only ONE row per company. The new design requires
-- multiple rows per company (one per VAT category).
-- PostgreSQL auto-names this constraint: vat_settings_company_id_key

ALTER TABLE vat_settings DROP CONSTRAINT IF EXISTS vat_settings_company_id_key;

-- ── Step 6: Delete old single-config stub rows ────────────────────────────────
-- Rows with code IS NULL are from the old single-row-per-company design.
-- Their is_vat_registered and vat_number data has been copied to companies
-- (Steps 3–4 above). These rows are no longer needed and are incompatible
-- with the new multi-row schema.
-- NOTE: The /active endpoint auto-seeds SA standard VAT categories on first
-- access for any VAT-registered company. No manual re-seeding is required.

DELETE FROM vat_settings WHERE code IS NULL;

-- ── Step 7: Add new unique constraint for multi-category design ───────────────
-- After Step 6, the table only contains properly-coded rows (or is empty).
-- Add the correct composite unique constraint.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'vat_settings_company_code_from_key'
  ) THEN
    ALTER TABLE vat_settings
      ADD CONSTRAINT vat_settings_company_code_from_key
      UNIQUE (company_id, code, effective_from);
  END IF;
END $$;

-- ── Step 8: Performance index ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_vat_settings_company_active
    ON vat_settings (company_id, is_active);

-- ============================================================================
-- END OF MIGRATION 035
--
-- AFTER RUNNING THIS:
--   1. The first GET /api/accounting/vat-settings/active call for any
--      VAT-registered company will auto-seed 6 SA standard VAT categories.
--   2. The VAT Type dropdown on the bank page will appear for VAT-registered
--      companies when Transaction Type = Account.
--   3. Saving VAT registration status from Company Profile will now persist
--      correctly (companies.is_vat_registered column now exists).
--   4. Bulk delete will stabilise once the 500/502 cascade is resolved.
-- ============================================================================
