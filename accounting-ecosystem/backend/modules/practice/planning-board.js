'use strict';

// Codebox 56 — Practice Planning Board + Weekly Planning Centre
// The practice's planning and workload management centre — "who has
// capacity, who is overloaded, what can be reassigned, which deadlines are
// at risk, which clients need attention this week." NOT AI. NOT automatic
// task movement. NOT calendar sync. NOT automatic workload balancing.
//
// This module aggregates, it never owns data. All team workload/priority
// figures are computed by reusing capacity.js's buildTeamCapacity() and
// work-queue.js's buildActiveQueue() in-process — no business logic
// (utilization math, priority scoring, waiting-on-me/others rules) is
// re-implemented here. The only new persisted data is manager planning notes.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const capacity = require('./capacity');
const workQueue = require('./work-queue');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const NOTE_STATUSES = ['open', 'in_progress', 'done', 'archived'];
const EVENT_TYPES = ['board_opened', 'note_created', 'note_updated', 'note_archived', 'filter_changed', 'week_changed'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _todayStr() { return new Date().toISOString().slice(0, 10); }
function _daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }

// Normalizes any date to the Monday of its week (ISO week, Monday start).
function _mondayOf(dateStr) {
    const d = new Date((dateStr || _todayStr()) + 'T00:00:00');
    const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
}
function _addDays(dateStr, n) { return new Date(new Date(dateStr + 'T00:00:00').getTime() + n * 86400000).toISOString().slice(0, 10); }

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role').eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!member || !MANAGER_ROLES.includes(member.role)) {
        res.status(403).json({ error: 'The Planning Board is only available to owners, partners, admins, and practice managers.' });
        return null;
    }
    return member;
}

