-- ============================================================================
-- Migration 012 — SQL persistence for voluntary tax config and PAYE recon
-- ============================================================================
-- Run in Supabase SQL Editor.
-- Fixes audit findings H3, H1, H2.
-- ============================================================================

-- H3: voluntary_tax_config on employees
-- Stores { type, fixed_amount, variable_amount, period, monthly_spread_amount,
--          start_period, end_period, reference } JSONB per employee.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS voluntary_tax_config JSONB DEFAULT NULL;

-- H1: SARS-submitted and bank-paid figures per period
-- One row per company + period_key. Updated by the PAYE recon page.
CREATE TABLE IF NOT EXISTS payroll_recon_submitted (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_key    VARCHAR(7) NOT NULL,          -- 'YYYY-MM'
  paye_submitted NUMERIC(12,2) DEFAULT 0,     -- what was submitted to SARS
  uif_submitted  NUMERIC(12,2) DEFAULT 0,
  sdl_submitted  NUMERIC(12,2) DEFAULT 0,
  paye_bank      NUMERIC(12,2) DEFAULT 0,     -- what was paid via bank
  uif_bank       NUMERIC(12,2) DEFAULT 0,
  sdl_bank       NUMERIC(12,2) DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, period_key)
);

-- H2: Finalized PAYE reconciliation state per tax year
-- One row per company + tax_year (e.g. '2025/2026').
CREATE TABLE IF NOT EXISTS payroll_recon_finalized (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_year      VARCHAR(9) NOT NULL,          -- 'YYYY/YYYY'
  is_finalized  BOOLEAN DEFAULT FALSE,
  finalized_by  TEXT,
  finalized_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, tax_year)
);

-- Reload PostgREST schema cache so new columns and tables are visible immediately
NOTIFY pgrst, 'reload schema';
