/**
 * ============================================================
 * Practice Tax Checklist Templates (Codebox 36)
 * ============================================================
 * Reusable tax document checklist templates + controlled apply.
 * NOT document storage. NOT SARS. NOT AI.
 * Generates: document requests, compliance pack items, tax return items.
 * ============================================================
 */

const express   = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMPLATE_TYPES = [
    'individual_tax', 'company_tax', 'provisional_tax', 'annual_financials',
    'vat_period', 'payroll_annual', 'cipc_annual', 'custom',
];

const CLIENT_TYPES = [
    'individual', 'company', 'trust', 'close_corporation', 'partnership', 'sole_proprietor', 'other',
];

const ITEM_CATEGORIES = [
    'document', 'tax_data', 'review', 'compliance', 'calculation', 'approval', 'custom',
];

const TARGET_TYPES = [
    'document_request', 'compliance_pack_item', 'individual_tax_item', 'company_tax_item',
];

const DOC_CATEGORIES = [
    'identity', 'tax', 'vat', 'payroll', 'accounting', 'banking',
    'cipc', 'trust', 'legal', 'compliance', 'financials', 'supporting_docs', 'custom',
];

const COMPLIANCE_ITEM_TYPES = ['document', 'task', 'deadline', 'checklist', 'review', 'custom'];

const IND_TAX_ITEM_TYPES = [
    'irp5', 'it3a', 'medical', 'retirement_annuity', 'travel', 'rental',
    'investment', 'donations', 'capital_gain', 'business_income', 'foreign_income', 'document', 'custom',
];

const CO_TAX_ITEM_TYPES = [
    'afs', 'trial_balance', 'tax_computation', 'assessed_loss', 'provisional_tax',
    'sars_statement', 'fixed_assets', 'loan_accounts', 'supporting_document', 'review', 'custom',
];

// ─── Seed data ─────────────────────────────────────────────────────────────────