async function _writeEvent(cid, noteId, eventType, actorUserId, notes, meta) {
    await supabase.from('practice_planning_events').insert({
        company_id: cid, note_id: noteId || null, event_type: eventType,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

async function _verifyNote(id, cid) {
    const { data } = await supabase.from('practice_planning_notes').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

// ── Team-wide item pool (cached) ────────────────────────────────────────────
// Reuses work-queue.js's buildActiveQueue() once per active team member —
// the exact same 11-source aggregation + deterministic priority engine
// Codebox 55 built, never re-implemented here. A short cache means the
// board's several panels (summary/week/team/deadlines) fired together on
// page load only pay for this once.

const _poolCache = new Map(); // company_id -> { data, expiresAt }
const POOL_CACHE_TTL_MS = 20000;

async function _buildTeamItemPool(cid) {
    const cached = _poolCache.get(cid);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const { data: members, error } = await supabase.from('practice_team_members')
        .select('id, display_name, role').eq('company_id', cid).eq('is_active', true);
    if (error) { console.error('[planning-board] team members', error.message); return { members: [], items: [] }; }

    // Codebox 61 — at-risk client flag. One lightweight direct query (not a
    // call into client-success.js's calculateClientHealth() per item) —
    // same reasoning as the Skills Matrix competency badge below: a plain
    // status lookup, no scoring logic to duplicate or reuse via a function call.
    const { data: atRiskRows } = await supabase.from('practice_client_success')
        .select('client_id, relationship_status').eq('company_id', cid).in('relationship_status', ['at_risk', 'critical']);
    const atRiskClientIds = new Set((atRiskRows || []).map(r => r.client_id));

    // Codebox 62 — annual return due/overdue flag. Same lightweight direct
    // query pattern as at-risk clients above — no call into secretarial.js's
    // getCorporateProfile() per item, just a plain date filter.
    const returnWindow = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const { data: returnRows } = await supabase.from('practice_annual_returns')
        .select('client_id, due_date, status').eq('company_id', cid).in('status', ['pending', 'overdue']).lte('due_date', returnWindow);
    const returnDueClientIds = new Set((returnRows || []).map(r => r.client_id));

    // Codebox 63 — pending statutory change flag. Same lightweight direct
    // query pattern — a case awaiting review/implementation is a plain
    // status lookup, not a call into secretarial-workflows.js's engine.
    const { data: pendingChangeRows } = await supabase.from('practice_secretarial_change_cases')
        .select('client_id, case_status').eq('company_id', cid).in('case_status', ['ready_for_review', 'approved']);
    const pendingChangeClientIds = new Set((pendingChangeRows || []).map(r => r.client_id));

    // Codebox 65 — BO readiness concern flag. Scoped to 'blocked' readiness
    // items only (a plain status filter) rather than replicating the full
    // ready/partial/incomplete score calculation from beneficial-ownership.js
    // for every client on every board load — this is the spec's "Optional"
    // integration, kept intentionally lightweight per session convention.
    const { data: blockedBoRows } = await supabase.from('practice_bo_readiness_items')
        .select('client_id, status, required').eq('company_id', cid).eq('status', 'blocked').eq('required', true);
    const boConcernClientIds = new Set((blockedBoRows || []).map(r => r.client_id));

    // Codebox 67 — statutory workload flags. Same deliberately lightweight
    // approach as Codebox 65's BO badge above — plain date/status filters,
    // not a call into secretarial-calendar.js's buildStatutoryCalendar()
    // (which does per-item dependency resolution) for every client on every
    // board load. "Upcoming" here means due within 30 days; "blocked" is
    // approximated as a pending schedule item with a non-overridden
    // dependency due within 30 days — the exact category still requires a
    // visit to /practice/secretarial-calendar.html for the authoritative view.
    const statutoryWindow = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { data: upcomingStatutoryRows } = await supabase.from('practice_statutory_schedule')
        .select('id, client_id, due_date, status').eq('company_id', cid).eq('status', 'pending').lte('due_date', statutoryWindow);
    const statutoryWorkloadClientIds = new Set((upcomingStatutoryRows || []).map(r => r.client_id));

    const upcomingScheduleIds = new Set((upcomingStatutoryRows || []).map(r => r.id));
    let statutoryBlockedClientIds = new Set();
    if (upcomingStatutoryRows && upcomingStatutoryRows.length) {
        const { data: depRows } = await supabase.from('practice_statutory_dependencies')
            .select('client_id, schedule_id, manager_override').eq('company_id', cid).eq('manager_override', false);
        statutoryBlockedClientIds = new Set((depRows || []).filter(d => upcomingScheduleIds.has(d.schedule_id)).map(d => d.client_id));
    }

    // Codebox 66 — evidence-blocked flag. Same lightweight direct query
    // pattern — a plain status filter on required items, not a call into
    // secretarial-evidence.js's checklist readiness computation per client.
    const { data: blockedEvidenceRows } = await supabase.from('practice_secretarial_evidence_items')
        .select('checklist_id, status, required').eq('company_id', cid).eq('status', 'blocked').eq('required', true);
    let evidenceBlockedClientIds = new Set();
    if (blockedEvidenceRows && blockedEvidenceRows.length) {
        const checklistIds = [...new Set(blockedEvidenceRows.map(r => r.checklist_id))];
        const { data: checklistRows } = await supabase.from('practice_secretarial_evidence_checklists').select('id, client_id').in('id', checklistIds).eq('company_id', cid);
        evidenceBlockedClientIds = new Set((checklistRows || []).map(c => c.client_id));
    }

    // Codebox 68 — lifecycle transition pending/blocked flag. Same
    // deliberately lightweight direct-query pattern as every badge above —
    // a plain status filter, not a call into entity-lifecycle.js's
    // getEntityLifecycleProfile() (which composes 4 other modules) per
    // client on every board load. "Pending" = awaiting manager review or
    // implementation (ready_for_review/approved); the authoritative detail
    // still lives on /practice/entity-lifecycle.html.
    const { data: pendingLifecycleRows } = await supabase.from('practice_entity_lifecycle_transitions')
        .select('client_id, transition_status').eq('company_id', cid).in('transition_status', ['ready_for_review', 'approved']);
    const lifecycleTransitionPendingClientIds = new Set((pendingLifecycleRows || []).map(r => r.client_id));

    const perMember = await Promise.all((members || []).map(async m => {
        const items = await workQueue.buildActiveQueue(cid, m.id);
        return items.map(item => Object.assign({}, item, {
            team_member_id: m.id, team_member_name: m.display_name,
            at_risk_client: !!(item.client_id && atRiskClientIds.has(item.client_id)),
            annual_return_due: !!(item.client_id && returnDueClientIds.has(item.client_id)),
            pending_statutory_change: !!(item.client_id && pendingChangeClientIds.has(item.client_id)),
            evidence_blocked: !!(item.client_id && evidenceBlockedClientIds.has(item.client_id)),
            statutory_workload_upcoming: !!(item.client_id && statutoryWorkloadClientIds.has(item.client_id)),
            statutory_workload_blocked: !!(item.client_id && statutoryBlockedClientIds.has(item.client_id)),
            bo_readiness_concern: !!(item.client_id && boConcernClientIds.has(item.client_id)),
            lifecycle_transition_pending: !!(item.client_id && lifecycleTransitionPendingClientIds.has(item.client_id)),
        }));
    }));

    const result = { members: members || [], items: perMember.flat() };
    _poolCache.set(cid, { data: result, expiresAt: Date.now() + POOL_CACHE_TTL_MS });
    return result;
}

// Codebox 58 (Work Delegation) calls this after any ownership change —
// Planning Board and Resource Forecast (which reuses this same pool) both
// read through it, so clearing it here is what makes a delegation
// "immediately affect" both pages without a second cache layer.
function _invalidatePoolCache(cid) {
    _poolCache.delete(cid);
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.week_start);
        const weekEnd = _addDays(weekStart, 6);
        const today = _todayStr();

        const [pool, teamCapacity, notesCount, unreadNotifCount] = await Promise.all([
            _buildTeamItemPool(cid),
            capacity.buildTeamCapacity(cid),
            supabase.from('practice_planning_notes').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('week_start', weekStart).neq('status', 'archived'),
            supabase.from('practice_notifications').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('notification_status', 'new'),
        ]);

        const items = pool.items;
        const overdue = items.filter(i => i.due_date && i.due_date < today);
        const dueThisWeek = items.filter(i => i.due_date && i.due_date >= weekStart && i.due_date <= weekEnd);
        const waitingForReview = items.filter(i => i.waiting_on === 'me');
        const critical = items.filter(i => i.priority_label === 'critical' || i.blocked);
        const upcomingDeadlines = items.filter(i => i.source_module === 'deadlines' && i.due_date && i.due_date >= today && i.due_date <= _daysFromNow(14));

        res.json({
            week_start: weekStart, week_end: weekEnd,
            team_member_count: pool.members.length,
            overloaded_count: teamCapacity.filter(m => m.capacity_status === 'overloaded').length,
            underutilized_count: teamCapacity.filter(m => m.capacity_status === 'underutilized').length,
            total_overdue: overdue.length,
            total_due_this_week: dueThisWeek.length,
            total_waiting_for_review: waitingForReview.length,
            total_critical: critical.length,
            upcoming_deadlines_count: upcomingDeadlines.length,
            notifications_unread_count: unreadNotifCount.count || 0,
            planning_notes_count: notesCount.count || 0,
        });
    } catch (err) {
        console.error('GET /api/practice/planning-board/summary', err);
        res.status(500).json({ error: 'Failed to load planning summary.' });
    }
});

// ── GET /week ─────────────────────────────────────────────────────────────────

router.get('/week', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.week_start);
        const weekEnd = _addDays(weekStart, 6);
        const nextWeekStart = _addDays(weekStart, 7);
        const nextWeekEnd = _addDays(weekStart, 13);
        const today = _todayStr();

        const [pool, notesRes] = await Promise.all([
            _buildTeamItemPool(cid),
            supabase.from('practice_planning_notes').select('*').eq('company_id', cid).eq('week_start', weekStart).neq('status', 'archived').order('created_at', { ascending: true }),
        ]);
        const items = pool.items;

        const byDueRange = (from, to) => items.filter(i => i.due_date && i.due_date >= from && i.due_date <= to).sort((a, b) => a.due_date.localeCompare(b.due_date));

        res.json({
            week_start: weekStart, week_end: weekEnd,
            next_week_start: nextWeekStart, next_week_end: nextWeekEnd,
            this_week: { count: byDueRange(weekStart, weekEnd).length, items: byDueRange(weekStart, weekEnd) },
            next_week: { count: byDueRange(nextWeekStart, nextWeekEnd).length, items: byDueRange(nextWeekStart, nextWeekEnd) },
            overdue: { count: items.filter(i => i.due_date && i.due_date < today).length, items: items.filter(i => i.due_date && i.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date)) },
            high_risk: { count: items.filter(i => i.priority_label === 'critical' || i.blocked).length, items: items.filter(i => i.priority_label === 'critical' || i.blocked).sort((a, b) => b.priority_score - a.priority_score) },
            upcoming_deadlines: { count: items.filter(i => i.source_module === 'deadlines' && i.due_date >= today).length, items: items.filter(i => i.source_module === 'deadlines' && i.due_date >= today).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 20) },
            waiting_for_review: { count: items.filter(i => i.waiting_on === 'me').length, items: items.filter(i => i.waiting_on === 'me').sort((a, b) => b.priority_score - a.priority_score) },
            manager_notes: notesRes.data || [],
        });
    } catch (err) {
        console.error('GET /api/practice/planning-board/week', err);
        res.status(500).json({ error: 'Failed to load week view.' });
    }
});

