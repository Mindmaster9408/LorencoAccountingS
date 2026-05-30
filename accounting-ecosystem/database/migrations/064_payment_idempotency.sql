-- ============================================================================
-- Migration 064: Payment Idempotency Keys
-- ============================================================================
-- Purpose:
--   Adds an idempotency_key column to customer_payments and supplier_payments.
--   Prevents duplicate payment rows, duplicate GL journals, and duplicate
--   allocations caused by double-click, browser retry, or slow-network replay.
--
-- Design (mirrors migration 026 on the POS sales table):
--   - Nullable UUID column. Existing payment rows retain NULL (not affected).
--   - Partial UNIQUE INDEX: (company_id, idempotency_key) WHERE key IS NOT NULL.
--     Only rows with a non-null key participate in the uniqueness constraint.
--   - company_id scoping prevents cross-tenant key collisions.
--   - Backend generates the key server-side after receiving it from the client.
--     Client generates a UUID per payment form open (in-memory, not localStorage).
--
-- On duplicate submission:
--   1. Pre-check: if idempotency_key already exists → return existing payment (no GL)
--   2. Race condition: if concurrent request wins the INSERT → unique constraint
--      violation (23505) → reverse the duplicate GL journal → return winning payment
--
-- Run in: Supabase SQL Editor
-- Prerequisite: 012_accounting_schema.sql (customer_payments + supplier_payments)
-- Safe: ADD COLUMN IF NOT EXISTS — no data loss, no existing rows affected
-- ============================================================================

-- customer_payments
ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

COMMENT ON COLUMN customer_payments.idempotency_key IS
  'Client-generated UUID per payment submission. Null for legacy rows. '
  'Partial unique index enforces deduplication for new submissions.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_payments_idempotency
  ON customer_payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- supplier_payments
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

COMMENT ON COLUMN supplier_payments.idempotency_key IS
  'Client-generated UUID per payment submission. Null for legacy rows. '
  'Partial unique index enforces deduplication for new submissions.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_payments_idempotency
  ON supplier_payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- Summary:
--   customer_payments.idempotency_key  UUID  nullable  unique per company
--   supplier_payments.idempotency_key  UUID  nullable  unique per company
--
--   All existing rows retain NULL — partial index only fires on non-null keys.
--   Historical payment data is completely unaffected.
-- ============================================================================