const SEED_TEMPLATES = [
    {
        template_name: 'Individual Tax Return',
        template_type: 'individual_tax',
        client_type:   'individual',
        description:   'Standard document checklist for individual (personal) income tax returns (ITR12).',
        is_default:    true,
        items: [
            { item_name: 'IRP5 / IT3(a)',                   item_description: 'Tax certificate from employer(s)',                    item_category: 'document', target_type: 'document_request', required: true,  sort_order: 1,  settings: { document_category: 'tax' } },
            { item_name: 'Medical tax certificate',          item_description: 'From medical aid scheme or administrator',            item_category: 'document', target_type: 'document_request', required: false, sort_order: 2,  settings: { document_category: 'financials' } },
            { item_name: 'Retirement annuity certificate',   item_description: 'RA contribution certificate (IT3f) from provider',   item_category: 'document', target_type: 'document_request', required: false, sort_order: 3,  settings: { document_category: 'financials' } },
            { item_name: 'Travel logbook',                   item_description: 'Completed SARS-compliant travel logbook for the year', item_category: 'document', target_type: 'document_request', required: false, sort_order: 4, settings: { document_category: 'supporting_docs' } },
            { item_name: 'Rental income schedule',           item_description: 'Rental income and expense breakdown',                 item_category: 'tax_data', target_type: 'document_request', required: false, sort_order: 5,  settings: { document_category: 'accounting' } },
            { item_name: 'Investment certificates (IT3b/IT3c)', item_description: 'Interest and dividend certificates from banks and brokers', item_category: 'document', target_type: 'document_request', required: false, sort_order: 6, settings: { document_category: 'financials' } },
            { item_name: 'Donation receipts (Section 18A)', item_description: 'Valid Section 18A receipts for deductible donations', item_category: 'document', target_type: 'document_request', required: false, sort_order: 7, settings: { document_category: 'supporting_docs' } },
            { item_name: 'Business income support',          item_description: 'Income and expense schedule for business activities',  item_category: 'tax_data', target_type: 'document_request', required: false, sort_order: 8, settings: { document_category: 'accounting' } },
        ],
    },
    {
        template_name: 'Company Tax Return',
        template_type: 'company_tax',
        client_type:   'company',
        description:   'Standard document checklist for company income tax returns (ITR14).',
        is_default:    true,
        items: [
            { item_name: 'Signed Annual Financial Statements',  item_description: 'Signed and dated AFS for the financial year',    item_category: 'document', target_type: 'document_request', required: true,  sort_order: 1, settings: { document_category: 'financials' } },
            { item_name: 'Tax computation support',             item_description: 'Detailed tax computation workings',               item_category: 'calculation', target_type: 'document_request', required: true,  sort_order: 2, settings: { document_category: 'accounting' } },
            { item_name: 'SARS statement of account',           item_description: 'Current SARS account statement for the company', item_category: 'compliance', target_type: 'document_request', required: true,  sort_order: 3, settings: { document_category: 'tax' } },
            { item_name: 'Provisional tax history (IRP6)',      item_description: 'IRP6 submissions and proof of payments',          item_category: 'document', target_type: 'document_request', required: true,  sort_order: 4, settings: { document_category: 'tax' } },
            { item_name: 'Assessed losses schedule',            item_description: 'Prior year assessed loss schedule and supporting', item_category: 'tax_data', target_type: 'document_request', required: false, sort_order: 5, settings: { document_category: 'accounting' } },
            { item_name: 'Dividends tax certificates',          item_description: 'Dividends declared and withholding tax details',  item_category: 'document', target_type: 'document_request', required: false, sort_order: 6, settings: { document_category: 'tax' } },
        ],
    },
    {
        template_name: 'Provisional Tax',
        template_type: 'provisional_tax',
        client_type:   null,
        description:   'Standard document checklist for provisional tax periods (IRP6).',
        is_default:    true,
        items: [
            { item_name: 'Management accounts',               item_description: 'Latest management accounts for the period',         item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 1, settings: { document_category: 'accounting' } },
            { item_name: 'Prior year tax assessment',          item_description: 'Most recent SARS income tax assessment',            item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 2, settings: { document_category: 'tax' } },
            { item_name: 'Income estimate for the year',       item_description: 'Estimated taxable income and basis of estimate',    item_category: 'tax_data',   target_type: 'document_request', required: true,  sort_order: 3, settings: { document_category: 'accounting' } },
            { item_name: 'Previous IRP6 submission',           item_description: 'Prior period IRP6 for reference',                  item_category: 'document',   target_type: 'document_request', required: false, sort_order: 4, settings: { document_category: 'tax' } },
        ],
    },
    {
        template_name: 'Annual Financial Statements',
        template_type: 'annual_financials',
        client_type:   null,
        description:   'Standard document checklist for compiling annual financial statements.',
        is_default:    true,
        items: [
            { item_name: 'Bank statements (all accounts)',     item_description: 'All bank accounts for the full financial year',     item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 1, settings: { document_category: 'banking' } },
            { item_name: 'Trial balance',                      item_description: 'Final trial balance for the financial period',      item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 2, settings: { document_category: 'accounting' } },
            { item_name: 'Debtors age analysis',               item_description: 'Trade debtors age analysis at year end',           item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 3, settings: { document_category: 'accounting' } },
            { item_name: 'Creditors age analysis',             item_description: 'Trade creditors age analysis at year end',         item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 4, settings: { document_category: 'accounting' } },
            { item_name: 'Fixed asset register',               item_description: 'Register with additions, disposals, depreciation', item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 5, settings: { document_category: 'accounting' } },
            { item_name: 'Payroll summary and EMP501',         item_description: 'Annual payroll summary and EMP501 reconciliation', item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 6, settings: { document_category: 'payroll' } },
            { item_name: 'Loan confirmations',                 item_description: 'Shareholder, director, and third-party loan confirmations', item_category: 'document', target_type: 'document_request', required: false, sort_order: 7, settings: { document_category: 'accounting' } },
            { item_name: 'Inventory valuation',                item_description: 'Stock count and valuation at year end',            item_category: 'document',   target_type: 'document_request', required: false, sort_order: 8, settings: { document_category: 'accounting' } },
            { item_name: 'VAT reconciliation',                 item_description: 'VAT reconciliation supporting schedules',          item_category: 'document',   target_type: 'document_request', required: false, sort_order: 9, settings: { document_category: 'vat' } },
        ],
    },
    {
        template_name: 'VAT Period Return',
        template_type: 'vat_period',
        client_type:   null,
        description:   'Standard document checklist for VAT201 period returns.',
        is_default:    true,
        items: [
            { item_name: 'Tax invoices (output VAT)',           item_description: 'Tax invoices for all output VAT transactions',     item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 1, settings: { document_category: 'vat' } },
            { item_name: 'Supplier invoices (input VAT)',       item_description: 'Valid tax invoices for input VAT claims',          item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 2, settings: { document_category: 'vat' } },
            { item_name: 'Bank statements',                     item_description: 'Bank statements for the VAT period',              item_category: 'document',   target_type: 'document_request', required: true,  sort_order: 3, settings: { document_category: 'banking' } },
            { item_name: 'Output VAT summary listing',          item_description: 'Sales and output VAT summary for the period',     item_category: 'tax_data',   target_type: 'document_request', required: true,  sort_order: 4, settings: { document_category: 'vat' } },
            { item_name: 'Input VAT support',                   item_description: 'Purchases and input VAT summary',                 item_category: 'tax_data',   target_type: 'document_request', required: true,  sort_order: 5, settings: { document_category: 'vat' } },
            { item_name: 'Import documents',                    item_description: 'SAD500 / customs documents if applicable',        item_category: 'document',   target_type: 'document_request', required: false, sort_order: 6, settings: { document_category: 'vat' } },
        ],
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyBelongsToCompany(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase.from(table).select('id').eq('id', parseInt(id)).eq('company_id', cid).single();
    return !!data;
}

async function logTemplateEvent(cid, templateId, eventType, opts = {}) {
    try {
        await supabase.from('practice_tax_checklist_template_events').insert({
            company_id:    cid,
            template_id:   templateId,
            event_type:    eventType,
            actor_user_id: opts.actorUserId || null,
            notes:         opts.notes       || null,
            metadata:      opts.metadata    || {},
        });
    } catch (_) { /* non-fatal audit */ }
}

// Map template item_category to a document_request category
function resolveDocCategory(item) {
    const fromSettings = item.settings?.document_category;
    if (fromSettings && DOC_CATEGORIES.includes(fromSettings)) return fromSettings;
    const catMap = {
        document: 'supporting_docs', tax_data: 'tax', review: 'supporting_docs',
        compliance: 'compliance', calculation: 'accounting', approval: 'supporting_docs', custom: 'custom',
    };
    return catMap[item.item_category] || 'supporting_docs';
}

// Map template item settings to compliance pack item_type
function resolvePackItemType(item) {
    const t = item.settings?.item_type;
    if (t && COMPLIANCE_ITEM_TYPES.includes(t)) return t;
    return item.item_category === 'review' ? 'review' : 'document';
}

// Map template item settings to individual_tax_items item_type
function resolveIndTaxItemType(item) {
    const t = item.settings?.item_type;
    if (t && IND_TAX_ITEM_TYPES.includes(t)) return t;
    return 'document';
}

// Map template item settings to company_tax_readiness_items item_type
function resolveCoTaxItemType(item) {
    const t = item.settings?.item_type;
    if (t && CO_TAX_ITEM_TYPES.includes(t)) return t;
    return 'supporting_document';
}

// ─── GET /templates ───────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
    const cid = req.companyId;
    const { template_type, is_active = 'true', client_type } = req.query;

    let q = supabase
        .from('practice_tax_checklist_templates')
        .select('*')
        .eq('company_id', cid)
        .order('template_name');

    if (is_active !== 'all') q = q.eq('is_active', is_active !== 'false');
    if (template_type && TEMPLATE_TYPES.includes(template_type)) q = q.eq('template_type', template_type);
    if (client_type   && CLIENT_TYPES.includes(client_type))     q = q.eq('client_type', client_type);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Add item count per template
    if (data && data.length > 0) {
        const ids = data.map(t => t.id);
        const { data: itemCounts } = await supabase
            .from('practice_tax_checklist_template_items')
            .select('template_id')
            .eq('company_id', cid)
            .in('template_id', ids);

        const countMap = {};
        (itemCounts || []).forEach(r => {
            countMap[r.template_id] = (countMap[r.template_id] || 0) + 1;
        });
        data.forEach(t => { t.item_count = countMap[t.id] || 0; });
    }

    res.json({ templates: data || [], total: (data || []).length });
});

