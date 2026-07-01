'use strict';

// Codebox 46 — Practice Knowledge Base + Technical Opinion Library
// Human-controlled knowledge library: SARS interpretations, internal policies,
// technical opinions, SOPs, working paper notes, client-specific positions.
//
// NOT AI-generated advice. NOT Sean AI. NOT automatic tax interpretation.
// All content is authored and reviewed by practice staff.

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

const CATEGORIES = [
    'income_tax', 'company_tax', 'provisional_tax', 'vat', 'paye',
    'payroll', 'cipc', 'coida', 'accounting', 'audit',
    'secretarial', 'internal_policy', 'workflow', 'other',
];

const ARTICLE_TYPES = [
    'technical_opinion', 'sars_interpretation', 'internal_policy', 'sop',
    'working_paper_note', 'client_position', 'checklist_note',
    'template_note', 'general_note',
];

const STATUSES = ['draft', 'under_review', 'approved', 'archived'];
const TERMINAL_STATUSES = ['archived'];

const LINKED_TYPES = [
    'client', 'taxpayer_profile', 'individual_tax_return', 'company_tax_return',
    'provisional_tax_plan', 'tax_submission', 'sars_statement_line',
    'tax_dispute', 'tax_completion_pack', 'workflow_run', 'task',
    'document_request', 'compliance_pack',
];

// Known practice tables for "belongs to this company where practical" checks.
const LINKED_TYPE_TABLE = {
    client:                'practice_clients',
    taxpayer_profile:      'practice_taxpayer_profiles',
    individual_tax_return: 'practice_individual_tax_returns',
    company_tax_return:    'practice_company_tax_returns',
    provisional_tax_plan:  'practice_provisional_tax_plans',
    tax_submission:        'practice_tax_submissions',
    sars_statement_line:   'practice_sars_statement_lines',
    tax_dispute:           'practice_tax_dispute_cases',
    tax_completion_pack:   'practice_tax_completion_packs',
    workflow_run:          'practice_workflow_runs',
    task:                  'practice_tasks',
    document_request:      'practice_document_requests',
    compliance_pack:       'practice_compliance_packs',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

function _normalizeTags(tags) {
    if (tags == null) return undefined;
    if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
    if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
    return undefined;
}

async function _verifyArticle(id, cid) {
    const { data } = await supabase
        .from('practice_knowledge_articles')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _verifyLink(linkId, articleId, cid) {
    const { data } = await supabase
        .from('practice_knowledge_links')
        .select('*')
        .eq('id', linkId)
        .eq('article_id', articleId)
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

async function _writeEvent(articleId, cid, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_knowledge_events').insert({
        article_id:    articleId,
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
        const { data: articles } = await supabase
            .from('practice_knowledge_articles')
            .select('status, category, article_type')
            .eq('company_id', cid);

        const all = articles || [];
        const counts = { draft: 0, under_review: 0, approved: 0, archived: 0 };
        all.forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });

        return res.json({
            total:         all.length,
            draft:         counts.draft,
            under_review:  counts.under_review,
            approved:      counts.approved,
            archived:      counts.archived,
        });
    } catch (err) {
        console.error('GET /api/practice/knowledge/summary', err);
        return res.status(500).json({ error: 'Failed to load knowledge base summary.' });
    }
});

// ── GET /linked/:linkedType/:linkedId ────────────────────────────────────────
// Returns approved/draft knowledge linked to a given record.

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
            .from('practice_knowledge_links')
            .select('*')
            .eq('company_id', cid)
            .eq('linked_type', linkedType)
            .eq('linked_id', linkedId);
        if (linkErr) throw linkErr;

        const articleIds = [...new Set((links || []).map(l => l.article_id))];
        if (!articleIds.length) return res.json({ articles: [], links: [] });

        const { data: articles, error: artErr } = await supabase
            .from('practice_knowledge_articles')
            .select('id, title, category, article_type, status, summary, tags, updated_at')
            .eq('company_id', cid)
            .in('id', articleIds)
            .order('updated_at', { ascending: false });
        if (artErr) throw artErr;

        return res.json({ articles: articles || [], links: links || [] });
    } catch (err) {
        console.error('GET /api/practice/knowledge/linked/:linkedType/:linkedId', err);
        return res.status(500).json({ error: 'Failed to load linked knowledge articles.' });
    }
});

