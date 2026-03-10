-- =============================================================================
-- Migration 007: Add payroll_kv_store_eco table
-- =============================================================================
-- This table is the cloud-backed localStorage bridge for the Paytime payroll
-- frontend. It stores per-company key/value data so payroll page state
-- survives browser clears and works across devices.
--
-- Run this in the Supabase SQL editor if your DB was created before this was
-- added to database/schema.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
  company_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, key)
);

ALTER TABLE payroll_kv_store_eco ENABLE ROW LEVEL SECURITY;
