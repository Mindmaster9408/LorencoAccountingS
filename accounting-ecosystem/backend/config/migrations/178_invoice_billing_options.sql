-- ============================================================================
-- 178_invoice_billing_options.sql
-- ============================================================================
-- Ledger Leo — "annual or monthly" billing option on quotes and invoices,
-- plus monthly recurring invoice plans.
--
-- How it works (see services/recurringInvoiceService.js for the engine):
--   1. A quote or draft invoice can switch on `billing_option_enabled`.
--      Off by default — nobody who does not use it sees any change.
--      The PDF then shows the client both options:
--        Annual  = the invoice total, once-off
--        Monthly = invoice total / 12, for 12 months
--   2. On the draft invoice the user records the client's choice
--      (`billing_choice`):
--        'annual'  → the invoice is posted normally for the full amount.
--        'monthly' → a row in customer_invoice_recurring_plans is created
--                    from the invoice's (annual) lines, and the draft itself
--                    becomes instalment 1 (each line / 12). Instalments 2–12
--                    are created on the same day of each following month.
--   3. Every instalment is created, posted to the GL and emailed
--      automatically (Ruan, 2026-11-11: "outomaties en dit word outomaties
--      gestuur"). The annual invoice is never posted as well, so revenue is
--      never doubled.
--
-- Idempotency: the partial unique index on (recurring_plan_id,
-- recurring_instalment_no) makes it impossible for the engine to create the
-- same month twice, even if two server instances run it at the same time.
-- ============================================================================

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS billing_option_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_choice          TEXT,
  ADD COLUMN IF NOT EXISTS recurring_plan_id       BIGINT,
  ADD COLUMN IF NOT EXISTS recurring_instalment_no INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_invoices_billing_choice_chk') THEN
    ALTER TABLE customer_invoices
      ADD CONSTRAINT customer_invoices_billing_choice_chk
      CHECK (billing_choice IS NULL OR billing_choice IN ('annual', 'monthly'));
  END IF;
END $$;

ALTER TABLE customer_quotes
  ADD COLUMN IF NOT EXISTS billing_option_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS customer_invoice_recurring_plans (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id),
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  source_invoice_id   INTEGER NOT NULL REFERENCES customer_invoices(id),
  frequency           TEXT    NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly')),
  instalments_total   INTEGER NOT NULL DEFAULT 12 CHECK (instalments_total BETWEEN 1 AND 120),
  start_date          DATE    NOT NULL,           -- date of instalment 1
  due_days            INTEGER NOT NULL DEFAULT 30, -- invoice date → due date offset
  vat_mode            TEXT    NOT NULL DEFAULT 'exclusive' CHECK (vat_mode IN ('exclusive', 'inclusive')),
  -- The ANNUAL lines exactly as they were on the invoice when "monthly" was
  -- chosen: [{description, account_id, line_type, item_id, quantity,
  -- unit_price, vat_rate}]. Each instalment is derived from this, never from
  -- a previous instalment, so rounding can never drift.
  annual_lines        JSONB   NOT NULL,
  annual_subtotal     NUMERIC(14,2) NOT NULL,
  annual_vat          NUMERIC(14,2) NOT NULL,
  annual_total        NUMERIC(14,2) NOT NULL,
  notes               TEXT,
  auto_post           BOOLEAN NOT NULL DEFAULT true,
  auto_email          BOOLEAN NOT NULL DEFAULT true,
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  last_run_at         TIMESTAMPTZ,
  last_error          TEXT,
  created_by          INTEGER REFERENCES users(id),
  cancelled_by        INTEGER REFERENCES users(id),
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cirp_company ON customer_invoice_recurring_plans(company_id);
CREATE INDEX IF NOT EXISTS idx_cirp_active  ON customer_invoice_recurring_plans(status) WHERE status = 'active';
-- One plan per source invoice — choosing "monthly" twice cannot create two plans.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cirp_source_invoice ON customer_invoice_recurring_plans(source_invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_invoices_recurring_plan_fk') THEN
    ALTER TABLE customer_invoices
      ADD CONSTRAINT customer_invoices_recurring_plan_fk
      FOREIGN KEY (recurring_plan_id) REFERENCES customer_invoice_recurring_plans(id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cust_inv_plan_instalment
  ON customer_invoices(recurring_plan_id, recurring_instalment_no)
  WHERE recurring_plan_id IS NOT NULL;

ALTER TABLE customer_invoice_recurring_plans ENABLE ROW LEVEL SECURITY;
