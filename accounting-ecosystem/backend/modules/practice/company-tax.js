/* =============================================================
   Practice Company Tax Data Capture  (Codebox 31)
   NOT company tax calculation. NOT ITR14 submission. NOT SARS.
   Data capture + readiness tracking only.
   Mounted at /api/practice/company-tax
   ============================================================= */
'use strict';

const express  = require('express');
const router   = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const CT_STATUSES = [
    'draft','collecting_docs','data_captured','ready_for_review',
    'reviewed','submitted','completed','cancelled',
];

const CT_READINESS_STATUSES = ['incomplete','partial','ready','blocked','unknown'];

const CT_ADJUSTMENT_TYPES = [
    'add_back','deduction','allowance','disallowance','assessed_loss',
    'capital_allowance','section_24c','doubtful_debt','donation','other',
];

const CT_ITEM_TYPES = [
    'afs','trial_balance','tax_computation','assessed_loss','provisional_tax',
    'sars_statement','fixed_assets','loan_accounts','supporting_document','review','custom',
];

const CT_ITEM_STATUSES = [
    'required','requested','received','captured','reviewed','waived','blocked','not_applicable',
];

const DONE_STATUSES = ['received','captured','reviewed','waived'];

const DEFAULT_READINESS_ITEMS = [
    { item_type: 'afs',                 item_name: 'Signed Annual Financial Statements',  required: true  },
    { item_type: 'trial_balance',       item_name: 'Trial Balance',                       required: true  },
    { item_type: 'tax_computation',     item_name: 'Tax Computation Support',              required: true  },
    { item_type: 'sars_statement',      item_name: 'SARS Statement of Account',           required: true  },
    { item_type: 'provisional_tax',     item_name: 'Provisional Tax History (IRP6)',       required: true  },
    { item_type: 'assessed_loss',       item_name: 'Assessed Loss Schedule',               required: true  },
    { item_type: 'fixed_assets',        item_name: 'Fixed Asset Register',                required: false },
    { item_type: 'loan_accounts',       item_name: 'Loan Account Confirmations',           required: false },
    { item_type: 'supporting_document', item_name: 'Supporting Documents',                required: false },
    { item_type: 'review',              item_name: 'Reviewer Sign-off',                   required: true  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyReturnBelongsToCompany(cid, returnId) {
    if (!returnId) return null;
    const { data } = await supabase
        .from('practice_company_tax_returns')
        .select('id, client_id, taxpayer_profile_id, status')
        .eq('id', parseInt(returnId))
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyClientBelongsToCompany(cid, clientId) {
    if (!clientId) return true;
    const { data } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('id', parseInt(clientId))
        .eq('company_id', cid)
        .single();
    return !!data;
}

async function verifyProfileBelongsToCompany(cid, profileId) {
    if (!profileId) return true;
    const { data } = await supabase
        .from('practice_taxpayer_profiles')
        .select('id')
        .eq('id', parseInt(profileId))
        .eq('company_id', cid)
        .single();
    return !!data;
}

async function logCtEvent(cid, returnId, eventType, opts = {}) {
    try {
        await supabase.from('practice_company_tax_events').insert({
            company_id:            cid,
            company_tax_return_id: returnId,
            event_type:            eventType,
            old_status:            opts.oldStatus    || null,
            new_status:            opts.newStatus    || null,
            actor_user_id:         opts.actorUserId  || null,
            notes:                 opts.notes        || null,
            metadata:              opts.metadata     || {},
        });
    } catch (_) { /* non-fatal */ }
}

async function recalculateReadiness(cid, returnId) {
    const { data: items } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('status, required')
        .eq('company_id', cid)
        .eq('company_tax_return_id', returnId);

    const allItems      = items || [];
    const requiredItems = allItems.filter(i => i.required);

    if (requiredItems.length === 0) {
        return { readiness_score: null, readiness_status: 'unknown' };
    }

    const isBlocked = requiredItems.some(i => i.status === 'blocked');
    if (isBlocked) {
        return { readiness_score: null, readiness_status: 'blocked' };
    }

    const doneCount = requiredItems.filter(i => DONE_STATUSES.includes(i.status)).length;
    const score     = Math.round((doneCount / requiredItems.length) * 100);

    let readiness_status;
    if (score >= 85)      readiness_status = 'ready';
    else if (score >= 50) readiness_status = 'partial';
    else                  readiness_status = 'incomplete';

    return { readiness_score: score, readiness_status };
}

function sanitizeReturnBody(body) {
    const allowed = [
        'client_id', 'taxpayer_profile_id', 'tax_year', 'return_name',
        'financial_year_start', 'financial_year_end', 'status',
        'accounting_profit_loss', 'turnover', 'cost_of_sales', 'gross_profit',
        'operating_expenses', 'finance_costs', 'other_income',
        'taxable_income_estimate', 'assessed_loss_brought_forward',
        'assessed_loss_utilised', 'assessed_loss_carried_forward',
        'responsible_team_member_id', 'reviewer_team_member_id',
        'related_taxpayer_profile_id', 'related_compliance_pack_id',
        'related_deadline_id', 'related_workflow_run_id', 'related_provisional_tax_plan_id',
        'notes', 'internal_notes', 'settings',
    ];
    const out = {};
    for (const k of allowed) { if (k in body) out[k] = body[k]; }
    return out;
}

// ─── Routes: Company Tax Returns ──────────────────────────────────────────────

// GET /api/practice/company-tax
router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_profile_id, tax_year,
        status, readiness_status,
    } = req.query;

    const page  = Math.max(1, parseInt(req.query.page  || 1));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    let q = supabase
        .from('practice_company_tax_returns')
        .select('*', { count: 'exact' })
        .eq('company_id', cid)
        .order('tax_year', { ascending: false })
        .order('created_at', { ascending: false })
        .range(from, to);

    if (client_id)          q = q.eq('client_id',          parseInt(client_id));
    if (taxpayer_profile_id) q = q.eq('taxpayer_profile_id', parseInt(taxpayer_profile_id));
    if (tax_year)           q = q.eq('tax_year',            parseInt(tax_year));
    if (status)             q = q.eq('status',              status);
    if (readiness_status)   q = q.eq('readiness_status',    readiness_status);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ company_tax_returns: data || [], total: count || 0, page, limit });
});

