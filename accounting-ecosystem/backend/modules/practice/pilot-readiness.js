'use strict';

// Codebox 80 — Practice Pilot Launch Readiness + Navigation/UX Consolidation
// "Can we start pilot testing?" — GO / NO-GO / CONDITIONAL GO, with a
// reason. The final consolidation layer before pilot testing: reduces
// Operational Health, Automation, role-link, and known-issue signals into
// one readiness score, plus a manager-editable launch checklist and
// known-issues register.
//
// NOT a new business module. NOT a core-logic rewrite. This module reads
// Operational Health's LATEST STORED run only — it never triggers a fresh
// multi-table scan, and it never invents a health signal that doesn't exist.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const RUN_TYPES = ['internal_test', 'pilot_test', 'pre_launch', 'go_no_go', 'post_fix_review'];
const READINESS_STATUSES = ['not_ready', 'needs_attention', 'pilot_ready', 'launch_ready', 'blocked'];
const DECISIONS = ['no_decision', 'go', 'no_go', 'conditional_go'];

const CHECK_CATEGORIES = [
    'navigation', 'access_control', 'core_operations', 'clients', 'planning', 'secretarial', 'tax',
    'engagement', 'reporting', 'automation', 'health', 'data', 'security', 'documentation', 'pilot_admin', 'custom',
];
const CHECK_STATUSES = ['not_started', 'passed', 'failed', 'warning', 'not_applicable', 'deferred'];
const CHECK_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const ISSUE_CATEGORIES = ['bug', 'ux', 'performance', 'data', 'security', 'access', 'navigation', 'integration', 'documentation', 'other'];
const ISSUE_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'accepted_risk', 'deferred', 'cancelled'];
const OPEN_ISSUE_STATUSES = ['open', 'in_progress'];
// A critical issue in one of these categories blocks pilot launch outright,
// regardless of overall score — per spec's scoring rule verbatim.
const BLOCKING_ISSUE_CATEGORIES = ['security', 'access'];

// This codebox ships the grouped navigation in the same commit as this
// engine — so from this point forward navigation is always consolidated.
// Not a runtime probe (navigation structure is code, not queryable data);
// see migration 137's header for why this is honest, not invented.
const NAVIGATION_CONSOLIDATED = true;
const NAVIGATION_GROUPS = [
    'Dashboard', 'Operations', 'Clients', 'Secretarial & Governance', 'People & Practice',
    'Compliance & Tax', 'Quality & Risk', 'Strategy & Executive',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can manage pilot readiness.');
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}
function _daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

