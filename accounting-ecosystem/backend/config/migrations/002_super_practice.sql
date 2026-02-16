-- ============================================================================
-- 002_super_practice.sql
-- Create the "Lorenco Accounting Services" super practice and add
-- Ruan, Anton and MJ as the only super-admin users. Revoke other
-- super-admin flags so only these users remain super admins.
-- NOTE: Uses Postgres pgcrypto `crypt()` + `gen_salt('bf', 12)` to create
-- bcrypt password hashes on the server. Update passwords after deployment.
-- ============================================================================

BEGIN;

-- 1) Create the super practice company if it doesn't exist
INSERT INTO companies (company_name, trading_name, is_active, modules_enabled, subscription_status)
SELECT 'Lorenco Accounting Services', 'Lorenco Accounting Services', true, ARRAY['pos','payroll','accounting','sean'], 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM companies WHERE company_name = 'Lorenco Accounting Services'
);

-- 2) Get the company id and insert/update super users
WITH the_company AS (
  SELECT id FROM companies WHERE company_name = 'Lorenco Accounting Services' LIMIT 1
),
ins_users AS (
  INSERT INTO users (username, email, password_hash, full_name, is_active, is_super_admin)
  VALUES
    ('ruanvlog', 'ruanvlog@lorenco.co.za', crypt('ChangeMe!2026', gen_salt('bf', 12)), 'Ruan Vlog', true, true),
    ('antonjvr', 'antonjvr@lorenco.co.za', crypt('ChangeMe!2026', gen_salt('bf', 12)), 'Anton JVR', true, true),
    ('mj', 'mj@lorenco.co.za', crypt('ChangeMe!2026', gen_salt('bf', 12)), 'MJ', true, true)
  ON CONFLICT (email) DO UPDATE
    SET is_super_admin = EXCLUDED.is_super_admin,
        full_name = COALESCE(EXCLUDED.full_name, users.full_name)
  RETURNING id, email
)

-- 3) Link those users to the super practice as `super_admin` in user_company_access
INSERT INTO user_company_access (user_id, company_id, role, is_primary, is_active)
SELECT u.id, c.id,
       'super_admin',
       CASE WHEN u.email = 'ruanvlog@lorenco.co.za' THEN true ELSE false END,
       true
FROM ins_users u CROSS JOIN the_company c
ON CONFLICT (user_id, company_id) DO UPDATE
  SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;

-- 4) Revoke super_admin flag from any other users (explicitly remove Gerhard if present)
UPDATE users
SET is_super_admin = false
WHERE email NOT IN ('ruanvlog@lorenco.co.za','antonjvr@lorenco.co.za','mj@lorenco.co.za')
  AND is_super_admin = true;

-- 5) Ensure the super practice has the full set of ecosystem modules (except coaching)
UPDATE companies
SET modules_enabled = (
  SELECT ARRAY(SELECT DISTINCT UNNEST(COALESCE(modules_enabled, ARRAY[]::text[]) || ARRAY['pos','payroll','accounting','sean']))
)
WHERE company_name = 'Lorenco Accounting Services';

COMMIT;
