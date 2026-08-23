-- =============================================================================
-- Migration 144: Fix dead journal_entries FK on customer & supplier invoices
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: customer_invoices.journal_id / payment_journal_id and
-- supplier_invoices.journal_id / payment_journal_id all reference the dead
-- legacy journal_entries table (database/schema.sql:768-769, 808-809), not
-- journals — the real table JournalService actually writes to. This is the
-- identical bug class migration 142 already fixed for
-- customer_invoice_lines.account_id (root cause there: journal_entries and
-- chart_of_accounts are both dead legacy tables from an older schema
-- iteration that nothing else in the live code touches). Left unfixed, any
-- attempt to "Post to GL" on a customer or supplier invoice fails the
-- moment it tries to write journal_id back to the invoice row.
--
-- Both customer_invoices and supplier_invoices share the exact same
-- definition, so both are fixed here in one migration rather than leaving
-- suppliers exposed to the same landmine.
--
-- NOT VALID: adds the corrected constraints without requiring every
-- existing row to already satisfy them — safe regardless of current data.
-- =============================================================================

BEGIN;

ALTER TABLE customer_invoices
  DROP CONSTRAINT IF EXISTS customer_invoices_journal_id_fkey;
ALTER TABLE customer_invoices
  ADD CONSTRAINT customer_invoices_journal_id_fkey
  FOREIGN KEY (journal_id) REFERENCES journals(id)
  NOT VALID;

ALTER TABLE customer_invoices
  DROP CONSTRAINT IF EXISTS customer_invoices_payment_journal_id_fkey;
ALTER TABLE customer_invoices
  ADD CONSTRAINT customer_invoices_payment_journal_id_fkey
  FOREIGN KEY (payment_journal_id) REFERENCES journals(id)
  NOT VALID;

ALTER TABLE supplier_invoices
  DROP CONSTRAINT IF EXISTS supplier_invoices_journal_id_fkey;
ALTER TABLE supplier_invoices
  ADD CONSTRAINT supplier_invoices_journal_id_fkey
  FOREIGN KEY (journal_id) REFERENCES journals(id)
  NOT VALID;

ALTER TABLE supplier_invoices
  DROP CONSTRAINT IF EXISTS supplier_invoices_payment_journal_id_fkey;
ALTER TABLE supplier_invoices
  ADD CONSTRAINT supplier_invoices_payment_journal_id_fkey
  FOREIGN KEY (payment_journal_id) REFERENCES journals(id)
  NOT VALID;

COMMIT;

SELECT pg_notify('pgrst', 'reload schema');

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT conrelid::regclass AS table_name, conname, confrelid::regclass AS references_table
FROM pg_constraint
WHERE conname IN (
  'customer_invoices_journal_id_fkey', 'customer_invoices_payment_journal_id_fkey',
  'supplier_invoices_journal_id_fkey', 'supplier_invoices_payment_journal_id_fkey'
);
