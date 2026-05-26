-- ============================================================================
-- Migration 024: Add is_demo flag to companies table
-- Run once in Supabase SQL Editor.
-- ============================================================================

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.is_demo IS
    'True for automatically provisioned demo companies (e.g. Paytime 30-day demo). '
    'Demo expiry is enforced via subscription_expires_at + subscription_status = ''demo''.';
