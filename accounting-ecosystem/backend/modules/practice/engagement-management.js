'use strict';

// Codebox 71 — Practice Engagement Management + Engagement Letter Foundation
// "Are we formally engaged to perform this work?" and "What engagements need
// review or renewal?" — within seconds.
//
// NOT document generation. NOT e-signature. NOT automatic proposal
// acceptance. NOT legal drafting. Structured engagement governance and
// engagement-letter TRACKING only.
//
// ENHANCEMENT LAYER — NOT A REWRITE. A full engagement system already exists
// (Codebox 15/16: practice_service_catalog, practice_client_engagements,
// practice_client_engagement_events, practice_engagement_periods — router
// modules/practice/engagements.js, 638 lines, mounted at the practice
// router's root). This module is mounted SEPARATELY at /engagement-management
// and NEVER modifies engagements.js or its tables' existing behavior.
//
// See migration 128's header for the definitive, field-by-field audit of
// what already existed vs. what was genuinely added.
//
// CRITICAL: engagements.js's generate-workflow/generation-preview endpoints
// GATE on the legacy `status` column being exactly 'active' (a live
// functional dependency, not just a naming convention). engagement_status
// (this module's richer 10-value lifecycle) is a separate, additional model
// — but because of that live dependency, THIS module keeps the legacy
// `status` column in sync for the transitions where a clean, unambiguous
// equivalent exists (see STATUS_SYNC_MAP below). draft/proposed/under_review/
// renewal_due/renewed never touch the legacy column.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGAGEMENT_STATUSES = ['draft', 'proposed', 'active', 'paused', 'under_review', 'renewal_due', 'renewed', 'ended', 'cancelled', 'rejected'];
const ENGAGEMENT_TYPES = ['accounting', 'tax', 'payroll', 'secretarial', 'advisory', 'compliance', 'bookkeeping', 'company_secretarial', 'management', 'custom'];
const FEE_BASES = ['fixed_monthly', 'fixed_annual', 'hourly', 'per_service', 'once_off', 'retainer', 'quote_based', 'no_charge', 'other'];
const BILLING_FREQUENCIES = ['monthly', 'quarterly', 'annual', 'once_off', 'ad_hoc', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const LETTER_STATUSES = ['draft', 'sent', 'signed', 'waived', 'expired', 'archived', 'cancelled'];

const TERMINAL_ENGAGEMENT_STATUSES = ['ended', 'cancelled', 'rejected'];
// Statuses that count as "the work is genuinely happening or has just
// happened" — used for active-engagement lists, work-coverage checks, and
// review-completion. Deliberately includes under_review/renewal_due/renewed
// (work continues through review) but not draft/proposed (not yet live).
const ACTIVE_LIKE_ENGAGEMENT_STATUSES = ['active', 'under_review', 'renewal_due', 'renewed'];

// The ONLY place the legacy `status` column (Codebox 15/16, 4 values) is
// ever touched by this module — only for transitions with a clean,
// unambiguous equivalent. See migration 128's header for why this exists
// (engagements.js's generate-workflow gate has a live dependency on
// status === 'active').
const STATUS_SYNC_MAP = { active: 'active', paused: 'paused', ended: 'ended', cancelled: 'cancelled', rejected: 'cancelled' };

// Deterministic transition rules — an unlisted (action, current engagement_status)
// combination always returns 422. "Never guess."
const TRANSITIONS = {
    propose: { from: ['draft'], to: 'proposed' },
    reject: { from: ['proposed'], to: 'rejected' },
    activate: { from: ['proposed', 'renewed'], to: 'active' },
    pause: { from: ['active', 'under_review'], to: 'paused' },
    resume: { from: ['paused'], to: 'active' },
    'start-review': { from: ['active'], to: 'under_review' },
    'complete-review': { from: ['under_review'], to: 'active' },
    'mark-renewal-due': { from: ['active', 'under_review'], to: 'renewal_due' },
    renew: { from: ['renewal_due'], to: 'renewed' },
    end: { from: ['active', 'paused', 'under_review', 'renewal_due', 'renewed'], to: 'ended' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

async function _myTeamMember(cid, user) {
    return teamAccess.getMyTeamMember(supabase, cid, user);
}
function _isManager(member) { return teamAccess.isManager(member); }

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can manage engagements.');
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _fetchEngagement(cid, id) {
    const { data } = await supabase.from('practice_client_engagements').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, engagementId, letterId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_engagement_management_events').insert({
        company_id: cid, client_id: clientId || null, engagement_id: engagementId || null, letter_id: letterId || null,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// An engagement created before migration 128 (or via the legacy engagements.js
// router) may have engagement_status still at its 'draft' default while its
// legacy `status` is already 'active' — this must never be misread as "not
// active" by this module's own checks. See migration 128's header.
function _isEffectivelyActive(eng) {
    return ACTIVE_LIKE_ENGAGEMENT_STATUSES.includes(eng.engagement_status) || eng.status === 'active';
}
function _letterObligationFulfilled(eng) {
    return ['not_required', 'signed', 'waived'].includes(eng.engagement_letter_status);
}

// ── Engine — getClientEngagementProfile() ────────────────────────────────────

async function getClientEngagementProfile(cid, clientId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    const { data: engagements } = await supabase.from('practice_client_engagements').select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false });
    const rows = engagements || [];
    const active = rows.filter(_isEffectivelyActive);
    const t = today();

    const dueForReview = active.filter(e => e.next_review_date && e.next_review_date <= t);
    const renewalDue = rows.filter(e => e.engagement_status === 'renewal_due' || (e.renewal_date && e.renewal_date <= t && _isEffectivelyActive(e)));
    const missingLetters = active.filter(e => !_letterObligationFulfilled(e));
    const highRisk = active.filter(e => ['high', 'critical'].includes(e.risk_level));
    const servicesCovered = [...new Set(active.map(e => e.engagement_type || e.service_category).filter(Boolean))];

    const possibleGaps = await _detectPossibleGaps(cid, clientId, active);

    return {
        client,
        engagements: rows,
        active_engagements: active,
        due_for_review: dueForReview,
        renewal_due: renewalDue,
        missing_engagement_letters: missingLetters,
        high_risk_engagements: highRisk,
        services_covered: servicesCovered,
        possible_gaps: possibleGaps,
    };
}

// Detects OBVIOUS gaps only — every flag is `possible_gap`, never definitive.
// A human decides whether an engagement is genuinely missing or whether the
// work is covered under a broader/different engagement type than guessed here.
async function _detectPossibleGaps(cid, clientId, activeEngagements) {
    const gaps = [];
    const activeTypes = new Set(activeEngagements.map(e => e.engagement_type).filter(Boolean));
    const hasType = types => types.some(t => activeTypes.has(t));

    try {
        const { count: taxCount } = await supabase.from('practice_taxpayer_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId);
        if ((taxCount || 0) > 0 && !hasType(['tax'])) {
            gaps.push({ area: 'tax', reason: 'Client has a tax profile but no active tax engagement.', severity: 'possible_gap' });
        }
    } catch (e) { /* non-fatal — one gap check failing must never block the rest */ }

    try {
        const { count: paye } = await supabase.from('practice_taxpayer_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId).eq('paye_registered', true);
        if ((paye || 0) > 0 && !hasType(['payroll'])) {
            gaps.push({ area: 'payroll', reason: 'Client is PAYE-registered but has no active payroll engagement.', severity: 'possible_gap' });
        }
    } catch (e) { /* non-fatal */ }

    try {
        const [secProfile, changeCases] = await Promise.all([
            supabase.from('practice_secretarial_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId),
            supabase.from('practice_secretarial_change_cases').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId),
        ]);
        if (((secProfile.count || 0) > 0 || (changeCases.count || 0) > 0) && !hasType(['secretarial', 'company_secretarial'])) {
            gaps.push({ area: 'secretarial', reason: 'Client has secretarial records/workflows but no active secretarial engagement.', severity: 'possible_gap' });
        }
    } catch (e) { /* non-fatal */ }

    try {
        const { count: timeEntries } = await supabase.from('practice_time_entries').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId);
        if ((timeEntries || 0) > 0 && !hasType(['accounting', 'bookkeeping', 'advisory'])) {
            gaps.push({ area: 'accounting', reason: 'Client has recorded time entries but no active accounting/bookkeeping/advisory engagement.', severity: 'possible_gap' });
        }
    } catch (e) { /* non-fatal */ }

    return gaps;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: rows } = await supabase.from('practice_client_engagements')
            .select('engagement_status, status, risk_level, risk_accepted_by, engagement_letter_status, next_review_date, renewal_date').eq('company_id', cid);
        const engagements = rows || [];
        const t = today();

        const statusCounts = {}; ENGAGEMENT_STATUSES.forEach(s => { statusCounts[s] = 0; });
        engagements.forEach(e => { if (e.engagement_status in statusCounts) statusCounts[e.engagement_status]++; });

        const active = engagements.filter(_isEffectivelyActive);
        const dueForReview = active.filter(e => e.next_review_date && e.next_review_date <= t).length;
        const renewalDue = engagements.filter(e => e.engagement_status === 'renewal_due' || (e.renewal_date && e.renewal_date <= t && _isEffectivelyActive(e))).length;
        const missingLetters = active.filter(e => !_letterObligationFulfilled(e)).length;
        const highRiskWithoutAcceptance = engagements.filter(e => ['high', 'critical'].includes(e.risk_level) && !e.risk_accepted_by).length;

        res.json({
            engagements_total: engagements.length,
            by_engagement_status: statusCounts,
            active_engagements: active.length,
            due_for_review: dueForReview,
            renewal_due: renewalDue,
            missing_engagement_letters: missingLetters,
            high_risk_without_acceptance: highRiskWithoutAcceptance,
        });
    } catch (err) {
        console.error('Engagement-management /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENGAGEMENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { client_id, engagement_status, risk_level, engagement_type, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_client_engagements').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (engagement_status) q = q.eq('engagement_status', engagement_status);
        if (risk_level) q = q.eq('risk_level', risk_level);
        if (engagement_type) q = q.eq('engagement_type', engagement_type);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(e => e.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ engagements: (data || []).map(e => ({ ...e, client_name: nameById[e.client_id] || null })) });
    } catch (err) {
        console.error('Engagement-management GET list error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/client/:clientId/profile', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    try {
        const result = await getClientEngagementProfile(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Engagement-management GET client profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, engagement_name, service_category } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!engagement_name) return res.status(400).json({ error: 'engagement_name is required' });
    if (!service_category) return res.status(400).json({ error: 'service_category is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const engagementStatus = ENGAGEMENT_STATUSES.includes(req.body.engagement_status) ? req.body.engagement_status : 'draft';
    if (req.body.engagement_type && !ENGAGEMENT_TYPES.includes(req.body.engagement_type)) return res.status(400).json({ error: 'Invalid engagement_type' });
    if (req.body.fee_basis && !FEE_BASES.includes(req.body.fee_basis)) return res.status(400).json({ error: 'Invalid fee_basis' });
    if (req.body.billing_frequency && !BILLING_FREQUENCIES.includes(req.body.billing_frequency)) return res.status(400).json({ error: 'Invalid billing_frequency' });
    if (req.body.risk_level && !RISK_LEVELS.includes(req.body.risk_level)) return res.status(400).json({ error: 'Invalid risk_level' });

    // Legacy `status` must be set explicitly at creation — its own DB DEFAULT
    // is 'active', which would silently misrepresent a draft/proposed
    // engagement to engagements.js's generate-workflow gate. See STATUS_SYNC_MAP.
    const legacyStatus = STATUS_SYNC_MAP[engagementStatus] || 'paused';

    const insertRow = {
        company_id: cid, client_id: clientId, engagement_name, service_category,
        status: legacyStatus, engagement_status: engagementStatus,
        engagement_type: req.body.engagement_type || null,
        description: req.body.description || null,
        scope_summary: req.body.scope_summary || null,
        scope_inclusions: req.body.scope_inclusions || [],
        scope_exclusions: req.body.scope_exclusions || [],
        fee_basis: req.body.fee_basis || null,
        fee_amount: req.body.fee_amount || null,
        billing_frequency: req.body.billing_frequency || null,
        start_date: req.body.start_date || null,
        next_review_date: req.body.next_review_date || null,
        renewal_date: req.body.renewal_date || null,
        partner_team_member_id: req.body.responsible_partner_id || null,
        responsible_team_member_id: req.body.responsible_manager_id || null,
        risk_level: req.body.risk_level || 'low',
        risk_notes: req.body.risk_notes || null,
        notes: req.body.notes || null,
        internal_notes: req.body.internal_notes || null,
        created_by: req.user.userId,
    };

    try {
        const { data, error } = await supabase.from('practice_client_engagements').insert(insertRow).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, clientId, data.id, null, 'engagement_created', null, engagementStatus, req.user.userId, null, {});
        res.status(201).json({ engagement: data });
    } catch (err) {
        console.error('Engagement-management POST error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    try {
        const eng = await _fetchEngagement(cid, id);
        if (!eng) return res.status(404).json({ error: 'Engagement not found' });
        const { data: letters } = await supabase.from('practice_engagement_letters').select('*').eq('company_id', cid).eq('engagement_id', id).order('created_at', { ascending: false });
        res.json({ engagement: eng, letters: letters || [] });
    } catch (err) {
        console.error('Engagement-management GET :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchEngagement(cid, id);
    if (!existing) return res.status(404).json({ error: 'Engagement not found' });
    if (TERMINAL_ENGAGEMENT_STATUSES.includes(existing.engagement_status)) return res.status(400).json({ error: `Cannot edit an engagement that is already ${existing.engagement_status}.` });

    const allowed = [
        'engagement_name', 'engagement_type', 'description', 'scope_summary', 'scope_inclusions', 'scope_exclusions',
        'fee_basis', 'fee_amount', 'billing_frequency', 'start_date', 'end_date', 'next_review_date', 'renewal_date',
        'risk_notes', 'notes', 'internal_notes', 'settings', 'client_accepted_at', 'client_accepted_by_name',
    ];
    const update = _pick(req.body, allowed);
    if (req.body.responsible_partner_id !== undefined) update.partner_team_member_id = req.body.responsible_partner_id;
    if (req.body.responsible_manager_id !== undefined) update.responsible_team_member_id = req.body.responsible_manager_id;
    if (update.engagement_type && !ENGAGEMENT_TYPES.includes(update.engagement_type)) return res.status(400).json({ error: 'Invalid engagement_type' });
    if (update.fee_basis && !FEE_BASES.includes(update.fee_basis)) return res.status(400).json({ error: 'Invalid fee_basis' });
    if (update.billing_frequency && !BILLING_FREQUENCIES.includes(update.billing_frequency)) return res.status(400).json({ error: 'Invalid billing_frequency' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_client_engagements').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, existing.client_id, id, null, 'engagement_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ engagement: data });
    } catch (err) {
        console.error('Engagement-management PUT :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchEngagement(cid, id);
    if (!existing) return res.status(404).json({ error: 'Engagement not found' });
    if (TERMINAL_ENGAGEMENT_STATUSES.includes(existing.engagement_status)) return res.status(400).json({ error: `Engagement is already ${existing.engagement_status}.` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel an engagement.' });

    try {
        const { data, error } = await supabase.from('practice_client_engagements')
            .update({ engagement_status: 'cancelled', status: STATUS_SYNC_MAP.cancelled, termination_reason: req.body.reason, cancelled_at: new Date().toISOString(), cancelled_by: req.user.userId, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, existing.client_id, id, null, 'engagement_cancelled', existing.engagement_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ engagement: data });
    } catch (err) {
        console.error('Engagement-management DELETE :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// LIFECYCLE ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

const ACTION_EVENT_TYPES = {
    propose: 'engagement_proposed', reject: 'engagement_cancelled', activate: 'engagement_activated',
    pause: 'engagement_paused', resume: 'engagement_resumed', 'start-review': 'engagement_review_started',
    'complete-review': 'engagement_review_completed', 'mark-renewal-due': 'engagement_renewal_due',
    renew: 'engagement_renewed', end: 'engagement_ended',
};

Object.keys(TRANSITIONS).forEach(action => {
    router.put(`/:id/${action}`, async (req, res) => {
        const cid = req.companyId;
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const eng = await _fetchEngagement(cid, id);
        if (!eng) return res.status(404).json({ error: 'Engagement not found' });

        const rule = TRANSITIONS[action];
        if (!rule.from.includes(eng.engagement_status)) {
            return res.status(422).json({ error: `Cannot ${action} from status "${eng.engagement_status}". Allowed from: ${rule.from.join(', ')}.` });
        }

        // Risk acceptance gate — only for activate/resume (the two paths that
        // bring an engagement into live work). Manager override allowed but
        // audited: an override_risk_reason accepts risk inline as part of
        // this same request.
        if (['activate', 'resume'].includes(action) && ['high', 'critical'].includes(eng.risk_level) && !eng.risk_accepted_by) {
            if (!req.body.override_risk_reason) {
                return res.status(422).json({ error: `This engagement is ${eng.risk_level} risk and has not had risk formally accepted. Call PUT /:id/accept-risk first, or provide override_risk_reason to accept and ${action} in one step.`, requires_risk_acceptance: true });
            }
            await supabase.from('practice_client_engagements').update({
                risk_accepted_by: req.user.userId, risk_accepted_at: new Date().toISOString(), risk_acceptance_reason: req.body.override_risk_reason,
            }).eq('id', id).eq('company_id', cid);
            await _writeEvent(cid, eng.client_id, id, null, 'engagement_risk_accepted', null, null, req.user.userId, req.body.override_risk_reason, { override: true, action });
        }

        // Engagement letter gate — only for activate (the point work begins).
        // Blocks unless the letter obligation is fulfilled (signed/waived/
        // not_required) — a deliberately broader reading than the spec's
        // literal "if required" trigger, closing the obvious drafted/sent-
        // but-never-signed loophole. See docs Architect Freedom.
        if (action === 'activate' && !_letterObligationFulfilled(eng)) {
            return res.status(422).json({ error: `This engagement's letter status is "${eng.engagement_letter_status}" — activation requires the letter to be signed or waived (or marked not_required).`, requires_letter_resolution: true });
        }

        try {
            const update = { engagement_status: rule.to, updated_by: req.user.userId, updated_at: new Date().toISOString() };
            if (rule.to in STATUS_SYNC_MAP) update.status = STATUS_SYNC_MAP[rule.to];
            if (action === 'complete-review') { update.reviewed_by = req.user.userId; update.reviewed_at = new Date().toISOString(); update.review_notes = req.body.notes || eng.review_notes; }
            if (action === 'end') { update.ended_at = new Date().toISOString(); update.ended_by = req.user.userId; update.termination_reason = req.body.reason || eng.termination_reason; }
            if (action === 'reject') { update.termination_reason = req.body.reason || null; }
            if (!['end', 'reject'].includes(action) && req.body.notes) update.review_notes = req.body.notes;

            if (action === 'reject' && !req.body.reason) return res.status(400).json({ error: 'reason is required to reject an engagement.' });
            if (action === 'end' && !req.body.reason) return res.status(400).json({ error: 'reason is required to end an engagement.' });

            const { data, error } = await supabase.from('practice_client_engagements').update(update).eq('id', id).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });

            await _writeEvent(cid, eng.client_id, id, null, ACTION_EVENT_TYPES[action], eng.engagement_status, rule.to, req.user.userId, req.body.notes || req.body.reason || null, {});
            res.json({ engagement: data });
        } catch (err) {
            console.error(`Engagement-management PUT /:id/${action} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

router.put('/:id/accept-risk', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const eng = await _fetchEngagement(cid, id);
    if (!eng) return res.status(404).json({ error: 'Engagement not found' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to accept risk.' });

    try {
        const { data, error } = await supabase.from('practice_client_engagements')
            .update({ risk_accepted_by: req.user.userId, risk_accepted_at: new Date().toISOString(), risk_acceptance_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, eng.client_id, id, null, 'engagement_risk_accepted', null, null, req.user.userId, req.body.reason, {});
        res.json({ engagement: data });
    } catch (err) {
        console.error('Engagement-management accept-risk error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENGAGEMENT LETTERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/letters', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    try {
        const { data, error } = await supabase.from('practice_engagement_letters').select('*').eq('company_id', cid).eq('engagement_id', id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ letters: data || [] });
    } catch (err) {
        console.error('Engagement-management GET letters error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/letters', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const eng = await _fetchEngagement(cid, id);
    if (!eng) return res.status(404).json({ error: 'Engagement not found' });
    if (!req.body.letter_title) return res.status(400).json({ error: 'letter_title is required' });

    try {
        const { data, error } = await supabase.from('practice_engagement_letters').insert({
            company_id: cid, client_id: eng.client_id, engagement_id: id,
            letter_title: req.body.letter_title, letter_reference: req.body.letter_reference || null,
            expiry_date: req.body.expiry_date || null, notes: req.body.notes || null, internal_notes: req.body.internal_notes || null,
            content_snapshot: req.body.content_snapshot || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        // A letter now exists — advance engagement_letter_status forward
        // from not_required/required to drafted, never backward from a more
        // advanced state (a manager may be drafting a NEW version while an
        // older one is still signed, which must not regress the engagement's
        // own letter status).
        if (['not_required', 'required'].includes(eng.engagement_letter_status)) {
            await supabase.from('practice_client_engagements').update({ engagement_letter_status: 'drafted', updated_at: new Date().toISOString() }).eq('id', id).eq('company_id', cid);
        }
        await _writeEvent(cid, eng.client_id, id, data.id, 'letter_created', null, 'draft', req.user.userId, req.body.letter_title, {});
        res.status(201).json({ letter: data });
    } catch (err) {
        console.error('Engagement-management POST letter error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

async function _fetchLetter(cid, letterId) {
    const { data } = await supabase.from('practice_engagement_letters').select('*').eq('id', letterId).eq('company_id', cid).maybeSingle();
    return data || null;
}

router.put('/letters/:letterId', async (req, res) => {
    const cid = req.companyId;
    const letterId = parseInt(req.params.letterId);
    if (!letterId) return res.status(400).json({ error: 'Invalid letter ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchLetter(cid, letterId);
    if (!existing) return res.status(404).json({ error: 'Letter not found' });
    if (['cancelled', 'archived'].includes(existing.letter_status)) return res.status(400).json({ error: `Cannot edit a letter that is already ${existing.letter_status}.` });

    const allowed = ['letter_title', 'letter_reference', 'expiry_date', 'notes', 'internal_notes', 'content_snapshot'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_engagement_letters').update(update).eq('id', letterId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ letter: data });
    } catch (err) {
        console.error('Engagement-management PUT letter error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

const LETTER_ACTIONS = {
    send: { to: 'sent', from: ['draft'], event: 'letter_sent', engagementStatus: 'sent', requireReason: false },
    sign: { to: 'signed', from: ['sent', 'draft'], event: 'letter_signed', engagementStatus: 'signed', requireReason: false },
    waive: { to: 'waived', from: ['draft', 'sent'], event: 'letter_waived', engagementStatus: 'waived', requireReason: true },
};

Object.keys(LETTER_ACTIONS).forEach(action => {
    const config = LETTER_ACTIONS[action];
    router.put(`/letters/:letterId/${action}`, async (req, res) => {
        const cid = req.companyId;
        const letterId = parseInt(req.params.letterId);
        if (!letterId) return res.status(400).json({ error: 'Invalid letter ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const existing = await _fetchLetter(cid, letterId);
        if (!existing) return res.status(404).json({ error: 'Letter not found' });
        if (!config.from.includes(existing.letter_status)) {
            return res.status(400).json({ error: `Cannot ${action} a letter from status "${existing.letter_status}".` });
        }
        if (config.requireReason && !req.body.reason) return res.status(400).json({ error: `reason is required to ${action} a letter.` });

        try {
            const update = { letter_status: config.to, updated_at: new Date().toISOString() };
            const now = new Date().toISOString();
            if (action === 'send') update.sent_at = now;
            if (action === 'sign') update.signed_at = now;
            if (action === 'waive') { update.waived_at = now; update.waiver_reason = req.body.reason; }

            const { data, error } = await supabase.from('practice_engagement_letters').update(update).eq('id', letterId).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });

            const engUpdate = { engagement_letter_status: config.engagementStatus, updated_at: now };
            if (action === 'send') engUpdate.engagement_letter_sent_at = now;
            if (action === 'sign') engUpdate.engagement_letter_signed_at = now;
            if (action === 'waive') engUpdate.engagement_letter_waiver_reason = req.body.reason;
            await supabase.from('practice_client_engagements').update(engUpdate).eq('id', existing.engagement_id).eq('company_id', cid);

            await _writeEvent(cid, existing.client_id, existing.engagement_id, letterId, config.event, existing.letter_status, config.to, req.user.userId, req.body.reason || null, {});
            res.json({ letter: data });
        } catch (err) {
            console.error(`Engagement-management PUT /letters/:letterId/${action} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

router.delete('/letters/:letterId', async (req, res) => {
    const cid = req.companyId;
    const letterId = parseInt(req.params.letterId);
    if (!letterId) return res.status(400).json({ error: 'Invalid letter ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchLetter(cid, letterId);
    if (!existing) return res.status(404).json({ error: 'Letter not found' });
    if (['cancelled', 'archived'].includes(existing.letter_status)) return res.status(400).json({ error: `Letter is already ${existing.letter_status}.` });

    try {
        const { data, error } = await supabase.from('practice_engagement_letters').update({ letter_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() }).eq('id', letterId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ letter: data });
    } catch (err) {
        console.error('Engagement-management DELETE letter error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid engagement ID' });
    try {
        const { data, error } = await supabase.from('practice_engagement_management_events').select('*').eq('company_id', cid).eq('engagement_id', id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Engagement-management GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules (Client Onboarding, Client Success, Management
// Dashboard, Planning Board) — see docs/new-app/71_engagement_management_letters.md
module.exports.getClientEngagementProfile = getClientEngagementProfile;
