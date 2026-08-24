-- =============================================================================
-- Migration 148: Repoint supplier_invoice_lines.account_id FK to accounts
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: found by live-testing invoice-line creation (2026-08-24), after
-- migrations 146/147 already made invoice header creation work.
-- supplier_invoice_lines_account_id_fkey references chart_of_accounts(id) —
-- a completely empty table (0 rows, in every company, confirmed) that
-- nothing else in this codebase writes to. The live, actively-used chart of
-- accounts table everywhere else in the app (journalService.js, accounts.js,
-- customer_invoice_lines, reports.js, findAccountByCode(), etc.) is
-- `accounts`. Because chart_of_accounts is permanently empty, no
-- supplier_invoice_lines row could ever be inserted with any account_id at
-- all — the FK rejected every real account, confirmed live with account id
-- 536 (a real, active, company-scoped account in `accounts`).
--
-- Fix: drop the stray FK to the dead table and recreate it against the real
-- accounts table. ON DELETE SET NULL — a deleted/deactivated GL account
-- should not cascade-delete historical invoice line data; account_id is
-- already nullable (the app allows a line with no account assigned).
-- =============================================================================

ALTER TABLE supplier_invoice_lines
  DROP CONSTRAINT IF EXISTS supplier_invoice_lines_account_id_fkey;

ALTER TABLE supplier_invoice_lines
  ADD CONSTRAINT supplier_invoice_lines_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'supplier_invoice_lines'::regclass AND conname = 'supplier_invoice_lines_account_id_fkey';
