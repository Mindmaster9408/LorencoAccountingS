'use strict';

// Codebox 57 — Practice Resource Forecasting + Future Capacity Planning
// "Will we have enough people and hours next month?" — deterministic,
// explainable, forward-looking capacity projection. NOT AI. NOT automatic
// scheduling. NOT calendar sync. NOT leave management. NOT hiring
// recommendations. No work is ever automatically moved.
//
// This module reads, it never owns data. Every hour figure is computed by
// reusing capacity.js's buildTeamCapacity() and planning-board.js's
// buildTeamItemPool() (which itself reuses work-queue.js's
// buildActiveQueue()) in-process — no source-table querying or business
// logic is re-implemented here. The only new persisted data is manager
// forecast snapshots.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const capacity = require('./capacity');
const planningBoard = require('./planning-board');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const ALLOWED_WEEKS = [4, 6, 8, 12];
const DEFAULT_WEEKS = 6;
const SNAPSHOT_STATUSES = ['active', 'archived'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _todayStr() { return new Date().toISOString().slice(0, 10); }
function _mondayOf(dateStr) {
    const d = new Date((dateStr || _todayStr()) + 'T00:00:00');
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
}
function _addDays(dateStr, n) { return new Date(new Date(dateStr + 'T00:00:00').getTime() + n * 86400000).toISOString().slice(0, 10); }
function _round1(n) { return Math.round(n * 10) / 10; }

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role').eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!member || !MANAGER_ROLES.includes(member.role)) {
        res.status(403).json({ error: 'Resource Forecasting is only available to owners, partners, admins, and practice managers.' });
        return null;
    }
    return member;
}

function _resolveWeeks(raw) {
    const n = parseInt(raw, 10);
    return ALLOWED_WEEKS.includes(n) ? n : DEFAULT_WEEKS;
}

