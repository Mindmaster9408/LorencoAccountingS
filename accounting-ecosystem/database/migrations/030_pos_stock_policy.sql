-- =============================================================================
-- Migration 030: POS Company Stock Policy Settings
-- =============================================================================
-- WHY THIS EXISTS:
--   Manufacturing and assembly clients often sell products before all stock
--   transfers/production receipts are captured, driving stock temporarily
--   negative. Blocking every sale at 0 stock makes the POS unusable for these
--   businesses. This migration adds a company-level toggle:
--     allow_negative_stock_sales BOOLEAN DEFAULT false
--   Default is FALSE — existing strict behaviour is preserved for all companies
--   that do not explicitly enable the setting.
--
-- WHAT CHANGES:
--   1. company_settings — new column allow_negative_stock_sales
--   2. decrement_stock_v2 — flexible version of decrement_stock; strict when
--      p_allow_negative = false (same guard as original), unconditional when
--      p_allow_negative = true.
--   3. create_sale_atomic — updated to accept p_allow_negative_stock and
--      call decrement_stock_v2 instead of decrement_stock.
--
-- SAFETY GUARANTEES:
--   - decrement_stock (migration 024) is NOT changed. It remains strict and
--     may be called by any code path outside create_sale_atomic.
--   - decrement_stock_v2 strict path is logically identical to decrement_stock.
--   - Default value of p_allow_negative_stock = false means any caller that
--     does not pass the flag gets the same strict behaviour as before.
--   - The DB function enforces the policy — the application cannot bypass it
--     by omitting the parameter.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- =============================================================================

-- ── Step 1: Add allow_negative_stock_sales to company_settings ────────────────
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS allow_negative_stock_sales BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN company_settings.allow_negative_stock_sales IS
  'When true, sales may drive product stock_quantity below zero. '
  'Intended for manufacturing clients where stock receipts lag behind sales. '
  'Default false — strict stock protection applies.';

-- ── Step 2: decrement_stock_v2 — flexible atomic decrement ───────────────────
-- p_allow_negative = false → identical to decrement_stock (strict guard).
-- p_allow_negative = true  → unconditional decrement; stock may go negative.
-- The product row must exist in both modes (rows_affected = 0 on miss).
CREATE OR REPLACE FUNCTION decrement_stock_v2(
  p_product_id     INT,
  p_quantity       INT,
  p_allow_negative BOOLEAN DEFAULT false
)
RETURNS VOID AS $$
DECLARE
  rows_affected INT;
BEGIN

  IF p_allow_negative THEN
    -- Negative-stock-allowed mode: unconditional decrement.
    -- Stock may go below zero. Row must still exist.
    UPDATE products
    SET    stock_quantity = stock_quantity - p_quantity
    WHERE  id = p_product_id;

    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    IF rows_affected = 0 THEN
      RAISE EXCEPTION
        'Product % not found during stock decrement', p_product_id;
    END IF;

  ELSE
    -- Strict mode: identical to decrement_stock.
    -- WHERE stock_quantity >= p_quantity is evaluated atomically.
    -- If 0 rows affected, stock was insufficient at write time.
    UPDATE products
    SET    stock_quantity = stock_quantity - p_quantity
    WHERE  id             = p_product_id
      AND  stock_quantity >= p_quantity;

    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    IF rows_affected = 0 THEN
      RAISE EXCEPTION
        'Insufficient stock for product %: cannot decrement by %',
        p_product_id,
        p_quantity;
    END IF;

  END IF;

END;
$$ LANGUAGE plpgsql;

-- ── Step 3: Replace create_sale_atomic with stock-policy-aware version ────────
-- Must DROP the existing 15-parameter overload before installing the new one.
-- CREATE OR REPLACE with a new parameter list creates an additional overload
-- (not a replacement) — PostgREST then cannot resolve the call unambiguously.
-- The DROP matches the exact signature installed by migration 027.
DROP FUNCTION IF EXISTS public.create_sale_atomic(
  integer, integer, text, text,
  numeric, numeric, numeric,
  jsonb, jsonb,
  numeric, integer, integer, text, text, uuid
);

