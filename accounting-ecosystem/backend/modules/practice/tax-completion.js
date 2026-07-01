'use strict';

// Codebox 45 — Tax Compliance Finalization + Completion Evidence Pack
// Internal quality-control and partner sign-off gate before a tax matter is
// considered complete. Enforces checklist completion, quality gate checks
// (outstanding payments, unmatched SARS lines, open disputes), and partner approval.
//
// NOT SARS API. NOT document storage. NOT eFiling integration.
// All data is internal practice-management state only.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const PACK_STATUSES     = ['draft', 'review_pending', 'approved', 'completed', 'cancelled'];
const SOURCE_TYPES      = ['individual_tax', 'company_tax', 'provisional_tax', 'vat', 'payroll'];
const ITEM_TYPES        = ['submission_proof', 'assessment', 'payment_proof', 'refund_proof',
                           'reconciliation', 'dispute', 'supporting_documents', 'working_papers',
                           'client_approval', 'partner_review', 'internal_review', 'other'];
const TERMINAL_STATUSES = ['completed', 'cancelled'];
const OVERRIDABLE_TYPES = ['outstanding_payments', 'unmatched_sars_lines', 'open_disputes'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyPack(id, cid) {
    const { data } = await supabase
        .from('practice_tax_completion_packs')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _verifyItem(itemId, packId, cid) {
    const { data } = await supabase
        .from('practice_tax_completion_items')
        .select('*')
        .eq('id', itemId)
        .eq('completion_pack_id', packId)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _writeEvent(packId, cid, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_tax_completion_events').insert({
        completion_pack_id: packId,
        company_id: cid,
        event_type: eventType,
        old_status: oldStatus || null,
        new_status: newStatus || null,
        actor_user_id: userId || null,
        notes: notes || null,
        metadata: meta || {},
    });
}

// Recalculate completion_score from current items.
// 100 if no required items exist; otherwise floor(done/required * 100).
async function _recalculateScore(packId, cid) {
    const { data: items } = await supabase
        .from('practice_tax_completion_items')
        .select('required, completed')
        .eq('completion_pack_id', packId)
        .eq('company_id', cid);
    const all = items || [];
    const required = all.filter(i => i.required);
    if (required.length === 0) return 100;
    const done = required.filter(i => i.completed);
    return Math.round((done.length / required.length) * 100);
}

// Save recalculated score to DB.
async function _saveScore(packId, cid, score, userId) {
    await supabase
        .from('practice_tax_completion_packs')
        .update({ completion_score: score, updated_by: userId || null })
        .eq('id', packId)
        .eq('company_id', cid);
}

// Enrich a list of packs with client_name from practice_clients.
async function _enrichClientNames(packs, cid) {
    if (!packs || packs.length === 0) return packs;
    const ids = [...new Set(packs.map(p => p.client_id).filter(Boolean))];
    if (!ids.length) return packs;
    const { data: clients } = await supabase
        .from('practice_clients')
        .select('id, client_name')
        .eq('company_id', cid)
        .in('id', ids);
    const nameMap = {};
    (clients || []).forEach(c => { nameMap[c.id] = c.client_name; });
    return packs.map(p => ({ ...p, client_name: nameMap[p.client_id] || null }));
}

// Default checklist items per source_type. All required unless noted.
function _defaultItems(sourceType) {
    const sets = {
        individual_tax: [
            { item_type: 'submission_proof',     item_name: 'Submission Proof',               required: true,  sort_order: 1 },
            { item_type: 'assessment',           item_name: 'Assessment / SARS Response',     required: true,  sort_order: 2 },
            { item_type: 'payment_proof',        item_name: 'Payment / Refund Handling',      required: true,  sort_order: 3 },
            { item_type: 'reconciliation',       item_name: 'SARS Statement Reconciliation',  required: true,  sort_order: 4 },
            { item_type: 'supporting_documents', item_name: 'Supporting Documents',           required: true,  sort_order: 5 },
            { item_type: 'working_papers',       item_name: 'Working Papers',                 required: true,  sort_order: 6 },
            { item_type: 'partner_review',       item_name: 'Partner Review',                 required: true,  sort_order: 7 },
        ],
        company_tax: [
            { item_type: 'submission_proof',     item_name: 'Submission Proof',               required: true,  sort_order: 1 },
            { item_type: 'internal_review',      item_name: 'AFS Review',                     required: true,  sort_order: 2 },
            { item_type: 'internal_review',      item_name: 'Tax Adjustments Review',         required: true,  sort_order: 3 },
            { item_type: 'assessment',           item_name: 'Assessment / SARS Response',     required: true,  sort_order: 4 },
            { item_type: 'payment_proof',        item_name: 'Payment / Refund Handling',      required: true,  sort_order: 5 },
            { item_type: 'reconciliation',       item_name: 'SARS Statement Reconciliation',  required: true,  sort_order: 6 },
            { item_type: 'supporting_documents', item_name: 'Supporting Documents',           required: true,  sort_order: 7 },
            { item_type: 'working_papers',       item_name: 'Working Papers',                 required: true,  sort_order: 8 },
            { item_type: 'partner_review',       item_name: 'Partner Review',                 required: true,  sort_order: 9 },
        ],
        provisional_tax: [
            { item_type: 'submission_proof',     item_name: 'Submission Proof',               required: true,  sort_order: 1 },
            { item_type: 'supporting_documents', item_name: 'Tax Calculation',                required: true,  sort_order: 2 },
            { item_type: 'payment_proof',        item_name: 'Payment Handling',               required: true,  sort_order: 3 },
            { item_type: 'working_papers',       item_name: 'Working Papers',                 required: true,  sort_order: 4 },
            { item_type: 'partner_review',       item_name: 'Partner Review',                 required: true,  sort_order: 5 },
        ],
        vat: [
            { item_type: 'submission_proof',     item_name: 'VAT201 Submission',              required: true,  sort_order: 1 },
            { item_type: 'payment_proof',        item_name: 'Payment / Refund Handling',      required: true,  sort_order: 2 },
            { item_type: 'reconciliation',       item_name: 'SARS Statement Reconciliation',  required: true,  sort_order: 3 },
            { item_type: 'working_papers',       item_name: 'Input/Output Reconciliation',    required: true,  sort_order: 4 },
            { item_type: 'working_papers',       item_name: 'Working Papers',                 required: false, sort_order: 5 },
            { item_type: 'partner_review',       item_name: 'Partner Review',                 required: true,  sort_order: 6 },
        ],
        payroll: [
            { item_type: 'submission_proof',     item_name: 'EMP201 / EMP501 Submission',     required: true,  sort_order: 1 },
            { item_type: 'payment_proof',        item_name: 'PAYE Payment',                   required: true,  sort_order: 2 },
            { item_type: 'payment_proof',        item_name: 'UIF / SDL Payment',              required: true,  sort_order: 3 },
            { item_type: 'reconciliation',       item_name: 'EMP Reconciliation',             required: true,  sort_order: 4 },
            { item_type: 'working_papers',       item_name: 'Working Papers',                 required: false, sort_order: 5 },
            { item_type: 'partner_review',       item_name: 'Partner Review',                 required: true,  sort_order: 6 },
        ],
    };
    return sets[sourceType] || [];
}

// Quality gate: returns array of block objects.
// severity: 'hard' = cannot be overridden, 'soft' = partner override allowed.
// Items are passed in from caller to avoid redundant DB query.
async function _runQualityGate(pack, cid, items) {
    const blocks = [];

    // HARD — score must be 100%
    if (pack.completion_score < 100) {
        const total = items.filter(i => i.required).length;
        const done  = items.filter(i => i.required && i.completed).length;
        blocks.push({
            type: 'incomplete_checklist',
            severity: 'hard',
            message: `Completion score is ${pack.completion_score}% — ${done}/${total} required items complete. All required items must be marked complete before finishing.`,
        });
    }

    // HARD — pack must be in approved status
    if (pack.pack_status !== 'approved') {
        blocks.push({
            type: 'not_approved',
            severity: 'hard',
            message: `Pack is in "${pack.pack_status}" status. It must be submitted for review and approved by a partner before completion.`,
        });
    }

    // Submission-level blocks — only if a submission_id is set
    if (!pack.submission_id) return blocks;

    const sid = pack.submission_id;

    // SOFT — outstanding/unresolved payments
    const { data: payments } = await supabase
        .from('practice_tax_payments')
        .select('id, direction, status, original_amount, balance_outstanding')
        .eq('company_id', cid)
        .eq('submission_id', sid);

    const blockingPayments = (payments || []).filter(p => {
        if (p.direction === 'payable'    && ['outstanding', 'partially_paid'].includes(p.status)) return true;
        if (p.direction === 'refundable' && p.status === 'refund_pending')                         return true;
        return false;
    });

    if (blockingPayments.length > 0) {
        blocks.push({
            type: 'outstanding_payments',
            severity: 'soft',
            message: `${blockingPayments.length} payment record(s) are unresolved (outstanding, partially paid, or refund pending).`,
            data: blockingPayments.map(p => ({ id: p.id, direction: p.direction, status: p.status, balance_outstanding: p.balance_outstanding })),
        });
    }

    // SOFT — unmatched or disputed SARS statement lines
    const { data: lines } = await supabase
        .from('practice_sars_statement_lines')
        .select('id, reconciliation_status, debit_amount, credit_amount')
        .eq('company_id', cid)
        .eq('submission_id', sid);

    const blockingLines = (lines || []).filter(l => ['unmatched', 'disputed'].includes(l.reconciliation_status));
    if (blockingLines.length > 0) {
        blocks.push({
            type: 'unmatched_sars_lines',
            severity: 'soft',
            message: `${blockingLines.length} SARS statement line(s) are unmatched or disputed.`,
            data: blockingLines.map(l => ({ id: l.id, status: l.reconciliation_status })),
        });
    }

    // SOFT — open (non-terminal, non-rejected) dispute cases
    const { data: disputes } = await supabase
        .from('practice_tax_dispute_cases')
        .select('id, case_type, case_status, title')
        .eq('company_id', cid)
        .eq('submission_id', sid)
        .not('case_status', 'in', '("accepted","rejected","completed","cancelled")');

    if ((disputes || []).length > 0) {
        blocks.push({
            type: 'open_disputes',
            severity: 'soft',
            message: `${disputes.length} dispute/objection case(s) are still active (not accepted, rejected, or completed).`,
            data: (disputes || []).map(d => ({ id: d.id, case_type: d.case_type, case_status: d.case_status, title: d.title })),
        });
    }

    return blocks;
}

// Check if a soft block type has a valid partner override in pack.settings.
function _isOverridden(settings, blockType) {
    const overrides = (settings && settings.partner_overrides) || [];
    return overrides.some(o => o.override_type === blockType);
}

// Build the immutable completion snapshot frozen at completion time.
async function _buildCompletionSnapshot(pack, cid, items, userId) {
    const snapshot = {
        frozen_at:        new Date().toISOString(),
        frozen_by:        userId || null,
        pack_id:          pack.id,
        client_id:        pack.client_id,
        submission_id:    pack.submission_id,
        source_type:      pack.source_type,
        completion_score: pack.completion_score,
        approved_by:      pack.approved_by,
        approved_at:      pack.approved_at,
        review_notes:     pack.review_notes,
        partner_notes:    pack.partner_notes,
        partner_overrides: (pack.settings && pack.settings.partner_overrides) || [],
        checklist_items:  items.map(i => ({
            id:           i.id,
            item_type:    i.item_type,
            item_name:    i.item_name,
            required:     i.required,
            completed:    i.completed,
            completed_at: i.completed_at,
            completed_by: i.completed_by,
            notes:        i.notes,
        })),
    };

    // Gather linked-module summaries if submission_id is set.
    if (pack.submission_id) {
        const sid = pack.submission_id;

        const { data: payments } = await supabase
            .from('practice_tax_payments')
            .select('id, direction, status, original_amount, balance_outstanding')
            .eq('company_id', cid).eq('submission_id', sid);
        snapshot.payments_at_completion = (payments || []).map(p => ({
            id: p.id, direction: p.direction, status: p.status,
            original_amount: p.original_amount, balance_outstanding: p.balance_outstanding,
        }));

        const { data: ls } = await supabase
            .from('practice_sars_statement_lines')
            .select('id, reconciliation_status, debit_amount, credit_amount')
            .eq('company_id', cid).eq('submission_id', sid);
        const lines = ls || [];
        snapshot.sars_recon_at_completion = {
            total:     lines.length,
            matched:   lines.filter(l => l.reconciliation_status === 'matched').length,
            unmatched: lines.filter(l => l.reconciliation_status === 'unmatched').length,
            disputed:  lines.filter(l => l.reconciliation_status === 'disputed').length,
            ignored:   lines.filter(l => l.reconciliation_status === 'ignored').length,
        };

        const { data: disputes } = await supabase
            .from('practice_tax_dispute_cases')
            .select('id, case_type, case_status, title')
            .eq('company_id', cid).eq('submission_id', sid);
        snapshot.disputes_at_completion = (disputes || []).map(d => ({
            id: d.id, case_type: d.case_type, case_status: d.case_status, title: d.title,
        }));
    }

    return snapshot;
}

// ── Routes ────────────────────────────────────────────────────────────────────
// NOTE: specific routes (GET /summary, POST /create-from-submission) are defined
// BEFORE parameterised routes (GET /:id) to avoid Express path collisions.

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: packs } = await supabase
            .from('practice_tax_completion_packs')
            .select('pack_status, completion_score')
            .eq('company_id', cid);
        const all = packs || [];

        const counts = { draft: 0, review_pending: 0, approved: 0, completed: 0, cancelled: 0 };
        let low_score = 0, near_complete = 0;

        all.forEach(p => {
            if (counts[p.pack_status] !== undefined) counts[p.pack_status]++;
            if (!TERMINAL_STATUSES.includes(p.pack_status)) {
                if (p.completion_score < 50)                                   low_score++;
                if (p.completion_score >= 75 && p.completion_score < 100)      near_complete++;
            }
        });

        return res.json({
            total_active:         all.filter(p => !TERMINAL_STATUSES.includes(p.pack_status)).length,
            total_draft:          counts.draft,
            total_review_pending: counts.review_pending,
            total_approved:       counts.approved,
            total_completed:      counts.completed,
            total_cancelled:      counts.cancelled,
            low_score_count:      low_score,
            near_complete_count:  near_complete,
        });
    } catch (err) {
        console.error('GET /api/practice/tax-completion/summary', err);
        return res.status(500).json({ error: 'Failed to load completion summary.' });
    }
});

