/* =============================================================
   Practice Tax Year Configuration  (Codebox 29)

   DRAFT / REVIEW ONLY.
   Tax constants stored here affect DRAFT estimates only.
   Verify all values against SARS published rates before activating.

   Mounted at /api/practice/tax-configs

   Routes (registration order — specific before generic):
     POST  /seed-from-js                  Seed DB configs from JS constants (one-off, no duplicates)
     GET   /:id/brackets                  List brackets for one config
     POST  /:id/brackets                  Add bracket to config
     GET   /:id/events                    Event history for one config
     PUT   /:id/brackets/:bracketId       Update bracket
     DELETE /:id/brackets/:bracketId      Delete bracket
     PUT   /:id/activate                  Transition: draft/archived → active
     PUT   /:id/archive                   Transition: active/draft → archived
     PUT   /:id/lock                      Lock config (prevents further editing)
     GET   /:id                           Get one config (includes brackets)
     PUT   /:id                           Update config fields
     GET   /                              List configs (filter: tax_year, status, country_code)
     POST  /                              Create config
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }        = require('../../config/database');
const { auditFromReq }    = require('../../middleware/audit');
const {
    TAX_YEAR_CONSTANTS,
    getConstants,
} = require('./individual-tax-constants');

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_STATUSES  = ['draft', 'active', 'archived'];
const COUNTRY_CODES    = ['ZA'];
const EVENT_TYPES      = [
    'config_created', 'config_updated', 'config_activated', 'config_archived',
    'config_reviewed', 'config_locked',
    'bracket_created', 'bracket_updated', 'bracket_deleted',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyConfigOwnership(configId, companyId) {
    // A config is accessible if company_id matches OR company_id is null (global)
    let q = supabase
        .from('practice_tax_year_configs')
        .select('*')
        .eq('id', configId);

    const { data, error } = await q;
    if (error || !data || data.length === 0) return null;

    const cfg = data[0];
    // Global configs (company_id null) are accessible to everyone
    if (cfg.company_id === null) return cfg;
    // Company-scoped configs: must match caller's company
    if (cfg.company_id === companyId) return cfg;
    return null;
}

async function logConfigEvent(configId, companyId, eventType, extras = {}) {
    try {
        await supabase.from('practice_tax_config_events').insert({
            config_id:     configId,
            company_id:    companyId || null,
            event_type:    eventType,
            old_status:    extras.old_status    || null,
            new_status:    extras.new_status    || null,
            actor_user_id: extras.actor_user_id || null,
            notes:         extras.notes         || null,
            metadata:      extras.metadata      || {},
        });
    } catch (e) { /* non-fatal */ }
}

function sanitizeConfigBody(body) {
    const allowed = [
        'tax_year', 'config_name', 'country_code',
        'effective_from', 'effective_to',
        'tax_threshold_under_65', 'tax_threshold_65_to_74', 'tax_threshold_75_plus',
        'primary_rebate', 'secondary_rebate', 'tertiary_rebate',
        'medical_credit_main_member', 'medical_credit_first_dependent', 'medical_credit_additional_dep',
        'retirement_annuity_pct_limit', 'retirement_annuity_annual_cap',
        'donations_pct_limit',
        'source_note', 'notes', 'settings',
    ];
    const out = {};
    for (const k of allowed) {
        if (k in body) out[k] = body[k];
    }
    return out;
}

// ─── POST /seed-from-js ───────────────────────────────────────────────────────
// One-off helper: copy JS constants into DB. Skips years that already have a config.
// Must be registered BEFORE /:id routes.

