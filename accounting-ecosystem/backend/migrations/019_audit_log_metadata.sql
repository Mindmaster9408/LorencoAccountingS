-- ============================================================================
-- Migration 019 — Add metadata column to audit_log
-- ============================================================================
-- Run in Supabase SQL Editor.
-- All statements are idempotent (safe to run more than once).
--
-- Root cause:
--   middleware/audit.js inserts a 'metadata' JSONB field on every audit event,
--   but the audit_log table was originally created without this column.
--   Result: every audit INSERT fails with:
--     "Could not find the 'metadata' column of 'audit_log' in the schema cache"
--   — meaning NO audit events are being persisted. This migration fixes that.
--
-- Tables affected:
--   audit_log — shared ecosystem audit table (payroll, auth, employees, etc.)
-- ============================================================================

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

COMMENT ON COLUMN audit_log.metadata IS
  'Free-form JSON context for the audit event.
   Examples: { "companiesAvailable": 3 }, { "fieldCount": 5 }.
   Populated by middleware/audit.js logAudit(). Never used for compliance queries
   — only for debugging and optional enrichment.';
