/* =============================================================
   Practice Reminder Center  (Codebox 21)
   In-app reminders only. No email/SMS/push. No cron.
   Mounted at /api/practice/reminders
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const REMINDER_TYPES = [
    'deadline_due', 'deadline_overdue', 'review_waiting', 'approval_waiting',
    'billing_waiting', 'health_action', 'period_waiting', 'engagement_setup',
    'capacity_warning', 'general',
];

const SOURCE_TYPES = [
    'deadline', 'task', 'billing_pack', 'health_action',
    'engagement_period', 'engagement', 'team_member', 'client', 'system',
];

const SEVERITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES   = ['open', 'snoozed', 'completed', 'dismissed', 'cancelled'];

// Maps source_type → Supabase table name for ownership verification
const SOURCE_TABLE = {
    deadline:          'practice_deadlines',
    task:              'practice_tasks',
    billing_pack:      'practice_billing_packs',
    health_action:     'practice_client_health_actions',
    engagement_period: 'practice_engagement_periods',
    engagement:        'practice_client_engagements',
    team_member:       'practice_team_members',
    client:            'practice_clients',
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function addDaysStr(n) {
    return new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
}

function daysBetween(from, to) {
    return Math.floor((new Date(to) - new Date(from)) / 86400000);
}

async function verifyReminderOwnership(cid, reminderId) {
    const { data } = await supabase
        .from('practice_reminders')
        .select('*')
        .eq('id', reminderId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifySourceOwnership(cid, source_type, source_id) {
    if (!source_id) return true;
    const table = SOURCE_TABLE[source_type];
    if (!table) return true;
    const { data } = await supabase
        .from(table)
        .select('id')
        .eq('id', source_id)
        .eq('company_id', cid)
        .single();
    return !!data;
}

async function duplicateExists(cid, source_type, source_id, reminder_type) {
    if (!source_id) return false;
    const { data } = await supabase
        .from('practice_reminders')
        .select('id')
        .eq('company_id', cid)
        .eq('source_type', source_type)
        .eq('source_id', source_id)
        .eq('reminder_type', reminder_type)
        .in('status', ['open', 'snoozed'])
        .limit(1);
    return !!(data && data.length > 0);
}

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase
            .from('practice_reminders')
            .select('status, severity, due_date, snoozed_until')
            .eq('company_id', cid)
            .not('status', 'in', '(cancelled)');

        if (error) {
            console.error('Reminders /summary error:', error.message);
            return res.status(500).json({ error: 'Failed to load summary' });
        }

        const t       = todayStr();
        const weekEnd = addDaysStr(7);
        const counts  = { open: 0, overdue: 0, due_today: 0, due_this_week: 0, urgent: 0, snoozed: 0 };

        for (const r of (data || [])) {
            if (r.status === 'snoozed') counts.snoozed++;
            if (r.status !== 'open') continue;

            counts.open++;
            if (r.severity === 'urgent') counts.urgent++;
            if (!r.due_date) continue;

            if (r.due_date < t)                          counts.overdue++;
            else if (r.due_date === t)                   counts.due_today++;
            else if (r.due_date > t && r.due_date <= weekEnd) counts.due_this_week++;
        }

        // Also include snoozed urgents
        for (const r of (data || [])) {
            if (r.status === 'snoozed' && r.severity === 'urgent') counts.urgent++;
        }

        res.json({ summary: counts });
    } catch (err) {
        console.error('Reminders /summary exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET /suggestions ─────────────────────────────────────────────────────────
// Scans live operational data to surface actionable items that have no open reminder.
// Runs 10 parallel queries. Heavy endpoint — call on demand, not on page load.

router.get('/suggestions', async (req, res) => {
    const cid = req.companyId;
    const t   = todayStr();
    const t7  = addDaysStr(7);

    try {
        const [
            existingReminders,
            deadlines,
            reviewTasks,
            approvalTasks,
            billingPacks,
            healthActions,
            periods,
            engagements,
            teamMembers,
            capacityTasks,
        ] = await Promise.all([
            // Existing open/snoozed reminders — for dedup check
            supabase.from('practice_reminders')
                .select('source_type, source_id, reminder_type')
                .eq('company_id', cid)
                .in('status', ['open', 'snoozed']),

            // Deadlines: overdue or due within 7 days
            supabase.from('practice_deadlines')
                .select('id, client_id, title, due_date')
                .eq('company_id', cid)
                .lte('due_date', t7)
                .not('status', 'in', '(completed,submitted,missed,cancelled)')
                .limit(200),

            // Tasks with review pending/in-progress
            supabase.from('practice_tasks')
                .select('id, client_id, title, review_status')
                .eq('company_id', cid)
                .in('review_status', ['pending', 'in_review'])
                .not('status', 'in', '(completed,cancelled)')
                .limit(100),

            // Tasks with approval pending/in-progress
            supabase.from('practice_tasks')
                .select('id, client_id, title, approval_status')
                .eq('company_id', cid)
                .in('approval_status', ['pending', 'in_review'])
                .not('status', 'in', '(completed,cancelled)')
                .limit(100),

            // Billing packs in draft/reviewed state
            supabase.from('practice_billing_packs')
                .select('id, client_id, pack_name, status, created_at')
                .eq('company_id', cid)
                .in('status', ['draft', 'reviewed'])
                .limit(100),

            // Open/in-progress health actions that are due/overdue
            supabase.from('practice_client_health_actions')
                .select('id, client_id, action_title, action_type, due_date, action_status')
                .eq('company_id', cid)
                .in('action_status', ['open', 'in_progress'])
                .lte('due_date', t)
                .limit(100),

            // Queued/ready engagement periods past their start date
            supabase.from('practice_engagement_periods')
                .select('id, client_id, period_label, period_start')
                .eq('company_id', cid)
                .in('status', ['queued', 'ready'])
                .lt('period_start', t)
                .limit(100),

            // Active engagements (for owner + recurrence checks)
            supabase.from('practice_client_engagements')
                .select('id, client_id, engagement_name, responsible_team_member_id, recurrence_type, recurrence_start_date, recurrence_day')
                .eq('company_id', cid)
                .eq('status', 'active')
                .limit(200),

            // Team members with capacity set (for overload check)
            supabase.from('practice_team_members')
                .select('id, display_name, weekly_capacity_hours')
                .eq('company_id', cid)
                .eq('capacity_is_active', true)
                .gt('weekly_capacity_hours', 0),

            // Open tasks with estimated hours grouped by preparer (for capacity)
            supabase.from('practice_tasks')
                .select('preparer_team_member_id, estimated_hours')
                .eq('company_id', cid)
                .not('status', 'in', '(completed,cancelled)')
                .not('preparer_team_member_id', 'is', null)
                .not('estimated_hours', 'is', null),
        ]);

        // Build dedup set from existing open/snoozed reminders
        const existingKeys = new Set(
            (existingReminders.data || []).map(r => `${r.source_type}:${r.source_id}:${r.reminder_type}`)
        );

        const suggestions = [];
        // Local set: prevents adding two suggestions with the same key in this response
        const addedKeys = new Set();

        function addSuggestion(s) {
            const key = `${s.source_type}:${s.source_id}:${s.reminder_type}`;
            if (!existingKeys.has(key) && !addedKeys.has(key)) {
                addedKeys.add(key);
                suggestions.push(s);
            }
        }

        // ── Overdue deadlines
        for (const d of (deadlines.data || [])) {
            if (d.due_date >= t) continue;
            const days = daysBetween(d.due_date, t);
            addSuggestion({
                reminder_type: 'deadline_overdue',
                source_type:   'deadline',
                source_id:     d.id,
                client_id:     d.client_id,
                title:         'Overdue: ' + d.title,
                message:       d.due_date + ' (' + days + ' day' + (days !== 1 ? 's' : '') + ' overdue)',
                severity:      days > 7 ? 'urgent' : 'high',
                due_date:      d.due_date,
                action_url:    '/practice/deadlines.html',
            });
        }

        // ── Deadlines due within 7 days
        for (const d of (deadlines.data || [])) {
            if (d.due_date < t) continue;
            const days = daysBetween(t, d.due_date);
            addSuggestion({
                reminder_type: 'deadline_due',
                source_type:   'deadline',
                source_id:     d.id,
                client_id:     d.client_id,
                title:         'Due soon: ' + d.title,
                message:       d.due_date + ' (in ' + days + ' day' + (days !== 1 ? 's' : '') + ')',
                severity:      days <= 2 ? 'high' : 'normal',
                due_date:      d.due_date,
                action_url:    '/practice/deadlines.html',
            });
        }

        // ── Review waiting
        for (const tk of (reviewTasks.data || [])) {
            addSuggestion({
                reminder_type: 'review_waiting',
                source_type:   'task',
                source_id:     tk.id,
                client_id:     tk.client_id,
                title:         'Review waiting: ' + tk.title,
                severity:      'normal',
                action_url:    '/practice/tasks.html',
            });
        }

        // ── Approval waiting
        for (const tk of (approvalTasks.data || [])) {
            addSuggestion({
                reminder_type: 'approval_waiting',
                source_type:   'task',
                source_id:     tk.id,
                client_id:     tk.client_id,
                title:         'Approval waiting: ' + tk.title,
                severity:      'normal',
                action_url:    '/practice/tasks.html',
            });
        }

        // ── Billing packs awaiting action
        for (const bp of (billingPacks.data || [])) {
            const ageDays = bp.created_at
                ? Math.floor((Date.now() - new Date(bp.created_at)) / 86400000)
                : 0;
            addSuggestion({
                reminder_type: 'billing_waiting',
                source_type:   'billing_pack',
                source_id:     bp.id,
                client_id:     bp.client_id,
                title:         'Billing awaiting: ' + (bp.pack_name || 'Pack ' + bp.id),
                message:       bp.status + ' · ' + ageDays + ' day' + (ageDays !== 1 ? 's' : '') + ' old',
                severity:      ageDays > 30 ? 'high' : 'normal',
                action_url:    '/practice/billing.html',
            });
        }

        // ── Health actions due or overdue
        for (const ha of (healthActions.data || [])) {
            const overdue = ha.due_date && ha.due_date < t;
            addSuggestion({
                reminder_type: 'health_action',
                source_type:   'health_action',
                source_id:     ha.id,
                client_id:     ha.client_id,
                title:         ha.action_title,
                message:       ha.action_type + (overdue ? ' · Overdue since ' + ha.due_date : ' · Due today'),
                severity:      overdue ? 'high' : 'normal',
                due_date:      ha.due_date || null,
                action_url:    '/practice/client-health.html',
            });
        }

        // ── Engagement periods past their start date
        for (const p of (periods.data || [])) {
            addSuggestion({
                reminder_type: 'period_waiting',
                source_type:   'engagement_period',
                source_id:     p.id,
                client_id:     p.client_id,
                title:         'Period overdue: ' + (p.period_label || 'Period ' + p.id),
                message:       'Period start: ' + p.period_start,
                severity:      'normal',
                action_url:    '/practice/engagement-periods.html',
            });
        }

        // ── Engagements missing responsible team member
        for (const eng of (engagements.data || [])) {
            if (eng.responsible_team_member_id) continue;
            addSuggestion({
                reminder_type: 'engagement_setup',
                source_type:   'engagement',
                source_id:     eng.id,
                client_id:     eng.client_id,
                title:         'Missing owner: ' + eng.engagement_name,
                message:       'Active engagement has no responsible team member',
                severity:      'normal',
                action_url:    '/practice/client-detail.html?id=' + eng.client_id,
            });
        }

        // ── Recurring engagements missing recurrence config (only if no owner issue was already flagged)
        for (const eng of (engagements.data || [])) {
            if (!eng.recurrence_type || ['once_off', 'ad_hoc'].includes(eng.recurrence_type)) continue;
            if (eng.recurrence_start_date && eng.recurrence_day) continue;
            addSuggestion({
                reminder_type: 'engagement_setup',
                source_type:   'engagement',
                source_id:     eng.id,
                client_id:     eng.client_id,
                title:         'Missing recurrence config: ' + eng.engagement_name,
                message:       'Recurring engagement is missing start date or recurrence day',
                severity:      'low',
                action_url:    '/practice/client-detail.html?id=' + eng.client_id,
            });
        }

        // ── Team member capacity overload
        const memberLoad = {};
        for (const m of (teamMembers.data || [])) {
            memberLoad[m.id] = { member: m, taskHours: 0 };
        }
        for (const tk of (capacityTasks.data || [])) {
            if (memberLoad[tk.preparer_team_member_id]) {
                memberLoad[tk.preparer_team_member_id].taskHours += parseFloat(tk.estimated_hours || 0);
            }
        }
        for (const memberId of Object.keys(memberLoad)) {
            const info    = memberLoad[memberId];
            const utilPct = info.member.weekly_capacity_hours > 0
                ? (info.taskHours / info.member.weekly_capacity_hours) * 100
                : 0;
            if (utilPct <= 100) continue;
            addSuggestion({
                reminder_type: 'capacity_warning',
                source_type:   'team_member',
                source_id:     parseInt(memberId, 10),
                title:         info.member.display_name + ' may be overloaded',
                message:       Math.round(utilPct) + '% of weekly capacity (' +
                               Math.round(info.taskHours) + 'h / ' + info.member.weekly_capacity_hours + 'h)',
                severity:      utilPct > 120 ? 'high' : 'normal',
                action_url:    '/practice/capacity.html',
            });
        }

        res.json({ suggestions, total: suggestions.length });
    } catch (err) {
        console.error('Reminders /suggestions exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET / — list reminders ───────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        status, severity, reminder_type, assigned_team_member_id,
        client_id, due_from, due_to, limit = '500',
    } = req.query;

    try {
        let query = supabase
            .from('practice_reminders')
            .select('*')
            .eq('company_id', cid)
            .order('due_date', { ascending: true, nullsFirst: false })
            .order('severity', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(parseInt(limit, 10) || 500);

        // Default: exclude cancelled unless explicitly requested
        if (status) {
            query = query.eq('status', status);
        } else {
            query = query.not('status', 'eq', 'cancelled');
        }

        if (severity)                query = query.eq('severity', severity);
        if (reminder_type)           query = query.eq('reminder_type', reminder_type);
        if (client_id)               query = query.eq('client_id', parseInt(client_id, 10));
        if (assigned_team_member_id) query = query.eq('assigned_team_member_id', parseInt(assigned_team_member_id, 10));
        if (due_from)                query = query.gte('due_date', due_from);
        if (due_to)                  query = query.lte('due_date', due_to);

        const { data, error } = await query;
        if (error) {
            console.error('Reminders GET / error:', error.message);
            return res.status(500).json({ error: 'Failed to load reminders' });
        }

        // Enrich with client and team member names
        const clientIds = [...new Set((data || []).map(r => r.client_id).filter(Boolean))];
        const memberIds = [...new Set((data || []).map(r => r.assigned_team_member_id).filter(Boolean))];

        const [clientsRes, membersRes] = await Promise.all([
            clientIds.length
                ? supabase.from('practice_clients').select('id, client_name').in('id', clientIds).eq('company_id', cid)
                : { data: [] },
            memberIds.length
                ? supabase.from('practice_team_members').select('id, display_name').in('id', memberIds).eq('company_id', cid)
                : { data: [] },
        ]);

        const clientMap = Object.fromEntries((clientsRes.data || []).map(c => [c.id, c.client_name]));
        const memberMap = Object.fromEntries((membersRes.data || []).map(m => [m.id, m.display_name]));

        const enriched = (data || []).map(r => ({
            ...r,
            client_name:      r.client_id ? (clientMap[r.client_id] || null) : null,
            assignee_name:    r.assigned_team_member_id ? (memberMap[r.assigned_team_member_id] || null) : null,
        }));

        res.json({ reminders: enriched, total: enriched.length });
    } catch (err) {
        console.error('Reminders GET / exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST /create-from-suggestion ─────────────────────────────────────────────
// Creates a reminder from a suggestion. Must be defined BEFORE POST /:id routes.

router.post('/create-from-suggestion', async (req, res) => {
    const cid = req.companyId;
    const {
        reminder_type, source_type, source_id, client_id,
        title, message, severity, due_date, action_url,
        assigned_team_member_id, metadata,
    } = req.body;

    if (!reminder_type || !source_type || !title) {
        return res.status(400).json({ error: 'reminder_type, source_type, and title are required' });
    }
    if (!REMINDER_TYPES.includes(reminder_type)) {
        return res.status(400).json({ error: 'Invalid reminder_type' });
    }
    if (!SOURCE_TYPES.includes(source_type)) {
        return res.status(400).json({ error: 'Invalid source_type' });
    }

    try {
        // Verify source record belongs to this company
        const sourceOwned = await verifySourceOwnership(cid, source_type, source_id);
        if (!sourceOwned) {
            return res.status(403).json({ error: 'Source record not found' });
        }

        // Prevent duplicate open reminders
        if (source_id) {
            const dup = await duplicateExists(cid, source_type, source_id, reminder_type);
            if (dup) {
                return res.status(409).json({ error: 'An open reminder already exists for this item' });
            }
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_reminders')
            .insert({
                company_id:              cid,
                reminder_type,
                source_type,
                source_id:               source_id   || null,
                client_id:               client_id   || null,
                assigned_team_member_id: assigned_team_member_id || null,
                title:                   title.trim(),
                message:                 message     || null,
                severity:                SEVERITIES.includes(severity) ? severity : 'normal',
                status:                  'open',
                due_date:                due_date    || null,
                action_url:              action_url  || null,
                metadata:                metadata    || {},
                created_at:              now,
                updated_at:              now,
                created_by:              req.user.userId,
            })
            .select()
            .single();

        if (error) {
            console.error('Reminders /create-from-suggestion insert error:', error.message);
            return res.status(500).json({ error: 'Failed to create reminder' });
        }

        await auditFromReq(req, 'CREATE', 'practice_reminder', data.id, {
            module: 'practice', action: 'reminder_created_from_suggestion',
            reminder_type, source_type, source_id,
        });

        res.status(201).json({ reminder: data });
    } catch (err) {
        console.error('Reminders /create-from-suggestion exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST / — create manual reminder ─────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        reminder_type, source_type = 'system', source_id,
        client_id, assigned_team_member_id,
        title, message, severity, due_date, action_url, metadata,
    } = req.body;

    if (!reminder_type || !title) {
        return res.status(400).json({ error: 'reminder_type and title are required' });
    }
    if (!REMINDER_TYPES.includes(reminder_type)) {
        return res.status(400).json({ error: 'Invalid reminder_type' });
    }

    try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_reminders')
            .insert({
                company_id:              cid,
                reminder_type,
                source_type,
                source_id:               source_id               || null,
                client_id:               client_id               || null,
                assigned_team_member_id: assigned_team_member_id || null,
                title:                   title.trim(),
                message:                 message                 || null,
                severity:                SEVERITIES.includes(severity) ? severity : 'normal',
                status:                  'open',
                due_date:                due_date                || null,
                action_url:              action_url              || null,
                metadata:                metadata                || {},
                created_at:              now,
                updated_at:              now,
                created_by:              req.user.userId,
            })
            .select()
            .single();

        if (error) {
            console.error('Reminders POST / insert error:', error.message);
            return res.status(500).json({ error: 'Failed to create reminder' });
        }

        await auditFromReq(req, 'CREATE', 'practice_reminder', data.id, {
            module: 'practice', action: 'reminder_created',
            reminder_type, source_type, source_id,
        });

        res.status(201).json({ reminder: data });
    } catch (err) {
        console.error('Reminders POST / exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id/snooze ─────────────────────────────────────────────────────────
// 3-segment — must be defined before the 2-segment PUT /:id

router.put('/:id/snooze', async (req, res) => {
    const cid = req.companyId;
    const reminderId = parseInt(req.params.id, 10);
    const { snoozed_until } = req.body;

    if (!snoozed_until) {
        return res.status(400).json({ error: 'snoozed_until is required' });
    }
    const snoozeDate = new Date(snoozed_until);
    if (isNaN(snoozeDate.getTime()) || snoozeDate <= new Date()) {
        return res.status(400).json({ error: 'snoozed_until must be a valid future datetime' });
    }

    try {
        const existing = await verifyReminderOwnership(cid, reminderId);
        if (!existing) return res.status(404).json({ error: 'Reminder not found' });
        if (['cancelled', 'completed', 'dismissed'].includes(existing.status)) {
            return res.status(409).json({ error: 'Cannot snooze a ' + existing.status + ' reminder' });
        }

        const { data, error } = await supabase
            .from('practice_reminders')
            .update({ status: 'snoozed', snoozed_until: snoozeDate.toISOString(), updated_at: new Date().toISOString() })
            .eq('id', reminderId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Reminders PUT /:id/snooze error:', error.message);
            return res.status(500).json({ error: 'Failed to snooze reminder' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_reminder', reminderId, {
            module: 'practice', action: 'reminder_snoozed', snoozed_until,
        });

        res.json({ reminder: data });
    } catch (err) {
        console.error('Reminders PUT /:id/snooze exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id/complete ────────────────────────────────────────────────────────

router.put('/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const reminderId = parseInt(req.params.id, 10);

    try {
        const existing = await verifyReminderOwnership(cid, reminderId);
        if (!existing) return res.status(404).json({ error: 'Reminder not found' });
        if (existing.status === 'cancelled') {
            return res.status(409).json({ error: 'Cannot complete a cancelled reminder' });
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_reminders')
            .update({ status: 'completed', completed_at: now, completed_by: req.user.userId, updated_at: now })
            .eq('id', reminderId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Reminders PUT /:id/complete error:', error.message);
            return res.status(500).json({ error: 'Failed to complete reminder' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_reminder', reminderId, {
            module: 'practice', action: 'reminder_completed',
        });

        res.json({ reminder: data });
    } catch (err) {
        console.error('Reminders PUT /:id/complete exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id/dismiss ─────────────────────────────────────────────────────────

router.put('/:id/dismiss', async (req, res) => {
    const cid = req.companyId;
    const reminderId = parseInt(req.params.id, 10);

    try {
        const existing = await verifyReminderOwnership(cid, reminderId);
        if (!existing) return res.status(404).json({ error: 'Reminder not found' });
        if (existing.status === 'cancelled') {
            return res.status(409).json({ error: 'Cannot dismiss a cancelled reminder' });
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_reminders')
            .update({ status: 'dismissed', dismissed_at: now, dismissed_by: req.user.userId, updated_at: now })
            .eq('id', reminderId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Reminders PUT /:id/dismiss error:', error.message);
            return res.status(500).json({ error: 'Failed to dismiss reminder' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_reminder', reminderId, {
            module: 'practice', action: 'reminder_dismissed',
        });

        res.json({ reminder: data });
    } catch (err) {
        console.error('Reminders PUT /:id/dismiss exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id — generic update ────────────────────────────────────────────────
// 2-segment — after all 3-segment PUT routes

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const reminderId = parseInt(req.params.id, 10);

    const allowed = ['title', 'message', 'severity', 'due_date', 'action_url',
                     'reminder_type', 'assigned_team_member_id', 'client_id', 'metadata'];
    const updates = {};
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
    }

    if (updates.severity && !SEVERITIES.includes(updates.severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
    }
    if (updates.reminder_type && !REMINDER_TYPES.includes(updates.reminder_type)) {
        return res.status(400).json({ error: 'Invalid reminder_type' });
    }
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
    }

    try {
        const existing = await verifyReminderOwnership(cid, reminderId);
        if (!existing) return res.status(404).json({ error: 'Reminder not found' });
        if (existing.status === 'cancelled') {
            return res.status(409).json({ error: 'Cannot edit a cancelled reminder' });
        }

        updates.updated_at = new Date().toISOString();

        const { data, error } = await supabase
            .from('practice_reminders')
            .update(updates)
            .eq('id', reminderId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Reminders PUT /:id error:', error.message);
            return res.status(500).json({ error: 'Failed to update reminder' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_reminder', reminderId, {
            module: 'practice', action: 'reminder_updated', fields: Object.keys(updates),
        });

        res.json({ reminder: data });
    } catch (err) {
        console.error('Reminders PUT /:id exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DELETE /:id — soft cancel ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const reminderId = parseInt(req.params.id, 10);

    try {
        const existing = await verifyReminderOwnership(cid, reminderId);
        if (!existing) return res.status(404).json({ error: 'Reminder not found' });
        if (existing.status === 'cancelled') {
            return res.status(409).json({ error: 'Reminder is already cancelled' });
        }

        const { error } = await supabase
            .from('practice_reminders')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', reminderId)
            .eq('company_id', cid);

        if (error) {
            console.error('Reminders DELETE /:id error:', error.message);
            return res.status(500).json({ error: 'Failed to cancel reminder' });
        }

        await auditFromReq(req, 'DELETE', 'practice_reminder', reminderId, {
            module: 'practice', action: 'reminder_cancelled',
        });

        res.json({ ok: true });
    } catch (err) {
        console.error('Reminders DELETE /:id exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
