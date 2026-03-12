-- ============================================================================
-- Migration 010: Per-user client access control
-- Run once against the Supabase database.
--
-- Purpose:
--   Adds a user_client_access table that records which eco_clients a specific
--   user is allowed to see within a company.  This is the user-level gate that
--   sits alongside user_app_access.
--
-- Enforcement logic (see backend/shared/routes/eco-clients.js GET /):
--   1. If the user has ANY rows in user_client_access for (user_id, company_id),
--      the eco-clients list is filtered to only those eco_client_ids.
--   2. If zero rows exist for that user+company pair, ALL company clients are
--      visible (backward-compatible default: "no restriction = full access").
--
-- API:
--   PUT /api/users/:id/client-access  { clients: [id, ...] | null }
--   null / missing  = remove all restrictions (unrestricted)
--   []              = block all clients
--   [1, 2, 3]       = replace grants with exactly these eco_client_ids
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_client_access (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    company_id    INTEGER NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    eco_client_id INTEGER NOT NULL REFERENCES eco_clients(id) ON DELETE CASCADE,
    granted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, company_id, eco_client_id)
);

-- Fast lookup for the eco-clients filter
CREATE INDEX IF NOT EXISTS idx_user_client_access_lookup
    ON user_client_access (user_id, company_id);

COMMENT ON TABLE user_client_access IS
    'Per-user, per-company eco_client access grants. '
    'Absence of rows for a (user, company) pair means unrestricted access to all company clients.';
