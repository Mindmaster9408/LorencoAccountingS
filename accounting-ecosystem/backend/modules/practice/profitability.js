'use strict';

// Codebox 73 — Practice Client Profitability + Service Margin Foundation
// "Where are we making or losing money?" and "Which clients or services need
// a pricing/scope conversation?" — within seconds.
//
// NOT accounting. NOT a general ledger. NOT invoicing automation. NOT
// revenue recognition. Accounting remains the financial source of truth;
// Billing/WIP (practice_billing_packs, Codebox billing.js) remains the
// billing workflow source of truth. This module only ANALYZES existing
// Time/Billing/Engagement data — it never writes to any of those tables.
//
// CRITICAL, READ BEFORE CHANGING ANY FORMULA: practice_team_members has NO
// cost-rate column anywhere in this schema (confirmed by a dedicated audit).
// estimated_cost is therefore ALWAYS 0 with a TEAM_COST_RATE_MISSING warning
// — which means estimated_margin always equals billed_value and
// margin_percentage is always exactly 100 (or null) until a real cost-rate
// data source exists. realization_percentage is the ONE reliable signal in
// this pass — see docs/new-app/73_client_profitability.md for the full
// consequence of this and why profitability_status still blends both
// signals (future-proofing for when cost data arrives) rather than dropping
// margin entirely.

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

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const PARTNER_ROLES = ['owner', 'partner'];

const SNAPSHOT_TYPES = ['client', 'engagement', 'service', 'practice', 'manual'];
const PROFITABILITY_STATUSES = ['profitable', 'watch', 'low_margin', 'unprofitable', 'unknown'];
const REVIEW_STATUSES = ['draft', 'under_review', 'reviewed', 'action_required', 'accepted', 'archived', 'cancelled'];
const RECOMMENDED_ACTIONS = ['no_action', 'reprice', 'rescope', 'improve_process', 'write_off_review', 'client_discussion', 'terminate_service', 'monitor', 'other'];

