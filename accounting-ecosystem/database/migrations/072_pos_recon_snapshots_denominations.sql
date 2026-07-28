-- Migration 072: Note/coin denomination breakdown on pos_recon_snapshots
--
-- The self-service Cash Up tab already lets a cashier count notes/coins
-- individually (note200, note100, ..., coin010 inputs feeding
-- calculateCashTotal()), but only the resulting TOTAL was ever sent to the
-- backend — the per-denomination counts themselves were never persisted.
-- Requested 2026-07-28 so the printed/reprinted cash-up slip can show the
-- same note/coin breakdown the cashier actually counted, not just a total.
--
-- Purely additive, nullable — null for any cash-up completed before this
-- (nothing to backfill) or completed via the manager's remote pending-
-- cashup flow (which only ever has a single aggregate counted-cash figure,
-- not a physical note/coin count).
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk

BEGIN;

ALTER TABLE pos_recon_snapshots
  ADD COLUMN IF NOT EXISTS denominations JSONB;

COMMENT ON COLUMN pos_recon_snapshots.denominations IS
  'Note/coin counts as entered on the Cash Up tab at completion time, e.g. '
  '{"note200":2,"note100":5,...,"coin010":10}. Null when completed via the '
  'manager remote pending-cashup flow (aggregate count only) or before this '
  'column existed.';

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pos_recon_snapshots' AND column_name = 'denominations';
