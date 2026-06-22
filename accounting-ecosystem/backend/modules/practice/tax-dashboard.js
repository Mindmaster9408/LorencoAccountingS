// Practice Tax Work Dashboard — Tax Season Command Center (Codebox 34)
// 5 endpoints aggregating tax-module data into one command center view.
// All routes scoped by req.companyId from JWT — no cross-tenant leakage.
// Read-only. No audit tables. No mutation. No SARS/eFiling. No Sean AI.
'use strict';

const express  = require('express');
const router   = express.Router();
const { supabase } = require('../../config/database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today()         { return new Date().toISOString().split('T')[0]; }
function daysFromNow(n)  { return new Date(Date.now() + n * 86400000).toISOString().split('T')[0]; }
function clientName(c)   { return (c?.display_name || c?.company_name || '—'); }

// ─── GET /summary ─────────────────────────────────────────────────────────────
// 12 KPI counts for the command-centre header cards.
// All transparent DB COUNT queries — no AI scoring, no heuristics.

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    const t   = today();
    const d14 = daysFromNow(14);

    try {
        const [
            indTotal, indReady, indRevPacks,
            coTotal,  coReady,  coRevPacks,
            provTotal, provDue,
            taxOverdue, docsOut,
            indCalcPending, coCalcPending,
        ] = await Promise.all([
            supabase.from('practice_individual_tax_returns')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_individual_tax_returns')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('readiness_status', 'ready')
                .not('status', 'in', '(completed,cancelled,submitted)'),
            supabase.from('practice_individual_tax_review_packs')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('pack_status', 'ready_for_review'),

            supabase.from('practice_company_tax_returns')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_company_tax_returns')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('readiness_status', 'ready')
                .not('status', 'in', '(completed,cancelled)'),
            supabase.from('practice_company_tax_review_packs')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('pack_status', 'ready_for_review'),

            supabase.from('practice_provisional_tax_plans')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_provisional_tax_periods')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid)
                .in('status', ['not_started', 'in_progress'])
                .not('due_date', 'is', null)
                .gte('due_date', t).lte('due_date', d14),

            supabase.from('practice_deadlines')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid)
                .not('status', 'in', '(completed,submitted,missed,cancelled)')
                .lt('due_date', t),
            supabase.from('practice_document_requests')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid)
                .in('request_status', ['requested', 'reminder_sent', 'partially_received']),

            supabase.from('practice_individual_tax_calculations')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('calculation_status', 'ready_for_review'),
            supabase.from('practice_company_tax_calculations')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('calculation_status', 'ready_for_review'),
        ]);

        res.json({
            individual_returns_total:           indTotal.count    || 0,
            individual_returns_ready:           indReady.count    || 0,
            individual_returns_review_pending:  indRevPacks.count || 0,
            company_returns_total:              coTotal.count     || 0,
            company_returns_ready:              coReady.count     || 0,
            company_returns_review_pending:     coRevPacks.count  || 0,
            provisional_plans_total:            provTotal.count   || 0,
            provisional_due_soon:               provDue.count     || 0,
            tax_deadlines_overdue:              taxOverdue.count  || 0,
            documents_outstanding:              docsOut.count     || 0,
            review_packs_pending:               (indRevPacks.count || 0) + (coRevPacks.count || 0),
            draft_calculations_pending_review:  (indCalcPending.count || 0) + (coCalcPending.count || 0),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /workload ─────────────────────────────────────────────────────────────
// Per-team-member breakdown: returns owned, packs to review, overdue items.
// Bulk-fetches all returns then aggregates in JS — avoids N+1 per member.

router.get('/workload', async (req, res) => {
    const cid = req.companyId;
    const t   = today();

    try {
        const [
            membersRes,
            indReturnsRes, coReturnsRes, provPlansRes,
            // Pack review attribution: use return's reviewer_team_member_id
            indPacksRes, coPacksRes,
            indReturnsRevRes, coReturnsRevRes,
            deadlinesRes, docsRes,
        ] = await Promise.all([
            supabase.from('practice_team_members')
                .select('id, display_name, role')
                .eq('company_id', cid).eq('is_active', true).order('display_name'),

            supabase.from('practice_individual_tax_returns')
                .select('id, responsible_team_member_id')
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_company_tax_returns')
                .select('id, responsible_team_member_id')
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_provisional_tax_plans')
                .select('id, responsible_team_member_id')
                .eq('company_id', cid).neq('status', 'cancelled'),

            // Packs in ready_for_review — with return_id so we can look up reviewer
            supabase.from('practice_individual_tax_review_packs')
                .select('tax_return_id')
                .eq('company_id', cid).eq('pack_status', 'ready_for_review'),
            supabase.from('practice_company_tax_review_packs')
                .select('company_tax_return_id')
                .eq('company_id', cid).eq('pack_status', 'ready_for_review'),

            // Return reviewer lookup for pack attribution
            supabase.from('practice_individual_tax_returns')
                .select('id, reviewer_team_member_id')
                .eq('company_id', cid).neq('status', 'cancelled'),
            supabase.from('practice_company_tax_returns')
                .select('id, reviewer_team_member_id')
                .eq('company_id', cid).neq('status', 'cancelled'),

            supabase.from('practice_deadlines')
                .select('id, responsible_team_member_id')
                .eq('company_id', cid)
                .not('status', 'in', '(completed,submitted,missed,cancelled)')
                .lt('due_date', t),
            supabase.from('practice_document_requests')
                .select('id, assigned_team_member_id')
                .eq('company_id', cid)
                .in('request_status', ['requested', 'reminder_sent', 'partially_received']),
        ]);

        // Build reviewer maps for packs
        const indRetViewerMap = {};
        (indReturnsRevRes.data || []).forEach(r => { indRetViewerMap[r.id] = r.reviewer_team_member_id; });
        const coRetViewerMap  = {};
        (coReturnsRevRes.data  || []).forEach(r => { coRetViewerMap[r.id]  = r.reviewer_team_member_id; });

        const members = membersRes.data || [];
        const map = {};
        members.forEach(m => {
            map[m.id] = {
                team_member_id:           m.id,
                display_name:             m.display_name,
                role:                     m.role,
                individual_returns_owned: 0,
                company_returns_owned:    0,
                provisional_plans_owned:  0,
                review_packs_pending:     0,
                overdue_tax_deadlines:    0,
                outstanding_documents:    0,
                total_tax_items:          0,
            };
        });

        (indReturnsRes.data || []).forEach(r => {
            if (r.responsible_team_member_id && map[r.responsible_team_member_id])
                map[r.responsible_team_member_id].individual_returns_owned++;
        });
        (coReturnsRes.data || []).forEach(r => {
            if (r.responsible_team_member_id && map[r.responsible_team_member_id])
                map[r.responsible_team_member_id].company_returns_owned++;
        });
        (provPlansRes.data || []).forEach(r => {
            if (r.responsible_team_member_id && map[r.responsible_team_member_id])
                map[r.responsible_team_member_id].provisional_plans_owned++;
        });

        // Attribute review packs to the underlying return's reviewer
        (indPacksRes.data || []).forEach(p => {
            const reviewer = indRetViewerMap[p.tax_return_id];
            if (reviewer && map[reviewer]) map[reviewer].review_packs_pending++;
        });
        (coPacksRes.data || []).forEach(p => {
            const reviewer = coRetViewerMap[p.company_tax_return_id];
            if (reviewer && map[reviewer]) map[reviewer].review_packs_pending++;
        });

        (deadlinesRes.data || []).forEach(d => {
            if (d.responsible_team_member_id && map[d.responsible_team_member_id])
                map[d.responsible_team_member_id].overdue_tax_deadlines++;
        });
        (docsRes.data || []).forEach(d => {
            if (d.assigned_team_member_id && map[d.assigned_team_member_id])
                map[d.assigned_team_member_id].outstanding_documents++;
        });

        const workload = Object.values(map).map(m => {
            m.total_tax_items = m.individual_returns_owned + m.company_returns_owned +
                m.provisional_plans_owned + m.review_packs_pending +
                m.overdue_tax_deadlines + m.outstanding_documents;
            return m;
        }).sort((a, b) => b.total_tax_items - a.total_tax_items);

        res.json({ workload });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /risk ────────────────────────────────────────────────────────────────
// Returns risk lists for the command-centre risk panels.
// Transparent counts only — no AI scoring, no invented heuristics.

router.get('/risk', async (req, res) => {
    const cid = req.companyId;
    const t   = today();
    const d7  = daysFromNow(7);

    try {
        const [
            overdueRes,
            indBlockedRes, coBlockedRes,
            indCalcsRes,   coCalcsRes,
            provDueRes,
            docsClientsRes,
            indPackRejRes,  coPackRejRes,
        ] = await Promise.all([
            // Overdue deadlines with client name + client_id (needed by action modal)
            supabase.from('practice_deadlines')
                .select('id, title, due_date, status, deadline_type, client_id, clients:practice_clients!client_id(display_name, company_name)')
                .eq('company_id', cid)
                .not('status', 'in', '(completed,submitted,missed,cancelled)')
                .lt('due_date', t).order('due_date').limit(20),

            // Individual returns: blocked readiness — client_id for action modal
            supabase.from('practice_individual_tax_returns')
                .select('id, return_name, tax_year, client_id, clients:practice_clients!client_id(display_name, company_name)')
                .eq('company_id', cid).eq('readiness_status', 'blocked')
                .not('status', 'in', '(completed,cancelled,submitted)').limit(20),

            // Company returns: blocked readiness — client_id for action modal
            supabase.from('practice_company_tax_returns')
                .select('id, return_name, tax_year, client_id, clients:practice_clients!client_id(display_name, company_name)')
                .eq('company_id', cid).eq('readiness_status', 'blocked')
                .not('status', 'in', '(completed,cancelled)').limit(20),

            // Individual calcs not approved/cancelled — filter extra warnings in JS
            supabase.from('practice_individual_tax_calculations')
                .select('id, calculation_name, calculation_status, warning_flags')
                .eq('company_id', cid)
                .not('calculation_status', 'in', '(approved,cancelled)').limit(100),

            // Company calcs not approved/cancelled
            supabase.from('practice_company_tax_calculations')
                .select('id, calculation_name, calculation_status, warning_flags')
                .eq('company_id', cid)
                .not('calculation_status', 'in', '(approved,cancelled)').limit(100),

            // Provisional periods due within 7 days
            supabase.from('practice_provisional_tax_periods')
                .select('id, period_type, due_date, status, plan_id')
                .eq('company_id', cid)
                .in('status', ['not_started', 'in_progress'])
                .not('due_date', 'is', null)
                .gte('due_date', t).lte('due_date', d7).order('due_date').limit(20),

            // Unique client_ids with outstanding doc requests
            supabase.from('practice_document_requests')
                .select('client_id')
                .eq('company_id', cid)
                .in('request_status', ['requested', 'reminder_sent', 'partially_received']),

            // Rejected review packs — individual
            supabase.from('practice_individual_tax_review_packs')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('pack_status', 'rejected'),

            // Rejected review packs — company
            supabase.from('practice_company_tax_review_packs')
                .select('id', { count: 'exact', head: true })
                .eq('company_id', cid).eq('pack_status', 'rejected'),
        ]);

        // Calcs with >2 warning flags (DRAFT + RATE are always present — >2 = extra flags)
        const indWithExtra = (indCalcsRes.data || []).filter(c =>
            Array.isArray(c.warning_flags) && c.warning_flags.length > 2
        );
        const coWithExtra = (coCalcsRes.data || []).filter(c =>
            Array.isArray(c.warning_flags) && c.warning_flags.length > 2
        );

        const uniqueDocClients = new Set((docsClientsRes.data || []).map(d => d.client_id)).size;

        const blockedReturns = [
            ...(indBlockedRes.data || []).map(r => ({
                id: r.id, source_type: 'individual', return_name: r.return_name,
                tax_year: r.tax_year, client_name: clientName(r.clients), client_id: r.client_id || null,
            })),
            ...(coBlockedRes.data || []).map(r => ({
                id: r.id, source_type: 'company', return_name: r.return_name,
                tax_year: r.tax_year, client_name: clientName(r.clients), client_id: r.client_id || null,
            })),
        ];

        res.json({
            overdue_tax_deadlines: (overdueRes.data || []).map(d => ({
                id: d.id, title: d.title, due_date: d.due_date,
                status: d.status, deadline_type: d.deadline_type,
                client_id: d.client_id || null,
                client_name: clientName(d.clients),
                days_overdue: Math.ceil((new Date(t) - new Date(d.due_date)) / 86400000),
            })),
            returns_with_blocked_readiness: blockedReturns,
            calculations_with_extra_warnings_count: indWithExtra.length + coWithExtra.length,
            calculations_with_extra_warnings: [
                ...indWithExtra.slice(0, 10).map(c => ({ ...c, source_type: 'individual' })),
                ...coWithExtra.slice(0, 10).map(c => ({ ...c, source_type: 'company' })),
            ],
            provisional_plans_near_due: (provDueRes.data || []).map(p => ({
                id: p.id, period_type: p.period_type, due_date: p.due_date,
                status: p.status, plan_id: p.plan_id,
                days_until: Math.ceil((new Date(p.due_date) - new Date(t)) / 86400000),
            })),
            tax_clients_missing_documents: uniqueDocClients,
            review_packs_rejected: (indPackRejRes.count || 0) + (coPackRejRes.count || 0),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /activity ────────────────────────────────────────────────────────────
// Merges the latest events from all 8 tax event tables; returns top 30 sorted.

router.get('/activity', async (req, res) => {
    const cid = req.companyId;

    const SOURCE_LABELS = [
        'Individual Tax', 'Individual Calculation', 'Individual Review Pack',
        'Company Tax',    'Company Calculation',    'Company Review Pack',
        'Provisional Tax', 'Compliance Pack',
    ];

    try {
        const results = await Promise.all([
            supabase.from('practice_individual_tax_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_individual_tax_calculation_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_individual_tax_review_pack_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_company_tax_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_company_tax_calculation_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_company_tax_review_pack_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_provisional_tax_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
            supabase.from('practice_compliance_pack_events')
                .select('id, event_type, created_at').eq('company_id', cid)
                .order('created_at', { ascending: false }).limit(8),
        ]);

        const combined = [];
        results.forEach((r, i) => {
            (r.data || []).forEach(e => {
                combined.push({ source: SOURCE_LABELS[i], event_type: e.event_type, created_at: e.created_at });
            });
        });

        combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ activity: combined.slice(0, 30) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /returns ─────────────────────────────────────────────────────────────
// Combined list of individual returns, company returns, and provisional plans.
// Fetches from all 3 tables in parallel, enriches with latest calc/pack status,
// merges, filters, sorts, and paginates in JS.
// outstanding_documents_count is aggregate-only — not computed per-row for perf.

router.get('/returns', async (req, res) => {
    const cid = req.companyId;
    const {
        tax_year, return_type, status, readiness_status,
        assigned_team_member_id, review_status,
        page: rawPage = 1, limit: rawLimit = 50,
    } = req.query;

    const limit  = Math.min(parseInt(rawLimit) || 50, 200);
    const offset = (Math.max(parseInt(rawPage) || 1, 1) - 1) * limit;
    const tmId   = assigned_team_member_id ? parseInt(assigned_team_member_id) : null;

    const wantInd  = !return_type || return_type === 'individual';
    const wantCo   = !return_type || return_type === 'company';
    const wantProv = !return_type || return_type === 'provisional';

    function buildIndQ() {
        let q = supabase.from('practice_individual_tax_returns')
            .select('id, return_name, tax_year, status, readiness_status, readiness_score, responsible_team_member_id, reviewer_team_member_id, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).neq('status', 'cancelled');
        if (tax_year)          q = q.eq('tax_year', parseInt(tax_year));
        if (status)            q = q.eq('status', status);
        if (readiness_status)  q = q.eq('readiness_status', readiness_status);
        if (tmId)              q = q.or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`);
        return q.limit(400);
    }

    function buildCoQ() {
        let q = supabase.from('practice_company_tax_returns')
            .select('id, return_name, tax_year, status, readiness_status, readiness_score, responsible_team_member_id, reviewer_team_member_id, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).neq('status', 'cancelled');
        if (tax_year)          q = q.eq('tax_year', parseInt(tax_year));
        if (status)            q = q.eq('status', status);
        if (readiness_status)  q = q.eq('readiness_status', readiness_status);
        if (tmId)              q = q.or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`);
        return q.limit(400);
    }

    function buildProvQ() {
        let q = supabase.from('practice_provisional_tax_plans')
            .select('id, plan_name, tax_year, status, responsible_team_member_id, reviewer_team_member_id, period_1_due_date, period_2_due_date, topup_due_date, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).neq('status', 'cancelled');
        if (tax_year) q = q.eq('tax_year', parseInt(tax_year));
        if (status)   q = q.eq('status', status);
        if (tmId)     q = q.or(`responsible_team_member_id.eq.${tmId},reviewer_team_member_id.eq.${tmId}`);
        return q.limit(400);
    }

    try {
        const [indRes, coRes, provRes, indCalcRes, coCalcRes, indPackRes, coPackRes] =
            await Promise.all([
                wantInd  ? buildIndQ()  : Promise.resolve({ data: [] }),
                wantCo   ? buildCoQ()   : Promise.resolve({ data: [] }),
                wantProv ? buildProvQ() : Promise.resolve({ data: [] }),
                // Latest calcs — ordered by version DESC so first-seen per return_id = latest
                supabase.from('practice_individual_tax_calculations')
                    .select('tax_return_id, calculation_status, warning_flags, calculation_version')
                    .eq('company_id', cid).neq('calculation_status', 'cancelled')
                    .order('calculation_version', { ascending: false }),
                supabase.from('practice_company_tax_calculations')
                    .select('company_tax_return_id, calculation_status, warning_flags, calculation_version')
                    .eq('company_id', cid).neq('calculation_status', 'cancelled')
                    .order('calculation_version', { ascending: false }),
                // Latest packs — first-seen per return_id = latest
                supabase.from('practice_individual_tax_review_packs')
                    .select('tax_return_id, pack_status')
                    .eq('company_id', cid).neq('pack_status', 'cancelled')
                    .order('created_at', { ascending: false }),
                supabase.from('practice_company_tax_review_packs')
                    .select('company_tax_return_id, pack_status')
                    .eq('company_id', cid).neq('pack_status', 'cancelled')
                    .order('created_at', { ascending: false }),
            ]);

        // Build first-seen maps (= latest version/pack per return)
        const indCalcMap = {};
        (indCalcRes.data || []).forEach(c => { if (!indCalcMap[c.tax_return_id])          indCalcMap[c.tax_return_id]          = c; });
        const coCalcMap  = {};
        (coCalcRes.data  || []).forEach(c => { if (!coCalcMap[c.company_tax_return_id])   coCalcMap[c.company_tax_return_id]   = c; });
        const indPackMap = {};
        (indPackRes.data || []).forEach(p => { if (!indPackMap[p.tax_return_id])          indPackMap[p.tax_return_id]          = p; });
        const coPackMap  = {};
        (coPackRes.data  || []).forEach(p => { if (!coPackMap[p.company_tax_return_id])   coPackMap[p.company_tax_return_id]   = p; });

        const rows = [];

        (indRes.data || []).forEach(r => {
            const calc = indCalcMap[r.id] || null;
            const pack = indPackMap[r.id] || null;
            rows.push({
                source_type:                  'individual',
                source_id:                    r.id,
                return_name:                  r.return_name,
                tax_year:                     r.tax_year,
                status:                       r.status,
                readiness_status:             r.readiness_status || 'unknown',
                readiness_score:              r.readiness_score,
                responsible_team_member_id:   r.responsible_team_member_id,
                reviewer_team_member_id:      r.reviewer_team_member_id,
                client_name:                  clientName(r.clients),
                latest_calculation_status:    calc?.calculation_status || null,
                latest_review_pack_status:    pack?.pack_status        || null,
                warning_flags_count:          Array.isArray(calc?.warning_flags) ? calc.warning_flags.length : 0,
                next_due_date:                null,
            });
        });

        (coRes.data || []).forEach(r => {
            const calc = coCalcMap[r.id] || null;
            const pack = coPackMap[r.id] || null;
            rows.push({
                source_type:                  'company',
                source_id:                    r.id,
                return_name:                  r.return_name,
                tax_year:                     r.tax_year,
                status:                       r.status,
                readiness_status:             r.readiness_status || 'unknown',
                readiness_score:              r.readiness_score,
                responsible_team_member_id:   r.responsible_team_member_id,
                reviewer_team_member_id:      r.reviewer_team_member_id,
                client_name:                  clientName(r.clients),
                latest_calculation_status:    calc?.calculation_status || null,
                latest_review_pack_status:    pack?.pack_status        || null,
                warning_flags_count:          Array.isArray(calc?.warning_flags) ? calc.warning_flags.length : 0,
                next_due_date:                null,
            });
        });

        (provRes.data || []).forEach(r => {
            const nextDue = [r.period_1_due_date, r.period_2_due_date, r.topup_due_date]
                .filter(Boolean).sort()[0] || null;
            rows.push({
                source_type:                  'provisional',
                source_id:                    r.id,
                return_name:                  r.plan_name,
                tax_year:                     r.tax_year,
                status:                       r.status,
                readiness_status:             null,
                readiness_score:              null,
                responsible_team_member_id:   r.responsible_team_member_id,
                reviewer_team_member_id:      r.reviewer_team_member_id,
                client_name:                  clientName(r.clients),
                latest_calculation_status:    null,
                latest_review_pack_status:    null,
                warning_flags_count:          0,
                next_due_date:                nextDue,
            });
        });

        // Apply review_status filter (JS-side)
        let filtered = rows;
        if (review_status) {
            filtered = rows.filter(r =>
                r.latest_review_pack_status === review_status ||
                r.latest_calculation_status === review_status
            );
        }

        // Sort: tax_year DESC, then client_name
        filtered.sort((a, b) => {
            if ((b.tax_year || 0) !== (a.tax_year || 0)) return (b.tax_year || 0) - (a.tax_year || 0);
            return a.client_name.localeCompare(b.client_name);
        });

        const total   = filtered.length;
        const pageNum = Math.max(parseInt(rawPage) || 1, 1);
        res.json({ returns: filtered.slice(offset, offset + limit), total, page: pageNum, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