router.post('/seed-from-js', async (req, res) => {
    const actorId = req.user?.id || null;
    const results = [];
    const errors  = [];

    for (const [yearStr, consts] of Object.entries(TAX_YEAR_CONSTANTS)) {
        const taxYear = parseInt(yearStr);

        // Check if a config already exists for this year (global scope)
        const { data: existing } = await supabase
            .from('practice_tax_year_configs')
            .select('id, status')
            .eq('tax_year', taxYear)
            .is('company_id', null)
            .eq('country_code', 'ZA');

        if (existing && existing.length > 0) {
            results.push({ tax_year: taxYear, action: 'skipped', reason: 'config already exists', config_id: existing[0].id });
            continue;
        }

        // Insert config
        const now = new Date().toISOString();
        const { data: newConfig, error: cfgErr } = await supabase
            .from('practice_tax_year_configs')
            .insert({
                company_id:                    null,
                tax_year:                      taxYear,
                config_name:                   'SARS ' + taxYear + ' — seeded from JS constants',
                country_code:                  'ZA',
                status:                        'draft',
                primary_rebate:                consts.rebates?.primary             || null,
                secondary_rebate:              consts.rebates?.secondary           || null,
                tertiary_rebate:               consts.rebates?.tertiary            || null,
                medical_credit_main_member:    consts.medical_credits_monthly?.main_member     || null,
                medical_credit_first_dependent:consts.medical_credits_monthly?.first_dependent || null,
                medical_credit_additional_dep: consts.medical_credits_monthly?.additional_dep  || null,
                tax_threshold_under_65:        consts.thresholds?.under_65         || null,
                tax_threshold_65_to_74:        consts.thresholds?.['65_to_74']     || null,
                tax_threshold_75_plus:         consts.thresholds?.['75_plus']      || null,
                retirement_annuity_pct_limit:  27.5,
                retirement_annuity_annual_cap: 350000,
                donations_pct_limit:           10.0,
                source_note:                   'Seeded from individual-tax-constants.js / ' + (consts.version || 'unknown'),
                created_by:                    actorId,
                updated_by:                    actorId,
                created_at:                    now,
                updated_at:                    now,
            })
            .select()
            .single();

        if (cfgErr) {
            errors.push({ tax_year: taxYear, error: cfgErr.message });
            continue;
        }

        // Insert brackets
        if (consts.brackets && consts.brackets.length > 0) {
            const bracketRows = consts.brackets.map(function (b, i) {
                return {
                    company_id:     null,
                    config_id:      newConfig.id,
                    tax_year:       taxYear,
                    bracket_order:  i + 1,
                    lower_bound:    b.from,
                    upper_bound:    b.to || null,
                    base_tax:       b.base,
                    marginal_rate:  b.rate * 100,   // stored as percentage
                    notes:          null,
                };
            });

            const { error: brackErr } = await supabase
                .from('practice_tax_brackets')
                .insert(bracketRows);

            if (brackErr) {
                errors.push({ tax_year: taxYear, error: 'Brackets failed: ' + brackErr.message });
                continue;
            }
        }

        await logConfigEvent(newConfig.id, null, 'config_created', {
            actor_user_id: actorId,
            notes: 'Seeded from JS constants',
            metadata: { tax_year: taxYear, bracket_count: (consts.brackets || []).length },
        });

        results.push({ tax_year: taxYear, action: 'created', config_id: newConfig.id, brackets: (consts.brackets || []).length });
    }

    res.json({ seeded: results, errors });
});

// ─── GET /:id/brackets ────────────────────────────────────────────────────────

router.get('/:id/brackets', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });

    const { data, error } = await supabase
        .from('practice_tax_brackets')
        .select('*')
        .eq('config_id', cfg.id)
        .order('bracket_order');
    if (error) return res.status(500).json({ error: error.message });

    res.json({ brackets: data || [] });
});

// ─── POST /:id/brackets ───────────────────────────────────────────────────────

router.post('/:id/brackets', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.locked_at) return res.status(400).json({ error: 'Config is locked. Cannot add brackets.' });

    const { bracket_order, lower_bound, upper_bound, base_tax, marginal_rate, notes } = req.body;

    if (lower_bound == null || lower_bound < 0)
        return res.status(400).json({ error: 'lower_bound must be >= 0' });
    if (upper_bound != null && upper_bound <= lower_bound)
        return res.status(400).json({ error: 'upper_bound must be > lower_bound' });
    if (marginal_rate == null || marginal_rate < 0)
        return res.status(400).json({ error: 'marginal_rate must be >= 0' });

    const { data, error } = await supabase
        .from('practice_tax_brackets')
        .insert({
            company_id:    cfg.company_id,
            config_id:     cfg.id,
            tax_year:      cfg.tax_year,
            bracket_order: bracket_order ? parseInt(bracket_order) : 99,
            lower_bound:   parseFloat(lower_bound),
            upper_bound:   upper_bound != null ? parseFloat(upper_bound) : null,
            base_tax:      base_tax    != null ? parseFloat(base_tax)    : 0,
            marginal_rate: parseFloat(marginal_rate),
            notes:         notes || null,
        })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'bracket_created', {
        actor_user_id: req.user?.id,
        metadata: { bracket_id: data.id },
    });
    await auditFromReq(req, 'CREATE', 'practice_tax_bracket', data.id, { module: 'practice' });

    res.status(201).json({ bracket: data });
});

