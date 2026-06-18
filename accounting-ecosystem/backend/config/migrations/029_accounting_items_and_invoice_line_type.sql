-- =============================================================================
-- Migration 029: Accounting Items Master + Invoice Line Type Support
-- =============================================================================
-- Part of ACC-CORE-033: Invoice Customer Add + Item/Service Line Foundation
-- Run in Supabase SQL Editor.
--
-- Changes:
--   1. accounting_items        — lightweight item/service catalogue per company
--   2. customer_invoice_lines  — add line_type + item_id columns
--   3. customers               — add vat_number column (safe, IF NOT EXISTS)
-- =============================================================================

BEGIN;

-- ─── 1. Accounting Items Master ──────────────────────────────────────────────
-- Lightweight item/service catalogue scoped to each company.
-- This is NOT a stock management table — Storehouse owns stock quantity.
-- item_type 'inventory' means the product exists in Storehouse; 'service' and
-- 'non_stock' have no stock dimension at all.
-- income_account_id stores the default revenue account for GL posting.

CREATE TABLE IF NOT EXISTS accounting_items (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_code         TEXT,
  item_name         TEXT NOT NULL,
  item_type         TEXT NOT NULL DEFAULT 'service'
                      CHECK (item_type IN ('service', 'inventory', 'non_stock')),
  description       TEXT,
  selling_price     NUMERIC(12,2),
  income_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  tax_type          TEXT NOT NULL DEFAULT 'standard'
                      CHECK (tax_type IN ('standard', 'zero_rated', 'exempt')),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_items_company
  ON accounting_items(company_id);

CREATE INDEX IF NOT EXISTS idx_accounting_items_name
  ON accounting_items(company_id, item_name);

-- item_code unique per company when provided (null/empty are excluded)
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_items_code
  ON accounting_items(company_id, item_code)
  WHERE item_code IS NOT NULL AND item_code <> '';

-- ─── 2. Invoice Line Type Support ────────────────────────────────────────────
-- Add line_type and item_id to customer_invoice_lines.
-- All existing rows will default to line_type = 'account' — no data migration.
-- item_id is nullable; only set when line_type = 'item'.
-- account_id continues to drive GL posting for both line types:
--   - account lines: account_id = user-selected revenue account
--   - item lines:    account_id = item.income_account_id (resolved at save time)

ALTER TABLE customer_invoice_lines
  ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'account'
    CHECK (line_type IN ('account', 'item')),
  ADD COLUMN IF NOT EXISTS item_id INTEGER
    REFERENCES accounting_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cil_item_id
  ON customer_invoice_lines(item_id)
  WHERE item_id IS NOT NULL;

-- ─── 3. customers: vat_number ────────────────────────────────────────────────
-- Optional VAT number field on the POS customers table (table name: customers).
-- Added safely — no-op if the column already exists.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS vat_number TEXT;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run to confirm the changes applied correctly:
SELECT
  t.table_name,
  c.column_name,
  c.data_type,
  c.column_default,
  c.is_nullable
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_name = c.table_name
WHERE c.table_name IN ('accounting_items', 'customer_invoice_lines', 'customers')
  AND c.column_name IN (
    'id', 'item_code', 'item_name', 'item_type', 'selling_price',
    'income_account_id', 'tax_type',
    'line_type', 'item_id',
    'vat_number'
  )
ORDER BY c.table_name, c.ordinal_position;
