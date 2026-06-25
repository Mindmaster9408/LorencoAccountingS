-- ============================================================================
-- Migration 090 — password_reset_tokens
-- ============================================================================
-- Secure, time-limited, single-use tokens for the password reset flow.
-- Replaces the unsafe direct-email-only reset endpoint.
--
-- Token lifecycle:
--   1. POST /forgot-password/request → token generated, hash stored here
--   2. Admin provides raw token to user (via server logs; email TBD)
--   3. POST /forgot-password/reset  → token matched against hash, marked used
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   VARCHAR(128) NOT NULL,           -- SHA-256 hex of the raw token
  expires_at   TIMESTAMPTZ NOT NULL,            -- 1 hour from creation
  used_at      TIMESTAMPTZ,                     -- NULL = not yet used
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  requested_ip VARCHAR(45),                     -- optional, for audit
  user_agent   TEXT                             -- optional, for audit
);

CREATE INDEX IF NOT EXISTS idx_pw_reset_user
  ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_pw_reset_expires
  ON password_reset_tokens(expires_at)
  WHERE used_at IS NULL;
