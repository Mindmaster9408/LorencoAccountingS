-- Migration 077: opt-in toggle for POS (Checkout Charlie) -> Accounting GL sync
--
-- Ruan's explicit requirement: pulling Charlie's daily sales into the
-- Accounting books must never happen automatically/silently -- a company
-- must explicitly opt in via Accounting -> Settings first. Defaults to
-- false so every existing company is unaffected until someone turns it on.
--
-- Follows the same pattern the accounting module already uses for its own
-- per-company settings (ALTER TABLE companies ADD COLUMN ... — see
-- 012_accounting_schema.sql's vat_period/income_tax_number etc.) rather than
-- reaching into POS's own company_settings table.
--
-- Run in: Supabase SQL Editor
-- Date: 2026-08-15

ALTER TABLE companies ADD COLUMN IF NOT EXISTS pos_gl_sync_enabled BOOLEAN DEFAULT false;
