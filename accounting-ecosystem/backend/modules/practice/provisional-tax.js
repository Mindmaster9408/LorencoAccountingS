/* =============================================================
   Practice Provisional Tax Planning  (Codebox 26)
   NOT tax calculation. NOT SARS submission. NOT eFiling.
   Tracks provisional tax planning readiness and progress only.
   Due dates are editable planning defaults — not legal authority.
   Mounted at /api/practice/provisional-tax
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAN_STATUSES = [
    'draft', 'collecting_info', 'ready_for_review', 'reviewed',
    'submitted', 'completed', 'cancelled',
];

const PERIOD_TYPES = ['period_1', 'period_2', 'topup'];

const PERIOD_STATUSES = [
    'not_started', 'collecting_info', 'ready', 'reviewed',
    'submitted', 'paid', 'waived', 'cancelled',
];

const TAXPAYER_TYPES = ['individual', 'company', 'trust', 'partnership', 'cc'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyPlanOwnership(cid, planId) {
    const { data } = await supabase
        .from('practice_provisional_tax_plans')
        .select('*')
        .eq('id', planId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyPeriodOwnership(cid, planId, periodId) {
    const { data } = await supabase
        .from('practice_provisional_tax_periods')
        .select('*')
        .eq('id', periodId)
        .eq('plan_id', planId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logEvent(cid, planId, periodId, eventType, extras = {}) {
    await supabase.from('practice_provisional_tax_events').insert({
        company_id:    cid,
        plan_id:       planId,
        period_id:     periodId || null,
        event_type:    eventType,
        old_status:    extras.old_status    || null,
        new_status:    extras.new_status    || null,
        actor_user_id: extras.actor_user_id || null,
        notes:         extras.notes         || null,
        metadata:      extras.metadata      || {},
    });
}

// ─── SA due date planning defaults ───────────────────────────────────────────
// These are PLANNING DEFAULTS ONLY. Not legal authority. All dates are editable.
// Based on the common individual/company provisional tax schedule:
//   Period 1: 6 months into the tax year (for Feb year-end individuals: 31 Aug)
//   Period 2: Last day of the tax year (for Feb year-end: 28/29 Feb)
//   Top-up: 6 months after year-end assessment window (commonly ~30 Sep next year)
// For companies: year-end determines the cycle — we store null and let practice fill in.

function calcDefaultDueDates(taxYear, taxpayerType) {
    // taxYear = 2026 means 1 Mar 2025 – 28 Feb 2026 for individuals
    if (taxpayerType === 'individual') {
        return {
            period_1_due_date: `${taxYear - 1}-08-31`,  // 31 Aug of prior year
            period_2_due_date: `${taxYear}-02-28`,       // 28 Feb of tax year
            topup_due_date:    `${taxYear}-09-30`,        // 30 Sep after tax year end
        };
    }
    // For companies the year-end varies — leave null, practice fills in
    return { period_1_due_date: null, period_2_due_date: null, topup_due_date: null };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// IMPORTANT: literal sub-routes BEFORE parameterised /:id to prevent false matches

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: plans, error } = await supabase
            .from('practice_provisional_tax_plans')
            .select('status, tax_year, period_1_due_date, period_2_due_date, topup_due_date')
            .eq('company_id', cid)
            .neq('status', 'cancelled');
        if (error) throw error;

        const byStatus = {};
        PLAN_STATUSES.forEach(s => { byStatus[s] = 0; });
        const byYear   = {};
        let upcomingP1 = 0;
        let upcomingP2 = 0;
        const today = new Date().toISOString().slice(0, 10);

        (plans || []).forEach(p => {
            byStatus[p.status] = (byStatus[p.status] || 0) + 1;
            byYear[p.tax_year] = (byYear[p.tax_year] || 0) + 1;
            if (p.period_1_due_date && p.period_1_due_date >= today) upcomingP1++;
            if (p.period_2_due_date && p.period_2_due_date >= today) upcomingP2++;
        });

        res.json({
            summary: {
                total:       plans.length,
                by_status:   byStatus,
                by_year:     byYear,
                upcoming_p1: upcomingP1,
                upcoming_p2: upcomingP2,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET / (list) ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, tax_year, status, taxpayer_profile_id,
        page = 1, limit = 50,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        let q = supabase
            .from('practice_provisional_tax_plans')
            .select(`
                *,
                clients:practice_clients!client_id(display_name, company_name)
            `)
            .eq('company_id', cid)
            .order('tax_year', { ascending: false })
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        if (client_id)          q = q.eq('client_id', parseInt(client_id));
        if (tax_year)           q = q.eq('tax_year', parseInt(tax_year));
        if (status)             q = q.eq('status', status);
        if (taxpayer_profile_id) q = q.eq('taxpayer_profile_id', parseInt(taxpayer_profile_id));

        const { data, error } = await q;
        if (error) throw error;

        const plans = (data || []).map(p => ({
            ...p,
            client_name: p.clients?.display_name || p.clients?.company_name || null,
            clients: undefined,
        }));

        res.json({ provisional_tax_plans: plans });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST / (create) ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_profile_id, tax_year, plan_name,
        taxpayer_type, provisional_taxpayer,
        prior_year_taxable_income, current_estimated_taxable_income,
        estimate_basis, risk_notes, notes, internal_notes,
        responsible_team_member_id, reviewer_team_member_id,
        period_1_due_date, period_2_due_date, topup_due_date,
        related_compliance_pack_id, related_deadline_id, related_workflow_run_id,
    } = req.body;

    if (!client_id)            return res.status(400).json({ error: 'client_id is required' });
    if (!taxpayer_profile_id)  return res.status(400).json({ error: 'taxpayer_profile_id is required' });
    if (!tax_year)             return res.status(400).json({ error: 'tax_year is required' });
    if (!plan_name?.trim())    return res.status(400).json({ error: 'plan_name is required' });
    if (tax_year < 2000 || tax_year > 2099)
        return res.status(400).json({ error: 'tax_year must be between 2000 and 2099' });

    // Verify client and profile belong to this company
    const { data: client } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('id', client_id)
        .eq('company_id', cid)
        .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: profile } = await supabase
        .from('practice_taxpayer_profiles')
        .select('id, taxpayer_type')
        .eq('id', taxpayer_profile_id)
        .eq('company_id', cid)
        .single();
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    // Use planning-default due dates if not supplied
    const resolvedType = taxpayer_type || profile.taxpayer_type;
    const defaults     = calcDefaultDueDates(parseInt(tax_year), resolvedType);

    if (prior_year_taxable_income != null && prior_year_taxable_income < 0)
        return res.status(400).json({ error: 'prior_year_taxable_income must be >= 0' });
    if (current_estimated_taxable_income != null && current_estimated_taxable_income < 0)
        return res.status(400).json({ error: 'current_estimated_taxable_income must be >= 0' });

    try {
        const { data: plan, error } = await supabase
            .from('practice_provisional_tax_plans')
            .insert({
                company_id:                      cid,
                client_id:                       parseInt(client_id),
                taxpayer_profile_id:             parseInt(taxpayer_profile_id),
                tax_year:                        parseInt(tax_year),
                plan_name:                       plan_name.trim(),
                status:                          'draft',
                taxpayer_type:                   resolvedType || null,
                provisional_taxpayer:            provisional_taxpayer !== false,
                prior_year_taxable_income:       prior_year_taxable_income  != null ? parseFloat(prior_year_taxable_income)  : null,
                current_estimated_taxable_income: current_estimated_taxable_income != null ? parseFloat(current_estimated_taxable_income) : null,
                estimate_basis:                  estimate_basis   || null,
                risk_notes:                      risk_notes       || null,
                notes:                           notes            || null,
                internal_notes:                  internal_notes   || null,
                responsible_team_member_id:      responsible_team_member_id  || null,
                reviewer_team_member_id:         reviewer_team_member_id     || null,
                period_1_due_date:               period_1_due_date || defaults.period_1_due_date,
                period_2_due_date:               period_2_due_date || defaults.period_2_due_date,
                topup_due_date:                  topup_due_date    || defaults.topup_due_date,
                related_compliance_pack_id:      related_compliance_pack_id  || null,
                related_deadline_id:             related_deadline_id          || null,
                related_workflow_run_id:         related_workflow_run_id      || null,
                created_by:                      req.user?.id || null,
                updated_by:                      req.user?.id || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, plan.id, null, 'provisional_tax_plan_created', {
            actor_user_id: req.user?.id,
            metadata: { tax_year: plan.tax_year, plan_name: plan.plan_name },
        });
        await auditFromReq(req, 'provisional_tax_plan_created', { plan_id: plan.id, tax_year: plan.tax_year });

        res.status(201).json({ plan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    try {
        const { data: plan, error } = await supabase
            .from('practice_provisional_tax_plans')
            .select(`
                *,
                clients:practice_clients!client_id(display_name, company_name)
            `)
            .eq('id', planId)
            .eq('company_id', cid)
            .single();
        if (error || !plan) return res.status(404).json({ error: 'Plan not found' });

        const { data: periods } = await supabase
            .from('practice_provisional_tax_periods')
            .select('*')
            .eq('plan_id', planId)
            .eq('company_id', cid)
            .order('period_type');

        res.json({
            plan: {
                ...plan,
                client_name: plan.clients?.display_name || plan.clients?.company_name || null,
                clients: undefined,
            },
            periods: periods || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    const existing = await verifyPlanOwnership(cid, planId);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Cannot modify a cancelled plan' });

    const allowed = [
        'plan_name', 'status', 'taxpayer_type', 'provisional_taxpayer',
        'prior_year_taxable_income', 'current_estimated_taxable_income',
        'estimate_basis', 'risk_notes', 'notes', 'internal_notes',
        'responsible_team_member_id', 'reviewer_team_member_id',
        'period_1_due_date', 'period_2_due_date', 'topup_due_date',
        'related_compliance_pack_id', 'related_deadline_id', 'related_workflow_run_id',
    ];

    const updates = { updated_at: new Date().toISOString(), updated_by: req.user?.id || null };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.status && !PLAN_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });
    if (updates.taxpayer_type && !TAXPAYER_TYPES.includes(updates.taxpayer_type))
        return res.status(400).json({ error: 'Invalid taxpayer_type' });
    if (updates.prior_year_taxable_income != null && updates.prior_year_taxable_income < 0)
        return res.status(400).json({ error: 'prior_year_taxable_income must be >= 0' });
    if (updates.current_estimated_taxable_income != null && updates.current_estimated_taxable_income < 0)
        return res.status(400).json({ error: 'current_estimated_taxable_income must be >= 0' });

    try {
        const { data: plan, error } = await supabase
            .from('practice_provisional_tax_plans')
            .update(updates)
            .eq('id', planId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        if (updates.status && updates.status !== existing.status) {
            await logEvent(cid, planId, null, 'provisional_tax_status_changed', {
                old_status: existing.status, new_status: updates.status,
                actor_user_id: req.user?.id,
            });
        } else {
            await logEvent(cid, planId, null, 'provisional_tax_plan_updated', {
                actor_user_id: req.user?.id,
            });
        }
        await auditFromReq(req, 'provisional_tax_plan_updated', { plan_id: planId });

        res.json({ plan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /:id (soft cancel) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    const existing = await verifyPlanOwnership(cid, planId);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Plan already cancelled' });

    try {
        const { error } = await supabase
            .from('practice_provisional_tax_plans')
            .update({ status: 'cancelled', updated_at: new Date().toISOString(), updated_by: req.user?.id || null })
            .eq('id', planId)
            .eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, planId, null, 'provisional_tax_status_changed', {
            old_status: existing.status, new_status: 'cancelled',
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'provisional_tax_plan_cancelled', { plan_id: planId });

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /:id/create-periods ──────────────────────────────────────────────────
// Creates period_1, period_2, topup rows if they do not already exist

router.post('/:id/create-periods', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    const plan = await verifyPlanOwnership(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // Find which periods already exist
    const { data: existing } = await supabase
        .from('practice_provisional_tax_periods')
        .select('period_type')
        .eq('plan_id', planId)
        .eq('company_id', cid);

    const existingTypes = new Set((existing || []).map(p => p.period_type));
    const dueDates = {
        period_1: plan.period_1_due_date,
        period_2: plan.period_2_due_date,
        topup:    plan.topup_due_date,
    };

    const toInsert = PERIOD_TYPES
        .filter(t => !existingTypes.has(t))
        .map(t => ({
            company_id:   cid,
            plan_id:      planId,
            period_type:  t,
            due_date:     dueDates[t] || null,
            status:       'not_started',
        }));

    if (toInsert.length === 0) {
        return res.status(409).json({ error: 'All periods already exist', existing_types: [...existingTypes] });
    }

    try {
        const { data: periods, error } = await supabase
            .from('practice_provisional_tax_periods')
            .insert(toInsert)
            .select();
        if (error) throw error;

        for (const p of periods) {
            await logEvent(cid, planId, p.id, 'provisional_tax_period_created', {
                actor_user_id: req.user?.id,
                metadata: { period_type: p.period_type },
            });
        }
        await auditFromReq(req, 'provisional_tax_periods_created', { plan_id: planId, count: periods.length });

        // Return all periods for this plan
        const { data: allPeriods } = await supabase
            .from('practice_provisional_tax_periods')
            .select('*')
            .eq('plan_id', planId)
            .eq('company_id', cid)
            .order('period_type');

        res.status(201).json({ periods: allPeriods || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id/periods/:periodId/status ─────────────────────────────────────────
// Must be before PUT /:id/periods/:periodId (more specific path)

router.put('/:id/periods/:periodId/status', async (req, res) => {
    const cid      = req.companyId;
    const planId   = parseInt(req.params.id);
    const periodId = parseInt(req.params.periodId);
    const { status } = req.body;

    if (!status) return res.status(400).json({ error: 'status is required' });
    if (!PERIOD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const plan = await verifyPlanOwnership(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const period = await verifyPeriodOwnership(cid, planId, periodId);
    if (!period) return res.status(404).json({ error: 'Period not found' });

    try {
        const { data: updated, error } = await supabase
            .from('practice_provisional_tax_periods')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('id', periodId)
            .eq('plan_id', planId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, planId, periodId, 'provisional_tax_status_changed', {
            old_status: period.status, new_status: status,
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'provisional_tax_period_status_changed', { plan_id: planId, period_id: periodId, new_status: status });

        res.json({ period: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id/periods/:periodId ────────────────────────────────────────────────

router.put('/:id/periods/:periodId', async (req, res) => {
    const cid      = req.companyId;
    const planId   = parseInt(req.params.id);
    const periodId = parseInt(req.params.periodId);

    const plan = await verifyPlanOwnership(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const period = await verifyPeriodOwnership(cid, planId, periodId);
    if (!period) return res.status(404).json({ error: 'Period not found' });

    const allowed = [
        'due_date', 'status',
        'estimated_taxable_income', 'estimated_tax_due',
        'amount_submitted', 'amount_paid',
        'submitted_at', 'paid_at',
        'submission_reference', 'payment_reference',
        'notes',
    ];

    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.status && !PERIOD_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });

    const numericFields = ['estimated_taxable_income', 'estimated_tax_due', 'amount_submitted', 'amount_paid'];
    for (const f of numericFields) {
        if (updates[f] != null && parseFloat(updates[f]) < 0)
            return res.status(400).json({ error: `${f} must be >= 0` });
    }

    try {
        const { data: updated, error } = await supabase
            .from('practice_provisional_tax_periods')
            .update(updates)
            .eq('id', periodId)
            .eq('plan_id', planId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, planId, periodId, 'provisional_tax_period_updated', {
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'provisional_tax_period_updated', { plan_id: planId, period_id: periodId });

        res.json({ period: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /:id/review ──────────────────────────────────────────────────────────

router.post('/:id/review', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    const plan = await verifyPlanOwnership(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!['ready_for_review', 'reviewed'].includes(plan.status)) {
        return res.status(400).json({ error: 'Plan must be in ready_for_review or reviewed status to record a review' });
    }

    const { notes } = req.body;
    const reviewedAt = new Date().toISOString();

    try {
        const { data: updated, error } = await supabase
            .from('practice_provisional_tax_plans')
            .update({
                status:       'reviewed',
                reviewed_at:  reviewedAt,
                reviewed_by:  req.user?.id || null,
                updated_at:   reviewedAt,
                updated_by:   req.user?.id || null,
            })
            .eq('id', planId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, planId, null, 'provisional_tax_reviewed', {
            old_status: plan.status, new_status: 'reviewed',
            actor_user_id: req.user?.id,
            notes: notes || null,
        });
        await auditFromReq(req, 'provisional_tax_reviewed', { plan_id: planId });

        res.json({ plan: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid    = req.companyId;
    const planId = parseInt(req.params.id);

    const plan = await verifyPlanOwnership(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    try {
        const { data: events, error } = await supabase
            .from('practice_provisional_tax_events')
            .select('*')
            .eq('plan_id', planId)
            .eq('company_id', cid)
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;

        res.json({ events: events || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;
