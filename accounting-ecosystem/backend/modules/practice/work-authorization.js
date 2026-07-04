'use strict';

// Codebox 72 — Practice Engagement Scope Control + Work Authorization Gate
// "Are we allowed to do this work under the current engagement?" and "If
// not, who approved the exception?" — within seconds.
//
// NOT legal advice. NOT automatic engagement drafting. NOT billing
// automation. NOT hard blocking of normal work. This module WARNS and
// RECORDS — it never prevents an operation elsewhere in the system from
// completing. Managers (and, for high/critical risk, partners) decide.
//
// Reuses engagement-management.js's getClientEngagementProfile() export
// (Codebox 71) live — never duplicates engagement data or scope logic.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const engagementManagement = require('./engagement-management');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
// Partner-or-above — the required approver role for high/critical risk
// overrides. See _approveOverrideOrRisk() for the "unverified" fallback.
const PARTNER_ROLES = ['owner', 'partner'];

const WORK_TYPES = ['accounting', 'tax', 'payroll', 'secretarial', 'advisory', 'compliance', 'bookkeeping', 'company_secretarial', 'management', 'billing', 'onboarding', 'custom'];
const AUTHORIZATION_STATUSES = ['clear', 'warning', 'out_of_scope', 'override_requested', 'override_approved', 'override_rejected', 'accepted_risk', 'cancelled'];
const SCOPE_RESULTS = ['in_scope', 'possible_gap', 'out_of_scope', 'no_active_engagement', 'unknown'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

// Deterministic mapping of a work_type to the engagement_type(s) that
// directly cover it. See docs/new-app/72_work_authorization_scope_control.md
// for the full scope-mapping rationale.
const WORK_TYPE_ENGAGEMENT_TYPES = {
    accounting: ['accounting'], tax: ['tax'], payroll: ['payroll'],
    secretarial: ['secretarial', 'company_secretarial'], advisory: ['advisory'], compliance: ['compliance'],
    bookkeeping: ['bookkeeping'], company_secretarial: ['company_secretarial', 'secretarial'],
    management: ['management'], billing: [], onboarding: [], custom: [],
};
// Work types that can never be deterministically mapped to one engagement
// type — always 'unknown' when no direct/inclusion match exists, never
// escalated to a guessed possible_gap/out_of_scope.
const UNMAPPABLE_WORK_TYPES = ['billing', 'onboarding', 'custom'];

const SCOPE_TO_AUTH_STATUS = { in_scope: 'clear', possible_gap: 'warning', out_of_scope: 'out_of_scope', no_active_engagement: 'out_of_scope', unknown: 'warning' };

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role')
        .eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }
