-- 180_eco_billing_customers.sql
-- Lorenco invoices everyone who uses the Eco from its own Ledger Leo company
-- (Lorenco Ecosystum, company 40). See services/ecoBilling.js.
--
-- 1. eco_clients.billing_excluded — test/demo/presentation/merged rows: hidden
--    from Platform Control (behind "Show test/demo") and never invoiced.
-- 2. customers gets a street address + registration number (a full SA tax
--    invoice needs the buyer's address) and eco_billing_company_id: the Eco
--    company this customer row stands for inside the billing company. One
--    row per (billing company, Eco company).

ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS billing_excluded BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address_line_1         TEXT,
  ADD COLUMN IF NOT EXISTS address_line_2         TEXT,
  ADD COLUMN IF NOT EXISTS registration_number    TEXT,
  ADD COLUMN IF NOT EXISTS eco_billing_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_eco_billing_company
  ON customers (company_id, eco_billing_company_id)
  WHERE eco_billing_company_id IS NOT NULL;

-- Ruan 2026-11-12: hide + never invoice the TEST company (and the rows created
-- under it), the demo companies, the presentation copies and the merged rows.
UPDATE eco_clients SET billing_excluded = true
 WHERE id IN (
   44,          -- Infinite Legacy — TEST (company 51)
   46, 47, 52,  -- rows created under the TEST company
   40, 43, 50,  -- "Demo Company" rows under three practices
   48, 49,      -- presentation copies (companies 53/54)
   39, 42       -- [MERGED-INTO-…] rows (inactive)
 );

NOTIFY pgrst, 'reload schema';