// ─── GET /:id/events ──────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });

    const { data, error } = await supabase
        .from('practice_tax_config_events')
        .select('*')
        .eq('config_id', cfg.id)
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ events: data || [] });
});

// ─── PUT /:id/brackets/:bracketId ─────────────────────────────────────────────

router.put('/:id/brackets/:bracketId', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.locked_at) return res.status(400).json({ error: 'Config is locked. Cannot edit brackets.' });

    const bracketId = parseInt(req.params.bracketId);
    const { data: existing } = await supabase
        .from('practice_tax_brackets')
        .select('id')
        .eq('id', bracketId)
        .eq('config_id', cfg.id)
        .single();
    if (!existing) return res.status(404).json({ error: 'Bracket not found' });

    const allowed = ['bracket_order', 'lower_bound', 'upper_bound', 'base_tax', 'marginal_rate', 'notes'];
    const updates = {};
    for (const k of allowed) {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    }

    if (updates.lower_bound != null && parseFloat(updates.lower_bound) < 0)
        return res.status(400).json({ error: 'lower_bound must be >= 0' });
    if (updates.marginal_rate != null && parseFloat(updates.marginal_rate) < 0)
        return res.status(400).json({ error: 'marginal_rate must be >= 0' });

    const { data, error } = await supabase
        .from('practice_tax_brackets')
        .update(updates)
        .eq('id', bracketId)
        .eq('config_id', cfg.id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'bracket_updated', {
        actor_user_id: req.user?.id,
        metadata: { bracket_id: bracketId, changed: Object.keys(updates) },
    });

    res.json({ bracket: data });
});

// ─── DELETE /:id/brackets/:bracketId ──────────────────────────────────────────

router.delete('/:id/brackets/:bracketId', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.locked_at) return res.status(400).json({ error: 'Config is locked. Cannot delete brackets.' });

    const bracketId = parseInt(req.params.bracketId);
    const { data: existing } = await supabase
        .from('practice_tax_brackets')
        .select('id')
        .eq('id', bracketId)
        .eq('config_id', cfg.id)
        .single();
    if (!existing) return res.status(404).json({ error: 'Bracket not found' });

    const { error } = await supabase
        .from('practice_tax_brackets')
        .delete()
        .eq('id', bracketId)
        .eq('config_id', cfg.id);
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'bracket_deleted', {
        actor_user_id: req.user?.id,
        metadata: { bracket_id: bracketId },
    });

    res.json({ success: true });
});

// ─── PUT /:id/activate ────────────────────────────────────────────────────────
// Only one active config per tax_year/country/company_id scope should exist.
// We archive existing active config for same scope before activating.

router.put('/:id/activate', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.status === 'active') return res.status(400).json({ error: 'Config is already active' });
    if (cfg.locked_at && cfg.status !== 'draft')
        return res.status(400).json({ error: 'Config is locked and cannot be re-activated' });

    // Archive any currently active config for same year/country/scope
    await supabase
        .from('practice_tax_year_configs')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('tax_year',     cfg.tax_year)
        .eq('country_code', cfg.country_code)
        .eq('status',       'active')
        .neq('id', cfg.id)
        [cfg.company_id ? 'eq' : 'is']('company_id', cfg.company_id || null);

    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('practice_tax_year_configs')
        .update({
            status:     'active',
            updated_at: now,
            updated_by: req.user?.id || null,
        })
        .eq('id', cfg.id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'config_activated', {
        old_status:    cfg.status,
        new_status:    'active',
        actor_user_id: req.user?.id,
        notes:         req.body.notes || null,
    });
    await auditFromReq(req, 'UPDATE', 'practice_tax_year_config', cfg.id, { module: 'practice', action: 'activate' });

    res.json({ config: data });
});

