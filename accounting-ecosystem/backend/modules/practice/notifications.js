'use strict';

// Codebox 54 — Practice Notification Centre + Internal Notification Routing
// A central, assigned, actionable inbox. NOT email. NOT SMS. NOT push. NOT
// Teams. NOT Sean AI. Internal to Practice Management only.
//
// Other modules call the exported notify() helper in-process instead of
// inserting into practice_notifications directly — this keeps routing,
// deduplication, and assignment-fallback logic in exactly one place. No
// module calls it automatically yet (see docs — Codebox 54 ships the helper
// only; automatic conversion of alerts into notifications is a future step).

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = [
    'risk', 'tax', 'billing', 'workflow', 'capacity', 'client',
    'documents', 'compliance', 'qms', 'knowledge', 'sop', 'communication', 'system',
];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['new', 'read', 'snoozed', 'completed', 'archived', 'cancelled'];
const TERMINAL_STATUSES = ['completed', 'archived', 'cancelled'];

const CLIENT_ROLE_FIELD = {
    owner: 'responsible_team_member_id',
    reviewer: 'reviewer_team_member_id',
    partner: 'partner_team_member_id',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyNotification(id, cid) {
    const { data } = await supabase.from('practice_notifications').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, notificationId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_notification_events').insert({
        company_id: cid,
        notification_id: notificationId,
        event_type: eventType,
        old_status: oldStatus || null,
        new_status: newStatus || null,
        actor_user_id: actorUserId || null,
        notes: notes || null,
        metadata: meta || {},
    });
}

// Resolves the current HTTP caller's own practice_team_members.id (if any),
// used for the "Assigned To Me" filter and the notification-bell count.
async function _myTeamMemberId(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id').eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data ? data.id : null;
}

// ── Routing — the documented assignment-resolution rule ────────────────────────
// 1. Explicit team member id (manual assignment) — used if it belongs to this
//    company and is active.
// 2. Role-based via a client's owner/reviewer/partner field (assignment =
//    { role: 'owner'|'reviewer'|'partner', clientId }) — used only if that
//    specific field is set on the client AND the referenced member is active.
//    A client missing that field does NOT fall back to a different client
//    role — it falls straight through to step 3, so "reviewer" never
//    silently becomes "owner".
// 3. Practice Admin fallback — first active team member found, trying role
//    'admin', then 'owner', then 'partner' in that order, ordered by id
//    ascending (oldest team member first) for determinism.
// 4. No team members exist at all — the notification is created unassigned
//    (assigned_team_member_id = null). This is intentionally rare and is
//    surfaced as a follow-up risk in the session handoff.
async function _resolveAssignment(cid, assignment) {
    assignment = assignment || {};

    if (assignment.teamMemberId) {
        const { data } = await supabase.from('practice_team_members').select('id')
            .eq('id', assignment.teamMemberId).eq('company_id', cid).eq('is_active', true).maybeSingle();
        if (data) return { teamMemberId: data.id, method: 'explicit' };
    }

    if (assignment.role && CLIENT_ROLE_FIELD[assignment.role] && assignment.clientId) {
        const field = CLIENT_ROLE_FIELD[assignment.role];
        const { data: client } = await supabase.from('practice_clients').select(field)
            .eq('id', assignment.clientId).eq('company_id', cid).maybeSingle();
        const memberId = client ? client[field] : null;
        if (memberId) {
            const { data: member } = await supabase.from('practice_team_members').select('id')
                .eq('id', memberId).eq('company_id', cid).eq('is_active', true).maybeSingle();
            if (member) return { teamMemberId: member.id, method: 'role:' + assignment.role };
        }
    }

    for (const role of ['admin', 'owner', 'partner']) {
        const { data } = await supabase.from('practice_team_members').select('id')
            .eq('company_id', cid).eq('role', role).eq('is_active', true)
            .order('id', { ascending: true }).limit(1).maybeSingle();
        if (data) return { teamMemberId: data.id, method: 'fallback:' + role };
    }

    return { teamMemberId: null, method: 'unassigned' };
}

