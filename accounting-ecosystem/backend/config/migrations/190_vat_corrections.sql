-- ============================================================================
-- 190 — VAT corrections carried into a later return (Ledger Leo, step 2)
-- ============================================================================
-- When Leo's books for a FILED period differ from what was filed (vat_returns,
-- migration 189), the difference can be corrected in a later, not-yet-filed
-- return instead of a revised return:
--   output VAT difference → VAT201 field 12 of the target period
--   input VAT difference  → VAT201 field 18 of the target period
--
-- Each carry is one row here, so the same difference is never corrected twice:
-- the service only lets you carry what is still uncorrected (difference minus
-- active corrections from that period), under a row lock on the filed return.
--
-- Nothing is posted to the ledger: the entries are already in the books (in
-- the old period). This is a return-level adjustment only. Cancelling is only
-- possible while the target period has no filed return.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vat_corrections (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_period_id      INTEGER NOT NULL REFERENCES vat_periods(id) ON DELETE RESTRICT,
  source_return_id      INTEGER REFERENCES vat_returns(id),
  target_period_id      INTEGER NOT NULL REFERENCES vat_periods(id) ON DELETE RESTRICT,
  output_vat            NUMERIC(14,2) NOT NULL DEFAULT 0,   -- → field 12 of the target (+ = more output VAT)
  input_vat             NUMERIC(14,2) NOT NULL DEFAULT 0,   -- → field 18 of the target (+ = more input VAT)
  reason                TEXT NOT NULL,
  status                VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by_user_id    INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by_user_id  INTEGER REFERENCES users(id),
  cancel_reason         TEXT,
  CONSTRAINT vat_corrections_not_same_period CHECK (source_period_id <> target_period_id),
  CONSTRAINT vat_corrections_not_zero CHECK (output_vat <> 0 OR input_vat <> 0),
  CONSTRAINT vat_corrections_reason_given CHECK (length(trim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_vat_corrections_source ON vat_corrections (company_id, source_period_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vat_corrections_target ON vat_corrections (company_id, target_period_id) WHERE status = 'active';

COMMENT ON TABLE vat_corrections IS
  'Differences of a filed VAT period carried into a later return (field 12 output / field 18 input). One row per carry; active rows count against the source period''s difference so nothing is corrected twice.';
