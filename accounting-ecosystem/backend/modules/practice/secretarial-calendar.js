'use strict';

// Codebox 67 — Secretarial Statutory Calendar + Compliance Scheduler
// "The Practice should never miss a statutory deadline." One calendar
// showing every upcoming corporate compliance obligation for every client.
//
// NOT another Deadlines module — practice_deadlines remains the master
// task/deadline system. This module defines statutory OBLIGATIONS (what's
// due, how often) and synchronises them with practice_deadlines by linking
// to an existing/created row, never duplicating deadline management.
//
// NOT CIPC API. NOT automatic submissions. NOT cron jobs. NOT calendar sync
// (Google/Outlook). NOT email/SMS/push reminders.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const beneficialOwnership = require('./beneficial-ownership');
// Codebox 66 (delivered after this file, out of order — see docs/new-app/
// SESSION_HANDOFF_codebox_66_secretarial_evidence.md) — closes the
// 'evidence_complete' dependency gap this file originally left as a
// documented follow-up (always-unsatisfied-unless-overridden).
const secretarialEvidence = require('./secretarial-evidence');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const OBLIGATION_TYPES = [
    'annual_return', 'beneficial_ownership_review', 'director_register_review',
    'share_register_review', 'company_information_review', 'financial_year_end_review',
    'company_secretary_review', 'auditor_review', 'accounting_officer_review', 'custom',
];
const FREQUENCIES = ['one_off', 'monthly', 'quarterly', 'half_yearly', 'annual', 'every_x_months', 'manual'];
const SCHEDULE_STATUSES = ['pending', 'completed', 'cancelled'];
const DEPENDENCY_TYPES = ['schedule_item', 'bo_review', 'evidence_complete', 'governance_complete', 'custom'];
const ANCHOR_TYPES = ['registration_date', 'financial_year_end', 'fixed_date', 'manual'];

