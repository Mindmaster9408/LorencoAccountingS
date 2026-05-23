'use strict';

/**
 * Opening Balance Routes
 * ============================================================================
 * All routes under /api/accounting/opening-balances
 *
 * Permission scheme (matches accounting/middleware/auth.js PERMISSIONS):
 *   opening_balance.view     — GET list, GET batch, GET lines, GET accounts
 *   opening_balance.create   — POST batches, POST manual-line
 *   opening_balance.edit     — PUT lines, POST map-line, DELETE line
 *   opening_balance.finalize — POST validate, POST finalize
 *   opening_balance.archive  — POST archive
 * ============================================================================
 */

const express = require('express');
const { authenticate, hasPermission } = require('../middleware/auth');
const OpeningBalancesService = require('../services/openingBalancesService');

const router = express.Router();

// ── BATCH LIST ───────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/opening-balances/batches
 * List all batches for the company.
 * Optional query: ?status=draft|validated|finalized|archived
 */
router.get('/batches',
  authenticate,
  hasPermission('opening_balance.view'),
  async (req, res) => {
    try {
      const batches = await OpeningBalancesService.listBatches({
        companyId: req.user.companyId,
        status:    req.query.status || null,
      });
      res.json({ batches });
    } catch (err) {
      console.error('[OpeningBalances] listBatches:', err);
      res.status(500).json({ error: 'Failed to load batches.', detail: err.message });
    }
  }
);

// ── CREATE BATCH ─────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batches
 * Create a new draft batch.
 * Body: { effectiveDate, sourceType, sourceName, description }
 */
router.post('/batches',
  authenticate,
  hasPermission('opening_balance.create'),
  async (req, res) => {
    try {
      const { effectiveDate, sourceType, sourceName, description } = req.body;
      if (!effectiveDate) return res.status(400).json({ error: 'effectiveDate is required.' });
      if (!sourceName || !sourceName.trim()) return res.status(400).json({ error: 'sourceName is required.' });

      const batch = await OpeningBalancesService.createBatch({
        companyId:     req.user.companyId,
        userId:        req.user.id,
        effectiveDate,
        sourceType:    sourceType || 'manual',
        sourceName,
        description:   description || null,
      });
      res.status(201).json({ batch });
    } catch (err) {
      console.error('[OpeningBalances] createBatch:', err);
      res.status(500).json({ error: 'Failed to create batch.', detail: err.message });
    }
  }
);

// ── GET SINGLE BATCH ─────────────────────────────────────────────────────────

/**
 * GET /api/accounting/opening-balances/batch/:batchId
 */