// ── GET / (list) ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        pack_status, source_type, client_id, submission_id,
        active_only, search,
        page = 1, per_page = 50,
    } = req.query;

    try {
        let q = supabase
            .from('practice_tax_completion_packs')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (pack_status)   q = q.eq('pack_status', pack_status);
        if (source_type)   q = q.eq('source_type', source_type);
        if (client_id)     q = q.eq('client_id', parseInt(client_id, 10));
        if (submission_id) q = q.eq('submission_id', parseInt(submission_id, 10));

        if (active_only === 'true' || active_only === '1') {
            q = q.not('pack_status', 'in', '("completed","cancelled")');
        }

        const limit  = Math.min(Math.max(parseInt(per_page, 10) || 50, 1), 200);
        const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

        q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        const enriched = await _enrichClientNames(data || [], cid);

        return res.json({ packs: enriched, total: count || 0, page: parseInt(page, 10) || 1, per_page: limit });
    } catch (err) {
        console.error('GET /api/practice/tax-completion', err);
        return res.status(500).json({ error: 'Failed to load completion packs.' });
    }
});

// ── POST /create-from-submission ─────────────────────────────────────────────
// Auto-links the pack to a submission and generates default checklist items.
// Ordered BEFORE POST / and GET /:id to avoid route collision.