// Maps an obligation_type onto the existing practice_deadlines.deadline_type
// vocabulary — the reuse target for "Deadline Synchronisation." Only types
// with an established, unambiguous deadline_type counterpart are mapped;
// anything else falls back to 'custom' (still synced, just not pre-categorized).
const OBLIGATION_TO_DEADLINE_TYPE = {
    annual_return: 'cipc_annual_return',
    beneficial_ownership_review: 'beneficial_ownership',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function addDays(dateStr, n) { return new Date(new Date(dateStr + 'T00:00:00').getTime() + n * 86400000).toISOString().split('T')[0]; }
function addMonths(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setMonth(d.getMonth() + n);
    return d.toISOString().split('T')[0];
}

async function _myTeamMember(cid, user) {
    return teamAccess.getMyTeamMember(supabase, cid, user);
}
function _isManager(member) { return teamAccess.isManager(member); }

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can manage the statutory calendar.');
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_statutory_calendar_events').insert({
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

// ─── Recurrence Engine ──────────────────────────────────────────────────────────
// Deterministic date math only — never a guessed or ML-derived date.

async function _resolveAnchorDate(cid, clientId, dueRule) {
    const anchor = (dueRule && dueRule.anchor) || 'manual';
    if (anchor === 'registration_date') {
        const { data } = await supabase.from('practice_secretarial_profiles').select('registration_date').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        return data?.registration_date || null;
    }
    if (anchor === 'financial_year_end') {
        const { data } = await supabase.from('practice_taxpayer_profiles').select('financial_year_end').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        return data?.financial_year_end || null;
    }
    if (anchor === 'fixed_date' && dueRule.fixed_month_day) {
        const y = new Date().getFullYear();
        return `${y}-${dueRule.fixed_month_day}`;
    }
    return null; // 'manual' or unresolvable — no automatic generation possible
}

// Returns [{ period_label, due_date }] for occurrences between today and
// throughDate (inclusive), starting from anchorDate. Applies due_rule.offset_days.
function _computeDueDates(obligation, anchorDate, throughDate) {
    const dueRule = obligation.due_rule || {};
    const offsetDays = dueRule.offset_days || 0;
    const results = [];

    if (obligation.frequency === 'one_off') {
        const due = addDays(anchorDate, offsetDays);
        results.push({ period_label: `${obligation.title}`, due_date: due });
        return results;
    }

    const stepMonths = {
        monthly: 1, quarterly: 3, half_yearly: 6, annual: 12,
        every_x_months: obligation.every_x_months || 1,
    }[obligation.frequency];
    if (!stepMonths) return results; // 'manual' — no auto-generated occurrences

    let cursor = addDays(anchorDate, offsetDays);
    // Advance to the first occurrence on/after today so we don't backfill history.
    while (cursor < today()) cursor = addMonths(cursor, stepMonths);

    while (cursor <= throughDate) {
        const year = cursor.slice(0, 4);
        results.push({ period_label: `${obligation.title} — ${year} (${cursor})`, due_date: cursor });
        cursor = addMonths(cursor, stepMonths);
    }
    return results;
}

// Resolve-or-create against practice_deadlines — the reuse target. Matches
// on (client_id, deadline_type, due_date); creates a new row only if no
// match exists. Never duplicates.
async function _resolveOrCreateDeadline(cid, clientId, obligation, dueDate, periodLabel, actorUserId) {
    const deadlineType = OBLIGATION_TO_DEADLINE_TYPE[obligation.obligation_type] || 'custom';

    const { data: existing } = await supabase.from('practice_deadlines')
        .select('id').eq('company_id', cid).eq('client_id', clientId).eq('deadline_type', deadlineType).eq('due_date', dueDate).maybeSingle();
    if (existing) return { deadlineId: existing.id, created: false };

    const { data: created, error } = await supabase.from('practice_deadlines').insert({
        company_id: cid, client_id: clientId, title: periodLabel, type: 'other',
        deadline_type: deadlineType, compliance_area: 'cipc', due_date: dueDate, status: 'pending',
        created_by: actorUserId,
    }).select('id').single();
    if (error) throw new Error(error.message);
    return { deadlineId: created.id, created: true };
}

// Idempotent — only inserts schedule rows for periods that don't already
// exist for this obligation (enforced by the DB's own unique constraint on
// (obligation_id, period_label) as a backstop, checked here first for a
// clean response rather than a constraint-violation error).
async function generateSchedule(cid, obligationId, actorUserId, monthsAhead) {
    const { data: obligation } = await supabase.from('practice_statutory_obligations').select('*').eq('id', obligationId).eq('company_id', cid).maybeSingle();
    if (!obligation) throw new Error('Obligation not found');
    if (!obligation.is_active) throw new Error('Obligation is not active');
    if (obligation.frequency === 'manual') return { created: [], message: 'This obligation is manual — add schedule entries directly via POST /schedule.' };

    const anchorDate = await _resolveAnchorDate(cid, obligation.client_id, obligation.due_rule);
    if (!anchorDate) return { created: [], message: 'Could not resolve an anchor date (registration date or financial year-end not on file) — add schedule entries manually or complete the Secretarial/Taxpayer profile first.' };

    const throughDate = addMonths(today(), monthsAhead || 12);
    const occurrences = _computeDueDates(obligation, anchorDate, throughDate);
    if (!occurrences.length) return { created: [], message: 'No new occurrences to generate.' };

    const { data: existingRows } = await supabase.from('practice_statutory_schedule').select('period_label').eq('obligation_id', obligationId);
    const existingLabels = new Set((existingRows || []).map(r => r.period_label));

    const created = [];
    for (const occ of occurrences) {
        if (existingLabels.has(occ.period_label)) continue;

        const { deadlineId, created: deadlineCreated } = await _resolveOrCreateDeadline(cid, obligation.client_id, obligation, occ.due_date, occ.period_label, actorUserId);

        const { data: row, error } = await supabase.from('practice_statutory_schedule').insert({
            company_id: cid, client_id: obligation.client_id, obligation_id: obligationId,
            period_label: occ.period_label, due_date: occ.due_date,
            warning_date: addDays(occ.due_date, -(obligation.warning_days || 0)),
            grace_end_date: addDays(occ.due_date, obligation.grace_period_days || 0),
            linked_deadline_id: deadlineId, created_by: actorUserId,
        }).select().single();
        if (error) throw new Error(error.message);

        await _writeEvent(cid, obligation.client_id, 'schedule', row.id, 'schedule_generated', null, row.status, actorUserId, occ.period_label, { due_date: occ.due_date });
        await _writeEvent(cid, obligation.client_id, 'schedule', row.id, deadlineCreated ? 'deadline_created' : 'deadline_linked', null, null, actorUserId, null, { deadline_id: deadlineId });

        created.push(row);
    }
    return { created, message: created.length ? `${created.length} schedule entr${created.length === 1 ? 'y' : 'ies'} generated.` : 'No new occurrences to generate.' };
}

// ─── Dependency Resolution — never guesses, always documents why ───────────────

async function _isDependencySatisfied(cid, dep) {
    if (dep.manager_override) return { satisfied: true, reason: 'Manager override' };

    if (dep.depends_on_type === 'schedule_item' && dep.depends_on_schedule_id) {
        const { data } = await supabase.from('practice_statutory_schedule').select('status').eq('id', dep.depends_on_schedule_id).eq('company_id', cid).maybeSingle();
        return { satisfied: !!data && data.status === 'completed', reason: data ? `Linked schedule item is ${data.status}` : 'Linked schedule item not found' };
    }
    if (dep.depends_on_type === 'bo_review') {
        try {
            const profile = await beneficialOwnership.getBeneficialOwnershipProfile(cid, dep.client_id);
            const ready = !!profile && profile.readiness && profile.readiness.status === 'ready';
            return { satisfied: ready, reason: profile ? `BO readiness is ${profile.readiness.status}` : 'No BO profile found' };
        } catch (e) { return { satisfied: false, reason: 'BO readiness could not be determined' }; }
    }
    // Codebox 66 — 'evidence_complete' now checks the linked evidence
    // checklist's live readiness (via depends_on_checklist_id, added by
    // migration 124) instead of always requiring manager confirmation.
    if (dep.depends_on_type === 'evidence_complete') {
        if (!dep.depends_on_checklist_id) return { satisfied: false, reason: 'No evidence checklist linked to this dependency yet — set depends_on_checklist_id, or use a manager override.' };
        try {
            const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('id', dep.depends_on_checklist_id).eq('company_id', cid).maybeSingle();
            if (!checklist) return { satisfied: false, reason: 'Linked evidence checklist not found' };
            const readiness = await secretarialEvidence.getChecklistReadiness(cid, checklist);
            return { satisfied: readiness.status === 'ready', reason: `Evidence checklist readiness is ${readiness.status}` };
        } catch (e) { return { satisfied: false, reason: 'Evidence checklist readiness could not be determined' }; }
    }
    // 'governance_complete' / 'custom' — no automatic check exists yet in
    // this codebase; never guessed. Only a manager override (handled above)
    // can satisfy these.
    return { satisfied: false, reason: 'Requires manager confirmation (no automatic check available for this dependency type)' };
}

// ─── Scheduler — buildStatutoryCalendar() ──────────────────────────────────────
// Pure computation over stored schedule rows + live dependency checks.
// Categories are never stored — always derived so they can never drift.

async function buildStatutoryCalendar(cid, clientId) {
    let q = supabase.from('practice_statutory_schedule').select('*').eq('company_id', cid).order('due_date');
    if (clientId) q = q.eq('client_id', clientId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const scheduleRows = rows || [];
    const scheduleIds = scheduleRows.map(r => r.id);
    const { data: depRows } = scheduleIds.length
        ? await supabase.from('practice_statutory_dependencies').select('*').eq('company_id', cid).in('schedule_id', scheduleIds)
        : { data: [] };
    const depsBySchedule = {};
    (depRows || []).forEach(d => { if (!depsBySchedule[d.schedule_id]) depsBySchedule[d.schedule_id] = []; depsBySchedule[d.schedule_id].push(d); });

    const t = today();
    const buckets = { upcoming: [], due_today: [], overdue: [], blocked: [], waiting: [], completed: [], future: [] };
    const items = [];

    for (const row of scheduleRows) {
        if (row.status === 'cancelled') continue; // excluded from every bucket — a cancelled entry needs no attention

        let category;
        let dependencyReasons = [];

        if (row.status === 'completed') {
            category = 'completed';
        } else {
            const deps = depsBySchedule[row.id] || [];
            const results = await Promise.all(deps.map(d => _isDependencySatisfied(cid, d)));
            const unsatisfied = results.filter(r => !r.satisfied);
            dependencyReasons = results.map(r => r.reason);

            if (unsatisfied.length) {
                category = row.due_date <= t ? 'blocked' : 'waiting';
            } else {
                const overdueBoundary = row.grace_end_date || row.due_date;
                if (t > overdueBoundary) category = 'overdue';
                else if (row.due_date === t) category = 'due_today';
                else if (row.warning_date && t >= row.warning_date) category = 'upcoming';
                else category = 'future';
            }
        }

        const item = { ...row, category, dependency_reasons: dependencyReasons };
        items.push(item);
        buckets[category].push(item);
    }

    return { items, buckets, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])) };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const calendar = await buildStatutoryCalendar(cid, null);
        res.json({ counts: calendar.counts, total: calendar.items.length });
    } catch (err) {
        console.error('Secretarial-calendar /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════════════════════

router.get('/calendar', async (req, res) => {
    const cid = req.companyId;
    const { client_id } = req.query;
    try {
        const calendar = await buildStatutoryCalendar(cid, client_id ? parseInt(client_id) : null);

        const clientIds = [...new Set(calendar.items.map(i => i.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        calendar.items = calendar.items.map(i => ({ ...i, client_name: nameById[i.client_id] || null }));
        Object.keys(calendar.buckets).forEach(k => { calendar.buckets[k] = calendar.buckets[k].map(i => ({ ...i, client_name: nameById[i.client_id] || null })); });

        res.json(calendar);
    } catch (err) {
        console.error('Secretarial-calendar GET calendar error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// OBLIGATIONS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/obligations', async (req, res) => {
    const cid = req.companyId;
    const { client_id, obligation_type, is_active } = req.query;
    try {
        let q = supabase.from('practice_statutory_obligations').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (obligation_type) q = q.eq('obligation_type', obligation_type);
        if (is_active !== undefined) q = q.eq('is_active', is_active === 'true');
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ obligations: data || [] });
    } catch (err) {
        console.error('Secretarial-calendar GET obligations error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/obligations', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, obligation_type, title, frequency, every_x_months, due_rule, warning_days, grace_period_days, mandatory, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!OBLIGATION_TYPES.includes(obligation_type)) return res.status(400).json({ error: 'Invalid obligation_type' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    if (frequency === 'every_x_months' && !every_x_months) return res.status(400).json({ error: 'every_x_months is required when frequency is every_x_months' });
    if (due_rule && due_rule.anchor && !ANCHOR_TYPES.includes(due_rule.anchor)) return res.status(400).json({ error: 'Invalid due_rule.anchor' });

    try {
        const { data, error } = await supabase.from('practice_statutory_obligations').insert({
            company_id: cid, client_id: clientId, obligation_type, title, frequency,
            every_x_months: every_x_months ? parseInt(every_x_months) : null,
            due_rule: due_rule || { anchor: 'manual', offset_days: 0, fixed_month_day: null },
            warning_days: warning_days != null ? parseInt(warning_days) : 30,
            grace_period_days: grace_period_days != null ? parseInt(grace_period_days) : 0,
            mandatory: mandatory != null ? !!mandatory : true,
            notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'obligation', data.id, 'obligation_created', null, null, req.user.userId, title, { obligation_type });
        res.status(201).json({ obligation: data });
    } catch (err) {
        console.error('Secretarial-calendar POST obligations error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/obligations/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid obligation ID' });
    try {
        const { data, error } = await supabase.from('practice_statutory_obligations').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Obligation not found' });
        res.json({ obligation: data });
    } catch (err) {
        console.error('Secretarial-calendar GET obligation error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/obligations/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid obligation ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_statutory_obligations').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Obligation not found' });

    const allowed = ['title', 'frequency', 'every_x_months', 'due_rule', 'warning_days', 'grace_period_days', 'mandatory', 'is_active', 'notes', 'internal_notes', 'settings'];
    const update = _pick(req.body, allowed);
    if (update.frequency && !FREQUENCIES.includes(update.frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    if (update.due_rule && update.due_rule.anchor && !ANCHOR_TYPES.includes(update.due_rule.anchor)) return res.status(400).json({ error: 'Invalid due_rule.anchor' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_statutory_obligations').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.is_active === false ? 'obligation_archived' : 'obligation_updated';
        await _writeEvent(cid, existing.data.client_id, 'obligation', id, eventType, null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ obligation: data });
    } catch (err) {
        console.error('Secretarial-calendar PUT obligation error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/obligations/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid obligation ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_statutory_obligations').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Obligation not found' });

    try {
        const { data, error } = await supabase.from('practice_statutory_obligations')
            .update({ is_active: false, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'obligation', id, 'obligation_archived', null, null, req.user.userId, req.body.reason || null, {});
        res.json({ obligation: data });
    } catch (err) {
        console.error('Secretarial-calendar DELETE obligation error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/obligations/:id/generate-schedule', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid obligation ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    try {
        const result = await generateSchedule(cid, id, req.user.userId, req.body.months_ahead);
        res.status(201).json(result);
    } catch (err) {
        console.error('Secretarial-calendar generate-schedule error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════

router.get('/schedule', async (req, res) => {
    const cid = req.companyId;
    const { client_id, obligation_id, status } = req.query;
    try {
        let q = supabase.from('practice_statutory_schedule').select('*').eq('company_id', cid).order('due_date');
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (obligation_id) q = q.eq('obligation_id', parseInt(obligation_id));
        if (status) q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ schedule: data || [] });
    } catch (err) {
        console.error('Secretarial-calendar GET schedule error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/schedule', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { obligation_id, period_label, due_date, notes } = req.body;
    const obligationId = parseInt(obligation_id);
    if (!obligationId) return res.status(400).json({ error: 'obligation_id is required' });
    const { data: obligation } = await supabase.from('practice_statutory_obligations').select('*').eq('id', obligationId).eq('company_id', cid).maybeSingle();
    if (!obligation) return res.status(404).json({ error: 'Obligation not found' });
    if (!period_label) return res.status(400).json({ error: 'period_label is required' });
    if (!due_date) return res.status(400).json({ error: 'due_date is required' });

    try {
        const { deadlineId } = await _resolveOrCreateDeadline(cid, obligation.client_id, obligation, due_date, period_label, req.user.userId);

        const { data, error } = await supabase.from('practice_statutory_schedule').insert({
            company_id: cid, client_id: obligation.client_id, obligation_id: obligationId, period_label, due_date,
            warning_date: addDays(due_date, -(obligation.warning_days || 0)),
            grace_end_date: addDays(due_date, obligation.grace_period_days || 0),
            linked_deadline_id: deadlineId, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, obligation.client_id, 'schedule', data.id, 'schedule_generated', null, data.status, req.user.userId, period_label, { manual: true });
        res.status(201).json({ schedule: data });
    } catch (err) {
        console.error('Secretarial-calendar POST schedule error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/schedule/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid schedule ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_statutory_schedule').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Schedule entry not found' });

    const allowed = ['period_label', 'due_date', 'status', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.status && !SCHEDULE_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'completed' && existing.data.status !== 'completed') {
        update.completed_at = new Date().toISOString();
        update.completed_by = req.user.userId;
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_statutory_schedule').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'completed' ? 'schedule_completed' : update.status === 'cancelled' ? 'schedule_cancelled' : 'schedule_updated';
        await _writeEvent(cid, existing.data.client_id, 'schedule', id, eventType, existing.data.status, data.status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ schedule: data });
    } catch (err) {
        console.error('Secretarial-calendar PUT schedule error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/dependencies', async (req, res) => {
    const cid = req.companyId;
    const { schedule_id, client_id } = req.query;
    try {
        let q = supabase.from('practice_statutory_dependencies').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (schedule_id) q = q.eq('schedule_id', parseInt(schedule_id));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ dependencies: data || [] });
    } catch (err) {
        console.error('Secretarial-calendar GET dependencies error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/dependencies', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { schedule_id, depends_on_type, depends_on_schedule_id, depends_on_checklist_id, description, notes } = req.body;
    const scheduleId = parseInt(schedule_id);
    if (!scheduleId) return res.status(400).json({ error: 'schedule_id is required' });
    const { data: schedule } = await supabase.from('practice_statutory_schedule').select('*').eq('id', scheduleId).eq('company_id', cid).maybeSingle();
    if (!schedule) return res.status(404).json({ error: 'Schedule entry not found' });
    if (!DEPENDENCY_TYPES.includes(depends_on_type)) return res.status(400).json({ error: 'Invalid depends_on_type' });

    if (depends_on_type === 'schedule_item') {
        if (!depends_on_schedule_id) return res.status(400).json({ error: 'depends_on_schedule_id is required when depends_on_type is schedule_item' });
        const { data: dep } = await supabase.from('practice_statutory_schedule').select('id').eq('id', depends_on_schedule_id).eq('company_id', cid).eq('client_id', schedule.client_id).maybeSingle();
        if (!dep) return res.status(400).json({ error: 'depends_on_schedule_id does not match an existing schedule entry for this client.' });
    }
    // Codebox 66 — evidence_complete dependencies may optionally link a
    // specific evidence checklist for automatic resolution (see
    // _isDependencySatisfied()). Without it, the dependency always requires
    // manager confirmation — never guessed which checklist was meant.
    if (depends_on_type === 'evidence_complete' && depends_on_checklist_id) {
        const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('id').eq('id', depends_on_checklist_id).eq('company_id', cid).eq('client_id', schedule.client_id).maybeSingle();
        if (!checklist) return res.status(400).json({ error: 'depends_on_checklist_id does not match an existing evidence checklist for this client.' });
    }

    try {
        const { data, error } = await supabase.from('practice_statutory_dependencies').insert({
            company_id: cid, client_id: schedule.client_id, schedule_id: scheduleId, depends_on_type,
            depends_on_schedule_id: depends_on_schedule_id ? parseInt(depends_on_schedule_id) : null,
            depends_on_checklist_id: depends_on_checklist_id ? parseInt(depends_on_checklist_id) : null,
            description: description || null, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, schedule.client_id, 'dependency', data.id, 'dependency_created', null, null, req.user.userId, description || null, { depends_on_type });
        res.status(201).json({ dependency: data });
    } catch (err) {
        console.error('Secretarial-calendar POST dependencies error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/dependencies/:id/override', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid dependency ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_statutory_dependencies').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Dependency not found' });

    const { clear, override_reason } = req.body;
    if (!clear && !override_reason) return res.status(400).json({ error: 'override_reason is required to set an override' });

    try {
        const update = clear
            ? { manager_override: false, override_reason: null, override_by: null, override_at: null }
            : { manager_override: true, override_reason, override_by: req.user.userId, override_at: new Date().toISOString() };
        update.updated_at = new Date().toISOString();

        const { data, error } = await supabase.from('practice_statutory_dependencies').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'dependency', id, 'dependency_overridden', null, null, req.user.userId, override_reason || 'Override cleared', { clear: !!clear });
        res.json({ dependency: data });
    } catch (err) {
        console.error('Secretarial-calendar override dependency error:', err.message);
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
        let q = supabase.from('practice_statutory_calendar_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-calendar GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/67_secretarial_calendar.md
module.exports.buildStatutoryCalendar = buildStatutoryCalendar;
module.exports.generateSchedule = generateSchedule;
