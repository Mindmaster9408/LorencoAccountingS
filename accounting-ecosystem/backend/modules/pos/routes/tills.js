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
 * Reset daily counters (close all open sessions)
 */
router.post('/daily-reset', requirePermission('SALES.VOID'), async (req, res) => {
  try {
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

    res.json({ success: true, message: 'All open sessions closed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
