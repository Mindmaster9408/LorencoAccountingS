-- ============================================================================
-- Migration 184: "who last used this company, and when" (admin panel)
-- ============================================================================
-- Ruan 2026-11-17: super users want to see whether clients use the program.
--
--   user_company_access.last_access_at  last time this user entered THIS
--     company: login with it selected, company switch, opening an app (SSO),
--     POS PIN. Written fire-and-forget by shared/services/loginActivity.js.
--   users.last_login_at (already exists) was only set by POS PIN logins;
--     normal logins now set it too.
--
-- One-off backfill from the existing audit trail so history shows at once:
--   SSO_LAUNCH rows carry the company → last_access_at
--   LOGIN / LOGIN_2FA_VERIFIED rows   → users.last_login_at (only if newer)
-- Idempotent (re-running only ever moves dates forward).
-- ============================================================================

ALTER TABLE user_company_access ADD COLUMN IF NOT EXISTS last_access_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_user_company_access_last_access
  ON user_company_access (company_id, last_access_at DESC) WHERE last_access_at IS NOT NULL;

UPDATE user_company_access uca
   SET last_access_at = s.last_at
  FROM (
    SELECT user_id, company_id, MAX(created_at) AS last_at
      FROM audit_log
     WHERE action_type = 'SSO_LAUNCH' AND user_id IS NOT NULL AND company_id IS NOT NULL
     GROUP BY user_id, company_id
  ) s
 WHERE uca.user_id = s.user_id AND uca.company_id = s.company_id
   AND (uca.last_access_at IS NULL OR uca.last_access_at < s.last_at);

UPDATE users u
   SET last_login_at = s.last_at
  FROM (
    SELECT user_id, MAX(created_at) AS last_at
      FROM audit_log
     WHERE action_type IN ('LOGIN', 'LOGIN_2FA_VERIFIED', '2FA_LOGIN_BACKUP_USED') AND user_id IS NOT NULL
     GROUP BY user_id
  ) s
 WHERE u.id = s.user_id
   AND (u.last_login_at IS NULL OR u.last_login_at < s.last_at);
