-- ============================================================================
-- 019_year_end_close.sql
-- Creates the year_end_close_records table used by the year-end close feature.
-- Safe to run multiple times — uses IF NOT EXISTS.
-- Run this in the Supabase SQL Editor.
-- ============================================================================

-- ── 1. Year-End Close Records ─────────────────────────────────────────────────
-- Tracks every completed year-end close operation per company.
-- One row per (company_id, from_date, to_date) — enforced by unique constraint.
-- The closing_journal_id points to the closing journal entry in the journals table.
CREATE TABLE IF NOT EXISTS year_end_close_records (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  financial_year_label VARCHAR(20)  NOT NULL,
  from_date            DATE         NOT NULL,
  to_date              DATE         NOT NULL,
  closing_journal_id   INTEGER      REFERENCES journals(id),
  closed_by_user_id    INTEGER      REFERENCES users(id),
  closed_at            TIMESTAMPTZ  DEFAULT NOW(),
  net_amount           NUMERIC(15,2),
  status               VARCHAR(20)  DEFAULT 'closed',
  CONSTRAINT year_end_close_unique UNIQUE(company_id, from_date, to_date)
);

-- Index for fast company-scoped lookup
CREATE INDEX IF NOT EXISTS idx_year_end_close_company
  ON year_end_close_records(company_id);
