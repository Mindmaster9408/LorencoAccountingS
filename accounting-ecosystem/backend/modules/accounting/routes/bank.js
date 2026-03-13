const express = require('express');
const db = require('../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Configure multer for file uploads
const uploadDir = path.join(__dirname, '../../../uploads/accounting/bank_attachments');

// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'attachment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  },
  fileFilter: function (req, file, cb) {
    // Accept images, PDFs, and common office documents
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|csv|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv', 'text/plain'
    ];
    const mimeOk = allowedMimeTypes.includes(file.mimetype);

    if (mimeOk || extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: images, PDF, DOC, XLS, CSV, TXT'));
    }
  }
});

/**
 * GET /api/bank/accounts
 * List bank accounts
 */
router.get('/accounts', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ba.*, a.code as ledger_account_code, a.name as ledger_account_name
       FROM bank_accounts ba
       LEFT JOIN accounts a ON ba.ledger_account_id = a.id
       WHERE ba.company_id = $1
       ORDER BY ba.name`,
      [req.user.companyId]
    );

    res.json({
      bankAccounts: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ error: 'Failed to fetch bank accounts' });
  }
});

/**
 * POST /api/bank/accounts
 * Create a new bank account
 */
router.post('/accounts', authenticate, hasPermission('bank.manage'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { name, bankName, accountNumberMasked, currency = 'ZAR', ledgerAccountId, openingBalance = 0, openingBalanceDate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO bank_accounts 
       (company_id, name, bank_name, account_number_masked, currency, ledger_account_id, opening_balance, opening_balance_date, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.companyId, name, bankName, accountNumberMasked, currency, ledgerAccountId, openingBalance, openingBalanceDate, true]
    );

    const bankAccount = result.rows[0];

    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'BANK_ACCOUNT',
      bankAccount.id,
      null,
      { name: bankAccount.name, bankName: bankAccount.bank_name },
      'Bank account created'
    );

    await client.query('COMMIT');

    res.status(201).json(bankAccount);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating bank account:', error);
    res.status(500).json({ error: 'Failed to create bank account' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/bank/transactions
 * List bank transactions
 */
router.get('/transactions', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const { bankAccountId, status, fromDate, toDate, limit = 100, offset = 0 } = req.query;
    
    let query = `
      SELECT bt.*, ba.name as bank_account_name
      FROM bank_transactions bt
      JOIN bank_accounts ba ON bt.bank_account_id = ba.id
      WHERE bt.company_id = $1
    `;
    const params = [req.user.companyId];
    let paramCount = 2;

    if (bankAccountId) {
      query += ` AND bt.bank_account_id = $${paramCount}`;
      params.push(bankAccountId);
      paramCount++;
    }

    if (status) {
      query += ` AND bt.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (fromDate) {
      query += ` AND bt.date >= $${paramCount}`;
      params.push(fromDate);
      paramCount++;
    }

    if (toDate) {
      query += ` AND bt.date <= $${paramCount}`;
      params.push(toDate);
      paramCount++;
    }

    query += ` ORDER BY bt.date DESC, bt.id DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      transactions: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching bank transactions:', error);
    res.status(500).json({ error: 'Failed to fetch bank transactions' });
  }
});

/**
 * POST /api/bank/import
 * Import bank transactions from CSV
 */
router.post('/import', authenticate, hasPermission('bank.import'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { bankAccountId, transactions } = req.body;

    if (!bankAccountId || !transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'Bank account ID and transactions array are required' });
    }

    await client.query('BEGIN');

    // Verify bank account exists
    const bankAccountCheck = await client.query(
      'SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2',
      [bankAccountId, req.user.companyId]
    );

    if (bankAccountCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const importedTransactions = [];

    for (const txn of transactions) {
      const { date, description, amount, reference, externalId, balance } = txn;

      // Check if already imported (by external ID)
      if (externalId) {
        const existingCheck = await client.query(
          'SELECT id FROM bank_transactions WHERE bank_account_id = $1 AND external_id = $2',
          [bankAccountId, externalId]
        );

        if (existingCheck.rows.length > 0) {
          continue; // Skip duplicates
        }
      }

      const result = await client.query(
        `INSERT INTO bank_transactions 
         (company_id, bank_account_id, date, description, amount, balance, reference, external_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [req.user.companyId, bankAccountId, date, description, amount, balance, reference, externalId, 'unmatched']
      );

      importedTransactions.push(result.rows[0]);
    }

    await AuditLogger.logUserAction(
      req,
      'IMPORT',
      'BANK_TRANSACTIONS',
      bankAccountId,
      null,
      { count: importedTransactions.length },
      'Bank transactions imported'
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Bank transactions imported successfully',
      imported: importedTransactions.length,
      transactions: importedTransactions
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error importing bank transactions:', error);
    res.status(500).json({ error: 'Failed to import bank transactions' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/bank/transactions/:id/allocate
 * Allocate bank transaction to create a draft journal
 */
router.post('/transactions/:id/allocate', authenticate, hasPermission('bank.allocate'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { lines, description } = req.body;

    if (!lines || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'Lines array is required' });
    }

    await client.query('BEGIN');

    // Get bank transaction
    const txnResult = await client.query(
      `SELECT bt.*, ba.ledger_account_id, ba.name as bank_account_name
       FROM bank_transactions bt
       JOIN bank_accounts ba ON bt.bank_account_id = ba.id
       WHERE bt.id = $1 AND bt.company_id = $2`,
      [req.params.id, req.user.companyId]
    );

    if (txnResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    const bankTxn = txnResult.rows[0];

    if (bankTxn.status !== 'unmatched') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Transaction already allocated' });
    }

    if (!bankTxn.ledger_account_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bank account has no linked ledger account' });
    }

    // Build journal lines (bank account + user-specified allocations)
    const journalLines = [];
    
    if (bankTxn.amount > 0) {
      // Money in: Debit bank account
      journalLines.push({
        accountId: bankTxn.ledger_account_id,
        debit: Math.abs(bankTxn.amount),
        credit: 0,
        description: `Bank: ${bankTxn.description}`
      });
      
      // Credits to other accounts
      lines.forEach(line => {
        journalLines.push({
          accountId: line.accountId,
          debit: 0,
          credit: line.amount,
          description: line.description || bankTxn.description
        });
      });
    } else {
      // Money out: Credit bank account
      journalLines.push({
        accountId: bankTxn.ledger_account_id,
        debit: 0,
        credit: Math.abs(bankTxn.amount),
        description: `Bank: ${bankTxn.description}`
      });
      
      // Debits to other accounts
      lines.forEach(line => {
        journalLines.push({
          accountId: line.accountId,
          debit: line.amount,
          credit: 0,
          description: line.description || bankTxn.description
        });
      });
    }

    // Create draft journal
    const journal = await JournalService.createDraftJournal(client, {
      companyId: req.user.companyId,
      date: bankTxn.date,
      reference: bankTxn.reference,
      description: description || `Bank: ${bankTxn.description}`,
      sourceType: 'bank',
      createdByUserId: req.user.id,
      lines: journalLines,
      metadata: { bankTransactionId: bankTxn.id }
    });

    // Mark transaction as matched
    await client.query(
      `UPDATE bank_transactions 
       SET status = 'matched', matched_entity_type = 'JOURNAL', matched_entity_id = $1, matched_by_user_id = $2
       WHERE id = $3`,
      [journal.id, req.user.id, bankTxn.id]
    );

    await AuditLogger.logUserAction(
      req,
      'ALLOCATE',
      'BANK_TRANSACTION',
      bankTxn.id,
      { status: 'unmatched' },
      { status: 'matched', journalId: journal.id },
      'Bank transaction allocated to journal'
    );

    await client.query('COMMIT');

    const fullJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);

    res.status(201).json({
      message: 'Bank transaction allocated successfully',
      journal: fullJournal
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error allocating bank transaction:', error);
    res.status(400).json({ error: error.message || 'Failed to allocate bank transaction' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/bank/reconcile
 * Mark transactions as reconciled
 */
router.post('/reconcile', authenticate, hasPermission('bank.reconcile'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { transactionIds } = req.body;

    if (!transactionIds || !Array.isArray(transactionIds)) {
      return res.status(400).json({ error: 'Transaction IDs array is required' });
    }

    await client.query('BEGIN');

    for (const txnId of transactionIds) {
      await client.query(
        `UPDATE bank_transactions 
         SET status = 'reconciled', reconciled_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2 AND status = 'matched'`,
        [txnId, req.user.companyId]
      );
    }

    await AuditLogger.logUserAction(
      req,
      'RECONCILE',
      'BANK_TRANSACTIONS',
      null,
      null,
      { transactionIds, count: transactionIds.length },
      'Bank transactions reconciled'
    );

    await client.query('COMMIT');

    res.json({
      message: 'Transactions reconciled successfully',
      count: transactionIds.length
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error reconciling transactions:', error);
    res.status(500).json({ error: 'Failed to reconcile transactions' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/bank/transactions/:id/attachments
 * Upload attachment for a bank transaction
 */
router.post('/transactions/:id/attachments', authenticate, hasPermission('bank.manage'), upload.single('file'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    await client.query('BEGIN');

    // Verify transaction exists and belongs to user's company
    const txnCheck = await client.query(
      'SELECT id FROM bank_transactions WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (txnCheck.rows.length === 0) {
      // Delete uploaded file
      fs.unlinkSync(req.file.path);
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    // Save attachment record
    const result = await client.query(
      `INSERT INTO bank_transaction_attachments 
       (company_id, bank_transaction_id, filename, original_filename, file_path, file_size, mime_type, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user.companyId,
        req.params.id,
        req.file.filename,
        req.file.originalname,
        req.file.path,
        req.file.size,
        req.file.mimetype,
        req.user.id
      ]
    );

    await AuditLogger.logUserAction(
      req,
      'UPLOAD',
      'BANK_TRANSACTION_ATTACHMENT',
      result.rows[0].id,
      null,
      { filename: req.file.originalname, transactionId: req.params.id },
      'Attachment uploaded to bank transaction'
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Attachment uploaded successfully',
      attachment: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    // Delete uploaded file if database operation failed
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading attachment:', error);
    res.status(500).json({ error: error.message || 'Failed to upload attachment' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/bank/transactions/:id/attachments
 * Get all attachments for a bank transaction
 */
router.get('/transactions/:id/attachments', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, u.email as uploaded_by_email, u.first_name, u.last_name
       FROM bank_transaction_attachments a
       LEFT JOIN users u ON a.uploaded_by_user_id = u.id
       WHERE a.bank_transaction_id = $1 AND a.company_id = $2
       ORDER BY a.created_at DESC`,
      [req.params.id, req.user.companyId]
    );

    res.json({
      attachments: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching attachments:', error);
    res.status(500).json({ error: 'Failed to fetch attachments' });
  }
});

/**
 * GET /api/bank/attachments/:attachmentId/download
 * Download an attachment
 */
router.get('/attachments/:attachmentId/download', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM bank_transaction_attachments 
       WHERE id = $1 AND company_id = $2`,
      [req.params.attachmentId, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = result.rows[0];

    if (!fs.existsSync(attachment.file_path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(attachment.file_path, attachment.original_filename);

  } catch (error) {
    console.error('Error downloading attachment:', error);
    res.status(500).json({ error: 'Failed to download attachment' });
  }
});

/**
 * DELETE /api/bank/attachments/:attachmentId
 * Delete an attachment
 */
router.delete('/attachments/:attachmentId', authenticate, hasPermission('bank.manage'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM bank_transaction_attachments 
       WHERE id = $1 AND company_id = $2`,
      [req.params.attachmentId, req.user.companyId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = result.rows[0];

    // Delete from database
    await client.query(
      'DELETE FROM bank_transaction_attachments WHERE id = $1',
      [req.params.attachmentId]
    );

    // Delete file from disk
    if (fs.existsSync(attachment.file_path)) {
      fs.unlinkSync(attachment.file_path);
    }

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'BANK_TRANSACTION_ATTACHMENT',
      req.params.attachmentId,
      { filename: attachment.original_filename },
      null,
      'Attachment deleted from bank transaction'
    );

    await client.query('COMMIT');

    res.json({
      message: 'Attachment deleted successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/bank/transactions/:id
 * Delete a bank transaction.
 * Rules:
 *   - Status 'reconciled'  → always blocked (must reverse reconciliation first)
 *   - Status 'matched'     → blocked unless ?force=1  (leaves journal entry orphaned — caller's responsibility)
 *   - Attachments are deleted from disk and DB before the transaction row is removed.
 */
router.delete('/transactions/:id', authenticate, hasPermission('bank.manage'), async (req, res) => {
  const { id } = req.params;
  const forceDelete = req.query.force === '1';
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Fetch and ownership-check the transaction
    const txnResult = await client.query(
      `SELECT * FROM bank_transactions WHERE id = $1 AND company_id = $2`,
      [id, req.user.companyId]
    );

    if (txnResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const txn = txnResult.rows[0];

    if (txn.status === 'reconciled') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Cannot delete a reconciled transaction. Reverse the reconciliation first.',
        code: 'RECONCILED'
      });
    }

    if (txn.status === 'matched' && !forceDelete) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Transaction is allocated to a journal entry. Add ?force=1 to confirm deletion.',
        code: 'ALLOCATED',
        journalRef: txn.matched_entity_id
      });
    }

    // Delete attachments from disk first, then DB
    const attachResult = await client.query(
      `SELECT * FROM bank_transaction_attachments WHERE transaction_id = $1`,
      [id]
    );

    for (const att of attachResult.rows) {
      if (att.file_path && fs.existsSync(att.file_path)) {
        try { fs.unlinkSync(att.file_path); } catch (_) { /* non-fatal */ }
      }
    }

    await client.query(
      `DELETE FROM bank_transaction_attachments WHERE transaction_id = $1`,
      [id]
    );

    // Delete the transaction
    await client.query(
      `DELETE FROM bank_transactions WHERE id = $1 AND company_id = $2`,
      [id, req.user.companyId]
    );

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'BANK_TRANSACTION',
      id,
      { description: txn.description, amount: txn.amount, status: txn.status, date: txn.date },
      null,
      forceDelete && txn.status === 'matched'
        ? 'Bank transaction force-deleted (was allocated to journal)'
        : 'Bank transaction deleted'
    );

    await client.query('COMMIT');

    res.json({ success: true, message: 'Transaction deleted' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting bank transaction:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  } finally {
    client.release();
  }
});

module.exports = router;
