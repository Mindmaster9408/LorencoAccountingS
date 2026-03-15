/**
 * ============================================================================
 * Authentication Routes - Unified Ecosystem
 * ============================================================================
 * Login, register, company selection, token refresh.
 * Adapted from Checkout Charlie auth with Supabase backend.
 * ============================================================================
 */

const express = require('express');
const bcrypt = require('bcrypt');
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
        companies:company_id (id, company_name, trading_name, modules_enabled)
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
        role: isSuperAdmin ? 'super_admin' : c.role,
        is_primary: c.is_primary
      }))
      .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

    // Build token payload — always auto-select first company so role is never null
    const tokenPayload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      isSuperAdmin: isSuperAdmin,
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
      const { data: newCompany, error: compError } = await supabase
        .from('companies')
        .insert({
          company_name: companyName,
          trading_name: companyTradingName,
          is_active: true,
          modules_enabled: ['pos', 'payroll', 'accounting', 'sean'],
          subscription_status: 'active'
        })
        .select()
        .single();

      if (compError) {
        console.error('Company creation error:', compError.message);
        return res.status(500).json({ error: 'Failed to create company: ' + compError.message });
      }

      company = newCompany;

      // Link main user to company as owner
      await supabase.from('user_company_access').insert({
        user_id: mainUser.id,
        company_id: company.id,
        role: ownerRole,
        is_primary: true,
        is_active: true
      });

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
      .select('id, company_name, trading_name, modules_enabled, subscription_status')
      .eq('id', parsedCompanyId)
      .eq('is_active', true)
      .single();

    if (compErr || !company) {
      return res.status(404).json({ error: 'Company not found or inactive' });
    }

    if (isSuperAdmin) {
      role = 'super_admin';
    } else {
      // Regular users — check user_company_access
      const { data: access, error } = await supabase
        .from('user_company_access')
        .select('role')
        .eq('user_id', userId)
        .eq('company_id', parsedCompanyId)
        .eq('is_active', true)
        .single();

      if (error || !access) {
        return res.status(403).json({ error: 'You do not have access to this company' });
      }
      role = access.role;
    }

    // Issue new token with company context
    const token = jwt.sign({
      userId: req.user.userId,
      username: req.user.username,
      email: req.user.email,
      fullName: req.user.fullName,
      companyId: parsedCompanyId,
      role: role,
      isSuperAdmin: isSuperAdmin,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success: true,
      token,
      companyId: parsedCompanyId,
      role,
      company: {
        id: company.id,
        company_name: company.company_name,
        trading_name: company.trading_name,
        modules_enabled: company.modules_enabled,
        subscription_status: company.subscription_status,
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
      .select('id, username, email, full_name, is_super_admin, created_at')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user,
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
        companies:company_id (id, company_name, trading_name, modules_enabled)
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
    const validApps = ['pos', 'payroll', 'accounting', 'sean', 'coaching'];

    if (!targetApp || !validApps.includes(targetApp)) {
      return res.status(400).json({ error: `Invalid targetApp. Must be one of: ${validApps.join(', ')}` });
    }

    // Get user from DB
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let resolvedCompanyId = companyId ? parseInt(companyId) : null;
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
      const { data: access } = await supabase
        .from('user_company_access')
        .select('*')
        .eq('user_id', user.id)
        .eq('company_id', resolvedCompanyId)
        .eq('is_active', true)
        .maybeSingle();

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

          const ALLOWED_CROSS_ROLES = ['business_owner', 'accountant', 'super_admin', 'store_manager'];
          if (!practiceAccess || !ALLOWED_CROSS_ROLES.includes(practiceAccess.role)) {
            return res.status(403).json({ error: 'You do not have access to this company' });
          }
          // Use the user's role from their managing practice
          role = practiceAccess.role;
        } else {
          return res.status(403).json({ error: 'You do not have access to this company' });
        }
      } else {
        role = access.role;
      }
    } else {
      const { data: accessList } = await supabase
        .from('user_company_access')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('is_primary', { ascending: false });

      if (accessList && accessList.length > 0) {
        resolvedCompanyId = accessList[0].company_id;
        role = accessList[0].role;
      }
    }

    // Fetch and validate the resolved company exists
    let company = null;
    if (resolvedCompanyId) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled')
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

module.exports = router;
