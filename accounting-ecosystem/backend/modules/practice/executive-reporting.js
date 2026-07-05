'use strict';

// Codebox 77 — Practice Executive Reporting + Board Pack Foundation
// "What decisions do we need to make today?" instead of "where is the
// information?" — a deterministic executive reporting layer assembled from
// every existing Practice engine.
//
// NOT Business Intelligence. NOT Power BI. NOT AI reporting. NOT financial
// statement reporting. buildExecutiveReport() below reuses existing
// exported engines only — see migration 134's header for the full,
// per-module reuse audit. No KPI/scoring logic is re-derived here.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const managementDashboard = require('./management-dashboard');
const partnerScorecards = require('./partner-scorecards');
const profitability = require('./profitability');
const capacity = require('./capacity');
const planningBoard = require('./planning-board');
const kpiHistory = require('./kpi-history');
const teamAccess = require('./lib/team-access');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) { PDFDocument = null; }

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const REPORT_TYPES = ['monthly', 'quarterly', 'annual', 'board', 'management', 'custom'];
const REPORT_STATUSES = ['draft', 'generated', 'under_review', 'approved', 'published', 'archived', 'cancelled'];
const TERMINAL_REPORT_STATUSES = ['archived', 'cancelled'];
// A report is safe to (re)generate or edit narrative fields on while still
// non-frozen. approved/published/archived are frozen — matches the
// approved-is-immutable convention used throughout this codebase.
const EDITABLE_REPORT_STATUSES = ['draft', 'generated', 'under_review'];

const SECTION_KEYS = [
    'executive_summary', 'practice_health', 'strategy', 'kpis', 'partner_scorecards',
    'profitability', 'pricing', 'client_success', 'capacity', 'planning', 'risk',
    'quality', 'secretarial', 'notifications', 'learning', 'recommendations',
    'decisions', 'actions',
];
const SECTION_STATUSES = ['included', 'hidden', 'manual'];

const DECISION_CATEGORIES = ['strategy', 'pricing', 'risk', 'quality', 'capacity', 'people', 'technology', 'client', 'secretarial', 'other'];
const DECISION_STATUSES = ['proposed', 'approved', 'deferred', 'rejected', 'implemented', 'cancelled'];

const ACTION_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const ACTION_STATUSES = ['open', 'in_progress', 'waiting', 'completed', 'cancelled'];

const DISCLAIMER = 'Internal executive management report — not financial statements or audit assurance. No AI-derived commentary.';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Executive reports become the official governance record for partner/board
// meetings — unlike the read-only reporting family this codebox builds on
// (Management Dashboard, KPI History, Partner Review Packs have no role
// gate at all), every write here is manager-gated via the canonical shared
// helper (CLAUDE.md: "always use the shared helper — never re-implement
// authorization logic").
async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can manage executive reports.');
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyReport(id, cid) {
    const { data } = await supabase.from('practice_executive_reports').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _verifyDecision(id, cid) {
    const { data } = await supabase.from('practice_executive_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _verifyAction(id, cid) {
    const { data } = await supabase.from('practice_executive_action_register').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, { reportId, decisionId, actionId }, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_executive_events').insert({
        company_id: cid,
        report_id: reportId || null,
        decision_id: decisionId || null,
        action_id: actionId || null,
        event_type: eventType,
        old_status: oldStatus || null,
        new_status: newStatus || null,
        actor_user_id: userId || null,
        notes: notes || null,
        metadata: meta || {},
    });
}

