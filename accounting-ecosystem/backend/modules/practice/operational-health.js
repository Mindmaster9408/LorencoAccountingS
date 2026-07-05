'use strict';

// Codebox 79 — Practice Operational Health Centre + System Readiness Monitor
// "Is the platform ready?" A read-only monitor over every other Practice
// module — module health, configuration validity, migration readiness,
// automation health, role-link integrity, stale data, and broken
// cross-module references — reduced to a deterministic production-
// readiness score and a fixed pilot-readiness checklist.
//
// NOT AI. NOT a new business module. NOT cron — every check runs only when
// a manager explicitly requests it (POST /run). This module never writes to
// any table outside its own two (practice_health_check_runs/_events) — it
// reads everything else, never mutates it.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const { getRules } = require('./alert-rules');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['modules', 'configuration', 'migrations', 'automation', 'role_links', 'stale_data', 'integrations'];

// Sums to 1.00. role_links and modules are weighted highest — a broken
// table or an unlinked login account blocks real work; stale data and
// automation warnings are important but rarely block launch on their own.
// Documented Architect Freedom (spec asks for "production readiness
// scoring" without dictating a formula) — same convention as
// partner-scorecards.js's WEIGHTS constant.
const CATEGORY_WEIGHTS = {
    modules: 0.20, configuration: 0.10, migrations: 0.15, automation: 0.10,
    role_links: 0.20, stale_data: 0.10, integrations: 0.15,
};

const STATUS_THRESHOLDS = { healthy: 90, warning: 70 }; // < warning threshold = critical

function _statusFromScore(score) {
    if (score >= STATUS_THRESHOLDS.healthy) return 'healthy';
    if (score >= STATUS_THRESHOLDS.warning) return 'warning';
    return 'critical';
}

// One representative table per major functional area — not exhaustive, but
// spans every codebox era (foundation through Codebox 78) so a genuinely
// broken/missing table anywhere in the stack surfaces here.
const ANCHOR_TABLES = [
    { table: 'practice_team_members', label: 'Team' },
    { table: 'practice_clients', label: 'Clients' },
    { table: 'practice_tasks', label: 'Tasks' },
    { table: 'practice_notifications', label: 'Notifications' },
    { table: 'practice_reminders', label: 'Reminders' },
    { table: 'practice_risks', label: 'Risk Register' },
    { table: 'practice_quality_reviews', label: 'QMS' },
    { table: 'practice_client_success', label: 'Client Success' },
    { table: 'practice_secretarial_profiles', label: 'Secretarial' },
    { table: 'practice_onboarding_profiles', label: 'Client Onboarding' },
    { table: 'practice_client_engagements', label: 'Engagements' },
    { table: 'practice_profitability_snapshots', label: 'Profitability' },
    { table: 'practice_pricing_reviews', label: 'Pricing Reviews' },
    { table: 'practice_partner_scorecards', label: 'Partner Scorecards' },
    { table: 'practice_strategic_plans', label: 'Strategic Planning' },
    { table: 'practice_executive_reports', label: 'Executive Reporting' },
    { table: 'practice_automation_rules', label: 'Automation' },
];

// Newest representative table per migration era — confirms migrations
// actually landed in the live database. A live table-existence probe
// (never a filesystem/migration-file count) — see migration 136's header
// for why: this app's migrations are split across two directories with
// independently-numbered, overlapping filenames.
const MIGRATION_PROBES = [
    { table: 'practice_team_members', migration: '~055 (foundation)' },
    { table: 'practice_kpi_snapshots', migration: '110ish (KPI History, Codebox 51)' },
    { table: 'practice_partner_scorecards', migration: '132 (Codebox 75)' },
    { table: 'practice_strategic_plans', migration: '133 (Codebox 76)' },
    { table: 'practice_executive_reports', migration: '134 (Codebox 77)' },
    { table: 'practice_automation_rules', migration: '135 (Codebox 78)' },
    { table: 'practice_health_check_runs', migration: '136 (this codebox)' },
];

