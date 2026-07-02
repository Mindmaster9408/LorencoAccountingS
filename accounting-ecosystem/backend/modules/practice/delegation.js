'use strict';

// Codebox 58 — Practice Delegation + Work Reassignment Controls
// Managers (and, for their own work, individual contributors) can safely
// move ownership of a work item to someone else — transparently,
// auditably, and reversibly. NOT AI delegation. NOT automatic
// reassignment. NOT approval workflows. NOT skill matching.
//
// This module does not own task/deadline/review/etc. data. It changes the
// existing owner column on the source table via changeOwnership() and
// keeps a full audit trail of that change — source modules remain owners
// of their own tables. changeOwnership() is exported so future modules can
// register their own source_module in SOURCE_REGISTRY and reuse it,
// exactly as the spec's Ownership Engine section requires.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const notifications = require('./notifications');
const workQueue = require('./work-queue');
const planningBoard = require('./planning-board');
// Codebox 59 — advisory only. Every use below is a warning label attached
// to the response, never a gate: a low-competency or restricted new owner
// can still be delegated to. See _competencyAdvisory().
const skillsMatrix = require('./skills-matrix');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const STATUSES = ['draft', 'delegated', 'accepted', 'declined', 'cancelled', 'completed'];
const ACTIVE_STATUSES = ['delegated', 'accepted'];

