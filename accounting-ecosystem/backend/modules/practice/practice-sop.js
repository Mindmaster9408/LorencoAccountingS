'use strict';

// Codebox 47 — Practice SOP Templates + Workflow Instruction Library
// The practice's operational instruction manual: reusable SOPs describing HOW
// work must be performed, attached to workflow templates, workflow steps,
// tasks, review tasks, compliance packs, completion packs, and knowledge articles.
//
// NOT AI. NOT document management. NOT workflow execution.

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

const STATUSES = ['draft', 'under_review', 'approved', 'archived'];
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

const LINKED_TYPES = [
    'workflow_template', 'workflow_step', 'task', 'review_task',
    'compliance_pack', 'completion_pack', 'knowledge_article',
];

// Known practice tables for "belongs to this company where practical" checks.
// review_task has no dedicated table — review tasks are practice_tasks rows
// with review_required = true, so it maps to the same table as 'task'.
const LINKED_TYPE_TABLE = {
    workflow_template: 'practice_workflow_templates',
    workflow_step:     'practice_workflow_template_steps',
    task:              'practice_tasks',
    review_task:       'practice_tasks',
    compliance_pack:   'practice_compliance_packs',
    completion_pack:   'practice_tax_completion_packs',
    knowledge_article: 'practice_knowledge_articles',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifySop(id, cid) {
    const { data } = await supabase
        .from('practice_sop_templates')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _verifyLink(linkId, sopId, cid) {
    const { data } = await supabase
        .from('practice_sop_links')
        .select('*')
        .eq('id', linkId)
        .eq('sop_id', sopId)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

// Best-effort check that a linked record belongs to this company.
// Returns true if the linked_type's table is unknown (nothing to check against)
// or if the record is found scoped to this company. Returns false only when
// the table IS known and the record does NOT belong to this company.
async function _verifyLinkedRecordOwnership(cid, linkedType, linkedId) {
    const table = LINKED_TYPE_TABLE[linkedType];
    if (!table) return true;
    const { data } = await supabase
        .from(table)
        .select('id')
        .eq('id', linkedId)
        .eq('company_id', cid)
        .maybeSingle();
    return !!data;
}

async function _writeEvent(sopId, cid, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_sop_events').insert({
        sop_id:        sopId,
        company_id:    cid,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: userId    || null,
        notes:         notes     || null,
        metadata:      meta      || {},
    });
}

// ── Routes ────────────────────────────────────────────────────────────────────
// NOTE: /summary and /linked/:linkedType/:linkedId are defined BEFORE
// parameterised /:id routes to avoid Express path collisions.

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: sops } = await supabase
            .from('practice_sop_templates')
            .select('status, category, difficulty')
            .eq('company_id', cid);

        const all = sops || [];
        const counts = { draft: 0, under_review: 0, approved: 0, archived: 0 };
        all.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });

        return res.json({
            total:        all.length,
            draft:        counts.draft,
            under_review: counts.under_review,
            approved:     counts.approved,
            archived:     counts.archived,
        });
    } catch (err) {
        console.error('GET /api/practice/sop/summary', err);
        return res.status(500).json({ error: 'Failed to load SOP library summary.' });
    }
});

// ── GET /linked/:linkedType/:linkedId ────────────────────────────────────────
// Returns SOPs attached to a given record — used by workflow/task/pack integration.
// Not explicitly listed in the spec's endpoint table, but required to fulfil the
// "Workflow Integration" section (Attached SOPs / Instruction button / Standard
// Procedure / Procedure), mirroring the same endpoint added for the Knowledge
// Base in Codebox 46.

