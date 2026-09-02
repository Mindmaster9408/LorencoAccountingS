-- =============================================================================
-- Migration 164: Fix bank_transactions.allocated_account_id foreign key
--                 pointing at the wrong table (system-wide bug)
-- =============================================================================
-- Found live (2026-09-02, WJM Beleggings, but affects EVERY company): every
-- single bank-transaction allocation attempt was silently failing and
-- auto-reversing. Confirmed live: POST /transactions/:id/allocate
-- (bank.js) correctly creates and posts the GL journal, then updates
-- bank_transactions with { status: 'matched', allocated_account_id, ... } --
-- and that UPDATE has been failing on every single call, always with:
--
--   error 23503: insert or update on table "bank_transactions" violates
--   foreign key constraint "bank_transactions_allocated_account_id_fkey"
--   Key (allocated_account_id)=(<real, valid account id>) is not present
--   in table "chart_of_accounts".
--
-- chart_of_accounts is a different, EMPTY, unused table -- every account
-- everywhere in this codebase (see accounts.js routes, journals, etc.)
-- lives in the `accounts` table instead. The FK was pointed at the wrong
-- table when originally created and this has apparently never worked, for
-- any company, since day one -- code-level, bank.js's own
-- linkage-update-failure auto-reversal safety net (added independently,
-- unrelated to this bug) was silently absorbing every failure and leaving
-- transactions permanently unmatched with no visible error to the user
-- beyond "why did this revert to unallocated".
--
-- No bank_transactions row anywhere has ever successfully carried a real
-- allocated_account_id (every one is NULL, confirmed via direct query), so
-- there is no data to migrate/reconcile -- this is purely a constraint fix.
-- =============================================================================

-- Wrapped in a DO block so this migration is safe to re-run — the CI
-- pipeline (.github/workflows/apply-migrations.yml) re-executes every file
-- in this folder on every push, forever, with no tracking of what already
-- ran. Plain `ADD CONSTRAINT` has no `IF NOT EXISTS` form in Postgres, so
-- without this guard the second-ever run would error "constraint already
-- exists" and (via the workflow's `set -e`) permanently halt every
-- migration numbered above this one on every future push.
DO $$
BEGIN
  ALTER TABLE bank_transactions
    DROP CONSTRAINT IF EXISTS bank_transactions_allocated_account_id_fkey;

  ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_allocated_account_id_fkey
    FOREIGN KEY (allocated_account_id) REFERENCES accounts(id);
EXCEPTION
  WHEN duplicate_object THEN
    NULL; -- constraint already correct from a previous run — nothing to do
END $$;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Should show the constraint now pointing at accounts, not chart_of_accounts:
SELECT
  tc.constraint_name,
  ccu.table_name AS references_table
FROM information_schema.table_constraints tc
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.table_name = 'bank_transactions'
  AND tc.constraint_type = 'FOREIGN KEY'
  AND tc.constraint_name = 'bank_transactions_allocated_account_id_fkey';