// GET /api/practice/company-tax/:id
router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('practice_company_tax_returns')
        .select('*')
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Company tax return not found' });
    res.json({ company_tax_return: data });
});

// POST /api/practice/company-tax
router.post('/', async (req, res) => {
    const cid  = req.companyId;
    const body = sanitizeReturnBody(req.body);

    if (!body.client_id)          return res.status(400).json({ error: 'client_id is required' });
    if (!body.taxpayer_profile_id) return res.status(400).json({ error: 'taxpayer_profile_id is required' });
    if (!body.tax_year)           return res.status(400).json({ error: 'tax_year is required' });
    if (!body.return_name)        return res.status(400).json({ error: 'return_name is required' });
    if (body.status && !CT_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });

    const [clientOk, profileOk] = await Promise.all([
        verifyClientBelongsToCompany(cid, body.client_id),
        verifyProfileBelongsToCompany(cid, body.taxpayer_profile_id),
    ]);
    if (!clientOk)  return res.status(400).json({ error: 'client_id not found in this company' });
    if (!profileOk) return res.status(400).json({ error: 'taxpayer_profile_id not found in this company' });

    body.company_id = cid;
    if (req.userId) body.created_by = req.userId;

    const { data, error } = await supabase
        .from('practice_company_tax_returns')
        .insert(body)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, data.id, 'company_tax_return_created', {
        actorUserId: req.userId || null,
        newStatus:   data.status,
        metadata:    { tax_year: data.tax_year },
    });
    await auditFromReq(req, 'CREATE', 'practice_company_tax_return', data.id, { module: 'practice' });
    res.status(201).json({ company_tax_return: data });
});

