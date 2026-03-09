-- =============================================================================
-- Lorenco Paytime — Supabase Schema
-- =============================================================================
-- Run this in the Supabase SQL Editor to create the payroll KV store table.
-- This table replaces the local payroll-data.json file.
-- =============================================================================

-- ─── Key-Value Store (stores all payroll data as JSON) ───────────────────────
-- Mirrors the localStorage / JSON file pattern but in cloud storage.
-- Each key maps to a JSON value, supporting all existing DataAccess operations:
--   employees_{companyId}, payruns_{companyId}, payroll_items_{companyId},
--   emp_payroll_{companyId}_{empId}, payslip_archive_*, etc.
-- =============================================================================

CREATE TABLE IF NOT EXISTS payroll_kv_store (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for prefix-based lookups (e.g. all keys starting with "employees_")
CREATE INDEX IF NOT EXISTS idx_payroll_kv_key_prefix ON payroll_kv_store (key text_pattern_ops);

-- Auto-update the updated_at timestamp on every change
CREATE OR REPLACE FUNCTION update_payroll_kv_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payroll_kv_updated ON payroll_kv_store;
CREATE TRIGGER trg_payroll_kv_updated
  BEFORE UPDATE ON payroll_kv_store
  FOR EACH ROW
  EXECUTE FUNCTION update_payroll_kv_timestamp();

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- For now, allow full access via service-role key (backend handles auth).
-- You can add RLS policies later for per-company access if needed.
ALTER TABLE payroll_kv_store ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON payroll_kv_store
  FOR ALL
  USING (true)
  WITH CHECK (true);