async function _writeEvent(cid, snapshotId, eventType, actorUserId, notes, meta) {
    await supabase.from('practice_resource_forecast_events').insert({
        company_id: cid, snapshot_id: snapshotId || null, event_type: eventType,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

// ── Load Estimation Engine ───────────────────────────────────────────────────
// Deterministic placeholders — NOT real estimates. Documented here exactly
// as the spec requires ("Document all placeholders. Do not pretend these
// are exact."). Only practice_tasks carries a genuine per-item estimate
// (work-queue.js's _fetchTasks exposes it as item.known_hours) — every
// other source table has no hours column at all.
//
//   actual_estimate      — task.estimated_hours was actually set by a user
//   default_placeholder  — no real number exists; a documented placeholder is used
//   unknown               — a source_module/role combination this table doesn't cover (defensive fallback only; should not occur in practice)
//
// Placeholder table:
//   task (preparer/assignee)      1 hour    — "task placeholder"
//   task (reviewer/approver)      0.5 hour  — "review item"
//   deadline                      0.5 hour  — "deadline admin item"
//   reminder / document / comms   0.25 hour — "document follow-up"
//   risk review / QMS review      0.5 hour  — "review item"
//   compliance pack (owner)       1 hour    — treated like production work
//   compliance pack (reviewer)    0.5 hour  — "review item"
//   tax return (preparer)         1 hour    — "task placeholder"
//   tax return (reviewer)         0.5 hour  — "review item"
function _estimateHours(item) {
    if (item.known_hours != null && !isNaN(Number(item.known_hours))) {
        return { hours: Number(item.known_hours), confidence: 'actual_estimate' };
    }
    const reviewRole = item.role === 'reviewer' || item.role === 'approver';
    switch (item.source_module) {
        case 'tasks': return { hours: reviewRole ? 0.5 : 1, confidence: 'default_placeholder' };
        case 'deadlines': return { hours: 0.5, confidence: 'default_placeholder' };
        case 'reminders':
        case 'document-requests':
        case 'communications': return { hours: 0.25, confidence: 'default_placeholder' };
        case 'risk-register':
        case 'qms': return { hours: 0.5, confidence: 'default_placeholder' };
        case 'compliance-packs': return { hours: reviewRole ? 0.5 : 1, confidence: 'default_placeholder' };
        case 'tax-individual':
        case 'tax-company': return { hours: reviewRole ? 0.5 : 1, confidence: 'default_placeholder' };
        default: return { hours: 1, confidence: 'unknown' };
    }
}

// ── Pressure category mapping ────────────────────────────────────────────────

function _pressureCategory(item) {
    if (item.role === 'reviewer' || item.role === 'approver') return 'review';
    if (item.source_module === 'deadlines') return 'deadline';
    if (item.source_module === 'tax-individual' || item.source_module === 'tax-company') return 'tax';
    if (item.source_module === 'qms') return 'qms';
    if (item.source_module === 'risk-register') return 'risk';
    if (['document-requests', 'communications', 'reminders'].includes(item.source_module)) return 'document';
    return null;
}

function _capacityStatus(pct) {
    if (pct == null) return 'unknown';
    if (pct < 50) return 'under_capacity';
    if (pct <= 85) return 'normal';
    if (pct <= 100) return 'high';
    if (pct <= 120) return 'over_capacity';
    return 'critical';
}

// ── Forecast item pool (reused, estimated, week-tagged) ─────────────────────

async function _buildEstimatedPool(cid) {
    const pool = await planningBoard.buildTeamItemPool(cid);
    const items = pool.items.map(item => {
        const est = _estimateHours(item);
        return Object.assign({}, item, {
            estimated_hours: est.hours,
            confidence: est.confidence,
            pressure_category: _pressureCategory(item),
        });
    });
    return { members: pool.members, items };
}

// Assigns each item a week_bucket index (0-based) within [weekStart, weekStart + weeks*7).
// Items due before weekStart (already overdue) are pulled forward into week 0 —
// documented choice: that work still needs doing, and week 0 is the most
// immediate planning horizon. Items due after the forecast window, or with
// no due_date at all, get week_bucket = null ("unscheduled") and are
// reported separately rather than silently guessed into a week.
function _assignWeekBucket(items, weekStart, weeks) {
    const windowEnd = _addDays(weekStart, weeks * 7 - 1);
    return items.map(item => {
        let weekBucket = null;
        if (item.due_date) {
            if (item.due_date < weekStart) weekBucket = 0;
            else if (item.due_date <= windowEnd) weekBucket = Math.floor((_daysBetween(weekStart, item.due_date)) / 7);
        }
        return Object.assign({}, item, { week_bucket: weekBucket });
    });
}
function _daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

// ── Weekly forecast buckets ──────────────────────────────────────────────────

async function _buildWeeklyForecast(cid, weekStart, weeks, teamMemberId) {
    const [{ items }, teamCapacity] = await Promise.all([_buildEstimatedPool(cid), capacity.buildTeamCapacity(cid)]);

    const capacityRows = teamMemberId ? teamCapacity.filter(m => m.member_id === teamMemberId) : teamCapacity;
    const weeklyCapacityHours = capacityRows.filter(m => m.capacity_is_active).reduce((s, m) => s + (m.weekly_capacity_hours || 0), 0);

    const scoped = teamMemberId ? items.filter(i => i.team_member_id === teamMemberId) : items;
    const bucketed = _assignWeekBucket(scoped, weekStart, weeks);
    const unscheduled = bucketed.filter(i => i.week_bucket == null);

    const weeklyBuckets = [];
    for (let w = 0; w < weeks; w++) {
        const wStart = _addDays(weekStart, w * 7);
        const wEnd = _addDays(weekStart, w * 7 + 6);
        const weekItems = bucketed.filter(i => i.week_bucket === w);

        const sumBy = (predicate) => _round1(weekItems.filter(predicate).reduce((s, i) => s + i.estimated_hours, 0));
        const allocatedHours = _round1(weekItems.reduce((s, i) => s + i.estimated_hours, 0));
        const utilization = weeklyCapacityHours > 0 ? _round1((allocatedHours / weeklyCapacityHours) * 100) : null;

        weeklyBuckets.push({
            week_start: wStart, week_end: wEnd,
            capacity_hours: _round1(weeklyCapacityHours),
            allocated_hours: allocatedHours,
            deadline_pressure: sumBy(i => i.pressure_category === 'deadline'),
            review_pressure: sumBy(i => i.pressure_category === 'review'),
            tax_pressure: sumBy(i => i.pressure_category === 'tax'),
            qms_pressure: sumBy(i => i.pressure_category === 'qms'),
            risk_pressure: sumBy(i => i.pressure_category === 'risk'),
            document_pressure: sumBy(i => i.pressure_category === 'document'),
            capacity_gap: _round1(allocatedHours - weeklyCapacityHours),
            utilization_percentage: utilization,
            status: _capacityStatus(utilization),
            item_count: weekItems.length,
        });
    }

    return { weekly: weeklyBuckets, unscheduled_count: unscheduled.length, all_items: bucketed, capacity_rows: capacityRows };
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.start_date);
        const weeks = _resolveWeeks(req.query.weeks);
        const teamMemberId = req.query.team_member_id ? parseInt(req.query.team_member_id, 10) : null;

        const { weekly, unscheduled_count } = await _buildWeeklyForecast(cid, weekStart, weeks, teamMemberId);

        const totalCapacity = _round1(weekly.reduce((s, w) => s + w.capacity_hours, 0));
        const totalAllocated = _round1(weekly.reduce((s, w) => s + w.allocated_hours, 0));
        const overloadedWeeks = weekly.filter(w => ['over_capacity', 'critical'].includes(w.status)).length;
        const criticalWeeks = weekly.filter(w => w.status === 'critical').length;

        res.json({
            forecast_start_date: weekStart, forecast_end_date: _addDays(weekStart, weeks * 7 - 1), forecast_weeks: weeks,
            total_capacity_hours: totalCapacity, total_allocated_hours: totalAllocated,
            capacity_gap: _round1(totalAllocated - totalCapacity),
            overloaded_weeks: overloadedWeeks, critical_weeks: criticalWeeks,
            unscheduled_item_count: unscheduled_count,
        });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/summary', err);
        res.status(500).json({ error: 'Failed to load forecast summary.' });
    }
});