router.post('/create-from-submission', async (req, res) => {
    const cid = req.companyId;
    const { submission_id, source_type, client_id } = req.body || {};

    if (!submission_id) return res.status(400).json({ error: 'submission_id is required.' });
    if (!source_type)   return res.status(400).json({ error: 'source_type is required.' });
    if (!client_id)     return res.status(400).json({ error: 'client_id is required.' });
    if (!SOURCE_TYPES.includes(source_type)) {
        return res.status(400).json({ error: `Invalid source_type. Must be one of: ${SOURCE_TYPES.join(', ')}` });
    }

    try {
        // Verify client belongs to this company
        const { data: client } = await supabase
            .from('practice_clients')
            .select('id')
            .eq('id', client_id)
            .eq('company_id', cid)
            .maybeSingle();
        if (!client) return res.status(404).json({ error: 'Client not found.' });

        // Verify submission belongs to this company
        const { data: submission } = await supabase
            .from('practice_tax_submissions')
            .select('id, submission_status, client_id, tax_type, tax_year')
            .eq('id', submission_id)
            .eq('company_id', cid)
            .maybeSingle();
        if (!submission) return res.status(404).json({ error: 'Tax submission not found.' });

        // Duplicate guard — one active pack per submission
        const { data: existing } = await supabase
            .from('practice_tax_completion_packs')
            .select('id')
            .eq('company_id', cid)
            .eq('submission_id', submission_id)
            .not('pack_status', 'in', '("completed","cancelled")')
            .limit(1)
            .maybeSingle();
        if (existing) {
            return res.status(409).json({
                error: 'An active completion pack already exists for this submission.',
                existing_pack_id: existing.id,
            });
        }

        // Insert pack
        const { data: pack, error: packErr } = await supabase
            .from('practice_tax_completion_packs')
            .insert({
                company_id:    cid,
                client_id,
                submission_id,
                source_type,
                pack_status:   'draft',
                completion_score: 0,
                created_by:    req.user?.userId,
                updated_by:    req.user?.userId,
            })
            .select()
            .single();
        if (packErr) throw packErr;

        // Generate default items
        const defaults = _defaultItems(source_type);
        if (defaults.length > 0) {
            await supabase.from('practice_tax_completion_items').insert(
                defaults.map(d => ({ company_id: cid, completion_pack_id: pack.id, ...d }))
            );
        }

        // Initial score — 0 since all items start incomplete
        // (Score stays at 0; recalculate after any item is completed)

        await _writeEvent(pack.id, cid, 'pack_created', null, 'draft', req.user?.userId, null, {
            source: 'create-from-submission', submission_id, source_type, items_generated: defaults.length,
        });

        await auditFromReq(req, 'completion_pack_created', 'completion_pack', pack.id, {
            submission_id, source_type, default_items_count: defaults.length,
        });

        return res.status(201).json({ pack, default_items_count: defaults.length });
    } catch (err) {
        console.error('POST /api/practice/tax-completion/create-from-submission', err);
        return res.status(500).json({ error: 'Failed to create completion pack from submission.' });
    }
});

