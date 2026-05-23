-- ============================================================================
-- Migration 043 — Fix historical_comparatives user-reference column types
-- ============================================================================
-- Root cause: migration 042 defined created_by / finalized_by / entered_by /
-- updated_by / performed_by as UUID. The app's users table uses INTEGER
-- primary keys (confirmed by migrations 014, 019, 041). Every other table in
-- this schema uses INTEGER for user-reference columns.
--
-- These tables were freshly created and have no rows (batch creation was
-- blocked by this very type error), so USING null is safe.
--
-- Safe to re-run: all columns exist before the ALTER and will simply be a
-- no-op if already INTEGER.
-- ============================================================================

-- ── historical_comparative_batches ──────────────────────────────────────────

ALTER TABLE historical_comparative_batches
  ALTER COLUMN created_by DROP DEFAULT;

ALTER TABLE historical_comparative_batches
  ALTER COLUMN created_by TYPE INTEGER USING NULL;

ALTER TABLE historical_comparative_batches
  ALTER COLUMN finalized_by DROP DEFAULT;

ALTER TABLE historical_comparative_batches
  ALTER COLUMN finalized_by TYPE INTEGER USING NULL;

-- ── historical_comparative_lines ────────────────────────────────────────────

ALTER TABLE historical_comparative_lines
  ALTER COLUMN entered_by DROP DEFAULT;

ALTER TABLE historical_comparative_lines
  ALTER COLUMN entered_by TYPE INTEGER USING NULL;

ALTER TABLE historical_comparative_lines
  ALTER COLUMN updated_by DROP DEFAULT;

ALTER TABLE historical_comparative_lines
  ALTER COLUMN updated_by TYPE INTEGER USING NULL;

-- ── historical_comparative_audit_log ────────────────────────────────────────

ALTER TABLE historical_comparative_audit_log
  ALTER COLUMN performed_by DROP DEFAULT;

ALTER TABLE historical_comparative_audit_log
  ALTER COLUMN performed_by TYPE INTEGER USING NULL;