// ─── POST /templates ──────────────────────────────────────────────────────────

router.post('/templates', async (req, res) => {
    const cid = req.companyId;
    const { template_name, template_type, description, client_type, tax_year, settings } = req.body;

    if (!template_name || !template_name.trim()) return res.status(400).json({ error: 'template_name is required' });
    if (!template_type || !TEMPLATE_TYPES.includes(template_type))
        return res.status(400).json({ error: `template_type must be one of: ${TEMPLATE_TYPES.join(', ')}` });
    if (client_type && !CLIENT_TYPES.includes(client_type))
        return res.status(400).json({ error: `client_type must be one of: ${CLIENT_TYPES.join(', ')}` });

    const { data, error } = await supabase
        .from('practice_tax_checklist_templates')
        .insert({
            company_id:    cid,
            template_name: template_name.trim(),
            template_type,
            description:   description || null,
            client_type:   client_type || null,
            tax_year:      tax_year    ? parseInt(tax_year) : null,
            settings:      settings   || {},
            is_active:     true,
            is_default:    false,
            created_by:    req.userId || null,
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    await logTemplateEvent(cid, data.id, 'tax_checklist_template_created', { actorUserId: req.userId });
    await auditFromReq(req, 'CREATE', 'practice_tax_checklist_template', data.id, { module: 'practice' });
    res.status(201).json({ template: data });
});

// ─── GET /templates/:id ───────────────────────────────────────────────────────

router.get('/templates/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('practice_tax_checklist_templates')
        .select('*')
        .eq('id', req.params.id)
        .eq('company_id', req.companyId)
        .single();
    if (error || !data) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: data });
});