// One reusable registry — "Future modules can register" (spec's Supported
// Source Types section). Each entry names the table, the descriptive
// source_type label, the set of valid ownership "roles" and which column
// each maps to, the default role when none is specified, how to derive a
// human-readable title, and a deep link back to the source page.
const SOURCE_REGISTRY = {
    tasks: {
        table: 'practice_tasks', sourceType: 'practice_task',
        roles: { assignee: 'assigned_to', preparer: 'preparer_team_member_id', reviewer: 'reviewer_team_member_id', approver: 'approver_team_member_id' },
        defaultRole: 'assignee', titleField: 'title',
        deepLink: id => '/practice/tasks.html?open=' + id,
    },
    deadlines: {
        table: 'practice_deadlines', sourceType: 'practice_deadline',
        roles: { responsible: 'responsible_team_member_id' },
        defaultRole: 'responsible', titleField: 'title',
        deepLink: id => '/practice/deadlines.html?open=' + id,
    },
    'risk-register': {
        table: 'practice_risks', sourceType: 'practice_risk',
        roles: { owner: 'owner_team_member_id' },
        defaultRole: 'owner', titleField: 'title',
        deepLink: id => '/practice/risk-register.html?open=' + id,
    },
    'qms-review': {
        table: 'practice_quality_reviews', sourceType: 'practice_quality_review',
        roles: { reviewer: 'assigned_reviewer_team_member_id' },
        defaultRole: 'reviewer', titleField: 'review_title',
        deepLink: id => '/practice/quality-management.html?open=' + id,
    },
    'qms-finding': {
        table: 'practice_quality_findings', sourceType: 'practice_quality_finding',
        roles: { responsible: 'responsible_team_member_id' },
        defaultRole: 'responsible', titleField: 'finding_title',
        deepLink: id => '/practice/quality-management.html?finding=' + id,
    },
    'tax-individual': {
        table: 'practice_individual_tax_returns', sourceType: 'practice_individual_tax_returns',
        roles: { preparer: 'responsible_team_member_id', reviewer: 'reviewer_team_member_id' },
        defaultRole: 'preparer', titleField: null, // composite title — see _getSourceTitle
        deepLink: id => '/practice/individual-tax.html?open=' + id,
    },
    'tax-company': {
        table: 'practice_company_tax_returns', sourceType: 'practice_company_tax_returns',
        roles: { preparer: 'responsible_team_member_id', reviewer: 'reviewer_team_member_id' },
        defaultRole: 'preparer', titleField: null,
        deepLink: id => '/practice/company-tax.html?open=' + id,
    },
    'compliance-packs': {
        table: 'practice_compliance_packs', sourceType: 'practice_compliance_pack',
        roles: { owner: 'owner_team_member_id', reviewer: 'reviewer_team_member_id' },
        defaultRole: 'owner', titleField: ['pack_name', 'pack_type'],
        deepLink: id => '/practice/compliance-packs.html?open=' + id,
    },
    'document-requests': {
        table: 'practice_document_requests', sourceType: 'practice_document_request',
        roles: { assignee: 'assigned_team_member_id' },
        defaultRole: 'assignee', titleField: ['request_title', 'document_category'],
        deepLink: id => '/practice/document-requests.html?open=' + id,
    },
    reminders: {
        table: 'practice_reminders', sourceType: 'practice_reminder',
        roles: { assignee: 'assigned_team_member_id' },
        defaultRole: 'assignee', titleField: ['title', 'reminder_type'],
        deepLink: id => '/practice/reminders.html?open=' + id,
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role').eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }

async function _writeEvent(cid, delegationId, eventType, oldOwnerId, newOwnerId, actorUserId, notes, meta) {
    await supabase.from('practice_work_delegation_events').insert({
        company_id: cid, delegation_id: delegationId, event_type: eventType,
        old_owner_id: oldOwnerId != null ? oldOwnerId : null, new_owner_id: newOwnerId != null ? newOwnerId : null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _resolveRegistry(sourceModule, role) {
    const registry = SOURCE_REGISTRY[sourceModule];
    if (!registry) throw new Error(`Unknown source_module "${sourceModule}". Supported: ${Object.keys(SOURCE_REGISTRY).join(', ')}.`);
    const resolvedRole = role || registry.defaultRole;
    const column = registry.roles[resolvedRole];
    if (!column) throw new Error(`Invalid role "${resolvedRole}" for source_module "${sourceModule}". Valid roles: ${Object.keys(registry.roles).join(', ')}.`);
    return { registry, role: resolvedRole, column };
}

async function _getCurrentOwner(cid, sourceModule, sourceId, role) {
    const { registry, role: resolvedRole, column } = _resolveRegistry(sourceModule, role);
    const { data, error } = await supabase.from(registry.table).select(`id, ${column}`).eq('id', sourceId).eq('company_id', cid).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Source record not found for this company.');
    return { registry, role: resolvedRole, column, currentOwnerId: data[column] != null ? data[column] : null };
}

async function _validateNewOwner(cid, newOwnerId) {
    const { data } = await supabase.from('practice_team_members').select('id').eq('id', newOwnerId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    if (!data) throw new Error('new_owner_id is not a valid active team member for this company.');
}

async function _writeSourceOwner(cid, table, column, sourceId, newOwnerId) {
    const { error } = await supabase.from(table).update({ [column]: newOwnerId }).eq('id', sourceId).eq('company_id', cid);
    if (error) throw error;
    // "Delegation must immediately affect Planning Board / Work Queue /
    // Resource Forecast / Capacity" — clearing these two caches is what
    // makes that true without a second recalculation engine. Capacity.js
    // has no cache of its own (always queries live), so nothing to clear there.
    workQueue.invalidateCache(cid);
    planningBoard.invalidatePoolCache(cid);
}

async function _getSourceTitle(registry, sourceId) {
    if (registry.titleField) {
        const cols = Array.isArray(registry.titleField) ? registry.titleField : [registry.titleField];
        const { data } = await supabase.from(registry.table).select(['id', ...cols].join(', ')).eq('id', sourceId).maybeSingle();
        if (data) { for (const c of cols) { if (data[c]) return data[c]; } }
        return `${registry.table} #${sourceId}`;
    }
    // Tax returns have no title column — compose one from the client + tax year, same convention as work-queue.js's tax fetcher.
    const { data } = await supabase.from(registry.table).select('id, tax_year, practice_clients:client_id(name)').eq('id', sourceId).maybeSingle();
    if (data) return `${data.practice_clients?.name || 'Unknown client'} — ${data.tax_year || 'tax return'}`;
    return `${registry.table} #${sourceId}`;
}

async function _revertOwnership(cid, delegation, actorUserId) {
    const { registry, column } = _resolveRegistry(delegation.source_module, delegation.ownership_role);
    await _writeSourceOwner(cid, registry.table, column, delegation.source_id, delegation.previous_owner_id);
    await _writeEvent(cid, delegation.id, 'ownership_changed', delegation.new_owner_id, delegation.previous_owner_id, actorUserId, null, { via: 'revert' });
}

// ── changeOwnership() — the reusable helper every module should call ──────────
// Responsibilities (per spec): validate ownership, validate destination,
// update the source record, create the delegation record, write events,
// notify the assignee, return the result. Every future module that wants
// to support delegation registers itself in SOURCE_REGISTRY above and
// calls this function — none of them re-implement any of the above.
async function changeOwnership({ cid, sourceModule, sourceType, sourceId, role, newOwnerId, delegatedBy, reason, notes, effectiveDate, actorUserId }) {
    if (!reason) throw new Error('delegation_reason is required.');
    if (newOwnerId == null) throw new Error('new_owner_id is required.');

    const { registry, role: resolvedRole, column, currentOwnerId } = await _getCurrentOwner(cid, sourceModule, sourceId, role);
    if (currentOwnerId === newOwnerId) throw new Error('new_owner_id is already the current owner of this item — nothing to delegate.');
    await _validateNewOwner(cid, newOwnerId);

    await _writeSourceOwner(cid, registry.table, column, sourceId, newOwnerId);

    const { data: delegation, error } = await supabase.from('practice_work_delegations').insert({
        company_id: cid, source_module: sourceModule, source_type: sourceType || registry.sourceType, source_id: sourceId,
        ownership_role: resolvedRole, previous_owner_id: currentOwnerId, new_owner_id: newOwnerId,
        delegated_by: delegatedBy || null, delegation_reason: reason, delegation_notes: notes || null,
        delegation_status: 'delegated', effective_date: effectiveDate || null, created_by: actorUserId || null,
    }).select().single();
    if (error) throw error;

    await _writeEvent(cid, delegation.id, 'delegation_created', currentOwnerId, newOwnerId, actorUserId, reason);
    await _writeEvent(cid, delegation.id, 'ownership_changed', currentOwnerId, newOwnerId, actorUserId, null, { via: 'delegation_created' });

    const title = await _getSourceTitle(registry, sourceId).catch(() => `${registry.table} #${sourceId}`);
    notifications.notify({
        cid, notificationKey: `delegation_assigned_${delegation.id}`,
        title: `You have been assigned: ${title}`, message: reason,
        category: 'workflow', severity: 'medium',
        sourceModule: 'delegation', sourceType: sourceType || registry.sourceType, sourceId: delegation.id,
        dueDate: effectiveDate || null, createdBy: actorUserId,
        assignment: { teamMemberId: newOwnerId },
    }).catch(err => console.error('[delegation] notify (assigned) failed — non-fatal', err.message));

    return { delegation, previous_owner_id: currentOwnerId, new_owner_id: newOwnerId };
}

// ── Enrichment (list/detail responses) ─────────────────────────────────────────

// Codebox 59 (Skills Matrix) advisory — warning label only, never a gate.
// Compares the previous and new owner's competency for whatever skill(s)
// map to this delegation's source_module (see skills-matrix.js's
// MODULE_SKILL_MAP). Scoped to single-delegation detail views only (not
// list views) to keep GET / cheap — each call here is a handful of extra
// lightweight queries, fine for one delegation, not worth paying for N of
// them on every list load.
async function _competencyAdvisory(cid, sourceModule, previousOwnerId, newOwnerId) {
    try {
        const [prev, next] = await Promise.all([
            previousOwnerId != null ? skillsMatrix.getCompetency(cid, previousOwnerId, sourceModule) : Promise.resolve(null),
            newOwnerId != null ? skillsMatrix.getCompetency(cid, newOwnerId, sourceModule) : Promise.resolve(null),
        ]);
        let warning = null;
        if (next && next.restrictions.length) warning = `${next.team_member_name || 'The new owner'} is marked restricted for: ${next.restrictions.join(', ')}.`;
        else if (next && next.specific_skill_matched && next.specific_level != null && next.specific_level <= 1) warning = `${next.team_member_name || 'The new owner'} has little or no recorded experience with this type of work.`;

        return {
            previous_owner: prev ? { level: prev.specific_skill_matched ? prev.specific_level : prev.overall_level, specific_skill_matched: prev.specific_skill_matched, restrictions: prev.restrictions } : null,
            new_owner: next ? { level: next.specific_skill_matched ? next.specific_level : next.overall_level, specific_skill_matched: next.specific_skill_matched, restrictions: next.restrictions } : null,
            warning,
        };
    } catch (e) {
        console.error('[delegation] competency advisory failed — non-fatal', e.message);
        return null;
    }
}

async function _enrichDelegations(delegations, includeAdvisory) {
    if (!delegations.length) return [];

    const memberIds = new Set();
    delegations.forEach(d => { [d.previous_owner_id, d.new_owner_id, d.delegated_by].forEach(id => { if (id != null) memberIds.add(id); }); });
    let membersById = {};
    if (memberIds.size) {
        const { data } = await supabase.from('practice_team_members').select('id, display_name').in('id', [...memberIds]);
        (data || []).forEach(m => { membersById[m.id] = m.display_name; });
    }

    return Promise.all(delegations.map(async d => {
        const registry = SOURCE_REGISTRY[d.source_module];
        const title = registry ? await _getSourceTitle(registry, d.source_id).catch(() => null) : null;
        const enriched = Object.assign({}, d, {
            title: title || `${d.source_type} #${d.source_id}`,
            deep_link: registry ? registry.deepLink(d.source_id) : null,
            previous_owner_name: d.previous_owner_id != null ? (membersById[d.previous_owner_id] || null) : null,
            new_owner_name: membersById[d.new_owner_id] || null,
            delegated_by_name: d.delegated_by != null ? (membersById[d.delegated_by] || null) : null,
        });
        if (includeAdvisory) enriched.competency_advisory = await _competencyAdvisory(d.company_id, d.source_module, d.previous_owner_id, d.new_owner_id);
        return enriched;
    }));
}

async function _verifyDelegation(id, cid) {
    const { data } = await supabase.from('practice_work_delegations').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

function _isInvolved(delegation, teamMemberId) {
    return teamMemberId != null && (delegation.previous_owner_id === teamMemberId || delegation.new_owner_id === teamMemberId || delegation.delegated_by === teamMemberId);
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const manager = _isManager(me);

        let q = supabase.from('practice_work_delegations').select('delegation_status, previous_owner_id, new_owner_id, delegated_by').eq('company_id', cid);
        if (!manager && me) q = q.or(`previous_owner_id.eq.${me.id},new_owner_id.eq.${me.id},delegated_by.eq.${me.id}`);
        else if (!manager && !me) return res.json({ total: 0, by_status: {}, pending_acceptance: 0, awaiting_my_response: 0 });

        const { data, error } = await q;
        if (error) throw error;
        const rows = data || [];

        const byStatus = { draft: 0, delegated: 0, accepted: 0, declined: 0, cancelled: 0, completed: 0 };
        rows.forEach(d => { if (byStatus[d.delegation_status] != null) byStatus[d.delegation_status]++; });

        const awaitingMyResponse = me ? rows.filter(d => d.delegation_status === 'delegated' && d.new_owner_id === me.id).length : 0;

        res.json({
            total: rows.length, by_status: byStatus,
            pending_acceptance: byStatus.delegated,
            awaiting_my_response: awaitingMyResponse,
            is_manager: manager,
        });
    } catch (err) {
        console.error('GET /api/practice/delegation/summary', err);
        res.status(500).json({ error: 'Failed to load delegation summary.' });
    }
});

// ── GET / (list) ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const manager = _isManager(me);

        let q = supabase.from('practice_work_delegations').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (req.query.status) q = q.eq('delegation_status', req.query.status);
        if (req.query.source_module) q = q.eq('source_module', req.query.source_module);

        if (!manager) {
            if (!me) return res.json({ delegations: [], total: 0 });
            q = q.or(`previous_owner_id.eq.${me.id},new_owner_id.eq.${me.id},delegated_by.eq.${me.id}`);
        } else if (req.query.my === 'true' && me) {
            q = q.or(`previous_owner_id.eq.${me.id},new_owner_id.eq.${me.id},delegated_by.eq.${me.id}`);
        }

        const { data, error } = await q;
        if (error) throw error;

        const enriched = await _enrichDelegations(data || []);
        res.json({ delegations: enriched, total: enriched.length });
    } catch (err) {
        console.error('GET /api/practice/delegation', err);
        res.status(500).json({ error: 'Failed to load delegations.' });
    }
});

// ── GET /competency-preview (advisory — before the create modal submits) ──────
// Lets the frontend show "Current owner competency / New owner competency /
// Suggested" warnings BEFORE a manager commits to a delegation, per the
// spec's Delegation Integration section. Warning only — the caller decides
// whether to proceed regardless of what this returns.
//
// Registered BEFORE GET /:id deliberately — Express matches routes in
// registration order, and /:id would otherwise swallow this path by
// treating "competency-preview" as an :id value.

router.get('/competency-preview', async (req, res) => {
    try {
        const cid = req.companyId;
        const { source_module: sourceModule, source_id: sourceId, role, new_owner_id: newOwnerId } = req.query;
        if (!sourceModule || !sourceId) return res.status(422).json({ error: 'source_module and source_id are required.' });

        let currentOwnerId = null;
        try {
            const resolved = await _getCurrentOwner(cid, sourceModule, parseInt(sourceId, 10), role);
            currentOwnerId = resolved.currentOwnerId;
        } catch (e) { /* unknown source — advisory just won't have a "current owner" side */ }

        const advisory = await _competencyAdvisory(cid, sourceModule, currentOwnerId, newOwnerId ? parseInt(newOwnerId, 10) : null);
        res.json({ advisory, current_owner_id: currentOwnerId });
    } catch (err) {
        console.error('GET /api/practice/delegation/competency-preview', err);
        res.status(500).json({ error: 'Failed to load competency preview.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && !_isInvolved(delegation, me?.id)) return res.status(403).json({ error: 'You are not involved in this delegation.' });

        const [enriched] = await _enrichDelegations([delegation], true);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('GET /api/practice/delegation/:id', err);
        res.status(500).json({ error: 'Failed to load delegation.' });
    }
});

// ── POST / (create — this IS the reassignment) ─────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const body = req.body || {};

        if (!body.source_module) return res.status(422).json({ error: 'source_module is required.' });
        if (!body.source_id) return res.status(422).json({ error: 'source_id is required.' });
        if (!body.new_owner_id) return res.status(422).json({ error: 'new_owner_id is required.' });
        if (!body.delegation_reason) return res.status(422).json({ error: 'delegation_reason is required.' });

        const sourceId = parseInt(body.source_id, 10);
        const newOwnerId = parseInt(body.new_owner_id, 10);

        // Authorization: a manager can delegate anything; anyone else may
        // only delegate their OWN work (self-service handoff) — resolved
        // by checking whether the caller is the current owner of the
        // requested role before any change is made.
        let currentOwnerCheck;
        try {
            currentOwnerCheck = await _getCurrentOwner(cid, body.source_module, sourceId, body.role);
        } catch (e) {
            return res.status(422).json({ error: e.message });
        }
        if (!_isManager(me) && (!me || currentOwnerCheck.currentOwnerId !== me.id)) {
            return res.status(403).json({ error: 'You can only delegate work that is currently assigned to you, unless you are a manager.' });
        }

        const result = await changeOwnership({
            cid, sourceModule: body.source_module, sourceType: body.source_type, sourceId,
            role: body.role, newOwnerId, delegatedBy: me ? me.id : null,
            reason: body.delegation_reason, notes: body.delegation_notes,
            effectiveDate: body.effective_date || null, actorUserId: req.user?.userId,
        });

        const [enriched] = await _enrichDelegations([result.delegation]);
        res.status(201).json({ delegation: enriched });
    } catch (err) {
        console.error('POST /api/practice/delegation', err);
        res.status(422).json({ error: err.message || 'Failed to create delegation.' });
    }
});

// ── PUT /:id (edit reason/notes/effective_date only — never ownership) ────────

router.put('/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });

        const canEdit = _isManager(me) || (me && delegation.delegated_by === me.id);
        if (!canEdit) return res.status(403).json({ error: 'Only the delegator or a manager can edit this delegation.' });
        if (!ACTIVE_STATUSES.includes(delegation.delegation_status) && delegation.delegation_status !== 'draft') {
            return res.status(422).json({ error: 'This delegation is already closed out and can no longer be edited.' });
        }

        const body = req.body || {};
        const patch = {};
        if (body.delegation_reason !== undefined) patch.delegation_reason = body.delegation_reason;
        if (body.delegation_notes !== undefined) patch.delegation_notes = body.delegation_notes;
        if (body.effective_date !== undefined) patch.effective_date = body.effective_date || null;

        const { data, error } = await supabase.from('practice_work_delegations').update(patch).eq('id', delegation.id).eq('company_id', cid).select().single();
        if (error) throw error;

        const [enriched] = await _enrichDelegations([data]);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('PUT /api/practice/delegation/:id', err);
        res.status(500).json({ error: 'Failed to update delegation.' });
    }
});

