-- ============================================================================
-- Migration: Add/Update Company Fields for Paytime Full Detail
-- ============================================================================
-- This migration ensures the companies table supports all required fields for Paytime.
-- Safe to run multiple times (uses IF NOT EXISTS / idempotent).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS trading_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS nature_of_business VARCHAR(255),
  ADD COLUMN IF NOT EXISTS financial_year_end VARCHAR(20),
  ADD COLUMN IF NOT EXISTS paye_reference_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS uif_reference_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sdl_reference_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS coid_reference_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS income_tax_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS website VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_street VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_suburb VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_city VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_province VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address_postal_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_branch_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_account_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pay_frequencies TEXT[],
  ADD COLUMN IF NOT EXISTS pay_day VARCHAR(20),
  ADD COLUMN IF NOT EXISTS normal_work_hours VARCHAR(20),
  ADD COLUMN IF NOT EXISTS logo_url VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payslip_display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payslip_address_line1 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_date DATE,
  ADD COLUMN IF NOT EXISTS directors JSONB DEFAULT '[]'::JSONB;

-- Date created is handled by created_at timestamp (already present)
-- If you need to backfill or migrate data, add UPDATE statements here.

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================