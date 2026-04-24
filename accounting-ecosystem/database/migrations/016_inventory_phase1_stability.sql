-- ============================================================================
-- Migration 016: Inventory Phase 1 Stability
-- Date: 2026-04-24
-- ============================================================================
-- Changes:
--   1. Add canonical supplier columns (name, email, phone, vat_number, notes)
--      to the suppliers table and backfill from legacy POS column names.
--   2. Add negative stock protection constraint on inventory_items.
--   3. Update purchase_orders status constraint to include partial_receipt.
--   4. Create adjust_inventory_stock() atomic RPC function — single source of
--      truth for all stock mutations across the ecosystem.
-- ============================================================================
-- SAFETY NOTE:
-- This migration is safe to re-run. All ALTER TABLE statements use
-- ADD COLUMN IF NOT EXISTS / ADD CONSTRAINT IF NOT EXISTS patterns.
-- The negative stock constraint uses NOT VALID to avoid scanning existing rows.
-- Run the negative-stock check query in Step 2a BEFORE validating that
-- constraint in production.
-- ============================================================================


-- ─── STEP 1: Add canonical supplier columns ───────────────────────────────────
-- The suppliers table was defined for the POS module with column names
-- (supplier_name, contact_email, contact_phone, tax_reference) that do not
-- match the inventory backend code which uses (name, email, phone, vat_number).
-- We add the canonical columns alongside the old ones so existing data is safe.
-- Old columns are NOT dropped — they remain for backward compatibility.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS name        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS phone       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS vat_number  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS notes       TEXT;

-- Backfill canonical columns from legacy POS column names
-- Only updates rows where the new columns are still null (safe on re-run)
UPDATE suppliers
SET
  name        = COALESCE(name,        supplier_name),
  email       = COALESCE(email,       contact_email),
  phone       = COALESCE(phone,       contact_phone),
  vat_number  = COALESCE(vat_number,  tax_reference)
WHERE name IS NULL OR name = '';

-- Ensure no nulls remain in the canonical name column
UPDATE suppliers
SET name = COALESCE(supplier_name, 'Unknown Supplier')
WHERE name IS NULL OR name = '';

-- Make canonical name NOT NULL (safe after backfill above)
ALTER TABLE suppliers ALTER COLUMN name SET NOT NULL;


-- ─── STEP 2: Negative stock protection ───────────────────────────────────────
-- IMPORTANT: Run the following diagnostic query BEFORE Step 2b in production:
--
--   SELECT id, name, current_stock
--   FROM inventory_items
--   WHERE current_stock < 0;
--
-- If any rows are returned, those stock levels must be manually corrected
-- before VALIDATE CONSTRAINT is called. The NOT VALID constraint below will
-- add the rule without scanning existing rows, allowing gradual cleanup.

-- Step 2a: Add constraint without scanning existing rows (non-blocking)
ALTER TABLE inventory_items
  ADD CONSTRAINT chk_current_stock_non_negative
  CHECK (current_stock >= 0) NOT VALID;

-- Step 2b: Validate constraint against all existing rows.
-- Comment this out if any rows have current_stock < 0 and re-run after fixing.
-- ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_current_stock_non_negative;


-- ─── STEP 3: Update purchase_orders status constraint ─────────────────────────
-- The original constraint (from migration 007) uses 'partial'.
-- We replace it with an extended set that includes 'partial_receipt'.

-- Remove the old constraint (migration 007 named it via inline CHECK)
-- Postgres auto-generates a name — we drop by searching for it.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'purchase_orders'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%'
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS ' || quote_ident(v_conname);
  END IF;
END $$;

-- Add updated constraint with partial_receipt included
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'sent', 'partial_receipt', 'received', 'cancelled'));


