const express = require('express');
const crypto = require('crypto');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

// =====================================================
// API KEY AUTHENTICATION FOR EXTERNAL APPS
// =====================================================

/**
 * Middleware to authenticate external apps via API key
 * Expects header: X-Integration-Key: <api_key>
 */
const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-integration-key'];

    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key. Provide X-Integration-Key header.' });
    }

    // Hash the API key to compare with stored hash
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const result = await db.query(
      `SELECT i.*, c.name as company_name
       FROM integrations i
       JOIN companies c ON i.company_id = c.id
       WHERE i.api_key_hash = $1 AND i.is_active = true`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    const integration = result.rows[0];

    // Update last used timestamp
    await db.query(
      'UPDATE integrations SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [integration.id]
    );

    // Attach integration info to request
    req.integration = integration;
    req.companyId = integration.company_id;

    next();
  } catch (error) {
    console.error('API key authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// =====================================================
// INTERNAL API (Requires user authentication)
// =====================================================

/**
 * GET /api/integrations
 * List all integrations for the current company
 */
router.get('/', authenticate, hasPermission('company.view'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, type, description, config, is_active, created_at, last_used_at,
              (api_key_hash IS NOT NULL) as has_api_key
       FROM integrations
       WHERE company_id = $1
       ORDER BY name`,
      [req.user.companyId]
    );

    res.json({
      integrations: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ error: 'Failed to fetch integrations' });
  }
});

/**
 * GET /api/integrations/:id
 * Get a specific integration
 */
router.get('/:id', authenticate, hasPermission('company.view'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, type, description, config, is_active, created_at, last_used_at,
              (api_key_hash IS NOT NULL) as has_api_key
       FROM integrations
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Error fetching integration:', error);
    res.status(500).json({ error: 'Failed to fetch integration' });
  }
});

/**
 * POST /api/integrations
 * Create a new integration
 */
router.post('/', authenticate, hasPermission('company.edit'), async (req, res) => {
  const client = await db.getClient();

  try {
    const { name, type, description, config } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    await client.query('BEGIN');

    // Generate API key
    const apiKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const result = await client.query(
      `INSERT INTO integrations
       (company_id, name, type, description, config, api_key_hash, is_active, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, type, description, config, is_active, created_at`,
      [req.user.companyId, name, type, description, JSON.stringify(config || {}), apiKeyHash, true, req.user.id]
    );

    const integration = result.rows[0];

    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'INTEGRATION',
      integration.id,
      null,
      { name: integration.name, type: integration.type },
      'Integration created'
    );

    await client.query('COMMIT');

    // Return API key only on creation (it won't be retrievable later)
    res.status(201).json({
      integration,
      apiKey,
      message: 'Integration created. Save the API key - it will not be shown again.'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating integration:', error);
    res.status(500).json({ error: 'Failed to create integration' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/integrations/:id
 * Update an integration
 */
router.put('/:id', authenticate, hasPermission('company.edit'), async (req, res) => {
  const client = await db.getClient();

  try {
    const { name, description, config, is_active } = req.body;

    await client.query('BEGIN');

    // Verify integration exists
    const existing = await client.query(
      'SELECT * FROM integrations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Integration not found' });
    }

    const result = await client.query(
      `UPDATE integrations
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           config = COALESCE($3, config),
           is_active = COALESCE($4, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND company_id = $6
       RETURNING id, name, type, description, config, is_active, created_at, last_used_at`,
      [name, description, config ? JSON.stringify(config) : null, is_active, req.params.id, req.user.companyId]
    );

    await AuditLogger.logUserAction(
      req,
      'UPDATE',
      'INTEGRATION',
      req.params.id,
      existing.rows[0],
      result.rows[0],
      'Integration updated'
    );

    await client.query('COMMIT');

    res.json(result.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating integration:', error);
    res.status(500).json({ error: 'Failed to update integration' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/integrations/:id/regenerate-key
 * Regenerate API key for an integration
 */
router.post('/:id/regenerate-key', authenticate, hasPermission('company.edit'), async (req, res) => {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Verify integration exists
    const existing = await client.query(
      'SELECT * FROM integrations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Generate new API key
    const apiKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    await client.query(
      'UPDATE integrations SET api_key_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [apiKeyHash, req.params.id]
    );

    await AuditLogger.logUserAction(
      req,
      'REGENERATE_KEY',
      'INTEGRATION',
      req.params.id,
      null,
      { name: existing.rows[0].name },
      'Integration API key regenerated'
    );

    await client.query('COMMIT');

    res.json({
      apiKey,
      message: 'API key regenerated. Save it - it will not be shown again.'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error regenerating API key:', error);
    res.status(500).json({ error: 'Failed to regenerate API key' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/integrations/:id
 * Delete an integration
 */
router.delete('/:id', authenticate, hasPermission('company.edit'), async (req, res) => {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT * FROM integrations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Integration not found' });
    }

    await client.query(
      'DELETE FROM integrations WHERE id = $1',
      [req.params.id]
    );

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'INTEGRATION',
      req.params.id,
      existing.rows[0],
      null,
      'Integration deleted'
    );

    await client.query('COMMIT');

    res.json({ message: 'Integration deleted successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting integration:', error);
    res.status(500).json({ error: 'Failed to delete integration' });
  } finally {
    client.release();
  }
});

// =====================================================
// EXTERNAL API (Requires API key authentication)
// =====================================================

/**
 * GET /api/integrations/external/accounts
 * Get chart of accounts for the integration's company
 * External apps use this to map their accounts
 */
router.get('/external/accounts', authenticateApiKey, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, code, name, type, description, is_active
       FROM accounts
       WHERE company_id = $1 AND is_active = true
       ORDER BY code`,
      [req.companyId]
    );

    res.json({
      accounts: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching accounts for integration:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

/**
 * GET /api/integrations/external/status
 * Check integration status and configuration
 */
router.get('/external/status', authenticateApiKey, async (req, res) => {
  try {
    res.json({
      status: 'connected',
      integration: {
        id: req.integration.id,
        name: req.integration.name,
        type: req.integration.type,
        company: req.integration.company_name
      },
      config: JSON.parse(req.integration.config || '{}')
    });

  } catch (error) {
    console.error('Error fetching integration status:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

/**
 * POST /api/integrations/external/transactions
 * Post transactions from external app
 * This creates journal entries and optionally bank transactions
 */
router.post('/external/transactions', authenticateApiKey, async (req, res) => {
  const client = await db.getClient();

  try {
    const { transactions } = req.body;

    if (!transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'Transactions array is required' });
    }

    await client.query('BEGIN');

    const results = [];
    const config = JSON.parse(req.integration.config || '{}');

    for (const txn of transactions) {
      const {
        date,
        reference,
        description,
        amount,
        type, // 'sale', 'refund', 'payment', 'expense'
        vatInclusive = true,
        vatRate = 15,
        accountId, // Override default account mapping
        externalId, // External system's transaction ID
        metadata = {}
      } = txn;

      // Validate required fields
      if (!date || !description || amount === undefined || !type) {
        results.push({
          externalId,
          success: false,
          error: 'Missing required fields: date, description, amount, type'
        });
        continue;
      }

      // Check for duplicate using external ID
      if (externalId) {
        const existing = await client.query(
          `SELECT id FROM integration_transactions
           WHERE integration_id = $1 AND external_id = $2`,
          [req.integration.id, externalId]
        );

        if (existing.rows.length > 0) {
          results.push({
            externalId,
            success: false,
            error: 'Transaction already imported',
            existingId: existing.rows[0].id
          });
          continue;
        }
      }

      // Determine accounts based on type and config
      let targetAccountId = accountId;
      let bankAccountId = config.defaultBankAccountId;
      let vatAccountId = config.vatOutputAccountId || config.vatInputAccountId;

      // Use configured defaults if no account specified
      if (!targetAccountId) {
        switch (type) {
          case 'sale':
            targetAccountId = config.salesAccountId;
            vatAccountId = config.vatOutputAccountId;
            break;
          case 'refund':
            targetAccountId = config.salesAccountId;
            vatAccountId = config.vatOutputAccountId;
            break;
          case 'expense':
            targetAccountId = accountId || config.defaultExpenseAccountId;
            vatAccountId = config.vatInputAccountId;
            break;
          case 'payment':
            targetAccountId = config.defaultBankAccountId;
            break;
        }
      }

      if (!targetAccountId) {
        results.push({
          externalId,
          success: false,
          error: `No account configured for type: ${type}`
        });
        continue;
      }

      // Calculate VAT if applicable
      let netAmount = parseFloat(amount);
      let vatAmount = 0;

      if (vatInclusive && vatRate > 0 && type !== 'payment') {
        vatAmount = netAmount * vatRate / (100 + vatRate);
        netAmount = netAmount - vatAmount;
      }

      // Build journal lines based on transaction type
      const journalLines = [];

      if (type === 'sale') {
        // Sale: Debit Bank, Credit Revenue, Credit VAT
        journalLines.push({
          accountId: bankAccountId,
          debit: parseFloat(amount),
          credit: 0,
          description: `${req.integration.name}: ${description}`
        });
        journalLines.push({
          accountId: targetAccountId,
          debit: 0,
          credit: netAmount,
          description: description
        });
        if (vatAmount > 0 && vatAccountId) {
          journalLines.push({
            accountId: vatAccountId,
            debit: 0,
            credit: vatAmount,
            description: `VAT on ${description}`
          });
        }
      } else if (type === 'refund') {
        // Refund: Credit Bank, Debit Revenue, Debit VAT
        journalLines.push({
          accountId: bankAccountId,
          debit: 0,
          credit: parseFloat(amount),
          description: `${req.integration.name} Refund: ${description}`
        });
        journalLines.push({
          accountId: targetAccountId,
          debit: netAmount,
          credit: 0,
          description: `Refund: ${description}`
        });
        if (vatAmount > 0 && vatAccountId) {
          journalLines.push({
            accountId: vatAccountId,
            debit: vatAmount,
            credit: 0,
            description: `VAT on refund: ${description}`
          });
        }
      } else if (type === 'expense') {
        // Expense: Debit Expense, Debit VAT Input, Credit Bank
        journalLines.push({
          accountId: targetAccountId,
          debit: netAmount,
          credit: 0,
          description: description
        });
        if (vatAmount > 0 && vatAccountId) {
          journalLines.push({
            accountId: vatAccountId,
            debit: vatAmount,
            credit: 0,
            description: `VAT on ${description}`
          });
        }
        journalLines.push({
          accountId: bankAccountId,
          debit: 0,
          credit: parseFloat(amount),
          description: `${req.integration.name}: ${description}`
        });
      } else if (type === 'payment') {
        // Payment received: Debit Bank, Credit Receivables
        journalLines.push({
          accountId: bankAccountId,
          debit: parseFloat(amount),
          credit: 0,
          description: `${req.integration.name}: ${description}`
        });
        journalLines.push({
          accountId: targetAccountId,
          debit: 0,
          credit: parseFloat(amount),
          description: description
        });
      }

      // Create journal entry
      try {
        const journal = await JournalService.createJournal(client, {
          companyId: req.companyId,
          date,
          reference: reference || `${req.integration.name}-${externalId || Date.now()}`,
          description: `${req.integration.name}: ${description}`,
          sourceType: 'integration',
          lines: journalLines,
          metadata: {
            integrationId: req.integration.id,
            integrationType: req.integration.type,
            externalId,
            ...metadata
          }
        });

        // Record the integration transaction
        await client.query(
          `INSERT INTO integration_transactions
           (company_id, integration_id, external_id, journal_id, type, amount, vat_amount, description, raw_data, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            req.companyId,
            req.integration.id,
            externalId,
            journal.id,
            type,
            amount,
            vatAmount,
            description,
            JSON.stringify(txn),
            'posted'
          ]
        );

        results.push({
          externalId,
          success: true,
          journalId: journal.id,
          netAmount,
          vatAmount
        });

      } catch (journalError) {
        results.push({
          externalId,
          success: false,
          error: journalError.message
        });
      }
    }

    await client.query('COMMIT');

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    res.status(successCount > 0 ? 201 : 400).json({
      message: `Processed ${transactions.length} transactions: ${successCount} succeeded, ${failCount} failed`,
      results
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing integration transactions:', error);
    res.status(500).json({ error: 'Failed to process transactions' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/integrations/external/transactions
 * Get transactions posted by this integration
 */
router.get('/external/transactions', authenticateApiKey, async (req, res) => {
  try {
    const { fromDate, toDate, status, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT it.*, j.reference as journal_reference, j.date as journal_date
      FROM integration_transactions it
      LEFT JOIN journals j ON it.journal_id = j.id
      WHERE it.integration_id = $1
    `;
    const params = [req.integration.id];
    let paramCount = 2;

    if (fromDate) {
      query += ` AND it.created_at >= $${paramCount}`;
      params.push(fromDate);
      paramCount++;
    }

    if (toDate) {
      query += ` AND it.created_at <= $${paramCount}`;
      params.push(toDate);
      paramCount++;
    }

    if (status) {
      query += ` AND it.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ` ORDER BY it.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      transactions: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching integration transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

/**
 * POST /api/integrations/external/webhook
 * Webhook endpoint for external apps to push events
 */
router.post('/external/webhook', authenticateApiKey, async (req, res) => {
  try {
    const { event, data } = req.body;

    if (!event) {
      return res.status(400).json({ error: 'Event type is required' });
    }

    // Log the webhook
    await db.query(
      `INSERT INTO integration_webhooks (integration_id, event_type, payload, status)
       VALUES ($1, $2, $3, $4)`,
      [req.integration.id, event, JSON.stringify(data || {}), 'received']
    );

    // Process based on event type
    switch (event) {
      case 'transaction.created':
      case 'sale.completed':
        // Auto-process if configured
        const config = JSON.parse(req.integration.config || '{}');
        if (config.autoSync && data) {
          // Queue for processing
          res.json({
            status: 'queued',
            message: 'Transaction queued for processing'
          });
          return;
        }
        break;

      case 'test':
        // Test webhook
        res.json({
          status: 'ok',
          message: 'Webhook received successfully',
          integration: req.integration.name
        });
        return;

      default:
        // Unknown event - just acknowledge
        break;
    }

    res.json({
      status: 'received',
      event
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

module.exports = router;