// ── PUT /:id/accept ───────────────────────────────────────────────────────────

router.put('/:id/accept', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && (!me || delegation.new_owner_id !== me.id)) return res.status(403).json({ error: 'Only the new owner or a manager can accept this delegation.' });
        if (delegation.delegation_status !== 'delegated') return res.status(422).json({ error: 'Only a pending delegation can be accepted.' });

        const { data, error } = await supabase.from('practice_work_delegations').update({ delegation_status: 'accepted' }).eq('id', delegation.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, delegation.id, 'delegation_accepted', delegation.previous_owner_id, delegation.new_owner_id, req.user?.userId);

        if (delegation.delegated_by) {
            const title = await _getSourceTitle(SOURCE_REGISTRY[delegation.source_module], delegation.source_id).catch(() => 'a delegated item');
            notifications.notify({
                cid, notificationKey: `delegation_accepted_${delegation.id}`,
                title: `Delegation accepted: ${title}`, message: `${me?.display_name || 'The new owner'} accepted the delegation.`,
                category: 'workflow', severity: 'info',
                sourceModule: 'delegation', sourceType: delegation.source_type, sourceId: delegation.id,
                createdBy: req.user?.userId, assignment: { teamMemberId: delegation.delegated_by },
            }).catch(e => console.error('[delegation] notify (accepted) failed — non-fatal', e.message));
        }

        const [enriched] = await _enrichDelegations([data]);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('PUT /api/practice/delegation/:id/accept', err);
        res.status(500).json({ error: 'Failed to accept delegation.' });
    }
});