// ─── PUT /templates/:id ───────────────────────────────────────────────────────

router.put('/templates/:id', async (req, res) => {
    const cid = req.companyId;
    const { data: existing } = await supabase
        .from('practice_tax_checklist_templates').select('id').eq('id', req.params.id).eq('company_id', cid).single();
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const allowed = ['template_name', 'template_type', 'description', 'client_type', 'tax_year', 'is_active', 'settings'];
    const updates = { updated_at: new Date().toISOString(), updated_by: req.userId || null };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.template_type && !TEMPLATE_TYPES.includes(updates.template_type))
        return res.status(400).json({ error: 'Invalid template_type' });
    if (updates.client_type && !CLIENT_TYPES.includes(updates.client_type))
        return res.status(400).json({ error: 'Invalid client_type' });

    const { data, error } = await supabase
        .from('practice_tax_checklist_templates')
        .update(updates)
        .eq('id', req.params.id)
        .eq('company_id', cid)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    const evtType = updates.is_active === false ? 'tax_checklist_template_deactivated' : 'tax_checklist_template_updated';
    await logTemplateEvent(cid, data.id, evtType, { actorUserId: req.userId });
    await auditFromReq(req, 'UPDATE', 'practice_tax_checklist_template', data.id, { module: 'practice' });
    res.json({ template: data });
});

// ─── DELETE /templates/:id ────────────────────────────────────────────────────
// Soft deactivate only — never hard delete

router.delete('/templates/:id', async (req, res) => {
    const cid = req.companyId;
    const { data: existing } = await supabase
        .from('practice_tax_checklist_templates').select('id').eq('id', req.params.id).eq('company_id', cid).single();
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const { error } = await supabase
        .from('practice_tax_checklist_templates')
        .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: req.userId || null })
        .eq('id', req.params.id)
        .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    await logTemplateEvent(cid, parseInt(req.params.id), 'tax_checklist_template_deactivated', { actorUserId: req.userId });
    await auditFromReq(req, 'DEACTIVATE', 'practice_tax_checklist_template', parseInt(req.params.id), { module: 'practice' });
    res.json({ success: true });
});

// ─── GET /templates/:id/items ─────────────────────────────────────────────────

router.get('/templates/:id/items', async (req, res) => {
    const cid = req.companyId;
    const templateId = parseInt(req.params.id);

    const { data: tpl } = await supabase
        .from('practice_tax_checklist_templates').select('id').eq('id', templateId).eq('company_id', cid).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const { data, error } = await supabase
        .from('practice_tax_checklist_template_items')
        .select('*')
        .eq('template_id', templateId)
        .eq('company_id', cid)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
});

// ─── POST /templates/:id/items ────────────────────────────────────────────────

