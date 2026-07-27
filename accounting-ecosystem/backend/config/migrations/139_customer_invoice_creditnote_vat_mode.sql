-- =============================================================================
-- Migration 139: Persist VAT entry mode on Customer Invoices & Credit Notes
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: customer_invoices / customer_credit_notes never recorded whether
-- a document was entered "Inclusive of VAT" or "Exclusive of VAT". The line
-- unit_price is stored as the raw literal number the user typed (gross if
-- Inclusive, net if Exclusive) — genuinely ambiguous once saved. Reopening
-- an existing document always defaulted the UI toggle back to Exclusive,
-- so re-saving an Inclusive-mode document unchanged silently charged VAT a
-- second time on the same base amount.
--
-- Fix: add a persisted vat_mode column (same name/type/values as the
-- existing customer_quotes.vat_mode from migration 031) so the edit UI can
-- restore the correct toggle state on reopen. Purely additive — existing
-- rows default to 'exclusive', which matches their current (hardcoded)
-- reopen behaviour exactly, so no historical data changes meaning.
-- =============================================================================

BEGIN;

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS vat_mode TEXT NOT NULL DEFAULT 'exclusive'
    CHECK (vat_mode IN ('exclusive','inclusive'));

ALTER TABLE customer_credit_notes
  ADD COLUMN IF NOT EXISTS vat_mode TEXT NOT NULL DEFAULT 'exclusive'
    CHECK (vat_mode IN ('exclusive','inclusive'));

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name IN ('customer_invoices', 'customer_credit_notes')
  AND column_name = 'vat_mode';