// ── notify() — the reusable helper future modules call ─────────────────────────
// Deduplicates (via notificationKey + resolved assignee), resolves the
// assignee (see _resolveAssignment above), stores the created event, and
// returns the notification id. Never silently drops a notification — if
// nothing can be resolved, it's created unassigned rather than discarded.
async function notify(params) {
    const {
        cid, notificationKey, title, message, category, severity,
        sourceModule, sourceType, sourceId, dueDate, metadata, createdBy, assignment,
    } = params || {};

    if (!cid) throw new Error('notify(): cid is required.');
    if (!title) throw new Error('notify(): title is required.');
    if (!CATEGORIES.includes(category)) throw new Error(`notify(): invalid category "${category}". Must be one of ${CATEGORIES.join(', ')}.`);
    if (!SEVERITIES.includes(severity)) throw new Error(`notify(): invalid severity "${severity}". Must be one of ${SEVERITIES.join(', ')}.`);

    const resolved = await _resolveAssignment(cid, assignment);

    if (notificationKey) {
        const existing = await _findActiveByKey(cid, notificationKey, resolved.teamMemberId);
        if (existing) return { notificationId: existing.id, created: false, deduped: true, resolution_method: resolved.method };
    }

    const insertRow = {
        company_id: cid,
        notification_key: notificationKey || null,
        title,
        message: message || null,
        category,
        severity,
        source_module: sourceModule || null,
        source_type: sourceType || null,
        source_id: sourceId || null,
        assigned_team_member_id: resolved.teamMemberId,
        created_by: createdBy || null,
        notification_status: 'new',
        due_date: dueDate || null,
        metadata: Object.assign({}, metadata || {}, { assignment_method: resolved.method }),
    };

    const { data: created, error } = await supabase.from('practice_notifications').insert(insertRow).select().single();
    if (error) {
        if (error.code === '23505' && notificationKey) {
            // Race: another concurrent notify() call for the same (key, assignee) won between our dedup check and insert.
            const existing = await _findActiveByKey(cid, notificationKey, resolved.teamMemberId);
            if (existing) return { notificationId: existing.id, created: false, deduped: true, resolution_method: resolved.method };
        }
        throw error;
    }

    await _writeEvent(cid, created.id, 'notification_created', null, 'new', createdBy, `Created by ${sourceModule || 'manual'}.`, { resolution_method: resolved.method });

    return { notificationId: created.id, created: true, deduped: false, resolution_method: resolved.method };
}

async function _findActiveByKey(cid, notificationKey, teamMemberId) {
    let q = supabase.from('practice_notifications').select('id')
        .eq('company_id', cid).eq('notification_key', notificationKey)
        .not('notification_status', 'in', '("completed","archived","cancelled")');
    q = teamMemberId != null ? q.eq('assigned_team_member_id', teamMemberId) : q.is('assigned_team_member_id', null);
    const { data } = await q.maybeSingle();
    return data || null;
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const today = new Date().toISOString().slice(0, 10);
        const myId = await _myTeamMemberId(cid, req.user?.userId);

        const { data, error } = await supabase.from('practice_notifications')
            .select('notification_status, severity, category, assigned_team_member_id, due_date')
            .eq('company_id', cid);
        if (error) throw error;
        const rows = data || [];

        const byStatus = { new: 0, read: 0, snoozed: 0, completed: 0, archived: 0, cancelled: 0 };
        const bySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
        const byCategory = {};
        let dueToday = 0, overdue = 0, assignedToMe = 0;

        rows.forEach(r => {
            if (byStatus[r.notification_status] != null) byStatus[r.notification_status]++;
            if (bySeverity[r.severity] != null) bySeverity[r.severity]++;
            byCategory[r.category] = (byCategory[r.category] || 0) + 1;
            const active = !TERMINAL_STATUSES.includes(r.notification_status);
            if (active && r.due_date === today) dueToday++;
            if (active && r.due_date && r.due_date < today) overdue++;
            if (active && myId != null && r.assigned_team_member_id === myId) assignedToMe++;
        });

        res.json({
            total: rows.length,
            unread_count: byStatus.new,
            by_status: byStatus,
            by_severity: bySeverity,
            by_category: byCategory,
            due_today_count: dueToday,
            overdue_count: overdue,
            assigned_to_me_count: assignedToMe,
            my_team_member_id: myId,
        });
    } catch (err) {
        console.error('GET /api/practice/notifications/summary', err);
        res.status(500).json({ error: 'Failed to load notification summary.' });
    }
});

