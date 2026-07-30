-- ============================================================================
-- Migration 073: POS Serial Number Tracking (add-on)
-- ============================================================================
-- Per-product opt-in serial number tracking for the Checkout Charlie POS.
-- Gated at the company level by the 'serial_tracking' entry in
-- companies.modules_enabled (Control Panel add-on toggle — see
-- backend/shared/routes/eco-clients.js), and at the product level by the
-- new products.track_serial flag below. A company having the add-on
-- enabled does not by itself make any product serial-tracked — each
-- product opts in individually (mirrors how a real store works: even an
-- electronics client has small accessories that don't need per-unit
-- tracking).
--
-- pos_product_serials.status is a mutable lifecycle field (in_stock ->
-- sold -> removed, or back to in_stock on a return), not an append-only
-- financial ledger row like pos_cash_paidouts/pos_recon_snapshots — this
-- is inventory metadata, and the existing inventory_adjustments audit
-- logging already covers the who/when trail at the stock-movement level.
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS track_serial BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS pos_product_serials (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  serial_number      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'in_stock'
                        CHECK (status IN ('in_stock', 'sold', 'removed')),
  received_reference TEXT,        -- links back to the receive/adjustment that brought it in
  sale_id            INTEGER,
  sale_item_id       INTEGER,
  sold_at            TIMESTAMPTZ,
  created_by_user_id INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, product_id, serial_number)
);

CREATE INDEX IF NOT EXISTS idx_pos_product_serials_product ON pos_product_serials(product_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_product_serials_sale ON pos_product_serials(sale_id);
CREATE INDEX IF NOT EXISTS idx_pos_product_serials_serial ON pos_product_serials(company_id, serial_number);
