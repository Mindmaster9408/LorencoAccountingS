-- ============================================================================
-- Migration 063: Supplier Invoice OCR Draft Staging Layer
-- ============================================================================
-- Purpose:
--   Creates a forensic staging table for supplier invoice PDF/image uploads
--   that have been parsed by OCR but not yet reviewed and approved by an
--   accountant.
--
--   FORENSIC PRINCIPLE:
--     OCR results are NEVER accounting truth.
--     An OCR draft MUST be reviewed and explicitly approved before a
--     supplier invoice is created and posted to the GL.
--     No GL journal may ever be created directly from an OCR upload.
--
-- Workflow:
--   UPLOAD → OCR EXTRACT → supplier_invoice_ocr_drafts (status='draft')
--   → Human Review / Edit → status='reviewed'
--   → Approve → supplier_invoices created → status='converted'
--
-- Columns:
--   ocr_raw            — full InvoiceOcrService response (immutable after upload)
--   extracted_header   — header fields parsed by OCR (immutable after upload)
--   extracted_lines    — line items parsed by OCR (immutable after upload)
--   reviewer_header    — accountant's corrected header fields
--   reviewer_lines     — accountant's corrected/confirmed line items
--   confidence_summary — per-field confidence scores from OCR
--
-- Run in: Supabase SQL Editor
-- Prerequisite: supplier_invoices table already exists
-- Safe: new table only — no changes to existing tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplier_invoice_ocr_drafts (
  id                          SERIAL PRIMARY KEY,
  company_id                  INTEGER  NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  supplier_id                 INTEGER  NULL     REFERENCES suppliers(id)  ON DELETE SET NULL,

  -- Lifecycle status
  status                      TEXT     NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewed', 'approved', 'rejected', 'converted')),

  -- Uploaded file metadata (file stored on disk; nullable if storage failed)
  original_filename           TEXT,
  file_mime_type              TEXT,
  file_size_bytes             INTEGER,
  file_path                   TEXT     NULL,   -- disk path relative to /uploads/

  -- OCR output — immutable after upload, preserves original extraction
  ocr_raw                     JSONB    NOT NULL DEFAULT '{}',
  extracted_header            JSONB    NOT NULL DEFAULT '{}',
  extracted_lines             JSONB    NOT NULL DEFAULT '[]',
  confidence_summary          JSONB    NOT NULL DEFAULT '{}',

  -- Reviewer-edited values (populated as reviewer corrects/confirms OCR output)
  reviewer_header             JSONB    NOT NULL DEFAULT '{}',
  reviewer_lines              JSONB    NOT NULL DEFAULT '[]',

  -- Internal notes
  notes                       TEXT,
  rejection_reason            TEXT,

  -- User tracking
  created_by_user_id          INTEGER  NULL REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_user_id         INTEGER  NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id         INTEGER  NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Outcome link — set when draft is converted to a real invoice
  converted_supplier_invoice_id INTEGER NULL REFERENCES supplier_invoices(id) ON DELETE SET NULL,

  -- Timestamps
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at                 TIMESTAMPTZ NULL,
  approved_at                 TIMESTAMPTZ NULL,
  rejected_at                 TIMESTAMPTZ NULL,
  converted_at                TIMESTAMPTZ NULL,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- Primary query: drafts by company + status (review queue)
CREATE INDEX IF NOT EXISTS idx_siod_company_status
  ON supplier_invoice_ocr_drafts (company_id, status);

-- Secondary: filter by supplier within a company
CREATE INDEX IF NOT EXISTS idx_siod_company_supplier
  ON supplier_invoice_ocr_drafts (company_id, supplier_id)
  WHERE supplier_id IS NOT NULL;

-- Traceability: find the draft that produced a given invoice
CREATE INDEX IF NOT EXISTS idx_siod_converted_invoice
  ON supplier_invoice_ocr_drafts (converted_supplier_invoice_id)
  WHERE converted_supplier_invoice_id IS NOT NULL;

-- Date ordering for list queries
CREATE INDEX IF NOT EXISTS idx_siod_created_at
  ON supplier_invoice_ocr_drafts (company_id, created_at DESC);

-- ── Auto-update trigger ───────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS siod_updated_at ON supplier_invoice_ocr_drafts;
CREATE TRIGGER siod_updated_at
  BEFORE UPDATE ON supplier_invoice_ocr_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Summary:
--   supplier_invoice_ocr_drafts stores every supplier invoice OCR upload
--   through its full lifecycle: draft → reviewed → converted (or rejected).
--   The raw OCR output is preserved unchanged in ocr_raw/extracted_*.
--   Reviewer edits are stored separately in reviewer_*.
--   GL posting only occurs AFTER the approve endpoint is called, which
--   internally uses the existing safe supplier invoice creation logic.
-- ============================================================================
