-- ============================================================================
-- 160_customer_invoice_email_tracking.sql
-- ============================================================================
-- Adds real "emailed to customer" tracking to customer_invoices, kept
-- deliberately separate from the existing `status` column — `status`
-- transitions to 'sent' as a side effect of GL-posting (POST /:id/post,
-- customer-invoices.js), which is a bookkeeping fact unrelated to whether
-- an email was ever actually dispatched. Conflating the two would silently
-- change the meaning of an already-relied-on field (CLAUDE.md Rule A2).
--
-- Also creates customer_statement_sends — a lightweight send-audit log for
-- the new customer-statement email feature, which isn't tied to a single
-- invoice's lifecycle the way invoice-emailing is.
-- ============================================================================

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS emailed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emailed_to   TEXT,
  ADD COLUMN IF NOT EXISTS email_count  INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS customer_statement_sends (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  sent_to        TEXT NOT NULL,
  sent_by        INTEGER REFERENCES users(id),
  closing_balance NUMERIC(14,2),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_statement_sends_company  ON customer_statement_sends(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_statement_sends_customer ON customer_statement_sends(customer_id);

ALTER TABLE customer_statement_sends ENABLE ROW LEVEL SECURITY;
