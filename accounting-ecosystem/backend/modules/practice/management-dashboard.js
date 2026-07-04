'use strict';

// Codebox 50 — Practice Management Dashboard (Executive Command Centre)
// Read-only aggregator over existing modules. NOT an operational page —
// this is where partners manage the practice.
//
// NOT AI. All scoring is deterministic, weighted arithmetic — documented below.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
// Codebox 53 — thresholds that decide "high"/"critical"/"overloaded"/"overdue"
// come from the central Alert Rules Engine instead of being hardcoded here.
// getRules() always resolves (DB row, or a safe fallback matching the
// original hardcoded values) — never throws, never returns undefined.
const { getRules } = require('./alert-rules');
// Codebox 67 — reuse the exact scheduler buildStatutoryCalendar() rather than
// re-approximating "blocked"/"overdue" with a second, cheaper heuristic here.
const { buildStatutoryCalendar } = require('./secretarial-calendar');
// Codebox 66 — reuse getEvidenceSummary() rather than re-deriving checklist
// readiness a second time.
const { getEvidenceSummary } = require('./secretarial-evidence');

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
function _clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// A disabled min-threshold rule should suppress that band entirely (nothing
// can be ">= Infinity"). Day-count rules (grace/window) ignore `enabled` —
// disabling a day count has no unambiguous meaning, so they always use
// threshold_value (falling back to the seeded default if unset).
function _effectiveMin(rule) {
    return rule && rule.enabled !== false && rule.threshold_value != null ? Number(rule.threshold_value) : Infinity;
}
function _effectiveDays(rule, fallback) {
    return rule && rule.threshold_value != null ? Number(rule.threshold_value) : fallback;
}

// Count-only query helper — head:true avoids fetching rows, just the count.
async function _count(table, build) {
    let q = supabase.from(table).select('id', { count: 'exact', head: true });
    if (build) q = build(q);
    const { count, error } = await q;
    if (error) { console.error(`[management-dashboard] count(${table})`, error.message); return 0; }
    return count || 0;
}

// ── Compute functions ─────────────────────────────────────────────────────────
// Codebox 51 (KPI History) reuses these directly (in-process function calls,
// not HTTP) so KPI logic is never duplicated. Each throws on error — route
// handlers below catch and translate to a 500; kpi-history.js does the same.

