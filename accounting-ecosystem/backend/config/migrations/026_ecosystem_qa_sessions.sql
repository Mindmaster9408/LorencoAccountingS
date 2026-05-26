-- Migration 026: Ecosystem QA Sessions
-- Internal smoke-testing session management for the Lorenco Ecosystem QA Hub.
-- Super-admins create time-limited, scoped access sessions for testers.
-- No client business data is stored here — only session metadata and scope.

CREATE TABLE IF NOT EXISTS ecosystem_qa_sessions (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by_user_id    integer     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    qa_user_email         text        NOT NULL,
    access_mode           text        NOT NULL DEFAULT 'VIEW_ONLY',
    allowed_apps          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    allowed_company_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    instructions          text,
    status                text        NOT NULL DEFAULT 'active',
    expires_at            timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    revoked_at            timestamptz,
    revoked_by_user_id    integer     REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT qa_sessions_access_mode_chk
        CHECK (access_mode IN ('VIEW_ONLY', 'TEST_ASSISTED', 'SANDBOX_WRITE')),
    CONSTRAINT qa_sessions_status_chk
        CHECK (status IN ('active', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_qa_sessions_status
    ON ecosystem_qa_sessions(status);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_qa_user_email
    ON ecosystem_qa_sessions(qa_user_email);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_expires_at
    ON ecosystem_qa_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_created_by
    ON ecosystem_qa_sessions(created_by_user_id);

COMMENT ON TABLE ecosystem_qa_sessions IS
    'Internal QA Hub: time-limited, scoped tester access sessions. No business data stored.';
COMMENT ON COLUMN ecosystem_qa_sessions.allowed_apps IS
    'Array of app keys the tester may access, e.g. ["accounting","paytime","pos"]';
COMMENT ON COLUMN ecosystem_qa_sessions.allowed_company_ids IS
    'Array of company IDs the tester may view, e.g. [1,2]';
COMMENT ON COLUMN ecosystem_qa_sessions.access_mode IS
    'VIEW_ONLY: read-only navigation. TEST_ASSISTED: guided checklist. SANDBOX_WRITE: future (not Phase 1).';
