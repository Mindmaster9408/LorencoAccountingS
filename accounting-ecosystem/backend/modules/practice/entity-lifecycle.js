'use strict';

// Codebox 68 — Practice Secretarial Entity Lifecycle Management
// "Where is this entity in its lifecycle?" and "What must happen before it
// can move to the next stage?" — within seconds.
//
// NOT CIPC API. NOT automatic deregistration/restoration. NOT liquidation/
// legal advice. NOT trust accounting. Manual entity lifecycle tracking and
// control — future CIPC/API work must plug into this engine, not replace it.
//
// current_lifecycle_status is a richer, SEPARATE model from
// practice_secretarial_profiles.company_status (Codebox 62/63) — never
// synchronised automatically. See migration 125's header.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const secretarial = require('./secretarial');
const secretarialCalendar = require('./secretarial-calendar');
const beneficialOwnership = require('./beneficial-ownership');
const secretarialEvidence = require('./secretarial-evidence');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const ENTITY_CATEGORIES = ['company', 'close_corporation', 'trust', 'non_profit', 'sole_proprietor', 'partnership', 'other'];
const LIFECYCLE_STATUSES = [
    'pre_incorporation', 'incorporated', 'active', 'trading', 'dormant', 'non_compliant',
    'deregistration_pending', 'deregistered', 'restoration_pending', 'restored',
    'liquidation_pending', 'liquidated', 'closed', 'unknown',
];
const TRADING_STATUSES = ['trading', 'not_trading', 'dormant', 'unknown'];
const COMPLIANCE_STATUSES = ['compliant', 'attention_required', 'non_compliant', 'unknown'];
const RISK_STATUSES = ['low', 'medium', 'high', 'critical', 'unknown'];

const TRANSITION_TYPES = [
    'incorporate', 'activate', 'commence_trading', 'mark_dormant', 'mark_non_compliant',
    'start_deregistration', 'confirm_deregistered', 'start_restoration', 'confirm_restored',
    'start_liquidation', 'confirm_liquidated', 'close_entity', 'reopen_entity', 'status_review', 'custom',
];
const TRANSITION_STATUSES = ['draft', 'preparing', 'awaiting_evidence', 'ready_for_review', 'approved', 'implemented', 'completed', 'rejected', 'cancelled'];
const CHECKLIST_ITEM_TYPES = [
    'evidence', 'approval', 'client_confirmation', 'statutory_check', 'tax_check', 'creditor_check',
    'cipc_step', 'governance_resolution', 'bo_check', 'document_request', 'internal_review', 'custom',
];

const TERMINAL_STATUSES = ['deregistered', 'liquidated', 'closed'];
const PRE_REVIEW_TRANSITION_STATUSES = ['draft', 'preparing', 'awaiting_evidence'];

// ── Transition Rules — the definitive, single source of truth ───────────────────
// Never guessed: an unlisted (transition_type, old_status) combination
// always blocks with 422. See docs/new-app/68_entity_lifecycle.md Architect
// Freedom for the 'activate' (incorporated OR restored) and 'close_entity'
// (any non-terminal) special cases.

const TRANSITION_RULES = {
    incorporate: { from: ['unknown', 'pre_incorporation'], to: 'incorporated' },
    activate: { from: ['incorporated', 'restored'], to: 'active' },
    commence_trading: { from: ['active'], to: 'trading' },
    mark_dormant: { from: ['active', 'trading'], to: 'dormant' },
    mark_non_compliant: { from: ['active', 'trading', 'dormant'], to: 'non_compliant' },
    start_deregistration: { from: ['active', 'trading', 'dormant', 'non_compliant'], to: 'deregistration_pending' },
    confirm_deregistered: { from: ['deregistration_pending'], to: 'deregistered' },
    start_restoration: { from: ['deregistered'], to: 'restoration_pending' },
    confirm_restored: { from: ['restoration_pending'], to: 'restored' },
    start_liquidation: { from: ['active', 'trading', 'dormant', 'non_compliant'], to: 'liquidation_pending' },
    confirm_liquidated: { from: ['liquidation_pending'], to: 'liquidated' },
    // close_entity: allowed from any status NOT already terminal — 'from' is
    // resolved dynamically in _validateTransition() rather than enumerated.
    close_entity: { from: 'non_terminal', to: 'closed' },
    reopen_entity: { from: ['closed'], to: 'active' },
    // status_review: never changes status — old_status must equal new_status.
    status_review: { from: 'any', to: 'same' },
    // custom: manager-defined old/new status, still blocked from a terminal
    // status unless it matches one of the two documented exceptions.
    custom: { from: 'any_non_terminal_unless_exception', to: 'any' },
};

