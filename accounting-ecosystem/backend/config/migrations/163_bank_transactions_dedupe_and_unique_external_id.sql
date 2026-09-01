-- =============================================================================
-- Migration 163: De-duplicate bank_transactions + unique (bank_account_id,
--                 external_id) index to make the class of bug structurally
--                 impossible going forward
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem found: a user reported Leo's bank transactions "Balance" column not
-- reconciling for Dronedog Studio (company_id 41, bank_account_id 9). Root
-- cause was NOT a display-order bug — it was 15 real transactions each
-- inserted TWICE into bank_transactions (30 rows total), confirmed live by
-- identical created_at timestamps within each half:
--   first copies  (ids 2566-2580) created_at 2026-05-13T08:23:26.107Z
--   second copies (ids 2581-2595) created_at 2026-05-13T08:23:30.988Z
-- — i.e. two separate bulk-insert calls ~4.9 seconds apart, same 15 rows both
-- times. Traced to bankStagingService.js's confirmStaged(): it read staging
-- rows, bulk-inserted into bank_transactions, and only AFTERWARDS marked the
-- staging rows CONFIRMED — a classic check-then-act race. The frontend
-- trigger ("Confirm All Visible" in bank-staging.html) did not disable its
-- button while the request was in flight (every other action button in that
-- file does), making a double-click (or a slow-response retry) the likely
-- trigger. Both the frontend button-disable and the backend race have been
-- fixed in code (bank-staging.html confirmAllVisible(), bankStagingService.js
-- confirmStaged() — now claims rows via a conditional UPDATE before
-- inserting). This migration is the third, DB-level layer: even if a future
-- code path reintroduces a similar race, the unique index below makes a
-- duplicate external_id per bank account impossible to insert at all.
--
-- Verified safe before writing this migration: all 30 rows across the 15
-- duplicate pairs were `status = 'unmatched'` — none allocated to any journal
-- entry — so deleting the second-inserted copy of each pair changes no GL
-- figures whatsoever.
--
-- Step 1 deletes only the LATER-created copy of each exact duplicate
-- (same bank_account_id + external_id), and only when neither the specific
-- row being removed nor the one being kept has ever been allocated/matched —
-- an extra safety condition beyond the one-time manual check above, so this
-- migration is safe to re-run or reuse as a template for a future account.
-- Step 2 adds the unique index. Both steps are idempotent.
-- =============================================================================

-- ── Step 1: remove exact duplicate rows (keep the earliest-created copy) ────
DELETE FROM bank_transactions t
USING (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY bank_account_id, external_id
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM bank_transactions
    WHERE external_id IS NOT NULL
  ) ranked
  WHERE rn > 1
) dupes
WHERE t.id = dupes.id
  AND t.status = 'unmatched'
  AND t.matched_entity_id IS NULL
  AND t.reconciled_at IS NULL;

-- ── Step 2: prevent this from ever being possible again ──────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_unique_account_external_id
  ON bank_transactions (bank_account_id, external_id)
  WHERE external_id IS NOT NULL;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- Should return 0 rows (no duplicate external_id left per bank account):
SELECT bank_account_id, external_id, COUNT(*)
FROM bank_transactions
WHERE external_id IS NOT NULL
GROUP BY bank_account_id, external_id
HAVING COUNT(*) > 1;

-- Should show the new index:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'bank_transactions'
  AND indexname = 'bank_transactions_unique_account_external_id';