router.get('/linked/:linkedType/:linkedId', async (req, res) => {
    const cid = req.companyId;
    const { linkedType } = req.params;
    const linkedId = Number(req.params.linkedId);

    if (!LINKED_TYPES.includes(linkedType)) {
        return res.status(400).json({ error: `Invalid linked_type. Allowed: ${LINKED_TYPES.join(', ')}` });
    }
    if (!linkedId || isNaN(linkedId)) return res.status(400).json({ error: 'Invalid linked_id.' });

    try {
        const { data: links, error: linkErr } = await supabase
            .from('practice_sop_links')
            .select('*')
            .eq('company_id', cid)
            .eq('linked_type', linkedType)
            .eq('linked_id', linkedId)
            .order('sort_order', { ascending: true });
        if (linkErr) throw linkErr;

        const sopIds = [...new Set((links || []).map(l => l.sop_id))];
        if (!sopIds.length) return res.json({ sops: [], links: [] });

        const { data: sops, error: sopErr } = await supabase
            .from('practice_sop_templates')
            .select('id, title, category, status, summary, estimated_minutes, difficulty, updated_at')
            .eq('company_id', cid)
            .in('id', sopIds);
        if (sopErr) throw sopErr;

        return res.json({ sops: sops || [], links: links || [] });
    } catch (err) {
        console.error('GET /api/practice/sop/linked/:linkedType/:linkedId', err);
        return res.status(500).json({ error: 'Failed to load linked SOPs.' });
    }
});

// ── GET / (list with filters + pagination) ───────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        search, category, status, difficulty,
        page = 1, limit = 50,
    } = req.query;

    try {
        if (status && !STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${STATUSES.join(', ')}` });
        }
        if (difficulty && !DIFFICULTIES.includes(difficulty)) {
            return res.status(400).json({ error: `Invalid difficulty. Allowed: ${DIFFICULTIES.join(', ')}` });
        }

        let q = supabase
            .from('practice_sop_templates')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (category)   q = q.eq('category', category);
        if (status)     q = q.eq('status', status);
        if (difficulty) q = q.eq('difficulty', difficulty);

        if (search) {
            const s = String(search).trim().replace(/[%,]/g, '');
            if (s) q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%,instruction_body.ilike.%${s}%`);
        }

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('updated_at', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        return res.json({ sops: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/sop', err);
        return res.status(500).json({ error: 'Failed to load SOPs.' });
    }
});