// ── GET / (list with filters + pagination) ───────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        search, category, article_type, status, tag,
        page = 1, limit = 50,
    } = req.query;

    try {
        if (category && !CATEGORIES.includes(category)) {
            return res.status(400).json({ error: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
        }
        if (article_type && !ARTICLE_TYPES.includes(article_type)) {
            return res.status(400).json({ error: `Invalid article_type. Allowed: ${ARTICLE_TYPES.join(', ')}` });
        }
        if (status && !STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${STATUSES.join(', ')}` });
        }

        let q = supabase
            .from('practice_knowledge_articles')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (category)     q = q.eq('category', category);
        if (article_type) q = q.eq('article_type', article_type);
        if (status)        q = q.eq('status', status);

        if (search) {
            const s = String(search).trim().replace(/[%,]/g, '');
            if (s) q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%,content.ilike.%${s}%,source_reference.ilike.%${s}%`);
        }

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('updated_at', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        // Tag filtering — done in-memory since JSONB array "contains" fallback
        // is simpler than a jsonb query here (no AI search; simple contains only).
        let results = data || [];
        let total = count || 0;
        if (tag) {
            const t = String(tag).trim().toLowerCase();
            results = results.filter(a => Array.isArray(a.tags) && a.tags.some(x => String(x).toLowerCase() === t));
            total = results.length;
        }

        return res.json({ articles: results, total, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/knowledge', err);
        return res.status(500).json({ error: 'Failed to load knowledge articles.' });
    }
});

// ── POST / (create) ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        title, category, article_type, summary, content, tags,
        effective_from, effective_to, source_reference, internal_notes,
    } = req.body || {};

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required.' });
    if (!category || !CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category is required. Allowed: ${CATEGORIES.join(', ')}` });
    }
    if (!article_type || !ARTICLE_TYPES.includes(article_type)) {
        return res.status(400).json({ error: `article_type is required. Allowed: ${ARTICLE_TYPES.join(', ')}` });
    }
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required.' });

    try {
        const { data: article, error } = await supabase
            .from('practice_knowledge_articles')
            .insert({
                company_id:       cid,
                title:            String(title).trim(),
                category,
                article_type,
                status:           'draft',
                summary:          summary || null,
                content:          String(content),
                tags:             _normalizeTags(tags) || [],
                effective_from:   effective_from || null,
                effective_to:     effective_to   || null,
                source_reference: source_reference || null,
                internal_notes:   internal_notes    || null,
                version:          1,
                created_by:       req.user?.userId,
                updated_by:       req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_created', null, 'draft', req.user?.userId, null, {
            category, article_type,
        });
        await auditFromReq(req, 'knowledge_article_created', 'knowledge_article', article.id, { category, article_type });

        return res.status(201).json(article);
    } catch (err) {
        console.error('POST /api/practice/knowledge', err);
        return res.status(500).json({ error: 'Failed to create knowledge article.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        return res.json(article);
    } catch (err) {
        console.error('GET /api/practice/knowledge/:id', err);
        return res.status(500).json({ error: 'Failed to load knowledge article.' });
    }
});

// ── PUT /:id (update) ─────────────────────────────────────────────────────────
// Approved articles cannot be edited without going back to draft first —
// low-risk versioning: any content edit on an approved article bumps version
// and resets status to draft, requiring re-review/re-approval.

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = [
        'title', 'category', 'article_type', 'summary', 'content', 'tags',
        'effective_from', 'effective_to', 'source_reference', 'internal_notes',
    ];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if (patch.category && !CATEGORIES.includes(patch.category)) {
        return res.status(400).json({ error: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
    }
    if (patch.article_type && !ARTICLE_TYPES.includes(patch.article_type)) {
        return res.status(400).json({ error: `Invalid article_type. Allowed: ${ARTICLE_TYPES.join(', ')}` });
    }
    if ('tags' in patch) {
        const normalized = _normalizeTags(patch.tags);
        patch.tags = normalized || [];
    }

    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status === 'archived') {
            return res.status(422).json({ error: 'Cannot edit an archived article.' });
        }

        const updates = { ...patch, updated_by: req.user?.userId };

        // Approved articles: content-affecting edits create a new version and
        // return the article to draft for re-review (low-risk versioning).
        const CONTENT_FIELDS = ['title', 'summary', 'content', 'category', 'article_type'];
        const isContentEdit = CONTENT_FIELDS.some(f => f in patch);
        let newStatus = article.status;
        if (article.status === 'approved' && isContentEdit) {
            updates.version = (article.version || 1) + 1;
            updates.status = 'draft';
            updates.approved_at = null;
            updates.approved_by = null;
            newStatus = 'draft';
        }

        const { data: updated, error } = await supabase
            .from('practice_knowledge_articles')
            .update(updates)
            .eq('id', article.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_updated', article.status, newStatus, req.user?.userId, null, {
            fields: Object.keys(patch), new_version: updates.version || article.version,
        });
        await auditFromReq(req, 'knowledge_article_updated', 'knowledge_article', article.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/knowledge/:id', err);
        return res.status(500).json({ error: 'Failed to update knowledge article.' });
    }
});

// ── DELETE /:id (soft archive only) ───────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status === 'archived') {
            return res.status(422).json({ error: 'Article is already archived.' });
        }

        const { data: updated, error } = await supabase
            .from('practice_knowledge_articles')
            .update({ status: 'archived', updated_by: req.user?.userId })
            .eq('id', article.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_archived', article.status, 'archived', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'knowledge_article_archived', 'knowledge_article', article.id, { previous_status: article.status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/knowledge/:id', err);
        return res.status(500).json({ error: 'Failed to archive knowledge article.' });
    }
});

// ── PUT /:id/submit-review ────────────────────────────────────────────────────
// Transition: draft → under_review

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status !== 'draft') {
            return res.status(422).json({ error: `Article must be in "draft" status to submit for review. Current: "${article.status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_knowledge_articles')
            .update({ status: 'under_review', updated_by: req.user?.userId })
            .eq('id', article.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_submitted_review', 'draft', 'under_review', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'knowledge_article_submitted_review', 'knowledge_article', article.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/knowledge/:id/submit-review', err);
        return res.status(500).json({ error: 'Failed to submit article for review.' });
    }
});

