/**
 * ============================================================================
 * Authentication Routes - Unified Ecosystem
 * ============================================================================
 * Login, register, company selection, token refresh.
 * Adapted from Checkout Charlie auth with Supabase backend.
 * ============================================================================
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase } = require('../../config/database');
const { authenticateToken, JWT_SECRET } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const { getRolePermissions } = require('../../config/permissions');

const router = express.Router();

/**
 * POST /api/auth/login
 * Authenticate user, return token + accessible companies
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    const loginId = username || email;

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    // Find user by username or email
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .or(`username.eq.${loginId},email.eq.${loginId}`)
      .eq('is_active', true)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Super admin path — BYPASSED: super admins now use normal app flow
    // Code preserved for future admin dashboard use
    /*
    if (user.is_super_admin) {
      const token = jwt.sign({
        userId: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        isSuperAdmin: true,
        role: 'super_admin',
      }, JWT_SECRET, { expiresIn: '24h' });

      // Audit login
      await auditFromReq(req, 'LOGIN', 'user', user.id, {
        module: 'shared',
        metadata: { isSuperAdmin: true }
      });

      return res.json({
        success: true,
        isSuperAdmin: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          email: user.email
        }
      });
    }
    */

    // Get user's accessible companies
    // SECURITY FIX: All users — including super admins — use user_company_access.
    // This prevents auto-created eco_client sub-companies from appearing in
    // the login response / company selector for any role.
    const isSuperAdmin = !!user.is_super_admin;

    const { data: accessRows, error: compError } = await supabase
      .from('user_company_access')
      .select(`
        company_id,
        role,
        is_primary,
        apps_access,
        companies:company_id (id, company_name, trading_name, modules_enabled, practice_code, account_holder_type)
      `)
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (compError) {
      console.error('Error fetching companies:', compError.message);
    }

    const companyList = (accessRows || [])
      .filter(c => c.companies)
      .map(c => ({
        id: c.companies.id,
        company_name: c.companies.company_name,
        trading_name: c.companies.trading_name,
        modules_enabled: c.companies.modules_enabled,
        practice_code: c.companies.practice_code || null,
        account_holder_type: c.companies.account_holder_type || null,
        role: isSuperAdmin ? 'super_admin' : c.role,
        is_primary: c.is_primary,
        apps_access: c.apps_access || null,
      }))
      .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

    // Build token payload — always auto-select first company so role is never null
    const tokenPayload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      isSuperAdmin: isSuperAdmin,
      hasCoachingAccess: !!(user.has_coaching_access),
      companyId: null,
      role: isSuperAdmin ? 'super_admin' : null,
    };

    let selectedCompany = null;
    if (companyList.length >= 1) {
      // Super admins always land on "The Infinite Legacy" as their home company
      if (isSuperAdmin) {
        selectedCompany = companyList.find(c =>
          c.company_name === 'The Infinite Legacy' || c.trading_name === 'The Infinite Legacy'
        ) || companyList[0];
      } else {
        // Regular users: prefer primary company, otherwise first
        selectedCompany = companyList.find(c => c.is_primary) || companyList[0];
      }
      tokenPayload.companyId = selectedCompany.id;
      tokenPayload.role = selectedCompany.role;
    }

    // ── 2FA DORMANT GATE ────────────────────────────────────────────────────
    // This block does nothing until TWO_FACTOR_AUTH_ENABLED=true is set in env.
    // When activated, users with two_factor_enabled=true will receive a
    // 2FA_REQUIRED challenge instead of a full token, and must call
    // POST /api/auth/2fa/verify to complete login.
    //
    // DO NOT enable without: feature flag active + user comms + UI challenge screen.
    if (
      process.env.TWO_FACTOR_AUTH_ENABLED === 'true' &&
      user.two_factor_enabled === true &&
      user.two_factor_confirmed_at
    ) {
      // Placeholder: return a partial token that can only call /api/auth/2fa/verify
      // Implementation: replace this comment with the 2FA challenge flow when activating.
      // For now this branch is unreachable because TWO_FACTOR_AUTH_ENABLED is unset.
      return res.status(200).json({
        success: false,
        requires2FA: true,
        code: '2FA_REQUIRED',
        message: 'Please complete two-factor authentication to continue.',
      });
    }
    // ── END 2FA DORMANT GATE ────────────────────────────────────────────────

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });

    // Audit login
    await auditFromReq(req, 'LOGIN', 'user', user.id, {
      module: 'shared',
      metadata: { companiesAvailable: companyList.length }
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        email: user.email,
        isSuperAdmin: isSuperAdmin,
        hasCoachingAccess: !!(user.has_coaching_access),
      },
      companies: companyList,
      selectedCompany,
      requiresCompanySelection: companyList.length > 1,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

/**
 * POST /api/auth/register
 * Register new user + optionally create company
 */
router.post('/register', async (req, res) => {
  try {
    const {
      username, email, password, full_name,
      company_name, trading_name,          // legacy simple fields
      account_type, practice, business,    // rich frontend payload
      users, existing_user_id              // team members + existing user mode
    } = req.body;

    // Resolve company details from practice/business or legacy fields
    const companyName = practice?.name || business?.name || company_name;
    const companyTradingName = practice?.trading_name || business?.trading_name || trading_name || companyName;

    // The first user who creates a company is always the owner of that company.
    // They must have 'business_owner' role regardless of their account_type, so they
    // can manage users, see client management, and pass canManageRole checks.
    // 'account_type' describes the TYPE of organisation being set up — not the
    // first user's access level within it.  Staff they add later can have any role.
    const ownerRole = 'business_owner';

    let mainUser;

    if (existing_user_id) {
      // Existing user mode — look up the user
      const { data: existingUser, error: euErr } = await supabase
        .from('users')
        .select('*')
        .eq('id', existing_user_id)
        .single();
      if (euErr || !existingUser) {
        return res.status(404).json({ error: 'Existing user not found' });
      }
      mainUser = existingUser;
    } else {
      // New user mode — validate and create
      const regEmail = email;
      const regUsername = username || email;
      const regPassword = password;
      const regFullName = full_name;

      if (!regEmail || !regPassword || !regFullName) {
        return res.status(400).json({ error: 'Email, password, and full name are required' });
      }

      // Check if user exists
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .or(`username.eq.${regUsername},email.eq.${regEmail}`)
        .limit(1);

      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'Username or email already registered' });
      }

      const password_hash = await bcrypt.hash(regPassword, 12);

      const { data: newUser, error: userError } = await supabase
        .from('users')
        .insert({ username: regUsername, email: regEmail, password_hash, full_name: regFullName, is_active: true })
        .select()
        .single();

      if (userError) {
        return res.status(500).json({ error: 'Failed to create user: ' + userError.message });
      }
      mainUser = newUser;
    }

    // Create company if name provided
    let company = null;
    if (companyName) {
      // Map account_type from the registration form to the canonical DB value.
      // The signup form sends 'accountant' (Accounting Practice) or 'business' (Business Owner).
      // Canonical DB values are 'accounting_practice' and 'business_owner'.
      // Both short form ('accountant'/'business') and canonical form are accepted so that
      // both old and new clients always produce the correct classification in the database.
      const accountTypeMap = {
        accountant:          'accounting_practice',
        accounting_practice: 'accounting_practice',
        business:            'business_owner',
        business_owner:      'business_owner',
        individual:          'individual',
      };
      const holderType = accountTypeMap[account_type] || null;

      const { data: newCompany, error: compError } = await supabase
        .from('companies')
        .insert({
          company_name: companyName,
          trading_name: companyTradingName,
          is_active: true,
          modules_enabled: ['pos', 'payroll', 'accounting', 'sean'],
          subscription_status: 'active',
          account_holder_type: holderType,
        })
        .select()
        .single();

      if (compError) {
        console.error('Company creation error:', compError.message);
        return res.status(500).json({ error: 'Failed to create company: ' + compError.message });
      }

      company = newCompany;

      // Generate practice_code for accounting practices (non-fatal if column not yet migrated)
      if (holderType === 'accounting_practice') {
        try {
          const practiceCode = `PRAC-${String(company.id).padStart(4, '0')}`;
          const { error: pcErr } = await supabase
            .from('companies')
            .update({ practice_code: practiceCode })
            .eq('id', company.id);
          if (!pcErr) company.practice_code = practiceCode;
        } catch (_) {
          // Non-fatal — migration 092 backfill handles existing rows
        }
      }

      // Link main user to company as owner
      await supabase.from('user_company_access').insert({
        user_id: mainUser.id,
        company_id: company.id,
        role: ownerRole,
        is_primary: true,
        is_active: true
      });

      // ── Provision Paytime 30-day demo company (idempotent — one per practice) ──
      try {
        const { data: existingDemo } = await supabase
          .from('eco_clients')
          .select('id')
          .eq('company_id', company.id)
          .eq('name', 'Demo Company')
          .limit(1);

        if (!existingDemo || existingDemo.length === 0) {
          const demoExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

          const { data: demoCompany, error: demoCompErr } = await supabase
            .from('companies')
            .insert({
              company_name:          'Demo Company',
              trading_name:          'Demo Company',
              is_active:             true,
              is_demo:               true,
              modules_enabled:       ['payroll'],
              subscription_status:   'demo',
              subscription_expires_at: demoExpiresAt,
            })
            .select()
            .single();

          if (!demoCompErr && demoCompany) {
            // Grant the new user access to the demo company data silo
            await supabase.from('user_company_access').insert({
              user_id:    mainUser.id,
              company_id: demoCompany.id,
              role:       'business_owner',
              is_primary: false,
              is_active:  true,
            });

            // Register demo company as a Paytime client of the practice
            await supabase.from('eco_clients').insert({
              company_id:        company.id,
              name:              'Demo Company',
              apps:              ['payroll'],
              client_company_id: demoCompany.id,
              is_active:         true,
            });
          } else if (demoCompErr) {
            console.error('[register] Demo company creation error:', demoCompErr.message);
          }
        }
      } catch (demoErr) {
        console.error('[register] Demo provisioning error:', demoErr.message);
      }

      // Create team members if provided
      if (Array.isArray(users) && users.length > 0) {
        for (const member of users) {
          // Skip the main user if they appear in the users array
          if (member.email?.toLowerCase() === mainUser.email?.toLowerCase()) continue;
          if (!member.email || !member.name) continue;

          try {
            // Check if team member already exists
            const { data: existingMember } = await supabase
              .from('users')
              .select('id')
              .eq('email', member.email.toLowerCase())
              .limit(1);

            let memberId;
            if (existingMember && existingMember.length > 0) {
              memberId = existingMember[0].id;
            } else {
              // Create the team member with a temp password they can change
              const memberHash = await bcrypt.hash(member.password || 'Welcome@2026', 12);
              const { data: newMember, error: memErr } = await supabase
                .from('users')
                .insert({
                  username: member.email.toLowerCase(),
                  email: member.email.toLowerCase(),
                  password_hash: memberHash,
                  full_name: member.name,
                  is_active: true
                })
                .select()
                .single();
              if (memErr) {
                console.error(`Failed to create team member ${member.email}:`, memErr.message);
                continue;
              }
              memberId = newMember.id;
            }

            // Link team member to company
            await supabase.from('user_company_access').insert({
              user_id: memberId,
              company_id: company.id,
              role: member.role || 'employee',
              is_primary: false,
              is_active: true
            });
          } catch (memError) {
            console.error(`Error processing team member ${member.email}:`, memError);
          }
        }
      }
    }

    const token = jwt.sign({
      userId: mainUser.id,
      username: mainUser.username,
      email: mainUser.email,
      fullName: mainUser.full_name,
      companyId: company?.id || null,
      role: company ? ownerRole : null,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: mainUser.id,
        username: mainUser.username,
        email: mainUser.email,
        fullName: mainUser.full_name,
      },
      company: company ? {
        id: company.id,
        company_name: company.company_name,
        trading_name: company.trading_name,
      } : null,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

/**
 * POST /api/auth/select-company
 * After login, select which company to work with
 * BUG FIX #2: Returns new token with company_id embedded
 */
router.post('/select-company', authenticateToken, async (req, res) => {
  try {
    const { companyId } = req.body;
    const userId = req.user.userId;

    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    const parsedCompanyId = parseInt(companyId, 10);

    // Trust isSuperAdmin from the JWT first — avoids an extra DB round-trip
    // and prevents super admins from being locked out when the DB is slow.
    const isSuperAdmin = req.user.isSuperAdmin || false;
    let role = null;

    // Fetch company details (needed by POS and other frontends)
    const { data: company, error: compErr } = await supabase
      .from('companies')
      .select('id, company_name, trading_name, modules_enabled, subscription_status, practice_code, account_holder_type')
      .eq('id', parsedCompanyId)
      .eq('is_active', true)
      .single();

    if (compErr || !company) {
      return res.status(404).json({ error: 'Company not found or inactive' });
    }

    let appsAccess = null;
    if (isSuperAdmin) {
      role = 'super_admin';
    } else {
      // Regular users — check direct user_company_access first
      const { data: access } = await supabase
        .from('user_company_access')
        .select('role, apps_access')
        .eq('user_id', userId)
        .eq('company_id', parsedCompanyId)
        .eq('is_active', true)
        .maybeSingle();

      if (access) {
        role = access.role;
        appsAccess = access.apps_access || null;
      } else {
        // No direct row — check if the target company is a client company managed
        // by a practice the user belongs to.  This mirrors the sso-launch logic so
        // accountants / business owners can select a client company from inside
        // Paytime's company-selection page without needing an explicit row.
        const { data: userPractices } = await supabase
          .from('user_company_access')
          .select('company_id')
          .eq('user_id', userId)
          .eq('is_active', true);
        const practiceIds = (userPractices || []).map(r => r.company_id);

        const { data: ecoClient } = practiceIds.length > 0
          ? await supabase
              .from('eco_clients')
              .select('id, company_id')
              .eq('client_company_id', parsedCompanyId)
              .in('company_id', practiceIds)
              .eq('is_active', true)
              .maybeSingle()
          : { data: null };

        if (!ecoClient) {
          return res.status(403).json({ error: 'You do not have access to this company' });
        }

        // Use the user's role from their managing practice
        const { data: practiceAccess } = await supabase
          .from('user_company_access')
          .select('role')
          .eq('user_id', userId)
          .eq('company_id', ecoClient.company_id)
          .eq('is_active', true)
          .maybeSingle();

        const ALLOWED_CROSS_ROLES = ['business_owner', 'practice_manager', 'administrator', 'accountant', 'super_admin', 'store_manager'];
        if (!practiceAccess || !ALLOWED_CROSS_ROLES.includes(practiceAccess.role)) {
          // Delegated access path: user has a restricted role at the practice but may have
          // explicit client visibility grant from the admin.
          let delegatedAccess = false;
          if (practiceAccess) {
            const { data: clientAccessRows } = await supabase
              .from('user_client_access').select('eco_client_id')
              .eq('user_id', userId)
              .eq('company_id', ecoClient.company_id);
            const rows = clientAccessRows || [];
            if (rows.length === 0) {
              // Zero rows = unrestricted client visibility
              delegatedAccess = true;
            } else {
              delegatedAccess = rows.some(r => r.eco_client_id === ecoClient.id);
            }
          }
          if (!delegatedAccess) {
            return res.status(403).json({ error: 'You do not have access to this company' });
          }
        }
        role = practiceAccess.role;
      }
    }

    // Fetch has_coaching_access from the users table — always from DB so the value is
    // accurate regardless of what the incoming JWT claims (handles old sessions).
    const { data: userRow } = await supabase
      .from('users')
      .select('has_coaching_access')
      .eq('id', req.user.userId)
      .single();
    const hasCoachingAccess = !!(userRow?.has_coaching_access);

    // Issue new token with company context
    const token = jwt.sign({
      userId: req.user.userId,
      username: req.user.username,
      email: req.user.email,
      fullName: req.user.fullName,
      companyId: parsedCompanyId,
      role: role,
      isSuperAdmin: isSuperAdmin,
      hasCoachingAccess,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success: true,
      token,
      companyId: parsedCompanyId,
      role,
      apps_access: appsAccess,
      hasCoachingAccess,
      company: {
        id: company.id,
        company_name: company.company_name,
        trading_name: company.trading_name,
        modules_enabled: company.modules_enabled,
        subscription_status: company.subscription_status,
        practice_code: company.practice_code || null,
        account_holder_type: company.account_holder_type || null,
      }
    });
  } catch (err) {
    console.error('Select company error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info from token
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, full_name, is_super_admin, has_coaching_access, created_at')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user,
      hasCoachingAccess: !!(user.has_coaching_access),
      companyId: req.companyId,
      role: req.user.role,
      permissions: req.user.role ? getRolePermissions(req.user.role) : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/auth/companies
 * List companies accessible to current user
 */
router.get('/companies', authenticateToken, async (req, res) => {
  try {
    const isSuperAdmin = req.user.isSuperAdmin;

    // SECURITY FIX: All users — including super admins — receive only the companies
    // they are explicitly linked to via user_company_access.  This prevents
    // auto-created eco_client sub-companies (orphan rows with no user_company_access)
    // from leaking into the company selector for any user role.
    // Super admins who need full company access should use the admin panel (/admin).
    let list;

    const { data: accessRows, error } = await supabase
      .from('user_company_access')
      .select(`
        company_id, role, is_primary,
        companies:company_id (id, company_name, trading_name, modules_enabled, practice_code, account_holder_type)
      `)
      .eq('user_id', req.user.userId)
      .eq('is_active', true);

    if (error) {
      return res.status(500).json({ error: 'Database error' });
    }

    const rawList = (accessRows || [])
      .filter(r => r.companies)
      .map(r => ({
        id: r.companies.id,
        company_name: r.companies.company_name,
        trading_name: r.companies.trading_name,
        modules_enabled: r.companies.modules_enabled,
        practice_code: r.companies.practice_code || null,
        account_holder_type: r.companies.account_holder_type || null,
        // Super admins always surface as 'super_admin' in the role field for UI rendering
        role: isSuperAdmin ? 'super_admin' : r.role,
        is_primary: r.is_primary,
      }));

    // Annotate each company with company_type so the frontend can detect owner-only logins.
    //   'practice'   — company appears as eco_clients.company_id (managing accounting firm)
    //   'client'     — company appears as eco_clients.client_company_id (client's isolated company)
    //   'standalone' — not found in eco_clients
    const allCompanyIds = rawList.map(c => c.id);
    let practiceIds = new Set();
    let clientIds = new Set();
    if (allCompanyIds.length > 0) {
      const [practiceRes, clientRes] = await Promise.all([
        supabase.from('eco_clients').select('company_id').in('company_id', allCompanyIds),
        supabase.from('eco_clients').select('client_company_id').in('client_company_id', allCompanyIds),
      ]);
      for (const r of (practiceRes.data || [])) practiceIds.add(r.company_id);
      for (const r of (clientRes.data || [])) clientIds.add(r.client_company_id);
    }

    list = rawList.map(c => ({
      ...c,
      company_type: practiceIds.has(c.id)
        ? 'practice'
        : clientIds.has(c.id)
          ? 'client'
          : 'standalone',
    }));

    res.json({ companies: list });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/auth/forgot-password/request
 * Step 1 — generate a secure, time-limited, single-use reset token.
 *
 * Always returns the same generic response regardless of whether the email
 * exists — prevents user enumeration attacks.
 *
 * The raw token is written to the server console so an administrator can
 * retrieve it from server logs and provide it to the requesting user.
 * WHEN AN EMAIL SERVICE IS AVAILABLE: replace the console.log block with
 * a call to your email provider (SendGrid / Resend / AWS SES).
 */
router.post('/forgot-password/request', async (req, res) => {
  const { email } = req.body;

  // Generic response returned in ALL paths — success or failure
  const GENERIC_OK = {
    success: true,
    message: 'If an account exists for that email address, a one-time reset code has been generated. Please contact your administrator to obtain the code.'
  };

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, full_name')
      .or(`email.eq.${email.toLowerCase()},username.eq.${email.toLowerCase()}`)
      .eq('is_active', true)
      .maybeSingle();

    if (!user) {
      // No account — return same generic response, do not reveal non-existence
      return res.json(GENERIC_OK);
    }

    // Invalidate any existing unused tokens for this user before issuing a new one
    await supabase
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('used_at', null);

    // Generate cryptographically secure token (64-char hex = 256 bits of entropy)
    const rawToken   = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    const requestedIp = String(req.ip || req.headers['x-forwarded-for'] || '').slice(0, 45) || null;
    const userAgent   = String(req.headers['user-agent'] || '').slice(0, 500) || null;

    await supabase.from('password_reset_tokens').insert({
      user_id:      user.id,
      token_hash:   tokenHash,
      expires_at:   expiresAt.toISOString(),
      requested_ip: requestedIp,
      user_agent:   userAgent
    });

    // ── EMAIL PLACEHOLDER ─────────────────────────────────────────────────────
    // When an email service is configured, replace this block with:
    //   await emailService.sendPasswordReset(user.email, rawToken, expiresAt);
    // Until then, the raw token is logged server-side for administrator retrieval.
    console.log('\n🔑 PASSWORD RESET REQUEST');
    console.log(`   Email  : ${user.email}`);
    console.log(`   Code   : ${rawToken}`);
    console.log(`   Expiry : ${expiresAt.toISOString()} (1 hour)`);
    console.log('   Action : Provide this code to the user. It is single-use.\n');
    // ─────────────────────────────────────────────────────────────────────────

    await supabase.from('audit_log').insert({
      action:      'PASSWORD_RESET_REQUESTED',
      entity_type: 'user',
      entity_id:   String(user.id),
      user_id:     user.id,
      metadata:    { email: user.email, requested_ip: requestedIp, expires_at: expiresAt.toISOString() }
    }).catch(() => {});

    return res.json(GENERIC_OK);
  } catch (err) {
    console.error('Forgot password request error:', err);
    return res.json(GENERIC_OK); // Always generic — never leak server errors
  }
});

/**
 * POST /api/auth/forgot-password/check
 * DEPRECATED — this endpoint performed an unauthenticated password reset.
 * Returns 410 Gone. Clients must use /forgot-password/request + /forgot-password/reset.
 */
router.post('/forgot-password/check', (_req, res) => {
  return res.status(410).json({
    error: 'This endpoint is deprecated. Use POST /api/auth/forgot-password/request to begin a password reset.',
    code:  'ENDPOINT_DEPRECATED'
  });
});

/**
 * POST /api/auth/forgot-password/reset
 * Final step — set a new password using a valid, unexpired, unused reset token.
 *
 * Body: { email, token, newPassword }
 *
 * Security:
 *   - `token` is the raw value; compared against SHA-256 hash in password_reset_tokens
 *   - Token must not be expired (expires_at > NOW())
 *   - Token must not have been used (used_at IS NULL)
 *   - Token is marked used before password is updated (atomic guard against races)
 *   - All failure paths return the same generic error to prevent enumeration
 */
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'email, token, and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (typeof token !== 'string' || token.trim().length < 10) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }

    // Generic failure — used for all invalid-token paths to prevent enumeration
    const FAIL = { error: 'Invalid or expired reset code. Please request a new one.' };

    // Look up active user
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .or(`email.eq.${email.toLowerCase()},username.eq.${email.toLowerCase()}`)
      .eq('is_active', true)
      .maybeSingle();

    if (!user) return res.status(400).json(FAIL);

    // Hash the provided raw token and look up in DB
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    const { data: resetRecord } = await supabase
      .from('password_reset_tokens')
      .select('id, expires_at, used_at')
      .eq('user_id',    user.id)
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!resetRecord)                                   return res.status(400).json(FAIL);
    if (resetRecord.used_at !== null)                   return res.status(400).json(FAIL);
    if (new Date(resetRecord.expires_at) < new Date())  return res.status(400).json(FAIL);

    // Mark token used BEFORE updating password — prevents race conditions
    const { error: useErr } = await supabase
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', resetRecord.id)
      .is('used_at', null); // CAS guard

    if (useErr) return res.status(500).json({ error: 'Server error' });

    // Hash new password and update user record
    const password_hash = await bcrypt.hash(newPassword, 12);
    const { error: updateErr } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', user.id);

    if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

    await supabase.from('audit_log').insert({
      action:      'PASSWORD_RESET_COMPLETED',
      entity_type: 'user',
      entity_id:   String(user.id),
      user_id:     user.id,
      metadata:    { email: user.email, method: 'token_based', token_id: resetRecord.id }
    }).catch(() => {});

    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Forgot password reset error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/auth/logout
 * Log the logout event (token invalidation is client-side)
 */
router.post('/logout', authenticateToken, async (req, res) => {
  await auditFromReq(req, 'LOGOUT', 'user', req.user.userId, { module: 'shared' });
  res.json({ success: true, message: 'Logged out' });
});

/**
 * POST /api/auth/sso-launch
 * Ecosystem SSO — generates an app-specific token so the user
 * can launch into a specific app + company without re-logging in.
 */
router.post('/sso-launch', authenticateToken, async (req, res) => {
  try {
    const { targetApp, companyId } = req.body;
    const validApps = ['pos', 'payroll', 'accounting', 'sean', 'coaching', 'inventory', 'practice'];

    if (!targetApp || !validApps.includes(targetApp)) {
      return res.status(400).json({ error: `Invalid targetApp. Must be one of: ${validApps.join(', ')}` });
    }

    // Run user fetch and company access check in parallel (both need only req.user.userId)
    const resolvedCompanyId0 = companyId ? parseInt(companyId) : null;
    const [
      { data: user, error: userError },
      { data: directAccess }
    ] = await Promise.all([
      supabase.from('users').select('*').eq('id', req.user.userId).single(),
      (resolvedCompanyId0 && req.user.role !== 'super_admin')
        ? supabase.from('user_company_access').select('role, apps_access')
            .eq('user_id', req.user.userId)
            .eq('company_id', resolvedCompanyId0)
            .eq('is_active', true)
            .maybeSingle()
        : Promise.resolve({ data: null })
    ]);

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // COACHING HARD LOCK: only the single authorised user (users.has_coaching_access = true)
    // may launch the coaching app. No super admin bypass — isSuperAdmin does NOT grant access.
    if (targetApp === 'coaching' && !user.has_coaching_access) {
      return res.status(403).json({
        error: 'Coaching access not authorised for this account',
        code: 'NO_COACHING_ACCESS',
      });
    }

    let resolvedCompanyId = resolvedCompanyId0;
    let role = req.user.role || 'admin';

    if (user.is_super_admin) {
      role = 'super_admin';
      // Resolve company: from request → from token → first active company in DB
      if (!resolvedCompanyId) resolvedCompanyId = req.companyId || null;
      if (!resolvedCompanyId) {
        const { data: firstCo } = await supabase
          .from('companies').select('id').eq('is_active', true).order('id').limit(1);
        if (firstCo && firstCo.length > 0) resolvedCompanyId = firstCo[0].id;
      }
    } else if (resolvedCompanyId) {
      const access = directAccess; // already fetched in parallel above

      if (!access) {
        // No direct company membership — check if the target company is a client company
        // managed by a practice the user belongs to.  This lets accountants / business
        // owners SSO into a client's isolated company without needing a direct
        // user_company_access row for that client company.
        //
        // SECURITY FIX: restrict the eco_clients lookup to practices the user actually
        // belongs to.  Without this filter any eco_client in the system could satisfy
        // the chain, potentially granting access to a client owned by a DIFFERENT firm.
        const { data: userPractices } = await supabase
          .from('user_company_access')
          .select('company_id')
          .eq('user_id', user.id)
          .eq('is_active', true);
        const practiceIds = (userPractices || []).map(r => r.company_id);

        const { data: ecoClient } = practiceIds.length > 0
          ? await supabase
              .from('eco_clients')
              .select('id, company_id')
              .eq('client_company_id', resolvedCompanyId)
              .in('company_id', practiceIds)   // Only eco_clients managed by THIS user's own firms
              .eq('is_active', true)
              .maybeSingle()
          : { data: null };

        if (ecoClient) {
          const { data: practiceAccess } = await supabase
            .from('user_company_access')
            .select('role')
            .eq('user_id', user.id)
            .eq('company_id', ecoClient.company_id)
            .eq('is_active', true)
            .maybeSingle();

          const ALLOWED_CROSS_ROLES = ['business_owner', 'practice_manager', 'administrator', 'accountant', 'super_admin', 'store_manager'];
          if (!practiceAccess || !ALLOWED_CROSS_ROLES.includes(practiceAccess.role)) {
            // Delegated access path: user has a restricted role (e.g. employee) at the practice
            // but may have been explicitly granted app + client access by the admin.
            // Check: user_app_access grant for targetApp at practice + client visibility.
            let delegatedAccess = false;
            if (practiceAccess && targetApp) {
              const [appGrantResult, clientRowsResult] = await Promise.all([
                supabase.from('user_app_access').select('id')
                  .eq('user_id', user.id)
                  .eq('company_id', ecoClient.company_id)
                  .eq('app_key', targetApp)
                  .maybeSingle(),
                supabase.from('user_client_access').select('eco_client_id')
                  .eq('user_id', user.id)
                  .eq('company_id', ecoClient.company_id),
              ]);
              if (appGrantResult.data) {
                const clientAccessRows = clientRowsResult.data || [];
                if (clientAccessRows.length === 0) {
                  // Zero rows = unrestricted — can access all clients
                  delegatedAccess = true;
                } else {
                  delegatedAccess = clientAccessRows.some(r => r.eco_client_id === ecoClient.id);
                }
              }
            }
            if (!delegatedAccess) {
              return res.status(403).json({ error: 'You do not have access to this company' });
            }
          }
          // Use the user's role from their managing practice
          role = practiceAccess.role;
        } else {
          return res.status(403).json({ error: 'You do not have access to this company' });
        }
      } else {
        role = access.role;
        // Check per-app access (null = all apps allowed)
        if (access.apps_access && !access.apps_access.includes(targetApp)) {
          return res.status(403).json({ error: `You do not have access to the ${targetApp} app` });
        }
      }
    } else {
      const { data: accessList } = await supabase
        .from('user_company_access')
        .select('company_id, role, apps_access')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('is_primary', { ascending: false });

      if (accessList && accessList.length > 0) {
        resolvedCompanyId = accessList[0].company_id;
        role = accessList[0].role;

        // Check per-app access
        if (accessList[0].apps_access && !accessList[0].apps_access.includes(targetApp)) {
          return res.status(403).json({ error: `You do not have access to the ${targetApp} app` });
        }
      }
    }

    // Fetch and validate the resolved company exists
    let company = null;
    if (resolvedCompanyId) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled, account_holder_type')
        .eq('id', resolvedCompanyId)
        .single();
      company = companyData;
    }
    if (!company) {
      return res.status(400).json({ error: 'No active company found. Please create or join a company first.' });
    }

    // Per-user app access gate — mirrors module-check.js Tier 3.
    // If the user has explicit app grants for this (user, company) pair,
    // the requested targetApp must be in that set.
    // Zero rows = unrestricted (backward-compatible default).
    if (!user.is_super_admin && resolvedCompanyId) {
      const { data: appRows } = await supabase
        .from('user_app_access')
        .select('app_key')
        .eq('user_id', user.id)
        .eq('company_id', resolvedCompanyId);

      if (appRows && appRows.length > 0) {
        const grantedApps = appRows.map(r => r.app_key);
        if (!grantedApps.includes(targetApp)) {
          return res.status(403).json({
            error: `You do not have access to the ${targetApp} app. Contact your administrator.`,
            module: targetApp,
          });
        }
      }
    }

    // Practice Module Gate: only accounting_practice companies with practice in modules_enabled.
    // Super admins bypass — they need access for testing and support.
    if (targetApp === 'practice' && !user.is_super_admin) {
      if (!Array.isArray(company.modules_enabled) || !company.modules_enabled.includes('practice')) {
        return res.status(403).json({
          error: 'Practice Management is not enabled for your company. Please contact your administrator.',
          code: 'PRACTICE_MODULE_NOT_ENABLED'
        });
      }
      if (company.account_holder_type !== 'accounting_practice') {
        return res.status(403).json({
          error: 'Practice Management is only available to accounting practices.',
          code: 'NOT_ACCOUNTING_PRACTICE'
        });
      }
    }

    const appToken = jwt.sign({
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      companyId: resolvedCompanyId,
      role: role,
      isSuperAdmin: user.is_super_admin || false,
      ssoSource: 'ecosystem',
      targetApp: targetApp,
    }, JWT_SECRET, { expiresIn: '8h' });

    await auditFromReq(req, 'SSO_LAUNCH', 'user', user.id, {
      module: 'shared',
      metadata: { targetApp, companyId: resolvedCompanyId },
    });

    res.json({
      success: true,
      appToken,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        email: user.email,
        isSuperAdmin: user.is_super_admin || false,
      },
      company: company ? {
        id: company.id,
        company_name: company.company_name,
        trading_name: company.trading_name,
        modules_enabled: company.modules_enabled,
        role: role,
      } : null,
      targetApp,
    });
  } catch (err) {
    console.error('SSO launch error:', err);
    res.status(500).json({ error: 'SSO launch failed' });
  }
});

// ── Company User Management ───────────────────────────────────────────────────
// These routes allow authorised users to manage who belongs to a company.
// Super admins may manage any company; other users may only manage companies
// they already have access to.

function canManageCompanyUsers(req, companyId, accessRows) {
  if (req.user.isSuperAdmin || req.user.role === 'super_admin') return true;
  return (accessRows || []).some(r => String(r.company_id) === String(companyId) && r.is_active);
}

/**
 * GET /api/auth/companies/:companyId/users
 * List active users for a company.
 */
router.get('/companies/:companyId/users', authenticateToken, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    const { data: myAccess } = await supabase
      .from('user_company_access')
      .select('company_id, is_active')
      .eq('user_id', req.user.userId);

    if (!canManageCompanyUsers(req, companyId, myAccess)) {
      return res.status(403).json({ error: 'Access denied to this company' });
    }

    const { data: access, error } = await supabase
      .from('user_company_access')
      .select(`role, is_primary, granted_at, employee_id,
               users:user_id (id, username, email, full_name, is_active, last_login_at)`)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('granted_at');

    if (error) return res.status(500).json({ error: error.message });

    const users = (access || [])
      .filter(a => a.users)
      .map(a => ({
        id: a.users.id,
        username: a.users.username,
        email: a.users.email,
        full_name: a.users.full_name,
        employee_id: a.employee_id || null,
        is_active: a.users.is_active,
        last_login_at: a.users.last_login_at,
        role: a.role,
        is_primary: a.is_primary,
        granted_at: a.granted_at,
      }));

    res.json({ users });
  } catch (err) {
    console.error('GET /auth/companies/:id/users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/auth/companies/:companyId/users
 * Create a new user and add them to the company.
 */
router.post('/companies/:companyId/users', authenticateToken, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    const { data: myAccess } = await supabase
      .from('user_company_access')
      .select('company_id, is_active')
      .eq('user_id', req.user.userId);

    if (!canManageCompanyUsers(req, companyId, myAccess)) {
      return res.status(403).json({ error: 'Access denied to this company' });
    }

    const { username, password, full_name, email, role, employee_id } = req.body;
    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ error: 'username, password, full_name and role are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check username uniqueness
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.toLowerCase().trim())
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    // Verify company exists
    const { data: company } = await supabase
      .from('companies')
      .select('id')
      .eq('id', companyId)
      .single();
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const password_hash = await bcrypt.hash(password, 12);

    const { data: newUser, error: userErr } = await supabase
      .from('users')
      .insert({
        username: username.toLowerCase().trim(),
        password_hash,
        full_name: full_name.trim(),
        email: email ? email.toLowerCase().trim() : null,
        role,
        is_active: true,
      })
      .select('id, username, full_name, email, role')
      .single();

    if (userErr) return res.status(500).json({ error: userErr.message });

    const { error: accessErr } = await supabase
      .from('user_company_access')
      .insert({
        user_id: newUser.id,
        company_id: companyId,
        role,
        employee_id: employee_id || null,
        is_active: true,
        is_primary: true,
        granted_at: new Date().toISOString(),
      });

    if (accessErr) {
      // Clean up orphan user on access insert failure
      await supabase.from('users').delete().eq('id', newUser.id);
      return res.status(500).json({ error: accessErr.message });
    }

    await auditFromReq(req, 'CREATE', 'users', newUser.id, {
      action: 'create_company_user',
      companyId,
      newUsername: newUser.username,
      role,
    });

    res.status(201).json({ user: newUser });
  } catch (err) {
    console.error('POST /auth/companies/:id/users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/auth/companies/:companyId/users/:userId
 * Remove a user from a company (deactivates their access record, does not delete the user).
 */
router.delete('/companies/:companyId/users/:userId', authenticateToken, async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    const userId    = parseInt(req.params.userId);
    if (!companyId || !userId) return res.status(400).json({ error: 'companyId and userId are required' });

    const { data: myAccess } = await supabase
      .from('user_company_access')
      .select('company_id, is_active')
      .eq('user_id', req.user.userId);

    if (!canManageCompanyUsers(req, companyId, myAccess)) {
      return res.status(403).json({ error: 'Access denied to this company' });
    }

    const { error } = await supabase
      .from('user_company_access')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('company_id', companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'user_company_access', userId, {
      action: 'remove_company_user',
      companyId,
      userId,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /auth/companies/:id/users/:uid error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PIN timing-safe dummy hash (one synchronous hash at module load, ~150ms) ──
// Prevents timing attacks when user not found: compare always runs, always takes same time.
const _PIN_TIMING_DUMMY = bcrypt.hashSync('__cc_pin_timing_dummy__', 10);

/**
 * POST /api/auth/pos/pin-login
 * PIN-based login for cashier-level POS users. Returns the same token shape as
 * POST /api/auth/select-company so the POS frontend can use the same completeLogin() flow.
 *
 * Body: { company_id?, company_name?, user_identifier, pin }
 *   company_id or company_name — which company to log into
 *   user_identifier            — username, email, or employee_id
 *   pin                        — 4–6 digit string (never stored, compared via bcrypt only)
 *
 * Security:
 *   - PIN never returned in any response or log
 *   - Timing-safe: bcrypt.compare runs even when user/PIN not found
 *   - Lockout: ≥5 failures in 15 min blocks further attempts (server-side only)
 *   - Company isolation enforced: lookups scoped to resolved company_id
 *   - Only PIN-eligible roles allowed: cashier, senior_cashier, shift_supervisor, assistant_manager
 */
router.post('/pos/pin-login', async (req, res) => {
  try {
    const { company_id, company_name, user_identifier, pin } = req.body;

    if (!user_identifier || !pin) {
      return res.status(400).json({ error: 'user_identifier and pin are required' });
    }
    if (!/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'Invalid PIN format' });
    }

    // ── Resolve company ──────────────────────────────────────────────────────
    let company = null;
    if (company_id) {
      const { data } = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled, is_active')
        .eq('id', parseInt(company_id, 10))
        .maybeSingle();
      company = data;
    } else if (company_name) {
      const { data } = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled, is_active')
        .ilike('company_name', String(company_name).trim())
        .maybeSingle();
      company = data;
    }

    if (!company || !company.is_active) {
      await bcrypt.compare(String(pin), _PIN_TIMING_DUMMY); // timing protection
      return res.status(400).json({ error: 'Company not found' });
    }

    // Check POS module is enabled
    const enabledModules = company.modules_enabled || [];
    if (!enabledModules.includes('pos') && !enabledModules.includes('all')) {
      await bcrypt.compare(String(pin), _PIN_TIMING_DUMMY);
      return res.status(403).json({ error: 'POS module is not enabled for this company' });
    }

    const PIN_ELIGIBLE_ROLES = ['cashier', 'senior_cashier', 'shift_supervisor', 'assistant_manager'];

    // ── Resolve user (try username → email → employee_id) ────────────────────
    let userData = null;
    {
      const { data: u1 } = await supabase.from('users').select('id, username, email, full_name, is_active').eq('username', String(user_identifier)).eq('is_active', true).maybeSingle();
      userData = u1;
    }
    if (!userData) {
      const { data: u2 } = await supabase.from('users').select('id, username, email, full_name, is_active').eq('email', String(user_identifier)).eq('is_active', true).maybeSingle();
      userData = u2;
    }
    if (!userData) {
      const { data: u3 } = await supabase.from('users').select('id, username, email, full_name, is_active').eq('employee_id', String(user_identifier)).eq('is_active', true).maybeSingle();
      userData = u3;
    }

    // ── Resolve company access and role ──────────────────────────────────────
    let userRole = null;
    if (userData) {
      const { data: access } = await supabase
        .from('user_company_access')
        .select('role, is_active')
        .eq('company_id', company.id)
        .eq('user_id', userData.id)
        .eq('is_active', true)
        .maybeSingle();
      if (access) userRole = access.role;
    }

    // ── Fetch PIN hash (only if we have a real user+role) ────────────────────
    let pinRecord = null;
    if (userData && userRole) {
      const { data: pr } = await supabase
        .from('user_pos_pins')
        .select('pin_hash, is_active')
        .eq('company_id', company.id)
        .eq('user_id', userData.id)
        .maybeSingle();
      pinRecord = pr;
    }

    // ── Timing-safe compare — always runs ────────────────────────────────────
    const hashToCompare = (pinRecord && pinRecord.is_active) ? pinRecord.pin_hash : _PIN_TIMING_DUMMY;
    const pinMatches = await bcrypt.compare(String(pin), hashToCompare);

    // ── Now enforce all business rules (after compare) ────────────────────────
    const logAttempt = (success, reason) =>
      supabase.from('pos_pin_attempts').insert({
        company_id:           company.id,
        user_id:              userData ? userData.id : null,
        attempted_identifier: user_identifier,
        success,
        failure_reason:       reason,
        ip_address:           req.ip || null,
        user_agent:           req.headers['user-agent'] || null,
      }).then(() => {});

    if (!userData || !userRole) {
      logAttempt(false, 'user_not_found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!PIN_ELIGIBLE_ROLES.includes(userRole)) {
      logAttempt(false, 'role_not_eligible');
      return res.status(403).json({
        error: 'PIN login is not available for management roles. Please use password login.',
      });
    }

    // Lockout check: count failures in last 15 minutes
    const lockoutSince = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count: failCount } = await supabase
      .from('pos_pin_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company.id)
      .eq('user_id', userData.id)
      .eq('success', false)
      .gte('created_at', lockoutSince);

    if ((failCount || 0) >= 5) {
      logAttempt(false, 'lockout');
      return res.status(429).json({
        error: 'Account temporarily locked due to too many failed attempts. Please try again in 15 minutes.',
      });
    }

    if (!pinMatches || !(pinRecord && pinRecord.is_active)) {
      const reason  = pinRecord ? 'wrong_pin' : 'no_pin_set';
      const remain  = Math.max(0, 4 - (failCount || 0));
      logAttempt(false, reason);
      const errMsg  = pinRecord
        ? `Invalid PIN. ${remain} attempt${remain !== 1 ? 's' : ''} remaining before lockout.`
        : 'No PIN is set for this account. Please ask a manager to set up your PIN.';
      return res.status(401).json({ error: errMsg, attempts_remaining: remain });
    }

    // ── Success ───────────────────────────────────────────────────────────────
    logAttempt(true, null);
    supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', userData.id).then(() => {});

    const permissions = getRolePermissions(userRole);
    const token = jwt.sign({
      userId:            userData.id,
      username:          userData.username,
      email:             userData.email,
      fullName:          userData.full_name,
      isSuperAdmin:      false,
      hasCoachingAccess: false,
      companyId:         company.id,
      role:              userRole,
      permissions,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success:     true,
      token,
      companyId:   company.id,
      role:        userRole,
      loginMethod: 'pin',
      company: {
        id:              company.id,
        company_name:    company.company_name,
        trading_name:    company.trading_name,
        modules_enabled: company.modules_enabled,
      },
      user: {
        id:       userData.id,
        username: userData.username,
        fullName: userData.full_name,
      },
    });
  } catch (err) {
    console.error('[auth/pos/pin-login] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
