-- =============================================================================
-- Migration 027: 2FA Foundation (DORMANT — NOT ENFORCED)
-- =============================================================================
-- Adds the database infrastructure for Google Authenticator-style TOTP 2FA
-- to the Lorenco Ecosystem. This migration is DORMANT — no login behaviour
-- changes. The feature flag TWO_FACTOR_AUTH is seeded as disabled.
--
-- 2FA will only be enforced when:
--   1. The TWO_FACTOR_AUTH feature flag is set to active + rollout_level >= superuser
--   2. The server environment variable TWO_FACTOR_AUTH_ENABLED=true is set
--   3. A user has completed the setup flow (two_factor_enabled = true, confirmed_at set)
--
-- SUPPORTED AUTHENTICATORS (no Google Cloud required — pure TOTP/RFC 6238):
--   Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden
--
-- SAFE TO RE-RUN: All statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- No existing data is modified. No existing columns are renamed or removed.
-- =============================================================================

-- ── A. Add 2FA columns to users table ────────────────────────────────────────
-- All columns are nullable or have safe defaults so existing rows are unaffected.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_enabled          BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_secret_encrypted TEXT        NULL,
  ADD COLUMN IF NOT EXISTS two_factor_confirmed_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS two_factor_backup_codes_hash TEXT[]     NULL,
  ADD COLUMN IF NOT EXISTS two_factor_last_verified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS two_factor_recovery_used_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN users.two_factor_enabled IS
  'Whether this user has completed 2FA setup. False by default for all users. '
  'Only becomes true after setup/confirm flow is completed AND feature flag allows it.';

COMMENT ON COLUMN users.two_factor_secret_encrypted IS
  'AES-256-GCM encrypted TOTP secret (otplib). '
  'Never exposed via API. Encrypted server-side using TOTP_ENCRYPTION_KEY env var.';

COMMENT ON COLUMN users.two_factor_confirmed_at IS
  'Timestamp when the user successfully verified their first TOTP code during setup. '
  'Null = setup not completed.';

COMMENT ON COLUMN users.two_factor_backup_codes_hash IS
  'Array of bcrypt-hashed one-time backup codes. Plain codes shown once after setup. '
  'Never expose hashes via any API.';

COMMENT ON COLUMN users.two_factor_last_verified_at IS
  'Timestamp of last successful TOTP challenge verification at login.';

COMMENT ON COLUMN users.two_factor_recovery_used_at IS
  'Timestamp of last backup code use. Used to detect suspicious recovery patterns.';

-- ── B. Partial index — only index users who have enabled 2FA ─────────────────
-- Keeps the index tiny since most users will have two_factor_enabled = false.

CREATE INDEX IF NOT EXISTS idx_users_2fa_enabled
  ON users (two_factor_enabled)
  WHERE two_factor_enabled = true;

-- ── C. user_security_events — audit trail for security-sensitive actions ─────
-- Forensic log of login challenges, setup events, failures, and recoveries.
-- Separate from audit_log to avoid mixing security events with data mutations.

CREATE TABLE IF NOT EXISTS user_security_events (
  id          UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- event_type values (extensible — add new values as needed):
  --   2fa_setup_started      — user initiated setup flow
  --   2fa_setup_confirmed    — user verified first code, 2FA activated
  --   2fa_setup_failed       — setup confirm code was wrong
  --   2fa_verify_success     — login challenge passed
  --   2fa_verify_failed      — login challenge failed (wrong code)
  --   2fa_backup_used        — backup code used for login
  --   2fa_disabled           — user or admin disabled 2FA
  event_type  TEXT         NOT NULL,

  ip_address  TEXT         NULL,
  user_agent  TEXT         NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  metadata    JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_user_security_events_user_id
  ON user_security_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_security_events_type
  ON user_security_events (event_type, created_at DESC);

COMMENT ON TABLE user_security_events IS
  'Forensic audit trail for 2FA and other security-sensitive user events. '
  'Records setup, verification, failure, and recovery actions. Append-only.';

-- ── D. Seed 2FA feature flag (disabled by default) ───────────────────────────
-- Only runs if the feature_flags table exists (migration 008).
-- If 008 has not been applied yet, this block is skipped safely — the flag
-- can be seeded by re-running this migration after 008 is applied.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'feature_flags'
  ) THEN
    INSERT INTO feature_flags (
      flag_key,
      display_name,
      description,
      app,
      is_active,
      rollout_level,
      allowed_company_ids
    )
    VALUES (
      'TWO_FACTOR_AUTH',
      'Two-Factor Authentication (TOTP)',
      'Google Authenticator-style TOTP 2FA for ecosystem login. '
      'Supports Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden. '
      'Activation plan: superuser first → admin → practice_manager → all. '
      'DO NOT activate without completing user communication and support preparation.',
      'global',
      false,
      'disabled',
      '{}'
    )
    ON CONFLICT (flag_key) DO NOTHING;

    RAISE NOTICE 'TWO_FACTOR_AUTH feature flag seeded (or already existed).';
  ELSE
    RAISE NOTICE 'feature_flags table not found — skipping flag seed. Run migration 008 first, then re-run this migration to seed the flag.';
  END IF;
END $$;

-- ── E. PostgREST schema reload ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verification query — run after migration to confirm state
-- =============================================================================
-- SELECT id, email, two_factor_enabled, two_factor_confirmed_at
-- FROM users
-- WHERE two_factor_enabled = true
-- ORDER BY two_factor_confirmed_at DESC;
--
-- SELECT flag_key, is_active, rollout_level FROM feature_flags WHERE flag_key = 'TWO_FACTOR_AUTH';
-- =============================================================================