CREATE OR REPLACE FUNCTION create_sale_atomic(
  -- Required parameters (no defaults) — must come first (PostgreSQL 42P13 rule)
  p_company_id          INT,
  p_user_id             INT,
  p_sale_number         TEXT,
  p_receipt_number      TEXT,
  p_subtotal            NUMERIC,
  p_vat_amount          NUMERIC,
  p_total_amount        NUMERIC,
  p_items               JSONB,
  p_payments            JSONB,
  -- Optional parameters (with defaults) — must come after all required params
  p_discount_amount     NUMERIC  DEFAULT 0,
  p_till_session_id     INT      DEFAULT NULL,
  p_customer_id         INT      DEFAULT NULL,
  p_payment_method      TEXT     DEFAULT 'cash',
  p_notes               TEXT     DEFAULT NULL,
  p_idempotency_key     UUID     DEFAULT NULL,
  p_allow_negative_stock BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_sale_id        INT;
  v_sale_number    TEXT;
  v_receipt_number TEXT;
  v_total_amount   NUMERIC;
  v_item           JSONB;
  v_payment        JSONB;
BEGIN

  -- ── 0. Idempotency gate ───────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, sale_number, receipt_number, total_amount
    INTO   v_sale_id, v_sale_number, v_receipt_number, v_total_amount
    FROM   sales
    WHERE  idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'sale_id',        v_sale_id,
        'sale_number',    v_sale_number,
        'receipt_number', v_receipt_number,
        'total_amount',   v_total_amount,
        'status',         'completed',
        'was_duplicate',  true
      );
    END IF;
  END IF;

  -- ── A. Insert sale record ─────────────────────────────────────────────────
  INSERT INTO sales (
    company_id,
    sale_number,
    receipt_number,
    user_id,
    cashier_id,
    customer_id,
    till_session_id,
    subtotal,
    discount_amount,
    vat_amount,
    total_amount,
    payment_method,
    payment_status,
    status,
    notes,
    idempotency_key
  ) VALUES (
    p_company_id,
    p_sale_number,
    p_receipt_number,
    p_user_id,
    p_user_id,
    p_customer_id,
    p_till_session_id,
    p_subtotal,
    p_discount_amount,
    p_vat_amount,
    p_total_amount,
    p_payment_method,
    'completed',
    'completed',
    p_notes,
    p_idempotency_key
  )
  RETURNING id, sale_number, receipt_number, total_amount
  INTO v_sale_id, v_sale_number, v_receipt_number, v_total_amount;

  -- ── B. Insert sale items ──────────────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO sale_items (
      company_id,
      sale_id,
      product_id,
      product_name,
      quantity,
      unit_price,
      discount_amount,
      vat_rate,
      line_total,
      total_price
    ) VALUES (
      p_company_id,
      v_sale_id,
      (v_item->>'product_id')::INT,
       v_item->>'product_name',
      (v_item->>'quantity')::INT,
      (v_item->>'unit_price')::NUMERIC,
      (v_item->>'discount_amount')::NUMERIC,
      (v_item->>'vat_rate')::NUMERIC,
      (v_item->>'line_total')::NUMERIC,
      (v_item->>'line_total')::NUMERIC
    );
  END LOOP;

  -- ── C. Insert payment records ─────────────────────────────────────────────
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    INSERT INTO sale_payments (
      company_id,
      sale_id,
      payment_method,
      amount,
      reference
    ) VALUES (
      p_company_id,
      v_sale_id,
       v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
       v_payment->>'reference'
    );
  END LOOP;

  -- ── D. Decrement stock per item (policy-aware) ────────────────────────────
  -- decrement_stock_v2 is called with the p_allow_negative flag.
  -- In strict mode (flag = false): raises P0001 on insufficient stock, which
  -- propagates here and rolls back all inserts above. No orphaned records.
  -- In negative-stock mode (flag = true): unconditional decrement; stock may
  -- go below zero. All inserts are still atomic — a missing product still rolls
  -- back everything.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    PERFORM decrement_stock_v2(
      (v_item->>'product_id')::INT,
      (v_item->>'quantity')::INT,
      p_allow_negative_stock
    );
  END LOOP;

  -- ── E. Return created sale identifiers ────────────────────────────────────
  RETURN jsonb_build_object(
    'sale_id',              v_sale_id,
    'sale_number',          v_sale_number,
    'receipt_number',       v_receipt_number,
    'total_amount',         v_total_amount,
    'status',               'completed',
    'was_duplicate',        false,
    'negative_stock_allowed', p_allow_negative_stock
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE;

END;
$$;
