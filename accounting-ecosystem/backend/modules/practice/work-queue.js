'use strict';

// Codebox 55 — Practice Work Queue + Personal Work Hub
// "What must I work on next?" — a single, deterministic, explainable
// aggregation of every outstanding item across the practice for one team
// member. NOT AI. NOT automatic workload balancing. NOT auto-assignment.
//
// No work items are stored. Every request recomputes the queue live from
// the source modules, which remain the sole owners of their data — this
// router only reads, never writes to any source table.

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _today() { return new Date().toISOString().slice(0, 10); }
function _daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function _daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

const RISK_RATING_BONUS = { flagged: 30, high: 20, medium: 10, normal: 0, low: 0 };
const PRIORITY_BONUS = { urgent: 40, high: 25, medium: 10, normal: 10, low: 0 };
const SEVERITY_BONUS = { critical: 80, high: 50, medium: 20, normal: 20, low: 5, info: 5 };

async function _myTeamMemberId(cid, user) {
    return teamAccess.getMyTeamMember(supabase, cid, user);
}

async function _writeEvent(cid, teamMemberId, eventType, sourceModule, sourceType, sourceId, actorUserId, notes, meta) {
    await supabase.from('practice_work_queue_events').insert({
        company_id: cid,
        team_member_id: teamMemberId || null,
        event_type: eventType,
        source_module: sourceModule || null,
        source_type: sourceType || null,
        source_id: sourceId || null,
        actor_user_id: actorUserId || null,
        notes: notes || null,
        metadata: meta || {},
    });
}

// ── Priority Engine ──────────────────────────────────────────────────────────
// Deterministic, additive, fully explainable. Every point added has a
// matching human-readable reason fragment — there is no hidden scoring.
// Bands: >=150 critical, >=100 high, >=50 medium, else low.

function _scoreItem(item, today) {
    let score = 0;
    const reasons = [];

    if (item.blocked) { score += 100; reasons.push('Blocked'); }

    if (item.due_date) {
        const days = _daysBetween(today, item.due_date);
        if (days < 0) { score += 90; reasons.push(`Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`); }
        else if (days === 0) { score += 70; reasons.push('Due today'); }
        else if (days <= 3) { score += 50; reasons.push(`Due in ${days} day${days === 1 ? '' : 's'}`); }
        else if (days <= 7) { score += 20; reasons.push(`Due in ${days} days`); }
    }

    if (item.severity_band) {
        const bonus = SEVERITY_BONUS[item.severity_band] || 0;
        if (bonus) { score += bonus; reasons.push(`${item.severity_band[0].toUpperCase()}${item.severity_band.slice(1)} severity`); }
    }

    if (item.manual_priority) {
        const bonus = PRIORITY_BONUS[item.manual_priority] || 0;
        if (bonus >= 25) { score += bonus; reasons.push(`Marked ${item.manual_priority} priority`); }
        else if (bonus) { score += bonus; }
    }

    if (item.client_risk_rating) {
        const bonus = RISK_RATING_BONUS[item.client_risk_rating] || 0;
        if (bonus) { score += bonus; reasons.push(item.client_risk_rating === 'flagged' ? 'Flagged client' : 'High-priority client'); }
    }

    if (item.waiting_on === 'me') { score += 40; reasons.push('Waiting on you'); }

    item.priority_score = score;
    item.priority_label = score >= 150 ? 'critical' : score >= 100 ? 'high' : score >= 50 ? 'medium' : 'low';
    item.reason = reasons.length ? reasons.join(' · ') : 'Open item assigned to you';
    return item;
}

// ── Source fetchers ──────────────────────────────────────────────────────────
// Each returns an array of normalized items for one team member. Failures
// are isolated — one source erroring never blocks the others (matches the
// defensive pattern used by notify() in Codebox 54).