// PUT /api/practice/company-tax/:id
router.put('/:id', async (req, res) => {
    const cid = req.companyId;

    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Cannot update a cancelled return' });

    const body = sanitizeReturnBody(req.body);
    if (body.status && !CT_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    if (body.status === 'cancelled') return res.status(400).json({ error: 'Use DELETE to cancel a return' });

    // Validate changed ownership references
    if (body.client_id && body.client_id !== existing.client_id) {
        if (!await verifyClientBelongsToCompany(cid, body.client_id))
            return res.status(400).json({ error: 'client_id not found in this company' });
    }
    if (body.taxpayer_profile_id && body.taxpayer_profile_id !== existing.taxpayer_profile_id) {
        if (!await verifyProfileBelongsToCompany(cid, body.taxpayer_profile_id))
            return res.status(400).json({ error: 'taxpayer_profile_id not found in this company' });
    }

    const oldStatus = existing.status;
    body.updated_at = new Date().toISOString();
    if (req.userId) body.updated_by = req.userId;

    if (body.status === 'reviewed' && !body.reviewed_at) {
        body.reviewed_at = new Date().toISOString();
        body.reviewed_by = req.userId || null;
    }

    const { data, error } = await supabase
        .from('practice_company_tax_returns')
        .update(body)
        .eq('id', req.params.id)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, data.id, 'company_tax_return_updated', {
        actorUserId: req.userId || null,
        oldStatus,
        newStatus:   data.status,
        metadata:    { changed_fields: Object.keys(body).filter(k => !['updated_at','updated_by'].includes(k)) },
    });
    await auditFromReq(req, 'UPDATE', 'practice_company_tax_return', data.id, { module: 'practice' });
    res.json({ company_tax_return: data });
});

// DELETE /api/practice/company-tax/:id  (soft cancel only)
router.delete('/:id', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Return is already cancelled' });
    if (['completed','submitted'].includes(existing.status)) {
        return res.status(400).json({ error: `Cannot cancel a return with status '${existing.status}'` });
    }

    const { error } = await supabase
        .from('practice_company_tax_returns')
        .update({ status: 'cancelled', updated_at: new Date().toISOString(), updated_by: req.userId || null })
        .eq('id', req.params.id)
        .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, parseInt(req.params.id), 'company_tax_return_cancelled', {
        actorUserId: req.userId || null,
        oldStatus:   existing.status,
        newStatus:   'cancelled',
    });
    await auditFromReq(req, 'CANCEL', 'practice_company_tax_return', parseInt(req.params.id), { module: 'practice' });
    res.json({ success: true });
});

// POST /api/practice/company-tax/:id/generate-default-items
router.post('/:id/generate-default-items', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const returnId = parseInt(req.params.id);

    // Only insert items that don't already exist (by item_name)
    const { data: existing_items } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('item_name')
        .eq('company_id', cid)
        .eq('company_tax_return_id', returnId);

    const existingNames = new Set((existing_items || []).map(i => i.item_name));

    const toInsert = DEFAULT_READINESS_ITEMS
        .filter(i => !existingNames.has(i.item_name))
        .map(i => ({
            company_id:            cid,
            company_tax_return_id: returnId,
            item_type:             i.item_type,
            item_name:             i.item_name,
            required:              i.required,
            status:                'required',
        }));

    let inserted = [];
    if (toInsert.length > 0) {
        const { data, error } = await supabase
            .from('practice_company_tax_readiness_items')
            .insert(toInsert)
            .select();
        if (error) return res.status(500).json({ error: error.message });
        inserted = data || [];
    }

    // Recalculate readiness after generating items
    const readiness = await recalculateReadiness(cid, returnId);
    await supabase
        .from('practice_company_tax_returns')
        .update({ ...readiness, updated_at: new Date().toISOString() })
        .eq('id', returnId)
        .eq('company_id', cid);

    await logCtEvent(cid, returnId, 'company_tax_items_generated', {
        actorUserId: req.userId || null,
        metadata:    { items_created: inserted.length, items_skipped: DEFAULT_READINESS_ITEMS.length - inserted.length },
    });
    await auditFromReq(req, 'CREATE', 'practice_company_tax_readiness_items', returnId, { module: 'practice', count: inserted.length });

    res.json({ items_created: inserted.length, items_skipped: existingNames.size, readiness });
});