// Executive KPIs across every module. Every query is company-scoped and
// count-only (head:true) — no row bodies are fetched, keeping this cheap
// even with ~25 parallel queries per request.
async function computeSummary(cid) {
    // Codebox 53 — central rules replace what used to be hardcoded here.
    const rules = await getRules(cid, [
        'risk_high_min', 'risk_critical_min', 'capacity_overloaded_ratio',
        'reminder_overdue_grace_days', 'reminder_upcoming_window_days', 'document_overdue_grace_days',
    ]);
    const riskHighMin = _effectiveMin(rules.risk_high_min);
    const riskCriticalMin = _effectiveMin(rules.risk_critical_min);
    const capacityOverloadedRatio = rules.capacity_overloaded_ratio.enabled !== false ? Number(rules.capacity_overloaded_ratio.threshold_value) : Infinity;
    const reminderOverdueCutoff = _daysFromNow(-_effectiveDays(rules.reminder_overdue_grace_days, 0));
    const reminderUpcomingWindow = _effectiveDays(rules.reminder_upcoming_window_days, 7);
    const documentOverdueCutoff = _daysFromNow(-_effectiveDays(rules.document_overdue_grace_days, 0));

    const today = _today();
    const weekOut = _daysFromNow(reminderUpcomingWindow);

    const [
            // ── Practice ──
            activeClients, activeStaff, openTasks, overdueTasks,

            // ── Capacity (raw rows — small table, needed for utilization math) ──
            teamCapacityRows, openTaskHoursRows,

            // ── Tax ──
            indivOpen, companyOpen, indivReadyReview, companyReadyReview,
            indivReadySubmit, companyReadySubmit, indivPipeline, companyPipeline,
            paymentsOutstanding, sarsUnmatched, openDisputes, activeCompletionPacks,

            // ── QMS ──
            activeReviews, failedReviews, needsCorrectionReviews, openFindings,
            criticalFindings, highFindings,

            // ── Risk ──
            openRisks, riskRows,

            // ── Client Health ──
            clientsGood, clientsWatch, clientsAtRisk, clientsCritical, clientsUnknown,

            // ── Knowledge ──
            kbDraft, kbUnderReview, kbApproved,

            // ── SOP ──
            sopDraft, sopUnderReview, sopApproved,

            // ── Billing ──
            billingDraft, billingLocked, billingRows,

            // ── Reminders ──
            remindersOverdue, remindersUpcoming,

            // ── Document Requests ──
            docsOutstanding, docsOverdue,

            // ── Communications ──
            commsFollowUp,

            // ── Compliance ──
            complianceOpen, complianceBlocked,

        ] = await Promise.all([
            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true)),
            _count('practice_team_members', q => q.eq('company_id', cid).eq('is_active', true)),
            _count('practice_tasks', q => q.eq('company_id', cid).in('status', ['open', 'in_progress'])),
            _count('practice_tasks', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).lt('due_date', today)),

            supabase.from('practice_team_members').select('id, weekly_capacity_hours').eq('company_id', cid).eq('is_active', true).eq('capacity_is_active', true),
            supabase.from('practice_tasks').select('assigned_to, estimated_hours').eq('company_id', cid).in('status', ['open', 'in_progress']),

            _count('practice_individual_tax_returns', q => q.eq('company_id', cid).not('status', 'in', '("completed","cancelled")')),
            _count('practice_company_tax_returns',    q => q.eq('company_id', cid).not('status', 'in', '("completed","cancelled")')),
            _count('practice_individual_tax_returns', q => q.eq('company_id', cid).eq('status', 'ready_for_review')),
            _count('practice_company_tax_returns',    q => q.eq('company_id', cid).eq('status', 'ready_for_review')),
            _count('practice_individual_tax_returns', q => q.eq('company_id', cid).eq('filing_stage', 'ready_to_submit')),
            _count('practice_company_tax_returns',    q => q.eq('company_id', cid).eq('filing_stage', 'ready_to_submit')),
            _count('practice_individual_tax_returns', q => q.eq('company_id', cid).not('filing_stage', 'in', '("completed","cancelled")')),
            _count('practice_company_tax_returns',    q => q.eq('company_id', cid).not('filing_stage', 'in', '("completed","cancelled")')),
            _count('practice_tax_payments',           q => q.eq('company_id', cid).eq('direction', 'payable').in('status', ['outstanding', 'partially_paid'])),
            _count('practice_sars_statement_lines',   q => q.eq('company_id', cid).in('reconciliation_status', ['unmatched', 'disputed'])),
            _count('practice_tax_dispute_cases',      q => q.eq('company_id', cid).not('case_status', 'in', '("completed","cancelled")')),
            _count('practice_tax_completion_packs',   q => q.eq('company_id', cid).not('pack_status', 'in', '("completed","cancelled")')),

            _count('practice_quality_reviews',  q => q.eq('company_id', cid).not('status', 'in', '("completed","cancelled")')),
            _count('practice_quality_reviews',  q => q.eq('company_id', cid).eq('status', 'failed')),
            _count('practice_quality_reviews',  q => q.eq('company_id', cid).eq('status', 'needs_correction')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress'])),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'critical')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'high')),

            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")')),
            supabase.from('practice_risks').select('inherent_risk, status').eq('company_id', cid).not('status', 'in', '("closed","cancelled")'),

            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true).eq('health_status', 'good')),
            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true).eq('health_status', 'watch')),
            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true).eq('health_status', 'at_risk')),
            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true).eq('health_status', 'critical')),
            _count('practice_clients', q => q.eq('company_id', cid).eq('is_active', true).or('health_status.is.null,health_status.eq.unknown')),

            _count('practice_knowledge_articles', q => q.eq('company_id', cid).eq('status', 'draft')),
            _count('practice_knowledge_articles', q => q.eq('company_id', cid).eq('status', 'under_review')),
            _count('practice_knowledge_articles', q => q.eq('company_id', cid).eq('status', 'approved')),

            _count('practice_sop_templates', q => q.eq('company_id', cid).eq('status', 'draft')),
            _count('practice_sop_templates', q => q.eq('company_id', cid).eq('status', 'under_review')),
            _count('practice_sop_templates', q => q.eq('company_id', cid).eq('status', 'approved')),

            _count('practice_billing_packs', q => q.eq('company_id', cid).eq('status', 'draft')),
            _count('practice_billing_packs', q => q.eq('company_id', cid).eq('status', 'locked')),
            supabase.from('practice_billing_packs').select('recoverable_value, billable_value, status').eq('company_id', cid).not('status', 'in', '("cancelled")'),

            _count('practice_reminders', q => q.eq('company_id', cid).in('status', ['open', 'snoozed']).lt('due_date', reminderOverdueCutoff)),
            _count('practice_reminders', q => q.eq('company_id', cid).in('status', ['open', 'snoozed']).gte('due_date', today).lte('due_date', weekOut)),

            _count('practice_document_requests', q => q.eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received'])),
            _count('practice_document_requests', q => q.eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received']).lt('required_by_date', documentOverdueCutoff)),

            _count('practice_client_communications', q => q.eq('company_id', cid).eq('response_required', true).in('response_status', ['waiting', 'overdue']).is('cancelled_at', null)),

            _count('practice_deadlines', q => q.eq('company_id', cid).in('status', ['open', 'pending', 'in_progress', 'waiting_client', 'waiting_review'])),
            _count('practice_compliance_packs', q => q.eq('company_id', cid).eq('readiness_status', 'blocked')),
        ]);

        // ── Capacity math (derived from raw rows fetched above) ──
        const capacityByMember = {};
        (teamCapacityRows.data || []).forEach(m => { capacityByMember[m.id] = { weekly: Number(m.weekly_capacity_hours) || 0, assigned: 0 }; });
        (openTaskHoursRows.data || []).forEach(t => {
            if (t.assigned_to != null && capacityByMember[t.assigned_to]) {
                capacityByMember[t.assigned_to].assigned += Number(t.estimated_hours) || 0;
            }
        });
        const members = Object.values(capacityByMember).filter(m => m.weekly > 0);
        const overCapacityCount = members.filter(m => (m.assigned / m.weekly) > capacityOverloadedRatio).length;
        const avgUtilizationPct = members.length
            ? Math.round((members.reduce((s, m) => s + (m.assigned / m.weekly), 0) / members.length) * 100)
            : 0;

        // ── Risk band math (derived from raw rows) — thresholds from getRules() above ──
        const risks = riskRows.data || [];
        const highRiskCount = risks.filter(r => r.inherent_risk >= riskHighMin && r.inherent_risk < riskCriticalMin).length;
        const criticalRiskCount = risks.filter(r => r.inherent_risk >= riskCriticalMin).length;

        // ── Billing realisation math (derived from raw rows) ──
        const packs = billingRows.data || [];
        const totalRecoverable = packs.reduce((s, p) => s + (Number(p.recoverable_value) || 0), 0);
        const totalBillable = packs.reduce((s, p) => s + (Number(p.billable_value) || 0), 0);
        const realisationPct = totalRecoverable > 0 ? Math.round((totalBillable / totalRecoverable) * 1000) / 10 : null;

        // ── Client Success relationship health (Codebox 61) — a separate
        // concept from client_health above (which is OPERATIONAL: overdue
        // deadlines/tasks/WIP). This counts RELATIONSHIP status from
        // practice_client_success. Kept out of the main Promise.all above
        // only for readability, matching the same precedent used for
        // client-health snapshot recency in computeExecutiveFeed().
        const relationshipRows = await supabase.from('practice_client_success').select('relationship_status').eq('company_id', cid);
        const relationshipCounts = { healthy: 0, watch: 0, at_risk: 0, critical: 0, unknown: 0 };
        (relationshipRows.data || []).forEach(r => { const k = r.relationship_status || 'unknown'; if (k in relationshipCounts) relationshipCounts[k]++; });

        // Codebox 65 — Beneficial Ownership summary. Low-risk, count-only
        // queries (same pattern as relationshipRows above) — no readiness
        // score computed here, just plain counts by owner status and a
        // blocked-required-item count (matching the Planning Board badge's
        // deliberately lightweight scope).
        const [boOwnerRows, boBlockedRows] = await Promise.all([
            supabase.from('practice_beneficial_owners').select('status, is_reportable').eq('company_id', cid),
            supabase.from('practice_bo_readiness_items').select('client_id').eq('company_id', cid).eq('status', 'blocked').eq('required', true),
        ]);
        const boOwnerCounts = { draft: 0, active: 0, incomplete: 0, verified: 0, not_reportable: 0, archived: 0 };
        (boOwnerRows.data || []).forEach(o => { if (o.status in boOwnerCounts) boOwnerCounts[o.status]++; });
        const boReportableCount = (boOwnerRows.data || []).filter(o => o.is_reportable).length;
        const boBlockedClientCount = new Set((boBlockedRows.data || []).map(r => r.client_id)).size;

        // Codebox 67 — Statutory Compliance summary. Reuses buildStatutoryCalendar()
        // directly (see require at top of file) rather than re-implementing the
        // upcoming/overdue/blocked categorization a second time.
        let statutoryCounts = { upcoming: 0, overdue: 0, blocked: 0, due_today: 0 };
        try {
            const statutoryCalendar = await buildStatutoryCalendar(cid, null);
            statutoryCounts = statutoryCalendar.counts;
        } catch (e) { console.error('[management-dashboard] statutory calendar', e.message); }

        // Codebox 66 — Evidence readiness summary, reused directly.
        let evidenceSummary = { checklists_total: 0, checklists_by_readiness: { ready: 0, partial: 0, incomplete: 0, blocked: 0, unknown: 0 } };
        try {
            evidenceSummary = await getEvidenceSummary(cid);
        } catch (e) { console.error('[management-dashboard] evidence summary', e.message); }

        // Codebox 68 — Entity Lifecycle summary. Low-risk, count-only queries
        // (same pattern as beneficial_ownership above) — no per-client call
        // into entity-lifecycle.js's getEntityLifecycleProfile() (which
        // composes 4 other modules) for every entity on every dashboard load.
        const [lifecycleProfileRows, lifecyclePendingRows] = await Promise.all([
            supabase.from('practice_entity_lifecycle_profiles').select('risk_status, compliance_status').eq('company_id', cid),
            supabase.from('practice_entity_lifecycle_transitions').select('client_id').eq('company_id', cid).in('transition_status', ['ready_for_review', 'approved']),
        ]);
        const lifecycleHighRiskCount = (lifecycleProfileRows.data || []).filter(p => ['high', 'critical'].includes(p.risk_status)).length;
        const lifecycleNonCompliantCount = (lifecycleProfileRows.data || []).filter(p => p.compliance_status === 'non_compliant').length;

        // Codebox 69 — Secretarial Integrity summary. Reads only the LATEST
        // run's stored counts plus a live open-findings count — never triggers
        // a new audit run from a dashboard page load (runIntegrityAudit() is
        // an explicit, manager-initiated action only).
        const [latestIntegrityRunRes, openIntegrityFindingsRes] = await Promise.all([
            supabase.from('practice_secretarial_integrity_runs').select('overall_score, critical_count, high_count, scan_started_at, passed').eq('company_id', cid).order('scan_started_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('practice_secretarial_integrity_findings').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('status', 'open'),
        ]);
        const latestIntegrityRun = latestIntegrityRunRes.data || null;

        // Codebox 70 — Client Onboarding summary. Low-risk, count-only
        // queries (same pattern as every other KPI block above) — no call
        // into client-onboarding.js's buildOnboardingWorkspace() (a write
        // operation) for a read-only dashboard load.
        const { data: onboardingRows } = await supabase.from('practice_onboarding_profiles')
            .select('onboarding_status, expected_go_live_date, completion_percentage, created_at').eq('company_id', cid);
        const obRows = onboardingRows || [];
        const obToday = _today();
        const obMonthStart = obToday.slice(0, 7) + '-01';
        const obActive = obRows.filter(p => !['completed', 'cancelled'].includes(p.onboarding_status));
        const obDelayed = obActive.filter(p => p.expected_go_live_date && p.expected_go_live_date < obToday);
        const obNewThisMonth = obRows.filter(p => p.created_at && p.created_at.slice(0, 10) >= obMonthStart).length;
        const obAvgCompletion = obActive.length ? Math.round(obActive.reduce((s, p) => s + (p.completion_percentage || 0), 0) / obActive.length) : 0;

        // Codebox 71 — Engagement Management summary. Low-risk, count-only
        // queries (same pattern as every other KPI block above) — no call
        // into engagement-management.js's getClientEngagementProfile() (a
        // per-client, multi-query function) for every client on every
        // dashboard load. "Clients with work but no engagement" is a cheaper
        // company-wide approximation (any tax/secretarial/time-entry record
        // vs. zero active engagements) — not the fully-typed per-service gap
        // detection the client-level profile performs.
        const [engRows, taxClientRows, secClientRows, timeClientRows] = await Promise.all([
            supabase.from('practice_client_engagements').select('client_id, engagement_status, status, risk_level, risk_accepted_by, engagement_letter_status, next_review_date').eq('company_id', cid),
            supabase.from('practice_taxpayer_profiles').select('client_id').eq('company_id', cid),
            supabase.from('practice_secretarial_profiles').select('client_id').eq('company_id', cid),
            supabase.from('practice_time_entries').select('client_id').eq('company_id', cid),
        ]);
        const ACTIVE_LIKE = ['active', 'under_review', 'renewal_due', 'renewed'];
        const isActiveEng = e => ACTIVE_LIKE.includes(e.engagement_status) || e.status === 'active';
        const engagementRows = engRows.data || [];
        const activeEngagements = engagementRows.filter(isActiveEng);
        const engDueForReview = activeEngagements.filter(e => e.next_review_date && e.next_review_date <= obToday).length;
        const engMissingLetters = activeEngagements.filter(e => !['not_required', 'signed', 'waived'].includes(e.engagement_letter_status)).length;
        const engHighRiskNoAcceptance = engagementRows.filter(e => ['high', 'critical'].includes(e.risk_level) && !e.risk_accepted_by).length;

        const clientsWithActiveEngagement = new Set(activeEngagements.map(e => e.client_id));
        const clientsWithWork = new Set([
            ...(taxClientRows.data || []).map(r => r.client_id),
            ...(secClientRows.data || []).map(r => r.client_id),
            ...(timeClientRows.data || []).map(r => r.client_id),
        ]);
        const clientsWithWorkNoEngagement = [...clientsWithWork].filter(id => !clientsWithActiveEngagement.has(id)).length;

        // Codebox 72 — Work Authorization summary. Low-risk, count-only
        // query (same pattern as every other KPI block above) — no call
        // into work-authorization.js's checkWorkAuthorization() (a write
        // operation) for a read-only dashboard load.
        const { data: authRows } = await supabase.from('practice_work_authorizations')
            .select('authorization_status, scope_result, risk_level').eq('company_id', cid).neq('authorization_status', 'cancelled');
        const authorizations = authRows || [];
        const outOfScopeWork = authorizations.filter(a => ['out_of_scope', 'no_active_engagement'].includes(a.scope_result)).length;
        const pendingOverrides = authorizations.filter(a => a.authorization_status === 'override_requested').length;
        const highRiskOverrides = authorizations.filter(a => a.authorization_status === 'override_approved' && ['high', 'critical'].includes(a.risk_level)).length;

        // Codebox 73 — Profitability summary. Low-risk, count-only query
        // (same pattern as every other KPI block above) — no call into
        // profitability.js's calculateProfitability() (a multi-query
        // computation) for every client on every dashboard load. Reads the
        // most recent 500 saved snapshots, same honest approximation as
        // that module's own /summary endpoint.
        const { data: profitRows } = await supabase.from('practice_profitability_snapshots')
            .select('profitability_status, warnings').eq('company_id', cid).order('created_at', { ascending: false }).limit(500);
        const snapshots = profitRows || [];
        const lowMarginClients = snapshots.filter(s => s.profitability_status === 'low_margin').length;
        const unprofitableClients = snapshots.filter(s => s.profitability_status === 'unprofitable').length;
        const highWriteoffs = snapshots.filter(s => (s.warnings || []).includes('HIGH_WRITEOFFS')).length;
        const lowRealization = snapshots.filter(s => (s.warnings || []).includes('LOW_REALIZATION')).length;

        // Codebox 74 — Pricing Review summary. Same count-only pattern as
        // every other KPI block — never computes buildPricingReview() for
        // every client on every dashboard load.
        const { data: pricingRows } = await supabase.from('practice_pricing_reviews')
            .select('pricing_status').eq('company_id', cid);
        const pricingReviews = pricingRows || [];
        const pricingReviewsTotal = pricingReviews.length;
        const partnerApprovalsWaiting = pricingReviews.filter(r => r.pricing_status === 'partner_review').length;
        const commercialDiscussionsPending = pricingReviews.filter(r => ['under_review', 'partner_review'].includes(r.pricing_status)).length;
        const approvedNotImplemented = pricingReviews.filter(r => r.pricing_status === 'approved').length;

        // Codebox 75 — Partner Scorecards summary. Same count-only pattern as
        // every other KPI block — never calls buildScorecard() from a
        // dashboard load. Reads only the most recent 500 saved snapshots.
        const { data: scorecardRows } = await supabase.from('practice_partner_scorecards')
            .select('id, scorecard_type, team_member_id, overall_score, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(500);
        const scorecards = scorecardRows || [];
        const latestPractice = scorecards.find(s => s.scorecard_type === 'practice') || null;
        const scoredSnapshots = scorecards.filter(s => s.overall_score != null);
        const lowestScoring = scoredSnapshots.length ? scoredSnapshots.reduce((min, s) => (s.overall_score < min.overall_score ? s : min)) : null;

        return {
            practice: {
                active_clients: activeClients,
                active_staff:   activeStaff,
                open_tasks:     openTasks,
                overdue_tasks:  overdueTasks,
            },
            capacity: {
                over_capacity_staff: overCapacityCount,
                avg_utilization_pct: avgUtilizationPct,
                staff_with_capacity_set: members.length,
            },
            tax: {
                open_returns:        indivOpen + companyOpen,
                ready_review:        indivReadyReview + companyReadyReview,
                ready_submit:        indivReadySubmit + companyReadySubmit,
                pipeline:            indivPipeline + companyPipeline,
                payments_outstanding: paymentsOutstanding,
                sars_recon_unmatched: sarsUnmatched,
                open_disputes:        openDisputes,
                completion_packs_active: activeCompletionPacks,
            },
            qms: {
                active_reviews:    activeReviews,
                failed_reviews:    failedReviews,
                needs_correction:  needsCorrectionReviews,
                open_findings:     openFindings,
                critical_findings: criticalFindings,
                high_findings:     highFindings,
            },
            risk: {
                open_risks:     openRisks,
                high_risks:     highRiskCount,
                critical_risks: criticalRiskCount,
            },
            client_health: {
                healthy: clientsGood,
                watch:   clientsWatch,
                critical: clientsAtRisk + clientsCritical,
                unknown: clientsUnknown,
            },
            // Codebox 61 — RELATIONSHIP health (manager assessment + communication
            // cadence), distinct from client_health above (operational risk).
            client_relationship: relationshipCounts,
            beneficial_ownership: {
                owners_by_status: boOwnerCounts,
                reportable_owners: boReportableCount,
                clients_with_blocked_items: boBlockedClientCount,
            },
            statutory_compliance: statutoryCounts,
            evidence_readiness: {
                total: evidenceSummary.checklists_total,
                by_readiness: evidenceSummary.checklists_by_readiness,
                blocked: evidenceSummary.checklists_by_readiness.blocked || 0,
            },
            entity_lifecycle: {
                entities_tracked: (lifecycleProfileRows.data || []).length,
                high_risk: lifecycleHighRiskCount,
                non_compliant: lifecycleNonCompliantCount,
                transitions_pending_review: (lifecyclePendingRows.data || []).length,
            },
            secretarial_integrity: {
                latest_score: latestIntegrityRun ? latestIntegrityRun.overall_score : null,
                latest_run_at: latestIntegrityRun ? latestIntegrityRun.scan_started_at : null,
                latest_passed: latestIntegrityRun ? latestIntegrityRun.passed : null,
                critical_findings: latestIntegrityRun ? latestIntegrityRun.critical_count : 0,
                open_findings: openIntegrityFindingsRes.count || 0,
            },
            client_onboarding: {
                new_clients_this_month: obNewThisMonth,
                active_onboardings: obActive.length,
                delayed_onboardings: obDelayed.length,
                avg_completion_pct: obAvgCompletion,
            },
            engagement_management: {
                due_for_review: engDueForReview,
                missing_engagement_letters: engMissingLetters,
                high_risk_without_acceptance: engHighRiskNoAcceptance,
                clients_with_work_no_engagement: clientsWithWorkNoEngagement,
            },
            work_authorization: {
                out_of_scope_work: outOfScopeWork,
                pending_overrides: pendingOverrides,
                high_risk_overrides: highRiskOverrides,
            },
            profitability: {
                low_margin_clients: lowMarginClients,
                unprofitable_clients: unprofitableClients,
                high_writeoffs: highWriteoffs,
                low_realization: lowRealization,
            },
            pricing_review: {
                total: pricingReviewsTotal,
                partner_approvals_waiting: partnerApprovalsWaiting,
                commercial_discussions_pending: commercialDiscussionsPending,
                approved_not_implemented: approvedNotImplemented,
            },
            partner_scorecards: {
                practice_score: latestPractice ? latestPractice.overall_score : null,
                practice_score_generated_at: latestPractice ? latestPractice.created_at : null,
                total_snapshots: scorecards.length,
                lowest_scoring_snapshot: lowestScoring,
            },
            knowledge: {
                draft: kbDraft, under_review: kbUnderReview, approved: kbApproved,
            },
            sop: {
                draft: sopDraft, under_review: sopUnderReview, approved: sopApproved,
            },
            billing: {
                draft_packs: billingDraft,
                locked_packs: billingLocked,
                realisation_pct: realisationPct,
            },
            reminders: {
                overdue: remindersOverdue, upcoming: remindersUpcoming,
            },
            document_requests: {
                outstanding: docsOutstanding, overdue: docsOverdue,
            },
            communications: {
                unread_followups: commsFollowUp,
            },
            compliance: {
                open: complianceOpen, blocked: complianceBlocked,
            },
        };
}

router.get('/summary', async (req, res) => {
    try {
        return res.json(await computeSummary(req.companyId));
    } catch (err) {
        console.error('GET /api/practice/management-dashboard/summary', err);
        return res.status(500).json({ error: 'Failed to load executive summary.' });
    }
});

// ── GET /executive-feed ───────────────────────────────────────────────────────
// Merges recent activity across modules, newest first. Modules with a
// dedicated append-only event log are used directly; modules without one
// fall back to recency-sorted base-table rows (see docs for the mapping —
// "Workflow" activity is intentionally omitted, see follow-up note).

async function computeExecutiveFeed(cid, limit) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

    const [qmsEv, riskEv, disputeEv, completionEv, kbEv, sopEv, comms, reminders, billing] = await Promise.all([
            supabase.from('practice_quality_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_risk_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_tax_dispute_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_tax_completion_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_knowledge_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_sop_events').select('id, event_type, old_status, new_status, notes, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_client_communications').select('id, communication_type, response_status, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_reminders').select('id, reminder_type, severity, status, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(limit),
            supabase.from('practice_billing_packs').select('id, status, period_start, period_end, updated_at').eq('company_id', cid).order('updated_at', { ascending: false }).limit(limit),
        ]);

        const feed = [];
        (qmsEv.data || []).forEach(e => feed.push({ source: 'qms', event_type: e.event_type, description: `Quality: ${e.event_type}${e.new_status ? ' → ' + e.new_status : ''}`, notes: e.notes, at: e.created_at }));
        (riskEv.data || []).forEach(e => feed.push({ source: 'risk', event_type: e.event_type, description: `Risk: ${e.event_type}${e.new_status ? ' → ' + e.new_status : ''}`, notes: e.notes, at: e.created_at }));
        (disputeEv.data || []).forEach(e => feed.push({ source: 'tax', event_type: e.event_type, description: `Tax dispute: ${e.event_type}${e.new_status ? ' → ' + e.new_status : ''}`, notes: e.notes, at: e.created_at }));
        (completionEv.data || []).forEach(e => feed.push({ source: 'tax', event_type: e.event_type, description: `Completion pack: ${e.event_type}${e.new_status ? ' → ' + e.new_status : ''}`, notes: e.notes, at: e.created_at }));
        (kbEv.data || []).forEach(e => feed.push({ source: 'knowledge', event_type: e.event_type, description: `Knowledge: ${e.event_type}`, notes: e.notes, at: e.created_at }));
        (sopEv.data || []).forEach(e => feed.push({ source: 'sop', event_type: e.event_type, description: `SOP: ${e.event_type}`, notes: e.notes, at: e.created_at }));
        (comms.data || []).forEach(e => feed.push({ source: 'communications', event_type: 'logged', description: `Communication logged: ${e.communication_type} (${e.response_status})`, notes: null, at: e.created_at }));
        (reminders.data || []).forEach(e => feed.push({ source: 'reminders', event_type: 'created', description: `Reminder created: ${e.reminder_type} (${e.severity})`, notes: null, at: e.created_at }));
        (billing.data || []).forEach(e => feed.push({ source: 'billing', event_type: 'updated', description: `Billing pack ${e.status} (${e.period_start || '—'} to ${e.period_end || '—'})`, notes: null, at: e.updated_at }));
        // Client health uses its own snapshot recency (separate query — kept
        // out of Promise.all above only for readability, negligible cost).
        const clientHealth = await supabase.from('practice_client_health_snapshots').select('id, client_id, health_status, calculated_at').eq('company_id', cid).order('calculated_at', { ascending: false }).limit(limit);
        (clientHealth.data || []).forEach(e => feed.push({ source: 'client', event_type: 'health_snapshot', description: `Client health recalculated: ${e.health_status}`, notes: null, at: e.calculated_at }));

        feed.sort((a, b) => new Date(b.at) - new Date(a.at));

        return feed.slice(0, limit);
}

router.get('/executive-feed', async (req, res) => {
    try {
        return res.json({ feed: await computeExecutiveFeed(req.companyId, req.query.limit) });
    } catch (err) {
        console.error('GET /api/practice/management-dashboard/executive-feed', err);
        return res.status(500).json({ error: 'Failed to load executive feed.' });
    }
});

// ── GET /alerts ────────────────────────────────────────────────────────────────
// Only critical / high / overdue / blocked / needs-partner / requires-approval.

async function computeAlerts(cid) {
    // Codebox 53 — central rules replace what used to be hardcoded here.
    const rules = await getRules(cid, [
        'risk_high_min', 'risk_critical_min', 'risk_partner_acceptance_min',
        'reminder_overdue_grace_days', 'document_overdue_grace_days', 'compliance_deadline_overdue_grace_days',
    ]);
    const riskHighMin = _effectiveMin(rules.risk_high_min);
    const riskCriticalMin = _effectiveMin(rules.risk_critical_min);
    const riskPartnerAcceptanceMin = _effectiveMin(rules.risk_partner_acceptance_min);
    const reminderOverdueCutoff = _daysFromNow(-_effectiveDays(rules.reminder_overdue_grace_days, 0));
    const documentOverdueCutoff = _daysFromNow(-_effectiveDays(rules.document_overdue_grace_days, 0));
    const deadlineOverdueCutoff = _daysFromNow(-_effectiveDays(rules.compliance_deadline_overdue_grace_days, 0));

    const today = _today();

    const [
            criticalRisks, criticalFindings, failedReviews,
            highRisks, highFindings,
            overdueTasks, overdueReminders, overdueDocs, overdueDeadlines,
            blockedCompliancePacks, blockedIndivTax, blockedCompanyTax,
            kbUnderReview, sopUnderReview, riskAwaitingAcceptance,
            billingAwaitingApproval,
        ] = await Promise.all([
            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', riskCriticalMin),
            supabase.from('practice_quality_findings').select('id, finding_title, review_id').eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'critical'),
            supabase.from('practice_quality_reviews').select('id, review_title').eq('company_id', cid).eq('status', 'failed'),

            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', riskHighMin).lt('inherent_risk', riskCriticalMin),
            supabase.from('practice_quality_findings').select('id, finding_title, review_id').eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'high'),

            supabase.from('practice_tasks').select('id, title').eq('company_id', cid).in('status', ['open', 'in_progress']).lt('due_date', today).limit(20),
            supabase.from('practice_reminders').select('id, reminder_type, due_date').eq('company_id', cid).in('status', ['open', 'snoozed']).lt('due_date', reminderOverdueCutoff).limit(20),
            supabase.from('practice_document_requests').select('id, document_category, required_by_date').eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received']).lt('required_by_date', documentOverdueCutoff).limit(20),
            supabase.from('practice_deadlines').select('id, title, due_date').eq('company_id', cid).in('status', ['open', 'pending', 'in_progress', 'waiting_client', 'waiting_review']).lt('due_date', deadlineOverdueCutoff).limit(20),

            supabase.from('practice_compliance_packs').select('id, pack_type').eq('company_id', cid).eq('readiness_status', 'blocked'),
            supabase.from('practice_individual_tax_returns').select('id').eq('company_id', cid).eq('readiness_status', 'blocked'),
            supabase.from('practice_company_tax_returns').select('id').eq('company_id', cid).eq('readiness_status', 'blocked'),

            supabase.from('practice_knowledge_articles').select('id, title').eq('company_id', cid).eq('status', 'under_review'),
            supabase.from('practice_sop_templates').select('id, title').eq('company_id', cid).eq('status', 'under_review'),
            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).eq('status', 'open').gte('inherent_risk', riskPartnerAcceptanceMin),

            supabase.from('practice_billing_packs').select('id, period_start, period_end').eq('company_id', cid).eq('status', 'reviewed'),
        ]);

        const alerts = [];
        const push = (severity, category, items, mapFn) => {
            (items.data || []).forEach(i => alerts.push({ severity, category, ...mapFn(i) }));
        };

        push('critical', 'risk',    criticalRisks,     r => ({ id: r.id, label: `Critical risk: ${r.title}`, score: r.inherent_risk }));
        push('critical', 'qms',     criticalFindings,  f => ({ id: f.id, label: `Critical finding: ${f.finding_title}` }));
        push('critical', 'qms',     failedReviews,     r => ({ id: r.id, label: `Failed review: ${r.review_title}` }));
        push('high',     'risk',    highRisks,         r => ({ id: r.id, label: `High risk: ${r.title}`, score: r.inherent_risk }));
        push('high',     'qms',     highFindings,      f => ({ id: f.id, label: `High-severity finding: ${f.finding_title}` }));

        push('overdue', 'tasks',      overdueTasks,          t => ({ id: t.id, label: `Overdue task: ${t.title}` }));
        push('overdue', 'reminders',  overdueReminders,      r => ({ id: r.id, label: `Overdue reminder: ${r.reminder_type}`, due: r.due_date }));
        push('overdue', 'documents',  overdueDocs,           d => ({ id: d.id, label: `Overdue document request: ${d.document_category}`, due: d.required_by_date }));
        push('overdue', 'compliance', overdueDeadlines,      d => ({ id: d.id, label: `Overdue deadline: ${d.title}`, due: d.due_date }));

        push('blocked', 'compliance', blockedCompliancePacks, p => ({ id: p.id, label: `Blocked compliance pack: ${p.pack_type}` }));
        push('blocked', 'tax',        blockedIndivTax,        r => ({ id: r.id, label: `Blocked individual tax return #${r.id}` }));
        push('blocked', 'tax',        blockedCompanyTax,      r => ({ id: r.id, label: `Blocked company tax return #${r.id}` }));

        push('needs_partner', 'knowledge', kbUnderReview,          a => ({ id: a.id, label: `Knowledge article awaiting approval: ${a.title}` }));
        push('needs_partner', 'sop',       sopUnderReview,         s => ({ id: s.id, label: `SOP awaiting approval: ${s.title}` }));
        push('needs_partner', 'risk',      riskAwaitingAcceptance, r => ({ id: r.id, label: `Risk awaiting partner decision: ${r.title}`, score: r.inherent_risk }));

        push('requires_approval', 'billing', billingAwaitingApproval, p => ({ id: p.id, label: `Billing pack awaiting approval (${p.period_start || '—'} to ${p.period_end || '—'})` }));

        return { alerts, total: alerts.length };
}