// ── POST / (manual create) ────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, submission_id, source_type, source_id,
        review_notes, partner_notes, completion_summary,
    } = req.body || {};

    if (!client_id)   return res.status(400).json({ error: 'client_id is required.' });
    if (!source_type) return res.status(400).json({ error: 'source_type is required.' });
    if (!SOURCE_TYPES.includes(source_type)) {
        return res.status(400).json({ error: `Invalid source_type. Must be one of: ${SOURCE_TYPES.join(', ')}` });
    }

    try {
        const { data: client } = await supabase
            .from('practice_clients')
            .select('id')
            .eq('id', client_id)
            .eq('company_id', cid)
            .maybeSingle();
        if (!client) return res.status(404).json({ error: 'Client not found.' });

        const { data: pack, error } = await supabase
            .from('practice_tax_completion_packs')
            .insert({
                company_id: cid,
                client_id,
                submission_id: submission_id || null,
                source_type,
                source_id:    source_id || null,
                pack_status:  'draft',
                completion_score: 0,
                review_notes:    review_notes    || null,
                partner_notes:   partner_notes   || null,
                completion_summary: completion_summary || null,
                created_by:  req.user?.userId,
                updated_by:  req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'pack_created', null, 'draft', req.user?.userId, null, {
            source: 'manual',
        });

        await auditFromReq(req, 'completion_pack_created', 'completion_pack', pack.id, {
            source_type, source: 'manual',
        });

        return res.status(201).json(pack);
    } catch (err) {
        console.error('POST /api/practice/tax-completion', err);
        return res.status(500).json({ error: 'Failed to create completion pack.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
// Returns pack + checklist items + quality gate status (for active packs).

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });

        // Load items sorted by sort_order
        const { data: items } = await supabase
            .from('practice_tax_completion_items')
            .select('*')
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .order('sort_order', { ascending: true });

        // Enrich with client name
        const [enriched] = await _enrichClientNames([pack], cid);

        // Run quality gate for active packs (informational — not blocking on GET)
        let quality_gate = { hard_blocks: [], soft_blocks: [], overrides_applied: [] };
        if (!TERMINAL_STATUSES.includes(pack.pack_status)) {
            const allBlocks = await _runQualityGate(pack, cid, items || []);
            quality_gate = {
                hard_blocks:      allBlocks.filter(b => b.severity === 'hard'),
                soft_blocks:      allBlocks.filter(b => b.severity === 'soft' && !_isOverridden(pack.settings, b.type)),
                overrides_applied: (pack.settings && pack.settings.partner_overrides) || [],
                soft_overridden:  allBlocks.filter(b => b.severity === 'soft' &&  _isOverridden(pack.settings, b.type)),
            };
        }

        return res.json({ ...enriched, items: items || [], quality_gate });
    } catch (err) {
        console.error('GET /api/practice/tax-completion/:id', err);
        return res.status(500).json({ error: 'Failed to load completion pack.' });
    }
});

