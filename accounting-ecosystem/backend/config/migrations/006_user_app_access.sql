-- =============================================================================
-- Migration 006: user_company_access — per-app access control
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- Adds apps_access column so each user can be restricted to specific apps
-- within a company (e.g. only POS, or only Payroll + Accounting).
-- NULL means unrestricted — the user can access all enabled apps.
-- =============================================================================

-- ─── 1. Add apps_access column ────────────────────────────────────────────────
ALTER TABLE user_company_access
  ADD COLUMN IF NOT EXISTS apps_access TEXT[] DEFAULT NULL;

COMMENT ON COLUMN user_company_access.apps_access IS
  'NULL = access to all enabled apps. Non-null restricts user to listed apps only (e.g. ARRAY[''pos'',''payroll'']).';

-- ─── 2. Verification ──────────────────────────────────────────────────────────
SELECT
  u.email,
  u.full_name,
  c.company_name,
  uca.role,
  uca.apps_access
FROM user_company_access uca
JOIN users    u ON u.id  = uca.user_id
JOIN companies c ON c.id = uca.company_id
ORDER BY c.company_name, u.email;
