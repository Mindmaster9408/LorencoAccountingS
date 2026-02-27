-- =============================================================================
-- Migration 005: eco_clients — client_company_id for data isolation
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- Each eco_client now has their OWN company in the companies table.
-- This ensures POS / Payroll / Accounting data is fully isolated per client.
-- =============================================================================

-- ─── 1. Add client_company_id column ─────────────────────────────────────────
ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS client_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_eco_clients_client_company ON eco_clients(client_company_id);

-- ─── 2. Back-fill: create a dedicated company for every existing eco_client
--        that does not already have one. ──────────────────────────────────────
DO $$
DECLARE
  rec        RECORD;
  new_co_id  INTEGER;
BEGIN
  FOR rec IN
    SELECT id, name, apps
    FROM eco_clients
    WHERE client_company_id IS NULL
      AND is_active = true
  LOOP
    -- Create a company named after the client
    INSERT INTO companies (company_name, trading_name, is_active, modules_enabled, subscription_status)
    VALUES (
      rec.name,
      rec.name,
      true,
      COALESCE(rec.apps, ARRAY['pos','payroll','accounting']::TEXT[]),
      'active'
    )
    RETURNING id INTO new_co_id;

    -- Link it back to the eco_client
    UPDATE eco_clients
    SET client_company_id = new_co_id
    WHERE id = rec.id;

    RAISE NOTICE 'Created company (id=%) for eco_client "%"', new_co_id, rec.name;
  END LOOP;
END $$;

-- ─── 3. Verification ──────────────────────────────────────────────────────────
SELECT
  ec.id,
  ec.name,
  ec.apps,
  ec.company_id       AS managing_company_id,
  ec.client_company_id,
  c.company_name      AS client_company_name
FROM eco_clients ec
LEFT JOIN companies c ON c.id = ec.client_company_id
ORDER BY ec.id;