function _isPartner(member) { return !!member && PARTNER_ROLES.includes(member.role); }

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!_isManager(member)) {
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage work authorizations.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _fetchAuthorization(cid, id) {
    const { data } = await supabase.from('practice_work_authorizations').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, authorizationId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_work_authorization_events').insert({
        company_id: cid, authorization_id: authorizationId, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

function _mentionsWorkType(scopeArray, workType) {
    if (!Array.isArray(scopeArray)) return false;
    const needle = workType.replace(/_/g, ' ').toLowerCase();
    return scopeArray.some(item => typeof item === 'string' && item.toLowerCase().includes(needle));
}

// ── Scope Mapping — deterministic, never guessed ─────────────────────────────
// See docs Architect Freedom for the full reasoning behind this ordering:
// explicit exclusion always wins, then a direct engagement_type match, then
// an advisory/management engagement whose scope_inclusions explicitly
// mentions the work type, then "no engagement at all" vs. "some engagement
// but nothing matching" vs. genuinely unmappable work types.

function _resolveScope(workType, activeEngagements) {
    const excluded = activeEngagements.find(e => _mentionsWorkType(e.scope_exclusions, workType));
    if (excluded) {
        return { scopeResult: 'out_of_scope', matchedEngagement: excluded, reason: `Explicitly excluded from "${excluded.engagement_name}"'s scope.` };
    }

    const directTypes = WORK_TYPE_ENGAGEMENT_TYPES[workType] || [];
    const directMatch = activeEngagements.find(e => directTypes.includes(e.engagement_type));
    if (directMatch) {
        return { scopeResult: 'in_scope', matchedEngagement: directMatch, reason: `Covered by "${directMatch.engagement_name}" (${directMatch.engagement_type}).` };
    }

    const inclusionMatch = activeEngagements.find(e => ['advisory', 'management'].includes(e.engagement_type) && _mentionsWorkType(e.scope_inclusions, workType));
    if (inclusionMatch) {
        return { scopeResult: 'in_scope', matchedEngagement: inclusionMatch, reason: `Covered via "${inclusionMatch.engagement_name}"'s scope_inclusions mentioning ${workType.replace(/_/g, ' ')}.` };
    }

    if (!activeEngagements.length) {
        return { scopeResult: 'no_active_engagement', matchedEngagement: null, reason: 'Client has no active engagement of any kind.' };
    }

    if (UNMAPPABLE_WORK_TYPES.includes(workType)) {
        return { scopeResult: 'unknown', matchedEngagement: null, reason: `"${workType}" work cannot be deterministically mapped to a specific engagement type — manual review recommended.` };
    }

    return { scopeResult: 'possible_gap', matchedEngagement: null, reason: `Client has ${activeEngagements.length} active engagement(s), but none cover ${workType.replace(/_/g, ' ')} work specifically.` };
}

function _defaultRiskForScope(scopeResult) {
    if (scopeResult === 'in_scope') return 'low';
    if (scopeResult === 'out_of_scope') return 'high';
    if (scopeResult === 'no_active_engagement') return 'medium';
    if (scopeResult === 'possible_gap') return 'medium';
    return 'medium'; // unknown
}

function _recommendedAction(scopeResult, riskLevel) {
    if (scopeResult === 'in_scope') return 'No action needed — work is covered.';
    if (scopeResult === 'out_of_scope') return `This work appears out of scope (risk: ${riskLevel}). Request an override or resolve via Engagement Management before proceeding.`;
    if (scopeResult === 'no_active_engagement') return 'No active engagement covers this client at all. Create an engagement via Engagement Management, or request an override to proceed.';
    if (scopeResult === 'possible_gap') return 'Possible scope gap — confirm with Engagement Management whether this work is covered, or request an override.';
    return 'Scope could not be determined automatically — manual review recommended.';
}

// ── Authorization Engine — checkWorkAuthorization() ──────────────────────────

async function checkWorkAuthorization({ companyId, clientId, workType, sourceModule, sourceType, sourceId, riskLevel, metadata, actorUserId }) {
    const client = await _verifyClient(companyId, clientId);
    if (!client) throw new Error('Client not found');
    if (!WORK_TYPES.includes(workType)) throw new Error(`Invalid work_type "${workType}"`);
    if (!sourceModule || !sourceType) throw new Error('source_module and source_type are required');

    let activeEngagements = [];
    try {
        const profile = await engagementManagement.getClientEngagementProfile(companyId, clientId);
        activeEngagements = profile ? profile.active_engagements : [];
    } catch (e) {
        // Engagement data unavailable — never fail the caller's operation;
        // resolve as 'unknown' instead of throwing.
        activeEngagements = [];
    }

    const { scopeResult, matchedEngagement, reason } = _resolveScope(workType, activeEngagements);
    const resolvedRisk = RISK_LEVELS.includes(riskLevel) ? riskLevel : _defaultRiskForScope(scopeResult);
    const authorizationStatus = SCOPE_TO_AUTH_STATUS[scopeResult];

    let existingQuery = supabase.from('practice_work_authorizations').select('*')
        .eq('company_id', companyId).eq('source_module', sourceModule).eq('source_type', sourceType).eq('work_type', workType)
        .not('authorization_status', 'in', '("cancelled","override_rejected")');
    // .eq() never matches NULL in PostgREST — a null source_id (a check with
    // no specific source record, e.g. a manual client-level check) needs
    // .is() instead, or every re-check would create a fresh duplicate row.
    existingQuery = sourceId ? existingQuery.eq('source_id', sourceId) : existingQuery.is('source_id', null);
    const { data: existing } = await existingQuery.maybeSingle();

    const row = {
        company_id: companyId, client_id: clientId, source_module: sourceModule, source_type: sourceType, source_id: sourceId || null,
        work_type: workType, authorization_status: authorizationStatus,
        matched_engagement_id: matchedEngagement ? matchedEngagement.id : null,
        matched_engagement_status: matchedEngagement ? matchedEngagement.engagement_status : null,
        scope_result: scopeResult, risk_level: resolvedRisk, reason, metadata: metadata || {},
    };

    let record;
    const priorStatus = existing ? existing.authorization_status : null;
    if (existing) {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ ...row, updated_by: actorUserId || null }).eq('id', existing.id).eq('company_id', companyId).select().single();
        if (error) throw new Error(error.message);
        record = data;
    } else {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .insert({ ...row, created_by: actorUserId || null }).select().single();
        if (error) throw new Error(error.message);
        record = data;
    }

    await _writeEvent(companyId, record.id, 'authorization_checked', priorStatus, authorizationStatus, actorUserId, null, { scope_result: scopeResult });
    if (scopeResult !== 'in_scope' && priorStatus !== authorizationStatus) {
        await _writeEvent(companyId, record.id, 'authorization_warning_created', priorStatus, authorizationStatus, actorUserId, reason, {});
    }

    return { authorization: record, recommended_action: _recommendedAction(scopeResult, resolvedRisk) };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: rows } = await supabase.from('practice_work_authorizations')
            .select('authorization_status, scope_result, risk_level').eq('company_id', cid).neq('authorization_status', 'cancelled');
        const auths = rows || [];

        const statusCounts = {}; AUTHORIZATION_STATUSES.forEach(s => { statusCounts[s] = 0; });
        auths.forEach(a => { if (a.authorization_status in statusCounts) statusCounts[a.authorization_status]++; });

        res.json({
            authorizations_total: auths.length,
            by_authorization_status: statusCounts,
            out_of_scope_work: auths.filter(a => a.scope_result === 'out_of_scope' || a.scope_result === 'no_active_engagement').length,
            pending_overrides: auths.filter(a => a.authorization_status === 'override_requested').length,
            high_risk_overrides: auths.filter(a => a.authorization_status === 'override_approved' && ['high', 'critical'].includes(a.risk_level)).length,
        });
    } catch (err) {
        console.error('Work-authorization /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECK
// ═══════════════════════════════════════════════════════════════════════════

router.post('/check', async (req, res) => {
    const cid = req.companyId;
    const { client_id, work_type, source_module, source_type, source_id, risk_level, metadata } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!work_type) return res.status(400).json({ error: 'work_type is required' });
    if (!source_module || !source_type) return res.status(400).json({ error: 'source_module and source_type are required' });
    if (risk_level && !RISK_LEVELS.includes(risk_level)) return res.status(400).json({ error: 'Invalid risk_level' });

    try {
        const result = await checkWorkAuthorization({
            companyId: cid, clientId, workType: work_type, sourceModule: source_module, sourceType: source_type,
            sourceId: source_id ? parseInt(source_id) : null, riskLevel: risk_level, metadata, actorUserId: req.user.userId,
        });
        res.status(201).json(result);
    } catch (err) {
        console.error('Work-authorization POST /check error:', err.message);
        const status = err.message === 'Client not found' || err.message.startsWith('Invalid work_type') ? 400 : 500;
        res.status(status).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATIONS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { client_id, authorization_status, scope_result, work_type, source_module, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_work_authorizations').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (authorization_status) q = q.eq('authorization_status', authorization_status);
        if (scope_result) q = q.eq('scope_result', scope_result);
        if (work_type) q = q.eq('work_type', work_type);
        if (source_module) q = q.eq('source_module', source_module);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(a => a.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ authorizations: (data || []).map(a => ({ ...a, client_name: nameById[a.client_id] || null })) });
    } catch (err) {
        console.error('Work-authorization GET list error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    try {
        const auth = await _fetchAuthorization(cid, id);
        if (!auth) return res.status(404).json({ error: 'Authorization not found' });
        res.json({ authorization: auth });
    } catch (err) {
        console.error('Work-authorization GET :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Override / Risk Actions ───────────────────────────────────────────────────

router.put('/:id/request-override', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const auth = await _fetchAuthorization(cid, id);
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    if (!['warning', 'out_of_scope'].includes(auth.authorization_status)) {
        return res.status(400).json({ error: `Cannot request an override from status "${auth.authorization_status}".` });
    }
    if (!req.body.override_reason) return res.status(400).json({ error: 'override_reason is required to request an override.' });

    try {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ authorization_status: 'override_requested', override_reason: req.body.override_reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'override_requested', auth.authorization_status, 'override_requested', req.user.userId, req.body.override_reason, {});
        res.json({ authorization: data });
    } catch (err) {
        console.error('Work-authorization request-override error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/approve-override', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const auth = await _fetchAuthorization(cid, id);
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    if (auth.authorization_status !== 'override_requested') return res.status(400).json({ error: 'Only an authorization with a pending override request can be approved.' });

    // High/critical risk requires a partner. If the approver is a manager/
    // admin (not a partner), the approval is still allowed — "no silent
    // blocking" — but flagged as unverified for later review, never hidden.
    const needsPartner = ['high', 'critical'].includes(auth.risk_level);
    const partnerUnverified = needsPartner && !_isPartner(member);

    try {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ authorization_status: 'override_approved', approved_by: req.user.userId, approved_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'override_approved', auth.authorization_status, 'override_approved', req.user.userId, req.body.notes || null, partnerUnverified ? { partner_required_unverified: true, approver_role: member.role } : {});
        res.json({ authorization: data, partner_required_unverified: partnerUnverified });
    } catch (err) {
        console.error('Work-authorization approve-override error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/reject-override', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const auth = await _fetchAuthorization(cid, id);
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    if (auth.authorization_status !== 'override_requested') return res.status(400).json({ error: 'Only an authorization with a pending override request can be rejected.' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to reject an override.' });

    try {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ authorization_status: 'override_rejected', rejected_by: req.user.userId, rejected_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'override_rejected', auth.authorization_status, 'override_rejected', req.user.userId, req.body.reason, {});
        res.json({ authorization: data });
    } catch (err) {
        console.error('Work-authorization reject-override error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/accept-risk', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const auth = await _fetchAuthorization(cid, id);
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    if (!['warning', 'out_of_scope', 'override_requested'].includes(auth.authorization_status)) {
        return res.status(400).json({ error: `Cannot accept risk from status "${auth.authorization_status}".` });
    }
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to accept risk.' });

    const needsPartner = ['high', 'critical'].includes(auth.risk_level);
    const partnerUnverified = needsPartner && !_isPartner(member);

    try {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ authorization_status: 'accepted_risk', approved_by: req.user.userId, approved_at: new Date().toISOString(), override_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'accepted_risk', auth.authorization_status, 'accepted_risk', req.user.userId, req.body.reason, partnerUnverified ? { partner_required_unverified: true, approver_role: member.role } : {});
        res.json({ authorization: data, partner_required_unverified: partnerUnverified });
    } catch (err) {
        console.error('Work-authorization accept-risk error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const auth = await _fetchAuthorization(cid, id);
    if (!auth) return res.status(404).json({ error: 'Authorization not found' });
    if (auth.authorization_status === 'cancelled') return res.status(400).json({ error: 'Authorization is already cancelled.' });

    try {
        const { data, error } = await supabase.from('practice_work_authorizations')
            .update({ authorization_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'authorization_cancelled', auth.authorization_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        res.json({ authorization: data });
    } catch (err) {
        console.error('Work-authorization DELETE :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid authorization ID' });
    try {
        const { data, error } = await supabase.from('practice_work_authorization_events').select('*').eq('company_id', cid).eq('authorization_id', id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Work-authorization GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules (Tasks, Workflow generation, Client Onboarding,
// Planning Board) — see docs/new-app/72_work_authorization_scope_control.md
module.exports.checkWorkAuthorization = checkWorkAuthorization;