router.get('/alerts', async (req, res) => {
    try {
        return res.json(await computeAlerts(req.companyId));
    } catch (err) {
        console.error('GET /api/practice/management-dashboard/alerts', err);
        return res.status(500).json({ error: 'Failed to load alerts.' });
    }
});

// ── GET /partner-review ────────────────────────────────────────────────────────
// Everything currently waiting on a partner decision.

async function computePartnerReview(cid) {
    // Codebox 53 — central rule for "which risks need partner acceptance".
    const rules = await getRules(cid, ['risk_partner_acceptance_min']);
    const riskPartnerAcceptanceMin = _effectiveMin(rules.risk_partner_acceptance_min);

    const [kb, sop, completion, qmsInReview, riskAccept, billingApproval] = await Promise.all([
        supabase.from('practice_knowledge_articles').select('id, title, category, updated_at').eq('company_id', cid).eq('status', 'under_review').order('updated_at', { ascending: true }),
        supabase.from('practice_sop_templates').select('id, title, category, updated_at').eq('company_id', cid).eq('status', 'under_review').order('updated_at', { ascending: true }),
        supabase.from('practice_tax_completion_packs').select('id, client_id, source_type, updated_at').eq('company_id', cid).eq('pack_status', 'review_pending').order('updated_at', { ascending: true }),
        supabase.from('practice_quality_reviews').select('id, review_title, review_type, updated_at').eq('company_id', cid).eq('status', 'in_review').order('updated_at', { ascending: true }),
        supabase.from('practice_risks').select('id, title, category, inherent_risk, updated_at').eq('company_id', cid).eq('status', 'open').gte('inherent_risk', riskPartnerAcceptanceMin).order('inherent_risk', { ascending: false }),
        supabase.from('practice_billing_packs').select('id, period_start, period_end, updated_at').eq('company_id', cid).eq('status', 'reviewed').order('updated_at', { ascending: true }),
    ]);

    return {
        knowledge_approvals: kb.data || [],
        sop_approvals:       sop.data || [],
        tax_completion:      completion.data || [],
        qms_reviews:         qmsInReview.data || [],
        risk_acceptance:     riskAccept.data || [],
        billing_approval:    billingApproval.data || [],
        total:
            (kb.data || []).length + (sop.data || []).length + (completion.data || []).length +
            (qmsInReview.data || []).length + (riskAccept.data || []).length + (billingApproval.data || []).length,
    };
}

