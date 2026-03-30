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

    const [accessResult, appAccessResult, clientAccessResult] = await Promise.all([
      supabase
        .from('user_company_access')
        .select(`
          role, is_primary, apps_access,
          users:user_id (id, username, email, full_name, is_active, created_at, last_login_at)
        `)
        .eq('company_id', companyId)
        .eq('is_active', true),
      supabase
        .from('user_app_access')
        .select('user_id, app_key')
        .eq('company_id', companyId),
      supabase
        .from('user_client_access')
        .select('user_id, eco_client_id')
        .eq('company_id', companyId),
    ]);

    if (accessResult.error) return res.status(500).json({ error: accessResult.error.message });

    // Build a map: userId -> app_key[]
    const appsByUser = {};
    for (const row of (appAccessResult.data || [])) {
      if (!appsByUser[row.user_id]) appsByUser[row.user_id] = [];
      appsByUser[row.user_id].push(row.app_key);
    }

    // Build a map: userId -> eco_client_id[]
    const clientsByUser = {};
    for (const row of (clientAccessResult.data || [])) {
      if (!clientsByUser[row.user_id]) clientsByUser[row.user_id] = [];
      clientsByUser[row.user_id].push(row.eco_client_id);
    }

    const users = (accessResult.data || []).filter(d => d.users).map(d => ({
      ...d.users,
      role: d.role,
      is_primary: d.is_primary,
      // apps[] is null when no explicit restriction is set (means: access all company apps)
      apps: appsByUser[d.users.id] || null,
      // clients[] is null when no explicit restriction is set (means: access all company clients)
      clients: clientsByUser[d.users.id] || null,
      apps_access: d.apps_access || null,
    }));

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/me
 * Self-update — users can always edit their own profile (name, email, password)
 */