// ── GET /forecast ─────────────────────────────────────────────────────────────

router.get('/forecast', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.start_date);
        const weeks = _resolveWeeks(req.query.weeks);
        const teamMemberId = req.query.team_member_id ? parseInt(req.query.team_member_id, 10) : null;

        const { weekly, unscheduled_count } = await _buildWeeklyForecast(cid, weekStart, weeks, teamMemberId);

        res.json({
            forecast_start_date: weekStart, forecast_end_date: _addDays(weekStart, weeks * 7 - 1), forecast_weeks: weeks,
            team_member_id: teamMemberId,
            weekly, unscheduled_item_count: unscheduled_count,
        });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/forecast', err);
        res.status(500).json({ error: 'Failed to compute forecast.' });
    }
});

// ── GET /team ─────────────────────────────────────────────────────────────────

router.get('/team', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.start_date);
        const weeks = _resolveWeeks(req.query.weeks);

        const [{ items }, teamCapacity] = await Promise.all([_buildEstimatedPool(cid), capacity.buildTeamCapacity(cid)]);
        const bucketed = _assignWeekBucket(items, weekStart, weeks);

        const team = teamCapacity.map(cap => {
            const memberItems = bucketed.filter(i => i.team_member_id === cap.member_id);
            const weeklyCap = cap.capacity_is_active ? (cap.weekly_capacity_hours || 0) : 0;

            const forecastWeeks = [];
            for (let w = 0; w < weeks; w++) {
                const wItems = memberItems.filter(i => i.week_bucket === w);
                const allocated = _round1(wItems.reduce((s, i) => s + i.estimated_hours, 0));
                const utilization = weeklyCap > 0 ? _round1((allocated / weeklyCap) * 100) : null;
                forecastWeeks.push({
                    week_start: _addDays(weekStart, w * 7), week_end: _addDays(weekStart, w * 7 + 6),
                    capacity_hours: _round1(weeklyCap), allocated_hours: allocated,
                    utilization_percentage: utilization, status: _capacityStatus(utilization),
                });
            }

            const totalCapacity = _round1(weeklyCap * weeks);
            const totalAllocated = _round1(forecastWeeks.reduce((s, w) => s + w.allocated_hours, 0));

            return {
                team_member_id: cap.member_id, display_name: cap.display_name, role: cap.role,
                weekly_capacity: cap.weekly_capacity_hours,
                forecast_weeks: forecastWeeks,
                total_capacity: totalCapacity, total_allocated: totalAllocated,
                capacity_gap: _round1(totalAllocated - totalCapacity),
                overloaded_weeks: forecastWeeks.filter(w => ['over_capacity', 'critical'].includes(w.status)).length,
                critical_weeks: forecastWeeks.filter(w => w.status === 'critical').length,
                status: _capacityStatus(totalCapacity > 0 ? _round1((totalAllocated / totalCapacity) * 100) : null),
                work_queue_link: '/practice/work-queue.html?team_member_id=' + cap.member_id,
            };
        }).sort((a, b) => {
            const order = { critical: 0, over_capacity: 1, high: 2, normal: 3, under_capacity: 4, unknown: 5 };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
        });

        res.json({ forecast_start_date: weekStart, forecast_weeks: weeks, team });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/team', err);
        res.status(500).json({ error: 'Failed to compute team forecast.' });
    }
});

