-- Migration 025: create_sale_atomic RPC
-- Wraps the full POS sale creation sequence in a single atomic plpgsql
-- transaction: INSERT sales + INSERT sale_items + INSERT sale_payments +
-- PERFORM decrement_stock per item.
--
-- Any RAISE EXCEPTION (including P0001 from decrement_stock on insufficient
-- stock) propagates upward and rolls back all writes made inside the function.
-- No orphaned sale records can result from a stock failure.
--
-- Depends on: decrement_stock (migration 024_pos_decrement_stock_rpc.sql)
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- Date: 2026-05-10

CREATE OR REPLACE FUNCTION create_sale_atomic(
  -- Required parameters (no defaults) — must come first
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
  p_discount_amount NUMERIC DEFAULT 0,
  p_till_session_id INT     DEFAULT NULL,
  p_customer_id     INT     DEFAULT NULL,
  p_payment_method  TEXT    DEFAULT 'cash',
  p_notes           TEXT    DEFAULT NULL
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
    notes
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
    p_notes
  )
  RETURNING id, sale_number, receipt_number, total_amount
  INTO v_sale_id, v_sale_number, v_receipt_number, v_total_amount;

  -- ── B. Insert sale items ──────────────────────────────────────────────────
  -- Both line_total and total_price are inserted (schema has both columns).
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
  -- and rolls back all inserts above. The sale record cannot exist without
  -- confirmed stock availability.
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
    'status',         'completed'
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE;

END;
$$;
