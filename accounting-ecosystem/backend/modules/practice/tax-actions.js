// Practice Tax Work Actions + Review Queue (Codebox 35)
// Follow-up action tracking for tax dashboard risks.
// NOT tax calculation. NOT SARS. NOT automation. NOT Sean AI.
// Mounted at /api/practice/tax-actions
'use strict';

const express  = require('express');
const router   = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_TYPES = [
    'individual_return', 'company_return', 'provisional_plan',
    'individual_calculation', 'company_calculation',
    'individual_review_pack', 'company_review_pack',
    'compliance_deadline', 'document_request', 'tax_dashboard_risk',
];

const ACTION_TYPES = [
    'create_task', 'assign_owner', 'assign_reviewer', 'request_document',
    'generate_review_pack', 'run_calculation', 'submit_for_review', 'general_followup',
];

const ACTION_STATUSES = ['open', 'in_progress', 'completed', 'dismissed', 'cancelled'];

const DOC_CATEGORIES = [
    'identity', 'tax', 'vat', 'payroll', 'accounting', 'banking',
    'cipc', 'trust', 'legal', 'compliance', 'financials', 'supporting_docs', 'custom',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

async function verifyOwn(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase.from(table).select('id').eq('id', parseInt(id)).eq('company_id', cid).single();
    return !!data;
}

async function fetchAction(cid, actionId) {
    const { data } = await supabase
        .from('practice_tax_work_actions')
        .select('*')
        .eq('id', actionId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logEvent(cid, actionId, eventType, payload) {
    await supabase.from('practice_tax_work_action_events').insert({
        company_id: cid, action_id: actionId, event_type: eventType,
        old_status:     payload.old_status     || null,
        new_status:     payload.new_status     || null,
        actor_user_id:  payload.actor_user_id  || null,
        notes:          payload.notes          || null,
        metadata:       payload.metadata       || {},
    });
}

// ─── SOURCE TABLE MAP ─────────────────────────────────────────────────────────
// Maps source_type → { table, pkField, statusField }

const SOURCE_MAP = {
    individual_return:    { table: 'practice_individual_tax_returns',    statusField: 'status',             reviewerField: 'reviewer_team_member_id' },
    company_return:       { table: 'practice_company_tax_returns',       statusField: 'status',             reviewerField: 'reviewer_team_member_id' },
    provisional_plan:     { table: 'practice_provisional_tax_plans',     statusField: 'status',             reviewerField: 'reviewer_team_member_id' },
    individual_calculation: { table: 'practice_individual_tax_calculations', statusField: 'calculation_status', reviewerField: null },
    company_calculation:  { table: 'practice_company_tax_calculations',  statusField: 'calculation_status', reviewerField: null },
    individual_review_pack: { table: 'practice_individual_tax_review_packs', statusField: 'pack_status',    reviewerField: null },
    company_review_pack:  { table: 'practice_company_tax_review_packs',  statusField: 'pack_status',        reviewerField: null },
};

// Status value to use when marking source as ready_for_review
const READY_STATUS = {
    individual_return:      'ready_for_review',
    company_return:         'ready_for_review',
    provisional_plan:       'ready_for_review',
    individual_calculation: 'ready_for_review',
    company_calculation:    'ready_for_review',
    individual_review_pack: 'ready_for_review',
    company_review_pack:    'ready_for_review',
};

// ─── IMPORTANT: Route ordering ────────────────────────────────────────────────
// Literal routes (review-queue, from-dashboard-risk) BEFORE /:id
// 3-segment routes (/:id/action) BEFORE 2-segment /:id

// ─── GET /review-queue ────────────────────────────────────────────────────────
// Aggregates all items currently in ready_for_review status across 7 sources.
// Filters: source_type, reviewer_team_member_id

router.get('/review-queue', async (req, res) => {
    const cid = req.companyId;
    const { source_type, reviewer_team_member_id } = req.query;
    const rvId = reviewer_team_member_id ? parseInt(reviewer_team_member_id) : null;

    const wantInd     = !source_type || source_type === 'individual_return';
    const wantCo      = !source_type || source_type === 'company_return';
    const wantProv    = !source_type || source_type === 'provisional_plan';
    const wantIndCalc = !source_type || source_type === 'individual_calculation';
    const wantCoCalc  = !source_type || source_type === 'company_calculation';
    const wantIndPack = !source_type || source_type === 'individual_review_pack';
    const wantCoPack  = !source_type || source_type === 'company_review_pack';

    function applyRevFilter(q, field) {
        return rvId ? q.eq(field, rvId) : q;
    }

    try {
        let indQ = supabase.from('practice_individual_tax_returns')
            .select('id, return_name, tax_year, status, readiness_status, reviewer_team_member_id, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).eq('status', 'ready_for_review').neq('status', 'cancelled');
        if (rvId) indQ = indQ.eq('reviewer_team_member_id', rvId);

        let coQ = supabase.from('practice_company_tax_returns')
            .select('id, return_name, tax_year, status, readiness_status, reviewer_team_member_id, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).eq('status', 'ready_for_review');
        if (rvId) coQ = coQ.eq('reviewer_team_member_id', rvId);

        let provQ = supabase.from('practice_provisional_tax_plans')
            .select('id, plan_name, tax_year, status, reviewer_team_member_id, clients:practice_clients!client_id(display_name, company_name)')
            .eq('company_id', cid).eq('status', 'ready_for_review');
        if (rvId) provQ = provQ.eq('reviewer_team_member_id', rvId);

        let indCalcQ = supabase.from('practice_individual_tax_calculations')
            .select('id, calculation_name, tax_year, calculation_status, warning_flags')
            .eq('company_id', cid).eq('calculation_status', 'ready_for_review');

        let coCalcQ = supabase.from('practice_company_tax_calculations')
            .select('id, calculation_name, tax_year, calculation_status, warning_flags')
            .eq('company_id', cid).eq('calculation_status', 'ready_for_review');

        let indPackQ = supabase.from('practice_individual_tax_review_packs')
            .select('id, pack_name, tax_year, pack_status, reviewer_team_member_id, tax_return_id')
            .eq('company_id', cid).eq('pack_status', 'ready_for_review');
        if (rvId) indPackQ = indPackQ.eq('reviewer_team_member_id', rvId);

        let coPackQ = supabase.from('practice_company_tax_review_packs')
            .select('id, pack_name, tax_year, pack_status, reviewer_team_member_id, company_tax_return_id')
            .eq('company_id', cid).eq('pack_status', 'ready_for_review');
        if (rvId) coPackQ = coPackQ.eq('reviewer_team_member_id', rvId);

        const [indRes, coRes, provRes, indCalcRes, coCalcRes, indPackRes, coPackRes, membersRes] =
            await Promise.all([
                wantInd     ? indQ.limit(100)     : Promise.resolve({ data: [] }),
                wantCo      ? coQ.limit(100)      : Promise.resolve({ data: [] }),
                wantProv    ? provQ.limit(100)    : Promise.resolve({ data: [] }),
                wantIndCalc ? indCalcQ.limit(100) : Promise.resolve({ data: [] }),
                wantCoCalc  ? coCalcQ.limit(100)  : Promise.resolve({ data: [] }),
                wantIndPack ? indPackQ.limit(100) : Promise.resolve({ data: [] }),
                wantCoPack  ? coPackQ.limit(100)  : Promise.resolve({ data: [] }),
                supabase.from('practice_team_members').select('id, display_name').eq('company_id', cid),
            ]);

        const memberMap = {};
        (membersRes.data || []).forEach(m => { memberMap[m.id] = m.display_name; });

        const rows = [];

        (indRes.data || []).forEach(r => rows.push({
            source_type: 'individual_return', source_id: r.id,
            client_name: r.clients?.display_name || r.clients?.company_name || '—',
            return_name: r.return_name, tax_year: r.tax_year, status: r.status,
            readiness_status: r.readiness_status || null,
            reviewer: r.reviewer_team_member_id ? (memberMap[r.reviewer_team_member_id] || 'Member #' + r.reviewer_team_member_id) : null,
            reviewer_id: r.reviewer_team_member_id || null,
            warning_count: 0, due_date: null,
        }));

        (coRes.data || []).forEach(r => rows.push({
            source_type: 'company_return', source_id: r.id,
            client_name: r.clients?.display_name || r.clients?.company_name || '—',
            return_name: r.return_name, tax_year: r.tax_year, status: r.status,
            readiness_status: r.readiness_status || null,
            reviewer: r.reviewer_team_member_id ? (memberMap[r.reviewer_team_member_id] || 'Member #' + r.reviewer_team_member_id) : null,
            reviewer_id: r.reviewer_team_member_id || null,
            warning_count: 0, due_date: null,
        }));

        (provRes.data || []).forEach(r => rows.push({
            source_type: 'provisional_plan', source_id: r.id,
            client_name: r.clients?.display_name || r.clients?.company_name || '—',
            return_name: r.plan_name, tax_year: r.tax_year, status: r.status,
            readiness_status: null,
            reviewer: r.reviewer_team_member_id ? (memberMap[r.reviewer_team_member_id] || 'Member #' + r.reviewer_team_member_id) : null,
            reviewer_id: r.reviewer_team_member_id || null,
            warning_count: 0, due_date: null,
        }));

        (indCalcRes.data || []).forEach(r => rows.push({
            source_type: 'individual_calculation', source_id: r.id,
            client_name: '—', return_name: r.calculation_name, tax_year: r.tax_year,
            status: r.calculation_status, readiness_status: null,
            reviewer: null, reviewer_id: null,
            warning_count: Array.isArray(r.warning_flags) ? r.warning_flags.length : 0,
            due_date: null,
        }));

        (coCalcRes.data || []).forEach(r => rows.push({
            source_type: 'company_calculation', source_id: r.id,
            client_name: '—', return_name: r.calculation_name, tax_year: r.tax_year,
            status: r.calculation_status, readiness_status: null,
            reviewer: null, reviewer_id: null,
            warning_count: Array.isArray(r.warning_flags) ? r.warning_flags.length : 0,
            due_date: null,
        }));

        (indPackRes.data || []).forEach(r => rows.push({
            source_type: 'individual_review_pack', source_id: r.id,
            client_name: '—', return_name: r.pack_name, tax_year: r.tax_year,
            status: r.pack_status, readiness_status: null,
            reviewer: r.reviewer_team_member_id ? (memberMap[r.reviewer_team_member_id] || 'Member #' + r.reviewer_team_member_id) : null,
            reviewer_id: r.reviewer_team_member_id || null,
            warning_count: 0, due_date: null,
        }));

        (coPackRes.data || []).forEach(r => rows.push({
            source_type: 'company_review_pack', source_id: r.id,
            client_name: '—', return_name: r.pack_name, tax_year: r.tax_year,
            status: r.pack_status, readiness_status: null,
            reviewer: r.reviewer_team_member_id ? (memberMap[r.reviewer_team_member_id] || 'Member #' + r.reviewer_team_member_id) : null,
            reviewer_id: r.reviewer_team_member_id || null,
            warning_count: 0, due_date: null,
        }));

        rows.sort((a, b) => (b.tax_year || 0) - (a.tax_year || 0) || a.client_name.localeCompare(b.client_name));
        res.json({ review_queue: rows, total: rows.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /from-dashboard-risk ────────────────────────────────────────────────
// Convenience: create an action directly from a risk item on the tax dashboard.
// Validates source ownership, logs event.

router.post('/from-dashboard-risk', async (req, res) => {
    const cid = req.companyId;
    const {
        source_type, source_id, action_type, action_title,
        assigned_team_member_id, due_date, notes, client_id,
    } = req.body;

    if (!source_type || !SOURCE_TYPES.includes(source_type))
        return res.status(400).json({ error: 'Invalid or missing source_type' });
    if (!source_id)
        return res.status(400).json({ error: 'source_id is required' });
    if (!action_type || !ACTION_TYPES.includes(action_type))
        return res.status(400).json({ error: 'Invalid or missing action_type' });
    if (!action_title?.trim())
        return res.status(400).json({ error: 'action_title is required' });

    // Validate source record belongs to company (if we have a table for this source_type)
    const srcMeta = SOURCE_MAP[source_type];
    if (srcMeta) {
        const ok = await verifyOwn(cid, srcMeta.table, source_id);
        if (!ok) return res.status(400).json({ error: 'Source record not found in this company' });
    }

    const [memberOk, clientOk] = await Promise.all([
        verifyOwn(cid, 'practice_team_members', assigned_team_member_id),
        verifyOwn(cid, 'practice_clients', client_id),
    ]);
    if (!memberOk) return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });
    if (!clientOk) return res.status(400).json({ error: 'client_id not found in this company' });

    try {
        const { data, error } = await supabase.from('practice_tax_work_actions').insert({
            company_id:               cid,
            client_id:                client_id              ? parseInt(client_id)              : null,
            source_type,
            source_id:                parseInt(source_id),
            action_type,
            action_title:             action_title.trim(),
            action_status:            'open',
            assigned_team_member_id:  assigned_team_member_id ? parseInt(assigned_team_member_id) : null,
            due_date:                 due_date || null,
            notes:                    notes    || null,
            created_by:               req.user?.id || null,
        }).select().single();
        if (error) throw error;

        await logEvent(cid, data.id, 'tax_action_created', {
            new_status: 'open', actor_user_id: req.user?.id,
            metadata: { source_type, source_id, action_type },
        });
        res.status(201).json({ action: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/create-task ────────────────────────────────────────────────────
// Creates a practice_task linked to this action's client.

router.post('/:id/create-task', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Cannot execute a cancelled action' });
    if (action.linked_task_id) return res.status(400).json({ error: 'A task is already linked to this action' });
    if (!action.client_id) return res.status(400).json({ error: 'Action must have a client_id to create a task' });

    const { task_title, task_notes, task_type, due_date, assigned_team_member_id } = req.body;
    const title = (task_title || action.action_title).trim();
    const validTypes = ['general','vat_return','tax_return','annual_financial','payroll','audit','bookkeeping','secretarial','other'];
    const resolvedType = task_type && validTypes.includes(task_type) ? task_type : 'tax_return';

    const memberOk = await verifyOwn(cid, 'practice_team_members', assigned_team_member_id);
    if (!memberOk) return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });

    try {
        const { data: task, error: tErr } = await supabase.from('practice_tasks').insert({
            company_id:                 cid,
            client_id:                  action.client_id,
            title,
            description:                task_notes || action.notes || null,
            type:                       resolvedType,
            priority:                   'medium',
            status:                     'open',
            due_date:                   due_date || action.due_date || null,
            reviewer_team_member_id:    assigned_team_member_id ? parseInt(assigned_team_member_id) : null,
            created_by:                 req.user?.id || null,
            notes:                      task_notes || action.notes || null,
            review_status:              'not_required',
            approval_status:            'not_required',
            qa_status:                  'none',
        }).select().single();
        if (tErr) throw tErr;

        const { error: uErr } = await supabase.from('practice_tax_work_actions')
            .update({ linked_task_id: task.id, action_status: 'in_progress', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (uErr) throw uErr;

        await logEvent(cid, actionId, 'tax_action_task_created', {
            old_status: action.action_status, new_status: 'in_progress',
            actor_user_id: req.user?.id,
            metadata: { task_id: task.id, task_title: title },
        });
        res.status(201).json({ task, action_id: actionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/create-document-request ────────────────────────────────────────
// Creates a practice_document_request linked to this action.

router.post('/:id/create-document-request', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Cannot execute a cancelled action' });
    if (action.linked_document_request_id) return res.status(400).json({ error: 'A document request is already linked to this action' });
    if (!action.client_id) return res.status(400).json({ error: 'Action must have a client_id to create a document request' });

    const { request_title, document_category, required_by_date, assigned_team_member_id, notes } = req.body;
    const title    = (request_title || action.action_title).trim();
    const category = document_category && DOC_CATEGORIES.includes(document_category) ? document_category : 'tax';

    const memberOk = await verifyOwn(cid, 'practice_team_members', assigned_team_member_id);
    if (!memberOk) return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });

    try {
        const { data: docReq, error: dErr } = await supabase.from('practice_document_requests').insert({
            company_id:              cid,
            client_id:               action.client_id,
            request_title:           title,
            document_category:       category,
            request_status:          'requested',
            required_by_date:        required_by_date || action.due_date || null,
            assigned_team_member_id: assigned_team_member_id ? parseInt(assigned_team_member_id) : null,
            notes:                   notes || action.notes || null,
            created_by:              req.user?.id || null,
        }).select().single();
        if (dErr) throw dErr;

        const { error: uErr } = await supabase.from('practice_tax_work_actions')
            .update({ linked_document_request_id: docReq.id, action_status: 'in_progress', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (uErr) throw uErr;

        await logEvent(cid, actionId, 'tax_action_document_request_created', {
            old_status: action.action_status, new_status: 'in_progress',
            actor_user_id: req.user?.id,
            metadata: { document_request_id: docReq.id, request_title: title, document_category: category },
        });
        res.status(201).json({ document_request: docReq, action_id: actionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/assign-reviewer ────────────────────────────────────────────────
// Assigns a reviewer to the source return/plan. Supported for: individual_return,
// company_return, provisional_plan. Other source_types return 400 (no reviewer field).

router.post('/:id/assign-reviewer', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Cannot execute a cancelled action' });

    const srcMeta = SOURCE_MAP[action.source_type];
    if (!srcMeta?.reviewerField) {
        return res.status(400).json({ error: `source_type '${action.source_type}' does not support reviewer assignment` });
    }

    const { reviewer_team_member_id } = req.body;
    if (!reviewer_team_member_id) return res.status(400).json({ error: 'reviewer_team_member_id is required' });

    const memberOk = await verifyOwn(cid, 'practice_team_members', reviewer_team_member_id);
    if (!memberOk) return res.status(400).json({ error: 'reviewer_team_member_id not found in this company' });

    // Verify source belongs to company
    const srcOk = await verifyOwn(cid, srcMeta.table, action.source_id);
    if (!srcOk) return res.status(400).json({ error: 'Source record not found in this company' });

    try {
        const { error: sErr } = await supabase.from(srcMeta.table)
            .update({ reviewer_team_member_id: parseInt(reviewer_team_member_id), updated_at: now() })
            .eq('id', action.source_id).eq('company_id', cid);
        if (sErr) throw sErr;

        const { error: uErr } = await supabase.from('practice_tax_work_actions')
            .update({ action_status: 'in_progress', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (uErr) throw uErr;

        await logEvent(cid, actionId, 'tax_action_reviewer_assigned', {
            old_status: action.action_status, new_status: 'in_progress',
            actor_user_id: req.user?.id,
            metadata: { source_type: action.source_type, source_id: action.source_id, reviewer_team_member_id: parseInt(reviewer_team_member_id) },
        });
        res.json({ ok: true, reviewer_team_member_id: parseInt(reviewer_team_member_id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/mark-ready-review ─────────────────────────────────────────────
// Marks the source record as ready_for_review. Supported for all return,
// calculation, and review pack source types. Not supported for compliance_deadline,
// document_request, or tax_dashboard_risk.

router.post('/:id/mark-ready-review', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Cannot execute a cancelled action' });

    const srcMeta = SOURCE_MAP[action.source_type];
    if (!srcMeta) {
        return res.status(400).json({ error: `source_type '${action.source_type}' does not support ready-for-review marking` });
    }

    const readyStatus = READY_STATUS[action.source_type];
    if (!readyStatus) {
        return res.status(400).json({ error: `No ready_for_review status defined for source_type '${action.source_type}'` });
    }

    // Fetch source to check current status
    const { data: src } = await supabase.from(srcMeta.table)
        .select('id, ' + srcMeta.statusField)
        .eq('id', action.source_id).eq('company_id', cid).single();
    if (!src) return res.status(400).json({ error: 'Source record not found in this company' });

    const currentStatus = src[srcMeta.statusField];
    const terminal = ['cancelled', 'completed', 'submitted', 'approved'];
    if (terminal.includes(currentStatus)) {
        return res.status(400).json({ error: `Cannot mark '${currentStatus}' source as ready_for_review` });
    }
    if (currentStatus === readyStatus) {
        return res.status(400).json({ error: 'Source is already in ready_for_review status' });
    }

    try {
        const upd = { updated_at: now(), [srcMeta.statusField]: readyStatus };
        const { error: sErr } = await supabase.from(srcMeta.table)
            .update(upd).eq('id', action.source_id).eq('company_id', cid);
        if (sErr) throw sErr;

        const { error: uErr } = await supabase.from('practice_tax_work_actions')
            .update({ action_status: 'in_progress', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (uErr) throw uErr;

        await logEvent(cid, actionId, 'tax_work_marked_ready_review', {
            old_status: action.action_status, new_status: 'in_progress',
            actor_user_id: req.user?.id,
            metadata: { source_type: action.source_type, source_id: action.source_id, previous_source_status: currentStatus },
        });
        res.json({ ok: true, source_new_status: readyStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /:id/complete ────────────────────────────────────────────────────────

router.put('/:id/complete', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (['completed', 'cancelled'].includes(action.action_status))
        return res.status(400).json({ error: `Action is already ${action.action_status}` });

    try {
        const { error } = await supabase.from('practice_tax_work_actions')
            .update({ action_status: 'completed', completed_at: now(), completed_by: req.user?.id || null, updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, actionId, 'tax_action_completed', {
            old_status: action.action_status, new_status: 'completed',
            actor_user_id: req.user?.id, notes: req.body.notes || null,
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /:id/dismiss ─────────────────────────────────────────────────────────

router.put('/:id/dismiss', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (['completed', 'cancelled', 'dismissed'].includes(action.action_status))
        return res.status(400).json({ error: `Action is already ${action.action_status}` });

    try {
        const { error } = await supabase.from('practice_tax_work_actions')
            .update({ action_status: 'dismissed', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, actionId, 'tax_action_dismissed', {
            old_status: action.action_status, new_status: 'dismissed',
            actor_user_id: req.user?.id, notes: req.body.notes || null,
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET / ────────────────────────────────────────────────────────────────────
// List with filters. Enriches with assigned member name.

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        source_type, action_status, action_type,
        assigned_team_member_id, client_id,
        due_from, due_to,
        page: rawPage = 1, limit: rawLimit = 50,
    } = req.query;

    const limit  = Math.min(parseInt(rawLimit) || 50, 200);
    const offset = (Math.max(parseInt(rawPage) || 1, 1) - 1) * limit;

    try {
        let q = supabase.from('practice_tax_work_actions')
            .select('*, assignee:practice_team_members!assigned_team_member_id(display_name)', { count: 'exact' })
            .eq('company_id', cid)
            .not('action_status', 'in', '(cancelled)');

        if (source_type)               q = q.eq('source_type', source_type);
        if (action_status)             q = q.eq('action_status', action_status);
        if (action_type)               q = q.eq('action_type', action_type);
        if (assigned_team_member_id)   q = q.eq('assigned_team_member_id', parseInt(assigned_team_member_id));
        if (client_id)                 q = q.eq('client_id', parseInt(client_id));
        if (due_from)                  q = q.gte('due_date', due_from);
        if (due_to)                    q = q.lte('due_date', due_to);

        const { data, error, count } = await q
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw error;

        res.json({ actions: data || [], total: count || 0, page: parseInt(rawPage) || 1, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST / ────────────────────────────────────────────────────────────────────
// Create action.

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        source_type, source_id, action_type, action_title,
        client_id, assigned_team_member_id, due_date, notes,
    } = req.body;

    if (!source_type || !SOURCE_TYPES.includes(source_type))
        return res.status(400).json({ error: 'Invalid or missing source_type' });
    if (!source_id)
        return res.status(400).json({ error: 'source_id is required' });
    if (!action_type || !ACTION_TYPES.includes(action_type))
        return res.status(400).json({ error: 'Invalid or missing action_type' });
    if (!action_title?.trim())
        return res.status(400).json({ error: 'action_title is required' });

    const [memberOk, clientOk] = await Promise.all([
        verifyOwn(cid, 'practice_team_members', assigned_team_member_id),
        verifyOwn(cid, 'practice_clients', client_id),
    ]);
    if (!memberOk) return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });
    if (!clientOk) return res.status(400).json({ error: 'client_id not found in this company' });

    try {
        const { data, error } = await supabase.from('practice_tax_work_actions').insert({
            company_id:               cid,
            client_id:                client_id              ? parseInt(client_id)              : null,
            source_type, source_id: parseInt(source_id),
            action_type, action_title: action_title.trim(),
            action_status:            'open',
            assigned_team_member_id:  assigned_team_member_id ? parseInt(assigned_team_member_id) : null,
            due_date:                 due_date || null,
            notes:                    notes    || null,
            created_by:               req.user?.id || null,
        }).select().single();
        if (error) throw error;

        await logEvent(cid, data.id, 'tax_action_created', {
            new_status: 'open', actor_user_id: req.user?.id,
            metadata: { source_type, source_id, action_type },
        });
        res.status(201).json({ action: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Cannot update a cancelled action' });

    const allowed = ['action_title', 'action_status', 'assigned_team_member_id', 'due_date', 'notes'];
    const updates = { updated_at: now(), updated_by: req.user?.id || null };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.action_status && !ACTION_STATUSES.includes(updates.action_status))
        return res.status(400).json({ error: 'Invalid action_status' });

    if (updates.assigned_team_member_id) {
        const ok = await verifyOwn(cid, 'practice_team_members', updates.assigned_team_member_id);
        if (!ok) return res.status(400).json({ error: 'assigned_team_member_id not found in this company' });
        updates.assigned_team_member_id = parseInt(updates.assigned_team_member_id);
    }

    try {
        const { data, error } = await supabase.from('practice_tax_work_actions')
            .update(updates).eq('id', actionId).eq('company_id', cid).select().single();
        if (error) throw error;

        await logEvent(cid, actionId, 'tax_action_updated', {
            old_status: action.action_status, new_status: data.action_status,
            actor_user_id: req.user?.id,
        });
        res.json({ action: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /:id (soft cancel) ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid      = req.companyId;
    const actionId = parseInt(req.params.id);
    const action   = await fetchAction(cid, actionId);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.action_status === 'cancelled') return res.status(400).json({ error: 'Action already cancelled' });

    try {
        const { error } = await supabase.from('practice_tax_work_actions')
            .update({ action_status: 'cancelled', updated_at: now(), updated_by: req.user?.id || null })
            .eq('id', actionId).eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, actionId, 'tax_action_cancelled', {
            old_status: action.action_status, new_status: 'cancelled',
            actor_user_id: req.user?.id,
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