// ── GET /clients ──────────────────────────────────────────────────────────────

router.get('/clients', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.start_date);
        const weeks = _resolveWeeks(req.query.weeks);
        const today = _todayStr();

        const { items } = await _buildEstimatedPool(cid);
        const bucketed = _assignWeekBucket(items, weekStart, weeks).filter(i => i.week_bucket != null);

        const byClient = {};
        bucketed.forEach(i => {
            const key = i.client_id != null ? 'id:' + i.client_id : (i.client_name ? 'name:' + i.client_name : null);
            if (!key) return; // internal/no-client items excluded from client forecast
            if (!byClient[key]) byClient[key] = { client_id: i.client_id, client_name: i.client_name || 'Unknown client', items: [] };
            byClient[key].items.push(i);
        });

        const clients = Object.values(byClient).map(c => {
            const hours = _round1(c.items.reduce((s, i) => s + i.estimated_hours, 0));
            const hasOverdue = c.items.some(i => i.due_date && i.due_date < today);
            let pressureStatus = 'normal';
            if (hours > 30 || hasOverdue) pressureStatus = 'critical';
            else if (hours > 15) pressureStatus = 'high';
            else if (hours > 5) pressureStatus = 'medium';

            return {
                client_id: c.client_id, client_name: c.client_name,
                estimated_hours_next_weeks: hours,
                deadline_count: c.items.filter(i => i.source_module === 'deadlines').length,
                tax_item_count: c.items.filter(i => ['tax-individual', 'tax-company'].includes(i.source_module)).length,
                document_count: c.items.filter(i => ['document-requests', 'communications'].includes(i.source_module)).length,
                risk_count: c.items.filter(i => i.source_module === 'risk-register').length,
                pressure_status: pressureStatus,
            };
        }).sort((a, b) => b.estimated_hours_next_weeks - a.estimated_hours_next_weeks);

        res.json({ forecast_start_date: weekStart, forecast_weeks: weeks, clients });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/clients', err);
        res.status(500).json({ error: 'Failed to compute client forecast.' });
    }
});

