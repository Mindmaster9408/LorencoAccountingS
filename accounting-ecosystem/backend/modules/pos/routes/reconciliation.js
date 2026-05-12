/**
 * ============================================================================
 * POS Reconciliation Routes - Checkout Charlie Module
 * ============================================================================
 * Mounted alongside sessions routes at /api/pos/sessions/:id/...
 *
 * These routes add forensic-grade reconciliation capability WITHOUT modifying
 * any existing route or report. All existing cash-up screens and reports
 * continue to function exactly as before.
 *
 * Endpoints:
 *   GET  /api/pos/sessions/:id/reconciliation
 *     — Live recon computed from authoritative DB data (sales, sale_payments,
 *       pos_returns). Always reflects current state. No snapshot created.
 *
 *   GET  /api/pos/sessions/:id/snapshot
 *     — Returns the most recent immutable reconciliation snapshot for this
 *       session. Returns 404 if none exists yet.
 *
 *   POST /api/pos/sessions/:id/snapshot
 *     — Manually trigger snapshot creation (manager/admin). Creates a new
 *       append-only snapshot even if one already exists. Useful after
 *       dispute, audit request, or if automatic cashup snapshot failed.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { computeSessionRecon, detectInconsistencies, createReconSnapshot } = require('../services/posReconService');

const router = express.Router();

router.use(requireCompany);

/**
 * GET /api/pos/sessions/:id/reconciliation
 * Live reconciliation computed from authoritative DB data at request time.
 *
 * Returns:
 *   - Full totals breakdown (sales, payments, refunds, voids)
 *   - expected_cash_in_drawer (forensically correct — cash only, includes refunds)
 *   - legacy_expected_balance (the value stored in till_sessions.expected_balance
 *     for comparison — this is the all-methods, no-refund figure)
 *   - Consistency issues detected
 *   - Payment method breakdown from sale_payments
 *   - Refund breakdown from pos_returns
 */
router.get('/:id/reconciliation', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const sessionId = req.params.id;
    const companyId = req.companyId;

    let recon;
    try {
      recon = await computeSessionRecon(sessionId, companyId);
    } catch (err) {
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      return res.status(500).json({ error: err.message });
    }

    const issues = await detectInconsistencies(sessionId, companyId);

    const session = recon.session;

    res.json({
      session: {
        id:               session.id,
        status:           session.status,
        till_id:          session.till_id,
        opened_at:        session.opened_at,
        closed_at:        session.closed_at,
        opening_balance:  recon.openingBalance,
        // Legacy figures stored on the session record (all-methods, no refunds)
        legacy_expected_balance:  session.expected_balance,
        legacy_closing_balance:   session.closing_balance,
        legacy_variance:          session.variance,
      },
      totals: {
        // Sales
        sale_count:     recon.saleCount,
        gross_sales:    recon.grossSales,
        discount_total: recon.discountTotal,
        vat_total:      recon.vatTotal,
        net_sales:      recon.netSales,
        // Voids
        void_count:     recon.voidCount,
        void_total:     recon.voidTotal,
        // Refunds
        refund_count:   recon.refundCount,
        refund_total:   recon.refundTotal,
      },
      payments: {
        // Authoritative breakdown from sale_payments table
        cash:           recon.paymentCash,
        card:           recon.paymentCard,
        eft:            recon.paymentEft,
        account:        recon.paymentAccount,
        other:          recon.paymentOther,
        full_breakdown: recon.paymentByMethod,
      },
      refunds: {
        cash:           recon.refundCash,
        card:           recon.refundCard,
        full_breakdown: recon.refundByMethod,
      },
      cash_reconciliation: {
        opening_balance:          recon.openingBalance,
        cash_sales:               recon.paymentCash,
        cash_refunds:             recon.refundCash,
        expected_cash_in_drawer:  recon.expectedCashInDrawer,
        // Legacy comparison — shows the trust gap between new and old figures
        legacy_expected_balance:  session.expected_balance,
        difference_from_legacy:   session.expected_balance != null
          ? Math.round((recon.expectedCashInDrawer - parseFloat(session.expected_balance)) * 100) / 100
          : null,
      },
      consistency: {
        is_consistent:  issues.length === 0,
        issue_count:    issues.length,
        issues,
      },
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Reconciliation] Live recon error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/sessions/:id/snapshot
 * Returns the most recent immutable reconciliation snapshot for this session.
 */
router.get('/:id/snapshot', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);

    // Verify session belongs to this company before returning snapshot
    const { data: session } = await supabase
      .from('till_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data, error } = await supabase
      .from('pos_recon_snapshots')
      .select('*')
      .eq('till_session_id', sessionId)
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'No reconciliation snapshot exists for this session' });

    res.json({ snapshot: data });
  } catch (err) {
    console.error('[Reconciliation] Get snapshot error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/sessions/:id/snapshots
 * Returns all immutable snapshots for this session (history).
 * A session may have multiple snapshots if manually triggered after cashup.
 */
router.get('/:id/snapshots', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);

    const { data: session } = await supabase
      .from('till_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data, error } = await supabase
      .from('pos_recon_snapshots')
      .select('id, created_at, triggered_by, generated_by_email, is_consistent, sale_count, gross_sales, net_sales, expected_cash_in_drawer, total_counted, cash_variance')
      .eq('till_session_id', sessionId)
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ snapshots: data || [] });
  } catch (err) {
    console.error('[Reconciliation] List snapshots error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sessions/:id/snapshot
 * Manually create an immutable reconciliation snapshot.
 * Requires manager-level permission (SALES.VOID used as proxy — same as void/cashup operations).
 *
 * Creates a new snapshot even if one already exists. Each snapshot is an
 * immutable historical record — they are never overwritten.
 */
router.post('/:id/snapshot', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const sessionId = req.params.id;
    const companyId = req.companyId;

    // Verify session belongs to this company
    const { data: session } = await supabase
      .from('till_sessions')
      .select('id, status, closing_balance, expected_balance, variance, user_id')
      .eq('id', parseInt(sessionId))
      .eq('company_id', parseInt(companyId))
      .maybeSingle();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Build cashupData from session record if available
    const cashupData = {
      total_counted: session.closing_balance,
      variance:      session.variance,
    };

    const snapshot = await createReconSnapshot(
      sessionId,
      companyId,
      req.user.userId,
      req.user.email || req.user.username,
      'manual',
      cashupData
    );

    if (!snapshot) {
      return res.status(500).json({ error: 'Snapshot creation failed — see server logs' });
    }

    res.status(201).json({ snapshot });
  } catch (err) {
    console.error('[Reconciliation] Manual snapshot error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
