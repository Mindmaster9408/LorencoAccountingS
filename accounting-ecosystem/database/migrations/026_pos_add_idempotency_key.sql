-- Migration 026: Add idempotency_key column to sales table
-- Enables duplicate-safe sale creation. The same offline sale can be posted
-- multiple times (network retry, double sync event) without creating duplicate
-- records, duplicate stock decrements, or duplicate payments.
--
-- Design:
--   - Nullable UUID column. Existing sales have NULL (allowed — the partial
--     index only enforces uniqueness when the value is NOT NULL).
--   - Partial UNIQUE INDEX: only rows where idempotency_key IS NOT NULL
--     participate in the constraint. This means legacy sales and sales
--     created without a key are not affected.
--   - The create_sale_atomic function (migration 027) checks this column
--     before inserting and returns the existing sale on match.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Date: 2026-05-11
-- Depends on: 025_pos_create_sale_atomic.sql

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency_key
  ON sales (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
