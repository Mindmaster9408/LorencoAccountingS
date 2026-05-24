-- Migration 047: Bank Reconciliation Sessions + Allocation Display Columns
-- Created: 2026-05-24
--
-- Closes audit gaps G1, G2, G3, R1, R3, R4 from BANK_TB_RECON_FORENSIC_AUDIT.md:
--   G1/R1: No persisted statement closing balance → bank_recon_sessions.statement_closing_balance
--   G2/R4: No audit trail of reconciliation sessions → bank_recon_sessions table
--   G3/R3: Allocation display columns only in server auto-migration → formalised here
--
-- DO NOT CHANGE: bank import flow, staging, duplicate detection, transfer detection,
--               allocation journal creation, VAT split, JournalService, TB source logic,
--               GL report logic, opening balances, historical comparatives.

-- ─────────────────────────────────────────────────────────────────────────────
-- PART A: Formalise allocation display columns on bank_transactions
-- These columns already exist on production (added by accounting-schema.js auto-migration).
-- This migration makes them an official, numbered, tracked schema change.
-- Using ADD COLUMN IF NOT EXISTS so this is safe to run on existing production DB.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS allocated_account_id   INTEGER REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS allocation_type        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS allocated_account_name TEXT,
  ADD COLUMN IF NOT EXISTS vat_setting_id         INTEGER REFERENCES vat_settings(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- PART B: Create bank_recon_sessions table
-- One row per completed bank reconciliation session.
-- Groups a batch of reconciled bank_transactions together with the statement
-- closing balance and date entered by the accountant.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_recon_sessions (
  id                        SERIAL PRIMARY KEY,
  company_id                INTEGER NOT NULL REFERENCES companies(id),
  bank_account_id           INTEGER NOT NULL REFERENCES bank_accounts(id),
  statement_date            DATE NOT NULL,
  statement_closing_balance NUMERIC(15,2) NOT NULL,
  cleared_balance           NUMERIC(15,2) NOT NULL,
  difference                NUMERIC(15,2) NOT NULL,
  transaction_count         INTEGER NOT NULL,
  created_by                INTEGER REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_sessions_company
  ON bank_recon_sessions(company_id, bank_account_id, statement_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- PART C: Add recon_session_id FK to bank_transactions
-- Links each reconciled transaction back to its session for audit purposes.
-- NULL = not yet part of a formal session (pre-migration reconciled rows are fine).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS recon_session_id INTEGER REFERENCES bank_recon_sessions(id);

CREATE INDEX IF NOT EXISTS idx_bank_txn_recon_session
  ON bank_transactions(recon_session_id)
  WHERE recon_session_id IS NOT NULL;
