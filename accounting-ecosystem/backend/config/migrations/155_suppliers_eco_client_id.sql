-- =============================================================================
-- Migration 155: Add eco_client_id to suppliers (symmetry with customers)
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: customers already has an eco_client_id column pointing at
-- eco_clients (the table that carries client_code — the "CLT-XXXXXXXX"
-- Lorenco Ecosystem code meant to identify a client the same way everywhere:
-- ECO Dashboard, invoices, whichever accountant is handling them). suppliers
-- has no equivalent column at all — confirmed via a live schema check
-- (accounting-ecosystem/docs/leo-customer-supplier-linking-and-invoice-pullthrough.md,
-- section 0). This is the foundation for linking a company's own customer/
-- supplier records to another real platform company by client_code instead
-- of the ad-hoc invitation-code/customer_number mechanisms already in the
-- codebase (see that doc for the full picture) — needed on BOTH tables since
-- the mirroring principle requires each side to get both a customer AND a
-- supplier record.
--
-- Purely additive — no existing column touched, no existing row affected.
-- Nullable: only rows created/updated by the new linking flow will ever set
-- this; every existing supplier is unaffected and stays NULL.
-- =============================================================================

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS eco_client_id INTEGER REFERENCES eco_clients(id);

CREATE INDEX IF NOT EXISTS idx_suppliers_eco_client_id
  ON suppliers (eco_client_id)
  WHERE eco_client_id IS NOT NULL;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'suppliers' AND column_name = 'eco_client_id';