// ── GET / (inbox list) ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const cid = req.companyId;
        const today = new Date().toISOString().slice(0, 10);
        const {
            status, category, severity, assigned_team_member_id,
            assigned_to_me, unread, due_today, overdue, search,
        } = req.query;

        const page = Math.max(1, parseInt(req.query.page || 1, 10));
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50, 10)));
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let q = supabase.from('practice_notifications').select('*', { count: 'exact' })
            .eq('company_id', cid)
            .order('created_at', { ascending: false })
            .range(from, to);

        if (status) q = q.eq('notification_status', status);
        if (category) q = q.eq('category', category);
        if (severity) q = q.eq('severity', severity);
        if (unread === 'true') q = q.eq('notification_status', 'new');
        if (due_today === 'true') q = q.eq('due_date', today);
        if (overdue === 'true') q = q.lt('due_date', today).not('notification_status', 'in', '("completed","archived","cancelled")');

        if (assigned_to_me === 'true') {
            const myId = await _myTeamMemberId(cid, req.user?.userId);
            q = myId != null ? q.eq('assigned_team_member_id', myId) : q.eq('id', -1); // no team member linked — no results, not an error
        } else if (assigned_team_member_id) {
            q = q.eq('assigned_team_member_id', parseInt(assigned_team_member_id, 10));
        }

        const { data, error, count } = await q;
        if (error) throw error;

        let rows = data || [];
        if (search) {
            const s = String(search).toLowerCase();
            rows = rows.filter(n => `${n.title} ${n.message || ''}`.toLowerCase().includes(s));
        }

        // Enrich with assignee display name (small table, cheap to fetch).
        const memberIds = [...new Set(rows.map(n => n.assigned_team_member_id).filter(Boolean))];
        let membersById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds);
            (members || []).forEach(m => { membersById[m.id] = m.display_name; });
        }
        rows = rows.map(n => ({ ...n, assigned_team_member_name: n.assigned_team_member_id ? (membersById[n.assigned_team_member_id] || null) : null }));

        res.json({ notifications: rows, total: search ? rows.length : (count || 0) });
    } catch (err) {
        console.error('GET /api/practice/notifications', err);
        res.status(500).json({ error: 'Failed to load notifications.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const notification = await _verifyNotification(req.params.id, req.companyId);
        if (!notification) return res.status(404).json({ error: 'Notification not found.' });
        res.json({ notification });
    } catch (err) {
        console.error('GET /api/practice/notifications/:id', err);
        res.status(500).json({ error: 'Failed to load notification.' });
    }
});

// ── POST / (manual creation — routes through the same notify() core) ──────────

router.post('/', async (req, res) => {
    try {
        const cid = req.companyId;
        const body = req.body || {};
        if (!body.title) return res.status(422).json({ error: 'title is required.' });
        if (!CATEGORIES.includes(body.category)) return res.status(422).json({ error: `Invalid category. Must be one of ${CATEGORIES.join(', ')}.` });
        if (!SEVERITIES.includes(body.severity)) return res.status(422).json({ error: `Invalid severity. Must be one of ${SEVERITIES.join(', ')}.` });

        let assignment = {};
        if (body.assigned_team_member_id) assignment = { teamMemberId: parseInt(body.assigned_team_member_id, 10) };
        else if (body.assignment_role && body.client_id) assignment = { role: body.assignment_role, clientId: parseInt(body.client_id, 10) };

        const result = await notify({
            cid,
            notificationKey: body.notification_key || null,
            title: body.title,
            message: body.message || null,
            category: body.category,
            severity: body.severity,
            sourceModule: body.source_module || 'manual',
            sourceType: body.source_type || null,
            sourceId: body.source_id ? parseInt(body.source_id, 10) : null,
            dueDate: body.due_date || null,
            metadata: body.metadata || {},
            createdBy: req.user?.userId || null,
            assignment,
        });

        const notification = await _verifyNotification(result.notificationId, cid);
        res.status(result.created ? 201 : 200).json({ notification, created: result.created, deduped: result.deduped });
    } catch (err) {
        console.error('POST /api/practice/notifications', err);
        res.status(500).json({ error: 'Failed to create notification.' });
    }
});

// ── Status transitions ───────────────────────────────────────────────────────

router.put('/:id/read', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (TERMINAL_STATUSES.includes(n.notification_status)) return res.status(422).json({ error: 'This notification is already terminal.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'read', read_at: new Date().toISOString() })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_read', n.notification_status, 'read', req.user?.userId);
        res.json({ notification: updated });
    } catch (err) {
        console.error('PUT /api/practice/notifications/:id/read', err);
        res.status(500).json({ error: 'Failed to mark notification as read.' });
    }
});

router.put('/:id/unread', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (n.notification_status !== 'read') return res.status(422).json({ error: 'Only read notifications can be marked unread.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'new', read_at: null })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_unread', n.notification_status, 'new', req.user?.userId);
        res.json({ notification: updated });
    } catch (err) {
        console.error('PUT /api/practice/notifications/:id/unread', err);
        res.status(500).json({ error: 'Failed to mark notification as unread.' });
    }
});

router.put('/:id/snooze', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (TERMINAL_STATUSES.includes(n.notification_status)) return res.status(422).json({ error: 'This notification is already terminal.' });

        const snoozedUntil = req.body?.snoozed_until;
        if (!snoozedUntil || isNaN(Date.parse(snoozedUntil))) return res.status(422).json({ error: 'snoozed_until is required and must be a valid date/time.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'snoozed', snoozed_until: snoozedUntil })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_snoozed', n.notification_status, 'snoozed', req.user?.userId, null, { snoozed_until: snoozedUntil });
        res.json({ notification: updated });
    } catch (err) {
        console.error('PUT /api/practice/notifications/:id/snooze', err);
        res.status(500).json({ error: 'Failed to snooze notification.' });
    }
});

