-- ============================================================================
-- Migration 055 — Inventory Procurement Hardening (Codebox 05)
-- Lorenco Storehouse — MrEasy Pilot Path
-- ============================================================================
-- Purpose:
--   1. Harden purchase_orders — standardized status, approval columns,
--      PO number sequence, currency, subtotal/tax split.
--   2. Harden purchase_order_items — supplier_sku, per-line expected date,
--      notes. Ensure po_id column exists (some prior installs used
--      purchase_order_id — this migration normalises to po_id via alias ADD).
--   3. Create purchase_receipts — immutable receipt header per receive event.
--   4. Create purchase_receipt_lines — immutable per-item receipt rows.
--   5. Create supplier_item_history — per-supplier/item purchase intelligence.
--
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Run AFTER migrations 050 – 054.
-- ============================================================================


-- ─── STEP 1: Extend purchase_orders ─────────────────────────────────────────

-- Add PO number sequence for auto-generation
CREATE SEQUENCE IF NOT EXISTS po_number_seq START 1000;

-- Harden existing table
ALTER TABLE purchase_orders
  -- Approval workflow
  ADD COLUMN IF NOT EXISTS approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ NULL,

  -- Financial fields
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10)   NOT NULL DEFAULT 'ZAR',
  ADD COLUMN IF NOT EXISTS subtotal      NUMERIC(15,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount    NUMERIC(15,4) NOT NULL DEFAULT 0,

  -- Rename ambiguity: ensure total_amount exists (already in base table)
  -- po_number already exists — make it NOT NULL with sequence default
  ADD COLUMN IF NOT EXISTS supplier_ref  VARCHAR(100) NULL;  -- supplier's own reference number

-- Standardise the status CHECK constraint.
-- The base 007 migration used: draft/sent/partial/received/cancelled
-- The index.js code uses:      draft/sent/partial_receipt/received/cancelled
-- Codebox 05 status set:       draft/approved/ordered/partial_receipt/fully_received/closed/cancelled
--
-- We cannot DROP a named CHECK constraint with IF EXISTS in all PG versions,
-- so we use a safe ALTER approach: drop the old constraint if it exists,
-- then add the new one.
DO $$
BEGIN
  -- Remove old status constraint if present (name may differ across installs)
  BEGIN
    ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Add Codebox 05 status constraint
  BEGIN
    ALTER TABLE purchase_orders
      ADD CONSTRAINT chk_po_status CHECK (status IN (
        'draft',
        'approved',
        'ordered',
        'partial_receipt',
        'fully_received',
        'closed',
        'cancelled'
      ));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$$;

-- ─── STEP 2: Extend purchase_order_items ────────────────────────────────────

-- Ensure po_id column exists. The original 007 migration created
-- purchase_order_id. Later code (index.js) uses po_id. We add po_id
-- as an alias populated from purchase_order_id where null.
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS po_id          INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS supplier_sku   VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS expected_date  DATE         NULL,
  ADD COLUMN IF NOT EXISTS notes          TEXT         NULL,
  ADD COLUMN IF NOT EXISTS line_total_calc NUMERIC(15,4) NULL; -- mutable mirror of generated col

-- Backfill po_id from purchase_order_id where po_id is null
UPDATE purchase_order_items
   SET po_id = purchase_order_id
 WHERE po_id IS NULL AND purchase_order_id IS NOT NULL;

-- Create index on po_id for future queries
CREATE INDEX IF NOT EXISTS idx_poi_po_id ON purchase_order_items(po_id);


-- ─── STEP 3: Create purchase_receipts ───────────────────────────────────────
-- One row per receive event. Immutable after creation.

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER      NOT NULL,
  po_id            INTEGER      NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  receipt_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  received_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  notes            TEXT         NULL,
  total_qty        NUMERIC(18,4) NOT NULL DEFAULT 0,
  total_value      NUMERIC(15,4) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  -- No updated_at — receipts are immutable
);

CREATE INDEX IF NOT EXISTS idx_pr_company      ON purchase_receipts (company_id);
CREATE INDEX IF NOT EXISTS idx_pr_company_po   ON purchase_receipts (company_id, po_id);

