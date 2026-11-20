-- 188 — customer_invoices.status: allow the values the code actually writes (2026-11-20)
--
-- Root cause: the CHECK constraint only allows draft/sent/paid/partial/overdue/cancelled, but
--   - Void      (routes/customer-invoices.js POST /:id/void) writes 'void'
--   - Payments  (POST /payments, part payment)               writes 'part_paid'
-- so voiding failed AFTER the journal had already been reversed (invoice stayed 'sent' while
-- the GL was reversed), and every part payment on a customer invoice was refused.
-- Found by the MCP invoice-tools E2E in company 51. Only company 51 test rows were affected.
--
-- Additive only: every existing value stays allowed.

ALTER TABLE customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_status_check;
ALTER TABLE customer_invoices ADD CONSTRAINT customer_invoices_status_check
  CHECK (status::text = ANY (ARRAY['draft', 'sent', 'paid', 'part_paid', 'partial', 'overdue', 'void', 'cancelled']::text[]));

-- Repair the half-voided test invoices (journal reversed, status still 'sent') — company 51 only.
UPDATE customer_invoices ci
   SET status = 'void', updated_at = NOW()
  FROM journals j
 WHERE j.id = ci.journal_id
   AND j.status = 'reversed'
   AND ci.status = 'sent'
   AND ci.company_id = 51;
