'use strict';

// Codebox 75 — Practice Partner Performance + Practice Scorecards
// A management scorecard system that AGGREGATES existing KPIs into
// executive views. NOT HR. NOT payroll performance. NOT employee ranking.
// NOT disciplinary management. NOT AI. Every component score is
// deterministic, weighted arithmetic, documented below — never fabricated
// when a source metric is unavailable (returns a warning and a null score
// for that component instead).

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
// Codebox 53 — reuse the exact same central thresholds computePracticeScore()
// uses, so a threshold change in Alert Rules flows through to scorecards too.
const { getRules } = require('./alert-rules');
// Codebox 56 — reuse buildTeamItemPool() for the planning component rather
// than re-deriving "overdue/critical work item" a second time.
const planningBoard = require('./planning-board');
// Codebox 57 — reuse buildTeamCapacity() for the capacity component rather
// than re-deriving utilization math a second time.
const capacity = require('./capacity');
// Codebox 59 — reuse getCompetency() for the learning component rather than
// re-deriving skill-gap counts a second time.
const skillsMatrix = require('./skills-matrix');

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

const SCORECARD_TYPES = ['partner', 'manager', 'team', 'practice'];
const REVIEW_STATUSES = ['draft', 'under_review', 'reviewed', 'accepted', 'action_required', 'archived', 'cancelled'];

// Weighting — see docs/new-app/75_partner_scorecards.md for the full
// rationale. Sums to 1.00. Developer-tunable per the spec's Architect
// Freedom clause; any retune must update this constant AND the docs.
const WEIGHTS = {
    profitability: 0.25, quality: 0.20, client: 0.15, capacity: 0.10, risk: 0.10,
    engagement: 0.05, learning: 0.05, planning: 0.05, notification: 0.05,
};

const _clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const _round2 = n => (n == null ? null : Math.round(n * 100) / 100);