async function _verifyRun(id, cid) {
    const { data } = await supabase.from('practice_pilot_readiness_runs').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _verifyChecklistItem(id, cid) {
    const { data } = await supabase.from('practice_pilot_checklist_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _verifyIssue(id, cid) {
    const { data } = await supabase.from('practice_pilot_known_issues').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, { runId, checklistItemId, issueId }, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_pilot_events').insert({
        company_id: cid, readiness_run_id: runId || null, checklist_item_id: checklistItemId || null, known_issue_id: issueId || null,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: userId || null, notes: notes || null, metadata: meta || {},
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// READINESS ENGINE — computePilotReadiness()
// Never invents health data — reads Operational Health's LATEST STORED run,
// never a fresh multi-table scan.
// ═══════════════════════════════════════════════════════════════════════════

async function computePilotReadiness(cid) {
    const warnings = [];
    const blockers = [];

    // 1. Latest Operational Health run — stored only, per spec verbatim.
    const { data: latestHealthRun } = await supabase.from('practice_health_check_runs')
        .select('id, overall_score, overall_status, category_results, findings, completed_at')
        .eq('company_id', cid).eq('run_status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle();

    let operationalHealthCriticalCount = 0;
    if (!latestHealthRun) {
        warnings.push({ code: 'OPERATIONAL_HEALTH_NOT_RUN', message: 'Operational Health has never been run for this company. Run it before assessing pilot readiness.' });
    } else {
        operationalHealthCriticalCount = (latestHealthRun.findings || []).filter(f => f.severity === 'critical').length;
        if (operationalHealthCriticalCount > 0) blockers.push({ code: 'OPERATIONAL_HEALTH_CRITICAL', message: `Operational Health has ${operationalHealthCriticalCount} critical finding(s).` });
    }

    // 2. Automation — direct count query, same pattern management-dashboard.js
    // and operational-health.js already use. Never re-derives automation.js's
    // own run-status logic.
    const { data: failedAutomationRuns } = await supabase.from('practice_automation_runs')
        .select('id').eq('company_id', cid).eq('run_status', 'failed').eq('dry_run', false).gte('created_at', _daysAgo(30));
    const failedAutomationCount = (failedAutomationRuns || []).length;
    if (failedAutomationCount > 0) warnings.push({ code: 'AUTOMATION_RECENT_FAILURES', message: `${failedAutomationCount} automation run(s) failed in the last 30 days.` });

    // 3. Role-link health — read from the stored Operational Health run's own
    // category_results.role_links (Codebox 79 already computed this exact
    // signal); never re-derived here.
    const roleLinks = latestHealthRun ? (latestHealthRun.category_results || {}).role_links : null;
    if (roleLinks && (roleLinks.needs_review > 0 || roleLinks.orphaned > 0)) {
        warnings.push({ code: 'ROLE_LINKS_NEED_REVIEW', message: `${roleLinks.needs_review || 0} team member(s) need role-link review, ${roleLinks.orphaned || 0} orphaned.` });
    }

    // 4. Known issues — open/in-progress only count toward score/blockers.
    const { data: issueRows } = await supabase.from('practice_pilot_known_issues').select('*').eq('company_id', cid).in('issue_status', OPEN_ISSUE_STATUSES);
    const issues = issueRows || [];
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;
    const highIssues = issues.filter(i => i.severity === 'high').length;
    const mediumIssues = issues.filter(i => i.severity === 'medium').length;
    const lowIssues = issues.filter(i => i.severity === 'low').length;

    const hasBlockingSecurityAccessIssue = issues.some(i => i.severity === 'critical' && BLOCKING_ISSUE_CATEGORIES.includes(i.issue_category));
    if (hasBlockingSecurityAccessIssue) blockers.push({ code: 'CRITICAL_SECURITY_ACCESS_ISSUE', message: 'An unresolved critical security/access issue exists — pilot launch is blocked until resolved or accepted as risk.' });

    // 5. Checklist items.
    const { data: checklistRows } = await supabase.from('practice_pilot_checklist_items').select('*').eq('company_id', cid);
    const checklist = checklistRows || [];
    const failedCriticalChecklist = checklist.filter(c => c.severity === 'critical' && c.check_status === 'failed').length;
    const failedHighChecklist = checklist.filter(c => c.severity === 'high' && c.check_status === 'failed').length;
    if (failedCriticalChecklist > 0) blockers.push({ code: 'CRITICAL_CHECKLIST_FAILED', message: `${failedCriticalChecklist} critical checklist item(s) failed.` });

    // ── Scoring — deterministic, per spec's exact formula ──────────────────
    let score = 100;
    score -= criticalIssues * 20;
    score -= highIssues * 10;
    score -= mediumIssues * 4;
    score -= lowIssues * 1;
    score -= failedCriticalChecklist * 15;
    score -= failedHighChecklist * 8;
    if (operationalHealthCriticalCount > 0) score -= 20;
    if (!NAVIGATION_CONSOLIDATED) score -= 10;
    score = Math.max(0, Math.round(score * 100) / 100);

    const criticalBlockersCount = criticalIssues + failedCriticalChecklist + (operationalHealthCriticalCount > 0 ? 1 : 0);

    let readinessStatus;
    if (hasBlockingSecurityAccessIssue) readinessStatus = 'blocked';
    else if (score >= 95 && criticalBlockersCount === 0) readinessStatus = 'launch_ready';
    else if (score >= 85 && criticalBlockersCount === 0) readinessStatus = 'pilot_ready';
    else if (score >= 70) readinessStatus = 'needs_attention';
    else readinessStatus = 'not_ready';

    // Per spec verbatim: if Operational Health has never run, status can
    // never read as ready — even if every other signal happens to score high.
    if (!latestHealthRun && ['launch_ready', 'pilot_ready'].includes(readinessStatus)) readinessStatus = 'needs_attention';

    // ── Module matrix — the 7 Operational Health categories (never
    // re-derived, just relabeled for a partner-facing view) plus 3
    // pilot-specific rows this codebox owns.
    const categoryResults = latestHealthRun ? latestHealthRun.category_results || {} : {};
    const CATEGORY_LABELS = { modules: 'Core Modules', configuration: 'Configuration', migrations: 'Migrations', automation: 'Automation', role_links: 'Role Links', stale_data: 'Data Freshness', integrations: 'Integrations' };
    const moduleMatrix = Object.keys(CATEGORY_LABELS).map(key => ({
        area: CATEGORY_LABELS[key],
        score: categoryResults[key] ? categoryResults[key].score : null,
        source: 'operational_health',
    }));
    moduleMatrix.push({ area: 'Navigation', score: NAVIGATION_CONSOLIDATED ? 100 : 0, source: 'pilot_readiness' });
    const checklistTotal = checklist.length;
    const checklistPassed = checklist.filter(c => c.check_status === 'passed').length;
    moduleMatrix.push({ area: 'Smoke Tests', score: checklistTotal ? Math.round((checklistPassed / checklistTotal) * 10000) / 100 : null, source: 'pilot_readiness' });
    moduleMatrix.push({ area: 'Known Issues', score: issues.length === 0 ? 100 : Math.max(0, 100 - issues.length * 10), source: 'pilot_readiness' });

    const smokeTestSummary = { total: checklistTotal, passed: checklistPassed, failed: checklist.filter(c => c.check_status === 'failed').length, not_started: checklist.filter(c => c.check_status === 'not_started').length };
    const navigationSummary = { consolidated: NAVIGATION_CONSOLIDATED, groups: NAVIGATION_GROUPS, group_count: NAVIGATION_GROUPS.length };
    const knownIssueSummary = { open_total: issues.length, critical: criticalIssues, high: highIssues, medium: mediumIssues, low: lowIssues };

    const recommendedNextActions = [];
    if (!latestHealthRun) recommendedNextActions.push('Run Operational Health at least once before assessing pilot readiness.');
    if (criticalIssues > 0) recommendedNextActions.push(`Resolve or accept risk on ${criticalIssues} critical known issue(s).`);
    if (failedCriticalChecklist > 0) recommendedNextActions.push(`Fix ${failedCriticalChecklist} failed critical checklist item(s).`);
    if (roleLinks && roleLinks.needs_review > 0) recommendedNextActions.push('Review unlinked team members on the Team page.');
    if (!recommendedNextActions.length && readinessStatus !== 'launch_ready') recommendedNextActions.push('Review remaining warnings and checklist items before deciding Go/No-Go.');

    return {
        overallScore: score, readinessStatus,
        criticalBlockers: criticalBlockersCount, highIssues, mediumIssues, lowIssues,
        operationalHealthRunId: latestHealthRun ? latestHealthRun.id : null,
        moduleMatrix, smokeTestSummary, navigationSummary, knownIssueSummary,
        blockers, warnings, recommendedNextActions,
        readinessSnapshot: { operational_health: latestHealthRun ? { id: latestHealthRun.id, score: latestHealthRun.overall_score, status: latestHealthRun.overall_status } : null, automation_failed_runs_30d: failedAutomationCount, role_links: roleLinks },
    };
}

// ── Seed default checklist (15 smoke-test items) ──────────────────────────────

const DEFAULT_CHECKLIST = [
    { check_category: 'access_control', check_title: 'Login works', severity: 'critical', sort_order: 1 },
    { check_category: 'access_control', check_title: 'Role access works', severity: 'critical', sort_order: 2 },
    { check_category: 'access_control', check_title: 'Team user links valid', severity: 'high', sort_order: 3, linked_url: '/practice/team.html' },
    { check_category: 'clients', check_title: 'Client create/view works', severity: 'high', sort_order: 4, linked_url: '/practice/clients.html' },
    { check_category: 'planning', check_title: 'Planning Board loads', severity: 'medium', sort_order: 5, linked_url: '/practice/planning-board.html' },
    { check_category: 'core_operations', check_title: 'My Work loads', severity: 'medium', sort_order: 6, linked_url: '/practice/work-queue.html' },
    { check_category: 'core_operations', check_title: 'Notifications load', severity: 'medium', sort_order: 7, linked_url: '/practice/notifications.html' },
    { check_category: 'secretarial', check_title: 'Secretarial profile loads', severity: 'medium', sort_order: 8, linked_url: '/practice/secretarial.html' },
    { check_category: 'engagement', check_title: 'Engagement management loads', severity: 'medium', sort_order: 9, linked_url: '/practice/engagement-management.html' },
    { check_category: 'reporting', check_title: 'Executive Reporting generate works', severity: 'high', sort_order: 10, linked_url: '/practice/executive-reporting.html' },
    { check_category: 'automation', check_title: 'Automation dry-run works', severity: 'medium', sort_order: 11, linked_url: '/practice/automation.html' },
    { check_category: 'health', check_title: 'Operational Health run works', severity: 'high', sort_order: 12, linked_url: '/practice/operational-health.html' },
    { check_category: 'security', check_title: 'No localStorage violations in new files', severity: 'critical', sort_order: 13 },
    { check_category: 'core_operations', check_title: 'Management Dashboard loads', severity: 'high', sort_order: 14, linked_url: '/practice/management-dashboard.html' },
    { check_category: 'navigation', check_title: 'Navigation renders without horizontal overflow', severity: 'high', sort_order: 15 },
];

async function _seedDefaults(cid, userId) {
    const { data: existing } = await supabase.from('practice_pilot_checklist_items').select('check_title').eq('company_id', cid).eq('is_default', true);
    const existingTitles = new Set((existing || []).map(c => c.check_title));
    const toInsert = DEFAULT_CHECKLIST.filter(c => !existingTitles.has(c.check_title)).map(c => Object.assign({
        company_id: cid, check_status: 'not_started', is_default: true, created_by: userId || null, updated_by: userId || null,
    }, c));
    if (!toInsert.length) return { inserted: 0 };
    const { data: inserted, error } = await supabase.from('practice_pilot_checklist_items').insert(toInsert).select('id, check_title');
    if (error) throw error;
    await _writeEvent(cid, {}, 'checklist_seeded', null, null, userId, null, { inserted_count: (inserted || []).length });
    return { inserted: (inserted || []).length, items: inserted || [] };
}

// ── Routes: Summary (dashboard integration) ────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [{ data: latestRun }, { count: openCriticalIssues }] = await Promise.all([
            supabase.from('practice_pilot_readiness_runs').select('id, overall_score, readiness_status, decision, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('practice_pilot_known_issues').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('severity', 'critical').in('issue_status', OPEN_ISSUE_STATUSES),
        ]);
        return res.json({ latest_run: latestRun || null, open_critical_issues: openCriticalIssues || 0 });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/summary', err);
        return res.status(500).json({ error: 'Failed to load pilot readiness summary.' });
    }
});