// Soft-reference integrity targets: [sourceTable, sourceColumn, humanLabel].
// Every one is a plain-integer "no FK" reference per this codebase's own
// convention (Codebox 41) — meaning nothing at the DB level stops it from
// going stale; this is the first place that is actually checked.
const INTEGRATION_LINKS = [
    { table: 'practice_notifications', column: 'assigned_team_member_id', label: 'Notifications → Team Member' },
    { table: 'practice_reminders', column: 'assigned_team_member_id', label: 'Reminders → Team Member' },
    { table: 'practice_executive_action_register', column: 'owner_team_member_id', label: 'Executive Actions → Team Member' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can run a health check.');
}

function _finding(category, severity, code, message, detail) {
    return { category, severity, code, message, detail: detail || null };
}

function _daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

// ── Category: Modules ─────────────────────────────────────────────────────────

async function _checkModules(cid) {
    const findings = [];
    let brokenCount = 0;

    for (const anchor of ANCHOR_TABLES) {
        const { error } = await supabase.from(anchor.table).select('id', { count: 'exact', head: true }).eq('company_id', cid).limit(1);
        if (error) {
            brokenCount++;
            findings.push(_finding('modules', 'critical', 'module_table_unreachable', `${anchor.label} module table (${anchor.table}) is unreachable.`, error.message));
        }
    }

    const score = Math.max(0, 100 - (brokenCount / ANCHOR_TABLES.length) * 100);
    return { score: Math.round(score * 100) / 100, findings, checked: ANCHOR_TABLES.length, broken: brokenCount };
}

// ── Category: Configuration ────────────────────────────────────────────────────

async function _checkConfiguration(cid) {
    const findings = [];
    let passed = 0;
    const total = 3;

    try {
        await getRules(cid, ['risk_high_min', 'risk_critical_min']);
        passed++;
    } catch (e) {
        findings.push(_finding('configuration', 'high', 'alert_rules_unresolvable', 'Central alert-rules configuration (Codebox 53) failed to resolve.', e.message));
    }

    const { data: profileRows } = await supabase.from('practice_profiles').select('id').eq('company_id', cid).limit(1);
    if (profileRows && profileRows.length) passed++;
    else findings.push(_finding('configuration', 'medium', 'practice_profile_missing', 'No practice_profiles row exists for this company yet.', null));

    const { count: ownerCount } = await supabase.from('practice_team_members').select('id', { count: 'exact', head: true })
        .eq('company_id', cid).eq('is_active', true).in('role', ['owner', 'partner']);
    if (ownerCount > 0) passed++;
    else findings.push(_finding('configuration', 'critical', 'no_owner_partner', 'No active owner/partner team member exists — no one can currently manage this practice.', null));

    const score = Math.round((passed / total) * 10000) / 100;
    return { score, findings, passed, total };
}

// ── Category: Migrations ──────────────────────────────────────────────────────

async function _checkMigrations(cid) {
    const findings = [];
    let missing = 0;

    for (const probe of MIGRATION_PROBES) {
        const { error } = await supabase.from(probe.table).select('id', { count: 'exact', head: true }).limit(1);
        if (error) {
            missing++;
            findings.push(_finding('migrations', 'critical', 'migration_table_missing', `Table "${probe.table}" (migration ${probe.migration}) is missing or unreachable.`, error.message));
        }
    }

    const score = Math.max(0, 100 - (missing / MIGRATION_PROBES.length) * 100);
    return { score: Math.round(score * 100) / 100, findings, checked: MIGRATION_PROBES.length, missing };
}

// ── Category: Automation ──────────────────────────────────────────────────────
// Same count-only direct-query pattern management-dashboard.js already uses
// for its own automation KPI block — never re-derives automation.js's
// scoring/idempotency logic.

async function _checkAutomation(cid) {
    const findings = [];

    const [{ count: activeRules }, { data: failedRuns }, { data: warningRuns }, { count: awaitingApproval }] = await Promise.all([
        supabase.from('practice_automation_rules').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('rule_status', 'active'),
        supabase.from('practice_automation_runs').select('id').eq('company_id', cid).eq('run_status', 'failed').eq('dry_run', false).gte('created_at', _daysAgo(30)),
        supabase.from('practice_automation_runs').select('id').eq('company_id', cid).eq('run_status', 'completed_with_warnings').gte('created_at', _daysAgo(30)),
        supabase.from('practice_automation_rules').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('requires_approval', true).is('approved_at', null).not('rule_status', 'in', '("archived","cancelled")'),
    ]);

    const failedCount = (failedRuns || []).length;
    const warningCount = (warningRuns || []).length;

    if (failedCount > 0) findings.push(_finding('automation', 'high', 'automation_runs_failed', `${failedCount} automation run(s) failed in the last 30 days.`, null));
    if (warningCount > 0) findings.push(_finding('automation', 'low', 'automation_runs_warned', `${warningCount} automation run(s) completed with warnings in the last 30 days.`, null));
    if (awaitingApproval > 0) findings.push(_finding('automation', 'info', 'automation_rules_awaiting_approval', `${awaitingApproval} automation rule(s) are awaiting approval.`, null));

    let score = 100;
    score -= Math.min(60, failedCount * 15);
    score -= Math.min(20, warningCount * 5);
    score = Math.max(0, score);

    return { score: Math.round(score * 100) / 100, findings, active_rules: activeRules || 0, failed_runs: failedCount, runs_with_warnings: warningCount, awaiting_approval: awaitingApproval || 0 };
}

// ── Category: Role-Link Integrity ─────────────────────────────────────────────
// Directly formalizes the 2026-07-05 root-cause fix (lib/team-access.js) as
// a permanent, visible check. READ-ONLY — mirrors getMyTeamMember()'s email
// self-heal matching logic to REPORT candidates; never calls .update().

async function _checkRoleLinks(cid) {
    const findings = [];

    const { data: unlinked } = await supabase.from('practice_team_members')
        .select('id, display_name, email').eq('company_id', cid).eq('is_active', true).is('user_id', null);

    let autoHealable = 0, needsReview = 0;
    if (unlinked && unlinked.length) {
        // Fetched once and reused for every unlinked member — not re-queried
        // per member.
        const { data: accessRows } = await supabase.from('user_company_access')
            .select('users:user_id(id, email)').eq('company_id', cid).eq('is_active', true);
        const activeEmails = (accessRows || []).map(r => r.users).filter(u => u && u.email);

        for (const member of unlinked) {
            if (!member.email) { needsReview++; continue; }
            const matches = activeEmails.filter(u => u.email.toLowerCase() === member.email.toLowerCase());
            if (matches.length === 1) autoHealable++;
            else needsReview++;
        }
    }

    if (autoHealable > 0) findings.push(_finding('role_links', 'medium', 'role_links_auto_healable', `${autoHealable} team member(s) have no login link but will self-heal automatically the next time they log in (single clean email match).`, null));
    if (needsReview > 0) findings.push(_finding('role_links', 'high', 'role_links_need_review', `${needsReview} team member(s) have no login link and no unambiguous email match — manual review needed on the Team page.`, null));

    // Reverse check: a linked user_id that no longer resolves to an active
    // ecosystem user for this company (e.g. access was revoked, roster row
    // was never updated).
    const { data: linked } = await supabase.from('practice_team_members')
        .select('id, display_name, user_id').eq('company_id', cid).eq('is_active', true).not('user_id', 'is', null);
    let orphaned = 0;
    if (linked && linked.length) {
        const { data: accessRows } = await supabase.from('user_company_access').select('user_id').eq('company_id', cid).eq('is_active', true);
        const activeUserIds = new Set((accessRows || []).map(r => r.user_id));
        orphaned = linked.filter(m => !activeUserIds.has(m.user_id)).length;
        if (orphaned > 0) findings.push(_finding('role_links', 'high', 'role_links_orphaned', `${orphaned} active team member(s) are linked to a login account that no longer has active access to this company.`, null));
    }

    const totalActive = ((unlinked || []).length) + ((linked || []).length);
    const issues = needsReview + orphaned;
    const score = totalActive === 0 ? 100 : Math.max(0, 100 - (issues / totalActive) * 100);

    return { score: Math.round(score * 100) / 100, findings, unlinked_total: (unlinked || []).length, auto_healable: autoHealable, needs_review: needsReview, orphaned };
}

// ── Category: Stale Data ───────────────────────────────────────────────────────
// Deterministic day thresholds — the first place these are centralized;
// no existing module tracks any of these itself.

async function _checkStaleData(cid) {
    const findings = [];

    const { data: latestSnapshot } = await supabase.from('practice_kpi_snapshots').select('generated_at').eq('company_id', cid).eq('status', 'active').order('generated_at', { ascending: false }).limit(1).maybeSingle();
    const kpiStale = !latestSnapshot || latestSnapshot.generated_at < _daysAgo(35);
    if (kpiStale) findings.push(_finding('stale_data', 'medium', 'kpi_snapshot_stale', 'No KPI snapshot captured in the last 35 days.', latestSnapshot ? latestSnapshot.generated_at : null));

    const { count: staleNotifications } = await supabase.from('practice_notifications').select('id', { count: 'exact', head: true })
        .eq('company_id', cid).in('notification_status', ['new', 'read']).lt('created_at', _daysAgo(30));
    if (staleNotifications > 0) findings.push(_finding('stale_data', 'low', 'notifications_stale', `${staleNotifications} notification(s) have been unread/unresolved for over 30 days.`, null));

    const { count: staleReports } = await supabase.from('practice_executive_reports').select('id', { count: 'exact', head: true })
        .eq('company_id', cid).in('report_status', ['draft', 'generated']).lt('created_at', _daysAgo(90));
    if (staleReports > 0) findings.push(_finding('stale_data', 'medium', 'executive_reports_stale', `${staleReports} executive report(s) have been stuck in draft/generated for over 90 days.`, null));

    // Only flags rules that HAVE run before but not recently — a genuinely
    // manual-only rule with no run yet is not "stale," it's simply unused.
    const { count: staleRules } = await supabase.from('practice_automation_rules').select('id', { count: 'exact', head: true })
        .eq('company_id', cid).eq('rule_status', 'active').not('last_run_at', 'is', null).lt('last_run_at', _daysAgo(60));
    if (staleRules > 0) findings.push(_finding('stale_data', 'low', 'automation_rules_stale', `${staleRules} active automation rule(s) have not run in over 60 days.`, null));

    let score = 100;
    if (kpiStale) score -= 15;
    score -= Math.min(30, (staleNotifications || 0) * 2);
    score -= Math.min(30, (staleReports || 0) * 10);
    score -= Math.min(15, (staleRules || 0) * 5);
    score = Math.max(0, score);

    return { score: Math.round(score * 100) / 100, findings };
}

// ── Category: Broken Integrations ─────────────────────────────────────────────

async function _checkIntegrations(cid) {
    const findings = [];
    let totalOrphaned = 0;

    const { data: activeMembers } = await supabase.from('practice_team_members').select('id').eq('company_id', cid).eq('is_active', true);
    const activeMemberIds = new Set((activeMembers || []).map(m => m.id));

    for (const link of INTEGRATION_LINKS) {
        const { data: rows } = await supabase.from(link.table).select(`id, ${link.column}`).eq('company_id', cid).not(link.column, 'is', null);
        const orphaned = (rows || []).filter(r => !activeMemberIds.has(r[link.column])).length;
        if (orphaned > 0) {
            totalOrphaned += orphaned;
            findings.push(_finding('integrations', 'medium', 'orphaned_soft_reference', `${orphaned} row(s) in ${link.label} point to an inactive or missing team member.`, null));
        }
    }

    const score = Math.max(0, 100 - totalOrphaned * 5);
    return { score: Math.round(score * 100) / 100, findings, orphaned_references: totalOrphaned };
}

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH ENGINE — computeOperationalHealth()
// ═══════════════════════════════════════════════════════════════════════════

async function computeOperationalHealth(cid) {
    const [modules, configuration, migrations, automation, roleLinks, staleData, integrations] = await Promise.all([
        _checkModules(cid), _checkConfiguration(cid), _checkMigrations(cid), _checkAutomation(cid),
        _checkRoleLinks(cid), _checkStaleData(cid), _checkIntegrations(cid),
    ]);

    const categoryResults = { modules, configuration, migrations, automation, role_links: roleLinks, stale_data: staleData, integrations };
    const findings = CATEGORIES.flatMap(c => categoryResults[c].findings);

    const overallScore = Math.round(
        CATEGORIES.reduce((sum, c) => sum + categoryResults[c].score * CATEGORY_WEIGHTS[c], 0) * 100
    ) / 100;
    const overallStatus = _statusFromScore(overallScore);

    const hasCriticalIn = (category) => categoryResults[category].findings.some(f => f.severity === 'critical');

    // Fixed, deterministic pilot-readiness checklist — every item traces to
    // an already-computed category result, never a fresh calculation.
    const checklist = [
        { key: 'modules_healthy', label: 'All core module tables are reachable', passed: !hasCriticalIn('modules'), detail: `${modules.broken}/${modules.checked} unreachable` },
        { key: 'migrations_applied', label: 'All represented migrations are applied', passed: !hasCriticalIn('migrations'), detail: `${migrations.missing}/${migrations.checked} missing` },
        { key: 'has_owner_or_partner', label: 'At least one active owner/partner can manage the practice', passed: !hasCriticalIn('configuration'), detail: null },
        { key: 'alert_rules_resolve', label: 'Central alert-rules configuration resolves correctly', passed: configuration.findings.every(f => f.code !== 'alert_rules_unresolvable'), detail: null },
        { key: 'role_links_reviewed', label: 'No team members require manual role-link review', passed: roleLinks.needs_review === 0 && roleLinks.orphaned === 0, detail: `${roleLinks.needs_review} need review, ${roleLinks.orphaned} orphaned` },
        { key: 'no_broken_integrations', label: 'No broken cross-module references', passed: integrations.orphaned_references === 0, detail: `${integrations.orphaned_references} orphaned reference(s)` },
        { key: 'automation_stable', label: 'Automation has no recent failed runs', passed: automation.failed_runs === 0, detail: `${automation.failed_runs} failed run(s) in last 30 days` },
        { key: 'no_critical_stale_data', label: 'No critical stale-data findings', passed: !hasCriticalIn('stale_data'), detail: null },
    ];

    return { overallScore, overallStatus, categoryResults, findings, checklist };
}

// ── Routes: Summary (dashboard integration) ────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data } = await supabase.from('practice_health_check_runs')
            .select('id, overall_score, overall_status, completed_at').eq('company_id', cid).eq('run_status', 'completed')
            .order('completed_at', { ascending: false }).limit(1).maybeSingle();
        return res.json({ latest_run: data || null });
    } catch (err) {
        console.error('GET /api/practice/operational-health/summary', err);
        return res.status(500).json({ error: 'Failed to load operational health summary.' });
    }
});