// ── PUT /:id/decline (reverts ownership) ───────────────────────────────────────

router.put('/:id/decline', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && (!me || delegation.new_owner_id !== me.id)) return res.status(403).json({ error: 'Only the new owner or a manager can decline this delegation.' });
        if (delegation.delegation_status !== 'delegated') return res.status(422).json({ error: 'Only a pending delegation can be declined.' });

        await _revertOwnership(cid, delegation, req.user?.userId);

        const { data, error } = await supabase.from('practice_work_delegations').update({ delegation_status: 'declined' }).eq('id', delegation.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, delegation.id, 'delegation_declined', delegation.new_owner_id, delegation.previous_owner_id, req.user?.userId, req.body?.notes || null);

        if (delegation.delegated_by) {
            const title = await _getSourceTitle(SOURCE_REGISTRY[delegation.source_module], delegation.source_id).catch(() => 'a delegated item');
            notifications.notify({
                cid, notificationKey: `delegation_declined_${delegation.id}`,
                title: `Delegation declined: ${title}`, message: req.body?.notes || `${me?.display_name || 'The intended owner'} declined the delegation — ownership has reverted.`,
                category: 'workflow', severity: 'high',
                sourceModule: 'delegation', sourceType: delegation.source_type, sourceId: delegation.id,
                createdBy: req.user?.userId, assignment: { teamMemberId: delegation.delegated_by },
            }).catch(e => console.error('[delegation] notify (declined) failed — non-fatal', e.message));
        }

        const [enriched] = await _enrichDelegations([data]);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('PUT /api/practice/delegation/:id/decline', err);
        res.status(500).json({ error: 'Failed to decline delegation.' });
    }
});