// Nearest active KPI snapshot at or before the given date — identical
// pattern to partner-review-packs.js (Codebox 52). Never a second KPI diff
// engine.
async function _nearestSnapshotAtOrBefore(cid, dateStr) {
    if (!dateStr) return null;
    const { data } = await supabase
        .from('practice_kpi_snapshots')
        .select('*')
        .eq('company_id', cid)
        .eq('status', 'active')
        .lte('generated_at', dateStr + 'T23:59:59.999Z')
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

// notifications.js exports no company-wide summary function (notify() is
// per-notification) — counts only, never re-deriving its internal scoring.
async function _notificationCounts(cid) {
    const today = new Date().toISOString().slice(0, 10);
    const [{ count: unread }, { count: overdue }, { count: critical }] = await Promise.all([
        supabase.from('practice_notifications').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('notification_status', ['new', 'read']),
        supabase.from('practice_notifications').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('notification_status', ['new', 'read']).lt('due_date', today),
        supabase.from('practice_notifications').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('severity', 'critical').in('notification_status', ['new', 'read']),
    ]);
    return { unread: unread || 0, overdue: overdue || 0, critical_unread: critical || 0 };
}

// learning-centre.js exports no company-wide summary function
// (calculateLearningProgress() is per-plan) — counts + cached progress
// average only, never re-deriving the per-plan calculation.
async function _learningCounts(cid) {
    const { data } = await supabase.from('practice_learning_plans').select('status, overall_progress').eq('company_id', cid);
    const rows = data || [];
    const active = rows.filter(r => r.status === 'active');
    const avgProgress = active.length ? Math.round((active.reduce((s, r) => s + (Number(r.overall_progress) || 0), 0) / active.length) * 100) / 100 : null;
    return { active_plans: active.length, total_plans: rows.length, avg_progress_pct: avgProgress };
}

// Deterministic confidence rating from the warnings/missing-information
// count — no AI, no fuzzy scoring. Documented Architect Freedom addition
// (the spec asks for "Confidence" in the engine's return without dictating
// a formula).
function _confidenceFromWarnings(warnings) {
    if (warnings.length === 0) return 'high';
    if (warnings.length <= 2) return 'medium';
    return 'low';
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT ENGINE — buildExecutiveReport()
// Reuses existing engines only. Returns { report_snapshot, sections,
// warnings, missing_information, confidence }.
// ═══════════════════════════════════════════════════════════════════════════

async function buildExecutiveReport(cid, { periodStart, periodEnd }) {
    const warnings = [];
    const missingInformation = [];

    const [
        summary, practiceScore, alerts, partnerQueue, feed,
        teamCapacity, itemPool, notifCounts, learningCounts,
    ] = await Promise.all([
        managementDashboard.computeSummary(cid),
        managementDashboard.computePracticeScore(cid),
        managementDashboard.computeAlerts(cid),
        managementDashboard.computePartnerReview(cid),
        managementDashboard.computeExecutiveFeed(cid, 20),
        capacity.buildTeamCapacity(cid),
        planningBoard.buildTeamItemPool(cid),
        _notificationCounts(cid),
        _learningCounts(cid),
    ]);

    // Practice-level scorecard — read-only reuse (partner-scorecards.js,
    // Codebox 75), never re-scored here.
    let practiceScorecard = null;
    try {
        practiceScorecard = await partnerScorecards.buildScorecard(cid, { scorecardType: 'practice', periodStart, periodEnd });
    } catch (e) {
        warnings.push(`Practice scorecard unavailable: ${e.message}`);
        missingInformation.push('partner_scorecards');
    }

    // Practice-wide profitability for the period — reuse calculateProfitability()
    // (Codebox 73) directly rather than the dashboard's flag-only counts.
    let profitabilitySummary = null;
    try {
        profitabilitySummary = await profitability.calculateProfitability({ companyId: cid, periodStart, periodEnd });
    } catch (e) {
        warnings.push(`Profitability summary unavailable: ${e.message}`);
        missingInformation.push('profitability');
    }

    // KPI trends — nearest active snapshot at/before each period boundary,
    // identical pattern to partner-review-packs.js. Never a second KPI engine.
    const snapshotStart = await _nearestSnapshotAtOrBefore(cid, periodStart);
    if (!snapshotStart) { warnings.push(`No KPI snapshot found at or before the period start (${periodStart}).`); missingInformation.push('kpi_trends_start'); }
    const snapshotEnd = await _nearestSnapshotAtOrBefore(cid, periodEnd);
    if (!snapshotEnd) warnings.push(`No KPI snapshot found at or before the period end (${periodEnd}) — end-of-period figures use live current-state data instead.`);

    const kpiTrends = kpiHistory.METRIC_KEYS.map(key => {
        const extractor = kpiHistory.METRIC_EXTRACTORS[key];
        const startVal = snapshotStart ? extractor(snapshotStart) ?? null : null;
        const endVal = snapshotEnd ? extractor(snapshotEnd) ?? null : (extractor({ kpi_data: summary, score_data: practiceScore }) ?? null);
        const bothKnown = startVal != null && endVal != null;
        return {
            metric_key: key,
            start_value: startVal,
            end_value: endVal,
            delta: bothKnown ? endVal - startVal : null,
            delta_percentage: bothKnown ? kpiHistory.deltaPct(endVal, startVal) : null,
            direction: bothKnown ? kpiHistory.direction(endVal - startVal) : null,
        };
    });

    const generatedAt = new Date().toISOString();

    // Sections — each entry becomes one practice_executive_report_sections
    // row (upserted by section_key). data is exactly what's reused above;
    // nothing here recomputes a KPI/score.
    const sectionDefs = [
        { section_key: 'practice_health', section_title: 'Practice Health', section_order: 1, data: { score: practiceScore, summary } },
        { section_key: 'strategy', section_title: 'Strategic Progress', section_order: 2, data: summary.strategic_planning },
        { section_key: 'kpis', section_title: 'KPI Trends', section_order: 3, data: { trends: kpiTrends, snapshots: { start: snapshotStart ? { id: snapshotStart.id, generated_at: snapshotStart.generated_at } : null, end: snapshotEnd ? { id: snapshotEnd.id, generated_at: snapshotEnd.generated_at } : null } } },
        { section_key: 'partner_scorecards', section_title: 'Partner Scorecards', section_order: 4, data: practiceScorecard },
        { section_key: 'profitability', section_title: 'Profitability', section_order: 5, data: profitabilitySummary || { unavailable: true, dashboard_flags: summary.profitability } },
        { section_key: 'pricing', section_title: 'Pricing Reviews', section_order: 6, data: summary.pricing_review },
        { section_key: 'client_success', section_title: 'Client Success', section_order: 7, data: { relationship: summary.client_relationship, health: summary.client_health } },
        { section_key: 'capacity', section_title: 'Capacity', section_order: 8, data: { rollup: summary.capacity, team: teamCapacity } },
        { section_key: 'planning', section_title: 'Planning & Workload', section_order: 9, data: { total_items: (itemPool.items || []).length, items_by_priority: (itemPool.items || []).reduce((acc, i) => { acc[i.priority_label || 'unknown'] = (acc[i.priority_label || 'unknown'] || 0) + 1; return acc; }, {}) } },
        { section_key: 'risk', section_title: 'Risk', section_order: 10, data: summary.risk },
        { section_key: 'quality', section_title: 'Quality (QMS)', section_order: 11, data: summary.qms },
        { section_key: 'secretarial', section_title: 'Secretarial & Compliance', section_order: 12, data: { statutory: summary.statutory_compliance, evidence: summary.evidence_readiness, integrity: summary.secretarial_integrity } },
        { section_key: 'notifications', section_title: 'Notifications', section_order: 13, data: notifCounts },
        { section_key: 'learning', section_title: 'Learning & Development', section_order: 14, data: learningCounts },
    ];

    const reportSnapshot = {
        period: { period_start: periodStart, period_end: periodEnd },
        generated_at: generatedAt,
        practice_score: practiceScore,
        alerts,
        partner_queue: partnerQueue,
        executive_feed: feed,
        warnings,
        missing_information: missingInformation,
        confidence: _confidenceFromWarnings(warnings),
        assumptions: [
            'All figures are deterministic counts/scores computed from existing Practice modules — no forecasting, prediction, or AI-derived commentary.',
            'Nearest available KPI snapshot at or before each period boundary was used for KPI Trends when an exact-date snapshot did not exist.',
            'Risk and QMS figures are reused from the Management Dashboard aggregate — never re-queried or re-scored independently.',
        ],
    };

    return { reportSnapshot, sectionDefs, warnings, missingInformation, confidence: reportSnapshot.confidence };
}

// Upserts the section rows for a report from buildExecutiveReport()'s
// sectionDefs — idempotent per (report_id, section_key), never duplicates
// on regenerate. Manual sections a partner already added are left alone.
async function _upsertSections(cid, reportId, sectionDefs, userId) {
    const { data: existing } = await supabase.from('practice_executive_report_sections').select('section_key, section_status').eq('report_id', reportId).eq('company_id', cid);
    const existingByKey = {};
    (existing || []).forEach(s => { existingByKey[s.section_key] = s; });

    for (const def of sectionDefs) {
        const already = existingByKey[def.section_key];
        if (already && already.section_status === 'manual') continue; // never overwrite a manual section
        await supabase.from('practice_executive_report_sections').upsert({
            company_id: cid, report_id: reportId,
            section_key: def.section_key, section_title: def.section_title, section_order: def.section_order,
            section_status: already ? already.section_status : 'included',
            section_snapshot: def.data,
            updated_by: userId || null,
        }, { onConflict: 'report_id,section_key' });
    }
}

// ── Routes: Summary (dashboard integration) ────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [{ data: latestRows }, { count: awaitingApproval }, { count: outstandingActions }, { count: openDecisions }] = await Promise.all([
            supabase.from('practice_executive_reports').select('id, report_title, report_type, report_status, period_start, period_end, generated_at, created_at').eq('company_id', cid).not('report_status', 'in', '("cancelled")').order('created_at', { ascending: false }).limit(1),
            supabase.from('practice_executive_reports').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('report_status', 'under_review'),
            supabase.from('practice_executive_action_register').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['open', 'in_progress', 'waiting']),
            supabase.from('practice_executive_decisions').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('decision_status', ['proposed', 'deferred']),
        ]);

        return res.json({
            latest_report: (latestRows || [])[0] || null,
            reports_awaiting_approval: awaitingApproval || 0,
            outstanding_actions: outstandingActions || 0,
            open_decisions: openDecisions || 0,
        });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/summary', err);
        return res.status(500).json({ error: 'Failed to load executive reporting summary.' });
    }
});

