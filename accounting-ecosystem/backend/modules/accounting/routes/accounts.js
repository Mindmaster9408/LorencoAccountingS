const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission, enforceCompanyScope } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');
const { seedDefaultAccounts, provisionFromTemplate, applyTemplateOverlay, getDefaultTemplate } = require('../../../config/accounting-schema');

const router = express.Router();

/**
 * GET /api/accounts
 * List all accounts for the company
 */
router.get('/', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const { type, isActive, includeInactive } = req.query;
    
    let query = 'SELECT * FROM accounts WHERE company_id = $1';
    const params = [req.user.companyId];
    let paramCount = 2;

    if (type) {
      query += ` AND type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (isActive !== undefined || !includeInactive) {
      const activeFilter = isActive === 'false' ? false : true;
      query += ` AND is_active = $${paramCount}`;
      params.push(activeFilter);
      paramCount++;
    }

    query += ' ORDER BY code';

    const result = await db.query(query, params);

    res.json({
      accounts: result.rows,
      count: result.rows.length
    });

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
    const tmplResult = await db.query(
      `SELECT t.*,
              COUNT(ta.id)::int AS account_count,
              cta.applied_at,
              cta.accounts_added
       FROM coa_templates t
       LEFT JOIN coa_template_accounts ta ON ta.template_id = t.id
       LEFT JOIN company_template_assignments cta
              ON cta.template_id = t.id AND cta.company_id = $1
       GROUP BY t.id, cta.applied_at, cta.accounts_added
       ORDER BY t.is_default DESC, t.parent_template_id NULLS FIRST, t.name`,
      [req.user.companyId]
    );
    res.json({ templates: tmplResult.rows });
  } catch (error) {
    console.error('Error fetching COA templates:', error);
    res.status(500).json({ error: 'Failed to fetch COA templates' });
  }
});

/**
 * GET /api/accounts/templates/:id/accounts
 * Preview accounts inside a specific template (before provisioning/applying overlay).
 */
router.get('/templates/:id/accounts', authenticate, hasPermission('account.view'), async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    if (isNaN(templateId)) return res.status(400).json({ error: 'Invalid templateId' });

    const tmpl = await db.query(
      `SELECT t.*, p.name AS parent_name
       FROM coa_templates t
       LEFT JOIN coa_templates p ON p.id = t.parent_template_id
       WHERE t.id = $1`,
      [templateId]
    );
    if (tmpl.rows.length === 0) return res.status(404).json({ error: 'Template not found' });

    const accounts = await db.query(
      `SELECT * FROM coa_template_accounts WHERE template_id = $1 ORDER BY sort_order, code`,
      [templateId]
    );

    res.json({ template: tmpl.rows[0], accounts: accounts.rows });
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
    const result = await db.query(
      'SELECT * FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(result.rows[0]);

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
  const client = await db.getClient();
  
  try {
    const { code, name, type, parentId, description, subType, reportingGroup, sortOrder, vatCode } = req.body;

    // Validation
    if (!code || !name || !type) {
      return res.status(400).json({ error: 'Code, name, and type are required' });
    }

    const validTypes = ['asset', 'liability', 'equity', 'income', 'expense'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }

    await client.query('BEGIN');

    // Check if code already exists
    const codeCheck = await client.query(
      'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
      [req.user.companyId, code]
    );

    if (codeCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Account code already exists' });
    }

    // Create account
    const result = await client.query(
      `INSERT INTO accounts
         (company_id, code, name, type, parent_id, description, sub_type,
          reporting_group, sort_order, vat_code, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       RETURNING *`,
      [
        req.user.companyId, code, name, type, parentId || null, description || null,
        subType || null, reportingGroup || null,
        sortOrder != null ? parseInt(sortOrder) : parseInt(code) || 0,
        vatCode || null,
      ]
    );

    const account = result.rows[0];

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'ACCOUNT',
      account.id,
      null,
      { code: account.code, name: account.name, type: account.type },
      'Account created'
    );

    await client.query('COMMIT');

    res.status(201).json(account);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating account:', error);
    res.status(500).json({ error: 'Failed to create account' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/accounts/:id
 * Update an account
 */
router.put('/:id', authenticate, hasPermission('account.edit'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { name, description, isActive, subType, reportingGroup, sortOrder, vatCode } = req.body;

    await client.query('BEGIN');

    // Get existing account
    const existing = await client.query(
      'SELECT * FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }

    const beforeData = existing.rows[0];

    // Don't allow editing system accounts
    if (beforeData.is_system) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot edit system accounts' });
    }

    // Update account (code and type are immutable)
    const result = await client.query(
      `UPDATE accounts
       SET name            = COALESCE($1, name),
           description     = COALESCE($2, description),
           is_active       = COALESCE($3, is_active),
           sub_type        = COALESCE($4, sub_type),
           reporting_group = COALESCE($5, reporting_group),
           sort_order      = COALESCE($6, sort_order),
           vat_code        = COALESCE($7, vat_code),
           updated_at      = NOW()
       WHERE id = $8 AND company_id = $9
       RETURNING *`,
      [
        name, description, isActive,
        subType || null, reportingGroup || null,
        sortOrder != null ? parseInt(sortOrder) : null,
        vatCode || null,
        req.params.id, req.user.companyId,
      ]
    );

    const account = result.rows[0];

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'UPDATE',
      'ACCOUNT',
      account.id,
      { name: beforeData.name, description: beforeData.description, isActive: beforeData.is_active },
      { name: account.name, description: account.description, isActive: account.is_active },
      'Account updated'
    );

    await client.query('COMMIT');

    res.json(account);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating account:', error);
    res.status(500).json({ error: 'Failed to update account' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/accounts/:id
 * Soft delete (deactivate) an account
 */
router.delete('/:id', authenticate, hasPermission('account.delete'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    // Get existing account
    const existing = await client.query(
      'SELECT * FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = existing.rows[0];

    // Don't allow deleting system accounts
    if (account.is_system) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot delete system accounts' });
    }

    // Check if account is used in any posted journals
    const usageCheck = await client.query(
      `SELECT COUNT(*) as count
       FROM journal_lines jl
       JOIN journals j ON jl.journal_id = j.id
       WHERE jl.account_id = $1 AND j.status = 'posted'`,
      [req.params.id]
    );

    if (parseInt(usageCheck.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Cannot delete account with posted transactions. Consider deactivating instead.' 
      });
    }

    // Soft delete (deactivate)
    await client.query(
      'UPDATE accounts SET is_active = false WHERE id = $1',
      [req.params.id]
    );

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'ACCOUNT',
      account.id,
      { code: account.code, name: account.name, isActive: true },
      { code: account.code, name: account.name, isActive: false },
      'Account deactivated'
    );

    await client.query('COMMIT');

    res.json({ message: 'Account deactivated successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/accounts/provision-defaults
 * Seeds the standard SA chart of accounts for this company (safe if already has accounts).
 * Delegates to provisionFromTemplate using the default template.
 */
router.post('/provision-defaults', authenticate, hasPermission('account.create'), async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const count = await provisionFromTemplate(req.user.companyId, client);
    await client.query('COMMIT');

    if (count === 0) {
      return res.json({ message: 'Chart of accounts already exists — no changes made.', seeded: false });
    }

    const result = await db.query(
      'SELECT * FROM accounts WHERE company_id = $1 ORDER BY sort_order, code',
      [req.user.companyId]
    );
    res.status(201).json({ message: `${count} accounts provisioned from Standard SA Base template.`, seeded: true, accounts: result.rows });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error provisioning default accounts:', error);
    res.status(500).json({ error: 'Failed to provision default accounts' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/accounts/provision-from-template/:templateId
 * Provisions a specific COA template for this company.
 * Only allowed if the company has no accounts yet.
 */
router.post('/provision-from-template/:templateId', authenticate, hasPermission('account.create'), async (req, res) => {
  const client = await db.getClient();
  try {
    const templateId = parseInt(req.params.templateId);
    if (isNaN(templateId)) {
      return res.status(400).json({ error: 'Invalid templateId' });
    }

    // Verify template exists
    const tmplCheck = await db.query(
      'SELECT id, name FROM coa_templates WHERE id = $1',
      [templateId]
    );
    if (tmplCheck.rows.length === 0) {
      return res.status(404).json({ error: 'COA template not found' });
    }

    await client.query('BEGIN');
    const count = await provisionFromTemplate(req.user.companyId, client, templateId);
    await client.query('COMMIT');

    if (count === 0) {
      return res.json({ message: 'Chart of accounts already exists — no changes made.', seeded: false });
    }

    const result = await db.query(
      'SELECT * FROM accounts WHERE company_id = $1 ORDER BY sort_order, code',
      [req.user.companyId]
    );
    res.status(201).json({
      message: `${count} accounts provisioned from "${tmplCheck.rows[0].name}" template.`,
      seeded: true,
      accounts: result.rows,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error provisioning from template:', error);
    res.status(500).json({ error: 'Failed to provision accounts from template' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/accounts/apply-overlay/:templateId
 * Applies an industry overlay template to a company that already has a base COA.
 * Only adds accounts that don't already exist (ON CONFLICT DO NOTHING).
 */
router.post('/apply-overlay/:templateId', authenticate, hasPermission('account.create'), async (req, res) => {
  const client = await db.getClient();
  try {
    const templateId = parseInt(req.params.templateId);
    if (isNaN(templateId)) return res.status(400).json({ error: 'Invalid templateId' });

    // Verify template exists
    const tmpl = await db.query(
      `SELECT id, name, parent_template_id FROM coa_templates WHERE id = $1`,
      [templateId]
    );
    if (tmpl.rows.length === 0) return res.status(404).json({ error: 'COA template not found' });

    await client.query('BEGIN');
    const count = await applyTemplateOverlay(req.user.companyId, client, templateId);
    await client.query('COMMIT');

    const result = await db.query(
      'SELECT * FROM accounts WHERE company_id = $1 ORDER BY sort_order, code',
      [req.user.companyId]
    );

    res.status(201).json({
      message: `${count} accounts added from "${tmpl.rows[0].name}" overlay.`,
      added: count,
      accounts: result.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error applying template overlay:', error);
    res.status(500).json({ error: error.message || 'Failed to apply template overlay' });
  } finally {
    client.release();
  }
});

module.exports = router;
