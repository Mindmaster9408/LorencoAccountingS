/**
 * ============================================================================
 * VAT Settings — Rate/Category Configuration
 * ============================================================================
 * Manages the catalogue of VAT categories and rates for a company.
 * Supports current, historical, and future rates via effective_from/effective_to.
 *
 * SA VAT categories seeded by default:
 *   standard          — Standard Rate 15%  (current)
 *   standard_capital  — Standard Rate Capital 15%  (current)
 *   zero              — Zero Rated 0%
 *   exempt            — Exempt (no VAT)
 *   old_rate          — Old Rate 14%  (pre-April 2018, inactive)
 *   old_rate_capital  — Old Rate Capital 14%  (pre-April 2018, inactive)
 *
 * Security:
 *   - All reads: authenticate (any valid user)
 *   - Create/update/delete: authorize('admin', 'accountant')
 *   - Seed defaults: authorize('admin', 'accountant')
 * ============================================================================
 */
const express = require('express');
const router = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ── SA default VAT categories ────────────────────────────────────────────────
// code, name, rate, is_capital, is_active, effective_from, sort_order
const SA_DEFAULT_VAT_CATEGORIES = [
  { code: 'standard',         name: 'Standard Rate (15%)',           rate: 15, is_capital: false, is_active: true,  effective_from: '2018-04-01', sort_order: 10 },
  { code: 'standard_capital', name: 'Standard Rate — Capital (15%)', rate: 15, is_capital: true,  is_active: true,  effective_from: '2018-04-01', sort_order: 20 },
  { code: 'zero',             name: 'Zero Rated (0%)',               rate: 0,  is_capital: false, is_active: true,  effective_from: '1990-01-01', sort_order: 30 },
  { code: 'exempt',           name: 'Exempt',                        rate: 0,  is_capital: false, is_active: true,  effective_from: '1990-01-01', sort_order: 40 },
  { code: 'old_rate',         name: 'Old Rate (14%)',                rate: 14, is_capital: false, is_active: false, effective_from: '1990-01-01', sort_order: 50 },
  { code: 'old_rate_capital', name: 'Old Rate — Capital (14%)',      rate: 14, is_capital: true,  is_active: false, effective_from: '1990-01-01', sort_order: 60 },
];

// ── GET /api/accounting/vat-settings — list all settings for company ─────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vat_settings')
      .select('*')
      .eq('company_id', req.user.companyId)
      .order('sort_order')
      .order('effective_from', { ascending: false });

    if (error) throw error;

    res.json({ vatSettings: data || [] });
  } catch (err) {
    console.error('[vat-settings] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to fetch VAT settings', detail: err.message });
  }
});

// ── GET /api/accounting/vat-settings/active — active settings for a date ─────
// Used by bank allocation UI to populate the VAT category dropdown.
// Returns only active settings whose effective_from <= asOfDate and
// (effective_to IS NULL OR effective_to >= asOfDate).
// Defaults to today.
router.get('/active', authenticate, async (req, res) => {
  try {
    const asOfDate = req.query.date || new Date().toISOString().slice(0, 10);

    let query = supabase
      .from('vat_settings')
      .select('id, code, name, rate, is_capital, effective_from, effective_to, sort_order')
      .eq('company_id', req.user.companyId)
      .eq('is_active', true)
      .lte('effective_from', asOfDate)
      .order('sort_order');

    const { data, error } = await query;
    if (error) throw error;

    // Filter out settings whose effective_to has passed
    const active = (data || []).filter(s =>
      !s.effective_to || s.effective_to >= asOfDate
    );

    res.json({ vatSettings: active });
  } catch (err) {
    console.error('[vat-settings] GET /active error:', err.message);
    res.status(500).json({ error: 'Failed to fetch active VAT settings', detail: err.message });
  }
});

