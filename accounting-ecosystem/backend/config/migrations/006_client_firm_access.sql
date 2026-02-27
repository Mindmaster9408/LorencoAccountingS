-- =============================================================================
-- Migration 006: eco_client_firm_access — Cross-Firm Client Visibility
-- =============================================================================
-- Allows accounting practices to view eco_clients managed by other practices.
-- A business owner or super admin grants a firm read-access to their client.
-- The firm's accountants/owners can then see that client in their ecosystem.
--
-- Example flow:
--   1. John's Hardware Store is an eco_client managed by The Infinite Legacy.
--   2. John also works with FGH Accounting.
--   3. The Infinite Legacy (or super admin) grants FGH Accounting visibility
--      by inserting into eco_client_firm_access.
--   4. FGH Accounting's users now see John's Hardware Store in their client list.
-- =============================================================================

CREATE TABLE IF NOT EXISTS eco_client_firm_access (
  id                    SERIAL PRIMARY KEY,
  eco_client_id         INTEGER NOT NULL REFERENCES eco_clients(id) ON DELETE CASCADE,
  firm_company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  granted_by_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  granted_at            TIMESTAMPTZ DEFAULT NOW(),
  is_active             BOOLEAN DEFAULT true,

  -- A firm can only be linked once per client
  UNIQUE(eco_client_id, firm_company_id)
);

CREATE INDEX IF NOT EXISTS idx_eco_cfa_client ON eco_client_firm_access(eco_client_id);
CREATE INDEX IF NOT EXISTS idx_eco_cfa_firm   ON eco_client_firm_access(firm_company_id);
CREATE INDEX IF NOT EXISTS idx_eco_cfa_active ON eco_client_firm_access(is_active);

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT 'eco_client_firm_access table created successfully' AS status;