// ── GET /deadlines ────────────────────────────────────────────────────────────
// Direct query, not the item pool — same reasoning as Planning Board's own
// deadline timeline (Codebox 56): buildActiveQueue() only ever returns
// items with a resolved assignee, so an unowned deadline would otherwise be
// invisible to this forecast even though it's exactly the kind of thing a
// manager needs to see coming.

router.get('/deadlines', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const weekStart = _mondayOf(req.query.start_date);
        const weeks = _resolveWeeks(req.query.weeks);
        const windowEnd = _addDays(weekStart, weeks * 7 - 1);

        const { data, error } = await supabase.from('practice_deadlines')
            .select('id, title, due_date, status, priority, responsible_team_member_id, client_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
            .eq('company_id', cid)
            .not('status', 'in', '("completed","submitted","missed","cancelled")')
            .lte('due_date', windowEnd)
            .order('due_date', { ascending: true });
        if (error) throw error;

        const today = _todayStr();
        const deadlines = (data || []).map(d => {
            const isOverdue = d.due_date < today;
            const weekBucket = d.due_date < weekStart ? 0 : (d.due_date <= windowEnd ? Math.floor(_daysBetween(weekStart, d.due_date) / 7) : null);
            const riskLevel = isOverdue || d.priority === 'urgent' ? 'critical' : (d.priority === 'high' ? 'high' : 'normal');
            return {
                id: d.id, title: d.title, client_name: d.practice_clients?.name || null,
                due_date: d.due_date, is_overdue: isOverdue,
                owner_team_member_id: d.responsible_team_member_id,
                owner_name: d.practice_team_members?.display_name || 'Unassigned',
                estimated_hours: 0.5, confidence: 'default_placeholder',
                risk_level: riskLevel, week_bucket: weekBucket,
                deep_link: '/practice/deadlines.html?open=' + d.id,
            };
        });

        res.json({ forecast_start_date: weekStart, forecast_weeks: weeks, deadlines, total: deadlines.length, overdue_count: deadlines.filter(d => d.is_overdue).length });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/deadlines', err);
        res.status(500).json({ error: 'Failed to compute deadline forecast.' });
    }
});

// ── Snapshots ─────────────────────────────────────────────────────────────────

async function _computeFullForecast(cid, weekStart, weeks) {
    const [{ weekly, unscheduled_count }, teamRes, clientsRes, deadlinesRes] = await Promise.all([
        _buildWeeklyForecast(cid, weekStart, weeks, null),
        _computeTeamForecast(cid, weekStart, weeks),
        _computeClientForecast(cid, weekStart, weeks),
        _computeDeadlineForecast(cid, weekStart, weeks),
    ]);

    const totalCapacity = _round1(weekly.reduce((s, w) => s + w.capacity_hours, 0));
    const totalAllocated = _round1(weekly.reduce((s, w) => s + w.allocated_hours, 0));

    return {
        forecast_data: { weekly, team: teamRes, clients: clientsRes, deadlines: deadlinesRes, unscheduled_item_count: unscheduled_count },
        summary_data: {
            total_capacity_hours: totalCapacity, total_allocated_hours: totalAllocated,
            capacity_gap: _round1(totalAllocated - totalCapacity),
            overloaded_weeks: weekly.filter(w => ['over_capacity', 'critical'].includes(w.status)).length,
            critical_weeks: weekly.filter(w => w.status === 'critical').length,
        },
    };
}

