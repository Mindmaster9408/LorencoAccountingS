-- Migration 070: Per-method counted amounts + variances on pos_recon_snapshots
--
-- Problem: the 2026-07-24 Cash Up enhancement added counted_eft/counted_account
-- input fields and varianceCard/varianceEft/varianceAccount computation to
-- POST /:id/complete-cashup (backend/modules/pos/routes/sessions.js), and
-- these values ARE passed into createReconSnapshot()'s cashupData argument —
-- but posReconService.js's createReconSnapshot() never actually included them
-- in its INSERT into pos_recon_snapshots, because the table never had columns
-- for them (029_pos_recon_snapshots.sql only has counted_cash/counted_card/
-- counted_other). The data was computed, shown to the cashier, and audit-
-- logged, but silently never reached the one place meant to be the permanent,
-- immutable historical record — meaning no reprint or historical report could
-- ever recover a session's EFT/Account counted amounts or their variances.
--
-- Purely additive — existing rows get NULL for the new columns (matching
-- what they've always effectively had: no data ever captured for these
-- fields), no historical data changes meaning.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk

BEGIN;

ALTER TABLE pos_recon_snapshots
  ADD COLUMN IF NOT EXISTS counted_eft      NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS counted_account  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS variance_card    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS variance_eft     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS variance_account NUMERIC(12,2);

COMMENT ON COLUMN pos_recon_snapshots.counted_eft IS
  'What the cashier physically/manually counted for EFT at cashup time (2026-07-24 Cash Up enhancement).';
COMMENT ON COLUMN pos_recon_snapshots.counted_account IS
  'What the cashier counted/confirmed for Account sales at cashup time.';
COMMENT ON COLUMN pos_recon_snapshots.variance_card IS
  'counted_card - payment_card (this session''s own system-recorded card sales). Null if counted_card was never supplied.';
COMMENT ON COLUMN pos_recon_snapshots.variance_eft IS
  'counted_eft - payment_eft. Null if counted_eft was never supplied.';
COMMENT ON COLUMN pos_recon_snapshots.variance_account IS
  'counted_account - payment_account. Null if counted_account was never supplied.';

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'pos_recon_snapshots'
  AND column_name IN ('counted_eft','counted_account','variance_card','variance_eft','variance_account');
