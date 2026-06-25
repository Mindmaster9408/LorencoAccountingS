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
    const { error } = await supabase
      .from('till_sessions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        notes: 'Closed by daily reset'
      })
      .eq('company_id', req.companyId)
      .eq('status', 'open');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'All open sessions closed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
