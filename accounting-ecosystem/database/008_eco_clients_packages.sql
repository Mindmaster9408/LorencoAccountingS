-- ============================================================================
-- Migration 008: Add package/addons/billing columns to eco_clients
-- Run once against the Supabase database.
-- ============================================================================

-- Package name (e.g. 'standard') — extensible for future tiers
ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS package_name VARCHAR(100) DEFAULT 'standard';

-- Add-ons enabled for this client (e.g. ['sean'])
ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS addons TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Billing tracking — last confirmed invoice snapshot
ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS last_billed_employees INTEGER DEFAULT 0;

ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS last_billed_period VARCHAR(10);           -- YYYY-MM

ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS last_billed_date TIMESTAMPTZ;

-- client_company_id link (may already exist — safe to re-run with IF NOT EXISTS)
ALTER TABLE eco_clients
    ADD COLUMN IF NOT EXISTS client_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

-- Index for quick lookup by client_company_id
CREATE INDEX IF NOT EXISTS idx_eco_clients_client_company ON eco_clients(client_company_id);
