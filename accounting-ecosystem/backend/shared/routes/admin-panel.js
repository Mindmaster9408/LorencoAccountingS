/**
 * ============================================================================
 * Admin Panel Routes — Super Admin Only
 * ============================================================================
 * Routes used exclusively by the Platform Control Centre (admin.html).
 * All routes require isSuperAdmin in the JWT.
 *
 * These routes allow the super admin to:
 *  - List users for any company (without needing that company in their JWT)
 *  - Change a user's role within a specific company scope
 *  - Assign Business Owner role from the Admin Panel
 *
 * Mounted at: /api/admin
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireSuperAdmin } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const { canManageRole } = require('../../config/permissions');

const router = express.Router();

// All admin-panel routes require authentication + super admin flag
router.use(authenticateToken);
router.use(requireSuperAdmin);

/**
 * GET /api/admin/companies/:companyId/users
 * List all active users for any company — super admin only.
 * Returns each user with their role within this company and basic profile.
 */
router.get('/companies/:companyId/users', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    // Verify company exists
    const { data: company } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('id', companyId)
      .single();
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { data: access, error } = await supabase
      .from('user_company_access')
      .select(`
        role, is_primary, is_active, granted_at,
        users:user_id (id, username, email, full_name, is_active, last_login_at, created_at)
      `)
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
        is_active: a.users.is_active,
        last_login_at: a.users.last_login_at,
        created_at: a.users.created_at,
        role: a.role,
        is_primary: a.is_primary,
        granted_at: a.granted_at,
      }));

    res.json({ users, company: { id: company.id, name: company.trading_name || company.company_name } });
  } catch (err) {
    console.error('admin GET /companies/:id/users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/admin/companies/:companyId/users/:userId/role
 * Change a user's role within a specific company — super admin only.
 *
 * Body: { role: 'business_owner' | 'accountant' | 'employee' | 'cashier' | ... }
 *
 * Superadmins bypass the normal canManageRole hierarchy check since they
 * have platform-level authority to repair any misconfigured role.
 * An audit record is written for every role change.
 */
router.put('/companies/:companyId/users/:userId/role', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId);
    const userId = parseInt(req.params.userId);
    const { role } = req.body;

    if (!companyId || !userId) {
      return res.status(400).json({ error: 'companyId and userId are required' });
    }

    const VALID_ROLES = ['super_admin', 'business_owner', 'accountant', 'manager', 'cashier', 'employee', 'viewer'];
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
    }

    // Verify company exists
    const { data: company } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('id', companyId)
      .single();
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Verify user exists
    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, email')
      .eq('id', userId)
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify user has access to this company
    const { data: access } = await supabase
      .from('user_company_access')
      .select('id, role')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle();

    if (!access) {
      return res.status(404).json({ error: 'User is not a member of this company' });
    }

    const oldRole = access.role;

    // Update role in user_company_access
    const { error: updateErr } = await supabase
      .from('user_company_access')
      .update({ role })
      .eq('user_id', userId)
      .eq('company_id', companyId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // If the new role is business_owner, also update the users.role column
    // so that the user's default role is reflected across the platform.
    if (role === 'business_owner') {
      await supabase
        .from('users')
        .update({ role: 'business_owner', updated_at: new Date().toISOString() })
        .eq('id', userId);
    }

    await auditFromReq(req, 'UPDATE', 'user_company_access', access.id, {
      action: 'admin_role_change',
      userId,
      companyId,
      oldRole,
      newRole: role,
      targetUserName: user.full_name,
      targetUserEmail: user.email,
      companyName: company.trading_name || company.company_name,
    });

    res.json({
      success: true,
      message: `Role for ${user.full_name} updated to ${role} in ${company.trading_name || company.company_name}`,
      user: { id: userId, full_name: user.full_name, role },
    });
  } catch (err) {
    console.error('admin PUT /companies/:id/users/:uid/role error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