// ── GET /team ─────────────────────────────────────────────────────────────────
// One card per team member: workload, capacity, overdue/due-this-week/
// critical counts, planning-note count, and one-click deep links.

router.get('/team', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.week_start);
        const weekEnd = _addDays(weekStart, 6);
        const today = _todayStr();

        const [pool, teamCapacity, notesRes, skillRows] = await Promise.all([
            _buildTeamItemPool(cid),
            capacity.buildTeamCapacity(cid),
            supabase.from('practice_planning_notes').select('team_member_id').eq('company_id', cid).eq('week_start', weekStart).neq('status', 'archived').not('team_member_id', 'is', null),
            // Codebox 59 (Skills Matrix) — optional badges only. One
            // lightweight direct query for the whole team rather than N
            // calls into getCompetency() (which does 3 queries per person);
            // this only needs a MAX(level) and a gap flag, not the full
            // advisory shape that helper returns.
            supabase.from('practice_team_skills').select('team_member_id, current_level, target_level').eq('company_id', cid),
        ]);

        const notesByMember = {};
        (notesRes.data || []).forEach(n => { notesByMember[n.team_member_id] = (notesByMember[n.team_member_id] || 0) + 1; });

        const capacityByMember = {};
        teamCapacity.forEach(c => { capacityByMember[c.member_id] = c; });

        const skillBadgeByMember = {};
        (skillRows.data || []).forEach(r => {
            const b = skillBadgeByMember[r.team_member_id] || { maxLevel: 0, hasGap: false };
            if (r.current_level > b.maxLevel) b.maxLevel = r.current_level;
            if (r.target_level != null && r.target_level > r.current_level) b.hasGap = true;
            skillBadgeByMember[r.team_member_id] = b;
        });
        function competencyBadge(memberId) {
            const b = skillBadgeByMember[memberId];
            if (!b) return null;
            if (b.maxLevel >= 5) return 'expert';
            if (b.maxLevel >= 4) return 'advanced';
            if (b.hasGap) return 'training_needed';
            return null;
        }

        const board = pool.members.map(m => {
            const memberItems = pool.items.filter(i => i.team_member_id === m.id);
            const cap = capacityByMember[m.id] || {};
            return {
                team_member_id: m.id, display_name: m.display_name, role: m.role,
                weekly_capacity_hours: cap.weekly_capacity_hours ?? null,
                estimated_task_hours: cap.estimated_task_hours ?? null,
                utilization_percentage: cap.utilization_percentage ?? null,
                capacity_status: cap.capacity_status || 'unknown',
                workload_count: memberItems.length,
                overdue_count: memberItems.filter(i => i.due_date && i.due_date < today).length,
                due_this_week_count: memberItems.filter(i => i.due_date && i.due_date >= weekStart && i.due_date <= weekEnd).length,
                critical_count: memberItems.filter(i => i.priority_label === 'critical' || i.blocked).length,
                waiting_for_review_count: memberItems.filter(i => i.waiting_on === 'me').length,
                planning_notes_count: notesByMember[m.id] || 0,
                competency_badge: competencyBadge(m.id),
                work_queue_link: '/practice/work-queue.html?team_member_id=' + m.id,
                capacity_link: '/practice/capacity.html?member_id=' + m.id,
            };
        }).sort((a, b) => {
            const order = { overloaded: 0, high: 1, normal: 2, underutilized: 3, unknown: 4 };
            return (order[a.capacity_status] ?? 5) - (order[b.capacity_status] ?? 5) || b.critical_count - a.critical_count;
        });

        res.json({ week_start: weekStart, week_end: weekEnd, team: board });
    } catch (err) {
        console.error('GET /api/practice/planning-board/team', err);
        res.status(500).json({ error: 'Failed to load team board.' });
    }
});

