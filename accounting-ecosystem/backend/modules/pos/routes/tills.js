/**
 * ============================================================================
 * POS Tills Routes - Checkout Charlie Module
 * ============================================================================
 * Till hardware management and daily reset.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');
const { computeSessionRecon } = require('../services/posReconService');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);

/**
 * GET /api/pos/tills
 * List tills for the company.
 * Default: active only (?include_inactive omitted or falsy).
 * Pass ?include_inactive=true for settings/management views.
 */
router.get('/', async (req, res) => {
  try {
    let query = supabase
      .from('tills')
      .select('*')
      .eq('company_id', req.companyId)
      .order('till_number');

    if (!req.query.include_inactive) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tills: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/tills
 * Create a new till
 */
router.post('/', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { till_name, till_number, location } = req.body;
    if (!till_name || !till_number) {
      return res.status(400).json({ error: 'till_name and till_number are required' });
    }

    const { data, error } = await supabase
      .from('tills')
      .insert({
        company_id: req.companyId,
        till_name,
        till_number,
        location: location || null,
        is_active: true
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ till: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/pos/tills/:id
 * Update a till — name, number, location, or is_active flag.
 */
router.patch('/:id', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const tillId = parseInt(req.params.id);
    const { is_active, till_name, till_number, location } = req.body;

    const updates = {};
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (till_name)   updates.till_name   = till_name.trim();
    if (till_number) updates.till_number = till_number.trim();
    if (location !== undefined) updates.location = location ? location.trim() : null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('tills')
      .update(updates)
      .eq('id', tillId)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Till not found' });
    res.json({ till: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/till/daily-reset
 * Reset daily counters for ONE till (close its own open session(s))
 */
router.post('/daily-reset', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    // BUG FIX (found live, 2026-09-04 — Magda's till went from "Till Open"
    // to "No Session" mid-shift after closing/reopening her computer, no
    // action taken by her): this route was closing EVERY open session in
    // the ENTIRE COMPANY, not just the till it was invoked for — despite
    // the frontend (index.html's dailyTillReset()) already correctly
    // resolving and sending till_id in the request body, which this route
    // silently ignored. The button/confirm text both say "start a fresh
    // day for THE till" (singular) — company-wide closure was never the
    // intent. Whoever ran a Daily Reset on their own till (elsewhere in
    // the store) also silently closed Magda's genuinely-in-use session at
    // the same time, forcing a brand new session to be opened for her just
    // so she could keep working, while her real one sits closed needing a
    // separate cashup. Scoping to till_id fixes this at the source.
    const { till_id } = req.body;
    if (!till_id) return res.status(400).json({ error: 'till_id is required' });

    // BUG FIX (found live, 2026-07-31, same audit as /sessions/pending-cashup):
    // this used to blanket-UPDATE every open session straight to 'closed'
    // without ever computing expected_balance — unlike POST /:id/close, which
    // always derives it via computeSessionRecon(). Any session closed through
    // Daily Reset therefore landed in the pending-cashup list showing
    // "Expected: R0.00" regardless of actual sales, indistinguishable from a
    // real zero-sales till. Compute it per-session here the same way /close
    // does, so a Daily Reset session reconciles identically to a manually
    // closed one.
    const { data: openSessions, error: fetchError } = await supabase
      .from('till_sessions')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('till_id', till_id)
      .eq('status', 'open');

    if (fetchError) return res.status(500).json({ error: fetchError.message });

    for (const s of (openSessions || [])) {
      let expected = null;
      try {
        const recon = await computeSessionRecon(s.id, req.companyId);
        expected = recon.expectedCashInDrawer;
      } catch (reconErr) {
        console.warn('[DailyReset] Recon calc skipped for session', s.id, reconErr.message);
      }

      await supabase
        .from('till_sessions')
        .update({
          status: 'closed',
          expected_balance: expected,
          closed_at: new Date().toISOString(),
          notes: 'Closed by daily reset'
        })
        .eq('id', s.id);
    }

    // Never logged at all before this fix — the incident that surfaced the
    // till_id scoping bug above (Magda's session closed by someone else's
    // Daily Reset) left zero audit trail; there was no way to see who ran
    // it, when, or which till/sessions it affected. This is exactly the
    // "show us what an employee clicked" gap Ruan raised in the same
    // conversation — logging it here is a direct, scoped answer for this
    // one action type, not a redesign of the audit log itself.
    posAuditFromReq(req, POS_EVENTS.SESSION_CLOSED, {
      tillId: till_id,
      metadata: {
        reason: 'daily_reset',
        session_ids_closed: (openSessions || []).map(s => s.id),
      },
    });

    res.json({
      success: true,
      message: `${(openSessions || []).length} open session(s) on this till closed`,
      sessions_closed: (openSessions || []).length
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