// Internal, non-HTTP variants of the /team, /clients, /deadlines logic above —
// reused by POST /snapshots so a saved snapshot freezes the exact same
// computation a manager sees live, without going through a second HTTP hop.
async function _computeTeamForecast(cid, weekStart, weeks) {
    const [{ items }, teamCapacity] = await Promise.all([_buildEstimatedPool(cid), capacity.buildTeamCapacity(cid)]);
    const bucketed = _assignWeekBucket(items, weekStart, weeks);
    return teamCapacity.map(cap => {
        const memberItems = bucketed.filter(i => i.team_member_id === cap.member_id);
        const weeklyCap = cap.capacity_is_active ? (cap.weekly_capacity_hours || 0) : 0;
        const forecastWeeks = [];
        for (let w = 0; w < weeks; w++) {
            const wItems = memberItems.filter(i => i.week_bucket === w);
            const allocated = _round1(wItems.reduce((s, i) => s + i.estimated_hours, 0));
            const utilization = weeklyCap > 0 ? _round1((allocated / weeklyCap) * 100) : null;
            forecastWeeks.push({ week_start: _addDays(weekStart, w * 7), week_end: _addDays(weekStart, w * 7 + 6), capacity_hours: _round1(weeklyCap), allocated_hours: allocated, utilization_percentage: utilization, status: _capacityStatus(utilization) });
        }
        const totalCapacity = _round1(weeklyCap * weeks);
        const totalAllocated = _round1(forecastWeeks.reduce((s, w) => s + w.allocated_hours, 0));
        return {
            team_member_id: cap.member_id, display_name: cap.display_name, role: cap.role,
            weekly_capacity: cap.weekly_capacity_hours, forecast_weeks: forecastWeeks,
            total_capacity: totalCapacity, total_allocated: totalAllocated, capacity_gap: _round1(totalAllocated - totalCapacity),
            overloaded_weeks: forecastWeeks.filter(w => ['over_capacity', 'critical'].includes(w.status)).length,
            critical_weeks: forecastWeeks.filter(w => w.status === 'critical').length,
            status: _capacityStatus(totalCapacity > 0 ? _round1((totalAllocated / totalCapacity) * 100) : null),
        };
    });
}

async function _computeClientForecast(cid, weekStart, weeks) {
    const today = _todayStr();
    const { items } = await _buildEstimatedPool(cid);
    const bucketed = _assignWeekBucket(items, weekStart, weeks).filter(i => i.week_bucket != null);
    const byClient = {};
    bucketed.forEach(i => {
        const key = i.client_id != null ? 'id:' + i.client_id : (i.client_name ? 'name:' + i.client_name : null);
        if (!key) return;
        if (!byClient[key]) byClient[key] = { client_id: i.client_id, client_name: i.client_name || 'Unknown client', items: [] };
        byClient[key].items.push(i);
    });
    return Object.values(byClient).map(c => {
        const hours = _round1(c.items.reduce((s, i) => s + i.estimated_hours, 0));
        const hasOverdue = c.items.some(i => i.due_date && i.due_date < today);
        let pressureStatus = 'normal';
        if (hours > 30 || hasOverdue) pressureStatus = 'critical'; else if (hours > 15) pressureStatus = 'high'; else if (hours > 5) pressureStatus = 'medium';
        return {
            client_id: c.client_id, client_name: c.client_name, estimated_hours_next_weeks: hours,
            deadline_count: c.items.filter(i => i.source_module === 'deadlines').length,
            tax_item_count: c.items.filter(i => ['tax-individual', 'tax-company'].includes(i.source_module)).length,
            document_count: c.items.filter(i => ['document-requests', 'communications'].includes(i.source_module)).length,
            risk_count: c.items.filter(i => i.source_module === 'risk-register').length,
            pressure_status: pressureStatus,
        };
    }).sort((a, b) => b.estimated_hours_next_weeks - a.estimated_hours_next_weeks);
}

