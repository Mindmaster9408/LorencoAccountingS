const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

/**
 * GET /api/accounts
 * List all accounts for the company
 */
router.get('/', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const { type, isActive, includeInactive } = req.query;
    const companyId = req.user.companyId;

    let q = supabase.from('accounts').select('*').eq('company_id', companyId);

    if (type) q = q.eq('type', type);

    if (isActive !== undefined) {
      q = q.eq('is_active', isActive !== 'false');
    } else if (!includeInactive) {
      q = q.eq('is_active', true);
    }

    q = q.order('code');

    const { data, error } = await q;
    if (error) throw error;

    res.json({ accounts: data || [], count: (data || []).length });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

/**
 * GET /api/accounts/templates
 * Returns available COA templates with account counts and company assignment status.
 * Defined BEFORE /:id to avoid Express routing conflict on single-segment paths.
 */
router.get('/templates', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const companyId = req.user.companyId;

    // Fetch all templates
    const { data: templates, error: tmplErr } = await supabase
      .from('coa_templates')
      .select('*')
      .order('is_default', { ascending: false })
      .order('name');
    if (tmplErr) throw tmplErr;

    // Fetch per-template account counts
    const { data: countRows, error: countErr } = await supabase
      .from('coa_template_accounts')
      .select('template_id');
    if (countErr) throw countErr;

    const countMap = {};
    for (const row of (countRows || [])) {
      countMap[row.template_id] = (countMap[row.template_id] || 0) + 1;
    }

    // Fetch company assignments for this company
    const { data: assignments, error: assignErr } = await supabase
      .from('company_template_assignments')
      .select('template_id, applied_at, accounts_added')
      .eq('company_id', companyId);
    if (assignErr) throw assignErr;

    const assignMap = {};
    for (const a of (assignments || [])) {
      assignMap[a.template_id] = a;
    }

    const result = (templates || []).map(t => ({
      ...t,
      account_count: countMap[t.id] || 0,
      applied_at: assignMap[t.id]?.applied_at || null,
      accounts_added: assignMap[t.id]?.accounts_added || null,
    }));

    res.json({ templates: result });
  } catch (error) {
    console.error('Error fetching COA templates:', error);
    res.status(500).json({ error: 'Failed to fetch COA templates' });
  }
});

/**
 * GET /api/accounts/templates/:id/accounts
 * Preview accounts inside a specific template.
 */
router.get('/templates/:id/accounts', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    if (isNaN(templateId)) return res.status(400).json({ error: 'Invalid templateId' });

    const { data: tmpl, error: tmplErr } = await supabase
      .from('coa_templates')
      .select('*, parent:coa_templates!parent_template_id(name)')
      .eq('id', templateId)
      .maybeSingle();
    if (tmplErr) throw tmplErr;
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { data: accounts, error: accErr } = await supabase
      .from('coa_template_accounts')
      .select('*')
      .eq('template_id', templateId)
      .order('sort_order')
      .order('code');
    if (accErr) throw accErr;

    const templateOut = { ...tmpl, parent_name: tmpl.parent?.name || null };
    delete templateOut.parent;

    res.json({ template: templateOut, accounts: accounts || [] });
  } catch (error) {
    console.error('Error fetching template accounts:', error);
    res.status(500).json({ error: 'Failed to fetch template accounts' });
  }
});

/**
 * GET /api/accounts/:id
 * Get a specific account
 */
