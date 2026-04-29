'use strict';

/**
 * ============================================================================
 * Bank Staging Routes
 * ============================================================================
 * Mounted at /api/accounting/bank/staging (via index.js)
 *
 * These routes manage the pre-confirmation staging pipeline for imported
 * bank transactions. No GL impact until confirmation.
 *
 * Route summary:
 *   POST   /import        — stage a batch of parsed transactions
 *   GET    /              — list staged transactions (with filters)
 *   GET    /batches       — list import batches with summary stats
 *   POST   /detect-transfers — run transfer detection on a batch
 *   POST   /confirm       — confirm staged rows → bank_transactions
 *   PATCH  /:id/reject    — reject a staged transaction
 *   POST   /transfers/:linkId/confirm — confirm transfer pair, create journal
 * ============================================================================
 */

const express = require('express');
const router  = express.Router();

const { authenticate, hasPermission } = require('../middleware/auth');
const { supabase }     = require('../../../config/database');
const AuditLogger      = require('../services/auditLogger');
const BankStagingService = require('../services/bankStagingService');
const { v4: uuidv4 }   = require('uuid');


/**
 * POST /api/accounting/bank/staging/import
 * Stage a batch of transactions from a parsed PDF/image result.
 *
 * Body:
 *   bankAccountId    {number|null}  — resolved bank account (null = not yet matched)
 *   transactions     {Array}        — ReviewTransaction[] from PdfStatementImportService
 *   importSource     {string}       — 'pdf'|'image'
 *   importBatchId    {string}       — optional UUID (generated if omitted)
 *   runDetection     {boolean}      — run transfer detection immediately (default true)
 *
 * Response 201:
 *   { batchId, staged, skipped, transfersDetected, links }
 */
router.post('/import',
  authenticate,
  hasPermission('bank.import'),
  async (req, res) => {
    try {
      const {
        bankAccountId,
        transactions,
        importSource  = 'pdf',
        importBatchId,
        runDetection  = true,
      } = req.body;

      if (!Array.isArray(transactions) || transactions.length === 0) {
        return res.status(400).json({ error: 'transactions[] is required and must be non-empty' });
      }

      // Verify bank account ownership if provided
      let resolvedBankAccountId = null;
      if (bankAccountId) {
        const { data: check } = await supabase
          .from('bank_accounts')
          .select('id')
          .eq('id', bankAccountId)
          .eq('company_id', req.user.companyId)
          .single();

        if (!check) {
          return res.status(404).json({ error: 'Bank account not found' });
        }
        resolvedBankAccountId = bankAccountId;
      }

      const batchId = importBatchId || uuidv4();

      // Stage transactions
      const { staged, skipped } = await BankStagingService.stageTransactions(
        req.user.companyId,
        resolvedBankAccountId,
        transactions,
        batchId,
        importSource
      );

      // Optionally run transfer detection immediately
      let detection = { processed: 0, transfersDetected: 0, links: [] };
      if (runDetection && staged.length > 0) {
        detection = await BankStagingService.detectTransfers(req.user.companyId, batchId);
      }

      await AuditLogger.logUserAction(
        req,
        'STAGE',
        'BANK_TRANSACTION_STAGING',
        resolvedBankAccountId,
        null,
        { batchId, staged: staged.length, skipped, importSource },
        'Bank transactions staged for review'
      );

      return res.status(201).json({
        batchId,
        staged:            staged.length,
        skipped,
        transfersDetected: detection.transfersDetected,
        links:             detection.links,
      });

    } catch (err) {
      console.error('[bankStaging/import]', err);
      return res.status(500).json({ error: err.message || 'Failed to stage transactions' });
    }
  }
);


/**
 * GET /api/accounting/bank/staging
 * List staged transactions for the authenticated company.
 *
 * Query params:
 *   batchId       {string}  — filter by import batch UUID
 *   bankAccountId {number}  — filter by bank account
 *   matchStatus   {string}  — UNMATCHED|TRANSFER_DETECTED|REVIEW_REQUIRED|CONFIRMED|REJECTED
 *   limit         {number}  — default 100
 *   offset        {number}  — default 0
 */
router.get('/',
  authenticate,
  hasPermission('bank.view'),
  async (req, res) => {
    try {
      const rows = await BankStagingService.listStaged(
        req.user.companyId,
        {
          batchId:       req.query.batchId,
          bankAccountId: req.query.bankAccountId ? parseInt(req.query.bankAccountId, 10) : undefined,
          matchStatus:   req.query.matchStatus,
          limit:         req.query.limit,
          offset:        req.query.offset,
        }
      );
      return res.json({ staging: rows, count: rows.length });
    } catch (err) {
      console.error('[bankStaging/list]', err);
      return res.status(500).json({ error: err.message || 'Failed to list staged transactions' });
    }
  }
);


/**
 * GET /api/accounting/bank/staging/batches
 * List import batches with summary stats (total, confirmed, rejected, transfers_detected).
 */
router.get('/batches',
  authenticate,
  hasPermission('bank.view'),
  async (req, res) => {
    try {
      const batches = await BankStagingService.listBatches(req.user.companyId);
      return res.json({ batches, count: batches.length });
    } catch (err) {
      console.error('[bankStaging/batches]', err);
      return res.status(500).json({ error: err.message || 'Failed to list batches' });
    }
  }
);


