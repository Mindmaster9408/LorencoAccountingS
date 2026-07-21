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
const { createReconSnapshot, computeSessionRecon } = require('../services/posReconService');
const { hasPermission } = require('../../../config/permissions');

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
 * Get sessions that need cash-up — cross-cashier visibility, so this is
 * management-tier only (TILLS.MANAGE). A regular cashier's own cashup
 * screen still calls this unconditionally; a 403 here is handled
 * gracefully by the frontend (the section simply stays hidden), which is
 * also the correct behaviour — a cashier should not see other cashiers'
 * pending till figures.
 */
router.get('/pending-cashup', requirePermission('TILLS.MANAGE'), async (req, res) => {
  try {
    // BUG FIX (found live, Workstream 97): this previously filtered on
    // closing_balance IS NULL, but /close accepts an optional closing_balance
    // and the self-service "close till" UI always sends one (a cashier's own
    // rough estimate) — meaning almost every real session would have a
    // non-null closing_balance the instant it's closed, and would then never
    // appear here at all, regardless of whether it had actually been
    // reconciled. status is the real state machine: 'open' -> 'closed' ->
    // 'cashed_up' (only /complete-cashup sets 'cashed_up'), so "needs
    // cash-up" correctly means status = 'closed', independent of whatever
    // closing_balance value (if any) was recorded at close time.
    const { data, error } = await supabase
      .from('till_sessions')
      .select('*, tills(till_name, till_number), users:user_id(username, full_name)')
      .eq('company_id', req.companyId)
      .eq('status', 'closed')
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

    // Closing your own session is unrestricted (existing self-service
    // behaviour, unchanged). Closing someone else's session — found live
    // to have NO permission check at all before this fix, meaning any
    // authenticated user, including a trainee, could close any other
    // cashier's till — now requires management-tier TILLS.MANAGE.
    if (session.user_id !== req.user.userId && !hasPermission(req.user.role, 'TILLS', 'MANAGE')) {
      return res.status(403).json({ error: 'Only a manager can close another cashier\'s till session' });
    }

    // Expected balance: cash-only (opening + cash payments − cash refunds), via
    // the same computeSessionRecon() used by the reconciliation endpoint and
    // shown to the cashier on-screen as "Expected cash in drawer". This used to
    // be reimplemented here as opening + ALL completed sales regardless of
    // payment method (card/EFT/account included), which persisted a false
    // "cash" expectation into till_sessions.expected_balance/variance for any
    // session with non-cash sales — the authoritative record disagreed with
    // what the cashier was shown. Sharing the one formula instead of
    // reimplementing it is the same fix as calcCartTotals() in the POS
    // frontend (six divergent VAT reimplementations, one bug).
    const recon    = await computeSessionRecon(session.id, req.companyId);
    const expected = recon.expectedCashInDrawer;
    const variance = closing_balance !== undefined
      ? Math.round((closing_balance - expected) * 100) / 100
      : null;

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

    // The state machine is open -> closed -> cashed_up (see /pending-cashup
    // above). The UI only ever offers this action for status='closed'
    // sessions, but that was never enforced server-side — a stray or future
    // call landing on a still-open session would compute variance against a
    // null expected_balance (since only /close sets it) and skip the
    // 'closed' state entirely.
    if (session.status !== 'closed') {
      return res.status(400).json({ error: `Session must be closed before completing cashup (current status: ${session.status})` });
    }

    // Same rule as /close: completing your own cashup is unrestricted;
    // completing someone else's requires management-tier TILLS.MANAGE.
    // This is the specific capability requested — a store manager finalising
    // the day's cashups on behalf of their cashiers — found live to have no
    // permission gate at all before this fix.
    if (session.user_id !== req.user.userId && !hasPermission(req.user.role, 'TILLS', 'MANAGE')) {
      return res.status(403).json({ error: 'Only a manager can complete another cashier\'s cashup' });
    }

    const totalCounted = (counted_cash || 0) + (counted_card || 0) + (counted_other || 0);
    // Variance is a CASH-drawer figure: counted cash vs expected cash-in-drawer
    // (now cash-only — see /close above). Comparing totalCounted (which folds
    // in counted_card/counted_other) against a cash-only expected_balance would
    // reintroduce the same mismatch this fix removes elsewhere, and would also
    // show a phantom shortfall on any session with account/pay-later sales
    // (no counted field exists for those at all). closing_balance below still
    // stores totalCounted — that "total tendered across all methods" figure is
    // unchanged and used elsewhere (till-summary reports) independently of variance.
    const variance = Math.round(((counted_cash || 0) - (session.expected_balance || 0)) * 100) / 100;

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