router.get('/:id', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Account not found' });
    res.json(data);
  } catch (error) {
    console.error('Error fetching account:', error);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

/**
 * POST /api/accounts
 * Create a new account
 */
router.post('/', authenticate, hasPermission('account.create'), async (req, res) => {
  try {
    const { code, name, type, parentId, description, subType, reportingGroup, sortOrder, vatCode } = req.body;
    const companyId = req.user.companyId;

    if (!code || !name || !type) {
      return res.status(400).json({ error: 'Code, name, and type are required' });
    }
    const validTypes = ['asset', 'liability', 'equity', 'income', 'expense'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }

    // Check for duplicate code
    const { data: existing } = await supabase
      .from('accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', code)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Account code already exists' });

    const { data: account, error } = await supabase
      .from('accounts')
      .insert({
        company_id: companyId,
        code,
        name,
        type,
        parent_id: parentId || null,
        description: description || null,
        sub_type: subType || null,
        reporting_group: reportingGroup || null,
        sort_order: sortOrder != null ? parseInt(sortOrder) : (parseInt(code) || 0),
        vat_code: vatCode || null,
        is_active: true,
      })
      .select()
      .single();
    if (error) throw error;

    await AuditLogger.logUserAction(
      req, 'CREATE', 'ACCOUNT', account.id,
      null, { code: account.code, name: account.name, type: account.type },
      'Account created'
    );

    res.status(201).json(account);
  } catch (error) {
    console.error('Error creating account:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * PUT /api/accounts/:id
 * Update an account (code and type are immutable; system accounts are locked)
 */
router.put('/:id', authenticate, hasPermission('account.edit'), async (req, res) => {
  try {
    const { name, description, isActive, subType, reportingGroup, sortOrder, vatCode } = req.body;
    const companyId = req.user.companyId;

    const { data: existing, error: fetchErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Account not found' });
    if (existing.is_system) return res.status(403).json({ error: 'Cannot edit system accounts' });

    const updates = {};
    if (name !== undefined)           updates.name            = name;
    if (description !== undefined)    updates.description     = description;
    if (isActive !== undefined)       updates.is_active       = isActive;
    if (subType !== undefined)        updates.sub_type        = subType || null;
    if (reportingGroup !== undefined) updates.reporting_group = reportingGroup || null;
    if (sortOrder != null)            updates.sort_order      = parseInt(sortOrder);
    if (vatCode !== undefined)        updates.vat_code        = vatCode || null;
    updates.updated_at = new Date().toISOString();

    const { data: account, error: updateErr } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', companyId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await AuditLogger.logUserAction(
      req, 'UPDATE', 'ACCOUNT', account.id,
      { name: existing.name, description: existing.description, isActive: existing.is_active },
      { name: account.name, description: account.description, isActive: account.is_active },
      'Account updated'
    );

    res.json(account);
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

/**
 * DELETE /api/accounts/:id
 * Soft delete (deactivate) an account
 */
router.delete('/:id', authenticate, hasPermission('account.delete'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const accountId = req.params.id;

    const { data: existing, error: fetchErr } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', accountId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Account not found' });
    if (existing.is_system) return res.status(403).json({ error: 'Cannot delete system accounts' });

    // Check if account is used in any posted journals
    const { count: usageCount, error: usageErr } = await supabase
      .from('journal_lines')
      .select('journals!inner(status)', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('journals.status', 'posted');
    if (usageErr) throw usageErr;

    if ((usageCount || 0) > 0) {
      return res.status(409).json({
        error: 'Cannot delete account with posted transactions. Consider deactivating instead.'
      });
    }

    const { error: delErr } = await supabase
      .from('accounts')
      .update({ is_active: false })
      .eq('id', accountId);
    if (delErr) throw delErr;

    await AuditLogger.logUserAction(
      req, 'DELETE', 'ACCOUNT', existing.id,
      { code: existing.code, name: existing.name, isActive: true },
      { code: existing.code, name: existing.name, isActive: false },
      'Account deactivated'
    );

    res.json({ message: 'Account deactivated successfully' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

/**
 * POST /api/accounts/provision-defaults
 * Seeds the standard SA chart of accounts for this company (safe if already has accounts).
 */
router.post('/provision-defaults', authenticate, hasPermission('account.create'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const count = await provisionFromTemplateSupabase(companyId);

    if (count === 0) {
      return res.json({ message: 'Chart of accounts already exists — no changes made.', seeded: false });
    }

    const { data: accounts } = await supabase
      .from('accounts')
      .select('*')
      .eq('company_id', companyId)
      .order('sort_order')
      .order('code');

    res.status(201).json({
      message: `${count} accounts provisioned from Standard SA Base template.`,
      seeded: true,
      accounts: accounts || [],
    });
  } catch (error) {
    console.error('Error provisioning default accounts:', error);
    res.status(500).json({ error: 'Failed to provision default accounts' });
  }
});

/**
 * POST /api/accounts/provision-from-template/:templateId
 * Provisions a specific COA template for this company.
 * Only allowed if the company has no accounts yet.
 */
router.post('/provision-from-template/:templateId', authenticate, hasPermission('account.create'), async (req, res) => {
  try {
    const templateId = parseInt(req.params.templateId);
    if (isNaN(templateId)) return res.status(400).json({ error: 'Invalid templateId' });
    const companyId = req.user.companyId;

    const { data: tmpl } = await supabase
      .from('coa_templates')
      .select('id, name')
      .eq('id', templateId)
      .maybeSingle();
    if (!tmpl) return res.status(404).json({ error: 'COA template not found' });

    const count = await provisionFromTemplateSupabase(companyId, templateId);

    if (count === 0) {
      return res.json({ message: 'Chart of accounts already exists — no changes made.', seeded: false });
    }

    const { data: accounts } = await supabase
      .from('accounts')
      .select('*')
      .eq('company_id', companyId)
      .order('sort_order')
      .order('code');

    res.status(201).json({
      message: `${count} accounts provisioned from "${tmpl.name}" template.`,
      seeded: true,
      accounts: accounts || [],
    });
  } catch (error) {
    console.error('Error provisioning from template:', error);
    res.status(500).json({ error: 'Failed to provision accounts from template' });
  }
});

/**
 * POST /api/accounts/apply-overlay/:templateId
 * Applies an industry overlay template to a company that already has a base COA.
 */
router.post('/apply-overlay/:templateId', authenticate, hasPermission('account.create'), async (req, res) => {
  try {
    const templateId = parseInt(req.params.templateId);
    if (isNaN(templateId)) return res.status(400).json({ error: 'Invalid templateId' });
    const companyId = req.user.companyId;

    const { data: tmpl } = await supabase
      .from('coa_templates')
      .select('id, name, parent_template_id')
      .eq('id', templateId)
      .maybeSingle();
    if (!tmpl) return res.status(404).json({ error: 'COA template not found' });

    const count = await applyTemplateOverlaySupabase(companyId, templateId);

    const { data: accounts } = await supabase
      .from('accounts')
      .select('*')
      .eq('company_id', companyId)
      .order('sort_order')
      .order('code');

    res.status(201).json({
      message: `${count} accounts added from "${tmpl.name}" overlay.`,
      added: count,
      accounts: accounts || [],
    });
  } catch (error) {
    console.error('Error applying template overlay:', error);
    res.status(500).json({ error: error.message || 'Failed to apply template overlay' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Supabase-based template provisioning helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instantiates a COA template into the accounts table for a company.
 * Safe to call multiple times — returns 0 if company already has accounts.
 * @returns {number} accounts inserted
 */
async function provisionFromTemplateSupabase(companyId, templateId = null) {
  // Check if company already has accounts
  const { count: existing } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if ((existing || 0) > 0) return 0;

  // Resolve template
  let tmplId = templateId;
  if (!tmplId) {
    const { data: dflt } = await supabase
      .from('coa_templates')
      .select('id')
      .eq('is_default', true)
      .order('id')
      .limit(1)
      .maybeSingle();
    if (!dflt) throw new Error('No default COA template found. Run ensureAccountingSchema first.');
    tmplId = dflt.id;
  }

  // Fetch template accounts
  const { data: tmplAccounts, error: taErr } = await supabase
    .from('coa_template_accounts')
    .select('*')
    .eq('template_id', tmplId)
    .order('sort_order')
    .order('code');
  if (taErr) throw taErr;
  if (!tmplAccounts || tmplAccounts.length === 0) {
    throw new Error(`COA template ${tmplId} has no accounts.`);
  }

  // Upsert accounts (ON CONFLICT company_id+code DO NOTHING)
  const rows = tmplAccounts.map(ta => ({
    company_id: companyId,
    code: ta.code,
    name: ta.name,
    type: ta.type,
    sub_type: ta.sub_type,
    reporting_group: ta.reporting_group,
    description: ta.description,
    sort_order: ta.sort_order,
    vat_code: ta.vat_code || null,
    is_active: true,
    is_system: false,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from('accounts')
    .upsert(rows, { onConflict: 'company_id,code', ignoreDuplicates: true })
    .select('id');
  if (insertErr) throw insertErr;

  const count = (inserted || []).length;

  // Record template assignment (idempotent)
  await supabase
    .from('company_template_assignments')
    .upsert(
      { company_id: companyId, template_id: tmplId, accounts_added: count },
      { onConflict: 'company_id,template_id' }
    );

  return count;
}

/**
 * Adds overlay template accounts to a company that already has a base COA.
 * Only adds accounts that don't already exist (ON CONFLICT DO NOTHING).
 * @returns {number} new accounts added
 */
async function applyTemplateOverlaySupabase(companyId, templateId) {
  // Verify company has accounts
  const { count: existing } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if ((existing || 0) === 0) {
    throw new Error('Cannot apply overlay: company has no base chart of accounts. Provision a base template first.');
  }

  // Fetch template accounts
  const { data: tmplAccounts, error: taErr } = await supabase
    .from('coa_template_accounts')
    .select('*')
    .eq('template_id', templateId)
    .order('sort_order')
    .order('code');
  if (taErr) throw taErr;
  if (!tmplAccounts || tmplAccounts.length === 0) {
    throw new Error(`COA template ${templateId} has no accounts.`);
  }

  const rows = tmplAccounts.map(ta => ({
    company_id: companyId,
    code: ta.code,
    name: ta.name,
    type: ta.type,
    sub_type: ta.sub_type,
    reporting_group: ta.reporting_group,
    description: ta.description,
    sort_order: ta.sort_order,
    vat_code: ta.vat_code || null,
    is_active: true,
    is_system: false,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from('accounts')
    .upsert(rows, { onConflict: 'company_id,code', ignoreDuplicates: true })
    .select('id');
  if (insertErr) throw insertErr;

  const count = (inserted || []).length;

  await supabase
    .from('company_template_assignments')
    .upsert(
      { company_id: companyId, template_id: templateId, accounts_added: count },
      { onConflict: 'company_id,template_id' }
    );

  return count;
}

module.exports = router;