// ── Routes: Readiness runs ────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
    const cid = req.companyId;
    const { run_name, run_type } = req.body || {};
    if (!run_name || !String(run_name).trim()) return res.status(400).json({ error: 'run_name is required.' });
    if (!RUN_TYPES.includes(run_type)) return res.status(400).json({ error: `run_type must be one of: ${RUN_TYPES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const result = await computePilotReadiness(cid);
        const { data: run, error } = await supabase.from('practice_pilot_readiness_runs').insert({
            company_id: cid, run_name: String(run_name).trim(), run_type,
            readiness_status: result.readinessStatus, overall_score: result.overallScore,
            critical_blockers: result.criticalBlockers, high_issues: result.highIssues, medium_issues: result.mediumIssues, low_issues: result.lowIssues,
            operational_health_run_id: result.operationalHealthRunId,
            module_matrix: result.moduleMatrix, smoke_test_summary: result.smokeTestSummary,
            navigation_summary: result.navigationSummary, known_issue_summary: result.knownIssueSummary,
            readiness_snapshot: { blockers: result.blockers, warnings: result.warnings, recommended_next_actions: result.recommendedNextActions, readiness_snapshot: result.readinessSnapshot },
            created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, { runId: run.id }, 'readiness_run_created', null, run.readiness_status, req.user?.userId, null, {});
        await _writeEvent(cid, { runId: run.id }, 'readiness_run_completed', null, run.readiness_status, req.user?.userId, null, { overall_score: result.overallScore });
        await auditFromReq(req, 'pilot_readiness_run', 'practice_pilot_readiness_run', run.id, { readiness_status: result.readinessStatus });

        return res.status(201).json({ run, blockers: result.blockers, warnings: result.warnings, recommended_next_actions: result.recommendedNextActions });
    } catch (err) {
        console.error('POST /api/practice/pilot-readiness/run', err);
        return res.status(500).json({ error: 'Failed to run pilot readiness check.' });
    }
});

router.get('/runs', async (req, res) => {
    const cid = req.companyId;
    const { page = 1, limit = 20 } = req.query;
    try {
        const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const { data, count, error } = await supabase.from('practice_pilot_readiness_runs')
            .select('id, run_name, run_type, readiness_status, overall_score, decision, created_at', { count: 'exact' })
            .eq('company_id', cid).order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);
        if (error) throw error;
        return res.json({ runs: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/runs', err);
        return res.status(500).json({ error: 'Failed to load readiness runs.' });
    }
});

router.get('/runs/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const run = await _verifyRun(req.params.id, cid);
        if (!run) return res.status(404).json({ error: 'Readiness run not found.' });
        return res.json({ run });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/runs/:id', err);
        return res.status(500).json({ error: 'Failed to load readiness run.' });
    }
});

router.put('/runs/:id/decision', async (req, res) => {
    const cid = req.companyId;
    const { decision, decision_notes } = req.body || {};
    if (!DECISIONS.includes(decision) || decision === 'no_decision') return res.status(400).json({ error: `decision must be one of: go, no_go, conditional_go` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const run = await _verifyRun(req.params.id, cid);
        if (!run) return res.status(404).json({ error: 'Readiness run not found.' });
        if (run.readiness_status === 'blocked' && decision === 'go') {
            return res.status(422).json({ error: 'Cannot record a "go" decision on a blocked readiness run — resolve the blocking issue first.' });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_pilot_readiness_runs').update({
            decision, decision_notes: decision_notes || null, decided_by: req.user?.userId || null, decided_at: now,
        }).eq('id', run.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { runId: run.id }, 'go_decision_recorded', run.decision, decision, req.user?.userId, decision_notes || null, {});
        await auditFromReq(req, 'pilot_readiness_decision_recorded', 'practice_pilot_readiness_run', run.id, { decision });

        return res.json({ run: updated });
    } catch (err) {
        console.error('PUT /api/practice/pilot-readiness/runs/:id/decision', err);
        return res.status(500).json({ error: 'Failed to record decision.' });
    }
});

// ── Routes: Checklist ──────────────────────────────────────────────────────────

router.get('/checklist', async (req, res) => {
    const cid = req.companyId;
    const { check_status, check_category } = req.query;
    try {
        if (check_status && !CHECK_STATUSES.includes(check_status)) return res.status(400).json({ error: `Invalid check_status. Allowed: ${CHECK_STATUSES.join(', ')}` });
        if (check_category && !CHECK_CATEGORIES.includes(check_category)) return res.status(400).json({ error: `Invalid check_category. Allowed: ${CHECK_CATEGORIES.join(', ')}` });

        let q = supabase.from('practice_pilot_checklist_items').select('*').eq('company_id', cid);
        if (check_status) q = q.eq('check_status', check_status);
        if (check_category) q = q.eq('check_category', check_category);
        q = q.order('sort_order');

        const { data, error } = await q;
        if (error) throw error;
        return res.json({ checklist: data || [] });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/checklist', err);
        return res.status(500).json({ error: 'Failed to load checklist.' });
    }
});

router.post('/checklist/seed-defaults', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const result = await _seedDefaults(cid, req.user?.userId);
        await auditFromReq(req, 'pilot_checklist_seeded', 'practice_pilot_checklist_item', null, { inserted_count: result.inserted });
        return res.status(201).json(result);
    } catch (err) {
        console.error('POST /api/practice/pilot-readiness/checklist/seed-defaults', err);
        return res.status(500).json({ error: 'Failed to seed default checklist.' });
    }
});

router.put('/checklist/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['check_title', 'check_description', 'check_status', 'severity', 'linked_module', 'linked_url', 'owner_team_member_id', 'due_date', 'evidence_notes', 'resolution_notes', 'sort_order'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (patch.check_status && !CHECK_STATUSES.includes(patch.check_status)) return res.status(400).json({ error: `Invalid check_status. Allowed: ${CHECK_STATUSES.join(', ')}` });
    if (patch.severity && !CHECK_SEVERITIES.includes(patch.severity)) return res.status(400).json({ error: `Invalid severity. Allowed: ${CHECK_SEVERITIES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const item = await _verifyChecklistItem(req.params.id, cid);
        if (!item) return res.status(404).json({ error: 'Checklist item not found.' });

        const { data: updated, error } = await supabase.from('practice_pilot_checklist_items').update({ ...patch, updated_by: req.user?.userId }).eq('id', item.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { checklistItemId: item.id }, 'checklist_item_updated', item.check_status, updated.check_status, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'pilot_checklist_item_updated', 'practice_pilot_checklist_item', item.id, { fields: Object.keys(patch) });

        return res.json({ item: updated });
    } catch (err) {
        console.error('PUT /api/practice/pilot-readiness/checklist/:id', err);
        return res.status(500).json({ error: 'Failed to update checklist item.' });
    }
});