// ── PUT /:id/cancel (reverts ownership) ─────────────────────────────────────────

router.put('/:id/cancel', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && (!me || delegation.delegated_by !== me.id)) return res.status(403).json({ error: 'Only the delegator or a manager can cancel this delegation.' });
        if (!ACTIVE_STATUSES.includes(delegation.delegation_status)) return res.status(422).json({ error: 'Only a delegated or accepted delegation can be cancelled.' });

        await _revertOwnership(cid, delegation, req.user?.userId);

        const { data, error } = await supabase.from('practice_work_delegations').update({ delegation_status: 'cancelled' }).eq('id', delegation.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, delegation.id, 'delegation_cancelled', delegation.new_owner_id, delegation.previous_owner_id, req.user?.userId, req.body?.notes || null);

        const title = await _getSourceTitle(SOURCE_REGISTRY[delegation.source_module], delegation.source_id).catch(() => 'a delegated item');
        notifications.notify({
            cid, notificationKey: `delegation_cancelled_${delegation.id}`,
            title: `Delegation cancelled: ${title}`, message: 'This item has been reassigned back to its previous owner.',
            category: 'workflow', severity: 'medium',
            sourceModule: 'delegation', sourceType: delegation.source_type, sourceId: delegation.id,
            createdBy: req.user?.userId, assignment: { teamMemberId: delegation.new_owner_id },
        }).catch(e => console.error('[delegation] notify (cancelled) failed — non-fatal', e.message));

        const [enriched] = await _enrichDelegations([data]);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('PUT /api/practice/delegation/:id/cancel', err);
        res.status(500).json({ error: 'Failed to cancel delegation.' });
    }
});