/**
 * GET /api/accounting/bank/staging/batch/:batchId
 * Fetch all rows and transfer links for a specific batch.
 */
router.get('/batch/:batchId',
  authenticate,
  hasPermission('bank.view'),
  async (req, res) => {
    try {
      const { rows, transferLinks } = await BankStagingService.getBatch(
        req.user.companyId,
        req.params.batchId
      );
      return res.json({ rows, transferLinks, count: rows.length });
    } catch (err) {
      console.error('[bankStaging/batch]', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch batch' });
    }
  }
);


/**
 * POST /api/accounting/bank/staging/detect-transfers
 * Run (or re-run) transfer detection on a staging batch.
 *
 * Body:
 *   batchId {string} — the import batch UUID to process
 */
router.post('/detect-transfers',
  authenticate,
  hasPermission('bank.import'),
  async (req, res) => {
    try {
      const { batchId } = req.body;
      if (!batchId) {
        return res.status(400).json({ error: 'batchId is required' });
      }

      const result = await BankStagingService.detectTransfers(
        req.user.companyId,
        batchId
      );

      return res.json(result);
    } catch (err) {
      console.error('[bankStaging/detect-transfers]', err);
      return res.status(500).json({ error: err.message || 'Transfer detection failed' });
    }
  }
);


/**
 * POST /api/accounting/bank/staging/confirm
 * Confirm selected staging rows — moves them into bank_transactions (status=unmatched).
 * These are NORMAL transactions (not transfers). GL is NOT affected.
 *
 * Body:
 *   stagingIds {number[]} — IDs of staging rows to confirm
 */
router.post('/confirm',
  authenticate,
  hasPermission('bank.import'),
  async (req, res) => {
    try {
      const { stagingIds } = req.body;

      if (!Array.isArray(stagingIds) || stagingIds.length === 0) {
        return res.status(400).json({ error: 'stagingIds[] is required and must be non-empty' });
      }

      const result = await BankStagingService.confirmStaged(
        req.user.companyId,
        stagingIds,
        req.user.id
      );

      await AuditLogger.logUserAction(
        req,
        'CONFIRM_STAGING',
        'BANK_TRANSACTION_STAGING',
        null,
        null,
        { confirmed: result.confirmed.length, skipped: result.skipped.length, stagingIds },
        'Staged bank transactions confirmed to bank_transactions'
      );

      return res.status(201).json({
        confirmed: result.confirmed,
        skipped:   result.skipped,
      });
    } catch (err) {
      console.error('[bankStaging/confirm]', err);
      return res.status(500).json({ error: err.message || 'Failed to confirm staging rows' });
    }
  }
);


/**
 * PATCH /api/accounting/bank/staging/:id/reject
 * Reject a staged transaction — marks it as REJECTED, will not be imported.
 */
router.patch('/:id/reject',
  authenticate,
  hasPermission('bank.import'),
  async (req, res) => {
    try {
      const stagingId = parseInt(req.params.id, 10);
      if (isNaN(stagingId)) {
        return res.status(400).json({ error: 'Invalid staging ID' });
      }

      const result = await BankStagingService.rejectStaged(req.user.companyId, stagingId);

      await AuditLogger.logUserAction(
        req,
        'REJECT_STAGING',
        'BANK_TRANSACTION_STAGING',
        stagingId,
        null,
        { match_status: 'REJECTED' },
        'Staged bank transaction rejected'
      );

      return res.json(result);
    } catch (err) {
      console.error('[bankStaging/reject]', err);
      if (err.message && err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }
      if (err.message && err.message.includes('already been confirmed')) {
        return res.status(409).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message || 'Failed to reject staging row' });
    }
  }
);


/**
 * POST /api/accounting/bank/staging/transfers/:linkId/confirm
 * Confirm a detected transfer pair.
 *
 * Creates a Dr/Cr transfer journal and moves both staging rows into
 * bank_transactions with status='matched'. This IS a GL-posting operation.
 *
 * Requires bank.allocate permission (same as regular allocation).
 */
router.post('/transfers/:linkId/confirm',
  authenticate,
  hasPermission('bank.allocate'),
  async (req, res) => {
    try {
      const linkId = parseInt(req.params.linkId, 10);
      if (isNaN(linkId)) {
        return res.status(400).json({ error: 'Invalid transfer link ID' });
      }

      const result = await BankStagingService.confirmTransfer(
        req.user.companyId,
        linkId,
        req.user
      );

      await AuditLogger.logUserAction(
        req,
        'CONFIRM_TRANSFER',
        'BANK_TRANSFER_LINK',
        linkId,
        { confirmed: false },
        { confirmed: true, journal_id: result.journalId },
        `Transfer confirmed — journal ${result.journalId} created`
      );

      return res.status(201).json({
        journalId:   result.journalId,
        bankTxnFrom: result.bankTxnFrom,
        bankTxnTo:   result.bankTxnTo,
        transferLink: result.transferLink,
      });
    } catch (err) {
      console.error('[bankStaging/confirm-transfer]', err);
      if (err.message && err.message.includes('not found')) {
        return res.status(404).json({ error: err.message });
      }
      if (err.message && err.message.includes('already confirmed')) {
        return res.status(409).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message || 'Failed to confirm transfer' });
    }
  }
);


module.exports = router;