function _validateTransition(transitionType, oldStatus, newStatus) {
    const rule = TRANSITION_RULES[transitionType];
    if (!rule) return { valid: false, reason: `Unknown transition_type "${transitionType}".` };

    if (rule.from === 'non_terminal') {
        if (TERMINAL_STATUSES.includes(oldStatus)) return { valid: false, reason: `Cannot close an entity already in a terminal status ("${oldStatus}").` };
    } else if (rule.from === 'any') {
        // status_review — no restriction on old_status
    } else if (rule.from === 'any_non_terminal_unless_exception') {
        const isDeregisteredException = oldStatus === 'deregistered' && newStatus === 'restoration_pending';
        const isClosedException = oldStatus === 'closed' && newStatus === 'active';
        if (TERMINAL_STATUSES.includes(oldStatus) && !isDeregisteredException && !isClosedException) {
            return { valid: false, reason: `Cannot transition out of terminal status "${oldStatus}" except deregistered→restoration_pending or closed→active.` };
        }
    } else if (!rule.from.includes(oldStatus)) {
        return { valid: false, reason: `Transition "${transitionType}" is not allowed from status "${oldStatus}". Allowed from: ${rule.from.join(', ')}.` };
    }

    if (rule.to === 'same') {
        if (newStatus !== oldStatus) return { valid: false, reason: 'status_review must not change the lifecycle status.' };
    } else if (rule.to !== 'any' && newStatus !== rule.to) {
        return { valid: false, reason: `Transition "${transitionType}" must result in status "${rule.to}", not "${newStatus}".` };
    }

    return { valid: true };
}

// ── Checklist Defaults ───────────────────────────────────────────────────────────
// Five sets exactly as specified. The rest are a deliberate, sensible-minimal
// extension under "Architect Freedom" (spec: "custom: no defaults unless
// developer adds minimal internal review item").

function _item(name, type) { return { item_name: name, item_type: type }; }

