-- ============================================================================
-- Migration 048: Bank Allocation Rules
-- ============================================================================
-- Purpose:
--   Creates per-company bank allocation rules. Rules match unallocated
--   bank transactions by description pattern and suggest an account + VAT
--   setting. Rules are suggest-only — no rule auto-posts to the GL.
--
-- Tables created:
--   bank_allocation_rules  — per-company pattern → account mapping
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 047_bank_recon_sessions.sql must already be applied
-- Safe: CREATE TABLE IF NOT EXISTS, additive only
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_allocation_rules (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Matching
  match_type           VARCHAR(20) NOT NULL DEFAULT 'contains'
                       CHECK (match_type IN ('exact', 'contains', 'starts_with')),
  match_pattern        TEXT NOT NULL,        -- raw pattern as the user entered it
  normalized_pattern   TEXT NOT NULL,        -- normalised version used for matching

  -- Allocation output
  allocation_type      VARCHAR(30) NOT NULL DEFAULT 'account'
                       CHECK (allocation_type IN ('account')),
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  vat_setting_id       INTEGER NULL REFERENCES vat_settings(id) ON DELETE SET NULL,

  -- Priority and control (lower number = higher priority)
  priority             INTEGER NOT NULL DEFAULT 100,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,

  -- Source tracking
  source               VARCHAR(30) NOT NULL DEFAULT 'user'
                       CHECK (source IN ('user', 'manual')),

  -- Audit
  created_by_user_id   INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_applied_at      TIMESTAMPTZ,          -- when this rule last triggered a suggestion
  apply_count          INTEGER NOT NULL DEFAULT 0
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_bank_rules_company_active
  ON bank_allocation_rules(company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_bank_rules_priority
  ON bank_allocation_rules(company_id, priority, is_active);

-- Partial index: only active rules — used by the suggest query
CREATE INDEX IF NOT EXISTS idx_bank_rules_normalized
  ON bank_allocation_rules(company_id, normalized_pattern)
  WHERE is_active = TRUE;

-- updated_at trigger (reuses the function created in migration 020)
DROP TRIGGER IF EXISTS bank_rules_updated_at ON bank_allocation_rules;
CREATE TRIGGER bank_rules_updated_at
  BEFORE UPDATE ON bank_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