// ── Routes: Known Issues ────────────────────────────────────────────────────────

router.get('/issues', async (req, res) => {
    const cid = req.companyId;
    const { issue_status, severity, issue_category, page = 1, limit = 50 } = req.query;
    try {
        if (issue_status && !ISSUE_STATUSES.includes(issue_status)) return res.status(400).json({ error: `Invalid issue_status. Allowed: ${ISSUE_STATUSES.join(', ')}` });
        if (severity && !ISSUE_SEVERITIES.includes(severity)) return res.status(400).json({ error: `Invalid severity. Allowed: ${ISSUE_SEVERITIES.join(', ')}` });
        if (issue_category && !ISSUE_CATEGORIES.includes(issue_category)) return res.status(400).json({ error: `Invalid issue_category. Allowed: ${ISSUE_CATEGORIES.join(', ')}` });

        let q = supabase.from('practice_pilot_known_issues').select('*', { count: 'exact' }).eq('company_id', cid);
        if (issue_status) q = q.eq('issue_status', issue_status);
        if (severity) q = q.eq('severity', severity);
        if (issue_category) q = q.eq('issue_category', issue_category);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ issues: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/issues', err);
        return res.status(500).json({ error: 'Failed to load known issues.' });
    }
});

router.post('/issues', async (req, res) => {
    const cid = req.companyId;
    const { issue_title, issue_description, issue_category, severity, affected_module, affected_url, reproduction_steps, expected_result, actual_result, workaround, assigned_team_member_id } = req.body || {};
    if (!issue_title || !String(issue_title).trim()) return res.status(400).json({ error: 'issue_title is required.' });
    if (!ISSUE_CATEGORIES.includes(issue_category)) return res.status(400).json({ error: `issue_category must be one of: ${ISSUE_CATEGORIES.join(', ')}` });
    if (!ISSUE_SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${ISSUE_SEVERITIES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data, error } = await supabase.from('practice_pilot_known_issues').insert({
            company_id: cid, issue_title: String(issue_title).trim(), issue_description: issue_description || null,
            issue_category, severity, affected_module: affected_module || null, affected_url: affected_url || null,
            reproduction_steps: reproduction_steps || null, expected_result: expected_result || null, actual_result: actual_result || null,
            workaround: workaround || null, assigned_team_member_id: assigned_team_member_id || null,
            reported_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, { issueId: data.id }, 'known_issue_created', null, data.issue_status, req.user?.userId, null, {});
        await auditFromReq(req, 'pilot_known_issue_created', 'practice_pilot_known_issue', data.id, {});

        return res.status(201).json({ issue: data });
    } catch (err) {
        console.error('POST /api/practice/pilot-readiness/issues', err);
        return res.status(500).json({ error: 'Failed to create known issue.' });
    }
});

router.get('/issues/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const issue = await _verifyIssue(req.params.id, cid);
        if (!issue) return res.status(404).json({ error: 'Known issue not found.' });
        return res.json({ issue });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/issues/:id', err);
        return res.status(500).json({ error: 'Failed to load known issue.' });
    }
});