// ── POST / (create) ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        title, category, summary, instruction_body, estimated_minutes, difficulty,
        requires_review, effective_from, effective_to, internal_notes,
    } = req.body || {};

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required.' });
    if (!instruction_body || !String(instruction_body).trim()) {
        return res.status(400).json({ error: 'instruction_body is required.' });
    }
    if (difficulty && !DIFFICULTIES.includes(difficulty)) {
        return res.status(400).json({ error: `Invalid difficulty. Allowed: ${DIFFICULTIES.join(', ')}` });
    }

    try {
        const { data: sop, error } = await supabase
            .from('practice_sop_templates')
            .insert({
                company_id:        cid,
                title:             String(title).trim(),
                category:          category || null,
                status:            'draft',
                summary:           summary || null,
                instruction_body:  String(instruction_body),
                estimated_minutes: estimated_minutes != null && estimated_minutes !== '' ? parseInt(estimated_minutes, 10) : null,
                difficulty:        difficulty || null,
                requires_review:   requires_review !== false && requires_review !== 'false',
                effective_from:    effective_from || null,
                effective_to:      effective_to   || null,
                internal_notes:    internal_notes  || null,
                version:           1,
                created_by:        req.user?.userId,
                updated_by:        req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_created', null, 'draft', req.user?.userId, null, { category });
        await auditFromReq(req, 'sop_created', 'sop_template', sop.id, { category });

        return res.status(201).json(sop);
    } catch (err) {
        console.error('POST /api/practice/sop', err);
        return res.status(500).json({ error: 'Failed to create SOP.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        return res.json(sop);
    } catch (err) {
        console.error('GET /api/practice/sop/:id', err);
        return res.status(500).json({ error: 'Failed to load SOP.' });
    }
});

// ── PUT /:id (update) ─────────────────────────────────────────────────────────
// Approved SOPs cannot be edited without going back to draft first — low-risk
// versioning: any content edit on an approved SOP bumps version and resets
// status to draft. The previous approved copy is not separately retained
// (no version-history table); only the current row is stored, but its version
// number changes so staff can see it needs re-approval.

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = [
        'title', 'category', 'summary', 'instruction_body', 'estimated_minutes',
        'difficulty', 'requires_review', 'effective_from', 'effective_to', 'internal_notes',
    ];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if (patch.difficulty && !DIFFICULTIES.includes(patch.difficulty)) {
        return res.status(400).json({ error: `Invalid difficulty. Allowed: ${DIFFICULTIES.join(', ')}` });
    }
    if ('estimated_minutes' in patch) {
        patch.estimated_minutes = patch.estimated_minutes != null && patch.estimated_minutes !== ''
            ? parseInt(patch.estimated_minutes, 10) : null;
    }

    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        if (sop.status === 'archived') {
            return res.status(422).json({ error: 'Cannot edit an archived SOP.' });
        }

        const updates = { ...patch, updated_by: req.user?.userId };

        // Approved SOPs: content-affecting edits create a new version and
        // return the SOP to draft for re-review (low-risk versioning).
        const CONTENT_FIELDS = ['title', 'summary', 'instruction_body', 'category'];
        const isContentEdit = CONTENT_FIELDS.some(f => f in patch);
        let newStatus = sop.status;
        if (sop.status === 'approved' && isContentEdit) {
            updates.version = (sop.version || 1) + 1;
            updates.status = 'draft';
            updates.approved_at = null;
            updates.approved_by = null;
            newStatus = 'draft';
        }

        const { data: updated, error } = await supabase
            .from('practice_sop_templates')
            .update(updates)
            .eq('id', sop.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_updated', sop.status, newStatus, req.user?.userId, null, {
            fields: Object.keys(patch), new_version: updates.version || sop.version,
        });
        await auditFromReq(req, 'sop_updated', 'sop_template', sop.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/sop/:id', err);
        return res.status(500).json({ error: 'Failed to update SOP.' });
    }
});

// ── DELETE / (soft archive) ───────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        if (sop.status === 'archived') {
            return res.status(422).json({ error: 'SOP is already archived.' });
        }

        const { data: updated, error } = await supabase
            .from('practice_sop_templates')
            .update({ status: 'archived', updated_by: req.user?.userId })
            .eq('id', sop.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_archived', sop.status, 'archived', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'sop_archived', 'sop_template', sop.id, { previous_status: sop.status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/sop/:id', err);
        return res.status(500).json({ error: 'Failed to archive SOP.' });
    }
});