// ── Routes: Run a health check ────────────────────────────────────────────────

router.post('/run', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: run, error: insertError } = await supabase.from('practice_health_check_runs').insert({
            company_id: cid, run_status: 'running', created_by: req.user?.userId || null,
        }).select().single();
        if (insertError) throw insertError;

        await supabase.from('practice_health_check_events').insert({ company_id: cid, run_id: run.id, event_type: 'health_check_started', actor_user_id: req.user?.userId || null, metadata: {} });

        let result;
        try {
            result = await computeOperationalHealth(cid);
        } catch (e) {
            await supabase.from('practice_health_check_runs').update({ run_status: 'failed', completed_at: new Date().toISOString() }).eq('id', run.id).eq('company_id', cid);
            await supabase.from('practice_health_check_events').insert({ company_id: cid, run_id: run.id, event_type: 'health_check_failed', actor_user_id: req.user?.userId || null, notes: e.message, metadata: {} });
            throw e;
        }

        const now = new Date().toISOString();
        const { data: updated, error: updateError } = await supabase.from('practice_health_check_runs').update({
            run_status: 'completed', completed_at: now,
            overall_score: result.overallScore, overall_status: result.overallStatus,
            category_results: result.categoryResults, findings: result.findings, checklist: result.checklist,
        }).eq('id', run.id).eq('company_id', cid).select().single();
        if (updateError) throw updateError;

        await supabase.from('practice_health_check_events').insert({
            company_id: cid, run_id: run.id, event_type: 'health_check_completed', actor_user_id: req.user?.userId || null,
            metadata: { overall_score: result.overallScore, overall_status: result.overallStatus },
        });
        await auditFromReq(req, 'operational_health_check_run', 'practice_health_check_run', run.id, { overall_status: result.overallStatus });

        return res.status(201).json({ run: updated });
    } catch (err) {
        console.error('POST /api/practice/operational-health/run', err);
        return res.status(500).json({ error: 'Failed to run operational health check.' });
    }
});