// ── GET /deadlines ────────────────────────────────────────────────────────────
// Practice-wide deadline timeline — intentionally NOT derived from the
// per-member item pool (which only ever covers assigned/active items).
// Deadlines without a responsible team member are invisible to any personal
// queue but must still be visible to a manager planning the week, so this
// queries practice_deadlines directly.

router.get('/deadlines', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
        const from = _daysFromNow(-30); // include recent overdue too, not just future
        const to = _daysFromNow(days);

        const { data, error } = await supabase.from('practice_deadlines')
            .select('id, title, due_date, status, priority, compliance_area, deadline_type, responsible_team_member_id, client_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
            .eq('company_id', cid)
            .not('status', 'in', '("completed","submitted","missed","cancelled")')
            .gte('due_date', from).lte('due_date', to)
            .order('due_date', { ascending: true });
        if (error) throw error;

        const today = _todayStr();
        const deadlines = (data || []).map(d => ({
            id: d.id, title: d.title, due_date: d.due_date, status: d.status, priority: d.priority,
            compliance_area: d.compliance_area, deadline_type: d.deadline_type,
            client_name: d.practice_clients?.name || null,
            responsible_team_member_id: d.responsible_team_member_id,
            responsible_team_member_name: d.practice_team_members?.display_name || null,
            is_overdue: d.due_date < today,
            deep_link: '/practice/deadlines.html?open=' + d.id,
        }));

        res.json({ deadlines, total: deadlines.length, overdue_count: deadlines.filter(d => d.is_overdue).length });
    } catch (err) {
        console.error('GET /api/practice/planning-board/deadlines', err);
        res.status(500).json({ error: 'Failed to load deadline timeline.' });
    }
});