router.put('/issues/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['issue_title', 'issue_description', 'issue_category', 'severity', 'issue_status', 'affected_module', 'affected_url', 'reproduction_steps', 'expected_result', 'actual_result', 'workaround', 'resolution_notes', 'assigned_team_member_id'];
    const patch = _pick(req.body || {}, EDITABLE);
    if (patch.issue_category && !ISSUE_CATEGORIES.includes(patch.issue_category)) return res.status(400).json({ error: `Invalid issue_category. Allowed: ${ISSUE_CATEGORIES.join(', ')}` });
    if (patch.severity && !ISSUE_SEVERITIES.includes(patch.severity)) return res.status(400).json({ error: `Invalid severity. Allowed: ${ISSUE_SEVERITIES.join(', ')}` });
    if (patch.issue_status && !ISSUE_STATUSES.includes(patch.issue_status)) return res.status(400).json({ error: `Invalid issue_status. Allowed: ${ISSUE_STATUSES.join(', ')}` });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const issue = await _verifyIssue(req.params.id, cid);
        if (!issue) return res.status(404).json({ error: 'Known issue not found.' });

        const { data: updated, error } = await supabase.from('practice_pilot_known_issues').update(patch).eq('id', issue.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { issueId: issue.id }, 'known_issue_updated', issue.issue_status, updated.issue_status, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'pilot_known_issue_updated', 'practice_pilot_known_issue', issue.id, { fields: Object.keys(patch) });

        return res.json({ issue: updated });
    } catch (err) {
        console.error('PUT /api/practice/pilot-readiness/issues/:id', err);
        return res.status(500).json({ error: 'Failed to update known issue.' });
    }
});

