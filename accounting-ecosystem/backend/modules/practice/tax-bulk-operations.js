/**
 * ============================================================
 * Practice Tax Bulk Operations (Codebox 37)
 * ============================================================
 * User-triggered bulk preparation for tax season.
 * NOT cron automation. NOT background execution. NOT SARS/eFiling.
 * All operations are inline, synchronous, and user-approved.
 * ============================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }      = require('../../config/database');
const { auditFromReq }  = require('../../middleware/audit');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

router.use(authenticateToken);
router.use(requireCompany);

// ── Constants ─────────────────────────────────────────────────────────────────

const OPERATION_TYPES = [
    'create_compliance_packs', 'apply_tax_checklist', 'create_document_requests',
    'assign_tax_owners', 'assign_reviewers', 'create_tax_actions', 'mixed_tax_season_setup',
];

const OPERATION_STATUSES = [
    'draft', 'previewed', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled',
];

const RUNNABLE_STATUSES = ['draft', 'previewed'];

const DOC_CATEGORIES = [
    'identity', 'tax', 'vat', 'payroll', 'accounting', 'banking', 'cipc', 'trust',
    'legal', 'compliance', 'financials', 'supporting_docs', 'custom',
];

const CAT_TO_DOC_CATEGORY = {
    document: 'supporting_docs', tax_data: 'tax', review: 'supporting_docs',
    compliance: 'compliance', calculation: 'accounting', approval: 'supporting_docs', custom: 'custom',
};

function now() { return new Date().toISOString(); }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logBulkEvent(cid, opId, eventType, userId, notes, meta) {
    await supabase.from('practice_tax_bulk_operation_events').insert({
        company_id: cid, operation_id: opId, event_type: eventType,
        actor_user_id: userId || null, notes: notes || null, metadata: meta || {},
    });
}

async function verifyOwn(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase.from(table).select('id').eq('company_id', cid).eq('id', parseInt(id)).maybeSingle();
    return !!data;
}

function resolveDocCategory(item) {
    const fromSettings = item.settings && item.settings.document_category;
    if (fromSettings && DOC_CATEGORIES.includes(fromSettings)) return fromSettings;
    return CAT_TO_DOC_CATEGORY[item.item_category] || 'supporting_docs';
}

// ── Preview Builder ───────────────────────────────────────────────────────────

async function buildPreviewData(cid, { operation_type, tax_year, filters, options }) {
    filters = filters || {};
    options = options || {};

    // Base client query
    let q = supabase.from('practice_clients')
        .select('id, name, client_type, responsible_team_member_id')
        .eq('company_id', cid)
        .eq('is_active', true);

    if (filters.client_type) q = q.eq('client_type', filters.client_type);
    if (filters.responsible_team_member_id)
        q = q.eq('responsible_team_member_id', parseInt(filters.responsible_team_member_id));

    const { data: baseClients, error: cErr } = await q.order('name');
    if (cErr) throw new Error(cErr.message);

    let clients = baseClients || [];
    const warnings = [];

    // Complex filter: provisional_taxpayer
    if (filters.provisional_taxpayer === true || filters.provisional_taxpayer === 'true') {
        const { data: profiles } = await supabase.from('practice_taxpayer_profiles')
            .select('client_id, provisional_taxpayer').eq('company_id', cid);
        const provIds = new Set(
            (profiles || []).filter(p => p.provisional_taxpayer).map(p => p.client_id)
        );
        clients = clients.filter(c => provIds.has(c.id));
    }

    // Complex filter: has_taxpayer_profile
    if (filters.has_taxpayer_profile === true || filters.has_taxpayer_profile === 'true') {
        const { data: profiles } = await supabase.from('practice_taxpayer_profiles')
            .select('client_id').eq('company_id', cid);
        const profileIds = new Set((profiles || []).map(p => p.client_id));
        clients = clients.filter(c => profileIds.has(c.id));
    }

    // Complex filter: has_active_engagement
    if (filters.has_active_engagement === true || filters.has_active_engagement === 'true') {
        const { data: engs } = await supabase.from('practice_client_engagements')
            .select('client_id').eq('company_id', cid).in('status', ['active', 'pending']);
        const engIds = new Set((engs || []).map(e => e.client_id));
        clients = clients.filter(c => engIds.has(c.id));
    }

    // Complex filter: missing_compliance_pack
    if (filters.missing_compliance_pack === true || filters.missing_compliance_pack === 'true') {
        const packType = options.compliance_pack_type;
        let packQ = supabase.from('practice_compliance_packs')
            .select('client_id').eq('company_id', cid).not('status', 'eq', 'cancelled');
        if (packType) packQ = packQ.eq('pack_type', packType);
        if (tax_year)  packQ = packQ.eq('tax_year', parseInt(tax_year));
        const { data: existingPacks } = await packQ;
        const hasPackIds = new Set((existingPacks || []).map(p => p.client_id));
        clients = clients.filter(c => !hasPackIds.has(c.id));
    }

    // Estimated outputs
    const count = clients.length;
    const estimated = { packs: 0, doc_requests: 0, actions: 0, assignments: 0 };

    if (['create_compliance_packs', 'mixed_tax_season_setup'].includes(operation_type))
        estimated.packs = count;

    if (['apply_tax_checklist', 'create_document_requests', 'mixed_tax_season_setup'].includes(operation_type)) {
        if (options.checklist_template_id) {
            const { count: itemCount } = await supabase.from('practice_tax_checklist_template_items')
                .select('id', { count: 'exact', head: true })
                .eq('template_id', parseInt(options.checklist_template_id))
                .eq('target_type', 'document_request');
            estimated.doc_requests = count * (itemCount || 5);
        } else {
            estimated.doc_requests = count * 5;
        }
    }

    if (operation_type === 'create_tax_actions') estimated.actions = count;
    if (['assign_tax_owners', 'assign_reviewers'].includes(operation_type)) estimated.assignments = count;

    // Warnings
    if (count === 0)
        warnings.push('No clients match the selected filters.');
    if (count > 100)
        warnings.push(`Large operation: ${count} clients will be processed.`);
    if (['apply_tax_checklist', 'create_document_requests', 'mixed_tax_season_setup'].includes(operation_type) && !options.checklist_template_id)
        warnings.push('No checklist template selected — no document requests will be created.');
    if (['assign_tax_owners'].includes(operation_type) && !options.assign_responsible_team_member_id)
        warnings.push('No owner team member selected.');
    if (['assign_reviewers'].includes(operation_type) && !options.assign_reviewer_team_member_id)
        warnings.push('No reviewer team member selected.');
    if (operation_type === 'create_tax_actions' && !options.action_type)
        warnings.push('No action type selected — general_followup will be used.');

    return { clients, warnings, estimated_outputs: estimated, client_count: count };
}

// ── Execute Sub-Functions ─────────────────────────────────────────────────────

async function _executeCreatePack(cid, client, options, taxYear, userId, result) {
    const packType = options.compliance_pack_type || 'individual_tax';
    const yr = taxYear ? parseInt(taxYear) : null;
    const packName = options.pack_name ||
        `${packType.replace(/_/g, ' ')} ${yr || new Date().getFullYear()} — ${client.name}`;

    let checkQ = supabase.from('practice_compliance_packs')
        .select('id').eq('company_id', cid).eq('client_id', client.id)
        .eq('pack_type', packType).not('status', 'eq', 'cancelled');
    if (yr) checkQ = checkQ.eq('tax_year', yr);
    const { data: existing } = await checkQ;

    if (existing && existing.length > 0) {
        result.created_records.pack_skipped = true;
        result.created_records.existing_pack_id = existing[0].id;
        return;
    }

    const { data: pack, error } = await supabase.from('practice_compliance_packs').insert({
        company_id:              cid,
        client_id:               client.id,
        pack_type:               packType,
        pack_name:               packName,
        tax_year:                yr,
        period_start:            options.pack_period_start || null,
        period_end:              options.pack_period_end   || null,
        status:                  'draft',
        readiness_status:        'unknown',
        owner_team_member_id:    options.assign_responsible_team_member_id
                                     ? parseInt(options.assign_responsible_team_member_id) : null,
        reviewer_team_member_id: options.assign_reviewer_team_member_id
                                     ? parseInt(options.assign_reviewer_team_member_id)    : null,
        created_by:              userId || null,
    }).select().single();

    if (error) throw new Error(error.message);
    result.created_records.pack_id       = pack.id;
    result.created_records.packs_created = (result.created_records.packs_created || 0) + 1;
}

async function _executeApplyChecklist(cid, client, options, templateItems, taxYear, userId, result, warnings) {
    const docItems = templateItems.filter(i => i.target_type === 'document_request');
    const nonDocItems = templateItems.filter(i => i.target_type !== 'document_request');

    if (nonDocItems.length > 0)
        warnings.push(`${nonDocItems.length} non-document template item(s) skipped in bulk mode`);
    if (!docItems.length) {
        warnings.push('Template has no document_request items');
        return;
    }

    const dueDate = options.due_date || null;

    const { data: existing } = await supabase.from('practice_document_requests')
        .select('request_title').eq('company_id', cid).eq('client_id', client.id);
    const existingTitles = new Set((existing || []).map(r => r.request_title.toLowerCase()));

    let created = 0, skipped = 0;
    for (const item of docItems) {
        if (existingTitles.has(item.item_name.toLowerCase())) { skipped++; continue; }
        const docCat = resolveDocCategory(item);
        const reqDate = dueDate || (item.default_due_offset_days
            ? new Date(Date.now() + item.default_due_offset_days * 86400000).toISOString().slice(0, 10)
            : null);

        const { error } = await supabase.from('practice_document_requests').insert({
            company_id:          cid,
            client_id:           client.id,
            request_title:       item.item_name,
            request_description: item.item_description || null,
            document_category:   docCat,
            required_by_date:    reqDate,
            request_status:      'requested',
            requested_at:        now(),
            created_by:          userId || null,
        });
        if (!error) { created++; existingTitles.add(item.item_name.toLowerCase()); }
    }

    result.created_records.doc_requests_created = (result.created_records.doc_requests_created || 0) + created;
    result.created_records.doc_requests_skipped = (result.created_records.doc_requests_skipped || 0) + skipped;
}

async function _executeCreateDocRequests(cid, client, options, templateItems, taxYear, userId, result) {
    const warnings = [];
    await _executeApplyChecklist(cid, client, options, templateItems, taxYear, userId, result, warnings);
    if (warnings.length) result.message = (result.message ? result.message + '; ' : '') + warnings.join('; ');
}

async function _executeAssignOwner(cid, client, options, result) {
    const newOwnerId = options.assign_responsible_team_member_id
        ? parseInt(options.assign_responsible_team_member_id) : null;
    if (!newOwnerId) return;

    if (client.responsible_team_member_id && !options.override_existing) {
        result.created_records.owner_skipped = true;
        return;
    }

    const { error } = await supabase.from('practice_clients')
        .update({ responsible_team_member_id: newOwnerId, updated_at: now() })
        .eq('company_id', cid).eq('id', client.id);
    if (error) throw new Error(error.message);
    result.created_records.owner_assigned = true;
}

async function _executeAssignReviewer(cid, client, options, taxYear, result) {
    const newReviewerId = options.assign_reviewer_team_member_id
        ? parseInt(options.assign_reviewer_team_member_id) : null;
    if (!newReviewerId) return;

    const yr = taxYear ? parseInt(taxYear) : null;
    let updated = 0;

    // Individual tax returns
    let indQ = supabase.from('practice_individual_tax_returns')
        .select('id, reviewer_team_member_id').eq('company_id', cid).eq('client_id', client.id);
    if (yr) indQ = indQ.eq('tax_year', yr);
    const { data: indReturns } = await indQ;
    for (const r of (indReturns || [])) {
        if (r.reviewer_team_member_id && !options.override_existing) continue;
        await supabase.from('practice_individual_tax_returns')
            .update({ reviewer_team_member_id: newReviewerId, updated_at: now() })
            .eq('id', r.id);
        updated++;
    }

    // Company tax returns
    let coQ = supabase.from('practice_company_tax_returns')
        .select('id, reviewer_team_member_id').eq('company_id', cid).eq('client_id', client.id);
    if (yr) coQ = coQ.eq('tax_year', yr);
    const { data: coReturns } = await coQ;
    for (const r of (coReturns || [])) {
        if (r.reviewer_team_member_id && !options.override_existing) continue;
        await supabase.from('practice_company_tax_returns')
            .update({ reviewer_team_member_id: newReviewerId, updated_at: now() })
            .eq('id', r.id);
        updated++;
    }

    result.created_records.reviewer_assignments = (result.created_records.reviewer_assignments || 0) + updated;
}

async function _executeCreateAction(cid, client, options, taxYear, userId, result) {
    const actionType  = options.action_type  || 'general_followup';
    const actionTitle = options.action_title ||
        `Tax season follow-up — ${client.name}${taxYear ? ' ' + taxYear : ''}`;
    const dueDate = options.due_date || null;

    const { data: existing } = await supabase.from('practice_tax_work_actions')
        .select('id').eq('company_id', cid).eq('client_id', client.id)
        .eq('action_type', actionType).eq('action_status', 'open');
    if (existing && existing.length > 0) {
        result.created_records.action_skipped = true;
        return;
    }

    const { data: action, error } = await supabase.from('practice_tax_work_actions').insert({
        company_id:    cid,
        client_id:     client.id,
        action_type:   actionType,
        action_title:  actionTitle,
        action_status: 'open',
        due_date:      dueDate,
        source_type:   'bulk_operation',
        created_by:    userId || null,
        created_at:    now(),
        updated_at:    now(),
    }).select().single();

    if (error) throw new Error(error.message);
    result.created_records.action_id      = action.id;
    result.created_records.actions_created = (result.created_records.actions_created || 0) + 1;
}

// ── Execute Engine ────────────────────────────────────────────────────────────

async function executeOperation(cid, op, userId) {
    const { id: opId, operation_type, tax_year, options = {}, preview_snapshot = {} } = op;
    const previewClients = preview_snapshot.clients || [];
    const clientIds = previewClients.map(c => c.id).filter(Boolean);

    if (!clientIds.length) {
        return { total: 0, created: 0, skipped: 0, failed: 0, warnings: 0 };
    }

    // Fetch current client rows to get latest responsible_team_member_id etc.
    const { data: clients } = await supabase.from('practice_clients')
        .select('id, name, client_type, responsible_team_member_id')
        .eq('company_id', cid).in('id', clientIds);

    // Pre-load template items if needed
    let templateItems = [];
    if (['apply_tax_checklist', 'create_document_requests', 'mixed_tax_season_setup'].includes(operation_type)
        && options.checklist_template_id) {
        const { data: items } = await supabase.from('practice_tax_checklist_template_items')
            .select('*').eq('template_id', parseInt(options.checklist_template_id))
            .order('sort_order', { ascending: true, nullsFirst: false });
        templateItems = items || [];
    }

    let totalCreated = 0, totalSkipped = 0, totalFailed = 0, totalWarnings = 0;
    const itemRows = [];

    for (const client of (clients || [])) {
        const itemResult = {
            company_id:      cid,
            operation_id:    opId,
            client_id:       client.id,
            item_status:     'pending',
            created_records: {},
            message:         null,
            error_detail:    null,
            created_at:      now(),
            updated_at:      now(),
        };
        const itemWarnings = [];

        try {
            if (['create_compliance_packs', 'mixed_tax_season_setup'].includes(operation_type))
                await _executeCreatePack(cid, client, options, tax_year, userId, itemResult);

            if (['apply_tax_checklist', 'mixed_tax_season_setup'].includes(operation_type))
                await _executeApplyChecklist(cid, client, options, templateItems, tax_year, userId, itemResult, itemWarnings);

            if (operation_type === 'create_document_requests')
                await _executeCreateDocRequests(cid, client, options, templateItems, tax_year, userId, itemResult);

            if (operation_type === 'assign_tax_owners')
                await _executeAssignOwner(cid, client, options, itemResult);

            if (operation_type === 'assign_reviewers')
                await _executeAssignReviewer(cid, client, options, tax_year, itemResult);

            if (operation_type === 'create_tax_actions')
                await _executeCreateAction(cid, client, options, tax_year, userId, itemResult);

            if (itemWarnings.length > 0) {
                itemResult.item_status = 'warning';
                itemResult.message     = itemWarnings.join('; ');
                totalWarnings++;
            } else {
                itemResult.item_status = 'success';
                totalCreated++;
            }
        } catch (err) {
            itemResult.item_status  = 'failed';
            itemResult.error_detail = err.message;
            itemResult.message      = 'Error: ' + err.message;
            totalFailed++;
        }

        itemRows.push(itemResult);
    }

    // Bulk insert items
    if (itemRows.length > 0)
        await supabase.from('practice_tax_bulk_operation_items').insert(itemRows);

    const total = (clients || []).length;
    return {
        total,
        created:  totalCreated,
        skipped:  totalSkipped,
        failed:   totalFailed,
        warnings: totalWarnings,
    };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET / — list operations
router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { operation_type, operation_status, tax_year, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let q = supabase.from('practice_tax_bulk_operations')
        .select('id, operation_name, operation_type, operation_status, tax_year, result_summary, created_by, created_at, started_at, completed_at')
        .eq('company_id', cid);

    if (operation_type && OPERATION_TYPES.includes(operation_type))
        q = q.eq('operation_type', operation_type);
    if (operation_status && OPERATION_STATUSES.includes(operation_status))
        q = q.eq('operation_status', operation_status);
    if (tax_year) q = q.eq('tax_year', parseInt(tax_year));

    const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ operations: data || [] });
});

// POST /preview — build preview (does NOT save to DB)
router.post('/preview', async (req, res) => {
    const cid = req.companyId;
    const { operation_name, operation_type, tax_year, filters, options } = req.body;

    if (!operation_type || !OPERATION_TYPES.includes(operation_type))
        return res.status(400).json({ error: `operation_type must be one of: ${OPERATION_TYPES.join(', ')}` });

    try {
        const preview = await buildPreviewData(cid, { operation_type, tax_year, filters, options });
        res.json({
            operation_name: operation_name || operation_type.replace(/_/g, ' '),
            operation_type,
            tax_year: tax_year || null,
            source_filter: filters || {},
            options: options || {},
            ...preview,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST / — create/save operation (with preview_snapshot already built by client)
router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        operation_name, operation_type, tax_year, filters, options, preview_snapshot,
    } = req.body;

    if (!operation_name || !operation_name.trim())
        return res.status(400).json({ error: 'operation_name is required' });
    if (!operation_type || !OPERATION_TYPES.includes(operation_type))
        return res.status(400).json({ error: `operation_type must be one of: ${OPERATION_TYPES.join(', ')}` });

    // Validate optional team member references
    const [ownerOk, reviewerOk] = await Promise.all([
        verifyOwn(cid, 'practice_team_members', options && options.assign_responsible_team_member_id),
        verifyOwn(cid, 'practice_team_members', options && options.assign_reviewer_team_member_id),
    ]);
    if (!ownerOk)    return res.status(400).json({ error: 'assign_responsible_team_member_id not found in this company' });
    if (!reviewerOk) return res.status(400).json({ error: 'assign_reviewer_team_member_id not found in this company' });

    const { data, error } = await supabase.from('practice_tax_bulk_operations').insert({
        company_id:       cid,
        operation_name:   operation_name.trim(),
        operation_type,
        operation_status: preview_snapshot && (preview_snapshot.clients || []).length > 0 ? 'previewed' : 'draft',
        tax_year:         tax_year ? parseInt(tax_year) : null,
        source_filter:    filters       && typeof filters       === 'object' ? filters       : {},
        options:          options       && typeof options        === 'object' ? options       : {},
        preview_snapshot: preview_snapshot && typeof preview_snapshot === 'object' ? preview_snapshot : {},
        created_by:       req.userId || null,
        created_at:       now(),
        updated_at:       now(),
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    await logBulkEvent(cid, data.id, 'bulk_operation_created', req.userId, null, { operation_type });
    await auditFromReq(req, 'CREATE', 'practice_tax_bulk_operation', data.id, { module: 'practice', operation_type });

    res.status(201).json({ operation: data });
});

// GET /:id/items — per-client results (before /:id)
router.get('/:id/items', async (req, res) => {
    const cid = req.companyId;
    const opId = parseInt(req.params.id);
    const { limit = 200 } = req.query;

    const opCheck = await supabase.from('practice_tax_bulk_operations')
        .select('id').eq('company_id', cid).eq('id', opId).maybeSingle();
    if (!opCheck.data) return res.status(404).json({ error: 'Operation not found' });

    const { data, error } = await supabase.from('practice_tax_bulk_operation_items')
        .select('id, client_id, item_status, message, created_records, error_detail, created_at, clients:practice_clients!client_id(name)')
        .eq('company_id', cid).eq('operation_id', opId)
        .order('created_at', { ascending: true }).limit(parseInt(limit));
    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map(i => ({
        ...i,
        client_name: i.clients ? i.clients.name : null,
        clients:     undefined,
    }));
    res.json({ items });
});

// GET /:id/events — audit log (before /:id)
router.get('/:id/events', async (req, res) => {
    const cid   = req.companyId;
    const opId  = parseInt(req.params.id);

    const opCheck = await supabase.from('practice_tax_bulk_operations')
        .select('id').eq('company_id', cid).eq('id', opId).maybeSingle();
    if (!opCheck.data) return res.status(404).json({ error: 'Operation not found' });

    const { data, error } = await supabase.from('practice_tax_bulk_operation_events')
        .select('*').eq('company_id', cid).eq('operation_id', opId)
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
});

// POST /:id/execute — run the operation (before /:id)
router.post('/:id/execute', async (req, res) => {
    const cid  = req.companyId;
    const opId = parseInt(req.params.id);

    const { data: op, error: opErr } = await supabase.from('practice_tax_bulk_operations')
        .select('*').eq('company_id', cid).eq('id', opId).maybeSingle();
    if (opErr || !op) return res.status(404).json({ error: 'Operation not found' });
    if (!RUNNABLE_STATUSES.includes(op.operation_status))
        return res.status(400).json({ error: `Cannot execute operation with status '${op.operation_status}'` });

    // Mark as running
    await supabase.from('practice_tax_bulk_operations')
        .update({ operation_status: 'running', started_at: now(), updated_at: now() })
        .eq('id', opId);

    await logBulkEvent(cid, opId, 'bulk_operation_executed', req.userId, null,
        { client_count: (op.preview_snapshot && (op.preview_snapshot.clients || []).length) || 0 });

    let summary;
    try {
        summary = await executeOperation(cid, op, req.userId);
    } catch (err) {
        await supabase.from('practice_tax_bulk_operations')
            .update({
                operation_status: 'failed',
                result_summary:   { error: err.message },
                completed_at:     now(), updated_at: now(),
            }).eq('id', opId);
        await logBulkEvent(cid, opId, 'bulk_operation_failed', req.userId, err.message, {});
        return res.status(500).json({ error: err.message });
    }

    const finalStatus = summary.failed === summary.total && summary.total > 0
        ? 'failed'
        : summary.failed > 0 || summary.warnings > 0
            ? 'completed_with_warnings'
            : 'completed';

    await supabase.from('practice_tax_bulk_operations')
        .update({
            operation_status: finalStatus,
            result_summary:   summary,
            completed_at:     now(),
            updated_at:       now(),
            updated_by:       req.userId || null,
        }).eq('id', opId);

    await logBulkEvent(cid, opId,
        finalStatus === 'failed' ? 'bulk_operation_failed' : 'bulk_operation_completed',
        req.userId, null, summary);
    await auditFromReq(req, 'UPDATE', 'practice_tax_bulk_operation', opId,
        { module: 'practice', final_status: finalStatus, summary });

    // Fetch items to return inline for the results panel
    const { data: items } = await supabase.from('practice_tax_bulk_operation_items')
        .select('id, client_id, item_status, message, error_detail, clients:practice_clients!client_id(name)')
        .eq('company_id', cid).eq('operation_id', opId)
        .order('created_at', { ascending: true });

    res.json({
        operation_status: finalStatus,
        result_summary:   summary,
        items: (items || []).map(i => ({
            ...i,
            client_name: i.clients ? i.clients.name : null,
            clients:     undefined,
        })),
    });
});

// PUT /:id/cancel (before /:id)
router.put('/:id/cancel', async (req, res) => {
    const cid  = req.companyId;
    const opId = parseInt(req.params.id);

    const { data: op } = await supabase.from('practice_tax_bulk_operations')
        .select('id, operation_status').eq('company_id', cid).eq('id', opId).maybeSingle();
    if (!op) return res.status(404).json({ error: 'Operation not found' });
    if (op.operation_status === 'running')
        return res.status(400).json({ error: 'Cannot cancel a running operation' });
    if (op.operation_status === 'cancelled')
        return res.status(400).json({ error: 'Already cancelled' });

    const { error } = await supabase.from('practice_tax_bulk_operations')
        .update({ operation_status: 'cancelled', cancelled_at: now(), updated_at: now(), updated_by: req.userId || null })
        .eq('id', opId);
    if (error) return res.status(500).json({ error: error.message });

    await logBulkEvent(cid, opId, 'bulk_operation_cancelled', req.userId, null, {});
    res.json({ success: true });
});

// GET /:id — single operation
router.get('/:id', async (req, res) => {
    const cid  = req.companyId;
    const opId = parseInt(req.params.id);
    const { data, error } = await supabase.from('practice_tax_bulk_operations')
        .select('*').eq('company_id', cid).eq('id', opId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Operation not found' });
    res.json({ operation: data });
});

module.exports = router;