// ── Routes: Reports CRUD ────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { report_status, report_type, period_from, period_to, page = 1, limit = 50 } = req.query;
    try {
        if (report_status && !REPORT_STATUSES.includes(report_status)) return res.status(400).json({ error: `Invalid report_status. Allowed: ${REPORT_STATUSES.join(', ')}` });
        if (report_type && !REPORT_TYPES.includes(report_type)) return res.status(400).json({ error: `Invalid report_type. Allowed: ${REPORT_TYPES.join(', ')}` });

        let q = supabase.from('practice_executive_reports')
            .select('id, report_title, report_type, report_status, period_start, period_end, period_key, generated_by, generated_at, approved_by, approved_at, published_by, published_at, created_at, updated_at', { count: 'exact' })
            .eq('company_id', cid);

        if (report_status) q = q.eq('report_status', report_status);
        if (report_type) q = q.eq('report_type', report_type);
        if (period_from) q = q.gte('period_start', period_from);
        if (period_to) q = q.lte('period_end', period_to);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;
        q = q.order('period_start', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ reports: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting', err);
        return res.status(500).json({ error: 'Failed to load executive reports.' });
    }
});

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const { report_title, report_type, period_start, period_end, period_key, executive_summary, practice_health_summary, key_wins, key_concerns, key_decisions, recommendations } = req.body || {};

    if (!report_title || !String(report_title).trim()) return res.status(400).json({ error: 'report_title is required.' });
    if (!REPORT_TYPES.includes(report_type)) return res.status(400).json({ error: `report_type must be one of: ${REPORT_TYPES.join(', ')}` });
    if (!period_start) return res.status(400).json({ error: 'period_start is required.' });
    if (!period_end) return res.status(400).json({ error: 'period_end is required.' });
    if (period_end < period_start) return res.status(400).json({ error: 'period_end cannot be before period_start.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: report, error } = await supabase.from('practice_executive_reports').insert({
            company_id: cid, report_title: String(report_title).trim(), report_type, report_status: 'draft',
            period_start, period_end, period_key: period_key || null,
            executive_summary: executive_summary || null, practice_health_summary: practice_health_summary || null,
            key_wins: key_wins || null, key_concerns: key_concerns || null, key_decisions: key_decisions || null, recommendations: recommendations || null,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_created', null, 'draft', req.user?.userId, null, {});
        await auditFromReq(req, 'executive_report_created', 'practice_executive_report', report.id, {});

        return res.status(201).json({ report });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting', err);
        return res.status(500).json({ error: 'Failed to create executive report.' });
    }
});

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        return res.json({ report });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id', err);
        return res.status(500).json({ error: 'Failed to load executive report.' });
    }
});

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['report_title', 'executive_summary', 'practice_health_summary', 'key_wins', 'key_concerns', 'key_decisions', 'recommendations'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (!EDITABLE_REPORT_STATUSES.includes(report.report_status)) return res.status(422).json({ error: `Cannot edit a report in "${report.report_status}" status.` });

        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ ...patch, updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'executive_report_updated', 'practice_executive_report', report.id, { fields: Object.keys(patch) });

        return res.json({ report: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id', err);
        return res.status(500).json({ error: 'Failed to update executive report.' });
    }
});

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required to cancel an executive report.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (TERMINAL_REPORT_STATUSES.includes(report.report_status)) return res.status(422).json({ error: `Report is already ${report.report_status}.` });

        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ report_status: 'cancelled', cancellation_reason: String(reason).trim(), updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_cancelled', report.report_status, 'cancelled', req.user?.userId, String(reason).trim(), {});
        await auditFromReq(req, 'executive_report_cancelled', 'practice_executive_report', report.id, {});

        return res.json({ report: updated });
    } catch (err) {
        console.error('DELETE /api/practice/executive-reporting/:id', err);
        return res.status(500).json({ error: 'Failed to cancel executive report.' });
    }
});