router.put('/me', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { full_name, email, current_password, new_password } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (full_name !== undefined) updates.full_name = full_name;
    if (email !== undefined) updates.email = email;

    // Password change requires current password verification
    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Current password is required to set a new password' });
      }
      const { data: user } = await supabase
        .from('users')
        .select('password_hash')
        .eq('id', userId)
        .single();
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });

      updates.password_hash = await bcrypt.hash(new_password, 10);
    }

    const { data: updated, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select('id, username, email, full_name')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ user: { id: updated.id, username: updated.username, fullName: updated.full_name, email: updated.email } });
  } catch (err) {
    console.error('PUT /api/users/me error:', err.message);
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
 * Only returns a user if they belong to the requesting user's current company.
 */
router.get('/:id', requirePermission('USERS.VIEW'), async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id);

    // Verify the requested user is a member of the current company (unless super admin)
    if (!req.user.isSuperAdmin) {
      const { data: access } = await supabase
        .from('user_company_access')
        .select('id')
        .eq('user_id', targetUserId)
        .eq('company_id', req.companyId)
        .eq('is_active', true)
        .limit(1);

      if (!access || access.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, email, full_name, is_active, created_at, last_login_at')
      .eq('id', targetUserId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    // Get company access info (scoped to current company for non-admins)
    const accessQ = supabase
      .from('user_company_access')
      .select('company_id, role, is_primary')
      .eq('user_id', targetUserId)
      .eq('is_active', true);

    if (!req.user.isSuperAdmin) {
      accessQ.eq('company_id', req.companyId);
    }

    const { data: accessRows } = await accessQ;
    user.companies = accessRows || [];

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/users
 * Create a new user and link to current company, with optional per-user app access.
 */
router.post('/', requirePermission('USERS.CREATE'), async (req, res) => {
  try {
    const { username, email, password, full_name, role, apps, apps_access } = req.body;

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'email, password, full_name, and role are required' });
    }
    const resolvedUsername = username || email;

    // Verify manager can assign this role
    if (!canManageRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot assign this role level' });
    }

    // Check uniqueness
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`username.eq.${resolvedUsername},email.eq.${email}`)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert({ username: resolvedUsername, email, password_hash, full_name, is_active: true })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Link to current company with optional per-app access
    await supabase.from('user_company_access').insert({
      user_id: newUser.id,
      company_id: req.companyId,
      role,
      is_primary: true,
      is_active: true,
      apps_access: Array.isArray(apps_access) && apps_access.length > 0 ? apps_access : null
    });

    // If specific apps were provided, record per-user app access.
    // An empty array means "no apps" (fully restricted).
    // Null / undefined means "use company defaults" (no restriction recorded).
    if (Array.isArray(apps)) {
      const VALID_APPS = ['pos', 'payroll', 'accounting', 'sean', 'coaching'];
      const appRows = apps
        .filter(a => VALID_APPS.includes(a))
        .map(a => ({
          user_id: newUser.id,
          company_id: req.companyId,
          app_key: a,
          granted_by: req.user.userId,
        }));
      if (appRows.length > 0) {
        await supabase.from('user_app_access').insert(appRows);
      }
    }

    await auditFromReq(req, 'CREATE', 'user', newUser.id, {
      newValue: { username, email, full_name, role, apps: apps || null }
    });

    res.status(201).json({
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        full_name: newUser.full_name,
        role,
        apps: apps || null,
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
    const { full_name, email, role, is_active, company_ids, apps_access, revoke_company_access } = req.body;

    // Revoke this user's access from the current company (without deactivating them globally)
    if (revoke_company_access) {
      await supabase
        .from('user_company_access')
        .update({ is_active: false })
        .eq('user_id', userId)
        .eq('company_id', req.companyId);
      await auditFromReq(req, 'UPDATE', 'user', userId, { metadata: { action: 'revoked_company_access', companyId: req.companyId } });
      return res.json({ success: true, message: 'User access revoked from this company' });
    }

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

    // Update role and/or apps_access for current company
    const accessUpdates = {};
    if (role) {
      if (!canManageRole(req.user.role, role)) {
        return res.status(403).json({ error: 'You cannot assign this role level' });
      }
      accessUpdates.role = role;
    }
    if (apps_access !== undefined) {
      accessUpdates.apps_access = Array.isArray(apps_access) && apps_access.length > 0 ? apps_access : null;
    }
    if (Object.keys(accessUpdates).length > 0) {
      await supabase
        .from('user_company_access')
        .update(accessUpdates)
        .eq('user_id', userId)
        .eq('company_id', req.companyId);
    }

    // Update per-user app access if apps[] was provided in the request.
    // apps: null/undefined = leave unchanged
    // apps: []             = remove all restrictions (or set empty — meaning blocked from all)
    // apps: ['pos',...]    = replace existing grants with this new set
    const { apps } = req.body;
    if (Array.isArray(apps)) {
      // Delete existing app access rows for this user+company
      await supabase
        .from('user_app_access')
        .delete()
        .eq('user_id', userId)
        .eq('company_id', req.companyId);

      const VALID_APPS = ['pos', 'payroll', 'accounting', 'sean', 'coaching'];
      const appRows = apps
        .filter(a => VALID_APPS.includes(a))
        .map(a => ({
          user_id: parseInt(userId),
          company_id: req.companyId,
          app_key: a,
          granted_by: req.user.userId,
        }));
      if (appRows.length > 0) {
        await supabase.from('user_app_access').insert(appRows);
      }
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
 * PUT /api/users/:id/client-access
 * Replace per-user eco_client grants for the current company.
 *   clients: null/undefined = remove all restrictions (unrestricted)
 *   clients: []             = block all clients
 *   clients: [id, ...]      = only those eco_client_ids are visible
 */
router.put('/:id/client-access', requirePermission('USERS.EDIT'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const companyId = req.companyId;
    const { clients } = req.body;

    // Always clear existing grants first (replace semantics)
    await supabase
      .from('user_client_access')
      .delete()
      .eq('user_id', userId)
      .eq('company_id', companyId);

    if (Array.isArray(clients) && clients.length > 0) {
      const rows = clients
        .map(id => parseInt(id))
        .filter(id => !isNaN(id))
        .map(eco_client_id => ({
          user_id: userId,
          company_id: companyId,
          eco_client_id,
          granted_by: req.user.userId,
        }));

      if (rows.length > 0) {
        const { error } = await supabase.from('user_client_access').insert(rows);
        if (error) return res.status(500).json({ error: error.message });
      }
    }

    await auditFromReq(req, 'UPDATE', 'user_client_access', userId, {
      metadata: { clients: clients || null, company_id: companyId }
    });

    res.json({
      success: true,
      clients: Array.isArray(clients) && clients.length > 0 ? clients : null
    });
  } catch (err) {
    console.error('PUT client-access error:', err);
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

// ═══════════════════════════════════════════════════════════════════════════════
// PAYTIME ACCESS CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/users/:id/paytime-config
 * Get paytime_user_config for a user + current company.
 * Returns null if no config exists (user has unrestricted access).
 */
router.get('/:id/paytime-config', requirePermission('USERS.VIEW'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const companyId = req.companyId;

    const { data, error } = await supabase
      .from('paytime_user_config')
      .select('*')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ config: data || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/:id/paytime-config
 * Upsert paytime_user_config for a user + current company.
 * Body: { modules: ['leave','payroll'], employee_scope: 'all'|'selected', can_view_confidential: bool }
 * Send null body (or { clear: true }) to remove config entirely (restores unrestricted access).
 */
router.put('/:id/paytime-config', requirePermission('USERS.EDIT'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const companyId = req.companyId;

    // Allow clearing config (restores unrestricted access)
    if (req.body.clear === true || req.body === null) {
      await supabase.from('paytime_user_config').delete()
        .eq('user_id', userId).eq('company_id', companyId);
      await auditFromReq(req, 'DELETE', 'paytime_user_config', userId, {
        metadata: { company_id: companyId, action: 'config_cleared' }
      });
      return res.json({ success: true, config: null });
    }

    const { modules, employee_scope, can_view_confidential } = req.body;

    // Validate
    const VALID_MODULES = ['leave', 'payroll'];
    const VALID_SCOPES = ['all', 'selected'];
    if (modules !== undefined && (!Array.isArray(modules) || modules.some(m => !VALID_MODULES.includes(m)))) {
      return res.status(400).json({ error: `modules must be an array containing: ${VALID_MODULES.join(', ')}` });
    }
    if (employee_scope !== undefined && !VALID_SCOPES.includes(employee_scope)) {
      return res.status(400).json({ error: `employee_scope must be one of: ${VALID_SCOPES.join(', ')}` });
    }

    const configRow = {
      user_id: userId,
      company_id: companyId,
      modules: modules ?? ['leave', 'payroll'],
      employee_scope: employee_scope ?? 'all',
      can_view_confidential: can_view_confidential ?? false,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('paytime_user_config')
      .upsert(configRow, { onConflict: 'user_id,company_id' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'paytime_user_config', userId, {
      metadata: { company_id: companyId, config: configRow }
    });

    res.json({ config: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users/:id/paytime-employees
 * List employees explicitly assigned to a user (employee_scope='selected').
 */
router.get('/:id/paytime-employees', requirePermission('USERS.VIEW'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const companyId = req.companyId;

    const { data, error } = await supabase
      .from('paytime_employee_access')
      .select('employee_id, granted_at, employees(id, full_name, employee_code, classification)')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .order('granted_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ employees: (data || []).map(r => ({ ...r.employees, granted_at: r.granted_at })) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/:id/paytime-employees
 * Replace the full employee visibility list for a user (replace-all semantics).
 * Body: { employee_ids: [1, 2, 3] }
 * Send employee_ids: [] to remove all assignments (effectively blocks all if scope='selected').
 */
router.put('/:id/paytime-employees', requirePermission('USERS.EDIT'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const companyId = req.companyId;
    const { employee_ids } = req.body;

    if (!Array.isArray(employee_ids)) {
      return res.status(400).json({ error: 'employee_ids must be an array of integers' });
    }

    // Replace-all: delete existing, insert new
    await supabase.from('paytime_employee_access').delete()
      .eq('user_id', userId).eq('company_id', companyId);

    const validIds = employee_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
    if (validIds.length > 0) {
      const rows = validIds.map(employee_id => ({
        user_id: userId,
        company_id: companyId,
        employee_id,
        granted_by: req.user.userId,
      }));
      const { error } = await supabase.from('paytime_employee_access').insert(rows);
      if (error) return res.status(500).json({ error: error.message });
    }

    await auditFromReq(req, 'UPDATE', 'paytime_employee_access', userId, {
      metadata: { company_id: companyId, employee_ids: validIds }
    });

    res.json({ success: true, employee_ids: validIds });
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
