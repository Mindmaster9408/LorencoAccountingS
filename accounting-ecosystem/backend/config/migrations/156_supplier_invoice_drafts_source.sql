-- =============================================================================
-- Migration 156: Add source tracking to supplier_invoice_ocr_drafts
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: the customer/supplier company-link feature (migration 155,
-- backend/shared/routes/client-links.js) needs a "this arrived as a draft,
-- a human must review and approve it before a real supplier_invoice is
-- created and posted to the GL" flow — exactly what
-- supplier_invoice_ocr_drafts already does for OCR uploads. Rather than
-- build a second, parallel draft-review-approve mechanism (a second table,
-- a second set of /review, /reject, /approve routes, duplicating all of
-- supplierOcrDrafts.js's forensic gates), this reuses that exact table and
-- its existing routes — see
-- docs/leo-customer-supplier-linking-and-invoice-pullthrough.md for why.
--
-- Adds:
--   source                     — 'ocr' (default, existing behaviour
--                                 unchanged) or 'company_link' (this feature)
--   source_customer_invoice_id — the SENDING company's customer_invoices.id,
--                                 for traceability back to the original
--                                 invoice (a different company's row — no FK,
--                                 cross-company by design)
--   source_company_id          — the SENDING company's id, same reason
--
-- Purely additive — no existing column touched, no existing row's behaviour
-- changed (source defaults to 'ocr' for every row that already exists).
-- =============================================================================

ALTER TABLE supplier_invoice_ocr_drafts
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ocr',
  ADD COLUMN IF NOT EXISTS source_customer_invoice_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_company_id INTEGER;

ALTER TABLE supplier_invoice_ocr_drafts DROP CONSTRAINT IF EXISTS supplier_invoice_ocr_drafts_source_check;
ALTER TABLE supplier_invoice_ocr_drafts ADD CONSTRAINT supplier_invoice_ocr_drafts_source_check
  CHECK (source IN ('ocr', 'company_link'));

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'supplier_invoice_ocr_drafts'
  AND column_name IN ('source', 'source_customer_invoice_id', 'source_company_id');
