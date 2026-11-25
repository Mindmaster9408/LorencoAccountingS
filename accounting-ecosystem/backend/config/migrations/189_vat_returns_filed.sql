-- =============================================================================
-- Migration 189: Filed SARS VAT returns + VAT payments; fix skewed VAT periods
-- =============================================================================
-- Run in Supabase SQL Editor (or scripts/run-sql.js file …). Idempotent.
--
-- Why: Ledger Leo had no record of what was ACTUALLY filed on eFiling or paid
-- to SARS (vat_submissions held only three Leo-calculated numbers and was never
-- used — 0 rows). Without the filed figures there is no way to see, later,
-- where the books and the filed return differ and correct it.
--
--   vat_returns   one row per VAT period per version (1 = original filing,
--                 2+ = revised return / request for correction). Every VAT201
--                 field is its own column. A revision never overwrites: the
--                 previous version is marked 'superseded'. ledger_snapshot
--                 freezes what Leo calculated when the return was captured.
--   vat_payments  any number of payments per period (VAT, penalty, interest,
--                 refund received), optionally linked to the Leo bank line.
--
-- Step 1 also fixes VAT periods created by vat.html's parsePeriodKey(), which
-- built dates at local midnight and converted with toISOString() — in South
-- Africa (UTC+2) every date landed one day early (e.g. "2026-11" stored as
-- 2026-10-31 → 2026-11-29). Only rows shifted back by exactly one day on BOTH
-- dates are corrected, and never a locked period. Verified 2026-11-25: 17 rows
-- (companies 1, 2, 7, 40, 41, 51), all exactly -1 day, none locked.
-- =============================================================================

-- ── Step 1: fix periods that are exactly one day early ───────────────────────
UPDATE vat_periods
   SET from_date  = from_date + 1,
       to_date    = to_date + 1,
       updated_at = now()
 WHERE EXTRACT(DAY FROM from_date) <> 1
   AND EXTRACT(DAY FROM from_date + 1) = 1            -- start is the last day of a month
   AND EXTRACT(DAY FROM to_date + 2) = 1              -- end is the second-last day of a month
   AND UPPER(COALESCE(status, '')) <> 'LOCKED';

-- ── Step 2: filed returns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_returns (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vat_period_id           INTEGER NOT NULL REFERENCES vat_periods(id) ON DELETE RESTRICT,
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status                  VARCHAR(20) NOT NULL DEFAULT 'filed' CHECK (status IN ('filed', 'superseded')),
  filed_date              DATE NOT NULL,
  sars_reference          VARCHAR(100),
  notes                   TEXT,

  -- VAT201 — output (consideration = amount incl. VAT unless stated)
  field_1    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Standard rate (excl capital goods & accommodation) — consideration
  field_1a   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Standard rate (only capital goods/services) — consideration
  field_2    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Zero rate (excl exported goods)
  field_2a   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Zero rate (only exported goods)
  field_3    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Exempt and non-supplies
  field_4    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- VAT on field 1
  field_4a   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- VAT on field 1A
  field_5    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Accommodation exceeding 28 days
  field_6    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Field 5 × 60%
  field_7    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Accommodation not exceeding 28 days
  field_8    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Total accommodation (6 + 7)
  field_9    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- VAT on accommodation
  field_10   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Change in use & export of second-hand goods — consideration
  field_11   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- VAT on field 10
  field_12   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Other and imported services (VAT)
  field_13   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- TOTAL A = 4 + 4A + 9 + 11 + 12
  -- VAT201 — input (VAT amounts)
  field_14   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Capital goods/services supplied to you
  field_14a  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Capital goods imported
  field_15   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Other goods/services supplied to you
  field_15a  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Other goods imported
  field_16   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Change in use
  field_17   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Bad debts
  field_18   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Other
  field_19   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- TOTAL B = 14 + 14A + 15 + 15A + 16 + 17 + 18
  field_20   NUMERIC(14,2) NOT NULL DEFAULT 0,   -- VAT payable (+) / refundable (−) = A − B

  ledger_snapshot         JSONB,                 -- Leo's own VAT201 figures at capture time
  captured_by_user_id     INTEGER REFERENCES users(id),
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at           TIMESTAMPTZ,
  superseded_by_return_id INTEGER REFERENCES vat_returns(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vat_period_id, version),
  CHECK (ABS(field_13 - (field_4 + field_4a + field_9 + field_11 + field_12)) < 0.01),
  CHECK (ABS(field_19 - (field_14 + field_14a + field_15 + field_15a + field_16 + field_17 + field_18)) < 0.01),
  CHECK (ABS(field_20 - (field_13 - field_19)) < 0.01)
);

-- Only one current (filed) version per period.
CREATE UNIQUE INDEX IF NOT EXISTS vat_returns_one_filed_per_period
  ON vat_returns (company_id, vat_period_id) WHERE status = 'filed';
CREATE INDEX IF NOT EXISTS vat_returns_company_idx ON vat_returns (company_id, vat_period_id);

-- ── Step 3: payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_payments (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vat_period_id        INTEGER NOT NULL REFERENCES vat_periods(id) ON DELETE RESTRICT,
  payment_date         DATE NOT NULL,
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_type         VARCHAR(20) NOT NULL DEFAULT 'vat'
                         CHECK (payment_type IN ('vat', 'penalty', 'interest', 'refund')),
  reference            VARCHAR(100),
  bank_transaction_id  INTEGER REFERENCES bank_transactions(id) ON DELETE SET NULL,
  notes                TEXT,
  created_by_user_id   INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,              -- soft delete: a mistaken capture stays in the audit trail
  deleted_by_user_id   INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS vat_payments_period_idx ON vat_payments (company_id, vat_period_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE vat_returns  IS 'VAT201 returns as actually filed with SARS — one row per period per version (migration 189)';
COMMENT ON TABLE vat_payments IS 'Payments to / refunds from SARS per VAT period (migration 189)';
COMMENT ON TABLE vat_submissions IS 'DEPRECATED (never used, 0 rows on 2026-11-25) — replaced by vat_returns + vat_payments (migration 189)';

-- ── Verification ─────────────────────────────────────────────────────────────
-- Should return 0 rows (no period left that is exactly one day early):
SELECT company_id, period_key, from_date, to_date
  FROM vat_periods
 WHERE EXTRACT(DAY FROM from_date) <> 1
   AND EXTRACT(DAY FROM from_date + 1) = 1
   AND EXTRACT(DAY FROM to_date + 2) = 1;
