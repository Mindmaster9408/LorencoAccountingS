-- =============================================================================
-- Migration 143: Restore journal_lines foreign keys (journal_id, account_id)
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: 012_accounting_schema.sql:98,101 dropped both foreign keys on
-- journal_lines (journal_id -> journals, account_id -> accounts) while
-- fixing an unrelated chart_of_accounts/accounts table-name confusion, and
-- neither was ever re-added in any later migration. Since then, 100% of
-- journal_lines' referential integrity has relied on application code alone
-- — no database-level guarantee that a line's journal_id/account_id points
-- at a real row, let alone the right company's row. Combined with a gap in
-- JournalService._assertAccountsPostable (fixed alongside this migration —
-- see journalService.js), an invalid or another-company's account_id could
-- previously pass silently.
--
-- NOT VALID: adds the corrected constraints without requiring every
-- existing row to already satisfy them — safe regardless of what (if any)
-- orphaned/foreign rows already exist. Every new insert is fully checked
-- from this point forward. Once confirmed clean, each constraint can be
-- separately VALIDATEd (a non-blocking, non-locking operation) — see the
-- verification query below.
-- =============================================================================

BEGIN;

ALTER TABLE journal_lines
  DROP CONSTRAINT IF EXISTS journal_lines_journal_id_fkey;

ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_journal_id_fkey
  FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE CASCADE
  NOT VALID;

ALTER TABLE journal_lines
  DROP CONSTRAINT IF EXISTS journal_lines_account_id_fkey;

ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id)
  NOT VALID;

COMMIT;

SELECT pg_notify('pgrst', 'reload schema');

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Confirm both constraints exist:
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'journal_lines'::regclass
  AND conname IN ('journal_lines_journal_id_fkey', 'journal_lines_account_id_fkey');

-- Find any existing rows that would fail validation (run before VALIDATE CONSTRAINT):
SELECT jl.id, jl.journal_id, jl.account_id
FROM journal_lines jl
LEFT JOIN journals j ON j.id = jl.journal_id
LEFT JOIN accounts a ON a.id = jl.account_id
WHERE j.id IS NULL OR a.id IS NULL;

-- Once the above returns zero rows, tighten enforcement to cover historical
-- data too (safe, does not lock the table for writes):
-- ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_journal_id_fkey;
-- ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_account_id_fkey;
