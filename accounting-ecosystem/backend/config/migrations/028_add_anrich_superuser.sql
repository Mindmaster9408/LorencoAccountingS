-- =============================================================================
-- Migration 028: Add Anrich van Stryp as Super User
-- =============================================================================
-- Creates anrichvstryp@lorencoeco.com as a super admin under The Infinite Legacy.
-- Access: all apps (POS, Payroll, Accounting, Sean). No coaching access.
-- Run this once in the Supabase SQL Editor.
-- =============================================================================

-- Requires pgcrypto for bcrypt hashing (enabled on all Supabase projects by default)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Steps 1 & 2: Upsert user + link to The Infinite Legacy ───────────────────
DO $$
DECLARE
    v_user_id    INTEGER;
    v_company_id INTEGER;
BEGIN
    -- Resolve The Infinite Legacy company
    SELECT id INTO v_company_id
    FROM companies
    WHERE company_name = 'The Infinite Legacy'
    LIMIT 1;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'The Infinite Legacy company not found';
    END IF;

    -- Check if user already exists
    SELECT id INTO v_user_id
    FROM users
    WHERE email = 'anrichvstryp@lorencoeco.com'
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
        -- User exists: update their flags
        UPDATE users
        SET full_name           = 'Anrich van Stryp',
            role                = 'super_admin',
            is_super_admin      = true,
            has_coaching_access = false,
            is_active           = true,
            updated_at          = NOW()
        WHERE id = v_user_id;
        RAISE NOTICE 'User updated (id=%)', v_user_id;
    ELSE
        -- User does not exist: create them
        INSERT INTO users (
            username,
            email,
            full_name,
            password_hash,
            role,
            is_super_admin,
            has_coaching_access,
            is_active
        )
        VALUES (
            'anrichvstryp@lorencoeco.com',
            'anrichvstryp@lorencoeco.com',
            'Anrich van Stryp',
            crypt('V$tryp96', gen_salt('bf', 12)),
            'super_admin',
            true,
            false,
            true
        )
        RETURNING id INTO v_user_id;
        RAISE NOTICE 'User created (id=%)', v_user_id;
    END IF;

    -- Link to The Infinite Legacy
    IF EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = v_user_id AND company_id = v_company_id
    ) THEN
        UPDATE user_company_access
        SET role       = 'super_admin',
            is_primary = true,
            is_active  = true,
            updated_at = NOW()
        WHERE user_id = v_user_id AND company_id = v_company_id;
    ELSE
        INSERT INTO user_company_access (user_id, company_id, role, is_primary, is_active)
        VALUES (v_user_id, v_company_id, 'super_admin', true, true);
    END IF;

    RAISE NOTICE 'Anrich van Stryp linked to The Infinite Legacy (user_id=%, company_id=%)',
        v_user_id, v_company_id;
END $$;

-- ── Verification ─────────────────────────────────────────────────────────────
SELECT
    u.id,
    u.email,
    u.full_name,
    u.role,
    u.is_super_admin,
    u.has_coaching_access,
    u.is_active,
    c.company_name,
    uca.role AS company_role
FROM users u
JOIN user_company_access uca ON uca.user_id = u.id
JOIN companies c ON c.id = uca.company_id
WHERE u.email = 'anrichvstryp@lorencoeco.com';
