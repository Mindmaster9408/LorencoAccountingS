'use strict';

// Codebox 76 — Practice Strategic Planning + Objectives Management
// "Where are we going?" NOT project management. NOT task management. NOT HR
// performance. Strategic practice leadership only — annual objectives,
// quarterly priorities, initiatives, and KPI links that REFERENCE (never
// duplicate) the KPI engines already built in Codeboxes 50/51/61/73/74/75
// and the Risk/QMS registers. NOT AI — every score deterministic, every
// formula returned alongside its result.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { getRules } = require('./alert-rules');
const planningBoard = require('./planning-board');
const capacity = require('./capacity');
const kpiHistory = require('./kpi-history');
const managementDashboard = require('./management-dashboard');
const { buildStatutoryCalendar } = require('./secretarial-calendar');

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

const PLAN_STATUSES = ['draft', 'active', 'under_review', 'completed', 'archived', 'cancelled'];
const OBJECTIVE_AREAS = ['growth', 'profitability', 'quality', 'client_success', 'capacity', 'team_development', 'risk', 'compliance', 'secretarial', 'tax', 'operational_excellence', 'technology', 'other'];
const OBJECTIVE_STATUSES = ['not_started', 'in_progress', 'on_track', 'at_risk', 'off_track', 'achieved', 'deferred', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const INITIATIVE_STATUSES = ['not_started', 'in_progress', 'blocked', 'completed', 'deferred', 'cancelled'];
const KPI_SOURCES = ['management_dashboard', 'kpi_history', 'partner_scorecard', 'profitability', 'client_success', 'risk', 'qms', 'planning', 'capacity', 'tax', 'secretarial', 'custom'];
const KPI_DIRECTIONS = ['increase', 'decrease', 'maintain', 'threshold'];
const REVIEW_STATUSES = ['draft', 'under_review', 'reviewed', 'action_required', 'completed', 'cancelled'];

const _clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const _round2 = n => (n == null ? null : Math.round(n * 100) / 100);

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage strategic planning.' });
        return null;
    }
    return member;
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _writeEvent(cid, refs, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_strategic_events').insert({
        company_id: cid,
        plan_id: refs.planId || null, objective_id: refs.objectiveId || null, initiative_id: refs.initiativeId || null,
        kpi_link_id: refs.kpiLinkId || null, review_id: refs.reviewId || null,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

async function _fetchPlan(cid, id) {
    const { data } = await supabase.from('practice_strategic_plans').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _fetchObjective(cid, id) {
    const { data } = await supabase.from('practice_strategic_objectives').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _fetchInitiative(cid, id) {
    const { data } = await supabase.from('practice_strategic_initiatives').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _fetchKpiLink(cid, id) {
    const { data } = await supabase.from('practice_strategic_kpi_links').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _fetchReview(cid, id) {
    const { data } = await supabase.from('practice_strategic_reviews').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// KPI LINK LOGIC — a small, explicit "known-safe" metric registry.
// References existing KPI sources — NEVER a duplicate KPI engine. Unmatched
// source/metric_key combinations always stay confidence:'manual' — no guess.
// ═══════════════════════════════════════════════════════════════════════════

// Fetchers that are safe to call once per refresh batch (not per-link) since
// each does its own small, cheap query — mirrors the exact reuse pattern
// established in partner-scorecards.js (Codebox 75).
async function _sharedSourceData(cid, sourcesNeeded) {
    const data = {};
    const jobs = [];

    if (sourcesNeeded.has('kpi_history')) {
        jobs.push(supabase.from('practice_kpi_snapshots').select('*').eq('company_id', cid).eq('status', 'active')
            .order('generated_at', { ascending: false }).limit(1).maybeSingle()
            .then(r => { data.kpi_history = r.data || null; }));
    }
    if (sourcesNeeded.has('management_dashboard')) {
        // Only ever called when a manager explicitly views/refreshes a single
        // objective's KPI links — never in a bulk/company-wide health scan.
        jobs.push(managementDashboard.computeSummary(cid).then(s => { data.management_dashboard = s; }).catch(() => { data.management_dashboard = null; }));
    }
    if (sourcesNeeded.has('partner_scorecard')) {
        jobs.push(supabase.from('practice_partner_scorecards').select('*').eq('company_id', cid).eq('scorecard_type', 'practice')
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
            .then(r => { data.partner_scorecard = r.data || null; }));
    }
    if (sourcesNeeded.has('profitability')) {
        jobs.push(supabase.from('practice_profitability_snapshots').select('profitability_status, warnings').eq('company_id', cid)
            .order('created_at', { ascending: false }).limit(500)
            .then(r => { data.profitability = r.data || []; }));
    }
    if (sourcesNeeded.has('client_success')) {
        jobs.push(supabase.from('practice_client_success').select('relationship_status').eq('company_id', cid)
            .then(r => { data.client_success = r.data || []; }));
    }
    if (sourcesNeeded.has('risk')) {
        jobs.push(Promise.all([
            getRules(cid, ['risk_high_min', 'risk_critical_min']),
            supabase.from('practice_risks').select('inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")'),
        ]).then(([rules, rows]) => { data.risk = { rules, rows: rows.data || [] }; }));
    }
    if (sourcesNeeded.has('qms')) {
        jobs.push(Promise.all([
            supabase.from('practice_quality_reviews').select('status').eq('company_id', cid),
            supabase.from('practice_quality_findings').select('severity').eq('company_id', cid).in('status', ['open', 'in_progress']),
        ]).then(([reviews, findings]) => { data.qms = { reviews: reviews.data || [], findings: findings.data || [] }; }));
    }
    if (sourcesNeeded.has('planning')) {
        jobs.push(planningBoard.buildTeamItemPool(cid).then(p => { data.planning = p; }).catch(() => { data.planning = null; }));
    }
    if (sourcesNeeded.has('capacity')) {
        jobs.push(capacity.buildTeamCapacity(cid).then(rows => { data.capacity = rows; }).catch(() => { data.capacity = null; }));
    }
    if (sourcesNeeded.has('tax')) {
        jobs.push(Promise.all([
            supabase.from('practice_individual_tax_returns').select('id', { count: 'exact', head: true }).eq('company_id', cid).not('status', 'in', '("completed","cancelled")'),
            supabase.from('practice_company_tax_returns').select('id', { count: 'exact', head: true }).eq('company_id', cid).not('status', 'in', '("completed","cancelled")'),
            supabase.from('practice_tax_payments').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('direction', 'payable').in('status', ['outstanding', 'partially_paid']),
        ]).then(([indiv, comp, pay]) => { data.tax = { open_returns: (indiv.count || 0) + (comp.count || 0), payments_outstanding: pay.count || 0 }; }));
    }
    if (sourcesNeeded.has('secretarial')) {
        jobs.push(Promise.all([
            buildStatutoryCalendar(cid, null).catch(() => ({ counts: { overdue: 0 } })),
            supabase.from('practice_secretarial_integrity_runs').select('critical_count, high_count').eq('company_id', cid).order('scan_started_at', { ascending: false }).limit(1).maybeSingle(),
        ]).then(([cal, run]) => { data.secretarial = { overdue_statutory_items: cal.counts?.overdue || 0, latest_integrity_run: run.data || null }; }));
    }

    await Promise.all(jobs);
    return data;
}

// Given a link and the shared source data, returns { value, confidence } —
// never throws, never guesses. Unmatched combos return confidence:'manual'
// and leave value untouched (caller keeps the existing stored current_value).
function _resolveMetric(link, shared) {
    const src = link.kpi_source, key = link.metric_key;

    if (src === 'kpi_history') {
        const snap = shared.kpi_history;
        if (snap && kpiHistory.METRIC_EXTRACTORS[key]) {
            const v = kpiHistory.METRIC_EXTRACTORS[key](snap);
            return v != null ? { value: v, confidence: 'auto' } : { value: null, confidence: 'manual' };
        }
        return null;
    }
    if (src === 'management_dashboard') {
        const s = shared.management_dashboard;
        if (!s) return null;
        const MD_PATHS = {
            active_clients: () => s.practice?.active_clients, open_tasks: () => s.practice?.open_tasks,
            overdue_tasks: () => s.practice?.overdue_tasks, avg_utilization_pct: () => s.capacity?.avg_utilization_pct,
            open_risks: () => s.risk?.open_risks, critical_risks: () => s.risk?.critical_risks,
            open_findings: () => s.qms?.open_findings, overdue_reminders: () => s.reminders?.overdue,
        };
        if (MD_PATHS[key]) { const v = MD_PATHS[key](); return v != null ? { value: v, confidence: 'auto' } : { value: null, confidence: 'manual' }; }
        return null;
    }
    if (src === 'partner_scorecard') {
        const s = shared.partner_scorecard;
        const SC_KEYS = ['overall_score', 'profitability_score', 'quality_score', 'capacity_score', 'client_score', 'risk_score', 'engagement_score', 'learning_score', 'planning_score', 'notification_score'];
        if (s && SC_KEYS.includes(key)) { const v = s[key]; return v != null ? { value: v, confidence: 'auto' } : { value: null, confidence: 'manual' }; }
        return null;
    }
    if (src === 'profitability') {
        const rows = shared.profitability || [];
        const MAP = {
            low_margin_clients: () => rows.filter(r => r.profitability_status === 'low_margin').length,
            unprofitable_clients: () => rows.filter(r => r.profitability_status === 'unprofitable').length,
            high_writeoffs: () => rows.filter(r => (r.warnings || []).includes('HIGH_WRITEOFFS')).length,
            low_realization: () => rows.filter(r => (r.warnings || []).includes('LOW_REALIZATION')).length,
        };
        if (MAP[key]) return { value: MAP[key](), confidence: 'auto' };
        return null;
    }
    if (src === 'client_success') {
        const rows = shared.client_success || [];
        const MAP = {
            healthy_count: () => rows.filter(r => r.relationship_status === 'healthy').length,
            watch_count: () => rows.filter(r => r.relationship_status === 'watch').length,
            at_risk_count: () => rows.filter(r => r.relationship_status === 'at_risk').length,
            critical_count: () => rows.filter(r => r.relationship_status === 'critical').length,
        };
        if (MAP[key]) return { value: MAP[key](), confidence: 'auto' };
        return null;
    }
    if (src === 'risk') {
        const d = shared.risk;
        if (!d) return null;
        const highMin = d.rules.risk_high_min?.enabled !== false ? Number(d.rules.risk_high_min?.threshold_value) : Infinity;
        const critMin = d.rules.risk_critical_min?.enabled !== false ? Number(d.rules.risk_critical_min?.threshold_value) : Infinity;
        const MAP = {
            open_risks: () => d.rows.length,
            high_risks: () => d.rows.filter(r => r.inherent_risk >= highMin && r.inherent_risk < critMin).length,
            critical_risks: () => d.rows.filter(r => r.inherent_risk >= critMin).length,
        };
        if (MAP[key]) return { value: MAP[key](), confidence: 'auto' };
        return null;
    }
    if (src === 'qms') {
        const d = shared.qms;
        if (!d) return null;
        const MAP = {
            open_findings: () => d.findings.length,
            critical_findings: () => d.findings.filter(f => f.severity === 'critical').length,
            failed_reviews: () => d.reviews.filter(r => r.status === 'failed').length,
        };
        if (MAP[key]) return { value: MAP[key](), confidence: 'auto' };
        return null;
    }
    if (src === 'planning') {
        const pool = shared.planning;
        if (!pool) return null;
        const today = new Date().toISOString().slice(0, 10);
        const MAP = {
            overdue_items: () => pool.items.filter(i => i.due_date && i.due_date < today).length,
            critical_items: () => pool.items.filter(i => i.priority_label === 'critical').length,
        };
        if (MAP[key]) return { value: MAP[key](), confidence: 'auto' };
        return null;
    }
    if (src === 'capacity') {
        const rows = shared.capacity;
        if (!rows) return null;
        const MAP = {
            avg_utilization_pct: () => { const withCap = rows.filter(m => m.capacity_status !== 'unknown'); return withCap.length ? Math.round(withCap.reduce((s, m) => s + (m.utilization_percentage || 0), 0) / withCap.length) : null; },
            overloaded_count: () => rows.filter(m => m.capacity_status === 'overloaded').length,
        };
        if (MAP[key]) { const v = MAP[key](); return v != null ? { value: v, confidence: 'auto' } : { value: null, confidence: 'manual' }; }
        return null;
    }
    if (src === 'tax') {
        const d = shared.tax;
        if (d && key in d) return { value: d[key], confidence: 'auto' };
        return null;
    }
    if (src === 'secretarial') {
        const d = shared.secretarial;
        if (!d) return null;
        if (key === 'overdue_statutory_items') return { value: d.overdue_statutory_items, confidence: 'auto' };
        if (key === 'open_integrity_findings') { const r = d.latest_integrity_run; return r ? { value: (r.critical_count || 0) + (r.high_count || 0), confidence: 'auto' } : null; }
        return null;
    }
    // 'custom' and any unmatched combination — always manual.
    return null;
}

// Refreshes a small set of KPI links (scoped to one objective's links at a
// time — never company-wide) against known-safe sources, persisting
// current_value/confidence/last_measured_at for matches. Non-matches are
// left completely untouched (existing manual value preserved).
async function _refreshKpiLinks(cid, links) {
    const sourcesNeeded = new Set(links.map(l => l.kpi_source).filter(s => s !== 'custom'));
    if (!sourcesNeeded.size) return links;
    const shared = await _sharedSourceData(cid, sourcesNeeded);

    const updated = [];
    for (const link of links) {
        const resolved = _resolveMetric(link, shared);
        if (resolved && resolved.value != null) {
            const { data } = await supabase.from('practice_strategic_kpi_links')
                .update({ current_value: resolved.value, confidence: 'auto', last_measured_at: new Date().toISOString() })
                .eq('id', link.id).eq('company_id', cid).select().single();
            updated.push(data || link);
        } else {
            updated.push(link);
        }
    }
    return updated;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS LOGIC
// ═══════════════════════════════════════════════════════════════════════════

function _kpiLinkProgress(link) {
    const { baseline_value: b, target_value: t, current_value: c, direction } = link;
    if (c == null || t == null) return null;
    if (direction === 'increase') {
        if (b == null || t === b) return null;
        return _clamp(((c - b) / (t - b)) * 100, 0, 100);
    }
    if (direction === 'decrease') {
        if (b == null || b === t) return null;
        return _clamp(((b - c) / (b - t)) * 100, 0, 100);
    }
    if (direction === 'maintain') {
        const denom = Math.max(Math.abs(t), 1);
        return _clamp(100 - (Math.abs(c - t) / denom) * 100, 0, 100);
    }
    if (direction === 'threshold') {
        if (c >= t) return 100;
        return t !== 0 ? _clamp((c / t) * 100, 0, 100) : null;
    }
    return null;
}

// Returns { computed_progress, formula, source } — NEVER writes to the
// stored progress_percentage column (that remains the manual fallback,
// always visible, never silently overwritten).
function _computeObjectiveProgress(objective, initiatives, kpiLinks) {
    const hasInitiatives = initiatives.length > 0;
    const hasKpis = kpiLinks.length > 0;

    let initiativesAvg = null;
    if (hasInitiatives) {
        initiativesAvg = _round2(initiatives.reduce((s, i) => s + (Number(i.progress_percentage) || 0), 0) / initiatives.length);
    }

    let kpiAvg = null;
    const kpiScored = kpiLinks.map(l => ({ link: l, pct: _kpiLinkProgress(l) })).filter(x => x.pct != null);
    if (hasKpis && kpiScored.length) {
        const totalWeight = kpiScored.reduce((s, x) => s + (Number(x.link.weight) || 1), 0);
        kpiAvg = _round2(kpiScored.reduce((s, x) => s + x.pct * ((Number(x.link.weight) || 1) / totalWeight), 0));
    }

    if (hasInitiatives && hasKpis && kpiAvg != null) {
        return { computed_progress: _round2((initiativesAvg + kpiAvg) / 2), formula: `Blended: 50% average initiative progress (${initiativesAvg}%) + 50% weighted KPI progress (${kpiAvg}%)`, source: 'blended' };
    }
    if (hasInitiatives) {
        return { computed_progress: initiativesAvg, formula: `Average progress across ${initiatives.length} initiative(s)`, source: 'initiatives' };
    }
    if (hasKpis && kpiAvg != null) {
        return { computed_progress: kpiAvg, formula: `Weighted average of ${kpiScored.length}/${kpiLinks.length} KPI link(s) with usable current/target values`, source: 'kpi_links' };
    }
    if (hasKpis && !kpiScored.length) {
        return { computed_progress: Number(objective.progress_percentage) || 0, formula: 'KPI links exist but none have usable current/target values yet — falling back to manually entered progress_percentage', source: 'manual_fallback' };
    }
    return { computed_progress: Number(objective.progress_percentage) || 0, formula: 'No initiatives or KPI links — manually entered progress_percentage', source: 'manual' };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIC ENGINE — getStrategicPlanHealth()
// ═══════════════════════════════════════════════════════════════════════════

async function getStrategicPlanHealth(cid, planId) {
    const plan = await _fetchPlan(cid, planId);
    if (!plan) throw new Error('Plan not found');

    const { data: objectiveRows } = await supabase.from('practice_strategic_objectives').select('*').eq('company_id', cid).eq('plan_id', planId);
    const objectives = objectiveRows || [];
    const objectiveIds = objectives.map(o => o.id);

    const [initiativeRows, kpiLinkRows] = await Promise.all([
        objectiveIds.length ? supabase.from('practice_strategic_initiatives').select('*').eq('company_id', cid).in('objective_id', objectiveIds) : Promise.resolve({ data: [] }),
        objectiveIds.length ? supabase.from('practice_strategic_kpi_links').select('*').eq('company_id', cid).in('objective_id', objectiveIds) : Promise.resolve({ data: [] }),
    ]);
    const initiatives = initiativeRows.data || [];
    const kpiLinks = kpiLinkRows.data || [];

    const today = new Date().toISOString().slice(0, 10);
    const objectivesWithProgress = objectives.map(o => {
        const oInitiatives = initiatives.filter(i => i.objective_id === o.id);
        const oKpis = kpiLinks.filter(k => k.objective_id === o.id);
        return { ...o, ..._computeObjectiveProgress(o, oInitiatives, oKpis), initiative_count: oInitiatives.length, kpi_link_count: oKpis.length };
    });

    const atRiskObjectives = objectivesWithProgress.filter(o => ['at_risk', 'off_track'].includes(o.objective_status));
    const blockedInitiatives = initiatives.filter(i => i.initiative_status === 'blocked');
    const overdueInitiatives = initiatives.filter(i => i.due_date && i.due_date < today && !['completed', 'cancelled'].includes(i.initiative_status));
    const kpiGaps = kpiLinks.filter(k => k.current_value == null || k.target_value == null);

    const overallProgress = objectivesWithProgress.length
        ? _round2(objectivesWithProgress.reduce((s, o) => s + (o.computed_progress || 0), 0) / objectivesWithProgress.length)
        : null;

    // Deterministic, manual-action suggestions only — never a fabricated
    // strategy or AI recommendation.
    const recommendedActions = [];
    objectivesWithProgress.forEach(o => {
        if (!o.initiative_count && !o.kpi_link_count) recommendedActions.push(`Objective "${o.objective_title}" has no initiatives or KPI links — add at least one to track real progress.`);
    });
    if (blockedInitiatives.length) recommendedActions.push(`${blockedInitiatives.length} initiative(s) are blocked — review blocker_notes and unblock or reassign.`);
    if (overdueInitiatives.length) recommendedActions.push(`${overdueInitiatives.length} initiative(s) are overdue — update due_date or mark progress.`);
    if (kpiGaps.length) recommendedActions.push(`${kpiGaps.length} KPI link(s) are missing a current or target value — set both to enable progress calculation.`);
    if (atRiskObjectives.length) recommendedActions.push(`${atRiskObjectives.length} objective(s) are marked at-risk/off-track — a strategic review may be due.`);

    return {
        plan, objectives: objectivesWithProgress, initiatives, kpi_links: kpiLinks,
        overall_progress: overallProgress,
        at_risk_objectives: atRiskObjectives, blocked_initiatives: blockedInitiatives,
        overdue_initiatives: overdueInitiatives, kpi_gaps: kpiGaps,
        recommended_next_manual_actions: recommendedActions,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: planRows } = await supabase.from('practice_strategic_plans').select('id, plan_status').eq('company_id', cid);
        const plans = planRows || [];
        const byStatus = {}; PLAN_STATUSES.forEach(s => { byStatus[s] = 0; });
        plans.forEach(p => { if (p.plan_status in byStatus) byStatus[p.plan_status]++; });

        const activePlanIds = plans.filter(p => ['active', 'under_review'].includes(p.plan_status)).map(p => p.id);
        const { data: objRows } = activePlanIds.length
            ? await supabase.from('practice_strategic_objectives').select('objective_status').eq('company_id', cid).in('plan_id', activePlanIds)
            : { data: [] };
        const objectives = objRows || [];
        const atRiskObjectives = objectives.filter(o => ['at_risk', 'off_track'].includes(o.objective_status)).length;

        const { data: reviewRows } = await supabase.from('practice_strategic_reviews').select('review_status, next_review_date').eq('company_id', cid);
        const reviews = reviewRows || [];
        const today = new Date().toISOString().slice(0, 10);
        const openReviews = reviews.filter(r => ['draft', 'under_review', 'action_required'].includes(r.review_status)).length;
        const reviewsDue = reviews.filter(r => r.next_review_date && r.next_review_date <= today && !['completed', 'cancelled'].includes(r.review_status)).length;

        res.json({
            plans_total: plans.length, by_plan_status: byStatus,
            active_plans: byStatus.active + byStatus.under_review,
            at_risk_objectives: atRiskObjectives, open_reviews: openReviews, reviews_due: reviewsDue,
        });
    } catch (err) {
        console.error('Strategic-planning /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLANS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/plans', async (req, res) => {
    const cid = req.companyId;
    const { plan_status, plan_year } = req.query;
    try {
        let q = supabase.from('practice_strategic_plans').select('*').eq('company_id', cid).order('plan_year', { ascending: false });
        if (plan_status) q = q.eq('plan_status', plan_status);
        if (plan_year) q = q.eq('plan_year', parseInt(plan_year));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ plans: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET /plans error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/plans', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { plan_name, plan_year, period_start, period_end } = req.body;
    if (!plan_name) return res.status(400).json({ error: 'plan_name is required' });
    if (!plan_year) return res.status(400).json({ error: 'plan_year is required' });
    if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end are required' });

    try {
        const { data, error } = await supabase.from('practice_strategic_plans').insert({
            company_id: cid, plan_name, plan_year: parseInt(plan_year), period_start, period_end,
            vision_statement: req.body.vision_statement || null, strategic_theme: req.body.strategic_theme || null,
            executive_summary: req.body.executive_summary || null, partner_notes: req.body.partner_notes || null,
            settings: req.body.settings || {}, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: data.id }, 'plan_created', null, data.plan_status, req.user.userId, plan_name, {});
        res.status(201).json({ plan: data });
    } catch (err) {
        console.error('Strategic-planning POST /plans error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/plans/:id', async (req, res) => {
    const plan = await _fetchPlan(req.companyId, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json({ plan });
});

router.put('/plans/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchPlan(cid, id);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    if (['archived', 'cancelled'].includes(existing.plan_status)) return res.status(400).json({ error: `Cannot edit a plan that is already ${existing.plan_status}.` });

    const allowed = ['plan_name', 'plan_year', 'period_start', 'period_end', 'vision_statement', 'strategic_theme', 'executive_summary', 'partner_notes', 'settings'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_strategic_plans').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: id }, 'plan_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ plan: data });
    } catch (err) {
        console.error('Strategic-planning PUT /plans/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/plans/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchPlan(cid, id);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    if (['archived', 'cancelled'].includes(existing.plan_status)) return res.status(400).json({ error: `Plan is already ${existing.plan_status}.` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel a strategic plan.' });

    try {
        const { data, error } = await supabase.from('practice_strategic_plans')
            .update({ plan_status: 'cancelled', cancellation_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: id }, 'plan_cancelled', existing.plan_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ plan: data });
    } catch (err) {
        console.error('Strategic-planning DELETE /plans/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Plan actions ──────────────────────────────────────────────────────────────

const PLAN_TRANSITIONS = {
    activate: { from: ['draft'], to: 'active', event: 'plan_activated' },
    complete: { from: ['active', 'under_review'], to: 'completed', event: 'plan_completed' },
    archive: { from: ['completed', 'cancelled'], to: 'archived', event: 'plan_archived' },
};

Object.keys(PLAN_TRANSITIONS).forEach(action => {
    router.put(`/plans/:id/${action}`, async (req, res) => {
        const cid = req.companyId;
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid plan ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const plan = await _fetchPlan(cid, id);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        const rule = PLAN_TRANSITIONS[action];
        if (!rule.from.includes(plan.plan_status)) {
            return res.status(422).json({ error: `Cannot ${action} from status "${plan.plan_status}". Allowed from: ${rule.from.join(', ')}.` });
        }

        try {
            const { data, error } = await supabase.from('practice_strategic_plans')
                .update({ plan_status: rule.to, updated_by: req.user.userId, updated_at: new Date().toISOString() }).eq('id', id).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });
            await _writeEvent(cid, { planId: id }, rule.event, plan.plan_status, rule.to, req.user.userId, req.body.notes || null, {});
            res.json({ plan: data });
        } catch (err) {
            console.error(`Strategic-planning PUT /plans/:id/${action} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// OBJECTIVES
// ═══════════════════════════════════════════════════════════════════════════

// A safe, read-only, cross-plan lookup — powers the Partner Scorecards
// integration ("show linked strategic objectives where safe") without that
// module needing to know about practice_strategic_plans at all.
router.get('/objectives', async (req, res) => {
    const cid = req.companyId;
    const { owner_team_member_id, objective_status } = req.query;
    if (!owner_team_member_id) return res.status(400).json({ error: 'owner_team_member_id is required for this cross-plan lookup.' });
    try {
        let q = supabase.from('practice_strategic_objectives').select('id, plan_id, objective_title, objective_area, objective_status, priority, progress_percentage')
            .eq('company_id', cid).eq('owner_team_member_id', parseInt(owner_team_member_id));
        if (objective_status) q = q.eq('objective_status', objective_status);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ objectives: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET /objectives error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/plans/:id/objectives', async (req, res) => {
    const cid = req.companyId;
    const planId = parseInt(req.params.id);
    try {
        const { data, error } = await supabase.from('practice_strategic_objectives').select('*').eq('company_id', cid).eq('plan_id', planId).order('created_at');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ objectives: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET objectives error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/plans/:id/objectives', async (req, res) => {
    const cid = req.companyId;
    const planId = parseInt(req.params.id);
    const member = await _requireManager(req, res);
    if (!member) return;

    const plan = await _fetchPlan(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const { objective_title, objective_area, priority } = req.body;
    if (!objective_title) return res.status(400).json({ error: 'objective_title is required' });
    if (!OBJECTIVE_AREAS.includes(objective_area)) return res.status(400).json({ error: `Invalid objective_area. Allowed: ${OBJECTIVE_AREAS.join(', ')}` });
    if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });

    try {
        const { data, error } = await supabase.from('practice_strategic_objectives').insert({
            company_id: cid, plan_id: planId, objective_title, objective_description: req.body.objective_description || null,
            objective_area, priority: priority || 'medium', owner_team_member_id: req.body.owner_team_member_id || null,
            target_date: req.body.target_date || null, progress_percentage: req.body.progress_percentage || 0,
            success_measure: req.body.success_measure || null, current_position: req.body.current_position || null,
            target_position: req.body.target_position || null, notes: req.body.notes || null, internal_notes: req.body.internal_notes || null,
            settings: req.body.settings || {}, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId, objectiveId: data.id }, 'objective_created', null, data.objective_status, req.user.userId, objective_title, {});
        res.status(201).json({ objective: data });
    } catch (err) {
        console.error('Strategic-planning POST objectives error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/objectives/:objectiveId', async (req, res) => {
    const cid = req.companyId;
    const objective = await _fetchObjective(cid, req.params.objectiveId);
    if (!objective) return res.status(404).json({ error: 'Objective not found' });
    try {
        const [{ data: initiatives }, { data: kpiLinks }] = await Promise.all([
            supabase.from('practice_strategic_initiatives').select('*').eq('company_id', cid).eq('objective_id', objective.id),
            supabase.from('practice_strategic_kpi_links').select('*').eq('company_id', cid).eq('objective_id', objective.id),
        ]);
        const progress = _computeObjectiveProgress(objective, initiatives || [], kpiLinks || []);
        res.json({ objective: { ...objective, ...progress }, initiatives: initiatives || [], kpi_links: kpiLinks || [] });
    } catch (err) {
        console.error('Strategic-planning GET /objectives/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/objectives/:objectiveId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.objectiveId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchObjective(cid, id);
    if (!existing) return res.status(404).json({ error: 'Objective not found' });

    const allowed = ['objective_title', 'objective_description', 'objective_area', 'objective_status', 'priority', 'owner_team_member_id', 'target_date', 'progress_percentage', 'success_measure', 'current_position', 'target_position', 'notes', 'internal_notes', 'settings'];
    const update = _pick(req.body, allowed);
    if (update.objective_area && !OBJECTIVE_AREAS.includes(update.objective_area)) return res.status(400).json({ error: 'Invalid objective_area' });
    if (update.objective_status && !OBJECTIVE_STATUSES.includes(update.objective_status)) return res.status(400).json({ error: 'Invalid objective_status' });
    if (update.priority && !PRIORITIES.includes(update.priority)) return res.status(400).json({ error: 'Invalid priority' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_strategic_objectives').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        const eventType = (update.objective_status && update.objective_status !== existing.objective_status) ? 'objective_status_changed' : 'objective_updated';
        await _writeEvent(cid, { planId: existing.plan_id, objectiveId: id }, eventType, existing.objective_status, update.objective_status || null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ objective: data });
    } catch (err) {
        console.error('Strategic-planning PUT /objectives/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/objectives/:objectiveId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.objectiveId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchObjective(cid, id);
    if (!existing) return res.status(404).json({ error: 'Objective not found' });
    if (existing.objective_status === 'cancelled') return res.status(400).json({ error: 'Objective is already cancelled.' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel an objective.' });

    try {
        const { data, error } = await supabase.from('practice_strategic_objectives')
            .update({ objective_status: 'cancelled', internal_notes: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: existing.plan_id, objectiveId: id }, 'objective_cancelled', existing.objective_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ objective: data });
    } catch (err) {
        console.error('Strategic-planning DELETE /objectives/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// INITIATIVES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/objectives/:objectiveId/initiatives', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_strategic_initiatives').select('*').eq('company_id', cid).eq('objective_id', req.params.objectiveId).order('created_at');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ initiatives: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET initiatives error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/objectives/:objectiveId/initiatives', async (req, res) => {
    const cid = req.companyId;
    const objectiveId = parseInt(req.params.objectiveId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const objective = await _fetchObjective(cid, objectiveId);
    if (!objective) return res.status(404).json({ error: 'Objective not found' });

    const { initiative_title } = req.body;
    if (!initiative_title) return res.status(400).json({ error: 'initiative_title is required' });

    try {
        const { data, error } = await supabase.from('practice_strategic_initiatives').insert({
            company_id: cid, objective_id: objectiveId, initiative_title, initiative_description: req.body.initiative_description || null,
            owner_team_member_id: req.body.owner_team_member_id || null, start_date: req.body.start_date || null, due_date: req.body.due_date || null,
            progress_percentage: req.body.progress_percentage || 0, blocker_notes: req.body.blocker_notes || null, next_action: req.body.next_action || null,
            notes: req.body.notes || null, settings: req.body.settings || {}, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: objective.plan_id, objectiveId, initiativeId: data.id }, 'initiative_created', null, data.initiative_status, req.user.userId, initiative_title, {});
        res.status(201).json({ initiative: data });
    } catch (err) {
        console.error('Strategic-planning POST initiatives error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/initiatives/:initiativeId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.initiativeId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchInitiative(cid, id);
    if (!existing) return res.status(404).json({ error: 'Initiative not found' });

    const allowed = ['initiative_title', 'initiative_description', 'initiative_status', 'owner_team_member_id', 'start_date', 'due_date', 'progress_percentage', 'blocker_notes', 'next_action', 'notes', 'settings'];
    const update = _pick(req.body, allowed);
    if (update.initiative_status && !INITIATIVE_STATUSES.includes(update.initiative_status)) return res.status(400).json({ error: 'Invalid initiative_status' });
    if (update.initiative_status === 'completed' && existing.initiative_status !== 'completed') {
        update.completed_at = new Date().toISOString();
        update.progress_percentage = 100;
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_strategic_initiatives').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        const objective = await _fetchObjective(cid, existing.objective_id);
        const eventType = (update.initiative_status && update.initiative_status !== existing.initiative_status) ? 'initiative_status_changed' : 'initiative_updated';
        await _writeEvent(cid, { planId: objective?.plan_id, objectiveId: existing.objective_id, initiativeId: id }, eventType, existing.initiative_status, update.initiative_status || null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ initiative: data });
    } catch (err) {
        console.error('Strategic-planning PUT /initiatives/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/initiatives/:initiativeId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.initiativeId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchInitiative(cid, id);
    if (!existing) return res.status(404).json({ error: 'Initiative not found' });
    if (existing.initiative_status === 'cancelled') return res.status(400).json({ error: 'Initiative is already cancelled.' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel an initiative.' });

    try {
        const { data, error } = await supabase.from('practice_strategic_initiatives')
            .update({ initiative_status: 'cancelled', blocker_notes: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        const objective = await _fetchObjective(cid, existing.objective_id);
        await _writeEvent(cid, { planId: objective?.plan_id, objectiveId: existing.objective_id, initiativeId: id }, 'initiative_cancelled', existing.initiative_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ initiative: data });
    } catch (err) {
        console.error('Strategic-planning DELETE /initiatives/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// KPI LINKS
// ═══════════════════════════════════════════════════════════════════════════

// GET refreshes this objective's links against known-safe sources before
// returning them — bounded to one objective's (small) link set, never
// company-wide. See _refreshKpiLinks()/_sharedSourceData() above.
router.get('/objectives/:objectiveId/kpis', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_strategic_kpi_links').select('*').eq('company_id', cid).eq('objective_id', req.params.objectiveId).order('created_at');
        if (error) return res.status(500).json({ error: error.message });
        const refreshed = await _refreshKpiLinks(cid, data || []);
        res.json({ kpi_links: refreshed.map(l => ({ ...l, computed_progress: _kpiLinkProgress(l) })) });
    } catch (err) {
        console.error('Strategic-planning GET kpis error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/objectives/:objectiveId/kpis', async (req, res) => {
    const cid = req.companyId;
    const objectiveId = parseInt(req.params.objectiveId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const objective = await _fetchObjective(cid, objectiveId);
    if (!objective) return res.status(404).json({ error: 'Objective not found' });

    const { kpi_source, metric_key, metric_label, direction } = req.body;
    if (!KPI_SOURCES.includes(kpi_source)) return res.status(400).json({ error: `Invalid kpi_source. Allowed: ${KPI_SOURCES.join(', ')}` });
    if (!metric_key) return res.status(400).json({ error: 'metric_key is required' });
    if (!metric_label) return res.status(400).json({ error: 'metric_label is required' });
    if (!KPI_DIRECTIONS.includes(direction)) return res.status(400).json({ error: `Invalid direction. Allowed: ${KPI_DIRECTIONS.join(', ')}` });

    try {
        const { data, error } = await supabase.from('practice_strategic_kpi_links').insert({
            company_id: cid, objective_id: objectiveId, kpi_source, metric_key, metric_label,
            baseline_value: req.body.baseline_value ?? null, target_value: req.body.target_value ?? null, current_value: req.body.current_value ?? null,
            direction, weight: req.body.weight != null ? req.body.weight : 1, notes: req.body.notes || null,
            settings: req.body.settings || {}, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const [refreshed] = kpi_source !== 'custom' ? await _refreshKpiLinks(cid, [data]) : [data];
        await _writeEvent(cid, { planId: objective.plan_id, objectiveId, kpiLinkId: data.id }, 'kpi_link_created', null, null, req.user.userId, metric_label, { kpi_source, metric_key });
        res.status(201).json({ kpi_link: refreshed });
    } catch (err) {
        console.error('Strategic-planning POST kpis error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/kpis/:kpiId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.kpiId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchKpiLink(cid, id);
    if (!existing) return res.status(404).json({ error: 'KPI link not found' });

    const allowed = ['metric_key', 'metric_label', 'baseline_value', 'target_value', 'current_value', 'direction', 'weight', 'notes', 'settings'];
    const update = _pick(req.body, allowed);
    if (update.direction && !KPI_DIRECTIONS.includes(update.direction)) return res.status(400).json({ error: 'Invalid direction' });
    // A manual edit to current_value is an explicit human override — always
    // marks confidence back to 'manual' so an auto-refresh doesn't silently
    // appear to have validated a value the user just typed in themselves.
    if ('current_value' in update) update.confidence = 'manual';
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_strategic_kpi_links').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { objectiveId: existing.objective_id, kpiLinkId: id }, 'kpi_link_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ kpi_link: data });
    } catch (err) {
        console.error('Strategic-planning PUT /kpis/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/kpis/:kpiId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.kpiId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchKpiLink(cid, id);
    if (!existing) return res.status(404).json({ error: 'KPI link not found' });

    try {
        const { error } = await supabase.from('practice_strategic_kpi_links').delete().eq('id', id).eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { objectiveId: existing.objective_id, kpiLinkId: id }, 'kpi_link_cancelled', null, null, req.user.userId, req.body?.reason || null, {});
        res.json({ success: true });
    } catch (err) {
        console.error('Strategic-planning DELETE /kpis/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/plans/:id/reviews', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_strategic_reviews').select('*').eq('company_id', cid).eq('plan_id', req.params.id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ reviews: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/plans/:id/reviews', async (req, res) => {
    const cid = req.companyId;
    const planId = parseInt(req.params.id);
    const member = await _requireManager(req, res);
    if (!member) return;

    const plan = await _fetchPlan(cid, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const { review_title } = req.body;
    if (!review_title) return res.status(400).json({ error: 'review_title is required' });

    try {
        let overallProgress = req.body.overall_progress ?? null;
        if (overallProgress == null) {
            try { overallProgress = (await getStrategicPlanHealth(cid, planId)).overall_progress; } catch (e) { /* leave null */ }
        }

        const { data, error } = await supabase.from('practice_strategic_reviews').insert({
            company_id: cid, plan_id: planId, review_title, review_period_start: req.body.review_period_start || null,
            review_period_end: req.body.review_period_end || null, overall_progress: overallProgress,
            review_summary: req.body.review_summary || null, wins: req.body.wins || null, concerns: req.body.concerns || null,
            decisions: req.body.decisions || null, action_items: req.body.action_items || null, partner_notes: req.body.partner_notes || null,
            next_review_date: req.body.next_review_date || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        // A review opened against an active plan puts the plan under formal
        // review — reachable only this way (see docs: no separate "start
        // review" action was specified). Completing the review returns the
        // plan to 'active'.
        if (plan.plan_status === 'active') {
            await supabase.from('practice_strategic_plans').update({ plan_status: 'under_review', updated_at: new Date().toISOString() }).eq('id', planId).eq('company_id', cid);
        }

        await _writeEvent(cid, { planId, reviewId: data.id }, 'review_created', null, data.review_status, req.user.userId, review_title, {});
        res.status(201).json({ review: data });
    } catch (err) {
        console.error('Strategic-planning POST reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/reviews/:reviewId', async (req, res) => {
    const review = await _fetchReview(req.companyId, req.params.reviewId);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json({ review });
});

router.put('/reviews/:reviewId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.reviewId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (['completed', 'cancelled'].includes(existing.review_status)) return res.status(400).json({ error: `Cannot edit a review that is already ${existing.review_status}.` });

    const allowed = ['review_title', 'review_period_start', 'review_period_end', 'overall_progress', 'review_summary', 'wins', 'concerns', 'decisions', 'action_items', 'partner_notes', 'next_review_date'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_strategic_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: existing.plan_id, reviewId: id }, 'review_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ review: data });
    } catch (err) {
        console.error('Strategic-planning PUT /reviews/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/reviews/:reviewId/complete', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.reviewId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (!['draft', 'under_review', 'action_required'].includes(review.review_status)) {
        return res.status(422).json({ error: `Cannot complete from status "${review.review_status}".` });
    }

    try {
        const { data, error } = await supabase.from('practice_strategic_reviews')
            .update({ review_status: 'completed', reviewed_by: req.user.userId, reviewed_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const plan = await _fetchPlan(cid, review.plan_id);
        if (plan && plan.plan_status === 'under_review') {
            await supabase.from('practice_strategic_plans').update({ plan_status: 'active', updated_at: new Date().toISOString() }).eq('id', review.plan_id).eq('company_id', cid);
        }

        await _writeEvent(cid, { planId: review.plan_id, reviewId: id }, 'review_completed', review.review_status, 'completed', req.user.userId, req.body.notes || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Strategic-planning PUT /reviews/:id/complete error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/reviews/:reviewId/action-required', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.reviewId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (!['draft', 'under_review'].includes(review.review_status)) {
        return res.status(422).json({ error: `Cannot mark action-required from status "${review.review_status}".` });
    }

    try {
        const { data, error } = await supabase.from('practice_strategic_reviews')
            .update({ review_status: 'action_required', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: review.plan_id, reviewId: id }, 'review_action_required', review.review_status, 'action_required', req.user.userId, req.body.notes || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Strategic-planning PUT /reviews/:id/action-required error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/reviews/:reviewId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.reviewId);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (['completed', 'cancelled'].includes(existing.review_status)) return res.status(400).json({ error: `Review is already ${existing.review_status}.` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel a review.' });

    try {
        const { data, error } = await supabase.from('practice_strategic_reviews')
            .update({ review_status: 'cancelled', cancellation_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, { planId: existing.plan_id, reviewId: id }, 'review_cancelled', existing.review_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Strategic-planning DELETE /reviews/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLAN HEALTH (engine, exposed read-only)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/plans/:id/health', async (req, res) => {
    try {
        res.json(await getStrategicPlanHealth(req.companyId, req.params.id));
    } catch (err) {
        console.error('Strategic-planning GET /plans/:id/health error:', err.message);
        res.status(err.message === 'Plan not found' ? 404 : 500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_strategic_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(500);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET /events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

const SOURCE_TYPE_COLUMNS = { plan: 'plan_id', objective: 'objective_id', initiative: 'initiative_id', 'kpi-link': 'kpi_link_id', review: 'review_id' };

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const column = SOURCE_TYPE_COLUMNS[req.params.sourceType];
    if (!column) return res.status(400).json({ error: `Invalid sourceType. Allowed: ${Object.keys(SOURCE_TYPE_COLUMNS).join(', ')}` });
    try {
        const { data, error } = await supabase.from('practice_strategic_events').select('*').eq('company_id', cid).eq(column, req.params.sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Strategic-planning GET /:sourceType/:sourceId/events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules' integrations (Management Dashboard, Partner
// Scorecards, Planning Board) — see docs/new-app/76_strategic_planning.md
module.exports.getStrategicPlanHealth = getStrategicPlanHealth;
