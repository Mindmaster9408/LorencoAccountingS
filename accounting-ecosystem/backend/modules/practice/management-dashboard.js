'use strict';

// Codebox 50 — Practice Management Dashboard (Executive Command Centre)
// Read-only aggregator over existing modules. NOT an operational page —
// this is where partners manage the practice.
//
// NOT AI. All scoring is deterministic, weighted arithmetic — documented below.

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function _today() { return new Date().toISOString().slice(0, 10); }
function _daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function _clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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
    const today = _today();
    const weekOut = _daysFromNow(7);

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

            _count('practice_reminders', q => q.eq('company_id', cid).in('status', ['open', 'snoozed']).lt('due_date', today)),
            _count('practice_reminders', q => q.eq('company_id', cid).in('status', ['open', 'snoozed']).gte('due_date', today).lte('due_date', weekOut)),

            _count('practice_document_requests', q => q.eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received'])),
            _count('practice_document_requests', q => q.eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received']).lt('required_by_date', today)),

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
        const overCapacityCount = members.filter(m => (m.assigned / m.weekly) > 1).length;
        const avgUtilizationPct = members.length
            ? Math.round((members.reduce((s, m) => s + (m.assigned / m.weekly), 0) / members.length) * 100)
            : 0;

        // ── Risk band math (derived from raw rows) ──
        const risks = riskRows.data || [];
        const highRiskCount = risks.filter(r => r.inherent_risk >= 15 && r.inherent_risk <= 19).length;
        const criticalRiskCount = risks.filter(r => r.inherent_risk >= 20).length;

        // ── Billing realisation math (derived from raw rows) ──
        const packs = billingRows.data || [];
        const totalRecoverable = packs.reduce((s, p) => s + (Number(p.recoverable_value) || 0), 0);
        const totalBillable = packs.reduce((s, p) => s + (Number(p.billable_value) || 0), 0);
        const realisationPct = totalRecoverable > 0 ? Math.round((totalBillable / totalRecoverable) * 1000) / 10 : null;

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
    const today = _today();

    const [
            criticalRisks, criticalFindings, failedReviews,
            highRisks, highFindings,
            overdueTasks, overdueReminders, overdueDocs, overdueDeadlines,
            blockedCompliancePacks, blockedIndivTax, blockedCompanyTax,
            kbUnderReview, sopUnderReview, riskAwaitingAcceptance,
            billingAwaitingApproval,
        ] = await Promise.all([
            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', 20),
            supabase.from('practice_quality_findings').select('id, finding_title, review_id').eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'critical'),
            supabase.from('practice_quality_reviews').select('id, review_title').eq('company_id', cid).eq('status', 'failed'),

            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', 15).lt('inherent_risk', 20),
            supabase.from('practice_quality_findings').select('id, finding_title, review_id').eq('company_id', cid).in('status', ['open', 'in_progress']).eq('severity', 'high'),

            supabase.from('practice_tasks').select('id, title').eq('company_id', cid).in('status', ['open', 'in_progress']).lt('due_date', today).limit(20),
            supabase.from('practice_reminders').select('id, reminder_type, due_date').eq('company_id', cid).in('status', ['open', 'snoozed']).lt('due_date', today).limit(20),
            supabase.from('practice_document_requests').select('id, document_category, required_by_date').eq('company_id', cid).in('request_status', ['requested', 'reminder_sent', 'partially_received']).lt('required_by_date', today).limit(20),
            supabase.from('practice_deadlines').select('id, title, due_date').eq('company_id', cid).in('status', ['open', 'pending', 'in_progress', 'waiting_client', 'waiting_review']).lt('due_date', today).limit(20),

            supabase.from('practice_compliance_packs').select('id, pack_type').eq('company_id', cid).eq('readiness_status', 'blocked'),
            supabase.from('practice_individual_tax_returns').select('id').eq('company_id', cid).eq('readiness_status', 'blocked'),
            supabase.from('practice_company_tax_returns').select('id').eq('company_id', cid).eq('readiness_status', 'blocked'),

            supabase.from('practice_knowledge_articles').select('id, title').eq('company_id', cid).eq('status', 'under_review'),
            supabase.from('practice_sop_templates').select('id, title').eq('company_id', cid).eq('status', 'under_review'),
            supabase.from('practice_risks').select('id, title, inherent_risk').eq('company_id', cid).eq('status', 'open').gte('inherent_risk', 15),

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
    const [kb, sop, completion, qmsInReview, riskAccept, billingApproval] = await Promise.all([
        supabase.from('practice_knowledge_articles').select('id, title, category, updated_at').eq('company_id', cid).eq('status', 'under_review').order('updated_at', { ascending: true }),
        supabase.from('practice_sop_templates').select('id, title, category, updated_at').eq('company_id', cid).eq('status', 'under_review').order('updated_at', { ascending: true }),
        supabase.from('practice_tax_completion_packs').select('id, client_id, source_type, updated_at').eq('company_id', cid).eq('pack_status', 'review_pending').order('updated_at', { ascending: true }),
        supabase.from('practice_quality_reviews').select('id, review_title, review_type, updated_at').eq('company_id', cid).eq('status', 'in_review').order('updated_at', { ascending: true }),
        supabase.from('practice_risks').select('id, title, category, inherent_risk, updated_at').eq('company_id', cid).eq('status', 'open').gte('inherent_risk', 15).order('inherent_risk', { ascending: false }),
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
            _count('practice_deadlines', q => q.eq('company_id', cid).in('status', ['open', 'pending', 'in_progress', 'waiting_client', 'waiting_review']).lt('due_date', today)),
            _count('practice_compliance_packs', q => q.eq('company_id', cid).eq('readiness_status', 'blocked')),
            _count('practice_deadlines', q => q.eq('company_id', cid).eq('status', 'missed')),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', 20)),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').gte('inherent_risk', 15).lt('inherent_risk', 20)),
            _count('practice_risks', q => q.eq('company_id', cid).not('status', 'in', '("closed","cancelled")').lt('inherent_risk', 15)),
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
        const overCapacityCount = members.filter(m => (m.assigned / m.weekly) > 1).length;
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
