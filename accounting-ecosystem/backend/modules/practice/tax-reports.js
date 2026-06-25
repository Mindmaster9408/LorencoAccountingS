/**
 * ============================================================
 * Practice Tax Season Reports + Exports (Codeboxes 38 & 39)
 * ============================================================
 * Data endpoints (CB38):
 *   GET  /progress, /status-breakdown, /document-outstanding,
 *        /review-bottlenecks, /partner-summary,
 *        /bulk-operation-summary, /risk-summary
 *   POST /snapshots
 *
 * Export endpoints (CB39) — per report type:
 *   GET  /<report>/report-data   — same data as parent, with _meta
 *   GET  /<report>/report-html   — printable HTML (text/html)
 *   GET  /<report>/report-pdf    — streamed PDF (application/pdf)
 *   GET  /tax-season-pack/report-data — all 7 reports combined
 *   GET  /tax-season-pack/report-html — combined printable HTML
 *   GET  /tax-season-pack/report-pdf  — combined PDF (7 sections)
 *
 * NOT tax calculation. NOT SARS/eFiling. NOT AI.
 * ============================================================
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) { PDFDocument = null; }

router.use(authenticateToken);
router.use(requireCompany);

// ── Constants ─────────────────────────────────────────────────────────────────

const TAX_PACK_TYPES           = ['individual_tax', 'company_tax'];
const OUTSTANDING_DOC_STATUSES = ['requested', 'reminder_sent', 'partially_received'];
const COMPLETED_STATUSES       = ['completed', 'submitted', 'approved'];
const REVIEWED_STATUSES        = ['reviewed'];
const CANCELLED_STATUSES       = ['cancelled'];
const DEADLINE_EXCLUDE_STATUSES = '(completed,submitted,missed,cancelled)';

const SNAPSHOT_REPORT_TYPES = [
    'tax_season_progress', 'partner_summary', 'document_outstanding',
    'review_bottleneck', 'bulk_operation_summary', 'risk_summary',
];

function today() { return new Date().toISOString().slice(0, 10); }
function now()   { return new Date().toISOString(); }

function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('en-ZA'); } catch (e) { return String(iso); }
}

function fmtEntityType(t) {
    const map = {
        individual_return: 'Individual Return',
        company_return:    'Company Return',
        ind_review_pack:   'Ind. Review Pack',
        co_review_pack:    'Co. Review Pack',
    };
    return map[t] || (t ? t.replace(/_/g, ' ') : '—');
}

// ── Shared query helpers ──────────────────────────────────────────────────────

async function resolveClientIds(cid, clientType) {
    if (!clientType) return null;
    const { data } = await supabase.from('practice_clients')
        .select('id').eq('company_id', cid).eq('client_type', clientType).eq('is_active', true);
    return (data || []).map(c => c.id);
}

function applyReturnFilters(q, { tax_year, clientIds, responsible, reviewer }) {
    if (tax_year)  q = q.eq('tax_year', parseInt(tax_year));
    if (clientIds && clientIds.length) q = q.in('client_id', clientIds);
    if (responsible) q = q.eq('responsible_team_member_id', parseInt(responsible));
    if (reviewer)    q = q.eq('reviewer_team_member_id',    parseInt(reviewer));
    return q;
}

function countBy(arr, field) {
    const counts = {};
    for (const item of (arr || [])) {
        const v = item[field] || 'unknown';
        counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
}

function progressBucket(status, readiness) {
    if (CANCELLED_STATUSES.includes(status)) return 'cancelled';
    if (COMPLETED_STATUSES.includes(status)) return 'completed';
    if (REVIEWED_STATUSES.includes(status))  return 'reviewed';
    if (status === 'ready_for_review')        return 'ready_for_review';
    if (readiness === 'blocked')              return 'blocked';
    return 'in_progress';
}

async function fetchCompanyName(cid) {
    try {
        const { data } = await supabase.from('companies')
            .select('company_name, trading_name').eq('id', cid).single();
        return data ? (data.trading_name || data.company_name || 'Practice') : 'Practice';
    } catch (e) { return 'Practice'; }
}

function filterSummary(q) {
    const parts = [];
    if (q.tax_year)                   parts.push('Tax Year: ' + q.tax_year);
    if (q.client_type)                parts.push('Client Type: ' + q.client_type.replace(/_/g, ' '));
    if (q.responsible_team_member_id) parts.push('Responsible ID: ' + q.responsible_team_member_id);
    if (q.reviewer_team_member_id)    parts.push('Reviewer ID: ' + q.reviewer_team_member_id);
    return parts.length ? parts.join(' | ') : 'All clients, all years';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING FUNCTIONS (shared by data routes + export routes)
// ═══════════════════════════════════════════════════════════════════════════════

async function _dataProgress(cid, q) {
    const clientIds = await resolveClientIds(cid, q.client_type);
    if (clientIds && clientIds.length === 0)
        return { total: 0, completed: 0, reviewed: 0, ready_for_review: 0, in_progress: 0, blocked: 0, cancelled: 0, progress_percentage: 0 };

    const f = { tax_year: q.tax_year, clientIds, responsible: q.responsible_team_member_id, reviewer: q.reviewer_team_member_id };

    const [indRes, coRes, provRes, indPackRes, coPackRes, compPackRes] = await Promise.all([
        applyReturnFilters(supabase.from('practice_individual_tax_returns').select('status, readiness_status').eq('company_id', cid), f),
        applyReturnFilters(supabase.from('practice_company_tax_returns').select('status, readiness_status').eq('company_id', cid), f),
        applyReturnFilters(supabase.from('practice_provisional_tax_plans').select('status').eq('company_id', cid), f),
        (() => {
            let qt = supabase.from('practice_individual_tax_review_packs').select('pack_status').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_review_packs').select('pack_status').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_compliance_packs').select('status').eq('company_id', cid).in('pack_type', TAX_PACK_TYPES);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.responsible_team_member_id) qt = qt.eq('owner_team_member_id', parseInt(q.responsible_team_member_id));
            return qt;
        })(),
    ]);

    const buckets = { completed: 0, reviewed: 0, ready_for_review: 0, in_progress: 0, blocked: 0, cancelled: 0 };
    for (const r of ([...(indRes.data || []), ...(coRes.data || [])])) buckets[progressBucket(r.status, r.readiness_status)]++;
    for (const r of (provRes.data || []))                               buckets[progressBucket(r.status, null)]++;
    for (const r of ([...(indPackRes.data || []), ...(coPackRes.data || [])])) buckets[progressBucket(r.pack_status, null)]++;
    for (const r of (compPackRes.data || []))                           buckets[progressBucket(r.status, null)]++;

    const total    = Object.values(buckets).reduce((a, b) => a + b, 0);
    const done     = buckets.completed + buckets.reviewed;
    const progress = total > 0 ? parseFloat((done / total * 100).toFixed(1)) : 0;
    return { total, progress_percentage: progress, ...buckets };
}

async function _dataStatusBreakdown(cid, q) {
    const clientIds = await resolveClientIds(cid, q.client_type);
    if (clientIds && clientIds.length === 0)
        return { individual_by_status: {}, company_by_status: {}, provisional_by_status: {}, packs_by_status: {}, ind_review_packs_by_status: {}, co_review_packs_by_status: {} };

    const f = { tax_year: q.tax_year, clientIds, responsible: q.responsible_team_member_id, reviewer: q.reviewer_team_member_id };

    const [indRes, coRes, provRes, compPackRes, indPackRes, coPackRes] = await Promise.all([
        applyReturnFilters(supabase.from('practice_individual_tax_returns').select('status, readiness_status').eq('company_id', cid), f),
        applyReturnFilters(supabase.from('practice_company_tax_returns').select('status, readiness_status').eq('company_id', cid), f),
        applyReturnFilters(supabase.from('practice_provisional_tax_plans').select('status').eq('company_id', cid), f),
        (() => {
            let qt = supabase.from('practice_compliance_packs').select('status, pack_type').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.responsible_team_member_id) qt = qt.eq('owner_team_member_id', parseInt(q.responsible_team_member_id));
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_individual_tax_review_packs').select('pack_status').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_review_packs').select('pack_status').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt;
        })(),
    ]);

    return {
        individual_by_status:       countBy(indRes.data,      'status'),
        individual_by_readiness:    countBy(indRes.data,      'readiness_status'),
        company_by_status:          countBy(coRes.data,       'status'),
        company_by_readiness:       countBy(coRes.data,       'readiness_status'),
        provisional_by_status:      countBy(provRes.data,     'status'),
        packs_by_status:            countBy(compPackRes.data,  'status'),
        packs_by_type:              countBy(compPackRes.data,  'pack_type'),
        ind_review_packs_by_status: countBy(indPackRes.data,  'pack_status'),
        co_review_packs_by_status:  countBy(coPackRes.data,   'pack_status'),
    };
}

async function _dataDocOutstanding(cid, q) {
    const t = today();
    const clientIds = await resolveClientIds(cid, q.client_type);
    if (clientIds && clientIds.length === 0)
        return { total: 0, overdue: 0, by_client: [], by_category: [], by_team_member: [] };

    let docQ = supabase.from('practice_document_requests')
        .select('id, client_id, request_title, document_category, required_by_date, request_status')
        .eq('company_id', cid).in('request_status', OUTSTANDING_DOC_STATUSES);
    if (clientIds && clientIds.length) docQ = docQ.in('client_id', clientIds);

    let clientQ = supabase.from('practice_clients')
        .select('id, name, responsible_team_member_id').eq('company_id', cid).eq('is_active', true);
    if (clientIds && clientIds.length) clientQ = clientQ.in('id', clientIds);
    if (q.responsible_team_member_id) clientQ = clientQ.eq('responsible_team_member_id', parseInt(q.responsible_team_member_id));

    const [docRes, clientRes, teamRes] = await Promise.all([docQ, clientQ,
        supabase.from('practice_team_members').select('id, display_name').eq('company_id', cid).eq('is_active', true)]);

    const docs    = docRes.data    || [];
    const clients = clientRes.data || [];
    const members = teamRes.data   || [];
    const clientMap      = new Map(clients.map(c => [c.id, c]));
    const memberMap      = new Map(members.map(m => [m.id, m.display_name]));
    const validClientIds = new Set(clients.map(c => c.id));
    const filteredDocs   = q.responsible_team_member_id ? docs.filter(d => validClientIds.has(d.client_id)) : docs;
    const overdueCount   = filteredDocs.filter(d => d.required_by_date && d.required_by_date < t).length;

    const byClientMap = new Map();
    for (const doc of filteredDocs) {
        const cl = clientMap.get(doc.client_id);
        if (!byClientMap.has(doc.client_id))
            byClientMap.set(doc.client_id, { client_id: doc.client_id, client_name: cl ? cl.name : `Client #${doc.client_id}`, total: 0, overdue: 0 });
        const entry = byClientMap.get(doc.client_id);
        entry.total++;
        if (doc.required_by_date && doc.required_by_date < t) entry.overdue++;
    }

    const byCatMap = {};
    for (const doc of filteredDocs) { const cat = doc.document_category || 'other'; byCatMap[cat] = (byCatMap[cat] || 0) + 1; }

    const byMemberMap = new Map();
    for (const doc of filteredDocs) {
        const cl = clientMap.get(doc.client_id);
        const memberId = cl ? cl.responsible_team_member_id : null;
        const key = memberId || 0;
        if (!byMemberMap.has(key))
            byMemberMap.set(key, { team_member_id: memberId, team_member_name: memberId ? (memberMap.get(memberId) || `Member #${memberId}`) : 'Unassigned', total: 0, overdue: 0 });
        const entry = byMemberMap.get(key);
        entry.total++;
        if (doc.required_by_date && doc.required_by_date < t) entry.overdue++;
    }

    return {
        total:          filteredDocs.length,
        overdue:        overdueCount,
        by_client:      Array.from(byClientMap.values()).sort((a, b) => b.total - a.total).slice(0, 50),
        by_category:    Object.entries(byCatMap).map(([cat, count]) => ({ category: cat, count })).sort((a, b) => b.count - a.count),
        by_team_member: Array.from(byMemberMap.values()).sort((a, b) => b.total - a.total),
    };
}

async function _dataReviewBottlenecks(cid, q) {
    const [indReturnRes, coReturnRes, indPackRes, coPackRes, teamRes] = await Promise.all([
        (() => {
            let qt = supabase.from('practice_individual_tax_returns')
                .select('id, return_name, tax_year, client_id, reviewer_team_member_id, updated_at, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).eq('status', 'ready_for_review');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt.order('updated_at').limit(100);
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_returns')
                .select('id, return_name, tax_year, client_id, reviewer_team_member_id, updated_at, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).eq('status', 'ready_for_review');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt.order('updated_at').limit(100);
        })(),
        (() => {
            let qt = supabase.from('practice_individual_tax_review_packs')
                .select('id, pack_name, tax_year, client_id, reviewer_team_member_id, pack_status, updated_at, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).in('pack_status', ['ready_for_review', 'rejected']);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt.order('updated_at').limit(100);
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_review_packs')
                .select('id, pack_name, tax_year, client_id, reviewer_team_member_id, pack_status, updated_at, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).in('pack_status', ['ready_for_review', 'rejected']);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (q.reviewer_team_member_id) qt = qt.eq('reviewer_team_member_id', parseInt(q.reviewer_team_member_id));
            return qt.order('updated_at').limit(100);
        })(),
        supabase.from('practice_team_members').select('id, display_name').eq('company_id', cid).eq('is_active', true),
    ]);

    const memberMap  = new Map((teamRes.data || []).map(m => [m.id, m.display_name]));
    const allWaiting = [
        ...(indReturnRes.data || []).map(r => ({ ...r, entity_type: 'individual_return', name: r.return_name, client_name: r.clients?.name })),
        ...(coReturnRes.data  || []).map(r => ({ ...r, entity_type: 'company_return',   name: r.return_name, client_name: r.clients?.name })),
        ...(indPackRes.data   || []).filter(p => p.pack_status === 'ready_for_review').map(p => ({ ...p, entity_type: 'ind_review_pack', name: p.pack_name, client_name: p.clients?.name })),
        ...(coPackRes.data    || []).filter(p => p.pack_status === 'ready_for_review').map(p => ({ ...p, entity_type: 'co_review_pack',  name: p.pack_name, client_name: p.clients?.name })),
    ];
    const rejected = [
        ...(indPackRes.data || []).filter(p => p.pack_status === 'rejected').map(p => ({ ...p, entity_type: 'ind_review_pack', name: p.pack_name, client_name: p.clients?.name })),
        ...(coPackRes.data  || []).filter(p => p.pack_status === 'rejected').map(p => ({ ...p, entity_type: 'co_review_pack',  name: p.pack_name, client_name: p.clients?.name })),
    ];

    const byReviewerMap = new Map();
    for (const item of allWaiting) {
        const rid = item.reviewer_team_member_id || 0;
        if (!byReviewerMap.has(rid))
            byReviewerMap.set(rid, { reviewer_id: rid, reviewer_name: rid ? (memberMap.get(rid) || `Reviewer #${rid}`) : 'Unassigned', count: 0, oldest_date: null });
        const entry = byReviewerMap.get(rid);
        entry.count++;
        if (!entry.oldest_date || item.updated_at < entry.oldest_date) entry.oldest_date = item.updated_at;
    }

    return {
        items_waiting_review: allWaiting.length,
        rejected_items:       rejected.length,
        by_reviewer:          Array.from(byReviewerMap.values()).sort((a, b) => b.count - a.count),
        oldest_waiting_items: allWaiting.slice(0, 10).map(i => ({
            id: i.id, entity_type: i.entity_type, name: i.name, client_name: i.client_name, tax_year: i.tax_year,
            waiting_since: i.updated_at, reviewer_name: i.reviewer_team_member_id ? (memberMap.get(i.reviewer_team_member_id) || null) : null,
        })),
        rejected_items_list: rejected.slice(0, 20).map(i => ({
            id: i.id, entity_type: i.entity_type, name: i.name, client_name: i.client_name, tax_year: i.tax_year, updated_at: i.updated_at,
        })),
    };
}

async function _dataPartnerSummary(cid, q) {
    const clientIds = await resolveClientIds(cid, q.client_type);
    if (clientIds && clientIds.length === 0) return { summary: [] };

    const [teamRes, indRes, coRes, provRes, compPackRes, docRes, actionRes, deadlineRes, allClientsRes] = await Promise.all([
        supabase.from('practice_team_members').select('id, display_name').eq('company_id', cid).eq('is_active', true),
        (() => {
            let qt = supabase.from('practice_individual_tax_returns').select('client_id, status, responsible_team_member_id').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_returns').select('client_id, status, responsible_team_member_id').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_provisional_tax_plans').select('client_id, status, responsible_team_member_id').eq('company_id', cid);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_compliance_packs').select('client_id, status, owner_team_member_id').eq('company_id', cid).in('pack_type', TAX_PACK_TYPES);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_document_requests').select('client_id, request_status, required_by_date').eq('company_id', cid).in('request_status', OUTSTANDING_DOC_STATUSES);
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_tax_work_actions').select('client_id').eq('company_id', cid).eq('action_status', 'open');
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_deadlines').select('client_id').eq('company_id', cid)
                .not('status', 'in', DEADLINE_EXCLUDE_STATUSES).lt('due_date', today());
            if (clientIds && clientIds.length) qt = qt.in('client_id', clientIds);
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_clients').select('id, responsible_team_member_id').eq('company_id', cid).eq('is_active', true);
            if (clientIds && clientIds.length) qt = qt.in('id', clientIds);
            return qt;
        })(),
    ]);

    const members    = teamRes.data       || [];
    const allReturns = [...(indRes.data || []), ...(coRes.data || []), ...(provRes.data || [])];
    const packs      = compPackRes.data   || [];
    const outDocs    = docRes.data        || [];
    const openActs   = actionRes.data     || [];
    const overdueDl  = deadlineRes.data   || [];
    const allClients = allClientsRes.data || [];

    const clientToMember  = new Map(allClients.map(c => [c.id, c.responsible_team_member_id]));
    const clientOverdueDl = new Map();
    for (const d of overdueDl) clientOverdueDl.set(d.client_id, (clientOverdueDl.get(d.client_id) || 0) + 1);

    const memberStats  = new Map();
    const ensureMember = (id) => {
        if (!memberStats.has(id)) {
            const m = members.find(x => x.id === id);
            memberStats.set(id, { team_member_id: id, team_member_name: m ? m.display_name : (id === 0 ? 'Unassigned' : `Member #${id}`), client_ids: new Set(), return_count: 0, ready_for_review: 0, pack_pending: 0, outstanding_docs: 0, open_actions: 0, overdue_deadlines: 0 });
        }
        return memberStats.get(id);
    };

    for (const r of allReturns) {
        const s = ensureMember(r.responsible_team_member_id || 0);
        s.client_ids.add(r.client_id);
        s.return_count++;
        if (r.status === 'ready_for_review') s.ready_for_review++;
    }
    for (const p of packs) {
        if (['completed', 'cancelled'].includes(p.status)) continue;
        ensureMember(p.owner_team_member_id || 0).pack_pending++;
    }
    for (const d of outDocs)  { const mid = clientToMember.get(d.client_id) || 0; ensureMember(mid).outstanding_docs++; }
    for (const a of openActs) { const mid = clientToMember.get(a.client_id) || 0; ensureMember(mid).open_actions++; }
    for (const [cId, count] of clientOverdueDl) { const mid = clientToMember.get(cId) || 0; ensureMember(mid).overdue_deadlines += count; }
    for (const m of members) ensureMember(m.id);

    const summary = Array.from(memberStats.values())
        .map(s => ({ ...s, client_count: s.client_ids.size, client_ids: undefined }))
        .filter(s => s.team_member_id !== 0 || s.return_count > 0)
        .sort((a, b) => b.return_count - a.return_count);

    return { summary };
}

async function _dataBulkSummary(cid) {
    const [opsRes, itemsRes] = await Promise.all([
        supabase.from('practice_tax_bulk_operations')
            .select('id, operation_name, operation_type, operation_status, tax_year, result_summary, created_at, completed_at')
            .eq('company_id', cid).order('created_at', { ascending: false }).limit(20),
        supabase.from('practice_tax_bulk_operation_items').select('operation_id, item_status').eq('company_id', cid),
    ]);

    const ops   = opsRes.data   || [];
    const items = itemsRes.data || [];
    const statusCounts = {};
    for (const op of ops) statusCounts[op.operation_status] = (statusCounts[op.operation_status] || 0) + 1;

    const itemsByOp = new Map();
    for (const item of items) {
        if (!itemsByOp.has(item.operation_id)) itemsByOp.set(item.operation_id, { success: 0, warning: 0, failed: 0, skipped: 0, total: 0 });
        const s = itemsByOp.get(item.operation_id);
        s[item.item_status] = (s[item.item_status] || 0) + 1;
        s.total++;
    }

    const operations = ops.map(op => ({
        id: op.id, operation_name: op.operation_name, operation_type: op.operation_type,
        operation_status: op.operation_status, tax_year: op.tax_year,
        result_summary: op.result_summary || {}, item_counts: itemsByOp.get(op.id) || { total: 0 },
        created_at: op.created_at, completed_at: op.completed_at,
    }));

    const totals = { success: 0, warning: 0, failed: 0, skipped: 0, total_items: 0 };
    for (const [, s] of itemsByOp) {
        totals.success += s.success || 0; totals.warning += s.warning || 0;
        totals.failed  += s.failed  || 0; totals.skipped += s.skipped || 0;
        totals.total_items += s.total || 0;
    }
    return { operations_by_status: statusCounts, operations, totals };
}

async function _dataRiskSummary(cid, q) {
    const t = today();
    const [overdueRes, indBlockedRes, coBlockedRes, indReadyRes, coReadyRes, indPacksExistRes, coPacksExistRes, docOutRes, actionsRes] = await Promise.all([
        supabase.from('practice_deadlines')
            .select('id, title, due_date, client_id, clients:practice_clients!client_id(name)')
            .eq('company_id', cid).not('status', 'in', DEADLINE_EXCLUDE_STATUSES).lt('due_date', t).order('due_date').limit(30),
        (() => {
            let qt = supabase.from('practice_individual_tax_returns')
                .select('id, return_name, tax_year, client_id, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).eq('readiness_status', 'blocked').not('status', 'in', '(completed,cancelled,submitted)');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt.limit(30);
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_returns')
                .select('id, return_name, tax_year, client_id, clients:practice_clients!client_id(name)')
                .eq('company_id', cid).eq('readiness_status', 'blocked').not('status', 'in', '(completed,cancelled)');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt.limit(30);
        })(),
        (() => {
            let qt = supabase.from('practice_individual_tax_returns').select('id, return_name, tax_year, client_id').eq('company_id', cid).eq('status', 'ready_for_review');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt.limit(100);
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_returns').select('id, return_name, tax_year, client_id').eq('company_id', cid).eq('status', 'ready_for_review');
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt.limit(100);
        })(),
        (() => {
            let qt = supabase.from('practice_individual_tax_review_packs').select('tax_return_id, pack_status').eq('company_id', cid).in('pack_status', ['draft','generated','ready_for_review','reviewed','approved']);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt;
        })(),
        (() => {
            let qt = supabase.from('practice_company_tax_review_packs').select('tax_return_id, pack_status').eq('company_id', cid).in('pack_status', ['draft','generated','ready_for_review','reviewed','approved']);
            if (q.tax_year) qt = qt.eq('tax_year', parseInt(q.tax_year));
            return qt;
        })(),
        supabase.from('practice_document_requests').select('id, client_id').eq('company_id', cid).in('request_status', OUTSTANDING_DOC_STATUSES).limit(500),
        supabase.from('practice_tax_work_actions').select('id, client_id, action_type, action_title, action_status').eq('company_id', cid).eq('action_status', 'open').order('created_at').limit(30),
    ]);

    const indPackReturnIds = new Set((indPacksExistRes.data || []).map(p => p.tax_return_id));
    const coPackReturnIds  = new Set((coPacksExistRes.data  || []).map(p => p.tax_return_id));
    const missingReviewPacks = [
        ...(indReadyRes.data || []).filter(r => !indPackReturnIds.has(r.id)),
        ...(coReadyRes.data  || []).filter(r => !coPackReturnIds.has(r.id)),
    ];

    const clientRiskCount = new Map();
    const addRisk = (id) => clientRiskCount.set(id, (clientRiskCount.get(id) || 0) + 1);
    for (const d of (overdueRes.data    || [])) addRisk(d.client_id);
    for (const r of (indBlockedRes.data || [])) addRisk(r.client_id);
    for (const r of (coBlockedRes.data  || [])) addRisk(r.client_id);
    for (const r of missingReviewPacks)          addRisk(r.client_id);
    for (const d of (docOutRes.data     || [])) addRisk(d.client_id);
    for (const a of (actionsRes.data    || [])) addRisk(a.client_id);

    const highRiskClientIds = Array.from(clientRiskCount.entries()).filter(([, c]) => c >= 2).map(([id]) => id);
    let highRiskClients = [];
    if (highRiskClientIds.length > 0) {
        const { data: hrc } = await supabase.from('practice_clients')
            .select('id, name, client_type').eq('company_id', cid).in('id', highRiskClientIds.slice(0, 50));
        highRiskClients = (hrc || []).map(c => ({ ...c, risk_count: clientRiskCount.get(c.id) || 0 })).sort((a, b) => b.risk_count - a.risk_count);
    }

    return {
        overdue_deadlines:        (overdueRes.data     || []).length,
        blocked_returns:          (indBlockedRes.data   || []).length + (coBlockedRes.data || []).length,
        missing_review_packs:     missingReviewPacks.length,
        outstanding_documents:    (docOutRes.data       || []).length,
        open_tax_actions:         (actionsRes.data      || []).length,
        high_risk_clients:        highRiskClients.length,
        overdue_deadline_items:   (overdueRes.data || []).slice(0, 20).map(d => ({ id: d.id, title: d.title, due_date: d.due_date, client_id: d.client_id, client_name: d.clients?.name })),
        blocked_return_items:     [...(indBlockedRes.data || []).map(r => ({ ...r, entity_type: 'individual', client_name: r.clients?.name })), ...(coBlockedRes.data || []).map(r => ({ ...r, entity_type: 'company', client_name: r.clients?.name }))].slice(0, 20),
        missing_review_pack_items: missingReviewPacks.slice(0, 20),
        open_actions:              (actionsRes.data || []).slice(0, 20),
        high_risk_client_list:     highRiskClients.slice(0, 20),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

const HTML_STYLES = `
body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111;background:#fff;margin:0;padding:0}
.page{max-width:900px;margin:0 auto;padding:24px 32px}
.print-btn{position:fixed;top:12px;right:12px;padding:8px 18px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:10pt;font-weight:700}
.draft-banner{background:#fffbeb;border:1px solid #f59e0b;border-radius:4px;padding:7px 12px;font-size:9.5pt;color:#92400e;margin-bottom:16px}
.page-header{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:18px}
.practice-name{font-size:16pt;font-weight:700}
.report-title{font-size:13pt;font-weight:700;color:#2563eb;margin:4px 0 2px}
.report-meta{font-size:8.5pt;color:#666}
.section-title{font-size:12pt;font-weight:700;margin:22px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
.stat-grid{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:18px}
.stat-box{border:1px solid #ddd;border-radius:4px;padding:10px 14px;min-width:110px;text-align:center}
.stat-val{font-size:22pt;font-weight:700;line-height:1}
.stat-lbl{font-size:8pt;color:#555;margin-top:2px;text-transform:uppercase}
.stat-pct .stat-val{color:#2563eb}
.stat-completed .stat-val{color:#16a34a}
.stat-reviewed  .stat-val{color:#2563eb}
.stat-ready     .stat-val{color:#d97706}
.stat-blocked   .stat-val{color:#dc2626}
.progress-bar-wrap{background:#e5e7eb;border-radius:4px;height:10px;margin-bottom:6px;overflow:hidden}
.progress-bar{background:#2563eb;height:10px;border-radius:4px}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:9.5pt}
th{background:#f3f4f6;text-align:left;padding:5px 8px;border-bottom:2px solid #d1d5db;font-size:8.5pt;text-transform:uppercase;letter-spacing:.03em}
td{padding:5px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
.page-footer{margin-top:28px;border-top:1px solid #ddd;padding-top:10px;font-size:8.5pt;color:#888;text-align:center}
@media print{.print-btn{display:none}.section-break{page-break-before:always}}
`;

function xesc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _htmlWrap(practiceName, reportTitle, filtersText, genTime, body) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xesc(reportTitle)} — ${xesc(practiceName)}</title><style>${HTML_STYLES}</style></head><body>
<button class="print-btn" onclick="window.print()">Print / Save PDF</button>
<div class="page">
<div class="draft-banner">&#9888; Draft — Internal use only — Do not distribute to clients</div>
<div class="page-header">
  <div class="practice-name">${xesc(practiceName)}</div>
  <div class="report-title">${xesc(reportTitle)}</div>
  <div class="report-meta">Filters: ${xesc(filtersText)} &nbsp;|&nbsp; Generated: ${xesc(fmtDate(genTime))}</div>
</div>
${body}
<div class="page-footer">Generated ${xesc(new Date(genTime).toLocaleString('en-ZA'))} &nbsp;|&nbsp; ${xesc(practiceName)} &nbsp;|&nbsp; Draft — Internal Use Only</div>
</div></body></html>`;
}

function _htmlTable(headers, rows) {
    if (!rows.length) return '<p style="color:#888;font-style:italic;font-size:9pt">No data.</p>';
    return '<table><thead><tr>' + headers.map(h => `<th>${xesc(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(row => '<tr>' + row.map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}

function _htmlStatGrid(stats) {
    return '<div class="stat-grid">' + stats.map(s =>
        `<div class="stat-box ${s.cls || ''}"><div class="stat-val">${xesc(String(s.val))}</div><div class="stat-lbl">${xesc(s.lbl)}</div></div>`
    ).join('') + '</div>';
}

function _htmlBodyProgress(d) {
    const pct = d.progress_percentage || 0;
    return `<div class="section-title">Progress Overview</div>
<div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
<p style="text-align:right;font-size:9pt;color:#555;margin:0 0 12px">${pct}% complete (${d.total} items tracked)</p>`
    + _htmlStatGrid([
        { val: d.total,             lbl: 'Total' },
        { val: pct + '%',           lbl: 'Complete',         cls: 'stat-pct' },
        { val: d.completed,         lbl: 'Completed',        cls: 'stat-completed' },
        { val: d.reviewed,          lbl: 'Reviewed',         cls: 'stat-reviewed' },
        { val: d.ready_for_review,  lbl: 'Ready for Review', cls: 'stat-ready' },
        { val: d.in_progress,       lbl: 'In Progress' },
        { val: d.blocked,           lbl: 'Blocked',          cls: d.blocked > 0 ? 'stat-blocked' : '' },
        { val: d.cancelled,         lbl: 'Cancelled' },
    ]);
}

function _htmlBodyStatusBreakdown(d) {
    const sections = [
        { title: 'Individual Returns by Status',    obj: d.individual_by_status },
        { title: 'Individual Readiness',            obj: d.individual_by_readiness },
        { title: 'Company Returns by Status',       obj: d.company_by_status },
        { title: 'Company Readiness',               obj: d.company_by_readiness },
        { title: 'Provisional Plans by Status',     obj: d.provisional_by_status },
        { title: 'Compliance Packs by Status',      obj: d.packs_by_status },
        { title: 'Ind. Review Packs by Status',     obj: d.ind_review_packs_by_status },
        { title: 'Co. Review Packs by Status',      obj: d.co_review_packs_by_status },
    ];
    return sections.filter(s => Object.keys(s.obj || {}).length > 0).map(s =>
        `<div class="section-title" style="font-size:10pt">${xesc(s.title)}</div>` +
        _htmlTable(['Status', 'Count'], Object.entries(s.obj).map(([k, v]) => [xesc(k.replace(/_/g, ' ')), String(v)]))
    ).join('') || '<p style="color:#888">No breakdown data.</p>';
}

function _htmlBodyDocOutstanding(d) {
    return `<div class="section-title">Outstanding Documents</div>`
        + _htmlStatGrid([{ val: d.total, lbl: 'Outstanding' }, { val: d.overdue, lbl: 'Overdue', cls: d.overdue > 0 ? 'stat-blocked' : '' }])
        + `<div class="section-title" style="font-size:10pt">By Client</div>`
        + _htmlTable(['Client', 'Outstanding', 'Overdue'],
            (d.by_client || []).slice(0, 30).map(c => [xesc(c.client_name), String(c.total), c.overdue > 0 ? `<b style="color:#dc2626">${c.overdue}</b>` : '0']))
        + `<div class="section-title" style="font-size:10pt">By Category</div>`
        + _htmlTable(['Category', 'Count'],
            (d.by_category || []).map(c => [xesc(c.category.replace(/_/g, ' ')), String(c.count)]))
        + `<div class="section-title" style="font-size:10pt">By Team Member</div>`
        + _htmlTable(['Member', 'Outstanding', 'Overdue'],
            (d.by_team_member || []).map(m => [xesc(m.team_member_name), String(m.total), m.overdue > 0 ? `<b style="color:#dc2626">${m.overdue}</b>` : '0']));
}

function _htmlBodyReviewBottlenecks(d) {
    let html = `<div class="section-title">Review Bottlenecks</div>`
        + _htmlStatGrid([{ val: d.items_waiting_review, lbl: 'Waiting Review', cls: d.items_waiting_review > 0 ? 'stat-ready' : '' }, { val: d.rejected_items, lbl: 'Rejected', cls: d.rejected_items > 0 ? 'stat-blocked' : '' }])
        + `<div class="section-title" style="font-size:10pt">By Reviewer</div>`
        + _htmlTable(['Reviewer', 'Waiting', 'Oldest Item'],
            (d.by_reviewer || []).map(r => [xesc(r.reviewer_name), String(r.count), fmtDate(r.oldest_date)]))
        + `<div class="section-title" style="font-size:10pt">Oldest Waiting Items</div>`
        + _htmlTable(['Item', 'Type', 'Client', 'Reviewer', 'Waiting Since'],
            (d.oldest_waiting_items || []).map(i => [xesc(i.name || '—'), xesc(fmtEntityType(i.entity_type)), xesc(i.client_name || '—'), xesc(i.reviewer_name || 'Unassigned'), fmtDate(i.waiting_since)]));
    if ((d.rejected_items_list || []).length > 0) {
        html += `<div class="section-title" style="font-size:10pt">Rejected Review Packs</div>`
            + _htmlTable(['Pack', 'Type', 'Client', 'Year', 'Updated'],
                d.rejected_items_list.map(i => [xesc(i.name || '—'), xesc(fmtEntityType(i.entity_type)), xesc(i.client_name || '—'), String(i.tax_year || '—'), fmtDate(i.updated_at)]));
    }
    return html;
}

function _htmlBodyPartnerSummary(d) {
    return `<div class="section-title">Partner / Team Summary</div>`
        + _htmlTable(['Team Member', 'Clients', 'Returns', 'Ready', 'Packs', 'Docs Out', 'Actions', 'Overdue'],
            (d.summary || []).map(r => [
                xesc(r.team_member_name), String(r.client_count || 0), String(r.return_count || 0),
                r.ready_for_review > 0 ? `<b style="color:#d97706">${r.ready_for_review}</b>` : '0',
                String(r.pack_pending || 0),
                r.outstanding_docs > 0 ? `<b>${r.outstanding_docs}</b>` : '0',
                String(r.open_actions || 0),
                r.overdue_deadlines > 0 ? `<b style="color:#dc2626">${r.overdue_deadlines}</b>` : '0',
            ]));
}

function _htmlBodyBulkSummary(d) {
    const ops = d.operations || [];
    if (!ops.length) return `<div class="section-title">Bulk Operations</div><p style="color:#888">No bulk operations.</p>`;
    return `<div class="section-title">Bulk Operations Summary</div>`
        + _htmlTable(['Operation', 'Type', 'Status', 'Year', 'Success', 'Warning', 'Failed', 'Date'],
            ops.map(op => {
                const ic = op.item_counts || {};
                return [xesc(op.operation_name), xesc(op.operation_type.replace(/_/g, ' ')), xesc(op.operation_status), String(op.tax_year || '—'), String(ic.success || 0), String(ic.warning || 0), String(ic.failed || 0), fmtDate(op.created_at)];
            }));
}

function _htmlBodyRiskSummary(d) {
    let html = `<div class="section-title">Risk Summary</div>`
        + _htmlStatGrid([
            { val: d.overdue_deadlines,     lbl: 'Overdue Deadlines',    cls: d.overdue_deadlines > 0 ? 'stat-blocked' : '' },
            { val: d.blocked_returns,       lbl: 'Blocked Returns',      cls: d.blocked_returns > 0 ? 'stat-blocked' : '' },
            { val: d.missing_review_packs,  lbl: 'Missing Review Packs', cls: d.missing_review_packs > 0 ? 'stat-ready' : '' },
            { val: d.outstanding_documents, lbl: 'Outstanding Docs',     cls: d.outstanding_documents > 0 ? 'stat-ready' : '' },
            { val: d.open_tax_actions,      lbl: 'Open Actions',          cls: d.open_tax_actions > 0 ? 'stat-ready' : '' },
            { val: d.high_risk_clients,     lbl: 'High-Risk Clients',    cls: d.high_risk_clients > 0 ? 'stat-blocked' : '' },
        ]);
    if ((d.overdue_deadline_items || []).length)
        html += `<div class="section-title" style="font-size:10pt">Overdue Deadlines</div>`
            + _htmlTable(['Deadline', 'Client', 'Due Date'],
                d.overdue_deadline_items.map(i => [xesc(i.title), xesc(i.client_name || '—'), `<b style="color:#dc2626">${fmtDate(i.due_date)}</b>`]));
    if ((d.blocked_return_items || []).length)
        html += `<div class="section-title" style="font-size:10pt">Blocked Returns</div>`
            + _htmlTable(['Return', 'Client', 'Type', 'Year'],
                d.blocked_return_items.map(r => [xesc(r.return_name || '—'), xesc(r.client_name || '—'), xesc(r.entity_type), String(r.tax_year || '—')]));
    if ((d.high_risk_client_list || []).length)
        html += `<div class="section-title" style="font-size:10pt">High-Risk Clients (2+ factors)</div>`
            + _htmlTable(['Client', 'Type', 'Risk Factors'],
                d.high_risk_client_list.map(c => [xesc(c.name), xesc(c.client_type || '—'), String(c.risk_count)]));
    return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF BUILDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function _pdfPageHeader(doc, practiceName, reportTitle, filtersText, genTime) {
    const W = doc.page.width - 100;
    doc.fontSize(14).fillColor('#000').font('Helvetica-Bold').text(practiceName, 50, 50, { width: W });
    doc.fontSize(11).fillColor('#2563eb').text(reportTitle, 50, doc.y + 2, { width: W });
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Filters: ${filtersText}  |  Generated: ${fmtDate(genTime)}`, 50, doc.y + 2, { width: W });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor('#111').lineWidth(1.5).stroke();
    doc.moveDown(0.4);
    doc.fontSize(8).fillColor('#b45309').text('DRAFT — Internal use only — Do not distribute to clients', 50, doc.y, { width: W });
    doc.fillColor('#000').moveDown(0.8);
}

function _pdfSectionLabel(doc, title) {
    doc.moveDown(0.4);
    const W = doc.page.width - 100;
    doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text(title, 50, doc.y, { width: W });
    doc.font('Helvetica').moveDown(0.15);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.fillColor('#000');
}

function _pdfTable(doc, headers, rows) {
    if (!rows.length) {
        doc.fontSize(8).fillColor('#888').text('No data.'); doc.fillColor('#000').moveDown(0.5); return;
    }
    const W    = doc.page.width - 100;
    const cols = headers.length;
    const colW = Math.floor(W / cols);
    let y = doc.y;

    const drawHeader = (yPos) => {
        let x = 50;
        doc.fontSize(7).fillColor('#374151').font('Helvetica-Bold');
        headers.forEach(h => { doc.text(h.toUpperCase(), x, yPos, { width: colW, ellipsis: true }); x += colW; });
        const lineY = yPos + 12;
        doc.moveTo(50, lineY).lineTo(50 + W, lineY).strokeColor('#9ca3af').lineWidth(0.5).stroke();
        doc.font('Helvetica');
        return lineY + 3;
    };

    y = drawHeader(y);

    for (const row of rows) {
        if (y + 13 > doc.page.height - 50) { doc.addPage(); y = drawHeader(50); }
        let x = 50;
        doc.fontSize(8).fillColor('#111');
        row.forEach(cell => { doc.text(String(cell == null ? '—' : cell), x, y, { width: colW, ellipsis: true }); x += colW; });
        y += 13;
    }
    doc.y = y; doc.fillColor('#000').moveDown(0.5);
}

function _pdfStatRow(doc, stats) {
    const W    = doc.page.width - 100;
    const cols = Math.min(stats.length, 4);
    const colW = Math.floor(W / cols);
    const rowH = 40;
    let y = doc.y;
    for (let i = 0; i < stats.length; i += cols) {
        const chunk = stats.slice(i, i + cols);
        if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 50; }
        let x = 50;
        chunk.forEach(s => {
            doc.rect(x, y, colW - 8, rowH - 4).strokeColor('#d1d5db').lineWidth(0.5).stroke();
            doc.fontSize(15).fillColor('#2563eb').text(String(s.val), x + 2, y + 4, { width: colW - 12, align: 'center' });
            doc.fontSize(6.5).fillColor('#555').text(s.lbl.toUpperCase(), x + 2, y + 22, { width: colW - 12, align: 'center' });
            x += colW;
        });
        y += rowH;
    }
    doc.y = y + 4; doc.fillColor('#000');
}

function _pdfFooter(doc, practiceName, genTime) {
    const range = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 1 };
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fontSize(7).fillColor('#9ca3af').text(
            `${practiceName}  |  Draft — Internal Use Only  |  ${new Date(genTime).toLocaleString('en-ZA')}  |  Page ${i + 1} of ${range.count}`,
            50, doc.page.height - 30, { width: doc.page.width - 100, align: 'center' }
        );
    }
}

// Per-report PDF section builders (isPackSection = skip page header when inside combined pack)
function _pdfSectionProgress(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Tax Season Progress Report', filtersText, genTime);
    _pdfSectionLabel(doc, 'Progress Overview');
    const W = doc.page.width - 100;
    const pct = d.progress_percentage || 0;
    doc.rect(50, doc.y, W, 8).fillColor('#e5e7eb').fill();
    doc.rect(50, doc.y, Math.round(W * pct / 100), 8).fillColor('#2563eb').fill();
    doc.fillColor('#000').moveDown(0.6);
    doc.fontSize(8).text(`${pct}% complete (${d.total} items tracked)`, 50, doc.y);
    doc.moveDown(0.5);
    _pdfStatRow(doc, [
        { val: d.total, lbl: 'Total' }, { val: d.completed, lbl: 'Completed' },
        { val: d.reviewed, lbl: 'Reviewed' }, { val: d.ready_for_review, lbl: 'Ready for Review' },
        { val: d.in_progress, lbl: 'In Progress' }, { val: d.blocked, lbl: 'Blocked' }, { val: d.cancelled, lbl: 'Cancelled' },
    ]);
}

function _pdfSectionPartner(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Partner / Team Summary', filtersText, genTime);
    _pdfSectionLabel(doc, 'Partner / Team Summary');
    _pdfTable(doc,
        ['Member', 'Clients', 'Returns', 'Ready', 'Packs', 'Docs Out', 'Actions', 'Overdue'],
        (d.summary || []).map(r => [r.team_member_name, r.client_count, r.return_count, r.ready_for_review, r.pack_pending, r.outstanding_docs, r.open_actions, r.overdue_deadlines])
    );
}

function _pdfSectionDocOutstanding(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Outstanding Documents', filtersText, genTime);
    _pdfSectionLabel(doc, 'Outstanding Documents');
    _pdfStatRow(doc, [{ val: d.total, lbl: 'Outstanding' }, { val: d.overdue, lbl: 'Overdue' }]);
    _pdfSectionLabel(doc, 'By Client (top 30)');
    _pdfTable(doc, ['Client', 'Outstanding', 'Overdue'],
        (d.by_client || []).slice(0, 30).map(c => [c.client_name, c.total, c.overdue]));
    _pdfSectionLabel(doc, 'By Category');
    _pdfTable(doc, ['Category', 'Count'],
        (d.by_category || []).map(c => [c.category.replace(/_/g, ' '), c.count]));
    _pdfSectionLabel(doc, 'By Team Member');
    _pdfTable(doc, ['Member', 'Outstanding', 'Overdue'],
        (d.by_team_member || []).map(m => [m.team_member_name, m.total, m.overdue]));
}

function _pdfSectionReviewBottlenecks(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Review Bottlenecks', filtersText, genTime);
    _pdfSectionLabel(doc, 'Review Bottlenecks');
    _pdfStatRow(doc, [{ val: d.items_waiting_review, lbl: 'Waiting Review' }, { val: d.rejected_items, lbl: 'Rejected' }]);
    _pdfSectionLabel(doc, 'By Reviewer');
    _pdfTable(doc, ['Reviewer', 'Waiting', 'Oldest Item'],
        (d.by_reviewer || []).map(r => [r.reviewer_name, r.count, fmtDate(r.oldest_date)]));
    _pdfSectionLabel(doc, 'Oldest Waiting Items');
    _pdfTable(doc, ['Item', 'Type', 'Client', 'Reviewer', 'Waiting Since'],
        (d.oldest_waiting_items || []).map(i => [i.name, fmtEntityType(i.entity_type), i.client_name, i.reviewer_name || 'Unassigned', fmtDate(i.waiting_since)]));
    if ((d.rejected_items_list || []).length) {
        _pdfSectionLabel(doc, 'Rejected Review Packs');
        _pdfTable(doc, ['Pack', 'Type', 'Client', 'Year', 'Updated'],
            d.rejected_items_list.map(i => [i.name, fmtEntityType(i.entity_type), i.client_name, i.tax_year, fmtDate(i.updated_at)]));
    }
}

function _pdfSectionRisk(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Risk Summary', filtersText, genTime);
    _pdfSectionLabel(doc, 'Risk Summary');
    _pdfStatRow(doc, [
        { val: d.overdue_deadlines, lbl: 'Overdue Deadlines' }, { val: d.blocked_returns, lbl: 'Blocked Returns' },
        { val: d.missing_review_packs, lbl: 'Missing Packs' }, { val: d.outstanding_documents, lbl: 'Outstanding Docs' },
        { val: d.open_tax_actions, lbl: 'Open Actions' }, { val: d.high_risk_clients, lbl: 'High-Risk Clients' },
    ]);
    if ((d.overdue_deadline_items || []).length) {
        _pdfSectionLabel(doc, 'Overdue Deadlines');
        _pdfTable(doc, ['Deadline', 'Client', 'Due Date'],
            d.overdue_deadline_items.map(i => [i.title, i.client_name, fmtDate(i.due_date)]));
    }
    if ((d.blocked_return_items || []).length) {
        _pdfSectionLabel(doc, 'Blocked Returns');
        _pdfTable(doc, ['Return', 'Client', 'Type', 'Year'],
            d.blocked_return_items.map(r => [r.return_name, r.client_name, r.entity_type, r.tax_year]));
    }
    if ((d.high_risk_client_list || []).length) {
        _pdfSectionLabel(doc, 'High-Risk Clients (2+ risk factors)');
        _pdfTable(doc, ['Client', 'Type', 'Risk Factors'],
            d.high_risk_client_list.map(c => [c.name, c.client_type, c.risk_count]));
    }
}

function _pdfSectionBulk(doc, d, practiceName, filtersText, genTime, isPackSection) {
    if (!isPackSection) _pdfPageHeader(doc, practiceName, 'Bulk Operations Summary', filtersText, genTime);
    _pdfSectionLabel(doc, 'Bulk Operations Summary');
    _pdfTable(doc,
        ['Operation', 'Type', 'Status', 'Year', 'Success', 'Warn', 'Failed', 'Date'],
        (d.operations || []).map(op => {
            const ic = op.item_counts || {};
            return [op.operation_name, op.operation_type.replace(/_/g, ' '), op.operation_status, op.tax_year, ic.success || 0, ic.warning || 0, ic.failed || 0, fmtDate(op.created_at)];
        })
    );
}

// ── Common export context helper ──────────────────────────────────────────────
async function _exportCtx(cid, q) {
    return {
        practiceName: await fetchCompanyName(cid),
        filtersText:  filterSummary(q),
        genTime:      now(),
    };
}

function _requirePDF(res) {
    if (!PDFDocument) { res.status(503).json({ error: 'PDFKit not available on this server' }); return false; }
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA ROUTES (CB38 — preserved, now call extracted _data* functions)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/progress', async (req, res) => {
    try { res.json(await _dataProgress(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status-breakdown', async (req, res) => {
    try { res.json(await _dataStatusBreakdown(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/document-outstanding', async (req, res) => {
    try { res.json(await _dataDocOutstanding(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/review-bottlenecks', async (req, res) => {
    try { res.json(await _dataReviewBottlenecks(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner-summary', async (req, res) => {
    try { res.json(await _dataPartnerSummary(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bulk-operation-summary', async (req, res) => {
    try { res.json(await _dataBulkSummary(req.companyId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/risk-summary', async (req, res) => {
    try { res.json(await _dataRiskSummary(req.companyId, req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT ROUTES (CB39) — /report-data, /report-html, /report-pdf per section
// All sub-routes defined before parent routes to avoid any Express ambiguity.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Progress ─────────────────────────────────────────────────────────────────

router.get('/progress/report-data', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataProgress(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'progress' });
        res.json({ ...d, _meta: ctx });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/progress/report-html', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataProgress(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'progress', format: 'html' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Tax Season Progress Report', ctx.filtersText, ctx.genTime, _htmlBodyProgress(d)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/progress/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const [d, ctx] = await Promise.all([_dataProgress(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'progress', format: 'pdf' });
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="tax-progress-report.pdf"');
        doc.pipe(res);
        _pdfSectionProgress(doc, d, ctx.practiceName, ctx.filtersText, ctx.genTime, false);
        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── Partner Summary ──────────────────────────────────────────────────────────

router.get('/partner-summary/report-data', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataPartnerSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'partner_summary' });
        res.json({ ...d, _meta: ctx });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner-summary/report-html', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataPartnerSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'partner_summary', format: 'html' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Partner / Team Summary', ctx.filtersText, ctx.genTime, _htmlBodyPartnerSummary(d)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner-summary/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const [d, ctx] = await Promise.all([_dataPartnerSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'partner_summary', format: 'pdf' });
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="partner-summary.pdf"');
        doc.pipe(res);
        _pdfSectionPartner(doc, d, ctx.practiceName, ctx.filtersText, ctx.genTime, false);
        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── Document Outstanding ─────────────────────────────────────────────────────

router.get('/document-outstanding/report-data', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataDocOutstanding(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'document_outstanding' });
        res.json({ ...d, _meta: ctx });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/document-outstanding/report-html', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataDocOutstanding(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'document_outstanding', format: 'html' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Outstanding Documents', ctx.filtersText, ctx.genTime, _htmlBodyDocOutstanding(d)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/document-outstanding/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const [d, ctx] = await Promise.all([_dataDocOutstanding(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'document_outstanding', format: 'pdf' });
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="document-outstanding.pdf"');
        doc.pipe(res);
        _pdfSectionDocOutstanding(doc, d, ctx.practiceName, ctx.filtersText, ctx.genTime, false);
        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── Review Bottlenecks ───────────────────────────────────────────────────────

router.get('/review-bottlenecks/report-data', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataReviewBottlenecks(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'review_bottlenecks' });
        res.json({ ...d, _meta: ctx });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/review-bottlenecks/report-html', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataReviewBottlenecks(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'review_bottlenecks', format: 'html' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Review Bottlenecks', ctx.filtersText, ctx.genTime, _htmlBodyReviewBottlenecks(d)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/review-bottlenecks/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const [d, ctx] = await Promise.all([_dataReviewBottlenecks(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'review_bottlenecks', format: 'pdf' });
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="review-bottlenecks.pdf"');
        doc.pipe(res);
        _pdfSectionReviewBottlenecks(doc, d, ctx.practiceName, ctx.filtersText, ctx.genTime, false);
        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── Risk Summary ─────────────────────────────────────────────────────────────

router.get('/risk-summary/report-data', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataRiskSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'risk_summary' });
        res.json({ ...d, _meta: ctx });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/risk-summary/report-html', async (req, res) => {
    try {
        const [d, ctx] = await Promise.all([_dataRiskSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'risk_summary', format: 'html' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Risk Summary', ctx.filtersText, ctx.genTime, _htmlBodyRiskSummary(d)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/risk-summary/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const [d, ctx] = await Promise.all([_dataRiskSummary(req.companyId, req.query), _exportCtx(req.companyId, req.query)]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'risk_summary', format: 'pdf' });
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="risk-summary.pdf"');
        doc.pipe(res);
        _pdfSectionRisk(doc, d, ctx.practiceName, ctx.filtersText, ctx.genTime, false);
        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── Tax Season Pack (all 7 combined) ────────────────────────────────────────

router.get('/tax-season-pack/report-data', async (req, res) => {
    try {
        const cid = req.companyId;
        const q   = req.query;
        const [ctx, progress, breakdown, docs, review, partner, bulk, risk] = await Promise.all([
            _exportCtx(cid, q), _dataProgress(cid, q), _dataStatusBreakdown(cid, q),
            _dataDocOutstanding(cid, q), _dataReviewBottlenecks(cid, q),
            _dataPartnerSummary(cid, q), _dataBulkSummary(cid), _dataRiskSummary(cid, q),
        ]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'tax_season_pack' });
        res.json({ _meta: ctx, progress, breakdown, docs, review, partner, bulk, risk });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tax-season-pack/report-html', async (req, res) => {
    try {
        const cid = req.companyId;
        const q   = req.query;
        const [ctx, progress, breakdown, docs, review, partner, bulk, risk] = await Promise.all([
            _exportCtx(cid, q), _dataProgress(cid, q), _dataStatusBreakdown(cid, q),
            _dataDocOutstanding(cid, q), _dataReviewBottlenecks(cid, q),
            _dataPartnerSummary(cid, q), _dataBulkSummary(cid), _dataRiskSummary(cid, q),
        ]);
        await auditFromReq(req, 'VIEW', 'tax_report', null, { module: 'practice', report: 'tax_season_pack', format: 'html' });

        const body = [
            _htmlBodyProgress(progress),
            `<div class="section-title" style="margin-top:30px">Status Breakdown</div>` + _htmlBodyStatusBreakdown(breakdown),
            _htmlBodyDocOutstanding(docs),
            _htmlBodyReviewBottlenecks(review),
            _htmlBodyPartnerSummary(partner),
            _htmlBodyBulkSummary(bulk),
            _htmlBodyRiskSummary(risk),
        ].join('\n');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(_htmlWrap(ctx.practiceName, 'Tax Season Pack', ctx.filtersText, ctx.genTime, body));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tax-season-pack/report-pdf', async (req, res) => {
    if (!_requirePDF(res)) return;
    try {
        const cid = req.companyId;
        const q   = req.query;
        const [ctx, progress, breakdown, docs, review, partner, bulk, risk] = await Promise.all([
            _exportCtx(cid, q), _dataProgress(cid, q), _dataStatusBreakdown(cid, q),
            _dataDocOutstanding(cid, q), _dataReviewBottlenecks(cid, q),
            _dataPartnerSummary(cid, q), _dataBulkSummary(cid), _dataRiskSummary(cid, q),
        ]);
        await auditFromReq(req, 'DOWNLOAD', 'tax_report', null, { module: 'practice', report: 'tax_season_pack', format: 'pdf' });

        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="tax-season-pack.pdf"');
        doc.pipe(res);

        // Section 1: header + progress
        _pdfPageHeader(doc, ctx.practiceName, 'Tax Season Pack', ctx.filtersText, ctx.genTime);
        _pdfSectionProgress(doc, progress, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        // Section 2: status breakdown (inline after progress)
        _pdfSectionLabel(doc, 'Status Breakdown');
        const bdSections = [
            { title: 'Individual Returns', obj: breakdown.individual_by_status },
            { title: 'Company Returns',    obj: breakdown.company_by_status },
            { title: 'Provisional Plans',  obj: breakdown.provisional_by_status },
            { title: 'Compliance Packs',   obj: breakdown.packs_by_status },
            { title: 'Ind. Review Packs',  obj: breakdown.ind_review_packs_by_status },
            { title: 'Co. Review Packs',   obj: breakdown.co_review_packs_by_status },
        ];
        for (const s of bdSections.filter(s => Object.keys(s.obj || {}).length > 0)) {
            _pdfSectionLabel(doc, s.title);
            _pdfTable(doc, ['Status', 'Count'], Object.entries(s.obj).map(([k, v]) => [k.replace(/_/g, ' '), v]));
        }

        doc.addPage();
        _pdfSectionDocOutstanding(doc, docs, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        doc.addPage();
        _pdfSectionReviewBottlenecks(doc, review, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        doc.addPage();
        _pdfSectionPartner(doc, partner, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        doc.addPage();
        _pdfSectionBulk(doc, bulk, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        doc.addPage();
        _pdfSectionRisk(doc, risk, ctx.practiceName, ctx.filtersText, ctx.genTime, true);

        _pdfFooter(doc, ctx.practiceName, ctx.genTime);
        doc.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /snapshots — save report snapshot (requires migration 087)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/snapshots', async (req, res) => {
    const cid = req.companyId;
    const { report_name, report_type, tax_year, filters, report_data, notes } = req.body;

    if (!report_name || !report_name.trim())
        return res.status(400).json({ error: 'report_name is required' });
    if (!report_type || !SNAPSHOT_REPORT_TYPES.includes(report_type))
        return res.status(400).json({ error: `report_type must be one of: ${SNAPSHOT_REPORT_TYPES.join(', ')}` });
    if (!report_data || typeof report_data !== 'object')
        return res.status(400).json({ error: 'report_data is required' });

    const { data, error } = await supabase.from('practice_tax_reporting_snapshots').insert({
        company_id:   cid,
        report_name:  report_name.trim(),
        report_type,
        tax_year:     tax_year ? parseInt(tax_year) : null,
        filters:      filters && typeof filters === 'object' ? filters : {},
        report_data,
        notes:        notes || null,
        generated_at: now(),
        generated_by: req.userId || null,
    }).select().single();

    if (error) {
        if (error.message.includes('does not exist') || error.message.includes('relation'))
            return res.status(503).json({ error: 'Snapshot table not yet created — run migration 087 first' });
        return res.status(500).json({ error: error.message });
    }

    await auditFromReq(req, 'CREATE', 'practice_tax_reporting_snapshot', data.id,
        { module: 'practice', report_type, tax_year });

    res.status(201).json({ snapshot: data });
});

module.exports = router;