// ── GET /capacity ─────────────────────────────────────────────────────────────
// Thin re-exposure of capacity.js's own aggregator through the board's base
// URL — not a reimplementation.

router.get('/capacity', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const team = await capacity.buildTeamCapacity(cid);
        res.json({ team });
    } catch (err) {
        console.error('GET /api/practice/planning-board/capacity', err);
        res.status(500).json({ error: 'Failed to load capacity overview.' });
    }
});

// ── Planning Notes ────────────────────────────────────────────────────────────

router.get('/planning-notes', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.week_start);
        let q = supabase.from('practice_planning_notes').select('*').eq('company_id', cid).eq('week_start', weekStart);
        if (req.query.team_member_id) q = q.eq('team_member_id', parseInt(req.query.team_member_id, 10));
        if (req.query.client_id) q = q.eq('client_id', parseInt(req.query.client_id, 10));
        if (req.query.include_archived !== 'true') q = q.neq('status', 'archived');
        const { data, error } = await q.order('created_at', { ascending: true });
        if (error) throw error;

        res.json({ notes: data || [], week_start: weekStart });
    } catch (err) {
        console.error('GET /api/practice/planning-board/planning-notes', err);
        res.status(500).json({ error: 'Failed to load planning notes.' });
    }
});

router.post('/planning-notes', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const body = req.body || {};
        if (!body.title) return res.status(422).json({ error: 'title is required.' });
        if (body.status && !NOTE_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${NOTE_STATUSES.join(', ')}.` });

        const insertRow = {
            company_id: cid,
            week_start: _mondayOf(body.week_start),
            team_member_id: body.team_member_id ? parseInt(body.team_member_id, 10) : null,
            client_id: body.client_id ? parseInt(body.client_id, 10) : null,
            title: body.title,
            notes: body.notes || null,
            status: body.status || 'open',
            metadata: body.metadata || {},
            created_by: req.user?.userId || null,
        };

        const { data, error } = await supabase.from('practice_planning_notes').insert(insertRow).select().single();
        if (error) throw error;

        await _writeEvent(cid, data.id, 'note_created', req.user?.userId);
        res.status(201).json({ note: data });
    } catch (err) {
        console.error('POST /api/practice/planning-board/planning-notes', err);
        res.status(500).json({ error: 'Failed to create planning note.' });
    }
});

router.put('/planning-notes/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const note = await _verifyNote(req.params.id, cid);
        if (!note) return res.status(404).json({ error: 'Planning note not found.' });

        const body = req.body || {};
        if (body.status && !NOTE_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${NOTE_STATUSES.join(', ')}.` });

        const patch = {
            title: body.title !== undefined ? body.title : note.title,
            notes: body.notes !== undefined ? body.notes : note.notes,
            status: body.status || note.status,
            team_member_id: body.team_member_id !== undefined ? (body.team_member_id ? parseInt(body.team_member_id, 10) : null) : note.team_member_id,
            client_id: body.client_id !== undefined ? (body.client_id ? parseInt(body.client_id, 10) : null) : note.client_id,
            metadata: body.metadata !== undefined ? body.metadata : note.metadata,
        };

        const { data, error } = await supabase.from('practice_planning_notes').update(patch).eq('id', note.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, note.id, 'note_updated', req.user?.userId);
        res.json({ note: data });
    } catch (err) {
        console.error('PUT /api/practice/planning-board/planning-notes/:id', err);
        res.status(500).json({ error: 'Failed to update planning note.' });
    }
});