// ── PUT /:id (update non-status fields) ──────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['review_notes', 'partner_notes', 'completion_summary'];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot modify a completed or cancelled pack.' });
        }

        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update({ ...patch, updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'pack_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'completion_pack_updated', 'completion_pack', pack.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id', err);
        return res.status(500).json({ error: 'Failed to update completion pack.' });
    }
});

// ── DELETE /:id (soft cancel) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (pack.pack_status === 'completed') {
            return res.status(422).json({ error: 'A completed pack cannot be cancelled.' });
        }
        if (pack.pack_status === 'cancelled') {
            return res.status(422).json({ error: 'Pack is already cancelled.' });
        }

        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update({ pack_status: 'cancelled', updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'pack_cancelled', pack.pack_status, 'cancelled', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'completion_pack_cancelled', 'completion_pack', pack.id, {
            previous_status: pack.pack_status, reason: reason || null,
        });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/tax-completion/:id', err);
        return res.status(500).json({ error: 'Failed to cancel completion pack.' });
    }
});

// ── POST /:id/generate-default-items ─────────────────────────────────────────

router.post('/:id/generate-default-items', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot modify a completed or cancelled pack.' });
        }

        const defaults = _defaultItems(pack.source_type);
        if (!defaults.length) {
            return res.status(400).json({ error: `No default items defined for source_type: ${pack.source_type}` });
        }

        const { data: existing } = await supabase
            .from('practice_tax_completion_items')
            .select('id')
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .limit(1);

        if ((existing || []).length > 0) {
            return res.status(409).json({
                error: 'Items already exist for this pack. Delete them first or add items individually.',
            });
        }

        const { data: inserted, error } = await supabase
            .from('practice_tax_completion_items')
            .insert(defaults.map(d => ({ company_id: cid, completion_pack_id: pack.id, ...d })))
            .select();
        if (error) throw error;

        const newScore = await _recalculateScore(pack.id, cid);
        await _saveScore(pack.id, cid, newScore, req.user?.userId);

        await _writeEvent(pack.id, cid, 'default_items_generated', null, null, req.user?.userId, null, {
            source_type: pack.source_type, items_count: inserted.length,
        });
        await auditFromReq(req, 'completion_items_generated', 'completion_pack', pack.id, {
            source_type: pack.source_type, items_count: inserted.length,
        });

        return res.status(201).json({ items: inserted, completion_score: newScore });
    } catch (err) {
        console.error('POST /api/practice/tax-completion/:id/generate-default-items', err);
        return res.status(500).json({ error: 'Failed to generate default items.' });
    }
});