router.post('/templates/:id/items', async (req, res) => {
    const cid = req.companyId;
    const templateId = parseInt(req.params.id);

    const { data: tpl } = await supabase
        .from('practice_tax_checklist_templates').select('id').eq('id', templateId).eq('company_id', cid).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const { item_name, item_description, item_category, target_type, required, sort_order, default_due_offset_days, settings } = req.body;

    if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name is required' });
    const cat    = item_category || 'document';
    const target = target_type  || 'document_request';
    if (!ITEM_CATEGORIES.includes(cat))   return res.status(400).json({ error: 'Invalid item_category' });
    if (!TARGET_TYPES.includes(target))   return res.status(400).json({ error: 'Invalid target_type' });

    // Auto sort_order if not provided
    let nextOrder = sort_order != null ? parseInt(sort_order) : null;
    if (nextOrder == null) {
        const { data: last } = await supabase
            .from('practice_tax_checklist_template_items')
            .select('sort_order')
            .eq('template_id', templateId)
            .order('sort_order', { ascending: false })
            .limit(1)
            .single();
        nextOrder = last?.sort_order != null ? last.sort_order + 1 : 1;
    }

    const { data, error } = await supabase
        .from('practice_tax_checklist_template_items')
        .insert({
            company_id:              cid,
            template_id:             templateId,
            item_name:               item_name.trim(),
            item_description:        item_description || null,
            item_category:           cat,
            target_type:             target,
            required:                required !== false,
            sort_order:              nextOrder,
            default_due_offset_days: default_due_offset_days != null ? parseInt(default_due_offset_days) : null,
            settings:                settings || {},
        })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await logTemplateEvent(cid, templateId, 'tax_checklist_item_created', { actorUserId: req.userId, metadata: { item_id: data.id } });
    res.status(201).json({ item: data });
});

// ─── PUT /templates/:id/items/:itemId ─────────────────────────────────────────

router.put('/templates/:id/items/:itemId', async (req, res) => {
    const cid = req.companyId;
    const templateId = parseInt(req.params.id);
    const itemId     = parseInt(req.params.itemId);

    const { data: existing } = await supabase
        .from('practice_tax_checklist_template_items')
        .select('id').eq('id', itemId).eq('template_id', templateId).eq('company_id', cid).single();
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const allowed = ['item_name', 'item_description', 'item_category', 'target_type', 'required', 'sort_order', 'default_due_offset_days', 'settings'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.item_category && !ITEM_CATEGORIES.includes(updates.item_category))
        return res.status(400).json({ error: 'Invalid item_category' });
    if (updates.target_type   && !TARGET_TYPES.includes(updates.target_type))
        return res.status(400).json({ error: 'Invalid target_type' });

    const { data, error } = await supabase
        .from('practice_tax_checklist_template_items')
        .update(updates)
        .eq('id', itemId)
        .eq('template_id', templateId)
        .eq('company_id', cid)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });

    await logTemplateEvent(cid, templateId, 'tax_checklist_item_updated', { actorUserId: req.userId, metadata: { item_id: data.id } });
    res.json({ item: data });
});

// ─── DELETE /templates/:id/items/:itemId ──────────────────────────────────────

router.delete('/templates/:id/items/:itemId', async (req, res) => {
    const cid        = req.companyId;
    const templateId = parseInt(req.params.id);
    const itemId     = parseInt(req.params.itemId);

    const { data: existing } = await supabase
        .from('practice_tax_checklist_template_items')
        .select('id').eq('id', itemId).eq('template_id', templateId).eq('company_id', cid).single();
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const { error } = await supabase
        .from('practice_tax_checklist_template_items')
        .delete()
        .eq('id', itemId)
        .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
});

// ─── POST /seed-defaults ──────────────────────────────────────────────────────