router.put('/issues/:id/resolve', async (req, res) => {
    const cid = req.companyId;
    const { resolution_notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const issue = await _verifyIssue(req.params.id, cid);
        if (!issue) return res.status(404).json({ error: 'Known issue not found.' });
        if (['resolved', 'cancelled'].includes(issue.issue_status)) return res.status(422).json({ error: `Issue is already "${issue.issue_status}".` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_pilot_known_issues').update({
            issue_status: 'resolved', resolution_notes: resolution_notes || null, resolved_by: req.user?.userId || null, resolved_at: now,
        }).eq('id', issue.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { issueId: issue.id }, 'known_issue_resolved', issue.issue_status, 'resolved', req.user?.userId, resolution_notes || null, {});
        await auditFromReq(req, 'pilot_known_issue_resolved', 'practice_pilot_known_issue', issue.id, {});

        return res.json({ issue: updated });
    } catch (err) {
        console.error('PUT /api/practice/pilot-readiness/issues/:id/resolve', err);
        return res.status(500).json({ error: 'Failed to resolve known issue.' });
    }
});

router.put('/issues/:id/accept-risk', async (req, res) => {
    const cid = req.companyId;
    const { resolution_notes } = req.body || {};
    if (!resolution_notes || !String(resolution_notes).trim()) return res.status(400).json({ error: 'resolution_notes is required to accept risk on a known issue.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const issue = await _verifyIssue(req.params.id, cid);
        if (!issue) return res.status(404).json({ error: 'Known issue not found.' });
        if (['resolved', 'cancelled'].includes(issue.issue_status)) return res.status(422).json({ error: `Issue is already "${issue.issue_status}".` });

        const { data: updated, error } = await supabase.from('practice_pilot_known_issues').update({
            issue_status: 'accepted_risk', resolution_notes: String(resolution_notes).trim(),
        }).eq('id', issue.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, { issueId: issue.id }, 'known_issue_updated', issue.issue_status, 'accepted_risk', req.user?.userId, String(resolution_notes).trim(), { accepted_risk: true });
        await auditFromReq(req, 'pilot_known_issue_risk_accepted', 'practice_pilot_known_issue', issue.id, {});

        return res.json({ issue: updated });
    } catch (err) {
        console.error('PUT /api/practice/pilot-readiness/issues/:id/accept-risk', err);
        return res.status(500).json({ error: 'Failed to accept risk on known issue.' });
    }
});

// ── Routes: Events ────────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { readiness_run_id, event_type, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_pilot_events').select('*', { count: 'exact' }).eq('company_id', cid);
        if (readiness_run_id) q = q.eq('readiness_run_id', parseInt(readiness_run_id, 10));
        if (event_type) q = q.eq('event_type', event_type);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ events: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/pilot-readiness/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;
module.exports.computePilotReadiness = computePilotReadiness;