async function _computeDeadlineForecast(cid, weekStart, weeks) {
    const windowEnd = _addDays(weekStart, weeks * 7 - 1);
    const { data, error } = await supabase.from('practice_deadlines')
        .select('id, title, due_date, status, priority, responsible_team_member_id, client_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
        .eq('company_id', cid)
        .not('status', 'in', '("completed","submitted","missed","cancelled")')
        .lte('due_date', windowEnd)
        .order('due_date', { ascending: true });
    if (error) throw error;
    const today = _todayStr();
    return (data || []).map(d => {
        const isOverdue = d.due_date < today;
        const weekBucket = d.due_date < weekStart ? 0 : (d.due_date <= windowEnd ? Math.floor(_daysBetween(weekStart, d.due_date) / 7) : null);
        return {
            id: d.id, title: d.title, client_name: d.practice_clients?.name || null, due_date: d.due_date, is_overdue: isOverdue,
            owner_name: d.practice_team_members?.display_name || 'Unassigned',
            estimated_hours: 0.5, confidence: 'default_placeholder',
            risk_level: isOverdue || d.priority === 'urgent' ? 'critical' : (d.priority === 'high' ? 'high' : 'normal'),
            week_bucket: weekBucket,
        };
    });
}

router.post('/snapshots', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const body = req.body || {};
        if (!body.snapshot_name) return res.status(422).json({ error: 'snapshot_name is required.' });

        const weekStart = _mondayOf(body.start_date);
        const weeks = _resolveWeeks(body.weeks);
        const { forecast_data, summary_data } = await _computeFullForecast(cid, weekStart, weeks);

        const { data, error } = await supabase.from('practice_resource_forecast_snapshots').insert({
            company_id: cid, snapshot_name: body.snapshot_name,
            forecast_start_date: weekStart, forecast_end_date: _addDays(weekStart, weeks * 7 - 1), forecast_weeks: weeks,
            forecast_data, summary_data, status: 'active', notes: body.notes || null,
            created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, data.id, 'forecast_snapshot_created', req.user?.userId);
        res.status(201).json({ snapshot: data });
    } catch (err) {
        console.error('POST /api/practice/resource-forecasting/snapshots', err);
        res.status(500).json({ error: 'Failed to save forecast snapshot.' });
    }
});

router.get('/snapshots', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        let q = supabase.from('practice_resource_forecast_snapshots')
            .select('id, snapshot_name, forecast_start_date, forecast_end_date, forecast_weeks, summary_data, status, notes, created_by, created_at')
            .eq('company_id', cid).order('created_at', { ascending: false });
        if (req.query.include_archived !== 'true') q = q.eq('status', 'active');
        const { data, error } = await q;
        if (error) throw error;

        res.json({ snapshots: data || [] });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/snapshots', err);
        res.status(500).json({ error: 'Failed to load forecast snapshots.' });
    }
});

router.get('/snapshots/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data, error } = await supabase.from('practice_resource_forecast_snapshots').select('*').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Forecast snapshot not found.' });

        await _writeEvent(cid, data.id, 'forecast_viewed', req.user?.userId);
        res.json({ snapshot: data });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/snapshots/:id', err);
        res.status(500).json({ error: 'Failed to load forecast snapshot.' });
    }
});

router.delete('/snapshots/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: existing, error: fetchErr } = await supabase.from('practice_resource_forecast_snapshots').select('id, status').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!existing) return res.status(404).json({ error: 'Forecast snapshot not found.' });
        if (existing.status === 'archived') return res.status(422).json({ error: 'This snapshot is already archived.' });

        const { data, error } = await supabase.from('practice_resource_forecast_snapshots').update({ status: 'archived' }).eq('id', existing.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, existing.id, 'forecast_snapshot_archived', req.user?.userId);
        res.json({ snapshot: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/resource-forecasting/snapshots/:id', err);
        res.status(500).json({ error: 'Failed to archive forecast snapshot.' });
    }
});

router.get('/snapshots/:id/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: existing } = await supabase.from('practice_resource_forecast_snapshots').select('id').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Forecast snapshot not found.' });

        const { data, error } = await supabase.from('practice_resource_forecast_events').select('*').eq('company_id', cid).eq('snapshot_id', existing.id).order('created_at', { ascending: false });
        if (error) throw error;

        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/resource-forecasting/snapshots/:id/events', err);
        res.status(500).json({ error: 'Failed to load snapshot history.' });
    }
});

module.exports = router;