// ── PUT /:id/approve ──────────────────────────────────────────────────────────
// Transition: under_review → approved

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status !== 'under_review') {
            return res.status(422).json({ error: `Article must be in "under_review" status to approve. Current: "${article.status}".` });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase
            .from('practice_knowledge_articles')
            .update({
                status:       'approved',
                reviewed_at:  now,
                reviewed_by:  req.user?.userId || null,
                approved_at:  now,
                approved_by:  req.user?.userId || null,
                updated_by:   req.user?.userId,
            })
            .eq('id', article.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_approved', 'under_review', 'approved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'knowledge_article_approved', 'knowledge_article', article.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/knowledge/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve knowledge article.' });
    }
});

// ── PUT /:id/archive ───────────────────────────────────────────────────────────
// Transition: any non-terminal status → archived

router.put('/:id/archive', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status === 'archived') {
            return res.status(422).json({ error: 'Article is already archived.' });
        }

        const { data: updated, error } = await supabase
            .from('practice_knowledge_articles')
            .update({ status: 'archived', updated_by: req.user?.userId })
            .eq('id', article.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_archived', article.status, 'archived', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'knowledge_article_archived', 'knowledge_article', article.id, { previous_status: article.status });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/knowledge/:id/archive', err);
        return res.status(500).json({ error: 'Failed to archive knowledge article.' });
    }
});

