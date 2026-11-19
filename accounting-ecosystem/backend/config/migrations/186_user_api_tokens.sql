-- ============================================================================
-- Migration 186 — personal access tokens (bots / AI agents as users)
-- ============================================================================
-- Ruan, 2026-11-18: an external bot (e.g. Grok) that a practice brings in is treated
-- exactly like an employee user. The practice creates a user for it and gives it a role;
-- that user creates a personal access token and pastes it into the bot. The bot connects
-- to /mcp with the token and acts with exactly that user's rights (role, companies,
-- client delegation) — nothing more. See docs/accounting/GROK_MCP_INTEGRATION_AUDIT_2026-11-18.md.
--
-- Only a SHA-256 hash of each token is stored; the token itself is shown once on creation.
-- RLS on, no policies: only the backend (service key) reads this table.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_api_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  token_prefix  VARCHAR(16)  NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    INTEGER      REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_api_tokens_user ON user_api_tokens (user_id);

ALTER TABLE user_api_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE user_api_tokens IS
  'Personal access tokens: a user (often a bot user) authenticates to /mcp with one and acts '
  'with exactly that user''s rights. Only SHA-256 hashes are stored. Migration 186.';