// ── POST /api/accounting/vat-settings/seed-defaults — seed SA defaults ───────
// Idempotent: skips codes that already exist for the company (per effective_from).
router.post('/seed-defaults', authenticate, authorize('admin', 'accountant'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const inserted = [];
    const skipped = [];

    for (const cat of SA_DEFAULT_VAT_CATEGORIES) {
      const { data: existing } = await supabase
        .from('vat_settings')
        .select('id')
        .eq('company_id', companyId)
        .eq('code', cat.code)
        .eq('effective_from', cat.effective_from)
        .maybeSingle();

      if (existing) {
        skipped.push(cat.code);
        continue;
      }

      const { error: insErr } = await supabase
        .from('vat_settings')
        .insert({ ...cat, company_id: companyId });

      if (insErr) throw insErr;
      inserted.push(cat.code);
    }

    res.json({ inserted, skipped });
  } catch (err) {
    console.error('[vat-settings] POST /seed-defaults error:', err.message);
    res.status(500).json({ error: 'Failed to seed VAT defaults', detail: err.message });
  }
});

// ── POST /api/accounting/vat-settings — create a new VAT category ────────────
router.post('/', authenticate, authorize('admin', 'accountant'), async (req, res) => {
  try {
    const { code, name, rate, is_capital, is_active, effective_from, effective_to, sort_order } = req.body;

    if (!code || !name || rate === undefined || rate === null) {
      return res.status(400).json({ error: 'code, name, and rate are required' });
    }

    const parsedRate = parseFloat(rate);
    if (isNaN(parsedRate) || parsedRate < 0 || parsedRate > 100) {
      return res.status(400).json({ error: 'rate must be a number between 0 and 100' });
    }

    const { data, error } = await supabase
      .from('vat_settings')
      .insert({
        company_id:     req.user.companyId,
        code:           code.trim().toLowerCase(),
        name:           name.trim(),
        rate:           parsedRate,
        is_capital:     !!is_capital,
        is_active:      is_active !== undefined ? !!is_active : true,
        effective_from: effective_from || '1990-01-01',
        effective_to:   effective_to || null,
        sort_order:     sort_order || 0,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A VAT setting with this code and effective date already exists' });
      }
      throw error;
    }

    res.status(201).json({ vatSetting: data });
  } catch (err) {
    console.error('[vat-settings] POST / error:', err.message);
    res.status(500).json({ error: 'Failed to create VAT setting', detail: err.message });
  }
});

// ── PUT /api/accounting/vat-settings/:id — update a VAT category ─────────────
router.put('/:id', authenticate, authorize('admin', 'accountant'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, rate, is_capital, is_active, effective_from, effective_to, sort_order } = req.body;

    // Verify ownership
    const { data: existing, error: findErr } = await supabase
      .from('vat_settings')
      .select('id, company_id, code')
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .single();

    if (findErr || !existing) {
      return res.status(404).json({ error: 'VAT setting not found' });
    }

    const updates = {};
    if (name !== undefined)           updates.name           = name.trim();
    if (rate !== undefined) {
      const r = parseFloat(rate);
      if (isNaN(r) || r < 0 || r > 100) {
        return res.status(400).json({ error: 'rate must be between 0 and 100' });
      }
      updates.rate = r;
    }
    if (is_capital !== undefined)     updates.is_capital     = !!is_capital;
    if (is_active !== undefined)      updates.is_active      = !!is_active;
    if (effective_from !== undefined) updates.effective_from = effective_from;
    if (effective_to !== undefined)   updates.effective_to   = effective_to || null;
    if (sort_order !== undefined)     updates.sort_order     = sort_order;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('vat_settings')
      .update(updates)
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .select()
      .single();

    if (error) throw error;

    res.json({ vatSetting: data });
  } catch (err) {
    console.error('[vat-settings] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Failed to update VAT setting', detail: err.message });
  }
});

// ── DELETE /api/accounting/vat-settings/:id — deactivate (soft delete) ───────
// Only deactivates — never hard-deletes. Historical rates must be preserved.
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('vat_settings')
      .select('id, code')
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'VAT setting not found' });
    }

    const { error } = await supabase
      .from('vat_settings')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', req.user.companyId);

    if (error) throw error;

    res.json({ success: true, message: `VAT setting '${existing.code}' deactivated` });
  } catch (err) {
    console.error('[vat-settings] DELETE /:id error:', err.message);
    res.status(500).json({ error: 'Failed to deactivate VAT setting', detail: err.message });
  }
});

module.exports = router;
