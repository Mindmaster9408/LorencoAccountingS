-- ============================================================================
-- Migration 042 — Historical Comparative Financial Engine
-- ============================================================================
-- Creates the historical comparatives reporting layer.
-- This is a SEPARATE, IMMUTABLE layer — it does NOT touch:
--   journals, journal_lines, bank_transactions, vat tables, invoices,
--   customers, suppliers, or live trial balance calculations.
--
-- Safe to re-run: all CREATE/ALTER statements use IF NOT EXISTS.
-- Run once against Supabase SQL Editor.
-- ============================================================================

-- Ensure uuid generation is available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── TABLE 1: historical_comparative_batches ───────────────────────────────────
-- A batch represents one import/capture session: a named set of historical
-- monthly figures for a specific company and year range.
CREATE TABLE IF NOT EXISTS historical_comparative_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by            UUID,
  source_type           TEXT NOT NULL DEFAULT 'manual',
  source_name           TEXT,
  description           TEXT,
  financial_year_start  INTEGER,
  financial_year_end    INTEGER,
  period_granularity    TEXT NOT NULL DEFAULT 'monthly',
  report_basis          TEXT NOT NULL DEFAULT 'profit_loss',
  status                TEXT NOT NULL DEFAULT 'draft',
  finalized_at          TIMESTAMPTZ,
  finalized_by          UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT historical_comparative_batches_source_type_chk
    CHECK (source_type IN ('manual', 'csv', 'excel', 'tb_import', 'opening_capture')),

  CONSTRAINT historical_comparative_batches_status_chk
    CHECK (status IN ('draft', 'validated', 'finalized', 'archived')),

  CONSTRAINT historical_comparative_batches_period_granularity_chk
    CHECK (period_granularity IN ('monthly', 'annual')),

  CONSTRAINT historical_comparative_batches_report_basis_chk
    CHECK (report_basis IN ('profit_loss', 'trial_balance', 'balance_sheet', 'mixed'))
);

CREATE INDEX IF NOT EXISTS idx_hcb_company_id
  ON historical_comparative_batches (company_id);

CREATE INDEX IF NOT EXISTS idx_hcb_status
  ON historical_comparative_batches (status);

CREATE INDEX IF NOT EXISTS idx_hcb_company_status
  ON historical_comparative_batches (company_id, status);

-- ── TABLE 2: historical_comparative_lines ────────────────────────────────────
-- Each row is one account × one month × one financial year.
-- account_id is a soft FK to accounts(id) — nullable to allow manual account
-- entries when the account may not exist in the live COA.
-- is_finalized mirrors the batch status but is set per-line on finalization.
CREATE TABLE IF NOT EXISTS historical_comparative_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         UUID NOT NULL REFERENCES historical_comparative_batches(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  account_code     TEXT,
  account_name     TEXT NOT NULL,
  account_type     TEXT,
  financial_year   INTEGER NOT NULL,
  period_month     INTEGER NOT NULL,
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  amount           NUMERIC(18, 2) NOT NULL DEFAULT 0,
  original_amount  NUMERIC(18, 2),
  source_reference TEXT,
  capture_method   TEXT NOT NULL DEFAULT 'manual',
  entered_by       UUID,
  entered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_finalized     BOOLEAN NOT NULL DEFAULT FALSE,
  notes            TEXT,

  CONSTRAINT hcl_period_month_chk
    CHECK (period_month BETWEEN 1 AND 12),

  CONSTRAINT hcl_capture_method_chk
    CHECK (capture_method IN ('manual', 'csv', 'excel', 'tb_import', 'system_adjustment'))
);

CREATE INDEX IF NOT EXISTS idx_hcl_company_id
  ON historical_comparative_lines (company_id);

CREATE INDEX IF NOT EXISTS idx_hcl_batch_id
  ON historical_comparative_lines (batch_id);

CREATE INDEX IF NOT EXISTS idx_hcl_account_id
  ON historical_comparative_lines (account_id);

CREATE INDEX IF NOT EXISTS idx_hcl_period
  ON historical_comparative_lines (company_id, financial_year, period_month);

-- Unique constraint: one amount per account per period per batch
-- Only enforced when account_id is set (non-null).
-- When account_id is null (free-text account), uniqueness is not enforced at DB level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hcl_batch_account_period
  ON historical_comparative_lines (batch_id, account_id, financial_year, period_month)
  WHERE account_id IS NOT NULL;

-- ── TABLE 3: historical_comparative_audit_log ─────────────────────────────────
-- Append-only audit trail. Every create/update/delete/block is recorded.
-- Never update or delete from this table.
CREATE TABLE IF NOT EXISTS historical_comparative_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id     UUID,
  line_id      UUID,
  action       TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  reason       TEXT,
  performed_by UUID,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hcal_action_chk
    CHECK (action IN (
      'BATCH_CREATED',
      'BATCH_UPDATED',
      'LINE_CREATED',
      'LINE_UPDATED',
      'LINE_DELETED',
      'BATCH_VALIDATED',
      'BATCH_FINALIZED',
      'BATCH_ARCHIVED',
      'FINALIZED_EDIT_BLOCKED'
    ))
);

CREATE INDEX IF NOT EXISTS idx_hcal_company_id
  ON historical_comparative_audit_log (company_id);

CREATE INDEX IF NOT EXISTS idx_hcal_batch_id
  ON historical_comparative_audit_log (batch_id);

CREATE INDEX IF NOT EXISTS idx_hcal_performed_at
  ON historical_comparative_audit_log (performed_at DESC);
