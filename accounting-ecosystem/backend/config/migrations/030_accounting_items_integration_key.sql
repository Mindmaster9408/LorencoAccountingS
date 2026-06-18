-- =============================================================================
-- Migration 030: Add integration_key to accounting_items
-- =============================================================================
-- Part of ACC-CORE-034: Products & Services Catalogue
-- Run in Supabase SQL Editor.
--
-- Changes:
--   1. accounting_items — add nullable integration_key TEXT column
--      Used for future mapping to POS (Checkout Charlie) or Storehouse items.
--      Nullable — no existing rows require a value.
-- =============================================================================

BEGIN;

ALTER TABLE accounting_items
  ADD COLUMN IF NOT EXISTS integration_key TEXT;

-- Partial index: only non-null keys need fast lookup
CREATE INDEX IF NOT EXISTS idx_accounting_items_integration_key
  ON accounting_items(company_id, integration_key)
  WHERE integration_key IS NOT NULL;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'accounting_items'
  AND column_name = 'integration_key';
