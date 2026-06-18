-- =============================================================================
-- Migration 031: Quotes / Estimates Module
-- =============================================================================
-- Part of ACC-CORE-035
-- Run in Supabase SQL Editor.
--
-- Changes:
--   1. customer_quotes      — quote / estimate headers, one per quote
--   2. customer_quote_lines — line items for each quote
--
-- Naming convention matches customer_invoices / customer_invoice_lines exactly:
--   subtotal_ex_vat, vat_amount, total_inc_vat (not subtotal/vat_total/total)
-- This makes convert-to-invoice a clean column-to-column copy.
--
-- Quotes do NOT affect GL, AR, VAT reports, or stock.
-- GL impact only happens after conversion to a posted invoice.
-- =============================================================================

BEGIN;

-- ─── 1. customer_quotes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_quotes (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id          INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name        TEXT NOT NULL,
  quote_number         TEXT NOT NULL,
  quote_date           DATE NOT NULL,
  expiry_date          DATE,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','sent','accepted','declined','expired','converted','void')),
  vat_mode             TEXT NOT NULL DEFAULT 'exclusive'
                         CHECK (vat_mode IN ('exclusive','inclusive')),
  notes                TEXT,
  terms                TEXT,
  subtotal_ex_vat      NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc_vat        NUMERIC(12,2) NOT NULL DEFAULT 0,
  converted_invoice_id INTEGER REFERENCES customer_invoices(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- quote_number is unique per company (prevents duplicate numbering)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_quotes_number
  ON customer_quotes(company_id, quote_number);

CREATE INDEX IF NOT EXISTS idx_customer_quotes_company
  ON customer_quotes(company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_customer_quotes_status
  ON customer_quotes(company_id, status);

CREATE INDEX IF NOT EXISTS idx_customer_quotes_customer
  ON customer_quotes(company_id, customer_id)
  WHERE customer_id IS NOT NULL;

-- ─── 2. customer_quote_lines ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_quote_lines (
  id              SERIAL PRIMARY KEY,
  quote_id        INTEGER NOT NULL REFERENCES customer_quotes(id) ON DELETE CASCADE,
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
  total_inc_vat   NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cql_quote_id
  ON customer_quote_lines(quote_id);

CREATE INDEX IF NOT EXISTS idx_cql_quote_item
  ON customer_quote_lines(item_id)
  WHERE item_id IS NOT NULL;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT
  table_name,
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_name IN ('customer_quotes', 'customer_quote_lines')
ORDER BY table_name, ordinal_position;
