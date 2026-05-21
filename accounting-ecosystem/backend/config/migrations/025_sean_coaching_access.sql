-- =============================================================================
-- Migration 025: Sean Coaching — users.has_coaching_access column
-- =============================================================================
-- Adds the has_coaching_access flag to the users table, enabling explicit
-- per-user coaching client access control for non-super-admin accounts.
--
-- PERMISSION MODEL (requireCoachingAccess in backend/sean/coaching-routes.js):
--   1. Super admins (isSuperAdmin=true in JWT, set by login route) → always allowed
--   2. Non-admin users → must have has_coaching_access = true in this column
--
-- This migration supersedes shared/migrations/add_coaching_access.sql, which
-- was never part of the automated migration pipeline.
--
-- INITIAL DATA:
--   ruanvlog@lorenco.co.za is the designated coaching user and receives
--   has_coaching_access = true. All other existing users remain false.
--
-- SAFE TO RE-RUN: idempotent — uses IF NOT EXISTS, WHERE-guarded UPDATE.
-- Applied automatically by GitHub Actions on push to main (apply-migrations.yml).
-- Can also be run manually in Supabase SQL Editor.
-- =============================================================================

-- Step 1: Add column if it does not already exist
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS has_coaching_access BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.has_coaching_access IS
    'Grants coaching client read access to non-super-admin users. '
    'Super admins bypass this check (isSuperAdmin flag in JWT). '
    'Set by migration 025. Only update via controlled migration.';

-- Step 2: Grant coaching access to the designated coaching user.
-- WHERE guard: only touches rows where the value would actually change.
UPDATE users
SET    has_coaching_access = true
WHERE  email               = 'ruanvlog@lorenco.co.za'
  AND  has_coaching_access = false;

-- Step 3: Index — requireCoachingAccess queries this column on every coaching request.
-- Partial index covers only the authorised-user rows (typically 1 row).
CREATE INDEX IF NOT EXISTS idx_users_has_coaching_access
    ON users (has_coaching_access)
    WHERE has_coaching_access = true;

-- Step 4: Tell PostgREST to reload its schema cache so the new column is visible
-- via the REST API immediately without a server restart.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verification query — run after migration to confirm state
-- =============================================================================
SELECT
    id,
    email,
    username,
    is_super_admin,
    has_coaching_access,
    is_active
FROM users
WHERE is_super_admin = true
   OR has_coaching_access = true
ORDER BY is_super_admin DESC, has_coaching_access DESC, email;
