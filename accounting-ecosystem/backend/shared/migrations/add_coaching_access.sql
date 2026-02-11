-- Migration: Add coaching access control
-- Created: 2026-02-11
-- Description: Adds has_coaching_access field to users table and sets up 4 super admins

-- Add coaching access flag to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_coaching_access BOOLEAN DEFAULT false;

-- Set the 4 super admins
UPDATE users SET is_super_admin = true WHERE email IN (
  'ruanvlog@lorenco.co.za',
  'antonjvr@lorenco.co.za',
  'user3@lorenco.co.za',
  'user4@lorenco.co.za'
);

-- Only ruan gets coaching access
UPDATE users SET has_coaching_access = true WHERE email = 'ruanvlog@lorenco.co.za';

-- Ensure other super admins don't have coaching access
UPDATE users SET has_coaching_access = false WHERE email IN (
  'antonjvr@lorenco.co.za',
  'user3@lorenco.co.za',
  'user4@lorenco.co.za'
);

-- Create index for faster coaching access checks
CREATE INDEX IF NOT EXISTS idx_users_has_coaching_access ON users(has_coaching_access) WHERE has_coaching_access = true;

-- Log the migration
INSERT INTO migrations (name, executed_at)
VALUES ('add_coaching_access', NOW())
ON CONFLICT (name) DO NOTHING;
