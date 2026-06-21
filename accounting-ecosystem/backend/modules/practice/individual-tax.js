/* =============================================================
   Practice Individual Income Tax Data Capture  (Codebox 27)
   NOT tax calculation. NOT SARS submission. NOT eFiling.
   Structured data capture and readiness tracking only.
   Mounted at /api/practice/individual-tax
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const RETURN_STATUSES = [
    'draft', 'collecting_docs', 'data_captured', 'ready_for_review',
    'reviewed', 'submitted', 'completed', 'cancelled',
];

const READINESS_STATUSES = ['incomplete', 'partial', 'ready', 'blocked', 'unknown'];

const ITEM_TYPES = [
    'irp5', 'it3a', 'medical', 'retirement_annuity', 'travel', 'rental',
    'investment', 'donations', 'capital_gain', 'business_income',
    'foreign_income', 'document', 'custom',
];

const ITEM_STATUSES = [
    'required', 'requested', 'received', 'captured', 'reviewed',
    'waived', 'blocked', 'not_applicable',
];

const INCOME_TYPES = [
    'salary', 'pension', 'annuity', 'interest', 'dividends', 'rental',
    'business', 'capital_gain', 'foreign_income', 'other',
];

const DEDUCTION_TYPES = [
    'medical', 'retirement_annuity', 'travel', 'donations', 'home_office',
    'wear_and_tear', 'business_expense', 'other',
];

// Statuses that count as "done" for readiness scoring
const DONE_STATUSES = ['received', 'captured', 'reviewed', 'waived'];

// ─── Default checklist items ──────────────────────────────────────────────────

const DEFAULT_ITEMS = [
    { item_type: 'irp5',               item_label: 'IRP5 / IT3(a) Certificate',           required: true  },
    { item_type: 'medical',            item_label: 'Medical Aid Tax Certificate',           required: false },
    { item_type: 'retirement_annuity', item_label: 'Retirement Annuity Certificate (IT3f)', required: false },
    { item_type: 'investment',         item_label: 'Investment Certificates (IT3b/IT3c)',   required: false },
    { item_type: 'rental',             item_label: 'Rental Income Schedule',                required: false },
    { item_type: 'travel',             item_label: 'Travel Logbook / Allowance Record',     required: false },
    { item_type: 'donations',          item_label: 'Donations Certificate (s18A)',           required: false },
    { item_type: 'capital_gain',       item_label: 'Capital Gains Support Documents',       required: false },
    { item_type: 'document',           item_label: 'Bank Details Confirmation',             required: true  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyReturnOwnership(cid, returnId) {
    const { data } = await supabase
        .from('practice_individual_tax_returns')
        .select('*')
        .eq('id', returnId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

function calculateReadiness(items) {
    const requiredItems = (items || []).filter(i => i.required !== false && i.item_status !== 'not_applicable');
    if (requiredItems.length === 0) return { score: null, readiness_status: 'unknown' };

    const blockedCount = requiredItems.filter(i => i.item_status === 'blocked').length;
    const doneCount    = requiredItems.filter(i => DONE_STATUSES.includes(i.item_status)).length;
    const score        = Math.round((doneCount / requiredItems.length) * 100);

    let readiness_status;
    if (blockedCount > 0)   readiness_status = 'blocked';
    else if (score >= 85)   readiness_status = 'ready';
    else if (score >= 50)   readiness_status = 'partial';
    else                    readiness_status = 'incomplete';

    return { score, readiness_status };
}

async function logEvent(cid, returnId, eventType, extras = {}) {
    await supabase.from('practice_individual_tax_events').insert({
        company_id:    cid,
        tax_return_id: returnId,
        event_type:    eventType,
        old_status:    extras.old_status    || null,
        new_status:    extras.new_status    || null,
        actor_user_id: extras.actor_user_id || null,
        notes:         extras.notes         || null,
        metadata:      extras.metadata      || {},
    });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// CRITICAL: All 3-segment and 4-segment literal sub-routes registered BEFORE
// the generic /:id, PUT /:id, DELETE /:id handlers.

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: returns, error } = await supabase
            .from('practice_individual_tax_returns')
            .select('status, readiness_status, tax_year')
            .eq('company_id', cid)
            .neq('status', 'cancelled');
        if (error) throw error;

        const byStatus    = {};
        const byReadiness = {};
        const byYear      = {};
        RETURN_STATUSES.forEach(s => { byStatus[s] = 0; });
        READINESS_STATUSES.forEach(s => { byReadiness[s] = 0; });

        (returns || []).forEach(r => {
            byStatus[r.status]             = (byStatus[r.status] || 0) + 1;
            byReadiness[r.readiness_status] = (byReadiness[r.readiness_status] || 0) + 1;
            byYear[r.tax_year]             = (byYear[r.tax_year] || 0) + 1;
        });

        res.json({
            summary: {
                total:        returns.length,
                by_status:    byStatus,
                by_readiness: byReadiness,
                by_year:      byYear,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET / (list) ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_profile_id, tax_year,
        status, readiness_status,
        page = 1, limit = 50,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        let q = supabase
            .from('practice_individual_tax_returns')
            .select(`
                *,
                clients:practice_clients!client_id(display_name, company_name)
            `)
            .eq('company_id', cid)
            .order('tax_year', { ascending: false })
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        if (client_id)           q = q.eq('client_id', parseInt(client_id));
        if (taxpayer_profile_id) q = q.eq('taxpayer_profile_id', parseInt(taxpayer_profile_id));
        if (tax_year)            q = q.eq('tax_year', parseInt(tax_year));
        if (status)              q = q.eq('status', status);
        if (readiness_status)    q = q.eq('readiness_status', readiness_status);

        const { data, error } = await q;
        if (error) throw error;

        const returns = (data || []).map(r => ({
            ...r,
            client_name: r.clients?.display_name || r.clients?.company_name || null,
            clients: undefined,
        }));

        res.json({ individual_tax_returns: returns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST / (create) ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_profile_id, tax_year, return_name,
        responsible_team_member_id, reviewer_team_member_id,
        related_compliance_pack_id, related_deadline_id,
        related_workflow_run_id, related_provisional_tax_plan_id,
        notes, internal_notes,
    } = req.body;

    if (!client_id)           return res.status(400).json({ error: 'client_id is required' });
    if (!taxpayer_profile_id) return res.status(400).json({ error: 'taxpayer_profile_id is required' });
    if (!tax_year)            return res.status(400).json({ error: 'tax_year is required' });
    if (!return_name?.trim()) return res.status(400).json({ error: 'return_name is required' });
    if (tax_year < 2000 || tax_year > 2099)
        return res.status(400).json({ error: 'tax_year must be between 2000 and 2099' });

    // Verify client and profile belong to this company
    const { data: client } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('id', client_id)
        .eq('company_id', cid)
        .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: profile } = await supabase
        .from('practice_taxpayer_profiles')
        .select('id, taxpayer_type')
        .eq('id', taxpayer_profile_id)
        .eq('company_id', cid)
        .single();
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    try {
        const { data: ret, error } = await supabase
            .from('practice_individual_tax_returns')
            .insert({
                company_id:                     cid,
                client_id:                      parseInt(client_id),
                taxpayer_profile_id:            parseInt(taxpayer_profile_id),
                related_taxpayer_profile_id:    parseInt(taxpayer_profile_id),
                tax_year:                       parseInt(tax_year),
                return_name:                    return_name.trim(),
                status:                         'draft',
                readiness_status:               'unknown',
                responsible_team_member_id:     responsible_team_member_id     || null,
                reviewer_team_member_id:        reviewer_team_member_id        || null,
                related_compliance_pack_id:     related_compliance_pack_id     || null,
                related_deadline_id:            related_deadline_id            || null,
                related_workflow_run_id:        related_workflow_run_id        || null,
                related_provisional_tax_plan_id:related_provisional_tax_plan_id|| null,
                notes:                          notes          || null,
                internal_notes:                 internal_notes || null,
                created_by:                     req.user?.id   || null,
                updated_by:                     req.user?.id   || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, ret.id, 'individual_tax_return_created', {
            actor_user_id: req.user?.id,
            metadata: { tax_year: ret.tax_year, return_name: ret.return_name },
        });
        await auditFromReq(req, 'individual_tax_return_created', { return_id: ret.id, tax_year: ret.tax_year });

        res.status(201).json({ tax_return: ret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /:id/generate-default-items ─────────────────────────────────────────

router.post('/:id/generate-default-items', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);
    const force    = req.query.force === 'true';

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    // Check existing items
    const { data: existing } = await supabase
        .from('practice_individual_tax_items')
        .select('item_type')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid);

    if ((existing || []).length > 0 && !force) {
        return res.status(409).json({
            error: 'Items already exist for this return',
            hint: 'Add ?force=true to append missing defaults',
        });
    }

    // Determine which types already exist to avoid duplication on force
    const existingTypes = new Set((existing || []).map(i => i.item_type));
    const toInsert = DEFAULT_ITEMS
        .filter(item => !existingTypes.has(item.item_type))
        .map(item => ({
            company_id:    cid,
            tax_return_id: returnId,
            item_type:     item.item_type,
            item_label:    item.item_label,
            item_status:   'required',
        }));

    if (toInsert.length === 0) {
        return res.json({ items: existing || [], inserted: 0 });
    }

    try {
        const { data: items, error } = await supabase
            .from('practice_individual_tax_items')
            .insert(toInsert)
            .select();
        if (error) throw error;

        await logEvent(cid, returnId, 'individual_tax_items_generated', {
            actor_user_id: req.user?.id,
            metadata: { count: items.length },
        });
        await auditFromReq(req, 'individual_tax_items_generated', { return_id: returnId, count: items.length });

        // Return all items
        const { data: allItems } = await supabase
            .from('practice_individual_tax_items')
            .select('*')
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .order('created_at');

        res.status(201).json({ items: allItems || [], inserted: items.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /:id/recalculate-readiness ───────────────────────────────────────────

router.post('/:id/recalculate-readiness', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data: items } = await supabase
        .from('practice_individual_tax_items')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid);

    const readiness = calculateReadiness(items || []);

    try {
        const { error } = await supabase
            .from('practice_individual_tax_returns')
            .update({
                readiness_score:  readiness.score,
                readiness_status: readiness.readiness_status,
                updated_at:       new Date().toISOString(),
                updated_by:       req.user?.id || null,
            })
            .eq('id', returnId)
            .eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, returnId, 'individual_tax_readiness_recalculated', {
            actor_user_id: req.user?.id,
            metadata: readiness,
        });

        res.json({ readiness });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id/items ────────────────────────────────────────────────────────────

router.get('/:id/items', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data: items, error } = await supabase
        .from('practice_individual_tax_items')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: items || [], readiness: calculateReadiness(items || []) });
});

// ── POST /:id/items ───────────────────────────────────────────────────────────

router.post('/:id/items', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { item_type, item_label, item_status, amount, source_reference, related_document_request_id, notes } = req.body;
    if (!item_type)       return res.status(400).json({ error: 'item_type is required' });
    if (!ITEM_TYPES.includes(item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (!item_label?.trim()) return res.status(400).json({ error: 'item_label is required' });

    try {
        const { data: item, error } = await supabase
            .from('practice_individual_tax_items')
            .insert({
                company_id:                 cid,
                tax_return_id:              returnId,
                item_type,
                item_label:                 item_label.trim(),
                item_status:                item_status && ITEM_STATUSES.includes(item_status) ? item_status : 'required',
                amount:                     amount != null ? parseFloat(amount) : null,
                source_reference:           source_reference           || null,
                related_document_request_id:related_document_request_id|| null,
                notes:                      notes || null,
            })
            .select()
            .single();
        if (error) throw error;

        res.status(201).json({ item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id/items/:itemId ────────────────────────────────────────────────────

router.put('/:id/items/:itemId', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);
    const itemId   = parseInt(req.params.itemId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const allowed = ['item_label', 'item_status', 'amount', 'source_reference', 'related_document_request_id', 'notes'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.item_status && !ITEM_STATUSES.includes(updates.item_status))
        return res.status(400).json({ error: 'Invalid item_status' });
    if (updates.amount != null) updates.amount = parseFloat(updates.amount);

    try {
        const { data: item, error } = await supabase
            .from('practice_individual_tax_items')
            .update(updates)
            .eq('id', itemId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;
        if (!item) return res.status(404).json({ error: 'Item not found' });

        res.json({ item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /:id/items/:itemId ─────────────────────────────────────────────────

router.delete('/:id/items/:itemId', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);
    const itemId   = parseInt(req.params.itemId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    try {
        const { error } = await supabase
            .from('practice_individual_tax_items')
            .delete()
            .eq('id', itemId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id/income ───────────────────────────────────────────────────────────

router.get('/:id/income', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_income_entries')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('income_type')
        .order('created_at');
    if (error) return res.status(500).json({ error: error.message });

    const totals = (data || []).reduce((acc, e) => {
        acc.gross_total    += parseFloat(e.gross_amount  || 0);
        acc.withheld_total += parseFloat(e.tax_withheld  || 0);
        return acc;
    }, { gross_total: 0, withheld_total: 0 });

    res.json({ income_entries: data || [], totals });
});

// ── POST /:id/income ──────────────────────────────────────────────────────────

router.post('/:id/income', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { income_type, description, gross_amount, tax_withheld, source_reference, notes } = req.body;
    if (!income_type) return res.status(400).json({ error: 'income_type is required' });
    if (!INCOME_TYPES.includes(income_type)) return res.status(400).json({ error: 'Invalid income_type' });
    if (gross_amount  != null && gross_amount  < 0) return res.status(400).json({ error: 'gross_amount must be >= 0' });
    if (tax_withheld  != null && tax_withheld  < 0) return res.status(400).json({ error: 'tax_withheld must be >= 0' });

    try {
        const { data: entry, error } = await supabase
            .from('practice_individual_tax_income_entries')
            .insert({
                company_id:       cid,
                tax_return_id:    returnId,
                income_type,
                description:      description      || null,
                gross_amount:     gross_amount  != null ? parseFloat(gross_amount)  : null,
                tax_withheld:     tax_withheld  != null ? parseFloat(tax_withheld)  : null,
                source_reference: source_reference || null,
                notes:            notes            || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, returnId, 'individual_tax_income_added', {
            actor_user_id: req.user?.id,
            metadata: { income_type, gross_amount },
        });

        res.status(201).json({ entry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id/income/:incomeId ─────────────────────────────────────────────────

router.put('/:id/income/:incomeId', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);
    const incomeId = parseInt(req.params.incomeId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const allowed  = ['income_type', 'description', 'gross_amount', 'tax_withheld', 'source_reference', 'notes'];
    const updates  = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.income_type && !INCOME_TYPES.includes(updates.income_type))
        return res.status(400).json({ error: 'Invalid income_type' });
    if (updates.gross_amount != null && updates.gross_amount < 0)
        return res.status(400).json({ error: 'gross_amount must be >= 0' });
    if (updates.tax_withheld != null && updates.tax_withheld < 0)
        return res.status(400).json({ error: 'tax_withheld must be >= 0' });

    try {
        const { data: entry, error } = await supabase
            .from('practice_individual_tax_income_entries')
            .update(updates)
            .eq('id', incomeId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;
        if (!entry) return res.status(404).json({ error: 'Income entry not found' });

        res.json({ entry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /:id/income/:incomeId ──────────────────────────────────────────────

router.delete('/:id/income/:incomeId', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);
    const incomeId = parseInt(req.params.incomeId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    try {
        const { error } = await supabase
            .from('practice_individual_tax_income_entries')
            .delete()
            .eq('id', incomeId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id/deductions ───────────────────────────────────────────────────────

router.get('/:id/deductions', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_deduction_entries')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('deduction_type')
        .order('created_at');
    if (error) return res.status(500).json({ error: error.message });

    const total = (data || []).reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
    res.json({ deduction_entries: data || [], total_deductions: total });
});

// ── POST /:id/deductions ──────────────────────────────────────────────────────

router.post('/:id/deductions', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { deduction_type, description, amount, source_reference, notes } = req.body;
    if (!deduction_type) return res.status(400).json({ error: 'deduction_type is required' });
    if (!DEDUCTION_TYPES.includes(deduction_type)) return res.status(400).json({ error: 'Invalid deduction_type' });
    if (amount != null && amount < 0) return res.status(400).json({ error: 'amount must be >= 0' });

    try {
        const { data: entry, error } = await supabase
            .from('practice_individual_tax_deduction_entries')
            .insert({
                company_id:       cid,
                tax_return_id:    returnId,
                deduction_type,
                description:      description      || null,
                amount:           amount != null ? parseFloat(amount) : null,
                source_reference: source_reference || null,
                notes:            notes            || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logEvent(cid, returnId, 'individual_tax_deduction_added', {
            actor_user_id: req.user?.id,
            metadata: { deduction_type, amount },
        });

        res.status(201).json({ entry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id/deductions/:deductionId ──────────────────────────────────────────

router.put('/:id/deductions/:deductionId', async (req, res) => {
    const cid         = req.companyId;
    const returnId    = parseInt(req.params.id);
    const deductionId = parseInt(req.params.deductionId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const allowed = ['deduction_type', 'description', 'amount', 'source_reference', 'notes'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.deduction_type && !DEDUCTION_TYPES.includes(updates.deduction_type))
        return res.status(400).json({ error: 'Invalid deduction_type' });
    if (updates.amount != null && updates.amount < 0)
        return res.status(400).json({ error: 'amount must be >= 0' });

    try {
        const { data: entry, error } = await supabase
            .from('practice_individual_tax_deduction_entries')
            .update(updates)
            .eq('id', deductionId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;
        if (!entry) return res.status(404).json({ error: 'Deduction entry not found' });

        res.json({ entry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /:id/deductions/:deductionId ───────────────────────────────────────

router.delete('/:id/deductions/:deductionId', async (req, res) => {
    const cid         = req.companyId;
    const returnId    = parseInt(req.params.id);
    const deductionId = parseInt(req.params.deductionId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    try {
        const { error } = await supabase
            .from('practice_individual_tax_deduction_entries')
            .delete()
            .eq('id', deductionId)
            .eq('tax_return_id', returnId)
            .eq('company_id', cid);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_events')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ events: data || [] });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    try {
        const { data: ret, error } = await supabase
            .from('practice_individual_tax_returns')
            .select(`
                *,
                clients:practice_clients!client_id(display_name, company_name)
            `)
            .eq('id', returnId)
            .eq('company_id', cid)
            .single();
        if (error || !ret) return res.status(404).json({ error: 'Tax return not found' });

        res.json({
            tax_return: {
                ...ret,
                client_name: ret.clients?.display_name || ret.clients?.company_name || null,
                clients: undefined,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const existing = await verifyReturnOwnership(cid, returnId);
    if (!existing) return res.status(404).json({ error: 'Tax return not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Cannot modify a cancelled return' });

    const allowed = [
        'return_name', 'status',
        'responsible_team_member_id', 'reviewer_team_member_id',
        'reviewed_at', 'reviewed_by',
        'related_compliance_pack_id', 'related_deadline_id',
        'related_workflow_run_id', 'related_provisional_tax_plan_id',
        'notes', 'internal_notes',
    ];

    const updates = { updated_at: new Date().toISOString(), updated_by: req.user?.id || null };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.status && !RETURN_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });

    try {
        const { data: ret, error } = await supabase
            .from('practice_individual_tax_returns')
            .update(updates)
            .eq('id', returnId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        const eventType = updates.status && updates.status !== existing.status
            ? 'individual_tax_status_changed'
            : 'individual_tax_return_updated';
        await logEvent(cid, returnId, eventType, {
            old_status: existing.status, new_status: updates.status || existing.status,
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'individual_tax_return_updated', { return_id: returnId });

        res.json({ tax_return: ret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /:id (soft cancel) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.id);

    const existing = await verifyReturnOwnership(cid, returnId);
    if (!existing) return res.status(404).json({ error: 'Tax return not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'Return already cancelled' });

    try {
        const { error } = await supabase
            .from('practice_individual_tax_returns')
            .update({ status: 'cancelled', updated_at: new Date().toISOString(), updated_by: req.user?.id || null })
            .eq('id', returnId)
            .eq('company_id', cid);
        if (error) throw error;

        await logEvent(cid, returnId, 'individual_tax_status_changed', {
            old_status: existing.status, new_status: 'cancelled',
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'individual_tax_return_cancelled', { return_id: returnId });

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;