// ─── PUT /:id/archive ─────────────────────────────────────────────────────────

router.put('/:id/archive', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.status === 'archived') return res.status(400).json({ error: 'Config is already archived' });

    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('practice_tax_year_configs')
        .update({ status: 'archived', updated_at: now, updated_by: req.user?.id || null })
        .eq('id', cfg.id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'config_archived', {
        old_status:    cfg.status,
        new_status:    'archived',
        actor_user_id: req.user?.id,
    });
    await auditFromReq(req, 'UPDATE', 'practice_tax_year_config', cfg.id, { module: 'practice', action: 'archive' });

    res.json({ config: data });
});

// ─── PUT /:id/lock ────────────────────────────────────────────────────────────

router.put('/:id/lock', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.locked_at) return res.status(400).json({ error: 'Config is already locked' });

    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('practice_tax_year_configs')
        .update({
            locked_at:  now,
            locked_by:  req.user?.id || null,
            updated_at: now,
            updated_by: req.user?.id || null,
        })
        .eq('id', cfg.id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'config_locked', {
        actor_user_id: req.user?.id,
        notes: req.body.notes || null,
    });
    await auditFromReq(req, 'UPDATE', 'practice_tax_year_config', cfg.id, { module: 'practice', action: 'lock' });

    res.json({ config: data });
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });

    // Load brackets alongside
    const { data: brackets } = await supabase
        .from('practice_tax_brackets')
        .select('*')
        .eq('config_id', cfg.id)
        .order('bracket_order');

    res.json({ config: cfg, brackets: brackets || [] });
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cfg = await verifyConfigOwnership(parseInt(req.params.id), req.companyId);
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (cfg.locked_at) return res.status(400).json({ error: 'Config is locked. Cannot edit.' });

    const body = sanitizeConfigBody(req.body);
    if (body.country_code && !COUNTRY_CODES.includes(body.country_code))
        return res.status(400).json({ error: 'Invalid country_code' });

    body.updated_at = new Date().toISOString();
    body.updated_by = req.user?.id || null;

    const { data, error } = await supabase
        .from('practice_tax_year_configs')
        .update(body)
        .eq('id', cfg.id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(cfg.id, cfg.company_id, 'config_updated', {
        actor_user_id: req.user?.id,
        metadata: { changed: Object.keys(body).filter(k => !['updated_at','updated_by'].includes(k)) },
    });
    await auditFromReq(req, 'UPDATE', 'practice_tax_year_config', cfg.id, { module: 'practice' });

    res.json({ config: data });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const { tax_year, status, country_code } = req.query;

    // Return global configs (company_id null) AND company-specific configs for this company
    let q = supabase
        .from('practice_tax_year_configs')
        .select('*')
        .or('company_id.is.null,company_id.eq.' + req.companyId)
        .order('tax_year', { ascending: false })
        .order('company_id', { ascending: true, nullsFirst: true });

    if (tax_year)    q = q.eq('tax_year',     parseInt(tax_year));
    if (status)      q = q.eq('status',       status);
    if (country_code) q = q.eq('country_code', country_code);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ configs: data || [], total: (data || []).length });
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const body = sanitizeConfigBody(req.body);

    if (!body.tax_year)    return res.status(400).json({ error: 'tax_year is required' });
    if (!body.config_name) return res.status(400).json({ error: 'config_name is required' });
    if (body.country_code && !COUNTRY_CODES.includes(body.country_code))
        return res.status(400).json({ error: 'Invalid country_code' });

    const now = new Date().toISOString();
    body.status     = 'draft';
    body.created_at = now;
    body.updated_at = now;
    // Global configs created through this public endpoint are always scoped null (global)
    // company-specific would require admin pathway (future)
    body.company_id = null;
    if (req.user?.id) { body.created_by = req.user.id; body.updated_by = req.user.id; }

    const { data, error } = await supabase
        .from('practice_tax_year_configs')
        .insert(body)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logConfigEvent(data.id, data.company_id, 'config_created', {
        actor_user_id: req.user?.id,
        new_status:    'draft',
    });
    await auditFromReq(req, 'CREATE', 'practice_tax_year_config', data.id, { module: 'practice' });

    res.status(201).json({ config: data });
});

module.exports = router;
