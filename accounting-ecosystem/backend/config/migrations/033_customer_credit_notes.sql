-- =============================================================================
-- Migration 033: Customer Credit Notes (ACC-CORE-036)
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Purpose: Creates the Customer Credit Notes module tables.
--
-- Design rules:
--   - Credit notes are append-only accounting events (never modify invoices)
--   - source_invoice_id is nullable — supports both standalone and invoice-linked CNs
--   - posted_journal_id links to the reversing GL journal created on posting
--   - Voiding a posted credit note creates a second reversal journal (append-only)
--   - No stock, no warehouse, no POS returns — accounting credit notes only
--
-- Tables created:
--   1. customer_credit_notes       — header, one per credit note
--   2. customer_credit_note_lines  — line items for each credit note
-- =============================================================================

BEGIN;

-- ─── 1. customer_credit_notes ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_credit_notes (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id           INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name         TEXT NOT NULL,

  -- Numbering
  credit_note_number    TEXT NOT NULL,

  -- Dates
  credit_note_date      DATE NOT NULL,

  -- Status lifecycle: draft → posted → void
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','posted','void')),

  -- Business metadata
  reason                TEXT,        -- e.g. "Billing error", "Goodwill credit", "Quantity adjustment"
  notes                 TEXT,

  -- Invoice link (nullable for standalone credit notes)
  source_invoice_id     INTEGER REFERENCES customer_invoices(id) ON DELETE SET NULL,

  -- Calculated totals (always ex-VAT storage, matches invoice convention)
  subtotal_ex_vat       NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc_vat         NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- GL journal created when posted (null until posted)
  posted_journal_id     INTEGER REFERENCES journals(id) ON DELETE SET NULL,

  -- Governance
  created_by_user_id    INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Credit note number is unique per company (prevents duplicate numbering)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_credit_notes_number
  ON customer_credit_notes(company_id, credit_note_number);

CREATE INDEX IF NOT EXISTS idx_customer_credit_notes_company
  ON customer_credit_notes(company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_customer_credit_notes_status
  ON customer_credit_notes(company_id, status);

CREATE INDEX IF NOT EXISTS idx_customer_credit_notes_customer
  ON customer_credit_notes(company_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_credit_notes_source_invoice
  ON customer_credit_notes(source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;

-- ─── 2. customer_credit_note_lines ───────────────────────────────────────────
-- Mirrors customer_invoice_lines exactly (same columns, CN-scoped).

CREATE TABLE IF NOT EXISTS customer_credit_note_lines (
  id              SERIAL PRIMARY KEY,
  credit_note_id  INTEGER NOT NULL REFERENCES customer_credit_notes(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  line_type       TEXT NOT NULL DEFAULT 'account'
                    CHECK (line_type IN ('account','item')),
  item_id         INTEGER REFERENCES accounting_items(id) ON DELETE SET NULL,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  description     TEXT NOT NULL DEFAULT '',
  quantity        NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,4) NOT NULL DEFAULT 0,
  vat_rate        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  subtotal_ex_vat NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc_vat   NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ccnl_credit_note_id
  ON customer_credit_note_lines(credit_note_id);

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name IN ('customer_credit_notes', 'customer_credit_note_lines')
ORDER BY table_name, ordinal_position;
