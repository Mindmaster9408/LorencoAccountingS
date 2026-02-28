/**
 * ============================================================================
 * User Routes - Unified Ecosystem
 * ============================================================================
 * CRUD for user management. Includes BUG FIX #3: Edit user endpoint.
 * ============================================================================
 */

const express = require('express');
const bcrypt = require('bcrypt');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const { canManageRole, getAllRoles } = require('../../config/permissions');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/users
 * List users for the current company
 * BUG FIX #2: Filters by company_id so users only see company members
 */
router.get('/', requirePermission('USERS.VIEW'), async (req, res) => {
  try {
    const companyId = req.companyId;

    const { data, error } = await supabase
      .from('user_company_access')
      .select(`
        role, is_primary,
        users:user_id (id, username, email, full_name, is_active, created_at, last_login_at)
      `)
      .eq('company_id', companyId)
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    const users = (data || []).filter(d => d.users).map(d => ({
      ...d.users,
      role: d.role,
      is_primary: d.is_primary,
    }));

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users/roles
 * Get available roles for user assignment
 */
router.get('/roles', (req, res) => {
  res.json({ roles: getAllRoles() });
});

/**
 * GET /api/users/:id
 */
router.get('/:id', requirePermission('USERS.VIEW'), async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, full_name, is_active, created_at, last_login_at')
      .eq('id', req.params.id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    // Get company access info
    const { data: access } = await supabase
      .from('user_company_access')
      .select('company_id, role, is_primary')
      .eq('user_id', req.params.id)
      .eq('is_active', true);

    user.companies = access || [];

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/users
 * Create a new user and link to current company
 */
router.post('/', requirePermission('USERS.CREATE'), async (req, res) => {
  try {
    const { username, email, password, full_name, role } = req.body;

    if (!username || !email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'username, email, password, full_name, and role are required' });
    }

    // Verify manager can assign this role
    if (!canManageRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot assign this role level' });
    }

    // Check uniqueness
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`username.eq.${username},email.eq.${email}`)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert({ username, email, password_hash, full_name, is_active: true })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Link to current company
    await supabase.from('user_company_access').insert({
      user_id: newUser.id,
      company_id: req.companyId,
      role,
      is_primary: true,
      is_active: true
    });

    await auditFromReq(req, 'CREATE', 'user', newUser.id, {
      newValue: { username, email, full_name, role }
    });

    res.status(201).json({
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        full_name: newUser.full_name,
        role
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/:id
 * BUG FIX #3: Edit user — update profile, role, and company assignment
 */
router.put('/:id', requirePermission('USERS.EDIT'), async (req, res) => {
  try {
    const userId = req.params.id;
    const { full_name, email, role, is_active, company_ids } = req.body;

    // Get old data for audit
    const { data: oldUser } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (!oldUser) return res.status(404).json({ error: 'User not found' });

    // Update user profile fields
    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;
    if (is_active !== undefined) updates.is_active = is_active;
    updates.updated_at = new Date().toISOString();

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Update role for current company
    if (role) {
      if (!canManageRole(req.user.role, role)) {
        return res.status(403).json({ error: 'You cannot assign this role level' });
      }

      await supabase
        .from('user_company_access')
        .update({ role })
        .eq('user_id', userId)
        .eq('company_id', req.companyId);
    }

    // Update company assignments if provided
    if (company_ids && Array.isArray(company_ids)) {
      // Get current assignments
      const { data: currentAccess } = await supabase
        .from('user_company_access')
        .select('company_id')
        .eq('user_id', userId)
        .eq('is_active', true);

      const currentIds = (currentAccess || []).map(a => a.company_id);

      // Add new companies
      for (const cid of company_ids) {
        if (!currentIds.includes(cid)) {
          await supabase.from('user_company_access').insert({
            user_id: userId,
            company_id: cid,
            role: role || 'cashier',
            is_primary: false,
            is_active: true
          });
        }
      }

      // Deactivate removed companies
      for (const cid of currentIds) {
        if (!company_ids.includes(cid)) {
          await supabase
            .from('user_company_access')
            .update({ is_active: false })
            .eq('user_id', userId)
            .eq('company_id', cid);
        }
      }
    }

    await auditFromReq(req, 'UPDATE', 'user', userId, {
      oldValue: { full_name: oldUser.full_name, email: oldUser.email },
      newValue: { full_name: updates.full_name, email: updates.email, role }
    });

    res.json({
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        full_name: updatedUser.full_name,
        is_active: updatedUser.is_active,
        role
      }
    });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/:id/password
 * Change password
 */
router.put('/:id/password', async (req, res) => {
  try {
    const userId = req.params.id;
    const { current_password, new_password } = req.body;

    // Only self or management can change passwords
    if (req.user.userId !== parseInt(userId) && !['super_admin', 'business_owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // If changing own password, verify current password
    if (req.user.userId === parseInt(userId)) {
      const { data: user } = await supabase
        .from('users')
        .select('password_hash')
        .eq('id', userId)
        .single();

      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from('users').update({ password_hash }).eq('id', userId);

    await auditFromReq(req, 'UPDATE', 'user', userId, {
      fieldName: 'password',
      metadata: { changedBy: req.user.userId }
    });

    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/users/:id/company-access
 * Remove a user from the CURRENT company only (revokes access without disabling their global account).
 * Requires USERS.DELETE permission.
 */
router.delete('/:id/company-access', requirePermission('USERS.DELETE'), async (req, res) => {
  try {
    const userId = req.params.id;
    const companyId = req.companyId;

    // Prevent removing yourself
    if (parseInt(userId) === req.user.userId) {
      return res.status(400).json({ error: 'You cannot remove yourself from the practice' });
    }

    const { error } = await supabase
      .from('user_company_access')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('company_id', companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'user_company_access', userId, {
      metadata: { removed_from_company: companyId }
    });

    res.json({ success: true, message: 'User removed from practice' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/users/:id (soft delete)
 */
router.delete('/:id', requirePermission('USERS.DELETE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    // Deactivate all company access
    await supabase
      .from('user_company_access')
      .update({ is_active: false })
      .eq('user_id', req.params.id);

    await auditFromReq(req, 'DELETE', 'user', req.params.id);
    res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
