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
    const isSuperAdmin = !!user.is_super_admin;
    let companies, compError;

    if (isSuperAdmin) {
      // Super admins get ALL companies
      const result = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled')
        .eq('is_active', true)
        .order('company_name');
      companies = result.data ? result.data.map(c => ({
        companies: c,
        company_id: c.id,
        role: 'super_admin',
        is_primary: true
      })) : [];
      compError = result.error;
    } else {
      const result = await supabase
        .from('user_company_access')
        .select(`
          company_id,
          role,
          is_primary,
          companies:company_id (id, company_name, trading_name, modules_enabled)
        `)
        .eq('user_id', user.id)
        .eq('is_active', true);
      companies = result.data;
      compError = result.error;
    }

    if (compError) {
      console.error('Error fetching companies:', compError.message);
    }

    const companyList = (companies || [])
      .filter(c => c.companies)
      .map(c => ({
        id: c.companies.id,
        company_name: c.companies.company_name,
        trading_name: c.companies.trading_name,
        modules_enabled: c.companies.modules_enabled,
        role: c.role,
        is_primary: c.is_primary
      }))
      .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

    // Build token payload
    const tokenPayload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      isSuperAdmin: isSuperAdmin,
      companyId: null,
      role: null,
    };

    // Auto-select if only one company
    let selectedCompany = null;
    if (companyList.length === 1) {
      selectedCompany = companyList[0];
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
    const { username, email, password, full_name, company_name, trading_name } = req.body;

    if (!username || !email || !password || !full_name) {
      return res.status(400).json({ error: 'Username, email, password, and full name are required' });
    }

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`username.eq.${username},email.eq.${email}`)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Username or email already registered' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Create user
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({ username, email, password_hash, full_name, is_active: true })
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to create user: ' + userError.message });
    }

    // If company_name provided, create company and link
    let company = null;
    if (company_name) {
      const { data: newCompany, error: compError } = await supabase
        .from('companies')
        .insert({
          company_name,
          trading_name: trading_name || company_name,
          is_active: true,
          modules_enabled: ['pos'],
          subscription_status: 'active'
        })
        .select()
        .single();

      if (!compError && newCompany) {
        company = newCompany;
        // Link user to company as business_owner
        await supabase.from('user_company_access').insert({
          user_id: newUser.id,
          company_id: newCompany.id,
          role: 'business_owner',
          is_primary: true,
          is_active: true
        });
      }
    }

    const token = jwt.sign({
      userId: newUser.id,
      username: newUser.username,
      email: newUser.email,
      fullName: newUser.full_name,
      companyId: company?.id || null,
      role: company ? 'business_owner' : null,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.full_name,
      },
      company: company ? {
        id: company.id,
        company_name: company.company_name,
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

    // Verify user has access to this company
    const { data: access, error } = await supabase
      .from('user_company_access')
      .select('role')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .single();

    if (error || !access) {
      return res.status(403).json({ error: 'You do not have access to this company' });
    }

    // Issue new token with company context
    const token = jwt.sign({
      userId: req.user.userId,
      username: req.user.username,
      email: req.user.email,
      fullName: req.user.fullName,
      companyId: companyId,
      role: access.role,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({ success: true, token, companyId, role: access.role });
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
    const { data: companies, error } = await supabase
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

    const list = (companies || [])
      .filter(c => c.companies)
      .map(c => ({
        id: c.companies.id,
        company_name: c.companies.company_name,
        trading_name: c.companies.trading_name,
        modules_enabled: c.companies.modules_enabled,
        role: c.role,
        is_primary: c.is_primary,
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
    const validApps = ['pos', 'payroll', 'accounting', 'sean'];

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
      if (!resolvedCompanyId) resolvedCompanyId = req.companyId || 1;
    } else if (resolvedCompanyId) {
      const { data: access } = await supabase
        .from('user_company_access')
        .select('*')
        .eq('user_id', user.id)
        .eq('company_id', resolvedCompanyId)
        .eq('is_active', true)
        .single();

      if (!access) {
        return res.status(403).json({ error: 'You do not have access to this company' });
      }
      role = access.role;
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

    let company = null;
    if (resolvedCompanyId) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('id, company_name, trading_name, modules_enabled')
        .eq('id', resolvedCompanyId)
        .single();
      company = companyData;
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
