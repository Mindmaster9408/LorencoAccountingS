-- ============================================================================
-- Migration 075: POS Serial Number Tracking — purchase-history linkage
-- ============================================================================
-- The Serial Number Lookup report (products.js GET /serials/search) has
-- been a current-status snapshot only — it can show which product/sale a
-- serial belongs to, but not which supplier it was bought from, what
-- invoice it came in on, or when. That information only ever existed as
-- unstructured text in pos_product_serials.received_reference (e.g.
-- "Receive #12 / INV-4471" or "Delivery #3 for PO PO-0042") — fine for a
-- human reading a log, not something a report can safely parse and join.
--
-- Adds two nullable FKs so a serial's purchase origin is queryable
-- directly instead of regex-parsed out of free text:
--   receive_id  -> pos_supplier_receives   (standalone Receive Stock path,
--                  inventory.js POST /receive)
--   transfer_id -> pos_company_transfers   (Purchase Order delivery path,
--                  purchase-orders.js POST /:id/deliveries/:deliveryId/receive)
-- Exactly one (or neither, for serials received before this migration —
-- those keep only their original received_reference text) will be set on
-- any given row, since a unit is received via exactly one of these paths.
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
-- ============================================================================

ALTER TABLE pos_product_serials
  ADD COLUMN IF NOT EXISTS receive_id  INTEGER REFERENCES pos_supplier_receives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transfer_id INTEGER REFERENCES pos_company_transfers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_product_serials_receive  ON pos_product_serials(receive_id);
CREATE INDEX IF NOT EXISTS idx_pos_product_serials_transfer ON pos_product_serials(transfer_id);