router.put('/:id/archive', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (['archived', 'cancelled'].includes(n.notification_status)) return res.status(422).json({ error: 'This notification is already terminal.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'archived', archived_at: new Date().toISOString() })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_archived', n.notification_status, 'archived', req.user?.userId);
        res.json({ notification: updated });
    } catch (err) {
        console.error('PUT /api/practice/notifications/:id/archive', err);
        res.status(500).json({ error: 'Failed to archive notification.' });
    }
});

router.put('/:id/complete', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (TERMINAL_STATUSES.includes(n.notification_status)) return res.status(422).json({ error: 'This notification is already terminal.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_completed', n.notification_status, 'completed', req.user?.userId);
        res.json({ notification: updated });
    } catch (err) {
        console.error('PUT /api/practice/notifications/:id/complete', err);
        res.status(500).json({ error: 'Failed to complete notification.' });
    }
});

// ── DELETE /:id (cancel only — never a hard delete) ────────────────────────────

router.delete('/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        if (TERMINAL_STATUSES.includes(n.notification_status)) return res.status(422).json({ error: 'This notification is already terminal.' });

        const { data: updated, error } = await supabase.from('practice_notifications')
            .update({ notification_status: 'cancelled', cancelled_at: new Date().toISOString() })
            .eq('id', n.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, n.id, 'notification_cancelled', n.notification_status, 'cancelled', req.user?.userId);
        res.json({ notification: updated, cancelled: true });
    } catch (err) {
        console.error('DELETE /api/practice/notifications/:id', err);
        res.status(500).json({ error: 'Failed to cancel notification.' });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const n = await _verifyNotification(req.params.id, cid);
        if (!n) return res.status(404).json({ error: 'Notification not found.' });
        const { data, error } = await supabase.from('practice_notification_events').select('*').eq('company_id', cid).eq('notification_id', n.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/notifications/:id/events', err);
        res.status(500).json({ error: 'Failed to load notification history.' });
    }
});

// ── Bulk actions ──────────────────────────────────────────────────────────────
// Each bulk action re-verifies ownership and current status per id — a
// mixed batch (some already terminal, some belonging to another company via
// a tampered request) partially succeeds rather than failing the whole
// batch, and the response reports exactly what happened to each id.

async function _bulkTransition(req, res, { toStatus, eventType, timestampField, blockedStatuses }) {
    try {
        const cid = req.companyId;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
        if (!ids.length) return res.status(422).json({ error: 'Request body must include a non-empty "ids" array.' });

        const results = { updated: [], skipped: [] };
        for (const id of ids) {
            const n = await _verifyNotification(id, cid);
            if (!n) { results.skipped.push({ id, reason: 'not_found' }); continue; }
            if (blockedStatuses.includes(n.notification_status)) { results.skipped.push({ id, reason: 'already_terminal' }); continue; }

            const patch = { notification_status: toStatus };
            if (timestampField) patch[timestampField] = new Date().toISOString();
            const { data: updated, error } = await supabase.from('practice_notifications').update(patch).eq('id', id).eq('company_id', cid).select().single();
            if (error) { results.skipped.push({ id, reason: 'update_failed' }); continue; }

            await _writeEvent(cid, id, eventType, n.notification_status, toStatus, req.user?.userId, null, { bulk: true });
            results.updated.push(updated);
        }
        res.json(results);
    } catch (err) {
        console.error('POST /api/practice/notifications/bulk-*', err);
        res.status(500).json({ error: 'Bulk action failed.' });
    }
}

router.post('/bulk-read', (req, res) => _bulkTransition(req, res, {
    toStatus: 'read', eventType: 'notification_read', timestampField: 'read_at', blockedStatuses: TERMINAL_STATUSES,
}));
router.post('/bulk-archive', (req, res) => _bulkTransition(req, res, {
    toStatus: 'archived', eventType: 'notification_archived', timestampField: 'archived_at', blockedStatuses: ['archived', 'cancelled'],
}));
router.post('/bulk-complete', (req, res) => _bulkTransition(req, res, {
    toStatus: 'completed', eventType: 'notification_completed', timestampField: 'completed_at', blockedStatuses: TERMINAL_STATUSES,
}));

module.exports = router;

// Reusable helper other modules call in-process — see docs/new-app/54_notification_centre.md
// for the routing/dedup rules. Not called automatically by any module yet.
module.exports.notify = notify;
module.exports.CATEGORIES = CATEGORIES;
module.exports.SEVERITIES = SEVERITIES;