router.post('/seed-defaults', async (req, res) => {
    const cid = req.companyId;

    // Check which template types are already seeded for this company
    const { data: existing } = await supabase
        .from('practice_tax_checklist_templates')
        .select('template_type, template_name')
        .eq('company_id', cid)
        .eq('is_default', true);

    const seededTypes = new Set((existing || []).map(t => t.template_type + ':' + t.template_name));

    let created = 0;
    let skipped = 0;

    for (const tpl of SEED_TEMPLATES) {
        const key = tpl.template_type + ':' + tpl.template_name;
        if (seededTypes.has(key)) { skipped++; continue; }

        const { data: newTpl, error: tErr } = await supabase
            .from('practice_tax_checklist_templates')
            .insert({
                company_id:    cid,
                template_name: tpl.template_name,
                template_type: tpl.template_type,
                client_type:   tpl.client_type   || null,
                description:   tpl.description   || null,
                is_active:     true,
                is_default:    true,
                settings:      {},
                created_by:    req.userId || null,
            })
            .select().single();

        if (tErr || !newTpl) { skipped++; continue; }

        const itemRows = tpl.items.map(item => ({
            company_id:              cid,
            template_id:             newTpl.id,
            item_name:               item.item_name,
            item_description:        item.item_description || null,
            item_category:           item.item_category || 'document',
            target_type:             item.target_type  || 'document_request',
            required:                item.required !== false,
            sort_order:              item.sort_order || null,
            default_due_offset_days: item.default_due_offset_days || null,
            settings:                item.settings || {},
        }));

        if (itemRows.length > 0) {
            await supabase.from('practice_tax_checklist_template_items').insert(itemRows);
        }

        await logTemplateEvent(cid, newTpl.id, 'tax_checklist_defaults_seeded', { actorUserId: req.userId });
        created++;
    }

    await auditFromReq(req, 'CREATE', 'practice_tax_checklist_defaults', 0, {
        module: 'practice',
        created,
        skipped,
    });

    res.json({ success: true, templates_created: created, templates_skipped: skipped });
});

// ─── POST /templates/:id/apply ────────────────────────────────────────────────

