/* =============================================================
   Practice Document Request Tracker  (Codebox 23)
   NOT file storage. NOT OCR. NOT SharePoint.
   Tracks: requested | reminder_sent | partially_received | received | waived | cancelled
   Overdue is computed in enrichRequest() — no cron, no stored flag.
   Mounted at /api/practice/document-requests
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const DOC_CATEGORIES = [
    'identity', 'tax', 'vat', 'payroll', 'accounting', 'banking',
    'cipc', 'trust', 'legal', 'compliance', 'financials', 'supporting_docs', 'custom',
];

const REQUEST_STATUSES = [
    'requested', 'reminder_sent', 'partially_received', 'received', 'waived', 'cancelled',
];

const OUTSTANDING_STATUSES = ['requested', 'reminder_sent', 'partially_received'];

const CHECKLIST_CATEGORIES = [
    'vat', 'tax', 'payroll', 'financials', 'audit', 'onboarding', 'cipc', 'trust', 'custom',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function getMondayStr() {
    const d = new Date();
    const diff = (d.getDay() === 0) ? -6 : 1 - d.getDay();
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().split('T')[0];
}

function getSundayStr() {
    const d = new Date();
    const diff = (d.getDay() === 0) ? 0 : 7 - d.getDay();
    d.setDate(d.getDate() + diff);
    d.setHours(23, 59, 59, 999);
    return d.toISOString().split('T')[0];
}

async function verifyBelongsToCompany(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase
        .from(table).select('id').eq('id', id).eq('company_id', cid).single();
    return !!data;
}

async function verifyRequestOwnership(cid, reqId) {
    const { data } = await supabase
        .from('practice_document_requests')
        .select('*')
        .eq('id', reqId)
        .eq('company_id', cid)
        .neq('request_status', 'cancelled')
        .single();
    return data || null;
}

function enrichRequest(r) {
    const today = todayStr();
    const isOverdue = OUTSTANDING_STATUSES.includes(r.request_status) &&
        r.required_by_date &&
        r.required_by_date < today;
    return { ...r, is_overdue: isOverdue };
}

// ─── GET /summary ─────────────────────────────────────────────────────────────
// MUST be before GET /:id to prevent 'summary' matching as :id

router.get('/summary', async (req, res) => {
    const cid   = req.companyId;
    const today = todayStr();
    const sun   = getSundayStr();
    try {
        const { data, error } = await supabase
            .from('practice_document_requests')
            .select('request_status, required_by_date, reminder_count, requested_at')
            .eq('company_id', cid)
            .neq('request_status', 'cancelled');

        if (error) return res.status(500).json({ error: error.message });

        const rows     = data || [];
        const mon      = getMondayStr();
        let totalActive = 0, outstanding = 0, overdue = 0, received = 0, dueThisWeek = 0, remindersSent = 0;

        rows.forEach(r => {
            totalActive++;
            if (OUTSTANDING_STATUSES.includes(r.request_status)) {
                outstanding++;
                if (r.required_by_date && r.required_by_date < today) overdue++;
                if (r.required_by_date && r.required_by_date >= today && r.required_by_date <= sun) dueThisWeek++;
                if (r.reminder_count > 0) remindersSent++;
            }
            if (r.request_status === 'received') received++;
        });

        res.json({
            summary: { total_active: totalActive, outstanding, overdue, received, due_this_week: dueThisWeek, reminders_sent: remindersSent }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Checklist routes (literals — MUST be before /:id) ────────────────────────

router.get('/checklists', async (req, res) => {
    const { category, active = 'true' } = req.query;
    let q = supabase
        .from('practice_document_checklists')
        .select('*')
        .eq('company_id', req.companyId)
        .order('checklist_name');

    if (active !== 'all') q = q.eq('is_active', active !== 'false');
    if (category && CHECKLIST_CATEGORIES.includes(category)) q = q.eq('category', category);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ checklists: data || [] });
});

router.post('/checklists', async (req, res) => {
    const { checklist_name, category, description } = req.body;
    if (!checklist_name || !checklist_name.trim()) return res.status(400).json({ error: 'checklist_name is required' });
    const cat = category || 'custom';
    if (!CHECKLIST_CATEGORIES.includes(cat)) return res.status(400).json({ error: 'Invalid category' });

    const { data, error } = await supabase
        .from('practice_document_checklists')
        .insert({
            company_id:     req.companyId,
            checklist_name: checklist_name.trim(),
            category:       cat,
            description:    description || null,
            created_by:     req.userId || null,
        })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    await auditFromReq(req, 'CREATE', 'practice_document_checklist', data.id, { module: 'practice' });
    res.status(201).json({ checklist: data });
});

// 3-segment item routes BEFORE 2-segment /:id routes

router.get('/checklists/:id/items', async (req, res) => {
    const { data: cl } = await supabase
        .from('practice_document_checklists').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });

    const { data, error } = await supabase
        .from('practice_document_checklist_items')
        .select('*')
        .eq('checklist_id', req.params.id)
        .eq('company_id', req.companyId)
        .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
});

router.post('/checklists/:id/items', async (req, res) => {
    const { data: cl } = await supabase
        .from('practice_document_checklists').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });

    const { item_name, item_description, document_category, document_type, sort_order, is_required } = req.body;
    if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name is required' });
    const cat = document_category || 'supporting_docs';
    if (!DOC_CATEGORIES.includes(cat)) return res.status(400).json({ error: 'Invalid document_category' });

    const { data: existing } = await supabase
        .from('practice_document_checklist_items').select('sort_order').eq('checklist_id', req.params.id).order('sort_order', { ascending: false }).limit(1).single();
    const nextOrder = sort_order != null ? parseInt(sort_order) : ((existing?.sort_order ?? -1) + 1);

    const { data, error } = await supabase
        .from('practice_document_checklist_items')
        .insert({
            checklist_id:      parseInt(req.params.id),
            company_id:        req.companyId,
            item_name:         item_name.trim(),
            item_description:  item_description || null,
            document_category: cat,
            document_type:     document_type || null,
            sort_order:        nextOrder,
            is_required:       is_required !== false,
        })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ item: data });
});

router.put('/checklists/:id/items/:itemId', async (req, res) => {
    const { data: item } = await supabase
        .from('practice_document_checklist_items')
        .select('id').eq('id', req.params.itemId).eq('checklist_id', req.params.id).eq('company_id', req.companyId).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const allowed = ['item_name', 'item_description', 'document_category', 'document_type', 'sort_order', 'is_required'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (updates.document_category && !DOC_CATEGORIES.includes(updates.document_category))
        return res.status(400).json({ error: 'Invalid document_category' });

    const { data, error } = await supabase
        .from('practice_document_checklist_items')
        .update(updates).eq('id', req.params.itemId).eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/checklists/:id/items/:itemId', async (req, res) => {
    const { data: item } = await supabase
        .from('practice_document_checklist_items')
        .select('id').eq('id', req.params.itemId).eq('checklist_id', req.params.id).eq('company_id', req.companyId).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const { error } = await supabase
        .from('practice_document_checklist_items')
        .delete().eq('id', req.params.itemId).eq('company_id', req.companyId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.post('/checklists/:id/apply', async (req, res) => {
    const cid = req.companyId;
    const checklistId = parseInt(req.params.id);
    const { client_id, required_by_date } = req.body;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    const [clOk, clientOk] = await Promise.all([
        supabase.from('practice_document_checklists').select('id, checklist_name').eq('id', checklistId).eq('company_id', cid).eq('is_active', true).single(),
        verifyBelongsToCompany(cid, 'practice_clients', parseInt(client_id)),
    ]);

    if (!clOk.data) return res.status(404).json({ error: 'Checklist not found or inactive' });
    if (!clientOk)  return res.status(400).json({ error: 'client_id not found in this company' });

    const { data: items, error: iErr } = await supabase
        .from('practice_document_checklist_items')
        .select('*')
        .eq('checklist_id', checklistId)
        .eq('company_id', cid)
        .order('sort_order');
    if (iErr) return res.status(500).json({ error: iErr.message });
    if (!items || items.length === 0) return res.status(400).json({ error: 'Checklist has no items' });

    const now = new Date().toISOString();
    const rows = items.map(item => ({
        company_id:        cid,
        client_id:         parseInt(client_id),
        request_title:     item.item_name,
        request_description: item.item_description || null,
        document_category: item.document_category,
        document_type:     item.document_type || null,
        request_status:    'requested',
        required_by_date:  required_by_date || null,
        requested_at:      now,
        notes:             `Applied from checklist: ${clOk.data.checklist_name}`,
        created_by:        req.userId || null,
    }));

    const { data: created, error: cErr } = await supabase
        .from('practice_document_requests')
        .insert(rows)
        .select();
    if (cErr) return res.status(500).json({ error: cErr.message });

    await auditFromReq(req, 'CREATE', 'practice_document_checklist_apply', checklistId, {
        module: 'practice',
        action: 'checklist_applied',
        client_id: parseInt(client_id),
        created_count: created.length,
        checklist_name: clOk.data.checklist_name,
    });

    res.status(201).json({ created: created.length, document_requests: created });
});

router.get('/checklists/:id', async (req, res) => {
    const { data: cl, error } = await supabase
        .from('practice_document_checklists')
        .select('*')
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();
    if (error || !cl) return res.status(404).json({ error: 'Checklist not found' });

    const { data: items } = await supabase
        .from('practice_document_checklist_items')
        .select('*')
        .eq('checklist_id', req.params.id)
        .eq('company_id', req.companyId)
        .order('sort_order');

    res.json({ checklist: { ...cl, items: items || [] } });
});

router.put('/checklists/:id', async (req, res) => {
    const { data: cl } = await supabase
        .from('practice_document_checklists').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });

    const { checklist_name, category, description, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (checklist_name !== undefined) updates.checklist_name = checklist_name.trim();
    if (category       !== undefined) {
        if (!CHECKLIST_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
        updates.category = category;
    }
    if (description !== undefined) updates.description = description || null;
    if (is_active   !== undefined) updates.is_active   = is_active === true || is_active === 'true';
    if (req.userId) updates.updated_by = req.userId;

    const { data, error } = await supabase
        .from('practice_document_checklists')
        .update(updates).eq('id', req.params.id).eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    await auditFromReq(req, 'UPDATE', 'practice_document_checklist', data.id, { module: 'practice' });
    res.json({ checklist: data });
});

router.delete('/checklists/:id', async (req, res) => {
    const { data: cl } = await supabase
        .from('practice_document_checklists').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
    if (!cl) return res.status(404).json({ error: 'Checklist not found' });

    const { error } = await supabase
        .from('practice_document_checklists')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('company_id', req.companyId);
    if (error) return res.status(500).json({ error: error.message });
    await auditFromReq(req, 'DEACTIVATE', 'practice_document_checklist', parseInt(req.params.id), { module: 'practice' });
    res.json({ success: true });
});

// ─── GET / — List requests ────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, status, category, assignee,
        overdue_only, search, limit: rawLimit,
    } = req.query;

    const today  = todayStr();
    const lim    = Math.min(200, Math.max(1, parseInt(rawLimit || 100)));

    let q = supabase
        .from('practice_document_requests')
        .select(`*,
            practice_clients:client_id(name),
            assignee:assigned_team_member_id(id, display_name)`)
        .eq('company_id', cid)
        .neq('request_status', 'cancelled')
        .order('requested_at', { ascending: false })
        .limit(lim);

    if (client_id) q = q.eq('client_id',               parseInt(client_id));
    if (category && DOC_CATEGORIES.includes(category))
                   q = q.eq('document_category',        category);
    if (assignee)  q = q.eq('assigned_team_member_id',  parseInt(assignee));

    // Status filter — 'outstanding' is a pseudo-value meaning all non-terminal statuses
    if (status === 'outstanding') {
        q = q.in('request_status', OUTSTANDING_STATUSES);
    } else if (status && REQUEST_STATUSES.includes(status)) {
        q = q.eq('request_status', status);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let results = (data || []).map(enrichRequest);

    // Post-fetch filters
    if (overdue_only === 'true') results = results.filter(r => r.is_overdue);

    if (search) {
        const s = search.toLowerCase();
        results = results.filter(r =>
            (r.request_title    && r.request_title.toLowerCase().includes(s)) ||
            (r.document_type    && r.document_type.toLowerCase().includes(s)) ||
            (r.notes            && r.notes.toLowerCase().includes(s)) ||
            (r.practice_clients?.name && r.practice_clients.name.toLowerCase().includes(s))
        );
    }

    res.json({ document_requests: results, total: results.length });
});

// ─── POST / — Create request ──────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, request_title, request_description,
        document_category, document_type,
        required_by_date, assigned_team_member_id,
        related_workflow_run_id, related_task_id,
        related_deadline_id, related_engagement_id, related_communication_id,
        notes, internal_notes,
    } = req.body;

    if (!client_id)      return res.status(400).json({ error: 'client_id is required' });
    if (!request_title || !request_title.trim())
                         return res.status(400).json({ error: 'request_title is required' });
    if (!document_category || !DOC_CATEGORIES.includes(document_category))
                         return res.status(400).json({ error: `document_category must be one of: ${DOC_CATEGORIES.join(', ')}` });

    // Parallel ownership verification
    const [clientOk, memberOk, taskOk, deadlineOk, engOk, commOk] = await Promise.all([
        verifyBelongsToCompany(cid, 'practice_clients',               parseInt(client_id)),
        verifyBelongsToCompany(cid, 'practice_team_members',          assigned_team_member_id),
        verifyBelongsToCompany(cid, 'practice_tasks',                 related_task_id),
        verifyBelongsToCompany(cid, 'practice_deadlines',             related_deadline_id),
        verifyBelongsToCompany(cid, 'practice_client_engagements',    related_engagement_id),
        verifyBelongsToCompany(cid, 'practice_client_communications', related_communication_id),
    ]);
    if (!clientOk)   return res.status(400).json({ error: 'client_id not found in this company' });
    if (!memberOk)   return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });
    if (!taskOk)     return res.status(400).json({ error: 'related_task_id not found in this company' });
    if (!deadlineOk) return res.status(400).json({ error: 'related_deadline_id not found in this company' });
    if (!engOk)      return res.status(400).json({ error: 'related_engagement_id not found in this company' });
    if (!commOk)     return res.status(400).json({ error: 'related_communication_id not found in this company' });

    const { data, error } = await supabase
        .from('practice_document_requests')
        .insert({
            company_id:               cid,
            client_id:                parseInt(client_id),
            request_title:            request_title.trim(),
            request_description:      request_description  || null,
            document_category,
            document_type:            document_type        || null,
            request_status:           'requested',
            required_by_date:         required_by_date     || null,
            assigned_team_member_id:  assigned_team_member_id ? parseInt(assigned_team_member_id) : null,
            related_workflow_run_id:  related_workflow_run_id  ? parseInt(related_workflow_run_id)  : null,
            related_task_id:          related_task_id          ? parseInt(related_task_id)          : null,
            related_deadline_id:      related_deadline_id      ? parseInt(related_deadline_id)      : null,
            related_engagement_id:    related_engagement_id    ? parseInt(related_engagement_id)    : null,
            related_communication_id: related_communication_id ? parseInt(related_communication_id) : null,
            notes:                    notes          || null,
            internal_notes:           internal_notes || null,
            created_by:               req.userId     || null,
        })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_document_request', data.id, {
        module: 'practice', action: 'document_requested', client_id: data.client_id,
    });
    res.status(201).json({ document_request: enrichRequest(data) });
});

// ─── GET /:id — Single request ────────────────────────────────────────────────
// After /summary and /checklists — no collision risk since those are literals

router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('practice_document_requests')
        .select(`*, practice_clients:client_id(name), assignee:assigned_team_member_id(id, display_name)`)
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Document request not found' });
    res.json({ document_request: enrichRequest(data) });
});

// ─── PUT /:id/received — Mark received ───────────────────────────────────────
// 3-segment — MUST be before 2-segment PUT /:id

router.put('/:id/received', async (req, res) => {
    const existing = await verifyRequestOwnership(req.companyId, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Document request not found or already cancelled' });

    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('practice_document_requests')
        .update({
            request_status: 'received',
            received_at:    now,
            updated_at:     now,
            updated_by:     req.userId || null,
        })
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_document_request', data.id, {
        module: 'practice', action: 'document_received',
    });
    res.json({ document_request: enrichRequest(data) });
});

// ─── PUT /:id/reminder-sent — Log a reminder ─────────────────────────────────

router.put('/:id/reminder-sent', async (req, res) => {
    const existing = await verifyRequestOwnership(req.companyId, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Document request not found or already cancelled' });
    if (!OUTSTANDING_STATUSES.includes(existing.request_status)) {
        return res.status(400).json({ error: `Cannot log reminder on a request with status "${existing.request_status}"` });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('practice_document_requests')
        .update({
            request_status:   'reminder_sent',
            reminder_count:   (existing.reminder_count || 0) + 1,
            last_reminder_at: now,
            updated_at:       now,
            updated_by:       req.userId || null,
        })
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_document_request', data.id, {
        module: 'practice', action: 'document_reminder_sent',
        reminder_count: data.reminder_count,
    });
    res.json({ document_request: enrichRequest(data) });
});

// ─── PUT /:id/waive — Waive the request ──────────────────────────────────────

router.put('/:id/waive', async (req, res) => {
    const existing = await verifyRequestOwnership(req.companyId, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Document request not found or already cancelled' });

    const now = new Date().toISOString();
    const { notes } = req.body;
    const { data, error } = await supabase
        .from('practice_document_requests')
        .update({
            request_status: 'waived',
            notes:          notes ? (existing.notes ? existing.notes + '\nWaived: ' + notes : 'Waived: ' + notes) : existing.notes,
            updated_at:     now,
            updated_by:     req.userId || null,
        })
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_document_request', data.id, {
        module: 'practice', action: 'document_waived',
    });
    res.json({ document_request: enrichRequest(data) });
});

// ─── PUT /:id — Generic update ────────────────────────────────────────────────
// 2-segment — AFTER all 3-segment PUTs

router.put('/:id', async (req, res) => {
    const existing = await verifyRequestOwnership(req.companyId, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Document request not found or already cancelled' });

    const allowed = [
        'request_title', 'request_description', 'document_category', 'document_type',
        'required_by_date', 'assigned_team_member_id',
        'related_workflow_run_id', 'related_task_id',
        'related_deadline_id', 'related_engagement_id', 'related_communication_id',
        'notes', 'internal_notes',
    ];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.document_category !== undefined && !DOC_CATEGORIES.includes(updates.document_category))
        return res.status(400).json({ error: 'Invalid document_category' });
    if (updates.assigned_team_member_id !== undefined)
        updates.assigned_team_member_id = updates.assigned_team_member_id ? parseInt(updates.assigned_team_member_id) : null;

    if (req.userId) updates.updated_by = req.userId;

    const { data, error } = await supabase
        .from('practice_document_requests')
        .update(updates)
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_document_request', data.id, { module: 'practice' });
    res.json({ document_request: enrichRequest(data) });
});

// ─── DELETE /:id — Soft cancel ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const existing = await verifyRequestOwnership(req.companyId, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Document request not found or already cancelled' });

    const { error } = await supabase
        .from('practice_document_requests')
        .update({
            request_status: 'cancelled',
            updated_at:     new Date().toISOString(),
            updated_by:     req.userId || null,
        })
        .eq('id', req.params.id)
        .eq('company_id', req.companyId);
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_document_request', parseInt(req.params.id), {
        module: 'practice', action: 'document_request_cancelled',
    });
    res.json({ success: true });
});

module.exports = router;