// ── PUT /:id/complete (no ownership change — closes the record out) ───────────

router.put('/:id/complete', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && (!me || delegation.new_owner_id !== me.id)) return res.status(403).json({ error: 'Only the new owner or a manager can complete this delegation.' });
        if (!ACTIVE_STATUSES.includes(delegation.delegation_status)) return res.status(422).json({ error: 'Only a delegated or accepted delegation can be marked complete.' });

        const { data, error } = await supabase.from('practice_work_delegations').update({ delegation_status: 'completed', completed_at: new Date().toISOString() }).eq('id', delegation.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, delegation.id, 'delegation_completed', delegation.previous_owner_id, delegation.new_owner_id, req.user?.userId);

        const [enriched] = await _enrichDelegations([data]);
        res.json({ delegation: enriched });
    } catch (err) {
        console.error('PUT /api/practice/delegation/:id/complete', err);
        res.status(500).json({ error: 'Failed to complete delegation.' });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const delegation = await _verifyDelegation(req.params.id, cid);
        if (!delegation) return res.status(404).json({ error: 'Delegation not found.' });
        if (!_isManager(me) && !_isInvolved(delegation, me?.id)) return res.status(403).json({ error: 'You are not involved in this delegation.' });

        const { data, error } = await supabase.from('practice_work_delegation_events').select('*').eq('company_id', cid).eq('delegation_id', delegation.id).order('created_at', { ascending: false });
        if (error) throw error;

        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/delegation/:id/events', err);
        res.status(500).json({ error: 'Failed to load delegation history.' });
    }
});

module.exports = router;

// Exported so future modules can call the exact same ownership-change
// pipeline (validate → update source → create delegation → write events →
// notify) instead of re-implementing any part of it.
module.exports.changeOwnership = changeOwnership;
module.exports.SOURCE_REGISTRY = SOURCE_REGISTRY;
