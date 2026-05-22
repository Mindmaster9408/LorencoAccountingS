/**
 * ============================================================================
 * POS Till Sessions Routes - Checkout Charlie Module
 * ============================================================================
 * Open/close till sessions, cash-up management.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { createReconSnapshot } = require('../services/posReconService');

const router = express.Router();

router.use(requireCompany);

/**
 * GET /api/pos/sessions
 * List sessions with optional status filter
 */
router.get('/', async (req, res) => {
  try {
    const { status, user_id } = req.query;
    let query = supabase
      .from('till_sessions')
      .select('*, tills(till_name, till_number, is_locked, locked_reason, is_printer_degraded, printer_degraded_reason), users:user_id(username, full_name)')
      .eq('company_id', req.companyId)
      .order('opened_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (user_id) query = query.eq('user_id', user_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/sessions/current
 * Get the current open session for the logged-in user
 */
router.get('/current', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('till_sessions')
      .select('*, tills(till_name, till_number, is_locked, locked_reason, is_printer_degraded, printer_degraded_reason)')
      .eq('company_id', req.companyId)
      .eq('user_id', req.user.userId)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ session: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/sessions/pending-cashup
 * Get sessions that need cash-up
 */
router.get('/pending-cashup', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('till_sessions')
      .select('*, tills(till_name, till_number), users:user_id(username, full_name)')
      .eq('company_id', req.companyId)
      .eq('status', 'closed')
      .is('closing_balance', null)
      .order('closed_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sessions/open
 * Open a new till session
 */
router.post('/open', async (req, res) => {
  try {
    const { till_id, opening_balance, notes } = req.body;

    if (!till_id || opening_balance === undefined) {
      return res.status(400).json({ error: 'till_id and opening_balance are required' });
    }
    if (opening_balance < 0) {
      return res.status(400).json({ error: 'opening_balance cannot be negative' });
    }

    // Check if this till already has an open session (any user, same company).
    // Enforces per-till uniqueness — prevents two cashiers sharing a till.
    // The DB-level partial unique index (migration 037) is the hard safety net
    // for any concurrent race that bypasses this application check.
    const { data: tillSession } = await supabase
      .from('till_sessions')
      .select('id, user_id')
      .eq('company_id', req.companyId)
      .eq('till_id', till_id)
      .eq('status', 'open')
      .limit(1);

    if (tillSession && tillSession.length > 0) {
      return res.status(409).json({
        error: 'This till already has an open session',
        sessionId: tillSession[0].id,
      });
    }

    // Check if this user already has an open session on any till
    const { data: existing } = await supabase
      .from('till_sessions')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('user_id', req.user.userId)
      .eq('status', 'open')
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'You already have an open session', sessionId: existing[0].id });
    }

    const { data, error } = await supabase
      .from('till_sessions')
      .insert({
        company_id: req.companyId,
        till_id,
        user_id: req.user.userId,
        opening_balance,
        status: 'open',
        notes,
        opened_at: new Date().toISOString()
      })
      .select('*, tills(till_name, till_number)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'till_session', data.id, {
      module: 'pos',
      newValue: { till_id, opening_balance }
    });
    posAuditFromReq(req, POS_EVENTS.TILL_OPENED, {
      tillId:        till_id,
      tillSessionId: data.id,
      afterSnapshot: {
        session_id:      data.id,
        till_id,
        opening_balance,
        status:          'open',
        opened_at:       data.opened_at,
      },
    });

    res.status(201).json({ session: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sessions/:id/close
 * Close a till session
 */
router.post('/:id/close', async (req, res) => {
  try {
    const { closing_balance, notes } = req.body;

    const { data: session } = await supabase
      .from('till_sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'open') return res.status(400).json({ error: 'Session is not open' });

    // Calculate expected balance from sales
    const { data: sales } = await supabase
      .from('sales')
      .select('total_amount, status')
      .eq('till_session_id', session.id)
      .eq('status', 'completed');

    const salesTotal = (sales || []).reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
    const expected = parseFloat(session.opening_balance) + salesTotal;
    const variance = closing_balance !== undefined ? closing_balance - expected : null;

    const { data, error } = await supabase
      .from('till_sessions')
      .update({
        status: 'closed',
        closing_balance: closing_balance !== undefined ? closing_balance : null,
        expected_balance: expected,
        variance,
        closed_at: new Date().toISOString(),
        notes: notes || session.notes
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'till_session', req.params.id, {
      module: 'pos',
      metadata: { action: 'close', expected, closing_balance, variance }
    });
    posAuditFromReq(req, POS_EVENTS.TILL_CLOSED, {
      tillId:         session.till_id || null,
      tillSessionId:  req.params.id,
      beforeSnapshot: { status: 'open', opening_balance: session.opening_balance },
      afterSnapshot:  { status: 'closed', expected_balance: expected, closing_balance, variance },
    });
    if (variance !== null && variance !== 0) {
      posAuditFromReq(req, POS_EVENTS.CASH_VARIANCE_RECORDED, {
        tillId:        session.till_id || null,
        tillSessionId: req.params.id,
        metadata:      { expected, closing_balance, variance, stage: 'session_close' },
      });
    }

    res.json({ session: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sessions/:id/complete-cashup
 * Complete the cash-up process for a closed session
 */
router.post('/:id/complete-cashup', async (req, res) => {
  try {
    const { counted_cash, counted_card, counted_other, notes } = req.body;

    const { data: session } = await supabase
      .from('till_sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const totalCounted = (counted_cash || 0) + (counted_card || 0) + (counted_other || 0);
    const variance = totalCounted - (session.expected_balance || 0);

    const { data, error } = await supabase
      .from('till_sessions')
      .update({
        closing_balance: totalCounted,
        variance,
        status: 'cashed_up',
        notes: notes || session.notes
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'till_session', req.params.id, {
      module: 'pos',
      metadata: { action: 'cashup', totalCounted, variance }
    });
    posAuditFromReq(req, POS_EVENTS.CASHUP_COMPLETED, {
      tillId:         session.till_id || null,
      tillSessionId:  req.params.id,
      beforeSnapshot: { status: session.status, expected_balance: session.expected_balance },
      afterSnapshot:  { status: 'cashed_up', total_counted: totalCounted, variance, counted_cash, counted_card, counted_other },
    });
    if (variance !== 0) {
      posAuditFromReq(req, POS_EVENTS.CASH_VARIANCE_RECORDED, {
        tillId:        session.till_id || null,
        tillSessionId: req.params.id,
        metadata:      { expected: session.expected_balance, total_counted: totalCounted, variance, stage: 'cashup' },
      });
    }

    // Create immutable reconciliation snapshot — fire-and-forget, never blocks response.
    // createReconSnapshot is internally try/catch and never throws.
    createReconSnapshot(
      req.params.id,
      req.companyId,
      req.user.userId,
      req.user.email || req.user.username,
      'cashup',
      { counted_cash, counted_card, counted_other, total_counted: totalCounted, variance }
    );

    res.json({ session: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