router.get('/partner-review', async (req, res) => {
    try {
        return res.json(await computePartnerReview(req.companyId));
    } catch (err) {
        console.error('GET /api/practice/management-dashboard/partner-review', err);
        return res.status(500).json({ error: 'Failed to load partner review queue.' });
    }
});

// ── GET /practice-score ────────────────────────────────────────────────────────
// Deterministic weighted scoring. NO AI. Weights and penalties documented in
// docs/new-app/50_management_dashboard.md — keep this block as the single
// source of truth if weights are ever retuned.

const SCORE_WEIGHTS = { quality: 0.30, compliance: 0.25, risk: 0.20, capacity: 0.10, tax: 0.15 };

async function computePracticeScore(cid) {
    // Codebox 53 — central rules replace what used to be hardcoded here.
    const rules = await getRules(cid, [
        'risk_high_min', 'risk_critical_min', 'capacity_overloaded_ratio', 'compliance_deadline_overdue_grace_days',
    ]);
    const riskHighMin = _effectiveMin(rules.risk_high_min);
    const riskCriticalMin = _effectiveMin(rules.risk_critical_min);
    const capacityOverloadedRatio = rules.capacity_overloaded_ratio.enabled !== false ? Number(rules.capacity_overloaded_ratio.threshold_value) : Infinity;
    const deadlineOverdueCutoff = _daysFromNow(-_effectiveDays(rules.compliance_deadline_overdue_grace_days, 0));

    const today = _today();

    const [
            failedReviews, criticalFindings, highFindings, mediumFindings, lowFindings,
            overdueDeadlines, blockedCompliancePacks, missedDeadlines,
            criticalRisks, highRisks, otherOpenRisks,
            teamCapacityRows, openTaskHoursRows,
            paymentsOutstanding, sarsUnmatched, openDisputes,
        ] = await Promise.all([
            _count('practice_quality_reviews', q => q.eq('company_id', cid).eq('status', 'failed')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'critical')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'high')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'medium')),
            _count('practice_quality_findings', q => q.eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'low')),
            _count('practice_deadlines', q => q.eq('company_id', cid).in('status', ['open', 'pending', 'in_progress', 'waiting_client', 'waiting_review']).lt('due_date', deadlineOverdueCutoff)),
            _count('practice_compliance_packs', q => q.eq('company_id', cid).eq('readiness_status', 'blocked')),
            _count('practice_deadlines', q => q.eq('company_id', cid).eq('status', 'missed')),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', riskCriticalMin)),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', riskHighMin).lt('inherent_risk', riskCriticalMin)),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').lt('inherent_risk', riskHighMin)),
            supabase.from('practice_team_members').select('id, weekly_capacity_hours').eq('company_id', cid).eq('is_active', true).eq('capacity_is_active', true),
            supabase.from('practice_tasks').select('assigned_to, estimated_hours').eq('company_id', cid).in('status', ['open', 'in_progress']),
            _count('practice_tax_payments', q => q.eq('company_id', cid).eq('direction', 'payable').in('status', ['outstanding', 'partially_paid'])),
            _count('practice_sars_statement_lines', q => q.eq('company_id', cid).in('reconciliation_status', ['unmatched', 'disputed'])),
            _count('practice_tax_dispute_cases', q => q.eq('company_id', cid).not('case_status', 'in', '("completed","cancelled")')),
        ]);

        // Quality: -15/failed review, -10/critical finding, -5/high, -2/medium, -1/low
        const qualityScore = _clamp(100
            - failedReviews * 15 - criticalFindings * 10 - highFindings * 5
            - mediumFindings * 2 - lowFindings * 1, 0, 100);

        // Compliance: -8/overdue deadline, -10/blocked compliance pack, -15/missed deadline
        const complianceScore = _clamp(100
            - overdueDeadlines * 8 - blockedCompliancePacks * 10 - missedDeadlines * 15, 0, 100);

        // Risk: -15/critical risk, -8/high risk, -2/other open risk
        const riskScore = _clamp(100
            - criticalRisks * 15 - highRisks * 8 - otherOpenRisks * 2, 0, 100);

        // Capacity: -20/over-capacity staff member, -0.5 per point of avg utilization over 100%
        const capacityByMember = {};
        (teamCapacityRows.data || []).forEach(m => { capacityByMember[m.id] = { weekly: Number(m.weekly_capacity_hours) || 0, assigned: 0 }; });
        (openTaskHoursRows.data || []).forEach(t => {
            if (t.assigned_to != null && capacityByMember[t.assigned_to]) {
                capacityByMember[t.assigned_to].assigned += Number(t.estimated_hours) || 0;
            }
        });
        const members = Object.values(capacityByMember).filter(m => m.weekly > 0);
        const overCapacityCount = members.filter(m => (m.assigned / m.weekly) > capacityOverloadedRatio).length;
        const avgUtilizationPct = members.length
            ? (members.reduce((s, m) => s + (m.assigned / m.weekly), 0) / members.length) * 100
            : 0;
        const capacityScore = _clamp(100
            - overCapacityCount * 20 - Math.max(0, avgUtilizationPct - 100) * 0.5, 0, 100);

        // Tax: -3/outstanding payable payment, -2/unmatched SARS line, -5/open dispute
        const taxScore = _clamp(100
            - paymentsOutstanding * 3 - sarsUnmatched * 2 - openDisputes * 5, 0, 100);

        const overall = Math.round(
            qualityScore    * SCORE_WEIGHTS.quality +
            complianceScore * SCORE_WEIGHTS.compliance +
            riskScore       * SCORE_WEIGHTS.risk +
            capacityScore   * SCORE_WEIGHTS.capacity +
            taxScore        * SCORE_WEIGHTS.tax
        );

        return {
            overall_score: overall,
            weights: SCORE_WEIGHTS,
            scores: {
                quality:    Math.round(qualityScore),
                compliance: Math.round(complianceScore),
                risk:       Math.round(riskScore),
                capacity:   Math.round(capacityScore),
                tax:        Math.round(taxScore),
            },
            method: 'deterministic_weighted_penalties',
        };
}

router.get('/practice-score', async (req, res) => {
    try {
        return res.json(await computePracticeScore(req.companyId));
    } catch (err) {
        console.error('GET /api/practice/management-dashboard/practice-score', err);
        return res.status(500).json({ error: 'Failed to calculate practice score.' });
    }
});

module.exports = router;

// Codebox 51 (KPI History) calls these directly — attached to the exported
// router function object so `require('./management-dashboard').computeSummary(cid)`
// works without a second HTTP round-trip and without duplicating any KPI logic.
module.exports.computeSummary = computeSummary;
module.exports.computeAlerts = computeAlerts;
module.exports.computePartnerReview = computePartnerReview;
module.exports.computePracticeScore = computePracticeScore;
module.exports.computeExecutiveFeed = computeExecutiveFeed;
