/* =============================================================
   Practice Taxpayer Profile Foundation  (Codebox 25)
   NOT tax calculation. NOT SARS submission. NOT eFiling.
   Tracks taxpayer profile completeness and document readiness only.
   Mounted at /api/practice/taxpayer-profiles
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const TAXPAYER_TYPES = ['individual', 'company', 'trust', 'partnership', 'cc'];

const TAX_STATUSES = ['active', 'dormant', 'ceased'];

const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'];

const READINESS_STATUSES = ['incomplete', 'partial', 'ready', 'blocked', 'unknown'];

const INCOME_TYPES = [
    'salary', 'business', 'rental', 'investment', 'interest',
    'dividends', 'foreign_income', 'capital_gain', 'trust_distribution', 'pension', 'other',
];

const DEDUCTION_TYPES = [
    'retirement_annuity', 'medical', 'travel', 'home_office', 'donations',
    'wear_and_tear', 'business_expenses', 'assessed_losses', 'other',
];

const READINESS_ITEM_STATUSES = ['required', 'received', 'completed', 'waived', 'blocked'];

const DONE_STATUSES = ['received', 'completed', 'waived'];

// ─── Default readiness items per taxpayer type ────────────────────────────────

const DEFAULT_READINESS_ITEMS = {
    individual: [
        { item_name: 'Tax Reference Number',             required: true  },
        { item_name: 'ID Document / Passport Copy',      required: true  },
        { item_name: 'IRP5 / IT3(a)',                    required: true  },
        { item_name: 'Medical Aid Tax Certificate',      required: false },
        { item_name: 'Retirement Annuity Certificate',   required: false },
        { item_name: 'Investment Certificates (IT3b)',   required: false },
    ],
    company: [
        { item_name: 'Income Tax Reference Number',      required: true  },
        { item_name: 'Company Registration Documents',   required: true  },
        { item_name: 'Signed Annual Financial Statements', required: true },
        { item_name: 'Trial Balance',                    required: true  },
        { item_name: 'Tax Computation Support',          required: true  },
    ],
    trust: [
        { item_name: 'Trust Deed',                       required: true  },
        { item_name: 'Trustee Resolution',               required: true  },
        { item_name: 'Financial Statements',             required: true  },
        { item_name: 'Income Tax Reference Number',      required: true  },
    ],
    partnership: [
        { item_name: 'Partnership Agreement',            required: true  },
        { item_name: 'Income Tax Reference Number',      required: true  },
        { item_name: 'Financial Statements',             required: true  },
        { item_name: 'Partner ID Documents',             required: false },
    ],
    cc: [
        { item_name: 'Income Tax Reference Number',      required: true  },
        { item_name: 'CC Registration Documents',        required: true  },
        { item_name: 'Signed Annual Financial Statements', required: true },
        { item_name: 'Trial Balance',                    required: true  },
        { item_name: 'Tax Computation Support',          required: true  },
    ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyBelongsToCompany(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase
        .from(table).select('id').eq('id', id).eq('company_id', cid).single();
    return !!data;
}

async function verifyProfileOwnership(cid, profileId) {
    const { data } = await supabase
        .from('practice_taxpayer_profiles')
        .select('*')
        .eq('id', profileId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

function calculateReadiness(items) {
    const requiredItems = (items || []).filter(i => i.required === true);
    if (requiredItems.length === 0) return { score: null, readiness_status: 'unknown' };

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

// ─── GET /summary — MUST be before /:id ───────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    const { client_id } = req.query;

    try {
        let q = supabase
            .from('practice_taxpayer_profiles')
            .select('taxpayer_type, tax_status, readiness_status')
            .eq('company_id', cid);

        if (client_id) q = q.eq('client_id', parseInt(client_id));

        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const rows = data || [];
        const byType       = {};
        const byReadiness  = {};
        let   activeCount  = 0;

        rows.forEach(r => {
            if (r.tax_status !== 'ceased') activeCount++;
            byType[r.taxpayer_type]         = (byType[r.taxpayer_type]         || 0) + 1;
            byReadiness[r.readiness_status] = (byReadiness[r.readiness_status] || 0) + 1;
        });

        res.json({
            summary: {
                total:       rows.length,
                active:      activeCount,
                by_type: {
                    individual:  byType.individual  || 0,
                    company:     byType.company     || 0,
                    trust:       byType.trust       || 0,
                    partnership: byType.partnership || 0,
                    cc:          byType.cc          || 0,
                },
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

// ─── GET / — List profiles ────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_type, tax_status, readiness_status,
        page: rawPage, limit: rawLimit,
    } = req.query;

    const lim  = Math.min(200, Math.max(1, parseInt(rawLimit || 50)));
    const page = Math.max(0, parseInt(rawPage || 0));

    try {
        let q = supabase
            .from('practice_taxpayer_profiles')
            .select(`*,
                practice_clients:client_id(id, name),
                responsible:responsible_team_member_id(id, display_name),
                reviewer:reviewer_team_member_id(id, display_name)`)
            .eq('company_id', cid)
            .order('created_at', { ascending: false })
            .range(page * lim, (page + 1) * lim - 1);

        if (client_id)       q = q.eq('client_id',        parseInt(client_id));
        if (taxpayer_type && TAXPAYER_TYPES.includes(taxpayer_type))
                             q = q.eq('taxpayer_type',    taxpayer_type);
        if (tax_status && TAX_STATUSES.includes(tax_status))
                             q = q.eq('tax_status',       tax_status);
        if (readiness_status && READINESS_STATUSES.includes(readiness_status))
                             q = q.eq('readiness_status', readiness_status);

        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        res.json({ taxpayer_profiles: data || [], page, limit: lim });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST / — Create profile ──────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, taxpayer_type,
        income_tax_reference, provisional_taxpayer, vat_registered, paye_registered,
        id_number, passport_number, marital_status,
        registration_number, financial_year_end,
        responsible_team_member_id, reviewer_team_member_id,
        notes, internal_notes,
    } = req.body;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });
    if (!taxpayer_type || !TAXPAYER_TYPES.includes(taxpayer_type))
        return res.status(400).json({ error: `taxpayer_type must be one of: ${TAXPAYER_TYPES.join(', ')}` });
    if (marital_status && !MARITAL_STATUSES.includes(marital_status))
        return res.status(400).json({ error: `marital_status must be one of: ${MARITAL_STATUSES.join(', ')}` });

    const [clientOk, respOk, reviewerOk] = await Promise.all([
        verifyBelongsToCompany(cid, 'practice_clients',      parseInt(client_id)),
        verifyBelongsToCompany(cid, 'practice_team_members', responsible_team_member_id),
        verifyBelongsToCompany(cid, 'practice_team_members', reviewer_team_member_id),
    ]);
    if (!clientOk)   return res.status(400).json({ error: 'client_id not found in this company' });
    if (!respOk)     return res.status(400).json({ error: 'responsible_team_member_id not found in this company' });
    if (!reviewerOk) return res.status(400).json({ error: 'reviewer_team_member_id not found in this company' });

    const { data, error } = await supabase
        .from('practice_taxpayer_profiles')
        .insert({
            company_id:                 cid,
            client_id:                  parseInt(client_id),
            taxpayer_type,
            income_tax_reference:       income_tax_reference    || null,
            provisional_taxpayer:       provisional_taxpayer    === true || provisional_taxpayer === 'true',
            vat_registered:             vat_registered          === true || vat_registered          === 'true',
            paye_registered:            paye_registered         === true || paye_registered         === 'true',
            id_number:                  id_number               || null,
            passport_number:            passport_number         || null,
            marital_status:             marital_status          || null,
            registration_number:        registration_number     || null,
            financial_year_end:         financial_year_end      || null,
            tax_status:                 'active',
            readiness_status:           'unknown',
            responsible_team_member_id: responsible_team_member_id ? parseInt(responsible_team_member_id) : null,
            reviewer_team_member_id:    reviewer_team_member_id    ? parseInt(reviewer_team_member_id)    : null,
            notes:                      notes          || null,
            internal_notes:             internal_notes || null,
            created_by:                 req.userId     || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_taxpayer_profile', data.id, {
        module: 'practice', action: 'taxpayer_profile_created', taxpayer_type,
    });

    res.status(201).json({ taxpayer_profile: data });
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('practice_taxpayer_profiles')
        .select(`*,
            practice_clients:client_id(id, name),
            responsible:responsible_team_member_id(id, display_name),
            reviewer:reviewer_team_member_id(id, display_name)`)
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();

    if (error || !data) return res.status(404).json({ error: 'Taxpayer profile not found' });
    res.json({ taxpayer_profile: data });
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const existing = await verifyProfileOwnership(cid, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const allowed = [
        'taxpayer_type', 'income_tax_reference',
        'provisional_taxpayer', 'vat_registered', 'paye_registered',
        'id_number', 'passport_number', 'marital_status',
        'registration_number', 'financial_year_end',
        'tax_status', 'responsible_team_member_id', 'reviewer_team_member_id',
        'notes', 'internal_notes',
    ];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.taxpayer_type  && !TAXPAYER_TYPES.includes(updates.taxpayer_type))
        return res.status(400).json({ error: 'Invalid taxpayer_type' });
    if (updates.tax_status     && !TAX_STATUSES.includes(updates.tax_status))
        return res.status(400).json({ error: 'Invalid tax_status' });
    if (updates.marital_status && !MARITAL_STATUSES.includes(updates.marital_status))
        return res.status(400).json({ error: 'Invalid marital_status' });
    if (req.userId) updates.updated_by = req.userId;

    const { data, error } = await supabase
        .from('practice_taxpayer_profiles')
        .update(updates)
        .eq('id', req.params.id)
        .eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_taxpayer_profile', data.id, {
        module: 'practice', action: 'taxpayer_profile_updated',
    });

    res.json({ taxpayer_profile: data });
});

// ─── DELETE /:id — Soft deactivate (tax_status → ceased) ─────────────────────

router.delete('/:id', async (req, res) => {
    const cid      = req.companyId;
    const existing = await verifyProfileOwnership(cid, parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { error } = await supabase
        .from('practice_taxpayer_profiles')
        .update({ tax_status: 'ceased', updated_at: new Date().toISOString(), updated_by: req.userId || null })
        .eq('id', req.params.id)
        .eq('company_id', cid);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_taxpayer_profile', parseInt(req.params.id), {
        module: 'practice', action: 'taxpayer_profile_ceased',
    });

    res.json({ success: true });
});

// ─── Income Sources ───────────────────────────────────────────────────────────

router.get('/:id/income-sources', async (req, res) => {
    const cid = req.companyId;
    const profile = await verifyProfileOwnership(cid, parseInt(req.params.id));
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { data, error } = await supabase
        .from('practice_taxpayer_income_sources')
        .select('*')
        .eq('profile_id', req.params.id)
        .eq('company_id', cid)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ income_sources: data || [] });
});

router.post('/:id/income-sources', async (req, res) => {
    const cid = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { income_type, description, notes } = req.body;
    if (!income_type || !INCOME_TYPES.includes(income_type))
        return res.status(400).json({ error: `income_type must be one of: ${INCOME_TYPES.join(', ')}` });

    const { data, error } = await supabase
        .from('practice_taxpayer_income_sources')
        .insert({
            company_id:  cid,
            profile_id:  profileId,
            income_type,
            description: description || null,
            notes:       notes       || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_taxpayer_income_source', data.id, {
        module: 'practice', action: 'taxpayer_income_source_added', profile_id: profileId,
    });

    res.status(201).json({ income_source: data });
});

router.put('/:id/income-sources/:sourceId', async (req, res) => {
    const cid      = req.companyId;
    const sourceId = parseInt(req.params.sourceId);

    const { data: src } = await supabase
        .from('practice_taxpayer_income_sources')
        .select('*').eq('id', sourceId).eq('profile_id', req.params.id).eq('company_id', cid).single();
    if (!src) return res.status(404).json({ error: 'Income source not found' });

    const updates = { updated_at: new Date().toISOString() };
    ['income_type', 'description', 'active', 'notes'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    if (updates.income_type && !INCOME_TYPES.includes(updates.income_type))
        return res.status(400).json({ error: 'Invalid income_type' });

    const { data, error } = await supabase
        .from('practice_taxpayer_income_sources')
        .update(updates).eq('id', sourceId).eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ income_source: data });
});

router.delete('/:id/income-sources/:sourceId', async (req, res) => {
    const cid      = req.companyId;
    const sourceId = parseInt(req.params.sourceId);

    const { data: src } = await supabase
        .from('practice_taxpayer_income_sources')
        .select('id').eq('id', sourceId).eq('profile_id', req.params.id).eq('company_id', cid).single();
    if (!src) return res.status(404).json({ error: 'Income source not found' });

    const { error } = await supabase
        .from('practice_taxpayer_income_sources')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', sourceId).eq('company_id', cid);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ─── Deductions ───────────────────────────────────────────────────────────────

router.get('/:id/deductions', async (req, res) => {
    const cid = req.companyId;
    const profile = await verifyProfileOwnership(cid, parseInt(req.params.id));
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { data, error } = await supabase
        .from('practice_taxpayer_deductions')
        .select('*')
        .eq('profile_id', req.params.id)
        .eq('company_id', cid)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ deductions: data || [] });
});

router.post('/:id/deductions', async (req, res) => {
    const cid       = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile   = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { deduction_type, description } = req.body;
    if (!deduction_type || !DEDUCTION_TYPES.includes(deduction_type))
        return res.status(400).json({ error: `deduction_type must be one of: ${DEDUCTION_TYPES.join(', ')}` });

    const { data, error } = await supabase
        .from('practice_taxpayer_deductions')
        .insert({
            company_id:     cid,
            profile_id:     profileId,
            deduction_type,
            description:    description || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_taxpayer_deduction', data.id, {
        module: 'practice', action: 'taxpayer_deduction_added', profile_id: profileId,
    });

    res.status(201).json({ deduction: data });
});

router.put('/:id/deductions/:deductionId', async (req, res) => {
    const cid         = req.companyId;
    const deductionId = parseInt(req.params.deductionId);

    const { data: ded } = await supabase
        .from('practice_taxpayer_deductions')
        .select('*').eq('id', deductionId).eq('profile_id', req.params.id).eq('company_id', cid).single();
    if (!ded) return res.status(404).json({ error: 'Deduction not found' });

    const updates = { updated_at: new Date().toISOString() };
    ['deduction_type', 'description', 'active'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    if (updates.deduction_type && !DEDUCTION_TYPES.includes(updates.deduction_type))
        return res.status(400).json({ error: 'Invalid deduction_type' });

    const { data, error } = await supabase
        .from('practice_taxpayer_deductions')
        .update(updates).eq('id', deductionId).eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ deduction: data });
});

router.delete('/:id/deductions/:deductionId', async (req, res) => {
    const cid         = req.companyId;
    const deductionId = parseInt(req.params.deductionId);

    const { data: ded } = await supabase
        .from('practice_taxpayer_deductions')
        .select('id').eq('id', deductionId).eq('profile_id', req.params.id).eq('company_id', cid).single();
    if (!ded) return res.status(404).json({ error: 'Deduction not found' });

    const { error } = await supabase
        .from('practice_taxpayer_deductions')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', deductionId).eq('company_id', cid);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ─── Readiness Items ──────────────────────────────────────────────────────────

// GET /:id/readiness — list items + compute live readiness
router.get('/:id/readiness', async (req, res) => {
    const cid       = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile   = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { data, error } = await supabase
        .from('practice_taxpayer_readiness_items')
        .select('*')
        .eq('profile_id', profileId)
        .eq('company_id', cid)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });

    const items = data || [];
    const { score, readiness_status } = calculateReadiness(items);

    res.json({
        items,
        readiness: { score, readiness_status, item_count: items.length },
    });
});

// POST /:id/readiness-items — add single item (BEFORE /:id/recalculate-readiness)
router.post('/:id/readiness-items', async (req, res) => {
    const cid       = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile   = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { item_name, required, related_document_request_id, notes } = req.body;
    if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name is required' });

    const { data, error } = await supabase
        .from('practice_taxpayer_readiness_items')
        .insert({
            company_id:                 cid,
            profile_id:                 profileId,
            item_name:                  item_name.trim(),
            required:                   required !== false,
            status:                     'required',
            related_document_request_id: related_document_request_id ? parseInt(related_document_request_id) : null,
            notes:                      notes || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ item: data });
});

// PUT /:id/readiness-items/:itemId — update item status / name
router.put('/:id/readiness-items/:itemId', async (req, res) => {
    const cid    = req.companyId;
    const itemId = parseInt(req.params.itemId);

    const { data: item } = await supabase
        .from('practice_taxpayer_readiness_items')
        .select('*').eq('id', itemId).eq('profile_id', req.params.id).eq('company_id', cid).single();
    if (!item) return res.status(404).json({ error: 'Readiness item not found' });

    const updates = { updated_at: new Date().toISOString() };
    ['item_name', 'required', 'status', 'notes', 'related_document_request_id'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    if (updates.status && !READINESS_ITEM_STATUSES.includes(updates.status))
        return res.status(400).json({ error: 'Invalid status' });
    if (updates.item_name) updates.item_name = updates.item_name.trim();

    const { data, error } = await supabase
        .from('practice_taxpayer_readiness_items')
        .update(updates).eq('id', itemId).eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

// POST /:id/recalculate-readiness — compute and persist score
router.post('/:id/recalculate-readiness', async (req, res) => {
    const cid       = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile   = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const { data: items, error: iErr } = await supabase
        .from('practice_taxpayer_readiness_items')
        .select('required, status')
        .eq('profile_id', profileId)
        .eq('company_id', cid);

    if (iErr) return res.status(500).json({ error: iErr.message });

    const { score, readiness_status } = calculateReadiness(items || []);
    const now = new Date().toISOString();

    const { data, error } = await supabase
        .from('practice_taxpayer_profiles')
        .update({ readiness_score: score, readiness_status, updated_at: now, updated_by: req.userId || null })
        .eq('id', profileId)
        .eq('company_id', cid)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_taxpayer_profile', data.id, {
        module: 'practice', action: 'taxpayer_profile_readiness_recalculated', score, readiness_status,
    });

    res.json({ taxpayer_profile: data, readiness: { score, readiness_status, item_count: (items || []).length } });
});

// POST /:id/generate-default-items — create default readiness checklist for taxpayer_type
router.post('/:id/generate-default-items', async (req, res) => {
    const cid       = req.companyId;
    const profileId = parseInt(req.params.id);
    const profile   = await verifyProfileOwnership(cid, profileId);
    if (!profile) return res.status(404).json({ error: 'Taxpayer profile not found' });

    const defaults = DEFAULT_READINESS_ITEMS[profile.taxpayer_type] || [];
    if (defaults.length === 0)
        return res.status(400).json({ error: `No default items defined for taxpayer_type "${profile.taxpayer_type}"` });

    const { data: existing } = await supabase
        .from('practice_taxpayer_readiness_items')
        .select('id').eq('profile_id', profileId).eq('company_id', cid);

    if (existing && existing.length > 0 && !req.query.force)
        return res.status(409).json({
            error: `Profile already has ${existing.length} item(s). Use ?force=true to add defaults anyway.`,
            existing_count: existing.length,
        });

    const rows = defaults.map(item => ({
        company_id: cid,
        profile_id: profileId,
        item_name:  item.item_name,
        required:   item.required !== false,
        status:     'required',
    }));

    const { data: created, error } = await supabase
        .from('practice_taxpayer_readiness_items')
        .insert(rows)
        .select();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_taxpayer_readiness_item', profileId, {
        module: 'practice', action: 'taxpayer_defaults_generated',
        taxpayer_type: profile.taxpayer_type, created_count: created.length,
    });

    res.status(201).json({ created: created.length, items: created });
});

module.exports = router;