const CHECKLIST_DEFAULTS = {
    mark_dormant: [
        _item('Client confirmation', 'client_confirmation'),
        _item('Tax status reviewed', 'tax_check'),
        _item('Annual returns reviewed', 'statutory_check'),
        _item('BO reviewed', 'bo_check'),
        _item('Partner approval', 'approval'),
    ],
    start_deregistration: [
        _item('Client instruction', 'client_confirmation'),
        _item('Tax clearance/status review', 'tax_check'),
        _item('Annual return status review', 'statutory_check'),
        _item('Creditor/obligation review', 'creditor_check'),
        _item('Governance resolution', 'governance_resolution'),
        _item('BO readiness reviewed', 'bo_check'),
        _item('CIPC step', 'cipc_step'),
    ],
    start_restoration: [
        _item('Client instruction', 'client_confirmation'),
        _item('Reason for restoration', 'internal_review'),
        _item('Outstanding annual returns reviewed', 'statutory_check'),
        _item('CIPC restoration step', 'cipc_step'),
        _item('Governance approval', 'governance_resolution'),
    ],
    start_liquidation: [
        _item('Client instruction', 'client_confirmation'),
        _item('Creditor review', 'creditor_check'),
        _item('Tax exposure review', 'tax_check'),
        _item('Governance resolution', 'governance_resolution'),
        _item('Legal/professional advice note', 'internal_review'),
        _item('Partner approval', 'approval'),
    ],
    commence_trading: [
        _item('Trading date confirmed', 'client_confirmation'),
        _item('Tax registrations reviewed', 'tax_check'),
        _item('Accounting engagement confirmed', 'internal_review'),
        _item('Compliance obligations reviewed', 'statutory_check'),
    ],
    custom: [],
};
// Generic sensible-minimal set for transition types the spec didn't
// enumerate explicit checklists for (Architect Freedom — see migration 125
// header and docs). 'custom' gets none, as specified.
const GENERIC_DEFAULTS = [_item('Internal review', 'internal_review'), _item('Partner approval', 'approval')];
['incorporate', 'activate', 'mark_non_compliant', 'confirm_deregistered', 'confirm_restored', 'confirm_liquidated', 'close_entity', 'reopen_entity', 'status_review']
    .forEach(t => { CHECKLIST_DEFAULTS[t] = GENERIC_DEFAULTS; });

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role')
        .eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!_isManager(member)) {
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage entity lifecycle records.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_entity_lifecycle_events').insert({
        company_id: cid, client_id: clientId || null, source_type: sourceType, source_id: sourceId,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _getOrInitProfile(cid, clientId, actorUserId) {
    const { data: existing } = await supabase.from('practice_entity_lifecycle_profiles').select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase.from('practice_entity_lifecycle_profiles')
        .insert({ company_id: cid, client_id: clientId, created_by: actorUserId }).select().single();
    if (error) throw new Error(error.message);
    await _writeEvent(cid, clientId, 'lifecycle_profile', created.id, 'lifecycle_profile_created', null, created.current_lifecycle_status, actorUserId, null, {});
    return created;
}

// ── Lifecycle Engine — getEntityLifecycleProfile() ──────────────────────────────
// Pure aggregation. Every cross-module read is independently wrapped so a
// failure in one sub-summary never breaks the whole profile — "Do not block
// if helper unavailable" per the spec's Secretarial Evidence integration note,
// applied consistently to every sub-summary here, not just evidence.

async function getEntityLifecycleProfile(cid, clientId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    const profile = await _getOrInitProfile(cid, clientId, null);

    const [transitionsRes, checklistRes] = await Promise.all([
        supabase.from('practice_entity_lifecycle_transitions').select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false }),
        supabase.from('practice_entity_lifecycle_checklist_items').select('*').eq('company_id', cid),
    ]);
    const allTransitions = transitionsRes.data || [];
    const activeTransitions = allTransitions.filter(t => !['completed', 'rejected', 'cancelled'].includes(t.transition_status));
    const completedTransitions = allTransitions.filter(t => t.transition_status === 'completed');
    const latestCompletedTransition = completedTransitions[0] || null;

    const activeTransitionIds = new Set(activeTransitions.map(t => t.id));
    const outstandingChecklistItems = (checklistRes.data || []).filter(i => activeTransitionIds.has(i.transition_id) && i.required && !i.completed);

    const statutoryCalendarSummary = await _safe(async () => {
        const cal = await secretarialCalendar.buildStatutoryCalendar(cid, clientId);
        return cal.counts;
    }, null);

    const secretarialProfileSummary = await _safe(async () => {
        const corp = await secretarial.getCorporateProfile(cid, clientId);
        return corp ? { company_status: corp.profile?.company_status || null, cipc_status: corp.profile?.cipc_status || null } : null;
    }, null);

    const boReadinessSummary = await _safe(async () => {
        const bo = await beneficialOwnership.getBeneficialOwnershipProfile(cid, clientId);
        return bo ? bo.readiness : null;
    }, null);

    // Secretarial Evidence — "if evidence helper exists, use it... do not
    // block if helper unavailable." The require already succeeded at module
    // load, so this wraps the actual computation instead (no evidence
    // checklists exist for this client is the common, non-error case).
    const evidenceReadinessSummary = await _safe(async () => {
        const { data: checklists } = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('company_id', cid).eq('client_id', clientId);
        if (!checklists || !checklists.length) return null;
        const readiness = await Promise.all(checklists.map(c => secretarialEvidence.getChecklistReadiness(cid, c)));
        const blocked = readiness.filter(r => r.status === 'blocked').length;
        const ready = readiness.filter(r => r.status === 'ready').length;
        return { checklists_total: checklists.length, ready, blocked };
    }, null);

    const riskFlags = _computeRiskFlags(profile, statutoryCalendarSummary, boReadinessSummary, evidenceReadinessSummary, outstandingChecklistItems);
    const recommendedActions = _computeRecommendedActions(profile, activeTransitions, riskFlags);

    return {
        client,
        profile,
        current_status: profile.current_lifecycle_status,
        active_transitions: activeTransitions,
        latest_completed_transition: latestCompletedTransition,
        outstanding_checklist_items: outstandingChecklistItems,
        statutory_calendar_summary: statutoryCalendarSummary,
        secretarial_profile_summary: secretarialProfileSummary,
        bo_readiness_summary: boReadinessSummary,
        evidence_readiness_summary: evidenceReadinessSummary,
        risk_flags: riskFlags,
        recommended_next_actions: recommendedActions,
    };
}