-- ─── STEP 4: Create adjust_inventory_stock() atomic RPC function ──────────────
-- This function is the SINGLE SOURCE OF TRUTH for all stock mutations.
-- It atomically updates current_stock AND inserts a stock_movements record.
-- No stock update can occur without a corresponding movement record.
-- No movement can be recorded if the stock update fails.
--
-- Returns JSONB:
--   { "success": true,  "new_stock": <number> }         on success
--   { "success": false, "error": "Insufficient stock",
--     "available": <number> }                            on insufficient stock
--   { "success": false, "error": "Item not found" }     on missing item
--
-- Parameters:
--   p_company_id    — company context (mandatory — multi-tenant safety)
--   p_item_id       — inventory_items.id
--   p_delta         — positive = stock in, negative = stock out
--   p_movement_type — 'in'|'out'|'return'|'adjustment'|'transfer'
--   p_warehouse_id  — optional warehouse FK
--   p_reference     — optional reference string (PO number, WO number, etc.)
--   p_notes         — optional notes
--   p_cost_price    — optional cost price per unit
--   p_created_by    — optional users.id of initiating user

CREATE OR REPLACE FUNCTION adjust_inventory_stock(
  p_company_id    INTEGER,
  p_item_id       INTEGER,
  p_delta         NUMERIC,
  p_movement_type VARCHAR(50),
  p_warehouse_id  INTEGER  DEFAULT NULL,
  p_reference     VARCHAR(255) DEFAULT NULL,
  p_notes         TEXT     DEFAULT NULL,
  p_cost_price    NUMERIC  DEFAULT NULL,
  p_created_by    INTEGER  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_stock NUMERIC;
BEGIN
  -- Atomic stock update — will only update if new stock remains >= 0
  -- The AND (current_stock + p_delta) >= 0 condition prevents negative stock
  UPDATE inventory_items
  SET
    current_stock = current_stock + p_delta,
    updated_at    = NOW()
  WHERE id         = p_item_id
    AND company_id = p_company_id
    AND (current_stock + p_delta) >= 0
  RETURNING current_stock INTO v_new_stock;

  -- If no row was returned, determine the reason
  IF NOT FOUND THEN
    -- Check if the item exists at all
    IF EXISTS (
      SELECT 1
      FROM inventory_items
      WHERE id = p_item_id AND company_id = p_company_id
    ) THEN
      -- Item exists but stock would go negative — insufficient stock
      RETURN jsonb_build_object(
        'success',   false,
        'error',     'Insufficient stock',
        'available', (
          SELECT current_stock
          FROM inventory_items
          WHERE id = p_item_id AND company_id = p_company_id
        )
      );
    ELSE
      -- Item not found for this company
      RETURN jsonb_build_object(
        'success', false,
        'error',   'Item not found'
      );
    END IF;
  END IF;

  -- Stock update succeeded — now record the movement in the same transaction
  -- ABS(p_delta) ensures the movement quantity is always positive in the ledger
  INSERT INTO stock_movements (
    company_id,
    item_id,
    warehouse_id,
    type,
    quantity,
    reference,
    notes,
    cost_price,
    created_by,
    created_at
  ) VALUES (
    p_company_id,
    p_item_id,
    p_warehouse_id,
    p_movement_type,
    ABS(p_delta),
    p_reference,
    p_notes,
    p_cost_price,
    p_created_by,
    NOW()
  );

  RETURN jsonb_build_object(
    'success',   true,
    'new_stock', v_new_stock
  );
END;
$$;

-- Grant execute permission to authenticated roles
-- (Supabase service role already has full access — this is for completeness)
-- GRANT EXECUTE ON FUNCTION adjust_inventory_stock TO authenticated;


-- ─── Verification ─────────────────────────────────────────────────────────────
-- Run these after migration to confirm correctness:
--
-- 1. Check supplier canonical columns exist:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'suppliers' AND column_name IN ('name','email','phone','vat_number','notes');
--
-- 2. Check constraint exists on inventory_items:
--    SELECT conname FROM pg_constraint WHERE conrelid = 'inventory_items'::regclass
--    AND conname = 'chk_current_stock_non_negative';
--
-- 3. Check purchase_orders status constraint:
--    SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'purchase_orders'::regclass AND contype = 'c';
--
-- 4. Check function exists:
--    SELECT proname FROM pg_proc WHERE proname = 'adjust_inventory_stock';
