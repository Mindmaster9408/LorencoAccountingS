const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission, enforceCompanyScope } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');
const { seedDefaultAccounts } = require('../../../config/accounting-schema');

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
    const { code, name, type, parentId, description } = req.body;

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
      `INSERT INTO accounts (company_id, code, name, type, parent_id, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.companyId, code, name, type, parentId || null, description || null, true]
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
    const { name, description, isActive } = req.body;

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

    // Update account
    const result = await client.query(
      `UPDATE accounts 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           is_active = COALESCE($3, is_active)
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [name, description, isActive, req.params.id, req.user.companyId]
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
 */
router.post('/provision-defaults', authenticate, hasPermission('account.create'), async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const count = await seedDefaultAccounts(req.user.companyId, client);
    await client.query('COMMIT');

    if (count === 0) {
      return res.json({ message: 'Chart of accounts already exists — no changes made.', seeded: false });
    }

    // Return the newly seeded accounts
    const result = await db.query(
      'SELECT * FROM accounts WHERE company_id = $1 ORDER BY code',
      [req.user.companyId]
    );
    res.status(201).json({ message: `${count} default accounts created.`, seeded: true, accounts: result.rows });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error seeding default accounts:', error);
    res.status(500).json({ error: 'Failed to provision default accounts' });
  } finally {
    client.release();
  }
});

module.exports = router;
