-- Migration 071: Cash Paid Out (mid-shift cash removed from the till drawer)
--
-- Problem: there was no way to record cash taken out of the drawer during
-- a shift (e.g. paying a delivery driver, buying something small for the
-- shop). Any such legitimate event was indistinguishable from a real
-- counting error — it just showed up as an unexplained cash-up variance.
-- Found while forensically investigating a real R286.80 shortfall
-- (Pennygrow, session #27, 2026-07-28) where every sale/payment record
-- was confirmed internally consistent — the gap had to be something the
-- system had no way to record at all.
--
-- Design: append-only, same pattern as pos_recon_snapshots (029) — a cash
-- paid-out is a financial record; once logged it's never edited or
-- deleted. No FK constraints, matching the established convention for
-- these audit-adjacent tables (survives session/till deletion).
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk

BEGIN;

CREATE TABLE IF NOT EXISTS pos_cash_paidouts (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  company_id         INTEGER NOT NULL,
  till_session_id    INTEGER NOT NULL,
  till_id            INTEGER,

  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason             TEXT NOT NULL,
  notes              TEXT,

  created_by_user_id INTEGER,
  created_by_email   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pos_cash_paidouts_session
  ON pos_cash_paidouts (till_session_id);

CREATE INDEX IF NOT EXISTS idx_pos_cash_paidouts_company_time
  ON pos_cash_paidouts (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_cash_paidout_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'pos_cash_paidouts is append-only. Cash paid-out records cannot be '
        'modified or deleted. Action: % on row id=%', TG_OP, OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS pos_cash_paidouts_no_update ON pos_cash_paidouts;
CREATE TRIGGER pos_cash_paidouts_no_update
    BEFORE UPDATE ON pos_cash_paidouts
    FOR EACH ROW EXECUTE FUNCTION prevent_cash_paidout_modification();

DROP TRIGGER IF EXISTS pos_cash_paidouts_no_delete ON pos_cash_paidouts;
CREATE TRIGGER pos_cash_paidouts_no_delete
    BEFORE DELETE ON pos_cash_paidouts
    FOR EACH ROW EXECUTE FUNCTION prevent_cash_paidout_modification();

COMMENT ON TABLE pos_cash_paidouts IS
    'Append-only record of cash removed from a till drawer mid-shift for a '
    'legitimate reason (e.g. paying a delivery driver). Factored into '
    'expected_cash_in_drawer by posReconService.computeSessionRecon().';

-- Historical snapshots must retain the figure actually subtracted at
-- cash-up time, not a value re-derived later from pos_cash_paidouts
-- (which is why this isn't just computed on read for the snapshot).
ALTER TABLE pos_recon_snapshots
  ADD COLUMN IF NOT EXISTS paid_out_total NUMERIC(12,2) DEFAULT 0;

COMMENT ON COLUMN pos_recon_snapshots.paid_out_total IS
  'Sum of pos_cash_paidouts for this session at snapshot time. Already '
  'subtracted into expected_cash_in_drawer above — stored separately here '
  'too so the cash-up slip can show it as its own line.';

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE (table_name = 'pos_cash_paidouts')
   OR (table_name = 'pos_recon_snapshots' AND column_name = 'paid_out_total')
ORDER BY table_name, column_name;