// ── POST /:id/recalculate-score ───────────────────────────────────────────────

router.post('/:id/recalculate-score', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot recalculate score of a completed or cancelled pack.' });
        }

        const newScore = await _recalculateScore(pack.id, cid);
        await _saveScore(pack.id, cid, newScore, req.user?.userId);

        await _writeEvent(pack.id, cid, 'score_recalculated', null, null, req.user?.userId, null, {
            old_score: pack.completion_score, new_score: newScore,
        });

        return res.json({ completion_score: newScore, previous_score: pack.completion_score });
    } catch (err) {
        console.error('POST /api/practice/tax-completion/:id/recalculate-score', err);
        return res.status(500).json({ error: 'Failed to recalculate score.' });
    }
});

// ── PUT /:id/submit-review ────────────────────────────────────────────────────
// Transition: draft → review_pending

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Pack is in a terminal state.' });
        }
        if (pack.pack_status !== 'draft') {
            return res.status(422).json({ error: `Pack must be in "draft" status to submit for review. Current: "${pack.pack_status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update({ pack_status: 'review_pending', updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'submitted_for_review', 'draft', 'review_pending', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'completion_pack_submitted_review', 'completion_pack', pack.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id/submit-review', err);
        return res.status(500).json({ error: 'Failed to submit pack for review.' });
    }
});

// ── PUT /:id/approve ──────────────────────────────────────────────────────────
// Transition: review_pending → approved

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Pack is in a terminal state.' });
        }
        if (pack.pack_status !== 'review_pending') {
            return res.status(422).json({ error: `Pack must be in "review_pending" status to approve. Current: "${pack.pack_status}".` });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update({
                pack_status:  'approved',
                approved_by:  req.user?.userId || null,
                approved_at:  now,
                review_notes: notes || pack.review_notes,
                updated_by:   req.user?.userId,
            })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'pack_approved', 'review_pending', 'approved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'completion_pack_approved', 'completion_pack', pack.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve pack.' });
    }
});

// ── PUT /:id/complete (the quality gate endpoint) ─────────────────────────────
// Transition: approved → completed
// Hard blocks: incomplete checklist, not-approved status.
// Soft blocks (partner-overridable): outstanding payments, unmatched lines, open disputes.

router.put('/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const { partner_notes, completion_summary } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Pack is already in a terminal state.' });
        }
        if (pack.pack_status !== 'approved') {
            return res.status(422).json({
                error: `Pack must be in "approved" status to complete. Current: "${pack.pack_status}".`,
                hint: pack.pack_status === 'draft' ? 'Use submit-review then approve first.' : undefined,
            });
        }

        // Load items (needed for score check and snapshot)
        const { data: items } = await supabase
            .from('practice_tax_completion_items')
            .select('*')
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .order('sort_order', { ascending: true });

        // Ensure score is current (recalculate and update if drifted)
        const currentScore = await _recalculateScore(pack.id, cid);
        if (currentScore !== pack.completion_score) {
            await _saveScore(pack.id, cid, currentScore, req.user?.userId);
            pack.completion_score = currentScore;
        }

        // Run quality gate
        const allBlocks        = await _runQualityGate(pack, cid, items || []);
        const hardBlocks       = allBlocks.filter(b => b.severity === 'hard');
        const softBlocks       = allBlocks.filter(b => b.severity === 'soft');
        const unoverriddenSoft = softBlocks.filter(b => !_isOverridden(pack.settings, b.type));
        const overriddenSoft   = softBlocks.filter(b =>  _isOverridden(pack.settings, b.type));

        if (hardBlocks.length > 0 || unoverriddenSoft.length > 0) {
            return res.status(422).json({
                error: 'Quality gate failed — completion is blocked.',
                hard_blocks: hardBlocks,
                soft_blocks_not_overridden: unoverriddenSoft,
                soft_blocks_overridden: overriddenSoft,
                hint: unoverriddenSoft.length > 0
                    ? 'Use PUT /:id/partner-override to override soft blocks before completing.'
                    : undefined,
            });
        }

        // All gates passed — build snapshot and complete
        const snapshot = await _buildCompletionSnapshot(pack, cid, items || [], req.user?.userId);

        const updates = {
            pack_status:         'completed',
            completion_date:     new Date().toISOString().slice(0, 10),
            completion_snapshot: snapshot,
            updated_by:          req.user?.userId,
        };
        if (partner_notes    != null) updates.partner_notes    = partner_notes;
        if (completion_summary != null) updates.completion_summary = completion_summary;

        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update(updates)
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'pack_completed', 'approved', 'completed', req.user?.userId,
            completion_summary || partner_notes || null,
            { completion_score: currentScore, blocks_overridden: overriddenSoft.map(b => b.type) });

        await auditFromReq(req, 'completion_pack_completed', 'completion_pack', pack.id, {
            completion_score: currentScore,
            blocks_overridden: overriddenSoft.map(b => b.type),
        });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id/complete', err);
        return res.status(500).json({ error: 'Failed to complete pack.' });
    }
});

// ── PUT /:id/partner-override ─────────────────────────────────────────────────
// Record a partner override for a specific soft block type (reason required).
// Overwrites any previous override of the same type (replace, not append).

router.put('/:id/partner-override', async (req, res) => {
    const cid = req.companyId;
    const { override_type, reason } = req.body || {};

    if (!override_type) {
        return res.status(400).json({ error: 'override_type is required.', allowed: OVERRIDABLE_TYPES });
    }
    if (!OVERRIDABLE_TYPES.includes(override_type)) {
        return res.status(400).json({ error: `Invalid override_type. Must be one of: ${OVERRIDABLE_TYPES.join(', ')}` });
    }
    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'reason is required for a partner override.' });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot add override to a completed or cancelled pack.' });
        }

        const existing = (pack.settings && pack.settings.partner_overrides) || [];
        const filtered = existing.filter(o => o.override_type !== override_type);
        const newOverride = {
            override_type,
            reason:    String(reason).trim(),
            user_id:   req.user?.userId || null,
            timestamp: new Date().toISOString(),
        };
        const updatedOverrides = [...filtered, newOverride];

        const { data: updated, error } = await supabase
            .from('practice_tax_completion_packs')
            .update({
                settings:   { ...(pack.settings || {}), partner_overrides: updatedOverrides },
                updated_by: req.user?.userId,
            })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_override_added', null, null, req.user?.userId,
            String(reason).trim(), { override_type });
        await auditFromReq(req, 'completion_pack_override_added', 'completion_pack', pack.id, {
            override_type, reason: String(reason).trim(),
        });

        return res.json({ pack: updated, override: newOverride });
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id/partner-override', err);
        return res.status(500).json({ error: 'Failed to add partner override.' });
    }
});

// ── GET /:id/items ────────────────────────────────────────────────────────────

router.get('/:id/items', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });

        const { data: items, error } = await supabase
            .from('practice_tax_completion_items')
            .select('*')
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .order('sort_order', { ascending: true });
        if (error) throw error;

        return res.json({ items: items || [] });
    } catch (err) {
        console.error('GET /api/practice/tax-completion/:id/items', err);
        return res.status(500).json({ error: 'Failed to load checklist items.' });
    }
});

// ── POST /:id/items ───────────────────────────────────────────────────────────

router.post('/:id/items', async (req, res) => {
    const cid = req.companyId;
    const { item_type, item_name, required, notes, sort_order } = req.body || {};

    if (!item_type || !ITEM_TYPES.includes(item_type)) {
        return res.status(400).json({ error: `item_type is required. Must be one of: ${ITEM_TYPES.join(', ')}` });
    }
    if (!item_name || !String(item_name).trim()) {
        return res.status(400).json({ error: 'item_name is required.' });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot add items to a completed or cancelled pack.' });
        }

        const { data: item, error } = await supabase
            .from('practice_tax_completion_items')
            .insert({
                company_id:        cid,
                completion_pack_id: pack.id,
                item_type,
                item_name:  String(item_name).trim(),
                required:   required !== false && required !== 'false',
                completed:  false,
                notes:      notes || null,
                sort_order: sort_order != null ? parseInt(sort_order, 10) : 99,
            })
            .select()
            .single();
        if (error) throw error;

        // Recalculate score after adding a required item
        const newScore = await _recalculateScore(pack.id, cid);
        await _saveScore(pack.id, cid, newScore, req.user?.userId);

        await _writeEvent(pack.id, cid, 'item_added', null, null, req.user?.userId, null, {
            item_id: item.id, item_name: item.item_name, required: item.required,
        });
        await auditFromReq(req, 'completion_item_added', 'completion_pack', pack.id, {
            item_id: item.id, item_name: item.item_name,
        });

        return res.status(201).json({ item, completion_score: newScore });
    } catch (err) {
        console.error('POST /api/practice/tax-completion/:id/items', err);
        return res.status(500).json({ error: 'Failed to add checklist item.' });
    }
});

// ── PUT /:id/items/:itemId ────────────────────────────────────────────────────
// Update item fields and/or mark complete/incomplete.
// Recalculates score after any change.

router.put('/:id/items/:itemId', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE_ITEM = ['item_name', 'required', 'completed', 'notes', 'sort_order'];
    const patch = _pick(req.body || {}, EDITABLE_ITEM);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE_ITEM });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot modify items on a completed or cancelled pack.' });
        }

        const existingItem = await _verifyItem(req.params.itemId, pack.id, cid);
        if (!existingItem) return res.status(404).json({ error: 'Checklist item not found.' });

        // If completing/uncompleting, manage completed_at and completed_by
        const updates = { ...patch };
        if (patch.completed === true || patch.completed === 'true') {
            updates.completed    = true;
            updates.completed_at = new Date().toISOString();
            updates.completed_by = req.user?.userId || null;
        } else if (patch.completed === false || patch.completed === 'false') {
            updates.completed    = false;
            updates.completed_at = null;
            updates.completed_by = null;
        }

        const { data: item, error } = await supabase
            .from('practice_tax_completion_items')
            .update(updates)
            .eq('id', existingItem.id)
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        // Recalculate score
        const newScore = await _recalculateScore(pack.id, cid);
        await _saveScore(pack.id, cid, newScore, req.user?.userId);

        const wasCompleted   = !existingItem.completed && item.completed;
        const wasUncompleted = existingItem.completed  && !item.completed;
        const eventType = wasCompleted ? 'item_completed' : wasUncompleted ? 'item_uncompleted' : 'item_updated';

        await _writeEvent(pack.id, cid, eventType, null, null, req.user?.userId, null, {
            item_id: item.id, item_name: item.item_name,
            old_score: pack.completion_score, new_score: newScore,
        });
        await auditFromReq(req, 'completion_item_updated', 'completion_pack', pack.id, {
            item_id: item.id, event_type: eventType, new_score: newScore,
        });

        return res.json({ item, completion_score: newScore });
    } catch (err) {
        console.error('PUT /api/practice/tax-completion/:id/items/:itemId', err);
        return res.status(500).json({ error: 'Failed to update checklist item.' });
    }
});

// ── DELETE /:id/items/:itemId ─────────────────────────────────────────────────

router.delete('/:id/items/:itemId', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: 'Cannot remove items from a completed or cancelled pack.' });
        }

        const existingItem = await _verifyItem(req.params.itemId, pack.id, cid);
        if (!existingItem) return res.status(404).json({ error: 'Checklist item not found.' });

        const { error } = await supabase
            .from('practice_tax_completion_items')
            .delete()
            .eq('id', existingItem.id)
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid);
        if (error) throw error;

        const newScore = await _recalculateScore(pack.id, cid);
        await _saveScore(pack.id, cid, newScore, req.user?.userId);

        await _writeEvent(pack.id, cid, 'item_removed', null, null, req.user?.userId, null, {
            item_id: existingItem.id, item_name: existingItem.item_name,
            was_required: existingItem.required, was_completed: existingItem.completed,
        });
        await auditFromReq(req, 'completion_item_removed', 'completion_pack', pack.id, {
            item_id: existingItem.id, item_name: existingItem.item_name,
        });

        return res.json({ message: 'Item removed.', completion_score: newScore });
    } catch (err) {
        console.error('DELETE /api/practice/tax-completion/:id/items/:itemId', err);
        return res.status(500).json({ error: 'Failed to remove checklist item.' });
    }
});

// ── GET /:id/events (append-only audit log) ───────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Completion pack not found.' });

        const { data: events, error } = await supabase
            .from('practice_tax_completion_events')
            .select('*')
            .eq('completion_pack_id', pack.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: events || [] });
    } catch (err) {
        console.error('GET /api/practice/tax-completion/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;
