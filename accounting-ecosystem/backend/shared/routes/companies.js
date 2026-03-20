/**
 * ============================================================================
 * Company Routes - Unified Ecosystem
 * ============================================================================
 * CRUD for companies. Shared across all modules.
 * BUG FIX #1: Default company only created if none exist (handled in database.js).
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany, requirePermission, requireSuperAdmin } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);

/**
 * GET /api/companies
 * List companies accessible to the user (or all for super admin)
 */
router.get('/', async (req, res) => {
  try {
    if (req.user.isSuperAdmin) {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .order('company_name');
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ companies: data });
    }

    // Non-admin: only companies the user has access to
    const { data, error } = await supabase
      .from('user_company_access')
      .select(`
        company_id, role, is_primary,
        companies:company_id (*)
      `)
      .eq('user_id', req.user.userId)
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    const companies = (data || []).filter(c => c.companies).map(c => ({
      ...c.companies,
      userRole: c.role,
      isPrimary: c.is_primary,
    }));

    res.json({ companies });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/companies/search?name=xyz
 * Search active companies by name (any authenticated user).
 * Used for the "Link Accounting Firm" firm picker in the dashboard.
 * Returns id, company_name, trading_name only (safe to expose to all users).
 */
router.get('/search', async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name || name.length < 2) {
      return res.json({ companies: [] });
    }

    const { data, error } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('is_active', true)
      .ilike('company_name', `%${name}%`)
      .order('company_name')
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ companies: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/companies/:id
 * Super admins can fetch any company. Regular users can only fetch companies
 * they are linked to via user_company_access.
 */
router.get('/:id', async (req, res) => {
  try {
    const companyId = parseInt(req.params.id);

    // Non-super-admins must have a user_company_access row for this company
    if (!req.user.isSuperAdmin) {
      const { data: access } = await supabase
        .from('user_company_access')
        .select('id')
        .eq('user_id', req.user.userId)
        .eq('company_id', companyId)
        .eq('is_active', true)
        .limit(1);

      if (!access || access.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Company not found' });
    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/companies
 * Create a new company
 * Permission: super_admin/business_owner, OR any user creating their first company
 */
router.post('/', async (req, res) => {
  try {
    const {
      company_name, trading_name, registration_number, vat_number,
      contact_email, contact_phone, address, modules_enabled
    } = req.body;

    if (!company_name) {
      return res.status(400).json({ error: 'company_name is required' });
    }

    // Allow first-company creation for any authenticated user
    // Otherwise require COMPANIES.CREATE permission
    const isSuperAdmin = req.user.isSuperAdmin;
    const userRole = req.user.role;
    const hasCreatePerm = isSuperAdmin || ['super_admin', 'business_owner'].includes(userRole);

    if (!hasCreatePerm) {
      // Check if this is their first company — allow it
      const { data: existingAccess } = await supabase
        .from('user_company_access')
        .select('id')
        .eq('user_id', req.user.userId)
        .eq('is_active', true)
        .limit(1);

      if (existingAccess && existingAccess.length > 0) {
        return res.status(403).json({ error: 'Insufficient permissions to create additional companies' });
      }
    }

    const { data, error } = await supabase
      .from('companies')
      .insert({
        company_name,
        trading_name: trading_name || company_name,
        registration_number: registration_number || null,
        vat_number: vat_number || null,
        contact_email: contact_email || null,
        contact_phone: contact_phone || null,
        address: address || null,
        modules_enabled: modules_enabled || ['pos', 'payroll', 'accounting', 'sean'],
        is_active: true,
        subscription_status: 'active'
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Determine if this should be the user's primary company
    const { data: existingLinks } = await supabase
      .from('user_company_access')
      .select('id')
      .eq('user_id', req.user.userId)
      .eq('is_active', true)
      .limit(1);
    const isPrimary = !existingLinks || existingLinks.length === 0;

    // Link creating user as business_owner
    await supabase.from('user_company_access').insert({
      user_id: req.user.userId,
      company_id: data.id,
      role: isSuperAdmin ? 'super_admin' : 'business_owner',
      is_primary: isPrimary,
      is_active: true
    });

    await auditFromReq(req, 'CREATE', 'company', data.id, { newValue: data });

    res.status(201).json({ company: data });
  } catch (err) {
    console.error('Company creation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/companies/:id
 * Update company details
 */
router.put('/:id', requireCompany, requirePermission('COMPANIES.EDIT'), async (req, res) => {
  try {
    const id = req.params.id;

    // Get old values for audit
    const { data: old } = await supabase.from('companies').select('*').eq('id', id).single();

    const updates = {};
    const allowed = ['company_name', 'trading_name', 'registration_number', 'vat_number',
      'contact_email', 'contact_phone', 'address', 'modules_enabled', 'is_active'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    // Super admins may also update the account_holder_type classification
    if (req.user.isSuperAdmin && req.body.account_holder_type !== undefined) {
      const validTypes = ['accounting_practice', 'business_owner', 'individual', null];
      if (validTypes.includes(req.body.account_holder_type)) {
        updates.account_holder_type = req.body.account_holder_type;
      }
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Company not found' });

    await auditFromReq(req, 'UPDATE', 'company', id, {
      oldValue: old,
      newValue: data,
    });

    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/companies/:id/account-holder-type
 * Super admin only — update entity classification without requiring full COMPANIES.EDIT permission.
 * Used by the Admin Panel to repair wrong classifications on existing records.
 */
router.patch('/:id/account-holder-type', requireSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { account_holder_type } = req.body;

    const validTypes = ['accounting_practice', 'business_owner', 'individual', null];
    if (!validTypes.includes(account_holder_type)) {
      return res.status(400).json({ error: 'Invalid account_holder_type. Must be accounting_practice, business_owner, individual, or null.' });
    }

    const { data: old } = await supabase.from('companies').select('account_holder_type, company_name').eq('id', id).single();
    if (!old) return res.status(404).json({ error: 'Company not found' });

    const { data, error } = await supabase
      .from('companies')
      .update({ account_holder_type, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'company', id, {
      field: 'account_holder_type',
      oldValue: old.account_holder_type,
      newValue: account_holder_type,
    });

    res.json({ company: data });
  } catch (err) {
    console.error('PATCH account-holder-type error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/companies/:id  (soft delete)
 */
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('companies')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'company', req.params.id);
    res.json({ success: true, message: 'Company deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
