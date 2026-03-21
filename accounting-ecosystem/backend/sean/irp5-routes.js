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

const { authenticateToken, requireSuperAdmin, requirePermission } = require('../middleware/auth');
const IRP5Learning = require('./irp5-learning');

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

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL ITEMS MANAGEMENT — SEAN governance view
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /items — Browse payroll items across companies ───────────────────────
//
// Super admin: returns items from ALL companies (or filtered by ?companyId=X).
// Non-superadmin: returns own company's items only (requires valid company context).
//
// Query params:
//   ?companyId=N         — filter to one company (superadmin only)
//   ?type=earning        — filter by item_type (earning | deduction | company_contribution)
//   ?missingIrp5=true    — only items where irp5_code IS NULL
//   ?includeInactive=true — include is_active = false items (superadmin only)

router.get('/items', async (req, res) => {
  try {
    const { supabase } = supabaseQuery2();
    const isSuperAdmin = req.user?.isSuperAdmin === true;
    const { companyId: queryCompanyId, type, missingIrp5, includeInactive } = req.query;

    // Determine company scope
    let targetCompanyId = null;
    if (isSuperAdmin && queryCompanyId) {
      targetCompanyId = parseInt(queryCompanyId, 10) || null;
    } else if (!isSuperAdmin) {
      // Non-superadmin: own company only
      targetCompanyId = req.companyId || req.user?.companyId;
      if (!targetCompanyId) {
        return res.status(403).json({ error: 'Company context required' });
      }
    }
    // isSuperAdmin && !queryCompanyId → all companies

    let query = supabase
      .from('payroll_items_master')
      .select('id, name, item_type, category, irp5_code, is_taxable, is_recurring, is_active, company_id, companies(id, name)')
      .order('company_id')
      .order('item_type')
      .order('name');

    // Scope by company
    if (targetCompanyId) {
      query = query.eq('company_id', targetCompanyId);
    }

    // Active filter (superadmin can see inactive items if requested)
    if (!isSuperAdmin || includeInactive !== 'true') {
      query = query.eq('is_active', true);
    }

    if (type) query = query.eq('item_type', type);
    if (missingIrp5 === 'true') query = query.is('irp5_code', null);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const items = data || [];

    // Attach governance stats
    const missingCount = items.filter(i => !i.irp5_code).length;

    res.json({ count: items.length, missingIrp5Count: missingCount, items });
  } catch (err) {
    console.error('[Sean Paytime] GET /items error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUT /items/:id — Update payroll item IRP5 code from SEAN governance ──────
//
// Super admin only.
// Applies the same IRP5 validation as items.js.
// Emits an IRP5 learning event (non-blocking) after save.
//
// Body: {
//   irp5_code: '3601'  — required (pass null to clear)
//   reason?: string    — optional reason for the change (stored in notes)
// }
//
// Does NOT automatically propagate globally — use the Transaction Store
// (POST /api/sean/store/submit → approve → sync) for cross-client governance.

router.put('/items/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { supabase } = supabaseQuery2();
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid item id' });

    const { irp5_code, reason } = req.body;

    if (irp5_code === undefined) {
      return res.status(400).json({ error: 'irp5_code is required (pass null to clear)' });
    }

    const newCode = (irp5_code === null || irp5_code === '') ? null : String(irp5_code).trim();

    if (newCode !== null && !/^\d{4,6}$/.test(newCode)) {
      return res.status(400).json({
        error: `Invalid IRP5 code: "${newCode}". Expected 4–6 digit SARS numeric code.`
      });
    }

    // Fetch existing item — no company restriction (superadmin spans all)
    const { data: existing, error: fetchErr } = await supabase
      .from('payroll_items_master')
      .select('id, company_id, name, item_type, category, irp5_code')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Payroll item not found' });
    }

    const updates = {
      irp5_code:            newCode,
      irp5_code_updated_at: new Date().toISOString(),
      irp5_code_updated_by: req.user?.userId || null
    };

    const { data, error } = await supabase
      .from('payroll_items_master')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Emit IRP5 learning event if code was added or changed (not cleared)
    if (newCode && newCode !== existing.irp5_code) {
      const changeType = !existing.irp5_code ? 'code_added' : 'code_changed';
      IRP5Learning.recordLearningEvent({
        companyId:        existing.company_id,
        payrollItemId:    id,
        payrollItemName:  existing.name,
        itemCategory:     existing.item_type || null,
        previousIrp5Code: existing.irp5_code || null,
        newIrp5Code:      newCode,
        changeType,
        changedBy:        req.user?.userId || null
      }).catch(e => console.error('[Sean] IRP5 learn event (non-fatal):', e.message));
    }

    res.json({
      success: true,
      item:    data,
      note:    reason || null
    });
  } catch (err) {
    console.error('[Sean Paytime] PUT /items/:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Helper — inline Supabase access ─────────────────────────────────────────

function supabaseQuery() {
  const { supabase } = require('../config/database');
  return supabase;
}

function supabaseQuery2() {
  return require('../config/database');
}

module.exports = router;
