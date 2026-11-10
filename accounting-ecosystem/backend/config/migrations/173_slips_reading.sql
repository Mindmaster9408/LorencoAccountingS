-- ============================================================================
-- Migration 173: Slip Capture — reading slips (Tesseract + supplier memory)
-- ============================================================================
-- Adds the "read the slip for me" layers (2026-11-05):
--   Layer 1  supplier memory  — per company, learned ONLY from details a
--                               person saved (never from raw OCR guesses)
--   Layer 2  Tesseract OCR    — on our own server, nothing leaves it
--   (Layer 3 external AI is deliberately NOT built — blocked until Ruan
--    approves it and a key exists. slip_readings.needs_review is the flag
--    such a layer would act on.)
--
-- A reading is only ever a SUGGESTION. It never writes into the slip's own
-- fields; the person confirms and saves. slip_readings keeps exactly what the
-- machine proposed, append-only, next to what the person saved on slips.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- ============================================================================

-- ── New detail fields on slips (editable, like the others) ──────────────────
ALTER TABLE slips ADD COLUMN IF NOT EXISTS vat_amount          NUMERIC(14,2) NULL;
ALTER TABLE slips ADD COLUMN IF NOT EXISTS supplier_vat_number TEXT NULL;
ALTER TABLE slips ADD COLUMN IF NOT EXISTS reading_status      TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slips_reading_status_check') THEN
    ALTER TABLE slips ADD CONSTRAINT slips_reading_status_check
      CHECK (reading_status IS NULL OR reading_status IN ('pending','done','failed','unavailable','unsupported'));
  END IF;
END $$;

-- ── slip_readings: what the machine read (append-only) ─────────────────────
CREATE TABLE IF NOT EXISTS slip_readings (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  slip_id         INTEGER NOT NULL REFERENCES slips(id) ON DELETE RESTRICT,
  engine          TEXT NOT NULL,               -- e.g. 'tesseract', 'pdf-text'
  engine_detail   TEXT NULL,                   -- which pass/variant won
  status          TEXT NOT NULL CHECK (status IN ('done','failed','unavailable','unsupported')),
  raw_text        TEXT NULL,
  ocr_confidence  NUMERIC(5,2) NULL,           -- tesseract mean word confidence 0–100
  suggestion      JSONB NOT NULL DEFAULT '{}'::jsonb,
  checks          JSONB NOT NULL DEFAULT '[]'::jsonb,
  needs_review    BOOLEAN NOT NULL DEFAULT TRUE,
  error           TEXT NULL,
  duration_ms     INTEGER NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_slip_readings_slip ON slip_readings (slip_id, id DESC);
ALTER TABLE slip_readings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION slip_readings_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'slip_readings is append-only (% on id=%)', TG_OP, OLD.id;
END;
$$;
DROP TRIGGER IF EXISTS slip_readings_no_update ON slip_readings;
CREATE TRIGGER slip_readings_no_update BEFORE UPDATE ON slip_readings
  FOR EACH ROW EXECUTE FUNCTION slip_readings_append_only();
DROP TRIGGER IF EXISTS slip_readings_no_delete ON slip_readings;
CREATE TRIGGER slip_readings_no_delete BEFORE DELETE ON slip_readings
  FOR EACH ROW EXECUTE FUNCTION slip_readings_append_only();

-- ── slip_supplier_memory: per-company, learned from confirmed details ───────
-- Company-scoped only. Sharing a mapping across companies would be a global
-- change and must go through Sean's approval flow (CLAUDE.md Part B) — not here.
CREATE TABLE IF NOT EXISTS slip_supplier_memory (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name_key             TEXT NOT NULL,          -- normalised supplier name (lowercase a-z0-9)
  supplier_name        TEXT NOT NULL,
  supplier_vat_number  TEXT NULL,
  category             TEXT NULL,
  times_confirmed      INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name_key)
);
CREATE INDEX IF NOT EXISTS idx_slip_supplier_memory_vat ON slip_supplier_memory (company_id, supplier_vat_number);
ALTER TABLE slip_supplier_memory ENABLE ROW LEVEL SECURITY;
