-- =============================================================================
-- Migration 037: POS Multi-Till Hardening
-- =============================================================================
-- Workstream 9B — three targeted fixes from the 9A multi-till stress audit.
--
-- FIXES IN THIS MIGRATION:
--
--   1. Per-till active session uniqueness
--      Partial UNIQUE INDEX on till_sessions(company_id, till_id) WHERE status = 'open'.
--      Prevents two cashiers from opening sessions on the same physical till
--      simultaneously. Closed and cashed-up sessions are excluded — multiple
--      historical sessions per till are expected and correct.
--      The application layer (sessions.js) checks BEFORE INSERT and returns 409.
--      This index is the DB-level safety net for any concurrent race.
--
--   2. Atomic return stock restoration: restore_stock_for_return()
--      Companion to decrement_stock_v2 (migration 030).
--      Replaces the read-then-write pattern in the return route with a single
--      atomic UPDATE stock_quantity = stock_quantity + qty. No read required.
--      No race window under concurrent returns of the same product.
--      Called once per returned item from sales.js /:id/return.
--
-- WHAT IS NOT CHANGED:
--   - decrement_stock_v2 — not touched
--   - create_sale_atomic — not touched
--   - till_sessions table structure — no column changes
--   - products table structure — no column changes
--
-- SAFETY:
--   - CREATE UNIQUE INDEX IF NOT EXISTS — idempotent, safe to re-run
--   - CREATE OR REPLACE FUNCTION — idempotent, safe to re-run
--   - No data mutations. No destructive operations.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Depends on: 030_pos_stock_policy.sql (products table, decrement_stock_v2 pattern)
-- =============================================================================

-- ── 1. Per-till active session uniqueness ─────────────────────────────────────
-- Enforces: at most one session with status = 'open' may exist per
-- (company_id, till_id) pair.
--
-- Closed ('closed', 'cashed_up') sessions are outside the partial filter —
-- unlimited historical sessions per till are valid and expected.
--
-- This index fires AFTER the application-layer check in sessions.js, providing
-- a hard guarantee if two concurrent open requests race through simultaneously.

CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_till_open_unique
    ON till_sessions (company_id, till_id)
    WHERE status = 'open';

COMMENT ON INDEX idx_till_sessions_till_open_unique IS
    'Enforces at most one open session per till per company. '
    'Partial index (WHERE status = ''open'') so historical closed sessions '
    'are not constrained. Added by migration 037 (Workstream 9B).';

-- ── 2. Atomic return stock restoration ───────────────────────────────────────
-- Called once per item in the return route (sales.js /:id/return).
-- Replaces:
--   SELECT stock_quantity ... WHERE id = ? AND company_id = ?
--   UPDATE ... SET stock_quantity = (selected value) + quantity WHERE id = ?
-- With:
--   UPDATE ... SET stock_quantity = stock_quantity + p_quantity WHERE id = ? AND company_id = ?
--
-- The arithmetic is evaluated atomically at UPDATE time under a row-level lock.
-- Two concurrent calls for the same product both succeed and both increments
-- are applied — no overwrite race possible.
--
-- Raises PRODUCT_NOT_FOUND if the product does not exist in the company.
-- The caller (sales.js) treats this as a non-fatal warning: the pos_returns
-- record is already committed when this function is called.

CREATE OR REPLACE FUNCTION restore_stock_for_return(
    p_product_id  INT,
    p_quantity    INT,
    p_company_id  INT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    rows_affected INT;
BEGIN
    UPDATE products
    SET    stock_quantity = stock_quantity + p_quantity
    WHERE  id            = p_product_id
      AND  company_id    = p_company_id;

    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    IF rows_affected = 0 THEN
        RAISE EXCEPTION
            'PRODUCT_NOT_FOUND: product % not found in company % during stock restoration',
            p_product_id, p_company_id;
    END IF;
END;
$$;

COMMENT ON FUNCTION restore_stock_for_return(INT, INT, INT) IS
    'Atomically increments stock_quantity for a returned item. '
    'Called once per item in the return route. Safe under concurrent returns: '
    'stock_quantity + p_quantity is evaluated at UPDATE time under a row lock. '
    'Raises PRODUCT_NOT_FOUND if the product does not exist in the company. '
    'Added by migration 037 (Workstream 9B).';