// ── PUT /:id/submit-review ────────────────────────────────────────────────────
// Transition: draft → under_review

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        if (sop.status !== 'draft') {
            return res.status(422).json({ error: `SOP must be in "draft" status to submit for review. Current: "${sop.status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_sop_templates')
            .update({ status: 'under_review', updated_by: req.user?.userId })
            .eq('id', sop.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_submitted', 'draft', 'under_review', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'sop_submitted', 'sop_template', sop.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/sop/:id/submit-review', err);
        return res.status(500).json({ error: 'Failed to submit SOP for review.' });
    }
});

// ── PUT /:id/approve ──────────────────────────────────────────────────────────
// Transition: under_review → approved

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        if (sop.status !== 'under_review') {
            return res.status(422).json({ error: `SOP must be in "under_review" status to approve. Current: "${sop.status}".` });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase
            .from('practice_sop_templates')
            .update({
                status:       'approved',
                reviewed_at:  now,
                reviewed_by:  req.user?.userId || null,
                approved_at:  now,
                approved_by:  req.user?.userId || null,
                updated_by:   req.user?.userId,
            })
            .eq('id', sop.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_approved', 'under_review', 'approved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'sop_approved', 'sop_template', sop.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/sop/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve SOP.' });
    }
});

// ── GET /:id/links ─────────────────────────────────────────────────────────────

router.get('/:id/links', async (req, res) => {
    const cid = req.companyId;
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });

        const { data, error } = await supabase
            .from('practice_sop_links')
            .select('*')
            .eq('sop_id', sop.id)
            .eq('company_id', cid)
            .order('sort_order', { ascending: true });
        if (error) throw error;

        return res.json({ links: data || [] });
    } catch (err) {
        console.error('GET /api/practice/sop/:id/links', err);
        return res.status(500).json({ error: 'Failed to load links.' });
    }
});

// ── POST /:id/links ────────────────────────────────────────────────────────────

router.post('/:id/links', async (req, res) => {
    const cid = req.companyId;
    const { linked_type, linked_id, notes, sort_order } = req.body || {};

    if (!linked_type || !LINKED_TYPES.includes(linked_type)) {
        return res.status(400).json({ error: `linked_type is required. Allowed: ${LINKED_TYPES.join(', ')}` });
    }
    const linkedId = Number(linked_id);
    if (!linkedId || isNaN(linkedId)) return res.status(400).json({ error: 'linked_id is required and must be a number.' });

    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });
        if (sop.status === 'archived') {
            return res.status(422).json({ error: 'Cannot add links to an archived SOP.' });
        }

        const belongsToCompany = await _verifyLinkedRecordOwnership(cid, linked_type, linkedId);
        if (!belongsToCompany) {
            return res.status(404).json({ error: `Linked ${linked_type} record not found for this company.` });
        }

        const { data: link, error } = await supabase
            .from('practice_sop_links')
            .insert({
                company_id:  cid,
                sop_id:      sop.id,
                linked_type,
                linked_id:   linkedId,
                sort_order:  sort_order != null && sort_order !== '' ? parseInt(sort_order, 10) : 0,
                notes:       notes || null,
                created_by:  req.user?.userId || null,
            })
            .select()
            .single();
        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'This SOP is already linked to that record.' });
            }
            throw error;
        }

        await _writeEvent(sop.id, cid, 'sop_linked', null, null, req.user?.userId, notes || null, {
            linked_type, linked_id: linkedId,
        });
        await auditFromReq(req, 'sop_linked', 'sop_template', sop.id, { linked_type, linked_id: linkedId });

        return res.status(201).json(link);
    } catch (err) {
        console.error('POST /api/practice/sop/:id/links', err);
        return res.status(500).json({ error: 'Failed to link SOP.' });
    }
});

// ── DELETE /:id/links/:linkId ──────────────────────────────────────────────────

router.delete('/:id/links/:linkId', async (req, res) => {
    const cid = req.companyId;
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });

        const link = await _verifyLink(req.params.linkId, sop.id, cid);
        if (!link) return res.status(404).json({ error: 'Link not found.' });

        const { error } = await supabase
            .from('practice_sop_links')
            .delete()
            .eq('id', link.id)
            .eq('company_id', cid);
        if (error) throw error;

        await _writeEvent(sop.id, cid, 'sop_unlinked', null, null, req.user?.userId, null, {
            linked_type: link.linked_type, linked_id: link.linked_id,
        });
        await auditFromReq(req, 'sop_unlinked', 'sop_template', sop.id, {
            linked_type: link.linked_type, linked_id: link.linked_id,
        });

        return res.json({ message: 'Link removed.' });
    } catch (err) {
        console.error('DELETE /api/practice/sop/:id/links/:linkId', err);
        return res.status(500).json({ error: 'Failed to remove link.' });
    }
});

// ── GET /:id/events (append-only audit log) ───────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const sop = await _verifySop(req.params.id, cid);
        if (!sop) return res.status(404).json({ error: 'SOP not found.' });

        const { data, error } = await supabase
            .from('practice_sop_events')
            .select('*')
            .eq('sop_id', sop.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/sop/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;