async function _fetchTasks(cid, tmId) {
    const { data, error } = await supabase.from('practice_tasks')
        .select('id, title, client_id, due_date, status, review_status, approval_status, priority, estimated_hours, assigned_to, preparer_team_member_id, reviewer_team_member_id, approver_team_member_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .not('status', 'in', '("completed","cancelled")')
        .or(`assigned_to.eq.${tmId},preparer_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId},approver_team_member_id.eq.${tmId}`);
    if (error) { console.error('[work-queue] tasks', error.message); return []; }

    return (data || []).map(t => {
        let role = 'assignee', waitingOn = null;
        if (t.reviewer_team_member_id === tmId && ['pending', 'in_review'].includes(t.review_status)) { role = 'reviewer'; waitingOn = 'me'; }
        else if (t.approver_team_member_id === tmId && t.approval_status === 'pending') { role = 'approver'; waitingOn = 'me'; }
        else if (t.preparer_team_member_id === tmId) { role = 'preparer'; waitingOn = ['pending', 'in_review'].includes(t.review_status) ? 'others' : null; }
        else if (t.assigned_to === tmId) { role = 'assignee'; waitingOn = null; }

        return {
            source_module: 'tasks', source_type: 'practice_task', source_id: t.id, client_id: t.client_id,
            role, title: t.title, client_name: t.practice_clients?.name || null,
            client_risk_rating: t.practice_clients?.risk_rating || null,
            due_date: t.due_date, status: t.status, manual_priority: t.priority,
            // Codebox 57 (Resource Forecasting) reads this — the only source
            // table with a real per-item hour estimate. Every other source
            // module has no such column; forecasting applies documented
            // placeholder hours for those instead of inventing a fake number
            // here. null (not 0) when genuinely not captured on the task.
            known_hours: t.estimated_hours != null ? Number(t.estimated_hours) : null,
            severity_band: null, blocked: false, waiting_on: waitingOn,
            deep_link: '/practice/tasks.html?open=' + t.id,
        };
    });
}

async function _fetchDeadlines(cid, tmId) {
    const { data, error } = await supabase.from('practice_deadlines')
        .select('id, title, due_date, status, priority, compliance_area, deadline_type, responsible_team_member_id, client_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .not('status', 'in', '("completed","submitted","missed","cancelled")')
        .eq('responsible_team_member_id', tmId);
    if (error) { console.error('[work-queue] deadlines', error.message); return []; }

    return (data || []).map(d => ({
        source_module: 'deadlines', source_type: 'practice_deadline', source_id: d.id, client_id: d.client_id,
        role: 'responsible', title: d.title, client_name: d.practice_clients?.name || null,
        client_risk_rating: d.practice_clients?.risk_rating || null,
        due_date: d.due_date, status: d.status, manual_priority: d.priority,
        severity_band: null, blocked: false, waiting_on: null,
        deep_link: '/practice/deadlines.html?open=' + d.id,
    }));
}

async function _fetchReminders(cid, tmId) {
    const { data, error } = await supabase.from('practice_reminders')
        .select('id, title, reminder_type, due_date, status, severity, assigned_team_member_id, client_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .in('status', ['open', 'snoozed'])
        .eq('assigned_team_member_id', tmId);
    if (error) { console.error('[work-queue] reminders', error.message); return []; }

    return (data || []).map(r => ({
        source_module: 'reminders', source_type: 'practice_reminder', source_id: r.id, client_id: r.client_id,
        role: 'assignee', title: r.title || r.reminder_type, client_name: r.practice_clients?.name || null,
        client_risk_rating: r.practice_clients?.risk_rating || null,
        due_date: r.due_date, status: r.status, manual_priority: null,
        severity_band: r.severity === 'urgent' ? 'high' : (r.severity || null), blocked: false, waiting_on: null,
        deep_link: '/practice/reminders.html?open=' + r.id,
    }));
}

async function _fetchRisks(cid, tmId) {
    const { data, error } = await supabase.from('practice_risks')
        .select('id, title, category, inherent_risk, status, next_review_date, owner_team_member_id, linked_client_id, practice_clients:linked_client_id(name, risk_rating)')
        .eq('company_id', cid)
        .not('status', 'in', '("closed","cancelled")')
        .eq('owner_team_member_id', tmId);
    if (error) { console.error('[work-queue] risks', error.message); return []; }

    return (data || []).map(r => ({
        source_module: 'risk-register', source_type: 'practice_risk', source_id: r.id, client_id: r.linked_client_id,
        role: 'owner', title: r.title, client_name: r.practice_clients?.name || null,
        client_risk_rating: r.practice_clients?.risk_rating || null,
        due_date: r.next_review_date, status: r.status, manual_priority: null,
        severity_band: r.inherent_risk >= 20 ? 'critical' : r.inherent_risk >= 15 ? 'high' : 'medium',
        blocked: false, waiting_on: null,
        deep_link: '/practice/risk-register.html?open=' + r.id,
    }));
}

async function _fetchQmsReviews(cid, tmId) {
    const { data, error } = await supabase.from('practice_quality_reviews')
        .select('id, review_title, status, client_id, assigned_reviewer_team_member_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .in('status', ['draft', 'in_review', 'needs_correction'])
        .eq('assigned_reviewer_team_member_id', tmId);
    if (error) { console.error('[work-queue] qms reviews', error.message); return []; }

    return (data || []).map(r => ({
        source_module: 'qms', source_type: 'practice_quality_review', source_id: r.id, client_id: r.client_id,
        role: 'reviewer', title: r.review_title, client_name: r.practice_clients?.name || null,
        client_risk_rating: r.practice_clients?.risk_rating || null,
        due_date: null, status: r.status, manual_priority: null,
        severity_band: r.status === 'needs_correction' ? 'high' : null, blocked: false,
        waiting_on: r.status === 'in_review' ? 'me' : null,
        deep_link: '/practice/quality-management.html?open=' + r.id,
    }));
}

async function _fetchQmsFindings(cid, tmId) {
    const { data, error } = await supabase.from('practice_quality_findings')
        .select('id, finding_title, status, severity, due_date, responsible_team_member_id, review_id')
        .eq('company_id', cid)
        .in('status', ['open', 'in_progress'])
        .eq('responsible_team_member_id', tmId);
    if (error) { console.error('[work-queue] qms findings', error.message); return []; }

    return (data || []).map(f => ({
        source_module: 'qms', source_type: 'practice_quality_finding', source_id: f.id, client_id: null,
        role: 'responsible', title: f.finding_title, client_name: null, client_risk_rating: null,
        due_date: f.due_date, status: f.status, manual_priority: null,
        severity_band: f.severity, blocked: false, waiting_on: null,
        deep_link: '/practice/quality-management.html?finding=' + f.id,
    }));
}

async function _fetchCompliancePacks(cid, tmId) {
    const { data, error } = await supabase.from('practice_compliance_packs')
        .select('id, pack_name, pack_type, status, readiness_status, client_id, owner_team_member_id, reviewer_team_member_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .not('status', 'in', '("completed","cancelled")')
        .or(`owner_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`);
    if (error) { console.error('[work-queue] compliance packs', error.message); return []; }

    return (data || []).map(p => {
        let role = 'owner', waitingOn = null;
        if (p.reviewer_team_member_id === tmId && p.status === 'ready_for_review') { role = 'reviewer'; waitingOn = 'me'; }
        else if (p.owner_team_member_id === tmId) { role = 'owner'; waitingOn = p.status === 'ready_for_review' ? 'others' : null; }

        return {
            source_module: 'compliance-packs', source_type: 'practice_compliance_pack', source_id: p.id, client_id: p.client_id,
            role, title: p.pack_name || p.pack_type, client_name: p.practice_clients?.name || null,
            client_risk_rating: p.practice_clients?.risk_rating || null,
            due_date: null, status: p.status, manual_priority: null,
            severity_band: null, blocked: p.readiness_status === 'blocked', waiting_on: waitingOn,
            deep_link: '/practice/compliance-packs.html?open=' + p.id,
        };
    });
}

async function _fetchDocumentRequests(cid, tmId) {
    const { data, error } = await supabase.from('practice_document_requests')
        .select('id, request_title, document_category, request_status, required_by_date, assigned_team_member_id, client_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .in('request_status', ['requested', 'reminder_sent', 'partially_received'])
        .eq('assigned_team_member_id', tmId);
    if (error) { console.error('[work-queue] document requests', error.message); return []; }

    return (data || []).map(d => ({
        source_module: 'document-requests', source_type: 'practice_document_request', source_id: d.id, client_id: d.client_id,
        role: 'assignee', title: d.request_title || d.document_category, client_name: d.practice_clients?.name || null,
        client_risk_rating: d.practice_clients?.risk_rating || null,
        due_date: d.required_by_date, status: d.request_status, manual_priority: null,
        severity_band: null, blocked: false, waiting_on: 'others',
        deep_link: '/practice/document-requests.html?open=' + d.id,
    }));
}

async function _fetchCommunications(cid, tmId) {
    const { data, error } = await supabase.from('practice_client_communications')
        .select('id, subject, communication_type, response_status, response_due_date, response_required, assigned_team_member_id, client_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .eq('response_required', true)
        .in('response_status', ['waiting', 'overdue'])
        .eq('assigned_team_member_id', tmId);
    if (error) { console.error('[work-queue] communications', error.message); return []; }

    return (data || []).map(c => ({
        source_module: 'communications', source_type: 'practice_client_communication', source_id: c.id, client_id: c.client_id,
        role: 'assignee', title: c.subject || c.communication_type, client_name: c.practice_clients?.name || null,
        client_risk_rating: c.practice_clients?.risk_rating || null,
        due_date: c.response_due_date, status: c.response_status, manual_priority: null,
        severity_band: c.response_status === 'overdue' ? 'high' : null, blocked: false, waiting_on: 'others',
        deep_link: '/practice/communications.html?open=' + c.id,
    }));
}

async function _fetchTaxReturns(cid, tmId, table, category, urlBase) {
    const { data, error } = await supabase.from(table)
        .select('id, tax_year, status, client_id, responsible_team_member_id, reviewer_team_member_id, practice_clients:client_id(name, risk_rating)')
        .eq('company_id', cid)
        .not('status', 'in', '("completed","cancelled")')
        .or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`);
    if (error) { console.error(`[work-queue] ${table}`, error.message); return []; }

    return (data || []).map(r => {
        let role = 'preparer', waitingOn = null;
        if (r.reviewer_team_member_id === tmId && r.status === 'ready_for_review') { role = 'reviewer'; waitingOn = 'me'; }
        else if (r.responsible_team_member_id === tmId) { role = 'preparer'; waitingOn = r.status === 'ready_for_review' ? 'others' : null; }

        const clientName = r.practice_clients?.name || 'Unknown client';
        return {
            source_module: category, source_type: table, source_id: r.id, client_id: r.client_id,
            role, title: `${clientName} — ${r.tax_year || 'tax return'}`, client_name: clientName,
            client_risk_rating: r.practice_clients?.risk_rating || null,
            due_date: null, status: r.status, manual_priority: null,
            severity_band: null, blocked: false, waiting_on: waitingOn,
            deep_link: `${urlBase}?open=${r.id}`,
        };
    });
}

// ── Core aggregator (cached) ────────────────────────────────────────────────
// One request can fire /summary, /my-work, /today, /overdue, /waiting-on-me,
// etc. in quick succession on page load — this cache means the ~11 source
// queries only actually run once per team member per short window, not once
// per endpoint. Short TTL, invalidated on the next natural expiry (there is
// nothing to invalidate on — this router never writes to source tables).

const _cache = new Map(); // `${cid}:${tmId}` -> { data, expiresAt }
const CACHE_TTL_MS = 15000;

async function _buildActiveQueue(cid, tmId) {
    const cacheKey = `${cid}:${tmId}`;
    const cached = _cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const today = _today();
    const results = await Promise.all([
        _fetchTasks(cid, tmId),
        _fetchDeadlines(cid, tmId),
        _fetchReminders(cid, tmId),
        _fetchRisks(cid, tmId),
        _fetchQmsReviews(cid, tmId),
        _fetchQmsFindings(cid, tmId),
        _fetchCompliancePacks(cid, tmId),
        _fetchDocumentRequests(cid, tmId),
        _fetchCommunications(cid, tmId),
        _fetchTaxReturns(cid, tmId, 'practice_individual_tax_returns', 'tax-individual', '/practice/individual-tax.html'),
        _fetchTaxReturns(cid, tmId, 'practice_company_tax_returns', 'tax-company', '/practice/company-tax.html'),
    ]);

    const items = results.flat().map(item => _scoreItem(item, today));
    items.sort((a, b) => b.priority_score - a.priority_score);

    _cache.set(cacheKey, { data: items, expiresAt: Date.now() + CACHE_TTL_MS });
    return items;
}

// Codebox 58 (Work Delegation) calls this after any ownership change so
// Work Hub, Planning Board, and Resource Forecast (which all read through
// this same cache) reflect the new owner immediately instead of waiting up
// to CACHE_TTL_MS — "delegation must immediately affect Work Queue" from
// that codebox's spec, without adding a second cache layer anywhere.
function _invalidateCache(cid) {
    for (const key of _cache.keys()) {
        if (key.startsWith(`${cid}:`)) _cache.delete(key);
    }
}

async function _fetchCompletedRecent(cid, tmId, days) {
    const since = _daysFromNow(-days);
    const [tasks, compliance, taxIndiv, taxCo] = await Promise.all([
        supabase.from('practice_tasks').select('id, title, status, updated_at, client_id, practice_clients:client_id(name)')
            .eq('company_id', cid).eq('status', 'completed').gte('updated_at', since)
            .or(`assigned_to.eq.${tmId},preparer_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId},approver_team_member_id.eq.${tmId}`),
        supabase.from('practice_compliance_packs').select('id, pack_name, pack_type, status, updated_at, client_id, practice_clients:client_id(name)')
            .eq('company_id', cid).eq('status', 'completed').gte('updated_at', since)
            .or(`owner_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`),
        supabase.from('practice_individual_tax_returns').select('id, tax_year, status, updated_at, client_id, practice_clients:client_id(name)')
            .eq('company_id', cid).eq('status', 'completed').gte('updated_at', since)
            .or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`),
        supabase.from('practice_company_tax_returns').select('id, tax_year, status, updated_at, client_id, practice_clients:client_id(name)')
            .eq('company_id', cid).eq('status', 'completed').gte('updated_at', since)
            .or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`),
    ]);

    const items = [];
    (tasks.data || []).forEach(t => items.push({ source_module: 'tasks', source_type: 'practice_task', source_id: t.id, title: t.title, client_name: t.practice_clients?.name || null, completed_at: t.updated_at, deep_link: '/practice/tasks.html?open=' + t.id }));
    (compliance.data || []).forEach(p => items.push({ source_module: 'compliance-packs', source_type: 'practice_compliance_pack', source_id: p.id, title: p.pack_name || p.pack_type, client_name: p.practice_clients?.name || null, completed_at: p.updated_at, deep_link: '/practice/compliance-packs.html?open=' + p.id }));
    (taxIndiv.data || []).forEach(r => items.push({ source_module: 'tax-individual', source_type: 'practice_individual_tax_returns', source_id: r.id, title: `${r.practice_clients?.name || 'Unknown client'} — ${r.tax_year || 'tax return'}`, client_name: r.practice_clients?.name || null, completed_at: r.updated_at, deep_link: '/practice/individual-tax.html?open=' + r.id }));
    (taxCo.data || []).forEach(r => items.push({ source_module: 'tax-company', source_type: 'practice_company_tax_returns', source_id: r.id, title: `${r.practice_clients?.name || 'Unknown client'} — ${r.tax_year || 'tax return'}`, client_name: r.practice_clients?.name || null, completed_at: r.updated_at, deep_link: '/practice/company-tax.html?open=' + r.id }));

    items.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
    return items;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Codebox 56 (Planning Board) reuses this router's own endpoints to open a
// specific employee's queue ("Work Queue: Open directly into employee
// queue"). ?team_member_id= is honoured ONLY when the caller's own role is
// manager-level — otherwise it's silently ignored and the caller always
// gets their own queue. This keeps Work Hub self-scoped-by-default for
// every other caller; a regular staff member cannot view a colleague's
// queue by editing the URL.
async function _requireTeamMember(req, res) {
    const cid = req.companyId;
    const me = await _myTeamMemberId(cid, req.user);

    const requestedId = req.query.team_member_id ? parseInt(req.query.team_member_id, 10) : null;
    if (requestedId && me && teamAccess.isManagerRole(me.role)) {
        const { data } = await supabase.from('practice_team_members').select('id, display_name, role').eq('id', requestedId).eq('company_id', cid).eq('is_active', true).maybeSingle();
        if (data) return data;
    }

    if (!me) {
        res.json({ team_member_id: null, unlinked: true, message: 'Your login is not linked to a Practice team member yet — ask a partner to link your account under Team.' });
        return null;
    }
    return me;
}

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;

        const today = _today();
        const items = await _buildActiveQueue(cid, member.id);
        const upcomingEnd = _daysFromNow(7);

        const counts = {
            my_work: items.length,
            today: items.filter(i => i.due_date === today).length,
            overdue: items.filter(i => i.due_date && i.due_date < today).length,
            upcoming: items.filter(i => i.due_date && i.due_date > today && i.due_date <= upcomingEnd).length,
            waiting_on_me: items.filter(i => i.waiting_on === 'me').length,
            waiting_on_others: items.filter(i => i.waiting_on === 'others').length,
        };

        const { count: unreadNotifications } = await supabase.from('practice_notifications').select('id', { count: 'exact', head: true })
            .eq('company_id', cid).eq('assigned_team_member_id', member.id).eq('notification_status', 'new');
        counts.notifications_unread = unreadNotifications || 0;

        res.json({
            team_member_id: member.id, team_member_name: member.display_name, team_member_role: member.role,
            counts, top_priority: items.slice(0, 5),
        });
    } catch (err) {
        console.error('GET /api/practice/work-queue/summary', err);
        res.status(500).json({ error: 'Failed to load work queue summary.' });
    }
});

function _applyCommonFilters(items, query) {
    let out = items;
    if (query.source_module) out = out.filter(i => i.source_module === query.source_module);
    if (query.search) {
        const s = String(query.search).toLowerCase();
        out = out.filter(i => `${i.title} ${i.client_name || ''}`.toLowerCase().includes(s));
    }
    return out;
}

router.get('/my-work', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const items = _applyCommonFilters(await _buildActiveQueue(cid, member.id), req.query);
        if (req.query.source_module || req.query.search) await _writeEvent(cid, member.id, 'queue_filtered', null, null, null, req.user?.userId, null, { query: req.query });
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/my-work', err);
        res.status(500).json({ error: 'Failed to load work queue.' });
    }
});

router.get('/today', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const today = _today();
        const items = _applyCommonFilters((await _buildActiveQueue(cid, member.id)).filter(i => i.due_date === today), req.query);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/today', err);
        res.status(500).json({ error: 'Failed to load today\'s work.' });
    }
});

router.get('/overdue', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const today = _today();
        const items = _applyCommonFilters((await _buildActiveQueue(cid, member.id)).filter(i => i.due_date && i.due_date < today), req.query);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/overdue', err);
        res.status(500).json({ error: 'Failed to load overdue work.' });
    }
});

router.get('/upcoming', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const today = _today();
        const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
        const end = _daysFromNow(days);
        const items = _applyCommonFilters((await _buildActiveQueue(cid, member.id)).filter(i => i.due_date && i.due_date > today && i.due_date <= end), req.query);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/upcoming', err);
        res.status(500).json({ error: 'Failed to load upcoming work.' });
    }
});

router.get('/waiting-on-me', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const items = _applyCommonFilters((await _buildActiveQueue(cid, member.id)).filter(i => i.waiting_on === 'me'), req.query);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/waiting-on-me', err);
        res.status(500).json({ error: 'Failed to load items waiting on you.' });
    }
});

router.get('/waiting-on-others', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const items = _applyCommonFilters((await _buildActiveQueue(cid, member.id)).filter(i => i.waiting_on === 'others'), req.query);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/waiting-on-others', err);
        res.status(500).json({ error: 'Failed to load items waiting on others.' });
    }
});

router.get('/completed', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
        const items = await _fetchCompletedRecent(cid, member.id, days);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/completed', err);
        res.status(500).json({ error: 'Failed to load recently completed work.' });
    }
});

router.get('/notifications', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const { data, error } = await supabase.from('practice_notifications').select('*')
            .eq('company_id', cid).eq('assigned_team_member_id', member.id)
            .not('notification_status', 'in', '("archived","cancelled")')
            .order('created_at', { ascending: false }).limit(limit);
        if (error) throw error;
        res.json({ notifications: data || [], total: (data || []).length });
    } catch (err) {
        console.error('GET /api/practice/work-queue/notifications', err);
        res.status(500).json({ error: 'Failed to load notifications.' });
    }
});

// ── Preferences ───────────────────────────────────────────────────────────────

router.get('/preferences', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const { data } = await supabase.from('practice_work_queue_preferences').select('*').eq('company_id', cid).eq('team_member_id', member.id).maybeSingle();
        res.json({
            preferences: data || { team_member_id: member.id, default_view: 'my_work', show_completed: false, show_notifications: true, show_overdue_first: true, collapsed_sections: [], metadata: {} },
            team_member: { id: member.id, display_name: member.display_name, role: member.role },
        });
    } catch (err) {
        console.error('GET /api/practice/work-queue/preferences', err);
        res.status(500).json({ error: 'Failed to load preferences.' });
    }
});

router.put('/preferences', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const body = req.body || {};
        const patch = {
            company_id: cid, team_member_id: member.id,
            default_view: body.default_view || 'my_work',
            show_completed: body.show_completed !== undefined ? !!body.show_completed : false,
            show_notifications: body.show_notifications !== undefined ? !!body.show_notifications : true,
            show_overdue_first: body.show_overdue_first !== undefined ? !!body.show_overdue_first : true,
            collapsed_sections: body.collapsed_sections || [],
            metadata: body.metadata || {},
        };
        const { data, error } = await supabase.from('practice_work_queue_preferences').upsert(patch, { onConflict: 'company_id,team_member_id' }).select().single();
        if (error) throw error;
        res.json({ preferences: data });
    } catch (err) {
        console.error('PUT /api/practice/work-queue/preferences', err);
        res.status(500).json({ error: 'Failed to save preferences.' });
    }
});

// ── Events ────────────────────────────────────────────────────────────────────
// Not part of the spec's literal endpoint list, but required so the
// append-only events table (mandated in the DATABASE section) can ever be
// populated — the frontend calls this for page_opened / item_opened /
// queue_filtered, and for item_completed / item_snoozed on the Notifications
// quick-actions (which call notifications.js's own endpoints for the actual
// state change, then log the interaction here). item_delegated is
// schema-supported but not wired to any UI action yet — reserved for a
// future reassignment feature.

router.post('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _myTeamMemberId(cid, req.user);
        const body = req.body || {};
        const validTypes = ['page_opened', 'item_opened', 'item_completed', 'item_snoozed', 'item_delegated', 'queue_filtered'];
        if (!validTypes.includes(body.event_type)) return res.status(422).json({ error: `event_type must be one of ${validTypes.join(', ')}.` });

        await _writeEvent(cid, member ? member.id : null, body.event_type, body.source_module || null, body.source_type || null, body.source_id || null, req.user?.userId, body.notes || null, body.metadata || {});
        res.status(201).json({ logged: true });
    } catch (err) {
        console.error('POST /api/practice/work-queue/events', err);
        res.status(500).json({ error: 'Failed to log event.' });
    }
});

router.get('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const member = await _requireTeamMember(req, res);
        if (!member) return;
        const { data, error } = await supabase.from('practice_work_queue_events').select('*')
            .eq('company_id', cid).eq('team_member_id', member.id)
            .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/work-queue/events', err);
        res.status(500).json({ error: 'Failed to load work queue history.' });
    }
});

module.exports = router;

// Codebox 56 (Planning Board) reuses this directly — attached to the
// exported router function object so `require('./work-queue').buildActiveQueue(cid, tmId)`
// works in-process without a second HTTP round-trip and without duplicating
// the 11-source aggregation or priority-scoring logic. Same reuse pattern as
// management-dashboard.js's computeSummary/computeAlerts (Codebox 51/52) and
// alert-rules.js's getRule/getRules (Codebox 53).
module.exports.buildActiveQueue = _buildActiveQueue;
module.exports.invalidateCache = _invalidateCache;
