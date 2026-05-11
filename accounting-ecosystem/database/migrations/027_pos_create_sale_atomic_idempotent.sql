-- Migration 027: Update create_sale_atomic with idempotency key support
-- Replaces the function installed by migration 025.
--
-- IMPORTANT — DROP OLD OVERLOAD FIRST:
--   CREATE OR REPLACE FUNCTION with a new parameter list creates an additional
--   overloaded function in PostgreSQL — it does NOT replace the old one.
--   If the old 14-parameter version is not dropped, PostgREST cannot resolve
--   calls and returns "could not choose the best candidate function".
--   The DROP below removes the old signature before installing the new one.
--
-- New behaviour (step 0 — idempotency gate):
--   If p_idempotency_key is provided AND a sale with that key already exists:
--     → Return the existing sale immediately.
--     → was_duplicate = true in the response.
--     → No INSERT, no stock decrement, no payment insert.
--
-- Existing behaviour (steps A–E) is unchanged when no duplicate is found.
--
-- The was_duplicate field is present in all responses so callers can
-- distinguish a new sale (was_duplicate: false) from a replayed one
-- (was_duplicate: true) and log / handle accordingly.
--
-- Note on concurrent race:
--   Two simultaneous requests with the same key arriving at the exact same
--   nanosecond may both pass the SELECT check and then one will fail with
--   23505 (unique constraint violation). The WHEN OTHERS THEN RAISE handler
--   surfaces this as a 500. Phase 2B sync lock prevents this from occurring
--   in practice.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Date: 2026-05-11
-- Depends on: 026_pos_add_idempotency_key.sql

-- Drop the old 14-parameter overload installed by migration 025.
-- Must match the exact parameter types of the old signature.
DROP FUNCTION IF EXISTS public.create_sale_atomic(
  integer, integer, text, text,
  numeric, numeric, numeric,
  jsonb, jsonb,
  numeric, integer, integer, text, text
);

CREATE OR REPLACE FUNCTION create_sale_atomic(
  -- Required parameters (no defaults) — must come first (PostgreSQL 42P13 rule)
  p_company_id      INT,
  p_user_id         INT,
  p_sale_number     TEXT,
  p_receipt_number  TEXT,
  p_subtotal        NUMERIC,
  p_vat_amount      NUMERIC,
  p_total_amount    NUMERIC,
  p_items           JSONB,
  p_payments        JSONB,
  -- Optional parameters (with defaults) — must come after all required params
  p_discount_amount   NUMERIC DEFAULT 0,
  p_till_session_id   INT     DEFAULT NULL,
  p_customer_id       INT     DEFAULT NULL,
  p_payment_method    TEXT    DEFAULT 'cash',
  p_notes             TEXT    DEFAULT NULL,
  p_idempotency_key   UUID    DEFAULT NULL
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
  -- If a key is provided, check for an existing sale with that key.
  -- Returning the existing sale here means no INSERT, no decrement_stock,
  -- no sale_items or sale_payments writes. The entire downstream is skipped.
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

  -- ── D. Decrement stock per item ───────────────────────────────────────────
  -- decrement_stock raises P0001 on insufficient stock, which propagates here
  -- and rolls back all inserts above (A, B, C). No orphaned records possible.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    PERFORM decrement_stock(
      (v_item->>'product_id')::INT,
      (v_item->>'quantity')::INT
    );
  END LOOP;

  -- ── E. Return created sale identifiers ────────────────────────────────────
  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'sale_number',    v_sale_number,
    'receipt_number', v_receipt_number,
    'total_amount',   v_total_amount,
    'status',         'completed',
    'was_duplicate',  false
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE;

END;
$$;
