/* =============================================================
   Practice Compliance Pack Tracker  (Codebox 24)
   NOT tax calculation. NOT financial statement generation. NOT SARS submission.
   Tracks readiness/completeness only.
   Readiness score computed on demand by recalculate-readiness — no stored flags.
   Mounted at /api/practice/compliance-packs
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const PACK_TYPES = [
    'annual_financials', 'company_tax', 'individual_tax',
    'vat_period', 'payroll_annual', 'cipc_annual', 'custom',
];

const PACK_STATUSES = [
    'draft', 'collecting_docs', 'ready_for_review', 'reviewed', 'completed', 'cancelled',
];

const READINESS_STATUSES = ['incomplete', 'partial', 'ready', 'blocked', 'unknown'];

const ITEM_TYPES = ['document', 'task', 'deadline', 'checklist', 'review', 'custom'];

const ITEM_STATUSES = [
    'required', 'requested', 'received', 'completed', 'waived', 'blocked', 'not_applicable',
];

// Statuses that count as "done" for readiness scoring
const DONE_STATUSES = ['completed', 'received', 'waived'];

// ─── Default items per pack type ─────────────────────────────────────────────

const DEFAULT_ITEMS = {
    annual_financials: [
        { item_name: 'Bank statements',        item_description: 'All bank accounts for the financial year', item_type: 'document', required: true },
        { item_name: 'Trial balance',           item_description: 'Final trial balance for the period',       item_type: 'document', required: true },
        { item_name: 'Debtors listing',         item_description: 'Trade debtors age analysis',              item_type: 'document', required: true },
        { item_name: 'Creditors listing',       item_description: 'Trade creditors age analysis',            item_type: 'document', required: true },
        { item_name: 'Fixed asset register',    item_description: 'Register with additions, disposals, depreciation', item_type: 'document', required: true },
        { item_name: 'Loan confirmations',      item_description: 'Shareholder loan, director loan, and third-party loan confirmations', item_type: 'document', required: false },
        { item_name: 'Inventory valuation',     item_description: 'Stock count and valuation at year end',   item_type: 'document', required: false },
        { item_name: 'Payroll reports',         item_description: 'Annual payroll summary and EMP501',        item_type: 'document', required: true },
        { item_name: 'VAT recon support',       item_description: 'VAT reconciliation for the year',         item_type: 'document', required: false },
    ],
    company_tax: [
        { item_name: 'Signed AFS',                  item_description: 'Signed annual financial statements',  item_type: 'document', required: true },
        { item_name: 'Tax computation support',      item_description: 'Detailed tax computation workings',  item_type: 'document', required: true },
        { item_name: 'SARS statement of account',    item_description: 'Current SARS account statement',     item_type: 'document', required: true },
        { item_name: 'Provisional tax history',      item_description: 'IRP6 submissions and payments',      item_type: 'document', required: true },
        { item_name: 'Assessed losses support',      item_description: 'Prior year assessed loss schedule',  item_type: 'document', required: false },
    ],
    individual_tax: [
        { item_name: 'IRP5 / IT3(a)',                item_description: 'Tax certificate from employer(s)',   item_type: 'document', required: true },
        { item_name: 'Medical tax certificate',      item_description: 'From medical aid / administrator',   item_type: 'document', required: false },
        { item_name: 'Retirement annuity certificate', item_description: 'RA contribution certificate (IT3f)', item_type: 'document', required: false },
        { item_name: 'Travel logbook',               item_description: 'Completed travel logbook for the year', item_type: 'document', required: false },
        { item_name: 'Rental income schedule',       item_description: 'Rental income and expense breakdown', item_type: 'document', required: false },
        { item_name: 'Investment certificates',      item_description: 'IT3b / IT3c from banks and brokers', item_type: 'document', required: false },
    ],
    vat_period: [
        { item_name: 'VAT invoices',                 item_description: 'Tax invoices for output and input VAT', item_type: 'document', required: true },
        { item_name: 'Bank statements',              item_description: 'Bank statements for the VAT period',  item_type: 'document', required: true },
        { item_name: 'Output VAT listing',           item_description: 'Sales and output VAT summary',        item_type: 'document', required: true },
        { item_name: 'Input VAT support',            item_description: 'Purchases and input VAT summary',     item_type: 'document', required: true },
        { item_name: 'Import documents',             item_description: 'SAD500 / customs documents if applicable', item_type: 'document', required: false },
    ],
    payroll_annual: [
        { item_name: 'Payroll reports',              item_description: 'Monthly and annual payroll summary',  item_type: 'document', required: true },
        { item_name: 'EMP501 support',               item_description: 'EMP501 reconciliation workings',      item_type: 'document', required: true },
        { item_name: 'IRP5 reconciliation',          item_description: 'IRP5 total vs PAYE paid reconciliation', item_type: 'document', required: true },
        { item_name: 'UIF / SDL summaries',          item_description: 'UIF and SDL payment history',         item_type: 'document', required: true },
    ],
    cipc_annual: [
        { item_name: 'Company resolution',           item_description: 'Director resolution to file annual return', item_type: 'document', required: true },
        { item_name: 'Annual return form',           item_description: 'CoR30.2 or equivalent completed form', item_type: 'document', required: true },
        { item_name: 'Beneficial ownership declaration', item_description: 'Beneficial Ownership Register filing', item_type: 'document', required: true },
        { item_name: 'Director / member details',    item_description: 'Current director and member ID details', item_type: 'document', required: false },
    ],
    custom: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyBelongsToCompany(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase
        .from(table).select('id').eq('id', id).eq('company_id', cid).single();
    return !!data;
}

async function verifyPackOwnership(cid, packId) {
    const { data } = await supabase
        .from('practice_compliance_packs')
        .select('*')
        .eq('id', packId)
        .eq('company_id', cid)
        .neq('status', 'cancelled')
        .single();
    return data || null;
}

function calculateReadiness(items) {
    // Only required items that are not marked not_applicable count
    const requiredItems = (items || []).filter(i => i.required === true && i.status !== 'not_applicable');

    if (requiredItems.length === 0) {
        return { score: null, readiness_status: 'unknown' };
    }

    const blockedCount = requiredItems.filter(i => i.status === 'blocked').length;
    const doneCount    = requiredItems.filter(i => DONE_STATUSES.includes(i.status)).length;
    const score        = Math.round((doneCount / requiredItems.length) * 100);

    let readiness_status;
    if (blockedCount > 0) {
        readiness_status = 'blocked';
    } else if (score >= 85) {
        readiness_status = 'ready';
    } else if (score >= 50) {
        readiness_status = 'partial';
    } else {
        readiness_status = 'incomplete';
    }

    return { score, readiness_status };
}

async function logPackEvent(cid, packId, eventType, oldStatus, newStatus, actorUserId, notes, metadata) {
    await supabase.from('practice_compliance_pack_events').insert({
        company_id:    cid,
        pack_id:       packId,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: actorUserId || null,
        notes:         notes      || null,
        metadata:      metadata   || {},
    });
}

// ─── GET /summary — MUST be before /:id ───────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    const { client_id } = req.query;

    try {
        let q = supabase
            .from('practice_compliance_packs')
            .select('status, readiness_status, readiness_score')
            .eq('company_id', cid)
            .neq('status', 'cancelled');

        if (client_id) q = q.eq('client_id', parseInt(client_id));

        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const rows  = data || [];
        const total = rows.length;
        const byStatus    = {};
        const byReadiness = {};

        rows.forEach(r => {
            byStatus[r.status]              = (byStatus[r.status]              || 0) + 1;
            byReadiness[r.readiness_status] = (byReadiness[r.readiness_status] || 0) + 1;
        });

        res.json({
            summary: {
                total,
                draft:            byStatus.draft            || 0,
                collecting_docs:  byStatus.collecting_docs  || 0,
                ready_for_review: byStatus.ready_for_review || 0,
                reviewed:         byStatus.reviewed         || 0,
                completed:        byStatus.completed        || 0,
                readiness: {
                    incomplete: byReadiness.incomplete || 0,
                    partial:    byReadiness.partial    || 0,
                    ready:      byReadiness.ready      || 0,
                    blocked:    byReadiness.blocked    || 0,
                    unknown:    byReadiness.unknown    || 0,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET / — List packs ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, pack_type, status, readiness_status,
        tax_year, page: rawPage, limit: rawLimit,
    } = req.query;

    const lim  = Math.min(200, Math.max(1, parseInt(rawLimit || 50)));
    const page = Math.max(0, parseInt(rawPage || 0));

    try {
        let q = supabase
            .from('practice_compliance_packs')
            .select(`*,
                practice_clients:client_id(id, name),
                owner:owner_team_member_id(id, display_name),
                reviewer:reviewer_team_member_id(id, display_name)`)
            .eq('company_id', cid)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false })
            .range(page * lim, (page + 1) * lim - 1);

        if (client_id)        q = q.eq('client_id',        parseInt(client_id));
        if (pack_type && PACK_TYPES.includes(pack_type))
                              q = q.eq('pack_type',        pack_type);
        if (status && PACK_STATUSES.filter(s => s !== 'cancelled').includes(status))
                              q = q.eq('status',           status);
        if (readiness_status && READINESS_STATUSES.includes(readiness_status))
                              q = q.eq('readiness_status', readiness_status);
        if (tax_year)         q = q.eq('tax_year',         parseInt(tax_year));

        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        res.json({ compliance_packs: data || [], page, limit: lim });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST / — Create pack ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, pack_type, pack_name,
        period_start, period_end, tax_year, financial_year_end,
        owner_team_member_id, reviewer_team_member_id,
        related_workflow_run_id, related_deadline_id,
        notes, internal_notes, settings,
    } = req.body;

    if (!client_id)   return res.status(400).json({ error: 'client_id is required' });
    if (!pack_type || !PACK_TYPES.includes(pack_type))
        return res.status(400).json({ error: `pack_type must be one of: ${PACK_TYPES.join(', ')}` });
    if (!pack_name || !pack_name.trim())
        return res.status(400).json({ error: 'pack_name is required' });

    const [clientOk, ownerOk, reviewerOk] = await Promise.all([
        verifyBelongsToCompany(cid, 'practice_clients',      parseInt(client_id)),
        verifyBelongsToCompany(cid, 'practice_team_members', owner_team_member_id),
        verifyBelongsToCompany(cid, 'practice_team_members', reviewer_team_member_id),
    ]);
    if (!clientOk)   return res.status(400).json({ error: 'client_id not found in this company' });
    if (!ownerOk)    return res.status(400).json({ error: 'owner_team_member_id not found in this company' });
    if (!reviewerOk) return res.status(400).json({ error: 'reviewer_team_member_id not found in this company' });

    const { data, error } = await supabase
        .from('practice_compliance_packs')
        .insert({
            company_id:              cid,
            client_id:               parseInt(client_id),
            pack_type,
            pack_name:               pack_name.trim(),
            period_start:            period_start       || null,
            period_end:              period_end         || null,
            tax_year:                tax_year           ? parseInt(tax_year)                : null,
            financial_year_end:      financial_year_end || null,
            status:                  'draft',
            readiness_status:        'unknown',
            owner_team_member_id:    owner_team_member_id    ? parseInt(owner_team_member_id)    : null,
            reviewer_team_member_id: reviewer_team_member_id ? parseInt(reviewer_team_member_id) : null,
            related_workflow_run_id: related_workflow_run_id ? parseInt(related_workflow_run_id) : null,
            related_deadline_id:     related_deadline_id     ? parseInt(related_deadline_id)     : null,
            notes:                   notes          || null,
            internal_notes:          internal_notes || null,
            settings:                settings && typeof settings === 'object' ? settings : {},
            created_by:              req.userId || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, data.id, 'compliance_pack_created', null, 'draft', req.userId, null, { pack_type });
    await auditFromReq(req, 'CREATE', 'practice_compliance_pack', data.id, { module: 'practice', pack_type });

    res.status(201).json({ compliance_pack: data });
});

// ─── GET /:id — Single pack ───────────────────────────────────────────────────
// After /summary literal — no collision risk

router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('practice_compliance_packs')
        .select(`*,
            practice_clients:client_id(id, name),
            owner:owner_team_member_id(id, display_name),
            reviewer:reviewer_team_member_id(id, display_name)`)
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();

    if (error || !data) return res.status(404).json({ error: 'Compliance pack not found' });
    res.json({ compliance_pack: data });
});

// ─── PUT /:id — Update pack ───────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyPackOwnership(cid, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    const allowed = [
        'pack_name', 'pack_type', 'period_start', 'period_end', 'tax_year', 'financial_year_end',
        'status', 'owner_team_member_id', 'reviewer_team_member_id',
        'related_workflow_run_id', 'related_deadline_id',
        'notes', 'internal_notes', 'settings',
    ];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.pack_type !== undefined && !PACK_TYPES.includes(updates.pack_type))
        return res.status(400).json({ error: 'Invalid pack_type' });
    if (updates.status !== undefined && !PACK_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });
    if (updates.pack_name !== undefined) updates.pack_name = updates.pack_name.trim();
    if (req.userId) updates.updated_by = req.userId;

    const { data, error } = await supabase
        .from('practice_compliance_packs')
        .update(updates)
        .eq('id', req.params.id)
        .eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    if (updates.status && updates.status !== existing.status) {
        await logPackEvent(cid, data.id, 'compliance_pack_updated', existing.status, data.status, req.userId, null, {});
    }
    await auditFromReq(req, 'UPDATE', 'practice_compliance_pack', data.id, { module: 'practice' });

    res.json({ compliance_pack: data });
});

// ─── DELETE /:id — Soft cancel ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyPackOwnership(cid, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Compliance pack not found or already cancelled' });

    const now = new Date().toISOString();
    const { error } = await supabase
        .from('practice_compliance_packs')
        .update({ status: 'cancelled', updated_at: now, updated_by: req.userId || null })
        .eq('id', req.params.id)
        .eq('company_id', cid);

    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, parseInt(req.params.id), 'compliance_pack_cancelled', existing.status, 'cancelled', req.userId, null, {});
    await auditFromReq(req, 'UPDATE', 'practice_compliance_pack', parseInt(req.params.id), {
        module: 'practice', action: 'compliance_pack_cancelled',
    });

    res.json({ success: true });
});

// ─── POST /:id/recalculate-readiness ─────────────────────────────────────────
// 3-segment — BEFORE /:id/items to avoid any path ambiguity

router.post('/:id/recalculate-readiness', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyPackOwnership(cid, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    const { data: items, error: iErr } = await supabase
        .from('practice_compliance_pack_items')
        .select('required, status')
        .eq('pack_id', req.params.id)
        .eq('company_id', cid);

    if (iErr) return res.status(500).json({ error: iErr.message });

    const { score, readiness_status } = calculateReadiness(items || []);
    const now = new Date().toISOString();

    const { data, error } = await supabase
        .from('practice_compliance_packs')
        .update({ readiness_score: score, readiness_status, updated_at: now, updated_by: req.userId || null })
        .eq('id', req.params.id)
        .eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, data.id, 'compliance_pack_readiness_recalculated', null, null, req.userId, null, {
        score, readiness_status, item_count: (items || []).length,
    });
    await auditFromReq(req, 'UPDATE', 'practice_compliance_pack', data.id, {
        module: 'practice', action: 'readiness_recalculated', score, readiness_status,
    });

    res.json({ compliance_pack: data, readiness: { score, readiness_status, item_count: (items || []).length } });
});

// ─── GET /:id/items — List items ──────────────────────────────────────────────

router.get('/:id/items', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    const { data, error } = await supabase
        .from('practice_compliance_pack_items')
        .select('*')
        .eq('pack_id', packId)
        .eq('company_id', cid)
        .order('sort_order')
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });

    const items = data || [];
    const { score, readiness_status } = calculateReadiness(items);

    res.json({ items, readiness: { score, readiness_status, item_count: items.length } });
});

// ─── POST /:id/items — Add item ───────────────────────────────────────────────

router.post('/:id/items', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    const {
        item_type, item_name, item_description, required,
        related_document_request_id, related_task_id, related_deadline_id,
        sort_order, notes,
    } = req.body;

    if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name is required' });
    const iType = item_type || 'document';
    if (!ITEM_TYPES.includes(iType)) return res.status(400).json({ error: 'Invalid item_type' });

    // Determine next sort order if not specified
    let nextOrder = sort_order != null ? parseInt(sort_order) : 0;
    if (sort_order == null) {
        const { data: last } = await supabase
            .from('practice_compliance_pack_items')
            .select('sort_order')
            .eq('pack_id', packId)
            .order('sort_order', { ascending: false })
            .limit(1)
            .single();
        nextOrder = (last?.sort_order ?? -1) + 1;
    }

    const { data, error } = await supabase
        .from('practice_compliance_pack_items')
        .insert({
            company_id:                  cid,
            pack_id:                     packId,
            item_type:                   iType,
            item_name:                   item_name.trim(),
            item_description:            item_description || null,
            status:                      'required',
            required:                    required !== false,
            related_document_request_id: related_document_request_id ? parseInt(related_document_request_id) : null,
            related_task_id:             related_task_id              ? parseInt(related_task_id)             : null,
            related_deadline_id:         related_deadline_id          ? parseInt(related_deadline_id)         : null,
            sort_order:                  nextOrder,
            notes:                       notes || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_compliance_pack_item', data.id, {
        module: 'practice', action: 'compliance_pack_item_added', pack_id: packId,
    });

    res.status(201).json({ item: data });
});

// ─── PUT /:id/items/:itemId — Update item ─────────────────────────────────────

router.put('/:id/items/:itemId', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);

    const { data: item } = await supabase
        .from('practice_compliance_pack_items')
        .select('*').eq('id', itemId).eq('pack_id', packId).eq('company_id', cid).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const allowed = [
        'item_type', 'item_name', 'item_description', 'status', 'required',
        'related_document_request_id', 'related_task_id', 'related_deadline_id',
        'sort_order', 'notes',
    ];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.item_type !== undefined && !ITEM_TYPES.includes(updates.item_type))
        return res.status(400).json({ error: 'Invalid item_type' });
    if (updates.status !== undefined && !ITEM_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });
    if (updates.item_name !== undefined) updates.item_name = updates.item_name.trim();

    const { data, error } = await supabase
        .from('practice_compliance_pack_items')
        .update(updates)
        .eq('id', itemId)
        .eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_compliance_pack_item', data.id, {
        module: 'practice', action: 'compliance_pack_item_updated', pack_id: packId,
    });

    res.json({ item: data });
});

// ─── DELETE /:id/items/:itemId — Soft retire (waived / not_applicable) ────────

router.delete('/:id/items/:itemId', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);

    const { data: item } = await supabase
        .from('practice_compliance_pack_items')
        .select('*').eq('id', itemId).eq('pack_id', packId).eq('company_id', cid).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Prefer soft mark over hard delete to preserve history
    const targetStatus = req.query.soft !== 'false' ? 'not_applicable' : null;

    if (targetStatus) {
        const { error } = await supabase
            .from('practice_compliance_pack_items')
            .update({ status: targetStatus, updated_at: new Date().toISOString() })
            .eq('id', itemId).eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });
    } else {
        const { error } = await supabase
            .from('practice_compliance_pack_items')
            .delete().eq('id', itemId).eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });
    }

    await auditFromReq(req, 'UPDATE', 'practice_compliance_pack_item', itemId, {
        module: 'practice', action: 'compliance_pack_item_updated', pack_id: packId,
        soft_status: targetStatus || 'deleted',
    });

    res.json({ success: true });
});

// ─── POST /:id/generate-default-items ─────────────────────────────────────────

router.post('/:id/generate-default-items', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    const defaults = DEFAULT_ITEMS[pack.pack_type] || [];
    if (defaults.length === 0) {
        return res.status(400).json({ error: `No default items defined for pack type "${pack.pack_type}"` });
    }

    // Check for existing items to avoid duplicate generation
    const { data: existing } = await supabase
        .from('practice_compliance_pack_items')
        .select('id')
        .eq('pack_id', packId)
        .eq('company_id', cid);

    if (existing && existing.length > 0 && !req.query.force) {
        return res.status(409).json({
            error: `Pack already has ${existing.length} item(s). Use ?force=true to add defaults anyway.`,
            existing_count: existing.length,
        });
    }

    const rows = defaults.map((item, idx) => ({
        company_id:      cid,
        pack_id:         packId,
        item_type:       item.item_type || 'document',
        item_name:       item.item_name,
        item_description: item.item_description || null,
        status:          'required',
        required:        item.required !== false,
        sort_order:      idx,
    }));

    const { data: created, error } = await supabase
        .from('practice_compliance_pack_items')
        .insert(rows)
        .select();

    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, packId, 'compliance_pack_defaults_generated', null, null, req.userId, null, {
        pack_type: pack.pack_type, created_count: created.length,
    });
    await auditFromReq(req, 'CREATE', 'practice_compliance_pack_item', packId, {
        module: 'practice', action: 'compliance_pack_defaults_generated',
        pack_type: pack.pack_type, created_count: created.length,
    });

    res.status(201).json({ created: created.length, items: created });
});

// ─── POST /:id/generate-from-documents ────────────────────────────────────────

router.post('/:id/generate-from-documents', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Compliance pack not found or cancelled' });

    // Fetch outstanding/received document requests for this client
    const OUTSTANDING = ['requested', 'reminder_sent', 'partially_received', 'received'];
    const { data: docReqs, error: dErr } = await supabase
        .from('practice_document_requests')
        .select('id, request_title, request_description, request_status')
        .eq('company_id', cid)
        .eq('client_id', pack.client_id)
        .in('request_status', OUTSTANDING)
        .order('requested_at', { ascending: false })
        .limit(100);

    if (dErr) return res.status(500).json({ error: dErr.message });
    if (!docReqs || docReqs.length === 0) {
        return res.json({ created: 0, items: [], message: 'No open document requests found for this client.' });
    }

    // Avoid creating duplicate items already linked to these requests
    const { data: existingItems } = await supabase
        .from('practice_compliance_pack_items')
        .select('related_document_request_id')
        .eq('pack_id', packId)
        .eq('company_id', cid);

    const alreadyLinked = new Set(
        (existingItems || [])
            .map(i => i.related_document_request_id)
            .filter(Boolean)
    );

    const toCreate = docReqs.filter(r => !alreadyLinked.has(r.id));
    if (toCreate.length === 0) {
        return res.json({ created: 0, items: [], message: 'All document requests are already linked to this pack.' });
    }

    // Determine next sort_order
    const { data: lastItem } = await supabase
        .from('practice_compliance_pack_items')
        .select('sort_order')
        .eq('pack_id', packId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .single();
    let nextOrder = (lastItem?.sort_order ?? -1) + 1;

    const rows = toCreate.map(r => {
        const isReceived = r.request_status === 'received';
        return {
            company_id:                 cid,
            pack_id:                    packId,
            item_type:                  'document',
            item_name:                  r.request_title,
            item_description:           r.request_description || null,
            status:                     isReceived ? 'received' : 'requested',
            required:                   true,
            related_document_request_id: r.id,
            sort_order:                 nextOrder++,
        };
    });

    const { data: created, error: cErr } = await supabase
        .from('practice_compliance_pack_items')
        .insert(rows)
        .select();

    if (cErr) return res.status(500).json({ error: cErr.message });

    await logPackEvent(cid, packId, 'compliance_pack_documents_generated', null, null, req.userId, null, {
        created_count: created.length, skipped: alreadyLinked.size,
    });
    await auditFromReq(req, 'CREATE', 'practice_compliance_pack_item', packId, {
        module: 'practice', action: 'compliance_pack_documents_generated', created_count: created.length,
    });

    res.status(201).json({ created: created.length, items: created });
});

module.exports = router;
