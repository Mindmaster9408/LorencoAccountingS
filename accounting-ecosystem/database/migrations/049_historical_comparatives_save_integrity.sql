-- ============================================================================
-- Migration 049 — Historical Comparatives: Save Integrity Hardening
-- ============================================================================
-- Adds the missing unique index for null-account-id rows so that concurrent
-- saves cannot produce duplicate rows for the same (batch, account_name,
-- account_code, year, month) combination.
--
-- Migration 042 already added:
--   uq_hcl_batch_account_period on (batch_id, account_id, financial_year, period_month)
--   WHERE account_id IS NOT NULL
-- That index covers the common case (COA-synced accounts with a real account_id).
-- This migration covers the freetext / null-account-id path.
--
-- Also fixes the historical_comparative_audit_log action constraint which was
-- missing 'GRID_SAVED' and 'BATCH_RESCALED' — both emitted by the service.
-- Without this fix, every bulk grid-save audit record silently fails to insert.
--
-- SAFE DUPLICATE DETECTION:
--   This migration detects existing duplicate null-account rows BEFORE attempting
--   to create the unique index. If duplicates are found, the migration raises a
--   clear error with instructions to resolve them manually.
--
-- Safe to re-run: all CREATE INDEX statements use IF NOT EXISTS.
--   The audit-log constraint drop/add is idempotent on repeated runs.
-- ============================================================================

-- ── Step 1: Detect duplicate null-account-id rows ───────────────────────────
-- If any (batch_id, account_code, account_name, financial_year, period_month)
-- combination appears more than once with account_id IS NULL, the unique index
-- below cannot be created cleanly.
--
-- To identify duplicates before running, execute:
--   SELECT batch_id, COALESCE(account_code,'') AS account_code, account_name,
--          financial_year, period_month, COUNT(*) AS n
--   FROM historical_comparative_lines
--   WHERE account_id IS NULL
--   GROUP BY 1,2,3,4,5
--   HAVING COUNT(*) > 1;
--
-- To remove duplicates, keep the most-recently-updated row per combination:
--   DELETE FROM historical_comparative_lines
--   WHERE id IN (
--     SELECT id FROM (
--       SELECT id,
--         ROW_NUMBER() OVER (
--           PARTITION BY batch_id, COALESCE(account_code,''), account_name,
--                        financial_year, period_month
--           ORDER BY updated_at DESC NULLS LAST, id DESC
--         ) AS rn
--       FROM historical_comparative_lines WHERE account_id IS NULL
--     ) sub WHERE rn > 1
--   );

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT batch_id, COALESCE(account_code, '') AS ac, account_name,
           financial_year, period_month
    FROM historical_comparative_lines
    WHERE account_id IS NULL
    GROUP BY batch_id, COALESCE(account_code, ''), account_name, financial_year, period_month
    HAVING COUNT(*) > 1
  ) dup_sets;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 049 blocked: % duplicate null-account-id row set(s) found in historical_comparative_lines. Run the duplicate-detection query in the migration header comment to identify them, then manually remove duplicate rows before re-running this migration.',
      dup_count;
  END IF;
END $$;

-- ── Step 2: Unique index for null-account-id rows ────────────────────────────
-- Uses COALESCE(account_code, '') so that rows with account_code = NULL and
-- account_code = '' are treated as the same key (both represent "no code").
-- Only covers rows where account_id IS NULL (partial index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_hcl_batch_account_snapshot_year_month
  ON historical_comparative_lines (
    batch_id,
    COALESCE(account_code, ''),
    account_name,
    financial_year,
    period_month
  )
  WHERE account_id IS NULL;

-- ── Step 3: Fix audit log action constraint ──────────────────────────────────
-- The original constraint in migration 042 was missing 'GRID_SAVED' and
-- 'BATCH_RESCALED', causing every grid-save and rescale audit write to silently
-- fail (the service catches all audit log errors). This adds the missing values.
ALTER TABLE historical_comparative_audit_log
  DROP CONSTRAINT IF EXISTS hcal_action_chk;

ALTER TABLE historical_comparative_audit_log
  ADD CONSTRAINT hcal_action_chk
  CHECK (action IN (
    'BATCH_CREATED',
    'BATCH_UPDATED',
    'BATCH_RESCALED',
    'LINE_CREATED',
    'LINE_UPDATED',
    'LINE_DELETED',
    'BATCH_VALIDATED',
    'BATCH_FINALIZED',
    'BATCH_ARCHIVED',
    'FINALIZED_EDIT_BLOCKED',
    'GRID_SAVED'
  ));