// POST /api/practice/company-tax/:id/recalculate-readiness
router.post('/:id/recalculate-readiness', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const returnId = parseInt(req.params.id);
    const readiness = await recalculateReadiness(cid, returnId);

    const { data, error } = await supabase
        .from('practice_company_tax_returns')
        .update({ ...readiness, updated_at: new Date().toISOString() })
        .eq('id', returnId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, returnId, 'company_tax_readiness_recalculated', {
        actorUserId: req.userId || null,
        metadata:    readiness,
    });

    res.json({ company_tax_return: data, readiness });
});

// ─── Routes: Adjustments ──────────────────────────────────────────────────────

// GET /api/practice/company-tax/:id/adjustments
router.get('/:id/adjustments', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_adjustments')
        .select('*')
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ adjustments: data || [] });
});

// POST /api/practice/company-tax/:id/adjustments
router.post('/:id/adjustments', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { adjustment_type, adjustment_category, description, amount, tax_effect, source_reference,
            related_document_request_id, notes } = req.body;

    if (!adjustment_type || !CT_ADJUSTMENT_TYPES.includes(adjustment_type))
        return res.status(400).json({ error: `adjustment_type must be one of: ${CT_ADJUSTMENT_TYPES.join(', ')}` });
    if (!description || !description.trim())
        return res.status(400).json({ error: 'description is required' });
    if (amount == null || isNaN(parseFloat(amount)))
        return res.status(400).json({ error: 'amount is required and must be numeric' });

    const { data, error } = await supabase
        .from('practice_company_tax_adjustments')
        .insert({
            company_id:                  cid,
            company_tax_return_id:       parseInt(req.params.id),
            adjustment_type,
            adjustment_category:         adjustment_category || null,
            description:                 description.trim(),
            amount:                      parseFloat(amount),
            tax_effect:                  tax_effect          || null,
            source_reference:            source_reference    || null,
            related_document_request_id: related_document_request_id ? parseInt(related_document_request_id) : null,
            notes:                       notes               || null,
        })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, parseInt(req.params.id), 'company_tax_adjustment_added', {
        actorUserId: req.userId || null,
        metadata:    { adjustment_id: data.id, adjustment_type, amount: data.amount },
    });
    await auditFromReq(req, 'CREATE', 'practice_company_tax_adjustment', data.id, { module: 'practice' });
    res.status(201).json({ adjustment: data });
});

// PUT /api/practice/company-tax/:id/adjustments/:adjustmentId
router.put('/:id/adjustments/:adjustmentId', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data: adj } = await supabase
        .from('practice_company_tax_adjustments')
        .select('id')
        .eq('id', req.params.adjustmentId)
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .single();
    if (!adj) return res.status(404).json({ error: 'Adjustment not found' });

    const allowed = ['adjustment_type','adjustment_category','description','amount','tax_effect','source_reference','related_document_request_id','notes'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.adjustment_type && !CT_ADJUSTMENT_TYPES.includes(updates.adjustment_type))
        return res.status(400).json({ error: 'Invalid adjustment_type' });
    if (updates.amount != null) updates.amount = parseFloat(updates.amount);

    const { data, error } = await supabase
        .from('practice_company_tax_adjustments')
        .update(updates)
        .eq('id', req.params.adjustmentId)
        .eq('company_id', cid)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await logCtEvent(cid, parseInt(req.params.id), 'company_tax_adjustment_updated', {
        actorUserId: req.userId || null,
        metadata:    { adjustment_id: data.id },
    });
    await auditFromReq(req, 'UPDATE', 'practice_company_tax_adjustment', data.id, { module: 'practice' });
    res.json({ adjustment: data });
});

