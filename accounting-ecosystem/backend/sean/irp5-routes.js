/**
 * ============================================================================
 * SEAN IRP5 Learning — API Routes
 * ============================================================================
 * Endpoints for the Sean Paytime IRP5 learning engine.
 * All routes are prefixed with /api/sean/paytime.
 *
 * Endpoints:
 *   POST  /irp5-event           — Receive an IRP5 code change from Paytime
 *   POST  /analyze              — Trigger pattern analysis manually
 *   GET   /patterns             — List discovered mapping patterns
 *   GET   /proposals            — List proposals awaiting authorization
 *   POST  /proposals/:id/approve — Approve a proposal (auth required)
 *   POST  /proposals/:id/reject  — Reject a proposal (with reason)
 *   POST  /proposals/:id/propagate — Run propagation for an approved proposal
 *   GET   /exceptions           — List exception companies for a mapping
 *   GET   /stats                — Learning system summary stats
 *   GET   /log                  — Propagation audit log
 *
 * Authorization levels:
 *   - /irp5-event        → any authenticated ecosystem user (called by Paytime)
 *   - /patterns, /stats  → PAYROLL.VIEW (accountants can see)
 *   - /proposals/*       → requireSuperAdmin (global ecosystem decisions only)
 *   - /propagate         → requireSuperAdmin
 *
 * References:
 *   CLAUDE.md Part B — Rules B1–B11
 * ============================================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateToken, requireSuperAdmin, requirePermission } = require('../../middleware/auth');
const IRP5Learning = require('../irp5-learning');

// All routes in this file require a valid JWT
router.use(authenticateToken);

// ─── POST /irp5-event — Receive IRP5 Learning Event from Paytime ─────────────
//
// Called by the Paytime payroll items route whenever an irp5_code is created
// or changed on a payroll_items_master record.
//
// Body: {
//   companyId, clientId?, payrollItemId?, payrollItemName,
//   itemCategory?, previousIrp5Code?, newIrp5Code,
//   changeType, changedBy?, taxYear?
// }

router.post('/irp5-event', async (req, res) => {
  try {
    const {
      companyId,
      clientId,
      payrollItemId,
      payrollItemName,
      itemCategory,
      previousIrp5Code,
      newIrp5Code,
      changeType,
      changedBy,
      taxYear
    } = req.body;

    // Validate required fields
    if (!companyId || !payrollItemName || !newIrp5Code || !changeType) {
      return res.status(400).json({
        error: 'companyId, payrollItemName, newIrp5Code, and changeType are required'
      });
    }

    // Validate IRP5 code format — SARS codes are 4-digit numbers
    if (!/^\d{4,6}$/.test(String(newIrp5Code).trim())) {
      return res.status(400).json({
        error: `Invalid IRP5 code format: "${newIrp5Code}". Expected 4–6 digit numeric SARS code.`
      });
    }

    const event = await IRP5Learning.recordLearningEvent({
      companyId:       parseInt(companyId, 10),
      clientId:        clientId ? parseInt(clientId, 10) : null,
      payrollItemId:   payrollItemId ? parseInt(payrollItemId, 10) : null,
      payrollItemName: String(payrollItemName).trim(),
      itemCategory:    itemCategory ? String(itemCategory).trim() : null,
      previousIrp5Code: previousIrp5Code ? String(previousIrp5Code).trim() : null,
      newIrp5Code:     String(newIrp5Code).trim(),
      changeType:      String(changeType),
      changedBy:       changedBy || req.user?.userId || null,
      taxYear
    });

    res.status(201).json({
      success: true,
      message: 'Learning event recorded',
      eventId: event.id
    });
  } catch (err) {
    console.error('[Sean IRP5] /irp5-event error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /analyze — Trigger Pattern Analysis ────────────────────────────────
//
// Manually triggers pattern analysis. In production this also runs after every
// learning event (background, non-blocking). This endpoint is for on-demand runs
// or after bulk data imports.

router.post('/analyze', requireSuperAdmin, async (req, res) => {
  try {
    const result = await IRP5Learning.analyzePatterns();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Sean IRP5] /analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /patterns — List Discovered Patterns ────────────────────────────────
//
// Returns all mapping patterns Sean has discovered.
// Query params: ?status=proposed&minConfidence=50

router.get('/patterns', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { status, minConfidence } = req.query;

    const patterns = await IRP5Learning.getPatterns({
      status:        status || null,
      minConfidence: minConfidence ? parseFloat(minConfidence) : 0
    });

    res.json({
      count:    patterns.length,
      patterns
    });
  } catch (err) {
    console.error('[Sean IRP5] /patterns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /proposals — List Pending Proposals ─────────────────────────────────
//
// Returns proposals awaiting authorization review, enriched with:
//   - clients where code is missing (will be filled if approved)
//   - clients with conflicting codes (will NOT be touched)
//   - clients already correctly coded

router.get('/proposals', requireSuperAdmin, async (req, res) => {
  try {
    const proposals = await IRP5Learning.getProposals();
    res.json({ count: proposals.length, proposals });
  } catch (err) {
    console.error('[Sean IRP5] /proposals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /proposals/:id/approve — Approve Proposal ─────────────────────────
//
// Marks a proposal as approved. Does NOT propagate yet — that is a separate step.
// Only ecosystem superusers may approve.

router.post('/proposals/:id/approve', requireSuperAdmin, async (req, res) => {
  try {
    const approvalId = parseInt(req.params.id, 10);
    if (!approvalId || isNaN(approvalId)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const updated = await IRP5Learning.approveProposal(approvalId, req.user.userId);

    res.json({
      success: true,
      message: 'Proposal approved. Run /propagate to apply to missing-code clients.',
      approval: updated
    });
  } catch (err) {
    console.error('[Sean IRP5] /approve error:', err.message);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('not pending') ? 409
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /proposals/:id/reject — Reject Proposal ───────────────────────────
//
// Body: { reason?: string }

router.post('/proposals/:id/reject', requireSuperAdmin, async (req, res) => {
  try {
    const approvalId = parseInt(req.params.id, 10);
    if (!approvalId || isNaN(approvalId)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const { reason } = req.body;
    const updated = await IRP5Learning.rejectProposal(approvalId, req.user.userId, reason);

    res.json({ success: true, message: 'Proposal rejected', approval: updated });
  } catch (err) {
    console.error('[Sean IRP5] /reject error:', err.message);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('not pending') ? 409
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /proposals/:id/propagate — Execute Approved Propagation ────────────
//
// SAFETY: Only runs for approvals in 'approved' status.
// Only fills NULL/empty irp5_code fields. Never overwrites existing codes.
// Logs every action (applied / skipped_existing / skipped_exception).

router.post('/proposals/:id/propagate', requireSuperAdmin, async (req, res) => {
  try {
    const approvalId = parseInt(req.params.id, 10);
    if (!approvalId || isNaN(approvalId)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const result = await IRP5Learning.propagateApproved(approvalId, req.user.userId);

    res.json({
      success: true,
      message: `Propagation complete.`,
      result: {
        applied:         result.applied,
        skippedExisting: result.skippedExisting,
        exceptions:      result.exceptions,
        errors:          result.errors
      },
      safetyNote: result.exceptions > 0
        ? `${result.exceptions} client(s) had a different existing IRP5 code — NOT overwritten. See /exceptions for details.`
        : undefined
    });
  } catch (err) {
    console.error('[Sean IRP5] /propagate error:', err.message);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('not in') ? 409
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── GET /exceptions — Exception Clients ─────────────────────────────────────
//
// Lists clients that have a different IRP5 code for a given item + proposed code.
// Query params: ?name=commission&code=3606

router.get('/exceptions', requireSuperAdmin, async (req, res) => {
  try {
    const { name, code } = req.query;

    if (!name || !code) {
      return res.status(400).json({ error: 'name and code query params are required' });
    }

    const normalizedName = IRP5Learning.normalizeName(name);
    const exceptions = await IRP5Learning.getExceptions(normalizedName, code);

    res.json({
      normalizedName,
      proposedCode: code,
      count:        exceptions.length,
      exceptions,
      note: 'These clients already have a different IRP5 code. They require individual review. Sean will never overwrite these automatically.'
    });
  } catch (err) {
    console.error('[Sean IRP5] /exceptions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /stats — System Stats ───────────────────────────────────────────────

router.get('/stats', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const stats = await IRP5Learning.getStats();
    res.json(stats);
  } catch (err) {
    console.error('[Sean IRP5] /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /log — Propagation Audit Log ────────────────────────────────────────
//
// Returns recent propagation log entries. Super admin only.
// Query params: ?limit=50&action=applied

router.get('/log', requireSuperAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const action = req.query.action || null;

    let query = supabaseQuery()
      .from('sean_irp5_propagation_log')
      .select(`
        id, company_id, payroll_item_name, irp5_code_written,
        previous_irp5_code, action, notes, created_at,
        approval:sean_irp5_propagation_approvals (
          snapshot_normalized_name, snapshot_irp5_code, approved_by, approved_at
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (action) query = query.eq('action', action);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ count: data?.length || 0, log: data || [] });
  } catch (err) {
    console.error('[Sean IRP5] /log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper — inline Supabase access ─────────────────────────────────────────

function supabaseQuery() {
  const { supabase } = require('../../config/database');
  return supabase;
}

module.exports = router;
