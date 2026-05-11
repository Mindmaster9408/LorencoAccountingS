-- =============================================================================
-- Migration 024: POS decrement_stock atomic RPC
-- =============================================================================
-- WHY THIS EXISTS:
--   The POS sale creation route calls supabase.rpc('decrement_stock', ...) to
--   reduce product stock on every completed sale. This function was referenced
--   in application code but was never created in the database.
--
--   Without this function, every production sale falls back to a non-atomic
--   read-then-write pattern using a stale stock value captured at request start.
--   That fallback:
--     - allows concurrent cashiers to both sell the last unit simultaneously
--     - silently clamps negative stock to 0 via Math.max(), hiding oversells
--     - does not guarantee the decrement happened atomically
--
--   This function replaces that unsafe path with a single atomic SQL statement.
--
-- HOW IT WORKS:
--   The UPDATE executes atomically at the database level. PostgreSQL acquires a
--   row-level lock on the product row during the update. The WHERE clause
--   (stock_quantity >= p_quantity) is evaluated at write time, not at the
--   earlier point when the application read the stock. This means:
--
--     - Two concurrent sales of the last unit will race at the DB level.
--     - Only one UPDATE will satisfy the WHERE condition (stock_quantity >= qty).
--     - The other will affect 0 rows, triggering the RAISE EXCEPTION.
--     - That exception propagates back to the application as an RPC error.
--     - The application then returns a 422 stock failure to the client.
--
-- CONCURRENCY SAFETY:
--   This is safe under concurrent writes because UPDATE with WHERE is atomic
--   in PostgreSQL. No explicit BEGIN/COMMIT is needed — single-statement
--   updates are automatically wrapped in an implicit transaction.
--
-- NEGATIVE STOCK:
--   The WHERE condition (stock_quantity >= p_quantity) guarantees the update
--   only executes when sufficient stock exists. Stock can never go below zero
--   through this function. If the condition fails, RAISE EXCEPTION fires.
--
-- USAGE:
--   Run this file once in the Supabase SQL Editor for the production project.
--   Project ref: glkndlzjkhwfsolueyhk
--   After running, verify via: SELECT proname FROM pg_proc WHERE proname = 'decrement_stock';
-- =============================================================================

CREATE OR REPLACE FUNCTION decrement_stock(
  p_product_id INT,
  p_quantity    INT
)
RETURNS VOID AS $$
DECLARE
  rows_affected INT;
BEGIN
  -- Atomic compare-and-decrement.
  -- Only updates if current stock_quantity is sufficient.
  -- Row-level locking prevents concurrent writes from both succeeding.
  UPDATE products
  SET    stock_quantity = stock_quantity - p_quantity
  WHERE  id             = p_product_id
    AND  stock_quantity >= p_quantity;

  -- Check whether the update matched any row.
  -- If 0 rows were affected, stock was insufficient at write time.
  GET DIAGNOSTICS rows_affected = ROW_COUNT;

  IF rows_affected = 0 THEN
    RAISE EXCEPTION
      'Insufficient stock for product %: cannot decrement by %',
      p_product_id,
      p_quantity;
  END IF;

END;
$$ LANGUAGE plpgsql;