// DELETE /api/practice/company-tax/:id/adjustments/:adjustmentId
router.delete('/:id/adjustments/:adjustmentId', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data: adj } = await supabase
        .from('practice_company_tax_adjustments')
        .select('id')
        .eq('id', req.params.adjustmentId)
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .single();
    if (!adj) return res.status(404).json({ error: 'Adjustment not found' });

    const { error } = await supabase
        .from('practice_company_tax_adjustments')
        .delete()
        .eq('id', req.params.adjustmentId)
        .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'practice_company_tax_adjustment', parseInt(req.params.adjustmentId), { module: 'practice' });
    res.json({ success: true });
});

// ─── Routes: Readiness Items ──────────────────────────────────────────────────

// GET /api/practice/company-tax/:id/items
router.get('/:id/items', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('*')
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .order('required', { ascending: false })
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
});

// POST /api/practice/company-tax/:id/items
router.post('/:id/items', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { item_type, item_name, status, required, related_document_request_id, notes } = req.body;

    if (!item_type || !CT_ITEM_TYPES.includes(item_type))
        return res.status(400).json({ error: `item_type must be one of: ${CT_ITEM_TYPES.join(', ')}` });
    if (!item_name || !item_name.trim())
        return res.status(400).json({ error: 'item_name is required' });
    if (status && !CT_ITEM_STATUSES.includes(status))
        return res.status(400).json({ error: 'Invalid status' });

    const { data, error } = await supabase
        .from('practice_company_tax_readiness_items')
        .insert({
            company_id:                  cid,
            company_tax_return_id:       parseInt(req.params.id),
            item_type,
            item_name:                   item_name.trim(),
            status:                      status || 'required',
            required:                    required !== false,
            related_document_request_id: related_document_request_id ? parseInt(related_document_request_id) : null,
            notes:                       notes || null,
        })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_company_tax_readiness_item', data.id, { module: 'practice' });
    res.status(201).json({ item: data });
});

// PUT /api/practice/company-tax/:id/items/:itemId
router.put('/:id/items/:itemId', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data: item } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('id')
        .eq('id', req.params.itemId)
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .single();
    if (!item) return res.status(404).json({ error: 'Readiness item not found' });

    const allowed = ['item_type','item_name','status','required','related_document_request_id','notes'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.item_type && !CT_ITEM_TYPES.includes(updates.item_type))
        return res.status(400).json({ error: 'Invalid item_type' });
    if (updates.status && !CT_ITEM_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });

    const { data, error } = await supabase
        .from('practice_company_tax_readiness_items')
        .update(updates)
        .eq('id', req.params.itemId)
        .eq('company_id', cid)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_company_tax_readiness_item', data.id, { module: 'practice' });
    res.json({ item: data });
});

// DELETE /api/practice/company-tax/:id/items/:itemId
router.delete('/:id/items/:itemId', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data: item } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('id')
        .eq('id', req.params.itemId)
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .single();
    if (!item) return res.status(404).json({ error: 'Readiness item not found' });

    const { error } = await supabase
        .from('practice_company_tax_readiness_items')
        .delete()
        .eq('id', req.params.itemId)
        .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'practice_company_tax_readiness_item', parseInt(req.params.itemId), { module: 'practice' });
    res.json({ success: true });
});

// ─── Routes: Events ───────────────────────────────────────────────────────────

// GET /api/practice/company-tax/:id/events
router.get('/:id/events', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyReturnBelongsToCompany(cid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Company tax return not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_events')
        .select('*')
        .eq('company_id', cid)
        .eq('company_tax_return_id', parseInt(req.params.id))
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
});

module.exports = router;
