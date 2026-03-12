-- ============================================================================
-- Migration 009: Per-user app access control
-- Run once against the Supabase database.
--
-- Purpose:
--   Adds a user_app_access table that records which apps a specific user is
--   allowed to access within a company.  This is the user-level gate that sits
--   INSIDE the company-level modules_enabled gate.
--
-- Enforcement logic (see middleware/module-check.js):
--   1. Server must have the module enabled (ENV flag).
--   2. Company must have the app in modules_enabled[].
--   3. IF the user has ANY rows in user_app_access for (user_id, company_id),
--      the requested app_key must also appear in those rows.
--   4. If zero rows exist for that user+company pair, all company-enabled apps
--      are allowed (backward-compatible default: "no restriction = full access").
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_app_access (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_key     VARCHAR(50) NOT NULL
                    CHECK (app_key IN ('pos', 'payroll', 'accounting', 'sean', 'coaching')),
    granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, company_id, app_key)
);

-- Fast lookup for the middleware check
CREATE INDEX IF NOT EXISTS idx_user_app_access_lookup
    ON user_app_access (user_id, company_id);

COMMENT ON TABLE user_app_access IS
    'Per-user, per-company app access grants. '
    'Absence of rows for a (user, company) pair means unrestricted access to all company-enabled apps.';