router.delete('/planning-notes/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const note = await _verifyNote(req.params.id, cid);
        if (!note) return res.status(404).json({ error: 'Planning note not found.' });

        const { data, error } = await supabase.from('practice_planning_notes').update({ status: 'archived' }).eq('id', note.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, note.id, 'note_archived', req.user?.userId);
        res.json({ note: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/planning-board/planning-notes/:id', err);
        res.status(500).json({ error: 'Failed to archive planning note.' });
    }
});

// ── Events ────────────────────────────────────────────────────────────────────

router.post('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const body = req.body || {};
        if (!EVENT_TYPES.includes(body.event_type)) return res.status(422).json({ error: `event_type must be one of ${EVENT_TYPES.join(', ')}.` });

        await _writeEvent(cid, body.note_id || null, body.event_type, req.user?.userId, body.notes || null, body.metadata || {});
        res.status(201).json({ logged: true });
    } catch (err) {
        console.error('POST /api/practice/planning-board/events', err);
        res.status(500).json({ error: 'Failed to log event.' });
    }
});

router.get('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        let q = supabase.from('practice_planning_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(100);
        if (req.query.note_id) q = q.eq('note_id', parseInt(req.query.note_id, 10));
        const { data, error } = await q;
        if (error) throw error;

        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/planning-board/events', err);
        res.status(500).json({ error: 'Failed to load planning board history.' });
    }
});

module.exports = router;

// Codebox 57 (Resource Forecasting) reuses this directly — attached to the
// exported router function object so `require('./planning-board').buildTeamItemPool(cid)`
// works in-process without a second HTTP round-trip and without a third
// re-implementation of "loop over active team members calling
// work-queue.js's buildActiveQueue()". Same reuse chain as capacity.js →
// planning-board.js and work-queue.js → planning-board.js.
module.exports.buildTeamItemPool = _buildTeamItemPool;
module.exports.invalidatePoolCache = _invalidatePoolCache;