// Statuses in practice_time_entries.billing_status (migration 061) that
// represent "approved for billing" — the spec's own "approved billable time"
// phrasing. 'billed' is included since a billed entry was, by definition,
// approved first and remains recoverable/realized.
const APPROVED_BILLING_STATUSES = ['approved', 'billed'];
// Packs whose write-off figures are final enough to count — a still-draft
// pack's totals can still change, so its write-offs are not yet counted.
const REVIEWED_PACK_STATUSES = ['reviewed', 'approved', 'locked'];
const BILLED_PACK_STATUSES = ['approved', 'locked'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage profitability reviews.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    if (!clientId) return null;
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_profitability_events').insert({
        company_id: cid, source_type: sourceType, source_id: sourceId, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

function _round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ── Profitability Engine — calculateProfitability() ──────────────────────────
// Pure aggregation over EXISTING data. Never writes. Every figure is
// documented in `assumptions` so a saved snapshot is always auditable
// against exactly what it was computed from.

async function calculateProfitability({ companyId, periodStart, periodEnd, clientId, engagementId, serviceId }) {
    if (!periodStart || !periodEnd) throw new Error('period_start and period_end are required');

    const assumptions = [];
    const warnings = [];

    // ── Resolve scope ────────────────────────────────────────────────────────
    let resolvedClientId = clientId || null;
    let engagement = null;
    if (engagementId) {
        const { data } = await supabase.from('practice_client_engagements').select('*').eq('id', engagementId).eq('company_id', companyId).maybeSingle();
        if (!data) throw new Error('Engagement not found');
        engagement = data;
        resolvedClientId = data.client_id;
        assumptions.push(`Scoped to engagement #${engagementId} ("${data.engagement_name}") — client resolved to #${resolvedClientId}.`);
    }
    if (resolvedClientId) {
        const client = await _verifyClient(companyId, resolvedClientId);
        if (!client) throw new Error('Client not found');
    }

    // task_id scoping — practice_time_entries has no direct engagement_id/
    // service_id column; the only link is via practice_tasks.engagement_id /
    // .service_id (migration 066, plain integers, no FK).
    let scopedTaskIds = null;
    if (engagementId || serviceId) {
        let taskQuery = supabase.from('practice_tasks').select('id').eq('company_id', companyId);
        if (engagementId) taskQuery = taskQuery.eq('engagement_id', engagementId);
        if (serviceId) taskQuery = taskQuery.eq('service_id', serviceId);
        const { data: taskRows } = await taskQuery;
        scopedTaskIds = (taskRows || []).map(t => t.id);
        assumptions.push(`Time entries scoped via ${scopedTaskIds.length} task(s) linked to ${engagementId ? 'engagement #' + engagementId : ''}${engagementId && serviceId ? ' and ' : ''}${serviceId ? 'service #' + serviceId : ''}.`);
        if (!scopedTaskIds.length) warnings.push('NO_LINKED_TASKS_FOUND');
    }

    // ── Time entries in period ───────────────────────────────────────────────
    let teQuery = supabase.from('practice_time_entries').select('*')
        .eq('company_id', companyId).gte('date', periodStart).lte('date', periodEnd);
    if (resolvedClientId) teQuery = teQuery.eq('client_id', resolvedClientId);
    if (scopedTaskIds) teQuery = scopedTaskIds.length ? teQuery.in('task_id', scopedTaskIds) : teQuery.eq('task_id', -1); // no matching tasks — force zero rows, never guess
    const { data: timeEntries, error: teErr } = await teQuery;
    if (teErr) throw new Error(teErr.message);
    const entries = timeEntries || [];

    const hoursRecorded = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    const billableEntries = entries.filter(e => e.billable !== false && e.time_type !== 'non_billable' && e.time_type !== 'internal' && e.time_type !== 'admin');
    const billableHours = billableEntries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    const nonbillableHours = _round2(hoursRecorded - billableHours);

    // recoverable_value = approved billable time at effective rate. Only
    // billing_status IN ('approved','billed') counts as "approved" — see
    // APPROVED_BILLING_STATUSES comment above.
    const approvedBillableEntries = billableEntries.filter(e => APPROVED_BILLING_STATUSES.includes(e.billing_status));
    let recoverableValue = 0;
    approvedBillableEntries.forEach(e => {
        const effectiveRate = Number(e.override_rate) || Number(e.standard_rate) || Number(e.rate) || 0;
        recoverableValue += (Number(e.hours) || 0) * effectiveRate;
    });
    assumptions.push('recoverable_value = SUM(hours × effective_rate) for billable time entries with billing_status in (approved, billed). effective_rate = COALESCE(override_rate, standard_rate, rate).');
    if (billableEntries.length && !approvedBillableEntries.length) warnings.push('NO_APPROVED_TIME_IN_PERIOD');

    const unapprovedBillableHours = billableHours - approvedBillableEntries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    if (hoursRecorded > 0 && (unapprovedBillableHours / hoursRecorded) > 0.3) warnings.push('SIGNIFICANT_UNAPPROVED_TIME');

    // Time entries linked to a task with no engagement_id — a detectable
    // (never guessed) scope-linkage gap.
    if (scopedTaskIds === null) {
        const entriesWithTask = entries.filter(e => e.task_id);
        if (entriesWithTask.length) {
            const taskIds = [...new Set(entriesWithTask.map(e => e.task_id))];
            const { data: taskRows } = await supabase.from('practice_tasks').select('id, engagement_id').in('id', taskIds).eq('company_id', companyId);
            const taskEngagementById = {};
            (taskRows || []).forEach(t => { taskEngagementById[t.id] = t.engagement_id; });
            const unlinked = entriesWithTask.filter(e => !taskEngagementById[e.task_id]);
            if (entriesWithTask.length && (unlinked.length / entriesWithTask.length) > 0.2) warnings.push('TIME_WITHOUT_ENGAGEMENT_LINK');
        }
    }

    // ── Billing packs overlapping the period ─────────────────────────────────
    let packQuery = supabase.from('practice_billing_packs').select('*')
        .eq('company_id', companyId).lte('period_start', periodEnd).gte('period_end', periodStart);
    if (resolvedClientId) packQuery = packQuery.eq('client_id', resolvedClientId);
    const { data: packRows, error: packErr } = await packQuery;
    if (packErr) throw new Error(packErr.message);
    const packs = packRows || [];

    const billedValue = packs.filter(p => BILLED_PACK_STATUSES.includes(p.status)).reduce((s, p) => s + (Number(p.billable_value) || 0), 0);
    assumptions.push(`billed_value = SUM(billing pack billable_value) for packs with status in (${BILLED_PACK_STATUSES.join(', ')}) overlapping the period.`);

    const writeoffFromPacks = packs.filter(p => REVIEWED_PACK_STATUSES.includes(p.status)).reduce((s, p) => s + (Number(p.writeoff_value) || 0), 0);
    const writeoffFromLooseEntries = entries.filter(e => !e.billing_pack_id && e.billing_status === 'written_off').reduce((s, e) => s + (Number(e.writeoff_value) || 0), 0);
    const writeoffValue = writeoffFromPacks + writeoffFromLooseEntries;
    assumptions.push(`writeoff_value = SUM(pack writeoff_value) for packs with status in (${REVIEWED_PACK_STATUSES.join(', ')}) + SUM(time_entry writeoff_value) for entries not yet in any pack with billing_status = written_off.`);

    if (recoverableValue > 0 && packs.length === 0) warnings.push('RECOVERABLE_VALUE_NO_BILLING_PACK');
    if (packs.some(p => p.status === 'draft')) warnings.push('BILLING_PACK_NOT_FINALIZED');

    let unbilledValue = recoverableValue - billedValue - writeoffValue;
    if (unbilledValue < 0) { warnings.push('UNBILLED_VALUE_NEGATIVE_CHECK_DATA'); unbilledValue = 0; }

    const realizationPercentage = recoverableValue > 0 ? _round2((billedValue / recoverableValue) * 100) : null;
    assumptions.push('realization_percentage = billed_value / recoverable_value × 100, only when recoverable_value > 0.');

    // estimated_cost — see module header. Always 0 until a real cost-rate
    // column exists on practice_team_members; never guessed, always flagged.
    const estimatedCost = 0;
    warnings.push('TEAM_COST_RATE_MISSING');
    assumptions.push('estimated_cost = 0 — practice_team_members has no cost-rate/internal-rate column in this schema. margin_percentage is therefore always 100 (or null) until a real cost-rate data source is added; realization_percentage is the reliable signal in this pass.');

    const estimatedMargin = _round2(billedValue - estimatedCost);
    const marginPercentage = billedValue > 0 ? _round2((estimatedMargin / billedValue) * 100) : null;

    // revenue_amount — no accounting ledger exists to read recognized
    // revenue from; billed_value (actual billed/invoiced amount per stored
    // billing pack aggregates) is the only defensible proxy available.
    const revenueAmount = billedValue;
    assumptions.push('revenue_amount = billed_value — the only defensible "revenue" proxy available without accounting ledger integration.');

    // ── Leakage flags (in addition to those already pushed above) ───────────
    if (recoverableValue > 0 && (unbilledValue / recoverableValue) > 0.3) warnings.push('HIGH_UNBILLED_VALUE');
    if (recoverableValue > 0 && (writeoffValue / recoverableValue) > 0.15) warnings.push('HIGH_WRITEOFFS');
    if (realizationPercentage !== null && realizationPercentage < 70) warnings.push('LOW_REALIZATION');
    if (hoursRecorded > 0 && (nonbillableHours / hoursRecorded) > 0.3) warnings.push('HIGH_NONBILLABLE_TIME');

    // Work-authorization leakage flag — reused live from Codebox 72, never
    // re-derived. Only meaningful at client scope (a service/practice-wide
    // roll-up would need per-client iteration, out of scope for this engine).
    if (resolvedClientId) {
        try {
            const { data: outOfScopeRows } = await supabase.from('practice_work_authorizations').select('id')
                .eq('company_id', companyId).eq('client_id', resolvedClientId).in('scope_result', ['out_of_scope', 'no_active_engagement'])
                .not('authorization_status', 'in', '("override_approved","accepted_risk","cancelled")');
            if ((outOfScopeRows || []).length) warnings.push('WORK_OUTSIDE_SCOPE');
        } catch (e) { /* non-fatal — a missing/erroring work-authorization check must never break profitability analysis */ }
    }

    const profitabilityStatus = _resolveStatus(marginPercentage, realizationPercentage);

    return {
        revenue_amount: _round2(revenueAmount), recoverable_value: _round2(recoverableValue), billed_value: _round2(billedValue),
        writeoff_value: _round2(writeoffValue), unbilled_value: _round2(unbilledValue), estimated_cost: _round2(estimatedCost),
        estimated_margin: estimatedMargin, realization_percentage: realizationPercentage, margin_percentage: marginPercentage,
        hours_recorded: _round2(hoursRecorded), billable_hours: _round2(billableHours), nonbillable_hours: nonbillableHours,
        profitability_status: profitabilityStatus,
        warnings: [...new Set(warnings)],
        source_breakdown: { time_entries_count: entries.length, billing_packs_count: packs.length, approved_billable_entries_count: approvedBillableEntries.length },
        assumptions,
        client_id: resolvedClientId, engagement_id: engagementId || null, service_id: serviceId || null,
    };
}

// Deterministic status from margin + realization tiers — see spec's
// suggested thresholds. Where both signals are available, the WORSE
// (higher-severity) tier wins, since either signal alone can indicate a
// real problem. Documented explicitly because the spec's own thresholds use
// ambiguous "or" language between tiers — this is the resolved reading.
const SEVERITY_RANK = { profitable: 0, watch: 1, low_margin: 2, unprofitable: 3, unknown: 4 };
function _tierFor(value, thresholds) {
    if (value == null) return null;
    if (value >= thresholds[0]) return 'profitable';
    if (value >= thresholds[1]) return 'watch';
    if (value >= thresholds[2]) return 'low_margin';
    return 'unprofitable';
}
function _resolveStatus(marginPct, realizationPct) {
    const marginTier = _tierFor(marginPct, [40, 25, 10]);
    const realizationTier = _tierFor(realizationPct, [85, 70, 50]);
    if (!marginTier && !realizationTier) return 'unknown';
    if (!marginTier) return realizationTier;
    if (!realizationTier) return marginTier;
    return SEVERITY_RANK[marginTier] >= SEVERITY_RANK[realizationTier] ? marginTier : realizationTier;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: rows } = await supabase.from('practice_profitability_snapshots')
            .select('profitability_status, snapshot_type, warnings, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(500);
        const snapshots = rows || [];

        // Latest snapshot per (snapshot_type + implicit scope) is not tracked
        // separately here — this is a company-wide rollup of the most recent
        // 500 snapshots' statuses, a cheap, honest approximation for the
        // dashboard, not a per-client "current state" index.
        const statusCounts = {}; PROFITABILITY_STATUSES.forEach(s => { statusCounts[s] = 0; });
        snapshots.forEach(s => { if (s.profitability_status in statusCounts) statusCounts[s.profitability_status]++; });

        const { data: reviewRows } = await supabase.from('practice_profitability_reviews').select('review_status').eq('company_id', cid).neq('review_status', 'cancelled');
        const reviews = reviewRows || [];
        const reviewCounts = {}; REVIEW_STATUSES.forEach(s => { reviewCounts[s] = 0; });
        reviews.forEach(r => { if (r.review_status in reviewCounts) reviewCounts[r.review_status]++; });

        const highWriteoffCount = snapshots.filter(s => (s.warnings || []).includes('HIGH_WRITEOFFS')).length;
        const lowRealizationCount = snapshots.filter(s => (s.warnings || []).includes('LOW_REALIZATION')).length;

        res.json({
            snapshots_total: snapshots.length,
            by_profitability_status: statusCounts,
            low_margin_clients: statusCounts.low_margin,
            unprofitable_clients: statusCounts.unprofitable,
            high_writeoff_count: highWriteoffCount,
            low_realization_count: lowRealizationCount,
            reviews_by_status: reviewCounts,
            reviews_open: reviews.length,
        });
    } catch (err) {
        console.error('Profitability /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSIS (ad-hoc, never persisted unless saved via POST /snapshots)
// ═══════════════════════════════════════════════════════════════════════════

function _periodFromQuery(req, res) {
    const { period_start, period_end } = req.query;
    if (!period_start || !period_end) { res.status(400).json({ error: 'period_start and period_end are required query parameters' }); return null; }
    return { periodStart: period_start, periodEnd: period_end };
}

router.get('/client/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const period = _periodFromQuery(req, res);
    if (!period) return;
    try {
        const client = await _verifyClient(cid, clientId);
        if (!client) return res.status(404).json({ error: 'Client not found' });
        const analysis = await calculateProfitability({ companyId: cid, periodStart: period.periodStart, periodEnd: period.periodEnd, clientId });
        res.json({ client, analysis });
    } catch (err) {
        console.error('Profitability GET client error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/engagement/:engagementId', async (req, res) => {
    const cid = req.companyId;
    const engagementId = parseInt(req.params.engagementId);
    if (!engagementId) return res.status(400).json({ error: 'Invalid engagement ID' });
    const period = _periodFromQuery(req, res);
    if (!period) return;
    try {
        const analysis = await calculateProfitability({ companyId: cid, periodStart: period.periodStart, periodEnd: period.periodEnd, engagementId });
        res.json({ analysis });
    } catch (err) {
        console.error('Profitability GET engagement error:', err.message);
        res.status(err.message === 'Engagement not found' ? 404 : 500).json({ error: err.message });
    }
});

router.get('/service/:serviceId', async (req, res) => {
    const cid = req.companyId;
    const serviceId = parseInt(req.params.serviceId);
    if (!serviceId) return res.status(400).json({ error: 'Invalid service ID' });
    const period = _periodFromQuery(req, res);
    if (!period) return;
    try {
        const clientId = req.query.client_id ? parseInt(req.query.client_id) : null;
        const analysis = await calculateProfitability({ companyId: cid, periodStart: period.periodStart, periodEnd: period.periodEnd, serviceId, clientId });
        res.json({ analysis });
    } catch (err) {
        console.error('Profitability GET service error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/practice', async (req, res) => {
    const cid = req.companyId;
    const period = _periodFromQuery(req, res);
    if (!period) return;
    try {
        const analysis = await calculateProfitability({ companyId: cid, periodStart: period.periodStart, periodEnd: period.periodEnd });
        res.json({ analysis });
    } catch (err) {
        console.error('Profitability GET practice error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOTS
// ═══════════════════════════════════════════════════════════════════════════

router.post('/snapshots', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { snapshot_type, period_start, period_end, period_key, client_id, engagement_id, service_id, notes } = req.body;
    if (!SNAPSHOT_TYPES.includes(snapshot_type)) return res.status(400).json({ error: 'Invalid snapshot_type' });
    if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end are required' });

    try {
        const analysis = await calculateProfitability({
            companyId: cid, periodStart: period_start, periodEnd: period_end,
            clientId: client_id ? parseInt(client_id) : null, engagementId: engagement_id ? parseInt(engagement_id) : null, serviceId: service_id ? parseInt(service_id) : null,
        });

        const { data, error } = await supabase.from('practice_profitability_snapshots').insert({
            company_id: cid, client_id: analysis.client_id, engagement_id: analysis.engagement_id, service_id: analysis.service_id,
            snapshot_type, period_start, period_end, period_key: period_key || null,
            profitability_status: analysis.profitability_status,
            revenue_amount: analysis.revenue_amount, recoverable_value: analysis.recoverable_value, billed_value: analysis.billed_value,
            writeoff_value: analysis.writeoff_value, unbilled_value: analysis.unbilled_value, estimated_cost: analysis.estimated_cost,
            estimated_margin: analysis.estimated_margin, realization_percentage: analysis.realization_percentage, margin_percentage: analysis.margin_percentage,
            hours_recorded: analysis.hours_recorded, billable_hours: analysis.billable_hours, nonbillable_hours: analysis.nonbillable_hours,
            analysis_snapshot: analysis, warnings: analysis.warnings, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, 'snapshot', data.id, 'profitability_snapshot_created', null, data.profitability_status, req.user.userId, notes || null, { snapshot_type });
        res.status(201).json({ snapshot: data });
    } catch (err) {
        console.error('Profitability POST snapshots error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/snapshots', async (req, res) => {
    const cid = req.companyId;
    const { client_id, engagement_id, service_id, snapshot_type, profitability_status, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_profitability_snapshots').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(300, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (engagement_id) q = q.eq('engagement_id', parseInt(engagement_id));
        if (service_id) q = q.eq('service_id', parseInt(service_id));
        if (snapshot_type) q = q.eq('snapshot_type', snapshot_type);
        if (profitability_status) q = q.eq('profitability_status', profitability_status);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(s => s.client_id).filter(Boolean))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ snapshots: (data || []).map(s => ({ ...s, client_name: s.client_id ? (nameById[s.client_id] || null) : null })) });
    } catch (err) {
        console.error('Profitability GET snapshots error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/snapshots/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid snapshot ID' });
    try {
        const { data, error } = await supabase.from('practice_profitability_snapshots').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Snapshot not found' });
        res.json({ snapshot: data });
    } catch (err) {
        console.error('Profitability GET snapshot error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Snapshots are an immutable historical record by design (see migration
// comment) — DELETE is disabled entirely rather than offered as a soft
// archive, since a snapshot's whole purpose is trend history a partner can
// always trust was never altered or hidden after the fact.
router.delete('/snapshots/:id', async (req, res) => {
    res.status(405).json({ error: 'Profitability snapshots are an immutable historical record and cannot be deleted or archived. Create a new snapshot to reflect updated data.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/reviews', async (req, res) => {
    const cid = req.companyId;
    const { client_id, engagement_id, review_status, assigned_partner_id, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_profitability_reviews').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (engagement_id) q = q.eq('engagement_id', parseInt(engagement_id));
        if (review_status) q = q.eq('review_status', review_status);
        if (assigned_partner_id) q = q.eq('assigned_partner_id', parseInt(assigned_partner_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(r => r.client_id).filter(Boolean))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ reviews: (data || []).map(r => ({ ...r, client_name: r.client_id ? (nameById[r.client_id] || null) : null })) });
    } catch (err) {
        console.error('Profitability GET reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/reviews', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, engagement_id, snapshot_id, review_title, review_summary, recommended_action, assigned_partner_id, next_review_date } = req.body;
    if (!review_title) return res.status(400).json({ error: 'review_title is required' });
    if (client_id) { const c = await _verifyClient(cid, parseInt(client_id)); if (!c) return res.status(404).json({ error: 'Client not found' }); }
    if (recommended_action && !RECOMMENDED_ACTIONS.includes(recommended_action)) return res.status(400).json({ error: 'Invalid recommended_action' });

    try {
        const { data, error } = await supabase.from('practice_profitability_reviews').insert({
            company_id: cid, client_id: client_id ? parseInt(client_id) : null, engagement_id: engagement_id ? parseInt(engagement_id) : null,
            snapshot_id: snapshot_id ? parseInt(snapshot_id) : null, review_title, review_summary: review_summary || null,
            recommended_action: recommended_action || null, assigned_partner_id: assigned_partner_id ? parseInt(assigned_partner_id) : null,
            next_review_date: next_review_date || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, 'review', data.id, 'profitability_review_created', null, data.review_status, req.user.userId, review_title, {});
        res.status(201).json({ review: data });
    } catch (err) {
        console.error('Profitability POST reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

async function _fetchReview(cid, id) {
    const { data } = await supabase.from('practice_profitability_reviews').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

router.get('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json({ review });
});

router.put('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (['archived', 'cancelled'].includes(existing.review_status)) return res.status(400).json({ error: `Cannot edit a review that is already ${existing.review_status}.` });

    const allowed = ['review_title', 'review_summary', 'partner_notes', 'recommended_action', 'assigned_partner_id', 'next_review_date'];
    const update = _pick(req.body, allowed);
    if (update.recommended_action && !RECOMMENDED_ACTIONS.includes(update.recommended_action)) return res.status(400).json({ error: 'Invalid recommended_action' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_profitability_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, 'review', id, 'profitability_review_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ review: data });
    } catch (err) {
        console.error('Profitability PUT review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (existing.review_status === 'cancelled') return res.status(400).json({ error: 'Review is already cancelled.' });

    try {
        const { data, error } = await supabase.from('practice_profitability_reviews')
            .update({ review_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() }).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, 'review', id, 'profitability_review_cancelled', existing.review_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Profitability DELETE review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Review Workflow Actions ───────────────────────────────────────────────────

const REVIEW_TRANSITIONS = {
    submit: { from: ['draft'], to: 'under_review', event: 'profitability_review_submitted' },
    complete: { from: ['under_review'], to: 'reviewed', event: 'profitability_review_completed' },
    'mark-action-required': { from: ['under_review', 'reviewed'], to: 'action_required', event: 'profitability_review_action_required' },
    accept: { from: ['reviewed', 'action_required'], to: 'accepted', event: 'profitability_review_accepted' },
    archive: { from: ['accepted', 'reviewed', 'action_required'], to: 'archived', event: 'profitability_review_archived' },
};

Object.keys(REVIEW_TRANSITIONS).forEach(action => {
    router.put(`/reviews/:id/${action}`, async (req, res) => {
        const cid = req.companyId;
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid review ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const review = await _fetchReview(cid, id);
        if (!review) return res.status(404).json({ error: 'Review not found' });
        const rule = REVIEW_TRANSITIONS[action];
        if (!rule.from.includes(review.review_status)) {
            return res.status(422).json({ error: `Cannot ${action} from status "${review.review_status}". Allowed from: ${rule.from.join(', ')}.` });
        }

        try {
            const update = { review_status: rule.to, updated_by: req.user.userId, updated_at: new Date().toISOString() };
            if (action === 'complete') { update.reviewed_by = req.user.userId; update.reviewed_at = new Date().toISOString(); }
            if (req.body.notes) update.partner_notes = req.body.notes;

            const { data, error } = await supabase.from('practice_profitability_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });
            await _writeEvent(cid, 'review', id, rule.event, review.review_status, rule.to, req.user.userId, req.body.notes || null, {});
            res.json({ review: data });
        } catch (err) {
            console.error(`Profitability PUT /reviews/:id/${action} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const sourceType = req.params.sourceType;
    const sourceId = parseInt(req.params.sourceId);
    if (!['snapshot', 'review'].includes(sourceType)) return res.status(400).json({ error: 'Invalid sourceType' });
    if (!sourceId) return res.status(400).json({ error: 'Invalid sourceId' });
    try {
        const { data, error } = await supabase.from('practice_profitability_events').select('*')
            .eq('company_id', cid).eq('source_type', sourceType).eq('source_id', sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Profitability GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules (Engagement Management, Client Success,
// Management Dashboard, Planning Board) — see docs/new-app/73_client_profitability.md
module.exports.calculateProfitability = calculateProfitability;
