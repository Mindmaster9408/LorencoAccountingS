-- ============================================================================
-- Migration 044 — COA Sub-Account Support
-- ============================================================================
-- Adds is_postable, account_level, display_order, and created_from_parent
-- to the accounts table.
--
-- AUDIT FINDINGS (pre-migration):
--   parent_id INTEGER REFERENCES accounts(id)  — ALREADY EXISTS (migration 012)
--   is_postable                                 — DOES NOT EXIST → added here
--   account_level                               — DOES NOT EXIST → added here
--   display_order                               — DOES NOT EXIST → added here
--   created_from_parent                         — DOES NOT EXIST → added here
--
-- Safe to re-run: all ADD COLUMN use IF NOT EXISTS.
-- ============================================================================

-- ── New columns ──────────────────────────────────────────────────────────────

-- Whether this account accepts direct postings.
-- false = parent/header account — no journals, bank allocations, or historical
--         capture lines may post directly to it.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_postable BOOLEAN NOT NULL DEFAULT true;

-- Depth level in the hierarchy. 0 = root account, 1 = direct child, etc.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_level INTEGER NOT NULL DEFAULT 0;

-- Optional explicit ordering within a parent group.
-- Falls back to sort_order / code ordering if null.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS display_order NUMERIC;

-- Marks accounts created via the sub-account creation flow (not direct create).
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS created_from_parent BOOLEAN NOT NULL DEFAULT false;

-- ── Backfill existing data ────────────────────────────────────────────────────

-- Any account that already has a parent_id is a child → level 1.
UPDATE accounts
  SET account_level = 1
WHERE parent_id IS NOT NULL
  AND account_level = 0;

-- Any account that is already referenced as a parent_id → non-postable.
-- (Bank auto-subaccounts already set parent_id on children; their parents
--  become non-postable now that is_postable is enforced.)
UPDATE accounts
  SET is_postable = false
WHERE id IN (
  SELECT DISTINCT parent_id FROM accounts WHERE parent_id IS NOT NULL
)
  AND is_postable = true;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_accounts_parent
  ON accounts (company_id, parent_id);

CREATE INDEX IF NOT EXISTS idx_accounts_postable
  ON accounts (company_id, is_postable);

CREATE INDEX IF NOT EXISTS idx_accounts_level
  ON accounts (company_id, account_level);
