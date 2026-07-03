'use strict';

// Codebox 61 — Practice Client Success & Relationship Management
// Answers "which client needs me today?" — relationship health, planned
// success activities, strategic opportunities, key contacts, communication
// cadence, and meeting history.
//
// NOT a CRM. NOT a sales pipeline. NOT marketing/email marketing. NOT lead
// management. NOT client master data (practice_clients stays authoritative
// for name/type/onboarding — this module only adds a relationship layer on
// top of it). Fully manager-controlled, deterministic, explainable.
//
// Client Health here is RELATIONSHIP health, not operational health.
// practice_clients.health_score/health_status (client-health.js, Codebox
// pre-61) already scores overdue deadlines/tasks/periods/WIP — this module
// does not recompute that. calculateClientHealth() below composes the
// existing operational score with communication cadence instead of
// duplicating deadline/task/WIP logic. See migration 118's header comment
// and docs/new-app/61_client_success.md Architect Freedom #1-#2.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const clientHealth = require('./client-health');
const { notify } = require('./notifications');
const secretarial = require('./secretarial');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const RELATIONSHIP_STATUSES = ['healthy', 'watch', 'at_risk', 'critical', 'unknown'];
const TREND_VALUES = ['improving', 'stable', 'declining', 'unknown'];

const ACTIVITY_TYPES = [
    'quarterly_review', 'annual_planning', 'tax_planning', 'business_review',
    'health_check', 'follow_up', 'training', 'onboarding', 'other',
];
const ACTIVITY_STATUSES = ['planned', 'completed', 'cancelled'];

const OPPORTUNITY_TYPES = [
    'accounting', 'payroll', 'pos', 'inventory', 'sean_ai',
    'secretarial', 'advisory', 'training', 'other',
];
const OPPORTUNITY_STATUSES = ['identified', 'discussed', 'proposal', 'won', 'lost', 'deferred'];