// ── GET /:id/links ─────────────────────────────────────────────────────────────

router.get('/:id/links', async (req, res) => {
    const cid = req.companyId;
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });

        const { data, error } = await supabase
            .from('practice_knowledge_links')
            .select('*')
            .eq('article_id', article.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ links: data || [] });
    } catch (err) {
        console.error('GET /api/practice/knowledge/:id/links', err);
        return res.status(500).json({ error: 'Failed to load links.' });
    }
});

// ── POST /:id/links ────────────────────────────────────────────────────────────

router.post('/:id/links', async (req, res) => {
    const cid = req.companyId;
    const { linked_type, linked_id, notes } = req.body || {};

    if (!linked_type || !LINKED_TYPES.includes(linked_type)) {
        return res.status(400).json({ error: `linked_type is required. Allowed: ${LINKED_TYPES.join(', ')}` });
    }
    const linkedId = Number(linked_id);
    if (!linkedId || isNaN(linkedId)) return res.status(400).json({ error: 'linked_id is required and must be a number.' });

    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });
        if (article.status === 'archived') {
            return res.status(422).json({ error: 'Cannot add links to an archived article.' });
        }

        const belongsToCompany = await _verifyLinkedRecordOwnership(cid, linked_type, linkedId);
        if (!belongsToCompany) {
            return res.status(404).json({ error: `Linked ${linked_type} record not found for this company.` });
        }

        const { data: link, error } = await supabase
            .from('practice_knowledge_links')
            .insert({
                company_id:  cid,
                article_id:  article.id,
                linked_type,
                linked_id:   linkedId,
                notes:       notes || null,
                created_by:  req.user?.userId || null,
            })
            .select()
            .single();
        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'This article is already linked to that record.' });
            }
            throw error;
        }

        await _writeEvent(article.id, cid, 'knowledge_article_linked', null, null, req.user?.userId, notes || null, {
            linked_type, linked_id: linkedId,
        });
        await auditFromReq(req, 'knowledge_article_linked', 'knowledge_article', article.id, { linked_type, linked_id: linkedId });

        return res.status(201).json(link);
    } catch (err) {
        console.error('POST /api/practice/knowledge/:id/links', err);
        return res.status(500).json({ error: 'Failed to link knowledge article.' });
    }
});

// ── DELETE /:id/links/:linkId ──────────────────────────────────────────────────

router.delete('/:id/links/:linkId', async (req, res) => {
    const cid = req.companyId;
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });

        const link = await _verifyLink(req.params.linkId, article.id, cid);
        if (!link) return res.status(404).json({ error: 'Link not found.' });

        const { error } = await supabase
            .from('practice_knowledge_links')
            .delete()
            .eq('id', link.id)
            .eq('company_id', cid);
        if (error) throw error;

        await _writeEvent(article.id, cid, 'knowledge_article_unlinked', null, null, req.user?.userId, null, {
            linked_type: link.linked_type, linked_id: link.linked_id,
        });
        await auditFromReq(req, 'knowledge_article_unlinked', 'knowledge_article', article.id, {
            linked_type: link.linked_type, linked_id: link.linked_id,
        });

        return res.json({ message: 'Link removed.' });
    } catch (err) {
        console.error('DELETE /api/practice/knowledge/:id/links/:linkId', err);
        return res.status(500).json({ error: 'Failed to remove link.' });
    }
});

// ── GET /:id/events (append-only audit log) ───────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const article = await _verifyArticle(req.params.id, cid);
        if (!article) return res.status(404).json({ error: 'Knowledge article not found.' });

        const { data, error } = await supabase
            .from('practice_knowledge_events')
            .select('*')
            .eq('article_id', article.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/knowledge/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;