// ── Routes: Generate report (frozen snapshot) ───────────────────────────────────
// "Generate again if updated information is required. Snapshots are
// immutable." — allowed from draft/generated/under_review (never
// approved+); each call fully overwrites report_snapshot and upserts
// engine-sourced sections.

router.post('/:id/generate', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (!EDITABLE_REPORT_STATUSES.includes(report.report_status)) {
            return res.status(422).json({ error: `Cannot generate a report in "${report.report_status}" status. Reports are frozen once approved.` });
        }

        const { reportSnapshot, sectionDefs, warnings, missingInformation, confidence } = await buildExecutiveReport(cid, {
            periodStart: report.period_start, periodEnd: report.period_end,
        });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_executive_reports').update({
            report_status: 'generated', report_snapshot: reportSnapshot,
            generated_by: req.user?.userId || null, generated_at: now, updated_by: req.user?.userId,
        }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _upsertSections(cid, report.id, sectionDefs, req.user?.userId);
        await _writeEvent(cid, { reportId: report.id }, 'report_generated', report.report_status, 'generated', req.user?.userId, null, { warnings_count: warnings.length, confidence });
        await auditFromReq(req, 'executive_report_generated', 'practice_executive_report', report.id, { confidence });

        return res.json({ report: updated, warnings, missing_information: missingInformation, confidence });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting/:id/generate', err);
        return res.status(500).json({ error: 'Failed to generate executive report.' });
    }
});

// Convenience one-shot create+generate — matches partner-review-packs.js's
// /generate shape exactly for callers (e.g. Strategic Planning's "Create
// Executive Report from strategic review") that want a single call.