async function _safe(fn, fallback) {
    try { return await fn(); } catch (e) { return fallback; }
}

// Deterministic, explainable — no AI, no scoring model beyond plain flags.
function _computeRiskFlags(profile, statutoryCalendar, boReadiness, evidenceReadiness, outstandingItems) {
    const flags = [];
    if (statutoryCalendar && (statutoryCalendar.overdue > 0)) flags.push(`${statutoryCalendar.overdue} overdue statutory item(s)`);
    if (statutoryCalendar && (statutoryCalendar.blocked > 0)) flags.push(`${statutoryCalendar.blocked} blocked statutory item(s)`);
    if (boReadiness && ['blocked', 'incomplete'].includes(boReadiness.status)) flags.push(`Beneficial Ownership readiness is ${boReadiness.status}`);
    if (evidenceReadiness && evidenceReadiness.blocked > 0) flags.push(`${evidenceReadiness.blocked} blocked evidence checklist(s)`);
    if (outstandingItems.length > 0) flags.push(`${outstandingItems.length} outstanding lifecycle checklist item(s)`);
    if (profile.compliance_status === 'non_compliant') flags.push('Compliance status is non-compliant');
    if (profile.risk_status === 'critical' || profile.risk_status === 'high') flags.push(`Risk status is ${profile.risk_status}`);
    return flags;
}