router.get('/batch/:batchId',
  authenticate,
  hasPermission('opening_balance.view'),
  async (req, res) => {
    try {
      const batch = await OpeningBalancesService.getBatch({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
      });
      res.json({ batch });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── GET BATCH LINES ───────────────────────────────────────────────────────────

/**
 * GET /api/accounting/opening-balances/batch/:batchId/lines
 */
router.get('/batch/:batchId/lines',
  authenticate,
  hasPermission('opening_balance.view'),
  async (req, res) => {
    try {
      const lines = await OpeningBalancesService.getBatchLines({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
      });
      res.json({ lines });
    } catch (err) {
      console.error('[OpeningBalances] getBatchLines:', err);
      res.status(500).json({ error: 'Failed to load lines.', detail: err.message });
    }
  }
);

// ── SAVE MANUAL LINE (create or update) ──────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/manual-line
 * Body: { lineId?, sourceAccountCode, sourceAccountName, mappedAccountId?, debit, credit, notes }
 * lineId present → update existing; absent → create new.
 */
router.post('/batch/:batchId/manual-line',
  authenticate,
  hasPermission('opening_balance.create'),
  async (req, res) => {
    try {
      const {
        lineId, sourceAccountCode, sourceAccountName,
        mappedAccountId, debit, credit, notes,
      } = req.body;

      const line = await OpeningBalancesService.saveManualLine({
        companyId:          req.user.companyId,
        batchId:            req.params.batchId,
        userId:             req.user.id,
        lineId:             lineId || null,
        sourceAccountCode:  sourceAccountCode || null,
        sourceAccountName:  sourceAccountName || null,
        mappedAccountId:    mappedAccountId   || null,
        debit:              debit  || 0,
        credit:             credit || 0,
        notes:              notes  || null,
      });
      res.json({ line });
    } catch (err) {
      console.error('[OpeningBalances] saveManualLine:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── DELETE LINE ───────────────────────────────────────────────────────────────

/**
 * DELETE /api/accounting/opening-balances/batch/:batchId/line/:lineId
 */
router.delete('/batch/:batchId/line/:lineId',
  authenticate,
  hasPermission('opening_balance.edit'),
  async (req, res) => {
    try {
      await OpeningBalancesService.deleteLine({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        lineId:    req.params.lineId,
        userId:    req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[OpeningBalances] deleteLine:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── MAP LINE ─────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/map-line
 * Body: { lineId, mappedAccountId }
 */
router.post('/batch/:batchId/map-line',
  authenticate,
  hasPermission('opening_balance.edit'),
  async (req, res) => {
    try {
      const { lineId, mappedAccountId } = req.body;
      if (!lineId)          return res.status(400).json({ error: 'lineId is required.' });
      if (!mappedAccountId) return res.status(400).json({ error: 'mappedAccountId is required.' });

      const line = await OpeningBalancesService.mapLine({
        companyId:       req.user.companyId,
        batchId:         req.params.batchId,
        lineId,
        userId:          req.user.id,
        mappedAccountId: parseInt(mappedAccountId, 10),
      });
      res.json({ line });
    } catch (err) {
      console.error('[OpeningBalances] mapLine:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── UNMAP LINE ────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/unmap-line
 * Body: { lineId }
 */
router.post('/batch/:batchId/unmap-line',
  authenticate,
  hasPermission('opening_balance.edit'),
  async (req, res) => {
    try {
      const { lineId } = req.body;
      if (!lineId) return res.status(400).json({ error: 'lineId is required.' });

      await OpeningBalancesService.unmapLine({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        lineId,
        userId:    req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[OpeningBalances] unmapLine:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── EXCLUDE LINE ──────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/exclude-line
 * Body: { lineId, reason? }
 */
router.post('/batch/:batchId/exclude-line',
  authenticate,
  hasPermission('opening_balance.edit'),
  async (req, res) => {
    try {
      const { lineId, reason } = req.body;
      if (!lineId) return res.status(400).json({ error: 'lineId is required.' });

      await OpeningBalancesService.excludeLine({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        lineId,
        userId:    req.user.id,
        reason:    reason || null,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[OpeningBalances] excludeLine:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── VALIDATE ─────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/validate
 * Runs all validation checks and (if valid) marks batch as 'validated'.
 */
router.post('/batch/:batchId/validate',
  authenticate,
  hasPermission('opening_balance.finalize'),
  async (req, res) => {
    try {
      const result = await OpeningBalancesService.validateBatch({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        userId:    req.user.id,
      });
      res.json(result);
    } catch (err) {
      console.error('[OpeningBalances] validateBatch:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── FINALIZE ─────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/finalize
 * Creates and posts the opening balance journal.
 * Batch must be in 'validated' status.
 */
router.post('/batch/:batchId/finalize',
  authenticate,
  hasPermission('opening_balance.finalize'),
  async (req, res) => {
    try {
      const result = await OpeningBalancesService.finalizeBatch({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        userId:    req.user.id,
      });
      res.json(result);
    } catch (err) {
      console.error('[OpeningBalances] finalizeBatch:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── ARCHIVE ───────────────────────────────────────────────────────────────────

/**
 * POST /api/accounting/opening-balances/batch/:batchId/archive
 * Archive a finalized batch (status must be 'finalized').
 */
router.post('/batch/:batchId/archive',
  authenticate,
  hasPermission('opening_balance.archive'),
  async (req, res) => {
    try {
      await OpeningBalancesService.archiveBatch({
        companyId: req.user.companyId,
        batchId:   req.params.batchId,
        userId:    req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[OpeningBalances] archiveBatch:', err);
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

// ── ACCOUNT SEARCH ────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/opening-balances/accounts/search?q=term
 * Returns up to 50 postable accounts matching the search term.
 */
router.get('/accounts/search',
  authenticate,
  hasPermission('opening_balance.view'),
  async (req, res) => {
    try {
      const searchTerm = (req.query.q || '').trim();
      if (!searchTerm) return res.json({ accounts: [] });

      const accounts = await OpeningBalancesService.searchAccounts({
        companyId:  req.user.companyId,
        searchTerm,
      });
      res.json({ accounts });
    } catch (err) {
      console.error('[OpeningBalances] searchAccounts:', err);
      res.status(500).json({ error: 'Account search failed.', detail: err.message });
    }
  }
);

module.exports = router;
