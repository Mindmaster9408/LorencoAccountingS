-- ============================================================================
-- Migration 172: Slip Capture app (`slips`) — core schema
-- ============================================================================
-- New module `slips` (2026-10-19, concept: docs/future-build/
-- SLIP_CAPTURE_APP_CONCEPT.md): any user photographs a slip/invoice on their
-- phone and the original is kept online, linked to their company, for at
-- least 7 years.
--
-- The file itself lives in the PRIVATE Supabase Storage bucket `slip-files`
-- (must be created once in the Supabase dashboard). This table holds the
-- metadata and the pointer to that file.
--
-- DB-enforced guarantees (not just conventions in application code):
--   1. The stored file is immutable: company_id, storage_bucket,
--      storage_path, sha256, original_filename, content_type and
--      file_size_bytes can never change after insert.
--   2. retain_until can only move later, never earlier.
--   3. A row cannot be DELETEd before retain_until. "Delete" in the app is a
--      soft hide (status = 'hidden'), which is always reversible.
--   4. company_id uses ON DELETE RESTRICT — a company that still holds slips
--      inside the retention period cannot be hard-deleted by accident.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS
-- throughout (CI applies every file in this directory on every push).
-- ============================================================================

CREATE TABLE IF NOT EXISTS slips (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  uploaded_by_user_id   INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,

  -- The stored original (immutable — see trigger below)
  original_filename     TEXT,
  content_type          TEXT NOT NULL,
  file_size_bytes       INTEGER NOT NULL CHECK (file_size_bytes > 0),
  sha256                TEXT NOT NULL,
  storage_bucket        TEXT NOT NULL,
  storage_path          TEXT NOT NULL UNIQUE,

  -- User-entered details (all optional; editable, every edit audit-logged)
  slip_date             DATE NULL,
  amount                NUMERIC(14,2) NULL,
  supplier_name         TEXT NULL,
  category              TEXT NULL,
  note                  TEXT NULL,

  -- Soft hide instead of delete
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
  hidden_at             TIMESTAMPTZ NULL,
  hidden_by_user_id     INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  hidden_reason         TEXT NULL,

  -- Retention: 7 years from the later of upload date and slip date
  retain_until          DATE NOT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slips_company_status_created ON slips (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slips_company_slip_date      ON slips (company_id, slip_date);
CREATE INDEX IF NOT EXISTS idx_slips_company_sha256         ON slips (company_id, sha256);

-- RLS on with NO policies: only the backend (service role, which bypasses
-- RLS) can read/write. The public anon key gets nothing via PostgREST.
ALTER TABLE slips ENABLE ROW LEVEL SECURITY;

-- ── Guard 1 + 2: immutable original, retain_until never earlier ────────────
CREATE OR REPLACE FUNCTION slips_guard_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id        IS DISTINCT FROM OLD.company_id
  OR NEW.storage_bucket    IS DISTINCT FROM OLD.storage_bucket
  OR NEW.storage_path      IS DISTINCT FROM OLD.storage_path
  OR NEW.sha256            IS DISTINCT FROM OLD.sha256
  OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
  OR NEW.content_type      IS DISTINCT FROM OLD.content_type
  OR NEW.file_size_bytes   IS DISTINCT FROM OLD.file_size_bytes
  -- uploader may only change to NULL (users FK ON DELETE SET NULL)
  OR (NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id AND NEW.uploaded_by_user_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'slips: the stored original of slip id=% is immutable', OLD.id;
  END IF;

  IF NEW.retain_until < OLD.retain_until THEN
    RAISE EXCEPTION 'slips: retain_until of slip id=% can only move later (% -> %)',
      OLD.id, OLD.retain_until, NEW.retain_until;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slips_guard_update ON slips;
CREATE TRIGGER slips_guard_update
  BEFORE UPDATE ON slips
  FOR EACH ROW EXECUTE FUNCTION slips_guard_update();

-- ── Guard 3: no physical delete inside the retention period ────────────────
CREATE OR REPLACE FUNCTION slips_guard_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retain_until > CURRENT_DATE THEN
    RAISE EXCEPTION 'slips: slip id=% is under retention until % and cannot be deleted (hide it instead)',
      OLD.id, OLD.retain_until;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS slips_guard_delete ON slips;
CREATE TRIGGER slips_guard_delete
  BEFORE DELETE ON slips
  FOR EACH ROW EXECUTE FUNCTION slips_guard_delete();