// ── Routes: Runs ──────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
    const cid = req.companyId;
    const { page = 1, limit = 20 } = req.query;
    try {
        const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const { data, count, error } = await supabase.from('practice_health_check_runs')
            .select('id, run_status, overall_score, overall_status, started_at, completed_at', { count: 'exact' })
            .eq('company_id', cid).order('started_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);
        if (error) throw error;
        return res.json({ runs: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/operational-health/runs', err);
        return res.status(500).json({ error: 'Failed to load health check runs.' });
    }
});

router.get('/runs/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_health_check_runs').select('*').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Health check run not found.' });
        return res.json({ run: data });
    } catch (err) {
        console.error('GET /api/practice/operational-health/runs/:id', err);
        return res.status(500).json({ error: 'Failed to load health check run.' });
    }
});

router.get('/runs/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: run } = await supabase.from('practice_health_check_runs').select('id').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (!run) return res.status(404).json({ error: 'Health check run not found.' });
        const { data, error } = await supabase.from('practice_health_check_events').select('*').eq('run_id', run.id).eq('company_id', cid).order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/operational-health/runs/:id/events', err);
        return res.status(500).json({ error: 'Failed to load run events.' });
    }
});

module.exports = router;
module.exports.computeOperationalHealth = computeOperationalHealth;
