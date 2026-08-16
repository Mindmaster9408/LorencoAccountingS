-- ============================================================
-- Migration 142: Fix customer_invoice_lines.account_id FK — was
-- pointing at the dead legacy chart_of_accounts table
-- ============================================================
--
-- Root cause found 2026-08-16 via a live diagnostic (pos-bridge.js's
-- "Generate Till Invoice" kept failing "insert or update on table
-- customer_invoice_lines violates foreign key constraint
-- customer_invoice_lines_account_id_fkey" no matter what — three
-- separate fix attempts around connection/transaction/RLS consistency
-- all failed, because none of those were ever the actual problem).
--
-- Confirmed via information_schema that
-- customer_invoice_lines_account_id_fkey actually references
-- chart_of_accounts(id), NOT accounts(id). chart_of_accounts is a
-- legacy table from an older schema iteration (database/schema.sql) —
-- it is NOT used by any live code path (only a stale requiredTables
-- array in backend/config/modules.js and a .bak file reference it).
-- Every real accounting feature — journals, bank reconciliation, VAT,
-- trial balance, general ledger, chart-of-accounts management UI, and
-- customer-invoices.js's own account lookups — reads/writes the
-- `accounts` table (backend/config/accounting-schema.js). The FK on
-- customer_invoice_lines was simply never updated when the schema was
-- redesigned around `accounts`, leaving it silently pointing at a
-- table nothing else touches.
--
-- This means the real "Create Invoice" screen (customer-invoices.js)
-- carries the exact same landmine — any manually-created invoice line
-- with an account_id sourced from `accounts` (which is 100% of them,
-- since that's the only account list the UI/API ever offers) would
-- hit this identical FK violation the moment someone tried to save a
-- real invoice. This was never caught because invoice creation had
-- not yet been live-tested end-to-end (see
-- project_customer_invoices_postgrest_cache_bug memory).
--
-- NOT VALID: adds the corrected constraint without requiring every
-- existing row to already satisfy it — safe regardless of what (if
-- any) rows already exist in this new-ish table. New inserts are
-- fully checked from this point forward.
-- ============================================================

ALTER TABLE customer_invoice_lines
  DROP CONSTRAINT IF EXISTS customer_invoice_lines_account_id_fkey;

ALTER TABLE customer_invoice_lines
  ADD CONSTRAINT customer_invoice_lines_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id)
  NOT VALID;

SELECT pg_notify('pgrst', 'reload schema');
