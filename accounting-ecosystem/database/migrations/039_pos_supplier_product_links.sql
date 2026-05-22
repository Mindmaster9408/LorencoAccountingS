-- ============================================================================
-- Migration 039 — POS Supplier-Product Links
-- ============================================================================
-- Creates product_suppliers junction table so products can be linked to
-- suppliers. Adds supplier_id FK to pos_supplier_receives so linked receives
-- are traceable back to the supplier record.
--
-- Run once against Supabase. Safe to re-run (all CREATE/ALTER use IF NOT EXISTS).
-- ============================================================================

-- Junction table: which products does each supplier supply?
CREATE TABLE IF NOT EXISTS product_suppliers (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, product_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_product_suppliers_by_supplier
  ON product_suppliers (company_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_product_suppliers_by_product
  ON product_suppliers (company_id, product_id);

-- Attach supplier FK to the receive header so linked receives are traceable
ALTER TABLE pos_supplier_receives
  ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_supplier_receives_supplier
  ON pos_supplier_receives (company_id, supplier_id)
  WHERE supplier_id IS NOT NULL;