router.post('/generate', async (req, res) => {
    const cid = req.companyId;
    const { report_title, report_type, period_start, period_end, period_key, executive_summary } = req.body || {};

    if (!report_title || !String(report_title).trim()) return res.status(400).json({ error: 'report_title is required.' });
    if (!REPORT_TYPES.includes(report_type)) return res.status(400).json({ error: `report_type must be one of: ${REPORT_TYPES.join(', ')}` });
    if (!period_start) return res.status(400).json({ error: 'period_start is required.' });
    if (!period_end) return res.status(400).json({ error: 'period_end is required.' });
    if (period_end < period_start) return res.status(400).json({ error: 'period_end cannot be before period_start.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { reportSnapshot, sectionDefs, warnings, missingInformation, confidence } = await buildExecutiveReport(cid, { periodStart: period_start, periodEnd: period_end });

        const now = new Date().toISOString();
        const { data: report, error } = await supabase.from('practice_executive_reports').insert({
            company_id: cid, report_title: String(report_title).trim(), report_type, report_status: 'generated',
            period_start, period_end, period_key: period_key || null,
            executive_summary: executive_summary || null, report_snapshot: reportSnapshot,
            generated_by: req.user?.userId || null, generated_at: now,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _upsertSections(cid, report.id, sectionDefs, req.user?.userId);
        await _writeEvent(cid, { reportId: report.id }, 'report_created', null, 'draft', req.user?.userId, null, {});
        await _writeEvent(cid, { reportId: report.id }, 'report_generated', 'draft', 'generated', req.user?.userId, null, { warnings_count: warnings.length, confidence });
        await auditFromReq(req, 'executive_report_generated', 'practice_executive_report', report.id, { confidence });

        return res.status(201).json({ report, warnings, missing_information: missingInformation, confidence });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting/generate', err);
        return res.status(500).json({ error: 'Failed to generate executive report.' });
    }
});

// ── Routes: Workflow (submit-review / approve / publish / archive) ─────────────

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (report.report_status !== 'generated') return res.status(422).json({ error: `Report must be "generated" to submit for review. Current: "${report.report_status}".` });

        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ report_status: 'under_review', updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_reviewed', report.report_status, 'under_review', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_report_submitted_review', 'practice_executive_report', report.id, {});

        return res.json({ report: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id/submit-review', err);
        return res.status(500).json({ error: 'Failed to submit report for review.' });
    }
});

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (report.report_status !== 'under_review') return res.status(422).json({ error: `Report must be "under_review" to approve. Current: "${report.report_status}".` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ report_status: 'approved', approved_by: req.user?.userId || null, approved_at: now, updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_approved', 'under_review', 'approved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_report_approved', 'practice_executive_report', report.id, {});

        return res.json({ report: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve executive report.' });
    }
});

router.put('/:id/publish', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (report.report_status !== 'approved') return res.status(422).json({ error: `Report must be "approved" to publish. Current: "${report.report_status}".` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ report_status: 'published', published_by: req.user?.userId || null, published_at: now, updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_published', 'approved', 'published', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_report_published', 'practice_executive_report', report.id, {});

        return res.json({ report: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id/publish', err);
        return res.status(500).json({ error: 'Failed to publish executive report.' });
    }
});

router.put('/:id/archive', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        if (!['approved', 'published'].includes(report.report_status)) return res.status(422).json({ error: `Report must be "approved" or "published" to archive. Current: "${report.report_status}".` });

        const { data: updated, error } = await supabase.from('practice_executive_reports').update({ report_status: 'archived', updated_by: req.user?.userId }).eq('id', report.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id }, 'report_archived', report.report_status, 'archived', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_report_archived', 'practice_executive_report', report.id, {});

        return res.json({ report: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id/archive', err);
        return res.status(500).json({ error: 'Failed to archive executive report.' });
    }
});

// ── Routes: Report data / HTML / PDF ────────────────────────────────────────────

router.get('/:id/report-data', async (req, res) => {
    const cid = req.companyId;
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        const { data: sections } = await supabase.from('practice_executive_report_sections').select('*').eq('report_id', report.id).eq('company_id', cid).order('section_order');
        return res.json({ report, sections: sections || [], disclaimer: DISCLAIMER });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id/report-data', err);
        return res.status(500).json({ error: 'Failed to load report data.' });
    }
});

router.get('/:id/report-html', async (req, res) => {
    const cid = req.companyId;
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        const { data: sections } = await supabase.from('practice_executive_report_sections').select('*').eq('report_id', report.id).eq('company_id', cid).eq('section_status', 'included').order('section_order');
        const { data: decisions } = await supabase.from('practice_executive_decisions').select('*').eq('report_id', report.id).eq('company_id', cid).order('created_at');
        const { data: actions } = await supabase.from('practice_executive_action_register').select('*').eq('report_id', report.id).eq('company_id', cid).order('created_at');

        await _writeEvent(cid, { reportId: report.id }, 'report_updated', null, null, req.user?.userId, null, { action: 'report_viewed', format: 'html' });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(_buildHtmlReport(report, sections || [], decisions || [], actions || []));
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id/report-html', err);
        return res.status(500).json({ error: 'Failed to render report.' });
    }
});

router.get('/:id/report-pdf', async (req, res) => {
    const cid = req.companyId;
    if (!PDFDocument) return res.status(503).json({ error: 'PDF generation is not available on this server.' });
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        const { data: sections } = await supabase.from('practice_executive_report_sections').select('*').eq('report_id', report.id).eq('company_id', cid).eq('section_status', 'included').order('section_order');
        const { data: decisions } = await supabase.from('practice_executive_decisions').select('*').eq('report_id', report.id).eq('company_id', cid).order('created_at');
        const { data: actions } = await supabase.from('practice_executive_action_register').select('*').eq('report_id', report.id).eq('company_id', cid).order('created_at');

        await _writeEvent(cid, { reportId: report.id }, 'report_updated', null, null, req.user?.userId, null, { action: 'pdf_downloaded' });

        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="executive-report-${report.id}.pdf"`);
        doc.pipe(res);
        _buildPdfReport(doc, report, sections || [], decisions || [], actions || []);
        doc.end();
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id/report-pdf', err);
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to generate PDF.' });
    }
});

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        const { data, error } = await supabase.from('practice_executive_events').select('*').eq('report_id', report.id).eq('company_id', cid).order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

// ── Routes: Sections ─────────────────────────────────────────────────────────────

router.get('/:id/sections', async (req, res) => {
    const cid = req.companyId;
    try {
        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });
        const { data, error } = await supabase.from('practice_executive_report_sections').select('*').eq('report_id', report.id).eq('company_id', cid).order('section_order');
        if (error) throw error;
        return res.json({ sections: data || [] });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/:id/sections', err);
        return res.status(500).json({ error: 'Failed to load sections.' });
    }
});

router.post('/:id/sections', async (req, res) => {
    const cid = req.companyId;
    const { section_key, section_title, section_order, notes } = req.body || {};
    if (!SECTION_KEYS.includes(section_key)) return res.status(400).json({ error: `section_key must be one of: ${SECTION_KEYS.join(', ')}` });
    if (!section_title || !String(section_title).trim()) return res.status(400).json({ error: 'section_title is required.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });

        const { data: existing } = await supabase.from('practice_executive_report_sections').select('id').eq('report_id', report.id).eq('company_id', cid).eq('section_key', section_key).maybeSingle();
        if (existing) return res.status(409).json({ error: `A "${section_key}" section already exists on this report.` });

        const { data, error } = await supabase.from('practice_executive_report_sections').insert({
            company_id: cid, report_id: report.id, section_key, section_title: String(section_title).trim(),
            section_order: section_order != null ? parseInt(section_order, 10) : 99, section_status: 'manual',
            section_snapshot: null, notes: notes || null,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        return res.status(201).json({ section: data });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting/:id/sections', err);
        return res.status(500).json({ error: 'Failed to add section.' });
    }
});

router.put('/:id/sections/:sectionId', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['section_title', 'section_order', 'section_status', 'notes'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (patch.section_status && !SECTION_STATUSES.includes(patch.section_status)) return res.status(400).json({ error: `section_status must be one of: ${SECTION_STATUSES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: section } = await supabase.from('practice_executive_report_sections').select('*').eq('id', req.params.sectionId).eq('report_id', req.params.id).eq('company_id', cid).maybeSingle();
        if (!section) return res.status(404).json({ error: 'Section not found.' });

        const { data: updated, error } = await supabase.from('practice_executive_report_sections').update({ ...patch, updated_by: req.user?.userId }).eq('id', section.id).eq('company_id', cid).select().single();
        if (error) throw error;
        return res.json({ section: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/:id/sections/:sectionId', err);
        return res.status(500).json({ error: 'Failed to update section.' });
    }
});

router.delete('/:id/sections/:sectionId', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: section } = await supabase.from('practice_executive_report_sections').select('*').eq('id', req.params.sectionId).eq('report_id', req.params.id).eq('company_id', cid).maybeSingle();
        if (!section) return res.status(404).json({ error: 'Section not found.' });
        if (section.section_status !== 'manual') return res.status(422).json({ error: 'Only a manual section can be removed. Hide an engine-sourced section instead (PUT section_status="hidden").' });

        const { error } = await supabase.from('practice_executive_report_sections').delete().eq('id', section.id).eq('company_id', cid);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('DELETE /api/practice/executive-reporting/:id/sections/:sectionId', err);
        return res.status(500).json({ error: 'Failed to remove section.' });
    }
});

// ── Routes: Decisions ─────────────────────────────────────────────────────────────
// Executive decision register only — never creates practice_tasks or
// workflow items.

