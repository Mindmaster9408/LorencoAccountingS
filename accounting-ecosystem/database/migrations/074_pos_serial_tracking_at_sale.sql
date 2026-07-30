-- ============================================================================
-- Migration 074: Serial Number Tracking — consumption at sale time
-- ============================================================================
-- Extends create_sale_atomic() (migration 030) to optionally consume serial
-- numbers for serial-tracked products, inside the SAME atomic transaction as
-- everything else the function already does. This is deliberately done here
-- (not as a follow-up JS query after the RPC returns) so a sale can never
-- complete with mismatched serial state — a serial-tracked product must
-- never oversell or sell an already-sold serial, and if it would, the whole
-- sale rolls back exactly like an insufficient-stock error already does.
--
-- BACKWARD COMPATIBLE — NO SIGNATURE CHANGE:
--   serial_numbers is an OPTIONAL key inside each element of the existing
--   p_items JSONB array, not a new function parameter. Every existing call
--   site (checkout, the /orders layby path, or anything else invoking this
--   RPC) that doesn't include it in an item continues to behave exactly as
--   before — this migration only adds new behaviour when that key is
--   present and non-empty for a given line item.
--
-- Run in: Supabase SQL Editor, project glkndlzjkhwfsolueyhk
-- ============================================================================

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
  v_sale_item_id   INT;
  v_serial_count   INT;
  v_serials_matched INT;
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

  -- ── B. Insert sale items (+ optional serial consumption) ─────────────────
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
    )
    RETURNING id INTO v_sale_item_id;

    -- Serial Number Tracking — optional. Only present when the till
    -- collected specific serials for a serial-tracked product. Absent/empty
    -- for every other line item: zero behaviour change.
    IF v_item ? 'serial_numbers' AND jsonb_array_length(v_item->'serial_numbers') > 0 THEN
      v_serial_count := jsonb_array_length(v_item->'serial_numbers');

      IF v_serial_count != (v_item->>'quantity')::INT THEN
        RAISE EXCEPTION
          'Serial number count mismatch for product %: expected % (qty), got %',
          (v_item->>'product_id')::INT, (v_item->>'quantity')::INT, v_serial_count;
      END IF;

      UPDATE pos_product_serials
      SET    status = 'sold', sale_id = v_sale_id, sale_item_id = v_sale_item_id, sold_at = NOW()
      WHERE  company_id    = p_company_id
        AND  product_id    = (v_item->>'product_id')::INT
        AND  status        = 'in_stock'
        AND  serial_number IN (SELECT jsonb_array_elements_text(v_item->'serial_numbers'));

      GET DIAGNOSTICS v_serials_matched = ROW_COUNT;

      IF v_serials_matched != v_serial_count THEN
        RAISE EXCEPTION
          'One or more serial numbers for product % are not currently in stock (already sold, removed, or do not exist)',
          (v_item->>'product_id')::INT;
      END IF;
    END IF;
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