COMMENT ON TABLE purchase_receipts IS
  'Immutable receipt event records. One row per receive action on a PO. '
  'Never updated after creation. Creates the audit trail for all stock received.';


-- ─── STEP 4: Create purchase_receipt_lines ───────────────────────────────────
-- One row per item per receive event. Immutable after creation.

CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
  id               BIGSERIAL PRIMARY KEY,
  receipt_id       BIGINT       NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
  po_item_id       INTEGER      NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  item_id          INTEGER      NOT NULL,
  qty_received     NUMERIC(18,4) NOT NULL,
  unit_cost        NUMERIC(15,4) NOT NULL DEFAULT 0,
  line_value       NUMERIC(15,4) NOT NULL DEFAULT 0,
  movement_id      BIGINT       NULL,   -- links to stock_movements.id
  warehouse_id     INTEGER      NULL,
  batch_ref        VARCHAR(100) NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_prl_qty_positive   CHECK (qty_received > 0),
  CONSTRAINT chk_prl_cost_nonneg    CHECK (unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_prl_receipt    ON purchase_receipt_lines (receipt_id);
CREATE INDEX IF NOT EXISTS idx_prl_item       ON purchase_receipt_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_prl_po_item    ON purchase_receipt_lines (po_item_id);

COMMENT ON TABLE purchase_receipt_lines IS
  'Immutable line-level receipt records. One row per item per receive action. '
  'Links to stock_movements for full forensic traceability.';


-- ─── STEP 5: Create supplier_item_history ────────────────────────────────────
-- Intelligence table: per company+supplier+item, tracks purchase history.
-- Updated after every successful receipt (not after PO create/approve).

CREATE TABLE IF NOT EXISTS supplier_item_history (
  id                    BIGSERIAL PRIMARY KEY,
  company_id            INTEGER       NOT NULL,
  supplier_id           INTEGER       NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id               INTEGER       NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  last_purchase_cost    NUMERIC(15,4) NULL,
  average_supplier_cost NUMERIC(15,4) NULL,
  last_purchase_date    TIMESTAMPTZ   NULL,
  lead_time_days        INTEGER       NOT NULL DEFAULT 0,
  preferred_supplier    BOOLEAN       NOT NULL DEFAULT FALSE,
  last_po_id            INTEGER       REFERENCES purchase_orders(id) ON DELETE SET NULL,
  last_received_qty     NUMERIC(18,4) NULL,
  purchase_count        INTEGER       NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_sih_company_supplier_item UNIQUE (company_id, supplier_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_sih_company_item     ON supplier_item_history (company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_sih_company_supplier ON supplier_item_history (company_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_sih_preferred        ON supplier_item_history (company_id, item_id, preferred_supplier);

COMMENT ON TABLE supplier_item_history IS
  'Per-supplier/item intelligence for procurement recommendations. '
  'Updated ONLY after successful stock receipt. Never updated on PO create/approve. '
  'average_supplier_cost = running weighted average across all receipts from this supplier.';


-- ─── STEP 6: Extend suppliers table ─────────────────────────────────────────

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_code  VARCHAR(50)  NULL,
  ADD COLUMN IF NOT EXISTS vat_number     VARCHAR(50)  NULL,
  ADD COLUMN IF NOT EXISTS lead_time_days INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_terms  VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS currency_code  VARCHAR(10)  NOT NULL DEFAULT 'ZAR',
  ADD COLUMN IF NOT EXISTS supplier_name  TEXT         NULL;   -- alias mirror of name

-- supplier_name backfill (backend sets this to name on insert)
UPDATE suppliers SET supplier_name = name WHERE supplier_name IS NULL;


-- ─── STEP 7: Performance Indexes ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_po_company_status
  ON purchase_orders (company_id, status);

CREATE INDEX IF NOT EXISTS idx_po_company_supplier
  ON purchase_orders (company_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_po_company_expected
  ON purchase_orders (company_id, expected_date)
  WHERE status NOT IN ('cancelled', 'closed', 'fully_received');
