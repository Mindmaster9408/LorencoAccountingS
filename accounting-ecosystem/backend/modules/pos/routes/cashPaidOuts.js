/**
 * ============================================================================
 * POS Cash Paid Out Routes - Checkout Charlie Module
 * ============================================================================
 * Mounted alongside sessions/reconciliation routes at /api/pos/sessions/:id/...
 *
 * Records cash physically removed from a till drawer mid-shift for a
 * legitimate reason (e.g. paying a delivery driver, buying something small
 * for the shop). Added 2026-07-28 after forensically investigating a real
 * cash-up shortfall for a trusted cashier: every sale/payment record was
 * confirmed internally consistent (see posReconService.detectInconsistencies),
 * so the gap had to be something the system had no way to record at all.
 * Factored into expected_cash_in_drawer by
 * posReconService.computeSessionRecon() — see migration 071.
 *
 * Endpoints:
 *   POST /api/pos/sessions/:id/paid-out  — record a new paid-out (session must be open)
 *   GET  /api/pos/sessions/:id/paid-outs — list paid-outs for a session
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);

router.post('/:id/paid-out', requirePermission('TILLS.PAID_OUT'), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const companyId = req.companyId;
    const { amount, reason, notes } = req.body;

    const amountNum = parseFloat(amount);
    if (!amountNum || isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Reason is required' });
    }

    const { data: session, error: sessErr } = await supabase
      .from('till_sessions')
      .select('id, status, till_id')
      .eq('id', sessionId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (sessErr) return res.status(500).json({ error: sessErr.message });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // A paid-out only makes sense while the till is actively in use — once
    // closed there's no more physical drawer activity left to record.
    if (session.status !== 'open') {
      return res.status(409).json({ error: `Session must be open to record a paid-out (current status: ${session.status})` });
    }

    const { data, error } = await supabase
      .from('pos_cash_paidouts')
      .insert({
        company_id:         companyId,
        till_session_id:    sessionId,
        till_id:            session.till_id || null,
        amount:              Math.round(amountNum * 100) / 100,
        reason:              reason.trim(),
        notes:               notes ? notes.trim() : null,
        created_by_user_id: req.user.userId,
        created_by_email:   req.user.email || req.user.username || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.CASH_PAID_OUT, {
      tillId:        session.till_id || null,
      tillSessionId: sessionId,
      afterSnapshot: { amount: data.amount, reason: data.reason },
    });

    res.status(201).json({ paidOut: data });
  } catch (err) {
    console.error('[CashPaidOuts] POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/paid-outs', requirePermission('TILLS.VIEW'), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const companyId = req.companyId;

    const { data: session } = await supabase
      .from('till_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data, error } = await supabase
      .from('pos_cash_paidouts')
      .select('*')
      .eq('till_session_id', sessionId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ paidOuts: data || [] });
  } catch (err) {
    console.error('[CashPaidOuts] GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