// Relationship severity rank — lower is worse. Used to combine the
// operational health component with the communication-cadence component
// into a single relationship_status via "worse of the two wins".
const STATUS_RANK = { critical: 0, at_risk: 1, watch: 2, healthy: 3 };
const OPERATIONAL_TO_RELATIONSHIP = { critical: 'critical', at_risk: 'at_risk', watch: 'watch', good: 'healthy' };
const CADENCE_TO_RELATIONSHIP = { overdue: 'at_risk', due_soon: 'watch', on_track: 'healthy' };
const CADENCE_SCORE = { overdue: 30, due_soon: 70, on_track: 100 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can edit Client Success records.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients')
        .select('id, name, client_type, responsible_team_member_id')
        .eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, eventType, entityType, entityId, clientId, actorUserId, notes, meta) {
    await supabase.from('practice_client_success_events').insert({
        company_id: cid, event_type: eventType, entity_type: entityType || null, entity_id: entityId || null,
        client_id: clientId || null, actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// Communication cadence — pure date arithmetic, no hidden logic. If a
// next_planned_contact_date exists, it is authoritative. Otherwise falls
// back to how long it's been since the last meaningful contact.
function _cadenceStatus(row) {
    const t = today();
    if (row.next_planned_contact_date) {
        const days = daysBetween(t, row.next_planned_contact_date);
        if (days < 0) return 'overdue';
        if (days <= 7) return 'due_soon';
        return 'on_track';
    }
    if (row.last_meaningful_contact_date) {
        const daysSince = daysBetween(row.last_meaningful_contact_date, t);
        if (daysSince > 90) return 'overdue';
        if (daysSince > 60) return 'due_soon';
        return 'on_track';
    }
    return 'unknown';
}

function _reviewStatus(nextReviewDate) {
    if (!nextReviewDate) return 'none';
    const days = daysBetween(today(), nextReviewDate);
    if (days < 0) return 'overdue';
    if (days <= 14) return 'due_soon';
    return 'on_track';
}

// ─── Core engine — calculateClientHealth() ─────────────────────────────────────
// Composes the pre-existing operational health score (client-health.js —
// overdue deadlines/tasks/periods/engagements/WIP) with communication
// cadence into a single deterministic relationship_status/score. A manager
// override always wins outright and this function never touches an
// overridden row. See migration 118 header + docs Architect Freedom #1-#2.

async function calculateClientHealth(cid, clientId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    let successRow = await _getOrInitSuccessRow(cid, clientId);

    if (successRow.is_manager_override) {
        return {
            client_id: clientId,
            relationship_status: successRow.relationship_status,
            relationship_score: successRow.relationship_score,
            source: 'manager_override',
            override_reason: successRow.override_reason,
            operational_component: null,
            cadence_component: _cadenceStatus(successRow),
        };
    }

    // Reuse client-health.js — never recompute overdue-deadline/task/WIP logic here.
    const healthData = await clientHealth.fetchHealthData(cid, clientId);
    const operational = healthData.clients.length
        ? clientHealth.scoreClientFromData(healthData.clients[0], healthData)
        : { health_score: null, health_status: 'unknown', risk_factors: [], metrics: {} };

    const cadence = _cadenceStatus(successRow);
    const operationalRelStatus = OPERATIONAL_TO_RELATIONSHIP[operational.health_status] || null;
    const cadenceRelStatus = CADENCE_TO_RELATIONSHIP[cadence] || null;

    let relationshipStatus;
    if (operationalRelStatus && cadenceRelStatus) {
        relationshipStatus = STATUS_RANK[operationalRelStatus] <= STATUS_RANK[cadenceRelStatus]
            ? operationalRelStatus : cadenceRelStatus;
    } else {
        relationshipStatus = operationalRelStatus || cadenceRelStatus || 'unknown';
    }

    const scoreParts = [];
    if (operational.health_score != null) scoreParts.push(operational.health_score);
    if (CADENCE_SCORE[cadence] != null) scoreParts.push(CADENCE_SCORE[cadence]);
    const relationshipScore = scoreParts.length
        ? Math.round((scoreParts.reduce((s, v) => s + v, 0) / scoreParts.length) * 10) / 10
        : null;

    await supabase.from('practice_client_success').update({
        relationship_status: relationshipStatus,
        relationship_score: relationshipScore,
        relationship_last_calculated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }).eq('id', successRow.id).eq('company_id', cid);

    return {
        client_id: clientId,
        relationship_status: relationshipStatus,
        relationship_score: relationshipScore,
        source: 'calculated',
        operational_component: { status: operational.health_status, score: operational.health_score, top_risks: operational.top_risks || [] },
        cadence_component: cadence,
    };
}

// Ensures a practice_client_success row exists (created lazily on first
// touch — a client with no relationship activity yet still needs a row to
// hang health/cadence state on). Never created implicitly with data beyond
// defaults; a manager fills in the rest via PUT /:clientId.
async function _getOrInitSuccessRow(cid, clientId) {
    const { data: existing } = await supabase.from('practice_client_success')
        .select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase.from('practice_client_success')
        .insert({ company_id: cid, client_id: clientId }).select().single();
    if (error) throw new Error(error.message);
    return created;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [success, opportunities] = await Promise.all([
            supabase.from('practice_client_success').select('relationship_status, next_review_date, next_planned_contact_date, last_meaningful_contact_date').eq('company_id', cid),
            supabase.from('practice_client_opportunities').select('status, estimated_value').eq('company_id', cid),
        ]);
        if (success.error) return res.status(500).json({ error: success.error.message });

        const counts = { total: 0, healthy: 0, watch: 0, at_risk: 0, critical: 0, unknown: 0, reviews_overdue: 0, reviews_due_soon: 0, cadence_overdue: 0 };
        for (const r of (success.data || [])) {
            counts.total++;
            counts[r.relationship_status || 'unknown']++;
            const rs = _reviewStatus(r.next_review_date);
            if (rs === 'overdue') counts.reviews_overdue++;
            if (rs === 'due_soon') counts.reviews_due_soon++;
            if (_cadenceStatus(r) === 'overdue') counts.cadence_overdue++;
        }

        const oppCounts = { identified: 0, discussed: 0, proposal: 0, won: 0, lost: 0, deferred: 0, open_estimated_value: 0 };
        for (const o of (opportunities.data || [])) {
            if (o.status in oppCounts) oppCounts[o.status]++;
            if (!['won', 'lost', 'deferred'].includes(o.status)) oppCounts.open_estimated_value += parseFloat(o.estimated_value || 0);
        }

        res.json({ clients: counts, opportunities: oppCounts });
    } catch (err) {
        console.error('Client-success /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT SUCCESS — list + detail + edit + override + recalculate
// ═══════════════════════════════════════════════════════════════════════════

// GET / — list, one row per active client, left-joined with its success state.
// ?assigned_to_me=true scopes to clients where the caller is the responsible
// team member (practice_clients) or the relationship owner (client-success).
router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { status, assigned_to_me } = req.query;
    try {
        let clientQ = supabase.from('practice_clients')
            .select('id, name, client_type, responsible_team_member_id')
            .eq('company_id', cid).eq('is_active', true).order('name');

        const [clients, success, members] = await Promise.all([
            clientQ,
            supabase.from('practice_client_success').select('*').eq('company_id', cid),
            supabase.from('practice_team_members').select('id, display_name').eq('company_id', cid).eq('is_active', true),
        ]);
        if (clients.error) return res.status(500).json({ error: clients.error.message });

        const memberById = {};
        for (const m of (members.data || [])) memberById[m.id] = m.display_name;
        const successByClient = {};
        for (const s of (success.data || [])) successByClient[s.client_id] = s;

        let me = null;
        if (assigned_to_me === 'true') me = await _myTeamMember(cid, req.user?.userId);

        let result = (clients.data || []).map(c => {
            const s = successByClient[c.id] || null;
            const ownerId = s?.relationship_owner_team_member_id || c.responsible_team_member_id || null;
            return {
                client_id: c.id,
                client_name: c.name,
                client_type: c.client_type,
                relationship_owner_team_member_id: ownerId,
                relationship_owner: ownerId ? (memberById[ownerId] || null) : null,
                relationship_status: s?.relationship_status || 'unknown',
                relationship_score: s?.relationship_score ?? null,
                trend: s?.trend || 'unknown',
                last_meaningful_contact_date: s?.last_meaningful_contact_date || null,
                next_planned_contact_date: s?.next_planned_contact_date || null,
                cadence_status: s ? _cadenceStatus(s) : 'unknown',
                next_review_date: s?.next_review_date || null,
                review_status: _reviewStatus(s?.next_review_date),
                is_manager_override: s?.is_manager_override || false,
            };
        });

        if (status) result = result.filter(r => r.relationship_status === status);
        if (me) result = result.filter(r => r.relationship_owner_team_member_id === me.id);

        res.json({ clients: result, total: result.length });
    } catch (err) {
        console.error('Client-success GET / error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /:clientId — full detail: success row, activities, meetings, opportunities.
router.get('/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const [success, activities, meetings, opportunities, governance] = await Promise.all([
            supabase.from('practice_client_success').select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle(),
            supabase.from('practice_client_success_activities').select('*').eq('company_id', cid).eq('client_id', clientId).order('scheduled_date', { ascending: false, nullsFirst: false }),
            supabase.from('practice_client_meetings').select('*').eq('company_id', cid).eq('client_id', clientId).order('meeting_date', { ascending: false }),
            supabase.from('practice_client_opportunities').select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false }),
            // Codebox 62 — governance summary, reused from secretarial.js
            // (no duplicate annual-return/director logic here). A failure here
            // must never break the rest of the Client Success detail view.
            secretarial.getGovernanceSummary(cid, clientId).catch(() => null),
        ]);

        const s = success.data || null;
        res.json({
            client,
            success: s,
            cadence_status: s ? _cadenceStatus(s) : 'unknown',
            review_status: _reviewStatus(s?.next_review_date),
            activities: activities.data || [],
            meetings: meetings.data || [],
            opportunities: opportunities.data || [],
            governance: governance,
        });
    } catch (err) {
        console.error('Client-success GET /:clientId error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /:clientId/health — dedicated health breakdown (operational + cadence components)
router.get('/:clientId/health', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    try {
        const result = await calculateClientHealth(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Client-success GET /:clientId/health error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /:clientId/recalculate — force a fresh health calculation.
// Not manager-gated, matching the existing client-health.js /recalculate precedent.
router.post('/:clientId/recalculate', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    try {
        const result = await calculateClientHealth(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Client-success /recalculate error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /:clientId — edit relationship fields (manager only). Creates the
// success row lazily if it doesn't exist yet.
router.put('/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const allowed = [
        'trend', 'last_meaningful_contact_date', 'next_planned_contact_date',
        'last_review_date', 'next_review_date', 'relationship_owner_team_member_id', 'notes',
    ];
    const update = _pick(req.body, allowed);
    if (update.trend && !TREND_VALUES.includes(update.trend)) return res.status(400).json({ error: 'Invalid trend' });
    update.updated_at = new Date().toISOString();

    try {
        await _getOrInitSuccessRow(cid, clientId);
        const { data, error } = await supabase.from('practice_client_success')
            .update(update).eq('company_id', cid).eq('client_id', clientId).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, 'health_assessed', 'client_success', data.id, clientId, req.user.userId, 'Relationship fields updated', { fields: Object.keys(update) });
        res.json({ success: data });
    } catch (err) {
        console.error('Client-success PUT /:clientId error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /:clientId/override — set or clear a manager override (manager only).
// Setting an override freezes relationship_status/score at the given values
// until explicitly cleared — calculateClientHealth() never overwrites it.
router.put('/:clientId/override', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { clear, relationship_status, relationship_score, override_reason } = req.body;

    try {
        await _getOrInitSuccessRow(cid, clientId);
        let update;
        let eventType;
        if (clear) {
            update = { is_manager_override: false, override_reason: null, override_by: null, override_at: null, updated_at: new Date().toISOString() };
            eventType = 'health_override_cleared';
        } else {
            if (!RELATIONSHIP_STATUSES.includes(relationship_status)) return res.status(400).json({ error: 'Invalid relationship_status' });
            update = {
                is_manager_override: true,
                relationship_status,
                relationship_score: relationship_score != null ? parseFloat(relationship_score) : null,
                override_reason: override_reason || null,
                override_by: req.user.userId,
                override_at: new Date().toISOString(),
                relationship_last_calculated_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            eventType = 'health_overridden';
        }

        const { data, error } = await supabase.from('practice_client_success')
            .update(update).eq('company_id', cid).eq('client_id', clientId).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, eventType, 'client_success', data.id, clientId, req.user.userId, override_reason || null, {});

        if (!clear && relationship_status === 'critical') {
            notify({
                cid, notificationKey: `client_success_critical_${clientId}`,
                title: `Client marked critical: ${client.name}`,
                message: override_reason || 'Manager override set relationship status to critical.',
                category: 'client', severity: 'high', sourceModule: 'client-success', sourceType: 'client_success', sourceId: data.id,
                createdBy: req.user.userId, assignment: { role: 'owner', clientId },
            }).catch(() => {});
        }

        res.json({ success: data });
    } catch (err) {
        console.error('Client-success PUT /:clientId/override error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUCCESS ACTIVITIES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/activities', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_client_success_activities')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('scheduled_date', { ascending: false, nullsFirst: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ activities: data || [] });
    } catch (err) {
        console.error('Client-success GET activities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/activities', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { activity_type, title, description, scheduled_date, owner_team_member_id, notes } = req.body;
    if (!ACTIVITY_TYPES.includes(activity_type)) return res.status(400).json({ error: 'Invalid activity_type' });
    if (!title) return res.status(400).json({ error: 'title is required' });

    try {
        const { data, error } = await supabase.from('practice_client_success_activities').insert({
            company_id: cid, client_id: clientId, activity_type, title, description: description || null,
            scheduled_date: scheduled_date || null, owner_team_member_id: owner_team_member_id || null,
            notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, 'activity_created', 'activity', data.id, clientId, req.user.userId, title, { activity_type });
        res.status(201).json({ activity: data });
    } catch (err) {
        console.error('Client-success POST activities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/activities/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid activity ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_client_success_activities').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Activity not found' });

    const allowed = ['activity_type', 'title', 'description', 'scheduled_date', 'completed_date', 'status', 'owner_team_member_id', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.activity_type && !ACTIVITY_TYPES.includes(update.activity_type)) return res.status(400).json({ error: 'Invalid activity_type' });
    if (update.status && !ACTIVITY_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'completed' && !update.completed_date) update.completed_date = today();
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_client_success_activities')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'completed' ? 'activity_completed' : update.status === 'cancelled' ? 'activity_cancelled' : 'activity_updated';
        await _writeEvent(cid, eventType, 'activity', id, existing.data.client_id, req.user.userId, null, {});
        res.json({ activity: data });
    } catch (err) {
        console.error('Client-success PUT activities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// MEETINGS — history is correctable via PUT, never deletable (audit trail)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/meetings', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_client_meetings')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('meeting_date', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ meetings: data || [] });
    } catch (err) {
        console.error('Client-success GET meetings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/meetings', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { meeting_date, purpose, attendees, summary, decisions, follow_ups, next_meeting_date, linked_document_notes, owner_team_member_id } = req.body;
    if (!meeting_date) return res.status(400).json({ error: 'meeting_date is required' });

    try {
        const { data, error } = await supabase.from('practice_client_meetings').insert({
            company_id: cid, client_id: clientId, meeting_date, purpose: purpose || null,
            attendees: Array.isArray(attendees) ? attendees : [], summary: summary || null,
            decisions: decisions || null, follow_ups: follow_ups || null, next_meeting_date: next_meeting_date || null,
            linked_document_notes: linked_document_notes || null, owner_team_member_id: owner_team_member_id || null,
            created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        // A logged meeting is meaningful contact — keep cadence in sync
        // without requiring a manager to also edit the success row by hand.
        await _getOrInitSuccessRow(cid, clientId);
        const successRow = await supabase.from('practice_client_success').select('last_meaningful_contact_date').eq('company_id', cid).eq('client_id', clientId).single();
        const shouldUpdateContact = !successRow.data?.last_meaningful_contact_date || meeting_date > successRow.data.last_meaningful_contact_date;
        const successUpdate = { updated_at: new Date().toISOString() };
        if (shouldUpdateContact) successUpdate.last_meaningful_contact_date = meeting_date;
        if (next_meeting_date) successUpdate.next_planned_contact_date = next_meeting_date;
        await supabase.from('practice_client_success').update(successUpdate).eq('company_id', cid).eq('client_id', clientId);

        await _writeEvent(cid, 'meeting_logged', 'meeting', data.id, clientId, req.user.userId, purpose || null, {});
        res.status(201).json({ meeting: data });
    } catch (err) {
        console.error('Client-success POST meetings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/meetings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_client_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Meeting not found' });

    const allowed = ['meeting_date', 'purpose', 'attendees', 'summary', 'decisions', 'follow_ups', 'next_meeting_date', 'linked_document_notes', 'owner_team_member_id'];
    const update = _pick(req.body, allowed);
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_client_meetings')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, 'meeting_updated', 'meeting', id, existing.data.client_id, req.user.userId, null, {});
        res.json({ meeting: data });
    } catch (err) {
        console.error('Client-success PUT meetings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// OPPORTUNITIES — NOT a sales pipeline. Manual log, status transitions only.
// ═══════════════════════════════════════════════════════════════════════════

// GET /opportunities/all — company-wide board across every client (2-segment
// literal path, registered ahead of no conflicting single-segment /:clientId
// GET route exists after this point, so ordering is safe either way — kept
// here to stay grouped with the rest of the Opportunities section).
router.get('/opportunities/all', async (req, res) => {
    const cid = req.companyId;
    const { status } = req.query;
    try {
        let q = supabase.from('practice_client_opportunities').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (status) q = q.eq('status', status);
        const [opportunities, clients] = await Promise.all([
            q,
            supabase.from('practice_clients').select('id, name').eq('company_id', cid),
        ]);
        if (opportunities.error) return res.status(500).json({ error: opportunities.error.message });

        const nameById = {};
        for (const c of (clients.data || [])) nameById[c.id] = c.name;

        const result = (opportunities.data || []).map(o => ({ ...o, client_name: nameById[o.client_id] || null }));
        res.json({ opportunities: result });
    } catch (err) {
        console.error('Client-success GET /opportunities/all error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:clientId/opportunities', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_client_opportunities')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ opportunities: data || [] });
    } catch (err) {
        console.error('Client-success GET opportunities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/opportunities', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { opportunity_type, title, description, estimated_value, expected_date, owner_team_member_id, notes } = req.body;
    if (!OPPORTUNITY_TYPES.includes(opportunity_type)) return res.status(400).json({ error: 'Invalid opportunity_type' });
    if (!title) return res.status(400).json({ error: 'title is required' });

    try {
        const { data, error } = await supabase.from('practice_client_opportunities').insert({
            company_id: cid, client_id: clientId, opportunity_type, title, description: description || null,
            estimated_value: estimated_value != null ? parseFloat(estimated_value) : null, expected_date: expected_date || null,
            owner_team_member_id: owner_team_member_id || null, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, 'opportunity_created', 'opportunity', data.id, clientId, req.user.userId, title, { opportunity_type });
        res.status(201).json({ opportunity: data });
    } catch (err) {
        console.error('Client-success POST opportunities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/opportunities/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid opportunity ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_client_opportunities').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Opportunity not found' });

    const allowed = ['opportunity_type', 'title', 'description', 'status', 'status_reason', 'estimated_value', 'expected_date', 'owner_team_member_id', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.opportunity_type && !OPPORTUNITY_TYPES.includes(update.opportunity_type)) return res.status(400).json({ error: 'Invalid opportunity_type' });
    if (update.status && !OPPORTUNITY_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.estimated_value != null) update.estimated_value = parseFloat(update.estimated_value);
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_client_opportunities')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'won' ? 'opportunity_won' : update.status === 'lost' ? 'opportunity_lost' : 'opportunity_updated';
        await _writeEvent(cid, eventType, 'opportunity', id, existing.data.client_id, req.user.userId, update.status_reason || null, {});
        res.json({ opportunity: data });
    } catch (err) {
        console.error('Client-success PUT opportunities error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS — read-only feed
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events/log', async (req, res) => {
    const cid = req.companyId;
    const { client_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_client_success_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Client-success GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/61_client_success.md
module.exports.calculateClientHealth = calculateClientHealth;