router.post('/templates/:id/apply', async (req, res) => {
    const cid        = req.companyId;
    const templateId = parseInt(req.params.id);

    const {
        client_id,
        compliance_pack_id,
        individual_tax_return_id,
        company_tax_return_id,
        due_date,
        create_document_requests = false,
        create_pack_items        = false,
        create_tax_items         = false,
    } = req.body;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });
    if (!create_document_requests && !create_pack_items && !create_tax_items)
        return res.status(400).json({ error: 'At least one of create_document_requests, create_pack_items, or create_tax_items must be true' });

    // Validate all ownership concurrently
    const checks = [
        supabase.from('practice_tax_checklist_templates').select('id, is_active').eq('id', templateId).eq('company_id', cid).single(),
        verifyBelongsToCompany(cid, 'practice_clients', client_id),
        compliance_pack_id        ? verifyBelongsToCompany(cid, 'practice_compliance_packs', compliance_pack_id)      : Promise.resolve(true),
        individual_tax_return_id  ? verifyBelongsToCompany(cid, 'practice_individual_tax_returns', individual_tax_return_id) : Promise.resolve(true),
        company_tax_return_id     ? verifyBelongsToCompany(cid, 'practice_company_tax_returns', company_tax_return_id)     : Promise.resolve(true),
    ];

    const [tplRes, clientOk, packOk, indOk, coOk] = await Promise.all(checks);

    if (!tplRes.data || !tplRes.data.is_active) return res.status(404).json({ error: 'Template not found or inactive' });
    if (!clientOk) return res.status(400).json({ error: 'client_id not found in this company' });
    if (compliance_pack_id && !packOk)
        return res.status(400).json({ error: 'compliance_pack_id not found in this company' });
    if (individual_tax_return_id && !indOk)
        return res.status(400).json({ error: 'individual_tax_return_id not found in this company' });
    if (company_tax_return_id && !coOk)
        return res.status(400).json({ error: 'company_tax_return_id not found in this company' });

    // Load all template items
    const { data: items, error: iErr } = await supabase
        .from('practice_tax_checklist_template_items')
        .select('*')
        .eq('template_id', templateId)
        .eq('company_id', cid)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('id');
    if (iErr) return res.status(500).json({ error: iErr.message });
    if (!items || items.length === 0)
        return res.status(400).json({ error: 'Template has no items to apply' });

    const now     = new Date().toISOString();
    const clientIdInt = parseInt(client_id);

    // Load existing doc request titles for this client (duplicate guard)
    const { data: existingDocRequests } = create_document_requests
        ? await supabase.from('practice_document_requests')
            .select('request_title')
            .eq('company_id', cid)
            .eq('client_id', clientIdInt)
            .neq('request_status', 'cancelled')
        : { data: [] };
    const existingDocTitles = new Set((existingDocRequests || []).map(r => r.request_title.toLowerCase()));

    // Load existing individual tax items for this return (duplicate guard)
    const { data: existingIndItems } = (create_tax_items && individual_tax_return_id)
        ? await supabase.from('practice_individual_tax_items')
            .select('item_label')
            .eq('tax_return_id', parseInt(individual_tax_return_id))
            .eq('company_id', cid)
        : { data: [] };
    const existingIndLabels = new Set((existingIndItems || []).map(r => r.item_label.toLowerCase()));

    // Load existing company tax readiness items (duplicate guard)
    const { data: existingCoItems } = (create_tax_items && company_tax_return_id)
        ? await supabase.from('practice_company_tax_readiness_items')
            .select('item_name')
            .eq('company_tax_return_id', parseInt(company_tax_return_id))
            .eq('company_id', cid)
        : { data: [] };
    const existingCoNames = new Set((existingCoItems || []).map(r => r.item_name.toLowerCase()));

    let docRequestsCreated = 0;
    let packItemsCreated   = 0;
    let taxItemsCreated    = 0;
    let skipped            = 0;

    for (const item of items) {
        const tType = item.target_type;

        // ── Document requests ──────────────────────────────────────────────────
        if (tType === 'document_request' && create_document_requests) {
            if (existingDocTitles.has(item.item_name.toLowerCase())) { skipped++; continue; }

            const dueDate = due_date || (item.default_due_offset_days != null
                ? new Date(Date.now() + item.default_due_offset_days * 86400000).toISOString().split('T')[0]
                : null);

            const { error: drErr } = await supabase.from('practice_document_requests').insert({
                company_id:          cid,
                client_id:           clientIdInt,
                request_title:       item.item_name,
                request_description: item.item_description || null,
                document_category:   resolveDocCategory(item),
                request_status:      'requested',
                required_by_date:    dueDate || null,
                requested_at:        now,
                created_by:          req.userId || null,
            });
            if (!drErr) { docRequestsCreated++; existingDocTitles.add(item.item_name.toLowerCase()); }
        }

        // ── Compliance pack items ──────────────────────────────────────────────
        else if (tType === 'compliance_pack_item' && create_pack_items && compliance_pack_id) {
            const { error: piErr } = await supabase.from('practice_compliance_pack_items').insert({
                company_id:   cid,
                pack_id:      parseInt(compliance_pack_id),
                item_type:    resolvePackItemType(item),
                item_name:    item.item_name,
                item_description: item.item_description || null,
                required:     item.required,
                sort_order:   item.sort_order || null,
                status:       'required',
            });
            if (!piErr) packItemsCreated++;
        }

        // ── Individual tax items ───────────────────────────────────────────────
        else if (tType === 'individual_tax_item' && create_tax_items && individual_tax_return_id) {
            if (existingIndLabels.has(item.item_name.toLowerCase())) { skipped++; continue; }

            const { error: itErr } = await supabase.from('practice_individual_tax_items').insert({
                company_id:    cid,
                tax_return_id: parseInt(individual_tax_return_id),
                item_type:     resolveIndTaxItemType(item),
                item_label:    item.item_name,
                item_status:   'required',
                notes:         item.item_description || null,
            });
            if (!itErr) { taxItemsCreated++; existingIndLabels.add(item.item_name.toLowerCase()); }
        }

        // ── Company tax readiness items ────────────────────────────────────────
        else if (tType === 'company_tax_item' && create_tax_items && company_tax_return_id) {
            if (existingCoNames.has(item.item_name.toLowerCase())) { skipped++; continue; }

            const { error: ctErr } = await supabase.from('practice_company_tax_readiness_items').insert({
                company_id:            cid,
                company_tax_return_id: parseInt(company_tax_return_id),
                item_type:             resolveCoTaxItemType(item),
                item_name:             item.item_name,
                status:                'required',
                required:              item.required,
                notes:                 item.item_description || null,
            });
            if (!ctErr) { taxItemsCreated++; existingCoNames.add(item.item_name.toLowerCase()); }
        }
    }

    await logTemplateEvent(cid, templateId, 'tax_checklist_applied', {
        actorUserId: req.userId,
        metadata: { client_id: clientIdInt, doc_requests_created: docRequestsCreated, pack_items_created: packItemsCreated, tax_items_created: taxItemsCreated, skipped },
    });
    await auditFromReq(req, 'APPLY', 'practice_tax_checklist_template', templateId, {
        module: 'practice', client_id: clientIdInt, doc_requests_created: docRequestsCreated, pack_items_created: packItemsCreated, tax_items_created: taxItemsCreated,
    });

    res.json({
        success:              true,
        doc_requests_created: docRequestsCreated,
        pack_items_created:   packItemsCreated,
        tax_items_created:    taxItemsCreated,
        skipped,
    });
});

module.exports = router;