function _effectiveMin(rule) {
    return rule && rule.enabled !== false && rule.threshold_value != null ? Number(rule.threshold_value) : Infinity;
}

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage scorecards.' });
        return null;
    }
    return member;
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _writeEvent(cid, scorecardId, reviewId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_partner_scorecard_events').insert({
        company_id: cid, scorecard_id: scorecardId || null, review_id: reviewId || null, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

// Resolves which team_member_ids are "in scope" for a given scorecard
// request. practice: null (no filter — everyone). partner/manager: exactly
// one id. team: every active member whose department matches team_key.
async function _resolveScopeMemberIds(cid, scorecardType, teamMemberId, teamKey) {
    if (scorecardType === 'practice') return null;
    if (scorecardType === 'team') {
        if (!teamKey) throw new Error('team_key is required for a team scorecard.');
        const { data } = await supabase.from('practice_team_members').select('id')
            .eq('company_id', cid).eq('is_active', true).eq('department', teamKey);
        return (data || []).map(m => m.id);
    }
    if (!teamMemberId) throw new Error(`team_member_id is required for a ${scorecardType} scorecard.`);
    return [teamMemberId];
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORECARD ENGINE — buildScorecard()
// ═══════════════════════════════════════════════════════════════════════════
// Every component below states its source, formula, weight, and confidence.
// If a source metric is unavailable, the component returns score: null with
// a warning — never a fabricated number. The overall score is a weighted
// average of only the AVAILABLE components, with weights re-normalized to
// sum to 1 among those — documented explicitly since the spec's weighting
// example assumes every component is always present.

async function _profitabilityComponent(cid, memberIds, periodStart, periodEnd) {
    let clientQ = supabase.from('practice_clients').select('id').eq('company_id', cid).eq('is_active', true);
    if (memberIds) clientQ = clientQ.or(`partner_team_member_id.in.(${memberIds.join(',')}),responsible_team_member_id.in.(${memberIds.join(',')})`);
    const { data: clientRows } = await clientQ;
    const clientIds = (clientRows || []).map(c => c.id);

    const base = { source: 'practice_profitability_snapshots (Codebox 73)', formula: '100 − unprofitable×20 − low_margin×10 − high_writeoffs×5 − low_realization×5 (latest snapshot per owned client)', weight: WEIGHTS.profitability };
    if (!clientIds.length) return { ...base, score: null, confidence: 'none', warning: 'NO_OWNED_CLIENTS' };

    const { data: snapRows } = await supabase.from('practice_profitability_snapshots')
        .select('client_id, profitability_status, warnings, created_at').eq('company_id', cid).in('client_id', clientIds)
        .order('created_at', { ascending: false });
    const latestByClient = new Map();
    (snapRows || []).forEach(s => { if (!latestByClient.has(s.client_id)) latestByClient.set(s.client_id, s); });
    const snapshots = [...latestByClient.values()];
    if (!snapshots.length) return { ...base, score: null, confidence: 'none', warning: 'NO_PROFITABILITY_DATA_FOR_OWNED_CLIENTS' };

    const unprofitable = snapshots.filter(s => s.profitability_status === 'unprofitable').length;
    const lowMargin = snapshots.filter(s => s.profitability_status === 'low_margin').length;
    const highWriteoffs = snapshots.filter(s => (s.warnings || []).includes('HIGH_WRITEOFFS')).length;
    const lowRealization = snapshots.filter(s => (s.warnings || []).includes('LOW_REALIZATION')).length;
    const score = _clamp(100 - unprofitable * 20 - lowMargin * 10 - highWriteoffs * 5 - lowRealization * 5, 0, 100);
    const coverage = snapshots.length / clientIds.length;
    const confidence = coverage >= 0.7 ? 'high' : coverage >= 0.3 ? 'medium' : 'low';
    return { ...base, score, confidence, warning: coverage < 0.7 ? 'LOW_SNAPSHOT_COVERAGE' : null, raw: { owned_clients: clientIds.length, snapshotted_clients: snapshots.length, unprofitable, low_margin: lowMargin, high_writeoffs: highWriteoffs, low_realization: lowRealization } };
}

async function _qualityComponent(cid, memberIds) {
    let reviewQ = supabase.from('practice_quality_reviews').select('status').eq('company_id', cid);
    let findingQ = supabase.from('practice_quality_findings').select('severity').eq('company_id', cid).in('status', ['open', 'in_progress']);
    if (memberIds) { reviewQ = reviewQ.in('assigned_reviewer_team_member_id', memberIds); findingQ = findingQ.in('responsible_team_member_id', memberIds); }
    const [{ data: reviews }, { data: findings }] = await Promise.all([reviewQ, findingQ]);
    const r = reviews || [], f = findings || [];
    const failed = r.filter(x => x.status === 'failed').length;
    const critical = f.filter(x => x.severity === 'critical').length;
    const high = f.filter(x => x.severity === 'high').length;
    const medium = f.filter(x => x.severity === 'medium').length;
    const low = f.filter(x => x.severity === 'low').length;
    const score = _clamp(100 - failed * 15 - critical * 10 - high * 5 - medium * 2 - low * 1, 0, 100);
    const attributed = r.length + f.length;
    return {
        source: 'practice_quality_reviews + practice_quality_findings (Codebox 48)',
        formula: '100 − failed_review×15 − critical_finding×10 − high×5 − medium×2 − low×1',
        weight: WEIGHTS.quality, score, confidence: attributed > 0 ? 'high' : 'low',
        warning: attributed > 0 ? null : 'NO_QUALITY_DATA_ATTRIBUTED',
        raw: { reviews: r.length, findings: f.length, failed, critical, high, medium, low },
    };
}

async function _clientComponent(cid, memberIds) {
    let clientQ = supabase.from('practice_clients').select('id').eq('company_id', cid).eq('is_active', true);
    if (memberIds) clientQ = clientQ.in('responsible_team_member_id', memberIds);
    const { data: clientRows } = await clientQ;
    const clientIds = (clientRows || []).map(c => c.id);
    const base = { source: 'practice_client_success (Codebox 61)', formula: '100 − watch×3 − at_risk×10 − critical×20 (relationship_status of owned clients)', weight: WEIGHTS.client };
    if (memberIds && !clientIds.length) return { ...base, score: null, confidence: 'none', warning: 'NO_OWNED_CLIENTS' };

    let succQ = supabase.from('practice_client_success').select('relationship_status').eq('company_id', cid);
    if (memberIds) succQ = succQ.in('client_id', clientIds);
    const { data: succRows } = await succQ;
    const rows = succRows || [];
    if (!rows.length) return { ...base, score: null, confidence: 'none', warning: 'NO_CLIENT_SUCCESS_DATA' };

    const watch = rows.filter(s => s.relationship_status === 'watch').length;
    const atRisk = rows.filter(s => s.relationship_status === 'at_risk').length;
    const critical = rows.filter(s => s.relationship_status === 'critical').length;
    const score = _clamp(100 - watch * 3 - atRisk * 10 - critical * 20, 0, 100);
    return { ...base, score, confidence: 'high', warning: null, raw: { clients_tracked: rows.length, watch, at_risk: atRisk, critical } };
}

async function _capacityComponent(cid, memberIds, rules) {
    const capacityOverloadedRatio = rules.capacity_overloaded_ratio.enabled !== false ? Number(rules.capacity_overloaded_ratio.threshold_value) : Infinity;
    const allMembers = await capacity.buildTeamCapacity(cid);
    const scoped = memberIds ? allMembers.filter(m => memberIds.includes(m.member_id)) : allMembers;
    const base = { source: 'capacity.buildTeamCapacity() (Codebox 18/57)', formula: '100 − max(0, utilization% − 100) per member, averaged', weight: WEIGHTS.capacity };
    const withCapacitySet = scoped.filter(m => m.capacity_status !== 'unknown');
    if (!withCapacitySet.length) return { ...base, score: null, confidence: 'none', warning: 'CAPACITY_NOT_SET' };

    const memberScores = withCapacitySet.map(m => {
        const utilRatio = (m.utilization_percentage || 0) / 100;
        return _clamp(100 - Math.max(0, utilRatio - capacityOverloadedRatio) * 100, 0, 100);
    });
    const score = _round2(memberScores.reduce((s, v) => s + v, 0) / memberScores.length);
    return { ...base, score, confidence: 'high', warning: withCapacitySet.length < scoped.length ? 'SOME_MEMBERS_MISSING_CAPACITY' : null, raw: { members_scored: withCapacitySet.length, members_in_scope: scoped.length } };
}

async function _riskComponent(cid, memberIds, rules) {
    const riskHighMin = _effectiveMin(rules.risk_high_min);
    const riskCriticalMin = _effectiveMin(rules.risk_critical_min);
    let q = supabase.from('practice_risks').select('inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")');
    if (memberIds) q = q.in('owner_team_member_id', memberIds);
    const { data } = await q;
    const rows = data || [];
    const critical = rows.filter(r => r.inherent_risk >= riskCriticalMin).length;
    const high = rows.filter(r => r.inherent_risk >= riskHighMin && r.inherent_risk < riskCriticalMin).length;
    const other = rows.length - critical - high;
    const score = _clamp(100 - critical * 15 - high * 8 - other * 2, 0, 100);
    return {
        source: 'practice_risks (Codebox 49)', formula: '100 − critical_risk×15 − high_risk×8 − other_open_risk×2',
        weight: WEIGHTS.risk, score, confidence: rows.length > 0 ? 'high' : 'low',
        warning: rows.length > 0 ? null : 'NO_RISK_DATA_ATTRIBUTED', raw: { open_risks: rows.length, critical, high, other },
    };
}

async function _engagementComponent(cid, memberIds) {
    let q = supabase.from('practice_client_engagements')
        .select('engagement_status, status, risk_level, risk_accepted_by, engagement_letter_status, next_review_date').eq('company_id', cid);
    if (memberIds) q = q.or(`partner_team_member_id.in.(${memberIds.join(',')}),responsible_team_member_id.in.(${memberIds.join(',')})`);
    const { data } = await q;
    const rows = data || [];
    const base = { source: 'practice_client_engagements (Codebox 71)', formula: '100 − missing_letter×5 − high_risk_no_acceptance×15 − due_for_review×3 (active-like engagements)', weight: WEIGHTS.engagement };
    if (!rows.length) return { ...base, score: null, confidence: 'none', warning: 'NO_OWNED_ENGAGEMENTS' };

    const ACTIVE_LIKE = ['active', 'under_review', 'renewal_due', 'renewed'];
    const active = rows.filter(e => ACTIVE_LIKE.includes(e.engagement_status) || e.status === 'active');
    const today = new Date().toISOString().slice(0, 10);
    const missingLetters = active.filter(e => !['not_required', 'signed', 'waived'].includes(e.engagement_letter_status)).length;
    const highRiskNoAcceptance = rows.filter(e => ['high', 'critical'].includes(e.risk_level) && !e.risk_accepted_by).length;
    const dueForReview = active.filter(e => e.next_review_date && e.next_review_date <= today).length;
    const score = _clamp(100 - missingLetters * 5 - highRiskNoAcceptance * 15 - dueForReview * 3, 0, 100);
    return { ...base, score, confidence: 'high', warning: null, raw: { total_engagements: rows.length, active: active.length, missing_letters: missingLetters, high_risk_no_acceptance: highRiskNoAcceptance, due_for_review: dueForReview } };
}

async function _learningComponent(cid, memberIds) {
    const base = { source: 'practice_learning_plans (Codebox 60) + skills-matrix.getCompetency() (Codebox 59)', formula: '100 − missing_competencies×5 − overdue_learning_plans×10, averaged per member', weight: WEIGHTS.learning };
    if (!memberIds) {
        // Practice-wide: average across all active members.
        const { data: allMembers } = await supabase.from('practice_team_members').select('id').eq('company_id', cid).eq('is_active', true);
        memberIds = (allMembers || []).map(m => m.id);
    }
    if (!memberIds.length) return { ...base, score: null, confidence: 'none', warning: 'NO_TEAM_MEMBERS_IN_SCOPE' };

    const today = new Date().toISOString().slice(0, 10);
    const { data: planRows } = await supabase.from('practice_learning_plans').select('team_member_id, status, target_completion_date').eq('company_id', cid).in('team_member_id', memberIds);
    const plans = planRows || [];

    const perMemberScores = await Promise.all(memberIds.map(async id => {
        let missingCompetencies = 0;
        try {
            const comp = await skillsMatrix.getCompetency(cid, id);
            missingCompetencies = (comp?.missingCompetencies || comp?.missing_competencies || []).length;
        } catch (e) { /* member may have no skills tracked yet — treated as 0 gaps, not an error */ }
        const overduePlans = plans.filter(p => p.team_member_id === id && p.status === 'active' && p.target_completion_date && p.target_completion_date < today).length;
        return _clamp(100 - missingCompetencies * 5 - overduePlans * 10, 0, 100);
    }));
    const score = _round2(perMemberScores.reduce((s, v) => s + v, 0) / perMemberScores.length);
    return { ...base, score, confidence: plans.length > 0 ? 'high' : 'low', warning: plans.length > 0 ? null : 'NO_LEARNING_PLANS_TRACKED', raw: { members_scored: perMemberScores.length, learning_plans: plans.length } };
}

async function _planningComponent(cid, memberIds) {
    const base = { source: 'planning-board.buildTeamItemPool() (Codebox 56)', formula: '100 − critical_items×5 − overdue_items×3, per member in scope', weight: WEIGHTS.planning };
    const pool = await planningBoard.buildTeamItemPool(cid);
    const items = memberIds ? pool.items.filter(i => memberIds.includes(i.team_member_id)) : pool.items;
    if (!items.length) return { ...base, score: null, confidence: 'none', warning: 'NO_ACTIVE_WORK_ITEMS' };

    const today = new Date().toISOString().slice(0, 10);
    const critical = items.filter(i => i.priority_label === 'critical').length;
    const overdue = items.filter(i => i.due_date && i.due_date < today).length;
    const score = _clamp(100 - critical * 5 - overdue * 3, 0, 100);
    return { ...base, score, confidence: 'high', warning: null, raw: { active_items: items.length, critical, overdue } };
}

async function _notificationComponent(cid, memberIds) {
    let q = supabase.from('practice_notifications').select('notification_status, severity, due_date').eq('company_id', cid);
    if (memberIds) q = q.in('assigned_team_member_id', memberIds);
    const { data } = await q;
    const rows = data || [];
    const base = { source: 'practice_notifications (Codebox 54)', formula: '100 − overdue×10 − critical_unread×5', weight: WEIGHTS.notification };
    if (!rows.length) return { ...base, score: null, confidence: 'none', warning: 'NO_NOTIFICATIONS_DATA' };

    const today = new Date().toISOString().slice(0, 10);
    // Codebox 54 — TERMINAL_STATUSES are 'completed'/'archived'/'cancelled'.
    // 'read'/'snoozed' are still active (not yet actioned), same definition
    // notifications.js itself uses for its own overdue/due-today counts.
    const active = rows.filter(n => !['completed', 'archived', 'cancelled'].includes(n.notification_status));
    const overdue = active.filter(n => n.due_date && n.due_date < today).length;
    const criticalUnread = active.filter(n => n.severity === 'critical' && n.notification_status === 'new').length;
    const score = _clamp(100 - overdue * 10 - criticalUnread * 5, 0, 100);
    return { ...base, score, confidence: 'high', warning: null, raw: { active_notifications: active.length, overdue, critical_unread: criticalUnread } };
}

async function buildScorecard(cid, { scorecardType, teamMemberId, teamKey, periodStart, periodEnd }) {
    if (!SCORECARD_TYPES.includes(scorecardType)) throw new Error(`Invalid scorecard_type. Allowed: ${SCORECARD_TYPES.join(', ')}`);
    const memberIds = await _resolveScopeMemberIds(cid, scorecardType, teamMemberId, teamKey);

    const rules = await getRules(cid, ['risk_high_min', 'risk_critical_min', 'capacity_overloaded_ratio']);

    const [profitability, quality, client, capacityComp, risk, engagement, learning, planning, notification] = await Promise.all([
        _profitabilityComponent(cid, memberIds, periodStart, periodEnd),
        _qualityComponent(cid, memberIds),
        _clientComponent(cid, memberIds),
        _capacityComponent(cid, memberIds, rules),
        _riskComponent(cid, memberIds, rules),
        _engagementComponent(cid, memberIds),
        _learningComponent(cid, memberIds),
        _planningComponent(cid, memberIds),
        _notificationComponent(cid, memberIds),
    ]);

    const components = { profitability, quality, client, capacity: capacityComp, risk, engagement, learning, planning, notification };
    const warnings = Object.entries(components).filter(([, c]) => c.warning).map(([key, c]) => `${key.toUpperCase()}_${c.warning}`);

    // Overall score: weighted average of only the AVAILABLE (non-null)
    // components, weights re-normalized to sum to 1 among those — never
    // fabricates a number for a component with no data, and never lets a
    // handful of unavailable components silently zero out the overall score.
    const available = Object.values(components).filter(c => c.score != null);
    let overallScore = null;
    if (available.length) {
        const totalWeight = available.reduce((s, c) => s + c.weight, 0);
        overallScore = _round2(available.reduce((s, c) => s + c.score * (c.weight / totalWeight), 0));
    }

    return {
        scorecard_type: scorecardType, team_member_id: teamMemberId || null, team_key: teamKey || null,
        period_start: periodStart, period_end: periodEnd,
        overall_score: overallScore,
        component_scores: components,
        warnings,
        weights: WEIGHTS,
        method: 'deterministic_weighted_penalties_reused_from_source_modules',
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRENDS — deterministic comparison against the previous snapshot only.
// No prediction.
// ═══════════════════════════════════════════════════════════════════════════

function _trendDirection(current, previous) {
    if (current == null || previous == null) return 'unknown';
    if (current > previous) return 'improved';
    if (current < previous) return 'declined';
    return 'stable';
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: rows } = await supabase.from('practice_partner_scorecards')
            .select('id, scorecard_type, team_member_id, overall_score, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(500);
        const scorecards = rows || [];
        const byType = { partner: 0, manager: 0, team: 0, practice: 0 };
        scorecards.forEach(s => { if (s.scorecard_type in byType) byType[s.scorecard_type]++; });

        const { data: reviewRows } = await supabase.from('practice_partner_scorecard_reviews').select('review_status').eq('company_id', cid);
        const reviews = reviewRows || [];
        const openReviews = reviews.filter(r => ['draft', 'under_review', 'reviewed', 'action_required'].includes(r.review_status)).length;

        const lowestScoring = [...scorecards].filter(s => s.overall_score != null).sort((a, b) => a.overall_score - b.overall_score)[0] || null;

        res.json({
            scorecards_total: scorecards.length,
            by_scorecard_type: byType,
            open_reviews: openReviews,
            lowest_scoring_snapshot: lowestScoring,
        });
    } catch (err) {
        console.error('Partner-scorecards /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// AD-HOC SCORECARD COMPUTATION (never persisted unless explicitly saved)
// ═══════════════════════════════════════════════════════════════════════════

function _defaultPeriod(q) {
    if (q.period_start && q.period_end) return { start: q.period_start, end: q.period_end };
    const now = new Date();
    return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10), end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10) };
}

router.get('/practice', async (req, res) => {
    const { start, end } = _defaultPeriod(req.query);
    try {
        res.json({ scorecard: await buildScorecard(req.companyId, { scorecardType: 'practice', periodStart: start, periodEnd: end }) });
    } catch (err) {
        console.error('Partner-scorecards GET /practice error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/partner/:teamMemberId', async (req, res) => {
    const { start, end } = _defaultPeriod(req.query);
    try {
        res.json({ scorecard: await buildScorecard(req.companyId, { scorecardType: 'partner', teamMemberId: parseInt(req.params.teamMemberId), periodStart: start, periodEnd: end }) });
    } catch (err) {
        console.error('Partner-scorecards GET /partner/:id error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

router.get('/manager/:teamMemberId', async (req, res) => {
    const { start, end } = _defaultPeriod(req.query);
    try {
        res.json({ scorecard: await buildScorecard(req.companyId, { scorecardType: 'manager', teamMemberId: parseInt(req.params.teamMemberId), periodStart: start, periodEnd: end }) });
    } catch (err) {
        console.error('Partner-scorecards GET /manager/:id error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

router.get('/team/:teamKey', async (req, res) => {
    const { start, end } = _defaultPeriod(req.query);
    try {
        res.json({ scorecard: await buildScorecard(req.companyId, { scorecardType: 'team', teamKey: decodeURIComponent(req.params.teamKey), periodStart: start, periodEnd: end }) });
    } catch (err) {
        console.error('Partner-scorecards GET /team/:key error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// Every distinct department value currently in use — powers the frontend's
// Team scorecard picker without guessing team_key strings.
router.get('/team-keys', async (req, res) => {
    try {
        const { data } = await supabase.from('practice_team_members').select('department').eq('company_id', req.companyId).eq('is_active', true).not('department', 'is', null);
        res.json({ team_keys: [...new Set((data || []).map(m => m.department).filter(Boolean))].sort() });
    } catch (err) {
        console.error('Partner-scorecards GET /team-keys error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOTS (immutable once created)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/snapshots', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { scorecard_type, team_member_id, team_key, period_start, period_end, period_key } = req.body;
    if (!SCORECARD_TYPES.includes(scorecard_type)) return res.status(400).json({ error: `Invalid scorecard_type. Allowed: ${SCORECARD_TYPES.join(', ')}` });
    if (!period_start || !period_end || !period_key) return res.status(400).json({ error: 'period_start, period_end, and period_key are all required.' });

    try {
        const result = await buildScorecard(cid, {
            scorecardType: scorecard_type, teamMemberId: team_member_id ? parseInt(team_member_id) : null,
            teamKey: team_key || null, periodStart: period_start, periodEnd: period_end,
        });

        const { data, error } = await supabase.from('practice_partner_scorecards').insert({
            company_id: cid, team_member_id: result.team_member_id, scorecard_type, team_key: result.team_key,
            period_start, period_end, period_key,
            overall_score: result.overall_score,
            profitability_score: result.component_scores.profitability.score,
            quality_score: result.component_scores.quality.score,
            capacity_score: result.component_scores.capacity.score,
            client_score: result.component_scores.client.score,
            risk_score: result.component_scores.risk.score,
            engagement_score: result.component_scores.engagement.score,
            learning_score: result.component_scores.learning.score,
            planning_score: result.component_scores.planning.score,
            notification_score: result.component_scores.notification.score,
            warnings: result.warnings, snapshot: result, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, data.id, null, 'scorecard_created', null, null, req.user.userId, null, { scorecard_type, period_key });
        res.status(201).json({ scorecard: data });
    } catch (err) {
        console.error('Partner-scorecards POST /snapshots error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

router.get('/snapshots', async (req, res) => {
    const cid = req.companyId;
    const { scorecard_type, team_member_id, team_key, period_key, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_partner_scorecards').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (scorecard_type) q = q.eq('scorecard_type', scorecard_type);
        if (team_member_id) q = q.eq('team_member_id', parseInt(team_member_id));
        if (team_key) q = q.eq('team_key', team_key);
        if (period_key) q = q.eq('period_key', period_key);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const memberIds = [...new Set((data || []).map(r => r.team_member_id).filter(Boolean))];
        let nameById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds).eq('company_id', cid);
            (members || []).forEach(m => { nameById[m.id] = m.display_name; });
        }
        res.json({ scorecards: (data || []).map(s => ({ ...s, team_member_name: s.team_member_id ? (nameById[s.team_member_id] || null) : null })) });
    } catch (err) {
        console.error('Partner-scorecards GET /snapshots error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/snapshots/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_partner_scorecards').select('*').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Scorecard not found' });
        res.json({ scorecard: data });
    } catch (err) {
        console.error('Partner-scorecards GET /snapshots/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Snapshots are permanently immutable — see migration header, same
// precedent as Profitability snapshots (Codebox 73).
router.delete('/snapshots/:id', (req, res) => {
    res.status(405).json({ error: 'Scorecard snapshots are immutable and cannot be deleted.' });
});

// ── GET /trends — compare a scorecard against its immediately preceding
// snapshot for the same scorecard_type + team_member_id/team_key. ──────────

router.get('/trends', async (req, res) => {
    const cid = req.companyId;
    const { scorecard_type, team_member_id, team_key } = req.query;
    if (!SCORECARD_TYPES.includes(scorecard_type)) return res.status(400).json({ error: `scorecard_type is required. Allowed: ${SCORECARD_TYPES.join(', ')}` });
    try {
        let q = supabase.from('practice_partner_scorecards').select('id, period_key, generated_at:created_at, overall_score, profitability_score, quality_score, capacity_score, client_score, risk_score, engagement_score, learning_score, planning_score, notification_score')
            .eq('company_id', cid).eq('scorecard_type', scorecard_type).order('created_at', { ascending: true });
        if (team_member_id) q = q.eq('team_member_id', parseInt(team_member_id));
        if (team_key) q = q.eq('team_key', team_key);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const rows = data || [];
        const SCORE_KEYS = ['overall_score', 'profitability_score', 'quality_score', 'capacity_score', 'client_score', 'risk_score', 'engagement_score', 'learning_score', 'planning_score', 'notification_score'];
        const trend = rows.map((row, i) => {
            const prev = i > 0 ? rows[i - 1] : null;
            const deltas = {};
            SCORE_KEYS.forEach(k => { deltas[k] = { value: row[k], delta: (row[k] != null && prev?.[k] != null) ? _round2(row[k] - prev[k]) : null, direction: prev ? _trendDirection(row[k], prev[k]) : 'unknown' }; });
            return { snapshot_id: row.id, period_key: row.period_key, generated_at: row.generated_at, scores: deltas };
        });
        res.json({ scorecard_type, trend });
    } catch (err) {
        console.error('Partner-scorecards GET /trends error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════

async function _fetchReview(cid, id) {
    const { data } = await supabase.from('practice_partner_scorecard_reviews').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

router.get('/reviews', async (req, res) => {
    const cid = req.companyId;
    const { scorecard_id, review_status, assigned_partner_id } = req.query;
    try {
        let q = supabase.from('practice_partner_scorecard_reviews').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (scorecard_id) q = q.eq('scorecard_id', parseInt(scorecard_id));
        if (review_status) q = q.eq('review_status', review_status);
        if (assigned_partner_id) q = q.eq('assigned_partner_id', parseInt(assigned_partner_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ reviews: data || [] });
    } catch (err) {
        console.error('Partner-scorecards GET /reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/reviews', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { scorecard_id, review_summary, strengths, improvement_areas, partner_notes, action_plan, assigned_partner_id, next_review_date } = req.body;
    const scorecardId = parseInt(scorecard_id);
    if (!scorecardId) return res.status(400).json({ error: 'scorecard_id is required' });
    const { data: scorecard } = await supabase.from('practice_partner_scorecards').select('id').eq('id', scorecardId).eq('company_id', cid).maybeSingle();
    if (!scorecard) return res.status(404).json({ error: 'Scorecard not found' });

    try {
        const { data, error } = await supabase.from('practice_partner_scorecard_reviews').insert({
            company_id: cid, scorecard_id: scorecardId, review_summary: review_summary || null, strengths: strengths || null,
            improvement_areas: improvement_areas || null, partner_notes: partner_notes || null, action_plan: action_plan || null,
            assigned_partner_id: assigned_partner_id || null, next_review_date: next_review_date || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, scorecardId, data.id, 'review_created', null, data.review_status, req.user.userId, null, {});
        res.status(201).json({ review: data });
    } catch (err) {
        console.error('Partner-scorecards POST /reviews error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/reviews/:id', async (req, res) => {
    const review = await _fetchReview(req.companyId, req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json({ review });
});

router.put('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (['archived', 'cancelled'].includes(existing.review_status)) return res.status(400).json({ error: `Cannot edit a review that is already ${existing.review_status}.` });

    const allowed = ['review_summary', 'strengths', 'improvement_areas', 'partner_notes', 'action_plan', 'assigned_partner_id', 'next_review_date'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_partner_scorecard_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, existing.scorecard_id, id, 'review_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ review: data });
    } catch (err) {
        console.error('Partner-scorecards PUT /reviews/:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Workflow actions — same TRANSITIONS-map pattern as Profitability
// (Codebox 73) since this module reuses the exact same review_status enum. ──

const TRANSITIONS = {
    submit: { from: ['draft'], to: 'under_review', event: 'submitted' },
    complete: { from: ['under_review'], to: 'reviewed', event: 'review_completed' },
    'mark-action-required': { from: ['under_review', 'reviewed'], to: 'action_required', event: 'action_required' },
    accept: { from: ['reviewed', 'action_required'], to: 'accepted', event: 'accepted' },
    archive: { from: ['accepted', 'reviewed', 'action_required'], to: 'archived', event: 'archived' },
};

Object.keys(TRANSITIONS).forEach(action => {
    router.put(`/reviews/:id/${action}`, async (req, res) => {
        const cid = req.companyId;
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid review ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const review = await _fetchReview(cid, id);
        if (!review) return res.status(404).json({ error: 'Review not found' });
        const rule = TRANSITIONS[action];
        if (!rule.from.includes(review.review_status)) {
            return res.status(422).json({ error: `Cannot ${action} from status "${review.review_status}". Allowed from: ${rule.from.join(', ')}.` });
        }

        try {
            const update = { review_status: rule.to, updated_by: req.user.userId, updated_at: new Date().toISOString() };
            if (action === 'complete') { update.reviewed_by = req.user.userId; update.reviewed_at = new Date().toISOString(); }
            if (req.body.notes) update.partner_notes = req.body.notes;

            const { data, error } = await supabase.from('practice_partner_scorecard_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });
            await _writeEvent(cid, review.scorecard_id, id, rule.event, review.review_status, rule.to, req.user.userId, req.body.notes || null, {});
            res.json({ review: data });
        } catch (err) {
            console.error(`Partner-scorecards PUT /reviews/:id/${action} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { scorecard_id, review_id } = req.query;
    try {
        let q = supabase.from('practice_partner_scorecard_events').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (scorecard_id) q = q.eq('scorecard_id', parseInt(scorecard_id));
        if (review_id) q = q.eq('review_id', parseInt(review_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Partner-scorecards GET /events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules' integrations (Management Dashboard, Planning
// Board, Client Success) — see docs/new-app/75_partner_scorecards.md
module.exports.buildScorecard = buildScorecard;
