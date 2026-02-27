-- =============================================================================
-- Migration 004: The Infinite Legacy — Super Company Setup
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- Sets up "The Infinite Legacy" as the master super company and ensures
-- Ruan, Anton and MJ are linked as super admins with full module access.
-- =============================================================================

-- ─── Step 1: Rename existing super company to "The Infinite Legacy" ──────────
-- Update the first/primary company (usually "Default Company" or "Lorenco Accounting Services")
-- to be "The Infinite Legacy" with all modules enabled.

UPDATE companies
SET
  company_name        = 'The Infinite Legacy',
  trading_name        = 'The Infinite Legacy',
  modules_enabled     = ARRAY['pos','payroll','accounting','sean'],
  is_active           = true,
  subscription_status = 'active',
  updated_at          = NOW()
WHERE id = (
  SELECT id FROM companies ORDER BY id ASC LIMIT 1
);

-- ─── Step 2: Insert if no companies exist yet ─────────────────────────────────
INSERT INTO companies (company_name, trading_name, modules_enabled, is_active, subscription_status)
SELECT 'The Infinite Legacy', 'The Infinite Legacy',
       ARRAY['pos','payroll','accounting','sean'], true, 'active'
WHERE NOT EXISTS (SELECT 1 FROM companies LIMIT 1);

-- ─── Step 3: Ensure super admin users exist ───────────────────────────────────
-- These match the seed in migration 002. Passwords are hashed with bcrypt (cost 12).
-- Password for all three: ChangeMe!2026
-- NOTE: If users already exist with different passwords, this will not change them.

INSERT INTO users (username, email, full_name, password_hash, role, is_super_admin, is_active)
VALUES
  ('ruanvlog@lorenco.co.za',  'ruanvlog@lorenco.co.za',  'Ruan',  '$2b$12$placeholder_ruan',  'super_admin', true, true),
  ('antonjvr@lorenco.co.za',  'antonjvr@lorenco.co.za',  'Anton', '$2b$12$placeholder_anton', 'super_admin', true, true),
  ('mj@lorenco.co.za',        'mj@lorenco.co.za',        'MJ',    '$2b$12$placeholder_mj',    'super_admin', true, true)
ON CONFLICT (email) DO UPDATE
  SET role          = 'super_admin',
      is_super_admin = true,
      is_active      = true,
      updated_at     = NOW();

-- ─── Step 4: Revoke super_admin from everyone else ────────────────────────────
UPDATE users
SET is_super_admin = false,
    updated_at     = NOW()
WHERE email NOT IN ('ruanvlog@lorenco.co.za', 'antonjvr@lorenco.co.za', 'mj@lorenco.co.za')
  AND is_super_admin = true;

-- ─── Step 5: Link all 3 super admins to The Infinite Legacy ──────────────────
-- Get the ID of The Infinite Legacy company
DO $$
DECLARE
  v_company_id INTEGER;
  v_user       RECORD;
BEGIN
  SELECT id INTO v_company_id
  FROM companies
  WHERE company_name = 'The Infinite Legacy'
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'The Infinite Legacy company not found after insert/update';
  END IF;

  FOR v_user IN
    SELECT id FROM users
    WHERE email IN ('ruanvlog@lorenco.co.za', 'antonjvr@lorenco.co.za', 'mj@lorenco.co.za')
  LOOP
    INSERT INTO user_company_access (user_id, company_id, role, is_primary, is_active)
    VALUES (v_user.id, v_company_id, 'super_admin', true, true)
    ON CONFLICT (user_id, company_id) DO UPDATE
      SET role      = 'super_admin',
          is_active = true,
          updated_at = NOW();
  END LOOP;

  RAISE NOTICE 'The Infinite Legacy setup complete (company_id = %)', v_company_id;
END $$;

-- ─── Step 6: Make sure all modules are enabled on The Infinite Legacy ─────────
UPDATE companies
SET modules_enabled = ARRAY['pos','payroll','accounting','sean'],
    updated_at      = NOW()
WHERE company_name = 'The Infinite Legacy';

-- ─── Verification query ───────────────────────────────────────────────────────
SELECT
  c.id,
  c.company_name,
  c.modules_enabled,
  u.email,
  u.role,
  u.is_super_admin,
  uca.role AS company_role
FROM companies c
JOIN user_company_access uca ON uca.company_id = c.id
JOIN users u ON u.id = uca.user_id
WHERE c.company_name = 'The Infinite Legacy'
ORDER BY u.email;