router.get('/decisions', async (req, res) => {
    const cid = req.companyId;
    const { decision_status, decision_category, report_id, owner_team_member_id, page = 1, limit = 50 } = req.query;
    try {
        if (decision_status && !DECISION_STATUSES.includes(decision_status)) return res.status(400).json({ error: `Invalid decision_status. Allowed: ${DECISION_STATUSES.join(', ')}` });
        if (decision_category && !DECISION_CATEGORIES.includes(decision_category)) return res.status(400).json({ error: `Invalid decision_category. Allowed: ${DECISION_CATEGORIES.join(', ')}` });

        let q = supabase.from('practice_executive_decisions').select('*', { count: 'exact' }).eq('company_id', cid);
        if (decision_status) q = q.eq('decision_status', decision_status);
        if (decision_category) q = q.eq('decision_category', decision_category);
        if (report_id) q = q.eq('report_id', parseInt(report_id, 10));
        if (owner_team_member_id) q = q.eq('owner_team_member_id', parseInt(owner_team_member_id, 10));

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ decisions: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/decisions', err);
        return res.status(500).json({ error: 'Failed to load decisions.' });
    }
});

router.post('/:id/decisions', async (req, res) => {
    const cid = req.companyId;
    const { decision_title, decision_description, decision_category, owner_team_member_id, due_date, notes } = req.body || {};
    if (!decision_title || !String(decision_title).trim()) return res.status(400).json({ error: 'decision_title is required.' });
    if (!DECISION_CATEGORIES.includes(decision_category)) return res.status(400).json({ error: `decision_category must be one of: ${DECISION_CATEGORIES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });

        const { data, error } = await supabase.from('practice_executive_decisions').insert({
            company_id: cid, report_id: report.id, decision_title: String(decision_title).trim(), decision_description: decision_description || null,
            decision_category, owner_team_member_id: owner_team_member_id || null, due_date: due_date || null, notes: notes || null,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id, decisionId: data.id }, 'decision_created', null, data.decision_status, req.user?.userId, null, {});
        await auditFromReq(req, 'executive_decision_created', 'practice_executive_decision', data.id, {});

        return res.status(201).json({ decision: data });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting/:id/decisions', err);
        return res.status(500).json({ error: 'Failed to create decision.' });
    }
});

router.put('/decisions/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['decision_title', 'decision_description', 'decision_category', 'decision_status', 'owner_team_member_id', 'due_date', 'notes'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (patch.decision_category && !DECISION_CATEGORIES.includes(patch.decision_category)) return res.status(400).json({ error: `Invalid decision_category. Allowed: ${DECISION_CATEGORIES.join(', ')}` });
    if (patch.decision_status && !DECISION_STATUSES.includes(patch.decision_status)) return res.status(400).json({ error: `Invalid decision_status. Allowed: ${DECISION_STATUSES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const decision = await _verifyDecision(req.params.id, cid);
        if (!decision) return res.status(404).json({ error: 'Decision not found.' });
        if (decision.decision_status === 'cancelled') return res.status(422).json({ error: 'Cannot edit a cancelled decision.' });

        const { data: updated, error } = await supabase.from('practice_executive_decisions').update({ ...patch, updated_by: req.user?.userId }).eq('id', decision.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: decision.report_id, decisionId: decision.id }, 'decision_updated', decision.decision_status, updated.decision_status, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'executive_decision_updated', 'practice_executive_decision', decision.id, { fields: Object.keys(patch) });

        return res.json({ decision: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/decisions/:id', err);
        return res.status(500).json({ error: 'Failed to update decision.' });
    }
});

router.put('/decisions/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const decision = await _verifyDecision(req.params.id, cid);
        if (!decision) return res.status(404).json({ error: 'Decision not found.' });
        if (['implemented', 'cancelled', 'rejected'].includes(decision.decision_status)) return res.status(422).json({ error: `Decision is already "${decision.decision_status}".` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_executive_decisions').update({ decision_status: 'implemented', completed_at: now, updated_by: req.user?.userId }).eq('id', decision.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: decision.report_id, decisionId: decision.id }, 'decision_completed', decision.decision_status, 'implemented', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_decision_completed', 'practice_executive_decision', decision.id, {});

        return res.json({ decision: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/decisions/:id/complete', err);
        return res.status(500).json({ error: 'Failed to complete decision.' });
    }
});

router.delete('/decisions/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required to cancel a decision.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const decision = await _verifyDecision(req.params.id, cid);
        if (!decision) return res.status(404).json({ error: 'Decision not found.' });
        if (decision.decision_status === 'cancelled') return res.status(422).json({ error: 'Decision is already cancelled.' });

        const { data: updated, error } = await supabase.from('practice_executive_decisions').update({ decision_status: 'cancelled', cancellation_reason: String(reason).trim(), updated_by: req.user?.userId }).eq('id', decision.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: decision.report_id, decisionId: decision.id }, 'decision_cancelled', decision.decision_status, 'cancelled', req.user?.userId, String(reason).trim(), {});
        await auditFromReq(req, 'executive_decision_cancelled', 'practice_executive_decision', decision.id, {});

        return res.json({ decision: updated });
    } catch (err) {
        console.error('DELETE /api/practice/executive-reporting/decisions/:id', err);
        return res.status(500).json({ error: 'Failed to cancel decision.' });
    }
});

// ── Routes: Action Register ────────────────────────────────────────────────────
// Lightweight management follow-up items. Do NOT replace Task Management.

router.get('/actions', async (req, res) => {
    const cid = req.companyId;
    const { status, priority, report_id, decision_id, owner_team_member_id, page = 1, limit = 50 } = req.query;
    try {
        if (status && !ACTION_STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${ACTION_STATUSES.join(', ')}` });
        if (priority && !ACTION_PRIORITIES.includes(priority)) return res.status(400).json({ error: `Invalid priority. Allowed: ${ACTION_PRIORITIES.join(', ')}` });

        let q = supabase.from('practice_executive_action_register').select('*', { count: 'exact' }).eq('company_id', cid);
        if (status) q = q.eq('status', status);
        if (priority) q = q.eq('priority', priority);
        if (report_id) q = q.eq('report_id', parseInt(report_id, 10));
        if (decision_id) q = q.eq('decision_id', parseInt(decision_id, 10));
        if (owner_team_member_id) q = q.eq('owner_team_member_id', parseInt(owner_team_member_id, 10));

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('due_date', { ascending: true, nullsFirst: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ actions: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/actions', err);
        return res.status(500).json({ error: 'Failed to load actions.' });
    }
});

router.post('/:id/actions', async (req, res) => {
    const cid = req.companyId;
    const { decision_id, action_title, action_description, owner_team_member_id, priority, due_date, notes } = req.body || {};
    if (!action_title || !String(action_title).trim()) return res.status(400).json({ error: 'action_title is required.' });
    if (priority && !ACTION_PRIORITIES.includes(priority)) return res.status(400).json({ error: `priority must be one of: ${ACTION_PRIORITIES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const report = await _verifyReport(req.params.id, cid);
        if (!report) return res.status(404).json({ error: 'Executive report not found.' });

        if (decision_id) {
            const decision = await _verifyDecision(decision_id, cid);
            if (!decision) return res.status(404).json({ error: 'decision_id does not belong to this company.' });
        }

        const { data, error } = await supabase.from('practice_executive_action_register').insert({
            company_id: cid, report_id: report.id, decision_id: decision_id || null,
            action_title: String(action_title).trim(), action_description: action_description || null,
            owner_team_member_id: owner_team_member_id || null, priority: priority || 'medium', due_date: due_date || null, notes: notes || null,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: report.id, decisionId: decision_id || null, actionId: data.id }, 'action_created', null, data.status, req.user?.userId, null, {});
        await auditFromReq(req, 'executive_action_created', 'practice_executive_action', data.id, {});

        return res.status(201).json({ action: data });
    } catch (err) {
        console.error('POST /api/practice/executive-reporting/:id/actions', err);
        return res.status(500).json({ error: 'Failed to create action.' });
    }
});

router.put('/actions/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['action_title', 'action_description', 'owner_team_member_id', 'priority', 'status', 'due_date', 'notes'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (patch.priority && !ACTION_PRIORITIES.includes(patch.priority)) return res.status(400).json({ error: `Invalid priority. Allowed: ${ACTION_PRIORITIES.join(', ')}` });
    if (patch.status && !ACTION_STATUSES.includes(patch.status)) return res.status(400).json({ error: `Invalid status. Allowed: ${ACTION_STATUSES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const action = await _verifyAction(req.params.id, cid);
        if (!action) return res.status(404).json({ error: 'Action not found.' });
        if (action.status === 'cancelled') return res.status(422).json({ error: 'Cannot edit a cancelled action.' });

        const { data: updated, error } = await supabase.from('practice_executive_action_register').update({ ...patch, updated_by: req.user?.userId }).eq('id', action.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: action.report_id, decisionId: action.decision_id, actionId: action.id }, 'action_updated', action.status, updated.status, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'executive_action_updated', 'practice_executive_action', action.id, { fields: Object.keys(patch) });

        return res.json({ action: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/actions/:id', err);
        return res.status(500).json({ error: 'Failed to update action.' });
    }
});

router.put('/actions/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const action = await _verifyAction(req.params.id, cid);
        if (!action) return res.status(404).json({ error: 'Action not found.' });
        if (['completed', 'cancelled'].includes(action.status)) return res.status(422).json({ error: `Action is already "${action.status}".` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_executive_action_register').update({ status: 'completed', completed_at: now, updated_by: req.user?.userId }).eq('id', action.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: action.report_id, decisionId: action.decision_id, actionId: action.id }, 'action_completed', action.status, 'completed', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'executive_action_completed', 'practice_executive_action', action.id, {});

        return res.json({ action: updated });
    } catch (err) {
        console.error('PUT /api/practice/executive-reporting/actions/:id/complete', err);
        return res.status(500).json({ error: 'Failed to complete action.' });
    }
});

router.delete('/actions/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required to cancel an action.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const action = await _verifyAction(req.params.id, cid);
        if (!action) return res.status(404).json({ error: 'Action not found.' });
        if (action.status === 'cancelled') return res.status(422).json({ error: 'Action is already cancelled.' });

        const { data: updated, error } = await supabase.from('practice_executive_action_register').update({ status: 'cancelled', cancellation_reason: String(reason).trim(), updated_by: req.user?.userId }).eq('id', action.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { reportId: action.report_id, decisionId: action.decision_id, actionId: action.id }, 'action_cancelled', action.status, 'cancelled', req.user?.userId, String(reason).trim(), {});
        await auditFromReq(req, 'executive_action_cancelled', 'practice_executive_action', action.id, {});

        return res.json({ action: updated });
    } catch (err) {
        console.error('DELETE /api/practice/executive-reporting/actions/:id', err);
        return res.status(500).json({ error: 'Failed to cancel action.' });
    }
});

// ── Routes: Events (company-wide) ───────────────────────────────────────────────

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { report_id, event_type, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_executive_events').select('*', { count: 'exact' }).eq('company_id', cid);
        if (report_id) q = q.eq('report_id', parseInt(report_id, 10));
        if (event_type) q = q.eq('event_type', event_type);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ events: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/executive-reporting/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

// ── HTML report builder ──────────────────────────────────────────────────────────
// Simple, dependency-free server-rendered HTML — same convention as
// partner-review-packs.js (Codebox 52). No chart library, no templating engine.

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fmt(n) { return n == null ? '—' : String(n); }
function _fmtDate(d) { return d ? new Date(d).toLocaleString('en-ZA') : '—'; }

function _sectionBody(section) {
    if (!section.section_snapshot) return section.notes ? `<p>${_esc(section.notes)}</p>` : '<p><em>No content.</em></p>';
    const rows = Object.entries(section.section_snapshot).map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : _fmt(v);
        return `<tr><td>${_esc(k.replace(/_/g, ' '))}</td><td>${_esc(val)}</td></tr>`;
    }).join('');
    return `<table><tbody>${rows}</tbody></table>`;
}

function _buildHtmlReport(report, sections, decisions, actions) {
    const style = `
        body { font-family: Arial, Helvetica, sans-serif; color: #1a1a2e; margin: 0; padding: 40px; background: #fff; }
        h1 { font-size: 20px; margin-bottom: 4px; }
        h2 { font-size: 15px; margin: 28px 0 10px; border-bottom: 2px solid #667eea; padding-bottom: 4px; }
        .meta { color: #718096; font-size: 12px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 12px; word-break: break-word; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
        th { background: #f7fafc; color: #4a5568; text-transform: uppercase; font-size: 10px; }
        .disclaimer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #718096; font-style: italic; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; background: #f7fafc; }
    `;

    const sectionsHtml = sections.map(s => `<h2>${_esc(s.section_title)}</h2>${_sectionBody(s)}`).join('');

    const decisionRows = decisions.map(d => `<tr><td>${_esc(d.decision_title)}</td><td>${_esc(d.decision_category)}</td><td>${_esc(d.decision_status)}</td><td>${_fmtDate(d.due_date)}</td></tr>`).join('');
    const actionRows = actions.map(a => `<tr><td>${_esc(a.action_title)}</td><td>${_esc(a.priority)}</td><td>${_esc(a.status)}</td><td>${_fmtDate(a.due_date)}</td></tr>`).join('');

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${_esc(report.report_title)} — Executive Report</title><style>${style}</style></head><body>
<h1>${_esc(report.report_title)}</h1>
<div class="meta">Type: <span class="badge">${_esc(report.report_type)}</span> &nbsp;|&nbsp; Period: ${_esc(report.period_start)} to ${_esc(report.period_end)} &nbsp;|&nbsp; Status: ${_esc(report.report_status)} &nbsp;|&nbsp; Generated: ${_fmtDate(report.generated_at)}</div>

<h2>Executive Summary</h2>
<p>${_esc(report.executive_summary) || '<em>No executive summary provided.</em>'}</p>

<h2>Practice Health Summary</h2>
<p>${_esc(report.practice_health_summary) || '<em>No practice health summary provided.</em>'}</p>

<h2>Key Wins</h2><p>${_esc(report.key_wins) || '<em>None recorded.</em>'}</p>
<h2>Key Concerns</h2><p>${_esc(report.key_concerns) || '<em>None recorded.</em>'}</p>
<h2>Recommendations</h2><p>${_esc(report.recommendations) || '<em>None recorded.</em>'}</p>

${sectionsHtml}

<h2>Executive Decisions (${decisions.length})</h2>
<table><thead><tr><th>Decision</th><th>Category</th><th>Status</th><th>Due</th></tr></thead><tbody>${decisionRows || '<tr><td colspan="4">No decisions recorded.</td></tr>'}</tbody></table>

<h2>Action Register (${actions.length})</h2>
<table><thead><tr><th>Action</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead><tbody>${actionRows || '<tr><td colspan="4">No actions recorded.</td></tr>'}</tbody></table>

<div class="disclaimer">${_esc(DISCLAIMER)}</div>
</body></html>`;
}

// ── PDF report builder (PDFKit) ──────────────────────────────────────────────────

function _pdfHeading(doc, text) {
    doc.moveDown(0.8).fontSize(13).fillColor('#1a1a2e').font('Helvetica-Bold').text(text);
    doc.font('Helvetica').fontSize(9).fillColor('#000');
}

function _buildPdfReport(doc, report, sections, decisions, actions) {
    doc.fontSize(18).font('Helvetica-Bold').text(report.report_title);
    doc.fontSize(9).font('Helvetica').fillColor('#718096')
        .text(`Type: ${report.report_type} | Period: ${report.period_start} to ${report.period_end}`)
        .text(`Status: ${report.report_status} | Generated: ${_fmtDate(report.generated_at)}`);
    doc.fillColor('#000');

    _pdfHeading(doc, 'Executive Summary');
    doc.fontSize(9).text(report.executive_summary || 'No executive summary provided.');

    _pdfHeading(doc, 'Practice Health Summary');
    doc.fontSize(9).text(report.practice_health_summary || 'No practice health summary provided.');

    _pdfHeading(doc, 'Key Wins');
    doc.fontSize(9).text(report.key_wins || 'None recorded.');
    _pdfHeading(doc, 'Key Concerns');
    doc.fontSize(9).text(report.key_concerns || 'None recorded.');
    _pdfHeading(doc, 'Recommendations');
    doc.fontSize(9).text(report.recommendations || 'None recorded.');

    sections.forEach(s => {
        _pdfHeading(doc, s.section_title);
        if (!s.section_snapshot) { doc.fontSize(9).text(s.notes || 'No content.'); return; }
        Object.entries(s.section_snapshot).forEach(([k, v]) => {
            const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : (v == null ? '—' : String(v));
            doc.fontSize(9).text(`${k.replace(/_/g, ' ')}: ${val}`);
        });
    });

    _pdfHeading(doc, `Executive Decisions (${decisions.length})`);
    if (!decisions.length) doc.fontSize(9).text('No decisions recorded.');
    decisions.forEach(d => doc.fontSize(9).text(`[${d.decision_status}] ${d.decision_title} (${d.decision_category})${d.due_date ? ' — due ' + d.due_date : ''}`));

    _pdfHeading(doc, `Action Register (${actions.length})`);
    if (!actions.length) doc.fontSize(9).text('No actions recorded.');
    actions.forEach(a => doc.fontSize(9).text(`[${a.status}] ${a.action_title} (${a.priority})${a.due_date ? ' — due ' + a.due_date : ''}`));

    doc.moveDown(1).fontSize(8).fillColor('#718096').font('Helvetica-Oblique').text(DISCLAIMER);

    const range = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 1 };
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fontSize(7).fillColor('#9ca3af').text(
            `Executive Report #${report.id}  |  Page ${i + 1} of ${range.count}`,
            50, doc.page.height - 30, { width: doc.page.width - 100, align: 'center' }
        );
    }
}

module.exports = router;
module.exports.buildExecutiveReport = buildExecutiveReport;