// Plain if/else lookup keyed off current status — never a guess, never AI.
const NEXT_ACTION_SUGGESTIONS = {
    pre_incorporation: 'Incorporate the entity once registration is confirmed.',
    incorporated: 'Activate the entity once initial statutory setup is complete.',
    active: 'Consider commence_trading once the entity begins operating, or mark_dormant if it will not trade.',
    trading: 'Review periodically — mark_dormant if trading stops, or start_deregistration/start_liquidation if closing.',
    dormant: 'Review periodically — reactivate is not a listed transition; consider commence_trading via a new active period if trading resumes, or start_deregistration if permanently closing.',
    non_compliant: 'Resolve outstanding compliance issues, or start_deregistration if the entity cannot be brought back into compliance.',
    deregistration_pending: 'Complete outstanding checklist items and confirm_deregistered once CIPC confirms deregistration.',
    deregistered: 'start_restoration if the client wishes to restore the entity; otherwise no further action.',
    restoration_pending: 'Complete outstanding checklist items and confirm_restored once CIPC confirms restoration.',
    restored: 'Activate the entity to resume normal status.',
    liquidation_pending: 'Complete outstanding checklist items and confirm_liquidated once the liquidation process concludes.',
    liquidated: 'No further lifecycle action — liquidated is terminal.',
    closed: 'reopen_entity if the client wishes to resume using this entity.',
    unknown: 'Review the entity and record its actual lifecycle status via incorporate/activate/status_review as appropriate.',
};
function _computeRecommendedActions(profile, activeTransitions, riskFlags) {
    const actions = [];
    if (activeTransitions.length) {
        actions.push(`${activeTransitions.length} transition(s) already in progress — resolve those before starting a new one.`);
    } else if (NEXT_ACTION_SUGGESTIONS[profile.current_lifecycle_status]) {
        actions.push(NEXT_ACTION_SUGGESTIONS[profile.current_lifecycle_status]);
    }
    if (riskFlags.length) actions.push('Address the flagged risks above before progressing the lifecycle further.');
    return actions;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [profilesRes, transitionsRes] = await Promise.all([
            supabase.from('practice_entity_lifecycle_profiles').select('current_lifecycle_status, risk_status').eq('company_id', cid),
            supabase.from('practice_entity_lifecycle_transitions').select('transition_status').eq('company_id', cid),
        ]);

        const statusCounts = {}; LIFECYCLE_STATUSES.forEach(s => { statusCounts[s] = 0; });
        let highRiskCount = 0;
        (profilesRes.data || []).forEach(p => { if (p.current_lifecycle_status in statusCounts) statusCounts[p.current_lifecycle_status]++; if (['high', 'critical'].includes(p.risk_status)) highRiskCount++; });

        const transitionCounts = {}; TRANSITION_STATUSES.forEach(s => { transitionCounts[s] = 0; });
        (transitionsRes.data || []).forEach(t => { if (t.transition_status in transitionCounts) transitionCounts[t.transition_status]++; });

        res.json({
            profiles_total: (profilesRes.data || []).length,
            by_lifecycle_status: statusCounts,
            high_risk_entities: highRiskCount,
            transitions_by_status: transitionCounts,
            active_transitions: (transitionsRes.data || []).filter(t => !['completed', 'rejected', 'cancelled'].includes(t.transition_status)).length,
        });
    } catch (err) {
        console.error('Entity-lifecycle /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT LIFECYCLE PROFILE
// ═══════════════════════════════════════════════════════════════════════════

router.get('/client/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    try {
        const result = await getEntityLifecycleProfile(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Entity-lifecycle GET /client/:clientId error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/client/:clientId/profile', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { entity_category } = req.body;
    if (entity_category && !ENTITY_CATEGORIES.includes(entity_category)) return res.status(400).json({ error: 'Invalid entity_category' });

    try {
        const profile = await _getOrInitProfile(cid, clientId, req.user.userId);
        if (entity_category && entity_category !== profile.entity_category) {
            const { data, error } = await supabase.from('practice_entity_lifecycle_profiles').update({ entity_category, updated_by: req.user.userId, updated_at: new Date().toISOString() }).eq('id', profile.id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json({ profile: data });
        }
        res.status(201).json({ profile });
    } catch (err) {
        console.error('Entity-lifecycle POST profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/client/:clientId/profile', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const allowed = [
        'entity_category', 'lifecycle_status_reason', 'next_review_date',
        'trading_status', 'compliance_status', 'risk_status', 'notes', 'internal_notes', 'settings',
    ];
    const update = _pick(req.body, allowed);
    if (update.entity_category && !ENTITY_CATEGORIES.includes(update.entity_category)) return res.status(400).json({ error: 'Invalid entity_category' });
    if (update.trading_status && !TRADING_STATUSES.includes(update.trading_status)) return res.status(400).json({ error: 'Invalid trading_status' });
    if (update.compliance_status && !COMPLIANCE_STATUSES.includes(update.compliance_status)) return res.status(400).json({ error: 'Invalid compliance_status' });
    if (update.risk_status && !RISK_STATUSES.includes(update.risk_status)) return res.status(400).json({ error: 'Invalid risk_status' });

    try {
        const profile = await _getOrInitProfile(cid, clientId, req.user.userId);
        const isReview = req.body.mark_reviewed === true;
        if (isReview) { update.last_reviewed_at = new Date().toISOString(); update.last_reviewed_by = req.user.userId; }
        update.updated_by = req.user.userId;
        update.updated_at = new Date().toISOString();

        const { data, error } = await supabase.from('practice_entity_lifecycle_profiles').update(update).eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'lifecycle_profile', profile.id, isReview ? 'lifecycle_reviewed' : 'lifecycle_profile_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ profile: data });
    } catch (err) {
        console.error('Entity-lifecycle PUT profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/transitions', async (req, res) => {
    const cid = req.companyId;
    const { client_id, transition_type, transition_status } = req.query;
    try {
        let q = supabase.from('practice_entity_lifecycle_transitions').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (transition_type) q = q.eq('transition_type', transition_type);
        if (transition_status) q = q.eq('transition_status', transition_status);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(t => t.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ transitions: (data || []).map(t => ({ ...t, client_name: nameById[t.client_id] || null })) });
    } catch (err) {
        console.error('Entity-lifecycle GET transitions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/transitions', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, transition_type, new_status, requested_by_name, requested_date, effective_date, transition_summary, reason, payload } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!TRANSITION_TYPES.includes(transition_type)) return res.status(400).json({ error: 'Invalid transition_type' });

    try {
        const profile = await _getOrInitProfile(cid, clientId, req.user.userId);
        const oldStatus = profile.current_lifecycle_status;
        const rule = TRANSITION_RULES[transition_type];
        const resolvedNewStatus = new_status || (rule.to !== 'any' && rule.to !== 'same' ? rule.to : oldStatus);

        const validation = _validateTransition(transition_type, oldStatus, resolvedNewStatus);
        if (!validation.valid) return res.status(422).json({ error: validation.reason });

        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions').insert({
            company_id: cid, client_id: clientId, lifecycle_profile_id: profile.id, transition_type,
            old_status: oldStatus, new_status: resolvedNewStatus,
            requested_by_name: requested_by_name || null, requested_date: requested_date || null, effective_date: effective_date || null,
            transition_summary: transition_summary || null, reason: reason || null, payload: payload || {},
            created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'lifecycle_transition', data.id, 'transition_created', null, data.transition_status, req.user.userId, transition_summary || null, { transition_type, old_status: oldStatus, new_status: resolvedNewStatus });
        res.status(201).json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle POST transitions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/transitions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });
    try {
        const [transitionRes, checklistRes] = await Promise.all([
            supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle(),
            supabase.from('practice_entity_lifecycle_checklist_items').select('*').eq('company_id', cid).eq('transition_id', id).order('sort_order'),
        ]);
        if (transitionRes.error) return res.status(500).json({ error: transitionRes.error.message });
        if (!transitionRes.data) return res.status(404).json({ error: 'Transition not found' });
        res.json({ transition: transitionRes.data, checklist: checklistRes.data || [] });
    } catch (err) {
        console.error('Entity-lifecycle GET transition error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Transition not found' });
    if (!PRE_REVIEW_TRANSITION_STATUSES.includes(existing.data.transition_status)) return res.status(400).json({ error: `Cannot edit a transition that is already ${existing.data.transition_status}.` });

    const allowed = ['requested_by_name', 'requested_date', 'effective_date', 'transition_summary', 'reason', 'risk_notes', 'evidence_notes', 'payload', 'settings', 'transition_status'];
    const update = _pick(req.body, allowed);
    if (update.transition_status && !PRE_REVIEW_TRANSITION_STATUSES.includes(update.transition_status)) {
        return res.status(400).json({ error: 'PUT /:id may only set draft/preparing/awaiting_evidence. Use the dedicated action endpoints for other transitions.' });
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'lifecycle_transition', id, 'transition_updated', existing.data.transition_status, data.transition_status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle PUT transition error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/transitions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Transition not found' });
    if (['completed', 'cancelled'].includes(existing.data.transition_status)) return res.status(400).json({ error: `Cannot cancel a transition that is already ${existing.data.transition_status}.` });

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({ transition_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'lifecycle_transition', id, 'transition_cancelled', existing.data.transition_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle DELETE transition error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════

router.post('/transitions/:id/generate-checklist', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });

    try {
        const { count } = await supabase.from('practice_entity_lifecycle_checklist_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('transition_id', id);
        if (count > 0 && req.query.force !== 'true') {
            return res.status(400).json({ error: 'Checklist already generated for this transition. Pass ?force=true to clear and regenerate.' });
        }
        if (count > 0 && req.query.force === 'true') {
            await supabase.from('practice_entity_lifecycle_checklist_items').delete().eq('company_id', cid).eq('transition_id', id);
        }

        const defaults = CHECKLIST_DEFAULTS[transition.transition_type] || [];
        if (!defaults.length) {
            return res.json({ checklist: [], message: `No default checklist for transition_type "${transition.transition_type}" — add items manually.` });
        }

        const rows = defaults.map((d, i) => ({ company_id: cid, transition_id: id, item_name: d.item_name, item_type: d.item_type, required: true, sort_order: i }));
        const { data, error } = await supabase.from('practice_entity_lifecycle_checklist_items').insert(rows).select();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'checklist_generated', transition.transition_status, transition.transition_status, req.user.userId, null, { count: data.length });
        res.status(201).json({ checklist: data });
    } catch (err) {
        console.error('Entity-lifecycle generate-checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/transitions/:id/checklist', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });
    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_checklist_items').select('*').eq('company_id', cid).eq('transition_id', id).order('sort_order');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ checklist: data || [] });
    } catch (err) {
        console.error('Entity-lifecycle GET checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id/checklist/:itemId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    if (!id || !itemId) return res.status(400).json({ error: 'Invalid transition or item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });

    const existing = await supabase.from('practice_entity_lifecycle_checklist_items').select('*').eq('id', itemId).eq('transition_id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Checklist item not found' });

    const allowed = ['item_name', 'item_type', 'required', 'completed', 'linked_document_request_id', 'notes', 'sort_order'];
    const update = _pick(req.body, allowed);
    if (update.item_type && !CHECKLIST_ITEM_TYPES.includes(update.item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (update.completed === true && !existing.data.completed) { update.completed_at = new Date().toISOString(); update.completed_by = req.user.userId; }
    if (update.completed === false) { update.completed_at = null; update.completed_by = null; }
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_checklist_items').update(update).eq('id', itemId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'checklist_item', itemId, 'checklist_item_updated', null, null, req.user.userId, existing.data.item_name, { completed: data.completed });
        res.json({ item: data });
    } catch (err) {
        console.error('Entity-lifecycle PUT checklist item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

router.put('/transitions/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });
    if (!PRE_REVIEW_TRANSITION_STATUSES.includes(transition.transition_status)) return res.status(400).json({ error: `Cannot submit for review from status "${transition.transition_status}".` });

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({ transition_status: 'ready_for_review', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'transition_submitted_review', transition.transition_status, 'ready_for_review', req.user.userId, null, {});
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle submit-review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });
    if (transition.transition_status !== 'ready_for_review') return res.status(400).json({ error: `Cannot approve from status "${transition.transition_status}" — transition must be ready_for_review.` });

    const { override_reason } = req.body;

    try {
        const { data: checklist } = await supabase.from('practice_entity_lifecycle_checklist_items').select('required, completed').eq('company_id', cid).eq('transition_id', id);
        const incomplete = (checklist || []).filter(i => i.required && !i.completed);
        if (incomplete.length && !override_reason) {
            return res.status(400).json({ error: `${incomplete.length} required checklist item(s) incomplete. Provide override_reason to approve anyway.`, incomplete_count: incomplete.length });
        }

        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({ transition_status: 'approved', approved_by: req.user.userId, approved_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'transition_approved', transition.transition_status, 'approved', req.user.userId, override_reason || null, { checklist_override: !!(incomplete.length && override_reason) });
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle approve error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id/reject', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });
    if (['completed', 'implemented', 'rejected', 'cancelled'].includes(transition.transition_status)) return res.status(400).json({ error: `Cannot reject a transition that is already ${transition.transition_status}.` });

    const { rejection_reason } = req.body;
    if (!rejection_reason) return res.status(400).json({ error: 'rejection_reason is required' });

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({ transition_status: 'rejected', rejection_reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'transition_rejected', transition.transition_status, 'rejected', req.user.userId, rejection_reason, {});
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle reject error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id/implement', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });
    if (transition.transition_status !== 'approved') return res.status(400).json({ error: `Cannot implement from status "${transition.transition_status}" — transition must be approved.` });

    const effectiveDate = req.body.effective_date || transition.effective_date;
    if (!effectiveDate) return res.status(400).json({ error: 'effective_date is required (on the transition or in this request) before implementation.' });

    try {
        const { data: profile } = await supabase.from('practice_entity_lifecycle_profiles').select('*').eq('id', transition.lifecycle_profile_id).eq('company_id', cid).maybeSingle();
        if (!profile) return res.status(404).json({ error: 'Lifecycle profile not found' });

        // Re-validate against the CURRENT profile status — it may have moved
        // since this transition was created (e.g. another transition
        // implemented in the meantime). Never guess; block with 422 instead.
        const validation = _validateTransition(transition.transition_type, profile.current_lifecycle_status, transition.new_status);
        if (!validation.valid) return res.status(422).json({ error: `Lifecycle status has changed since this transition was created: ${validation.reason}` });

        const beforeSnapshot = { ...profile };
        const now = new Date().toISOString();

        const { data: updatedProfile, error: profileError } = await supabase.from('practice_entity_lifecycle_profiles')
            .update({ current_lifecycle_status: transition.new_status, status_effective_date: effectiveDate, updated_by: req.user.userId, updated_at: now })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (profileError) return res.status(500).json({ error: profileError.message });

        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({
                transition_status: 'implemented', implemented_by: req.user.userId, implemented_at: now, effective_date: effectiveDate,
                before_snapshot: beforeSnapshot, after_snapshot: updatedProfile, updated_by: req.user.userId, updated_at: now,
            })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'transition_implemented', transition.transition_status, 'implemented', req.user.userId, null, { old_status: profile.current_lifecycle_status, new_status: transition.new_status });
        await _writeEvent(cid, transition.client_id, 'lifecycle_profile', profile.id, 'lifecycle_status_changed', profile.current_lifecycle_status, transition.new_status, req.user.userId, transition.transition_summary || null, { transition_id: id });

        res.json({ transition: data, profile: updatedProfile });
    } catch (err) {
        console.error('Entity-lifecycle implement error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/transitions/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid transition ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: transition } = await supabase.from('practice_entity_lifecycle_transitions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!transition) return res.status(404).json({ error: 'Transition not found' });
    if (transition.transition_status !== 'implemented') return res.status(400).json({ error: `Cannot complete from status "${transition.transition_status}" — transition must be implemented.` });
    if (!transition.after_snapshot) return res.status(400).json({ error: 'This transition has no after_snapshot — it cannot be marked complete.' });

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_transitions')
            .update({ transition_status: 'completed', completed_by: req.user.userId, completed_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, transition.client_id, 'lifecycle_transition', id, 'transition_completed', transition.transition_status, 'completed', req.user.userId, null, {});
        res.json({ transition: data });
    } catch (err) {
        console.error('Entity-lifecycle complete error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { client_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_entity_lifecycle_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Entity-lifecycle GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const sourceType = req.params.sourceType;
    const sourceId = parseInt(req.params.sourceId);
    if (!['lifecycle_profile', 'lifecycle_transition', 'checklist_item'].includes(sourceType)) return res.status(400).json({ error: 'Invalid sourceType' });
    if (!sourceId) return res.status(400).json({ error: 'Invalid sourceId' });

    try {
        const { data, error } = await supabase.from('practice_entity_lifecycle_events').select('*')
            .eq('company_id', cid).eq('source_type', sourceType).eq('source_id', sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Entity-lifecycle GET source events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/68_entity_lifecycle.md
module.exports.getEntityLifecycleProfile = getEntityLifecycleProfile;

// Codebox 69 — secretarial-integrity.js reuses this exact terminal-status
// list for its lifecycle consistency checks instead of redeclaring it.
// Purely additive export — zero change to any existing route's behavior.
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
