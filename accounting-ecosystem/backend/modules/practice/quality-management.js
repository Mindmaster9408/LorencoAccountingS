'use strict';

// Codebox 48 — Practice Quality Management System (QMS)
// Quality reviews, non-conformance findings, and CAPA (corrective/preventive
// action) tracking over tasks, workflow runs, completion packs, SOPs, and
// ad-hoc internal inspections / client file reviews.
//
// NOT AI. NOT a disciplinary workflow. NOT Sean AI. This is quality control only.

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

const REVIEW_TYPES = [
    'task_review', 'workflow_review', 'tax_review', 'completion_pack_review',
    'sop_compliance_review', 'internal_inspection', 'client_file_review', 'custom',
];

const REVIEW_STATUSES = ['draft', 'in_review', 'passed', 'failed', 'needs_correction', 'completed', 'cancelled'];
const REVIEW_TERMINAL_STATUSES = ['completed', 'cancelled'];

const LINKED_TYPES = ['task', 'workflow', 'completion_pack', 'sop'];

// Known practice tables for "belongs to this company" ownership checks.
const LINKED_TYPE_TABLE = {
    task:            'practice_tasks',
    workflow:        'practice_workflow_runs',
    completion_pack: 'practice_tax_completion_packs',
    sop:             'practice_sop_templates',
};

const FINDING_TYPES = [
    'non_conformance', 'observation', 'improvement', 'risk',
    'missing_evidence', 'sop_not_followed', 'review_note', 'custom',
];

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const FINDING_STATUSES = ['open', 'in_progress', 'resolved', 'verified', 'dismissed', 'cancelled'];
const FINDING_TERMINAL_STATUSES = ['verified', 'dismissed', 'cancelled'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyReview(id, cid) {
    const { data } = await supabase
        .from('practice_quality_reviews')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

// Findings are addressed by id alone (not nested under a review id in the
// route), so ownership is scoped to company_id only.
async function _verifyFinding(findingId, cid) {
    const { data } = await supabase
        .from('practice_quality_findings')
        .select('*')
        .eq('id', findingId)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

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

async function _findActiveReviewForLink(cid, linkedType, linkedId) {
    if (!linkedType || !linkedId) return null;
    const { data } = await supabase
        .from('practice_quality_reviews')
        .select('id')
        .eq('company_id', cid)
        .eq('linked_type', linkedType)
        .eq('linked_id', linkedId)
        .not('status', 'in', '("completed","cancelled")')
        .limit(1)
        .maybeSingle();
    return data || null;
}

async function _writeEvent(reviewId, findingId, cid, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_quality_events').insert({
        review_id:     reviewId,
        finding_id:    findingId || null,
        company_id:    cid,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: userId    || null,
        notes:         notes     || null,
        metadata:      meta      || {},
    });
}

// Enrich a list of reviews with client_name from practice_clients.
async function _enrichClientNames(reviews, cid) {
    if (!reviews || !reviews.length) return reviews;
    const ids = [...new Set(reviews.map(r => r.client_id).filter(Boolean))];
    if (!ids.length) return reviews;
    const { data: clients } = await supabase
        .from('practice_clients')
        .select('id, name')
        .eq('company_id', cid)
        .in('id', ids);
    const map = {};
    (clients || []).forEach(c => { map[c.id] = c.name; });
    return reviews.map(r => ({ ...r, client_name: r.client_id ? (map[r.client_id] || null) : null }));
}

// ── Routes ────────────────────────────────────────────────────────────────────
// NOTE: /summary, /create-from-* are defined at their own top-level paths and
// never collide with /reviews/:id — no special ordering required, but kept
// grouped logically below for readability.

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: reviews } = await supabase
            .from('practice_quality_reviews')
            .select('status, review_type, quality_score')
            .eq('company_id', cid);

        const all = reviews || [];
        const counts = { draft: 0, in_review: 0, passed: 0, failed: 0, needs_correction: 0, completed: 0, cancelled: 0 };
        all.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });

        const { count: openFindings } = await supabase
            .from('practice_quality_findings')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', cid)
            .in('status', ['open', 'in_progress']);

        const { count: criticalOpenFindings } = await supabase
            .from('practice_quality_findings')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', cid)
            .in('status', ['open', 'in_progress'])
            .eq('severity', 'critical');

        return res.json({
            total:             all.length,
            draft:             counts.draft,
            in_review:         counts.in_review,
            passed:            counts.passed,
            failed:            counts.failed,
            needs_correction:  counts.needs_correction,
            completed:         counts.completed,
            cancelled:         counts.cancelled,
            open_findings:     openFindings || 0,
            critical_open_findings: criticalOpenFindings || 0,
        });
    } catch (err) {
        console.error('GET /api/practice/qms/summary', err);
        return res.status(500).json({ error: 'Failed to load QMS summary.' });
    }
});

// ── GET /reviews (list with filters + pagination) ────────────────────────────

router.get('/reviews', async (req, res) => {
    const cid = req.companyId;
    const {
        search, review_type, status, linked_type, linked_id, client_id,
        page = 1, limit = 50,
    } = req.query;

    try {
        if (review_type && !REVIEW_TYPES.includes(review_type)) {
            return res.status(400).json({ error: `Invalid review_type. Allowed: ${REVIEW_TYPES.join(', ')}` });
        }
        if (status && !REVIEW_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${REVIEW_STATUSES.join(', ')}` });
        }
        if (linked_type && !LINKED_TYPES.includes(linked_type)) {
            return res.status(400).json({ error: `Invalid linked_type. Allowed: ${LINKED_TYPES.join(', ')}` });
        }

        let q = supabase
            .from('practice_quality_reviews')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (review_type) q = q.eq('review_type', review_type);
        if (status)      q = q.eq('status', status);
        if (linked_type) q = q.eq('linked_type', linked_type);
        if (linked_id)   q = q.eq('linked_id', Number(linked_id));
        if (client_id)   q = q.eq('client_id', Number(client_id));

        if (search) {
            const s = String(search).trim().replace(/[%,]/g, '');
            if (s) q = q.or(`review_title.ilike.%${s}%,review_notes.ilike.%${s}%`);
        }

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('created_at', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        const enriched = await _enrichClientNames(data || [], cid);

        return res.json({ reviews: enriched, total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/qms/reviews', err);
        return res.status(500).json({ error: 'Failed to load quality reviews.' });
    }
});

// ── POST /reviews (manual create) ────────────────────────────────────────────

router.post('/reviews', async (req, res) => {
    const cid = req.companyId;
    const {
        review_title, review_type, linked_type, linked_id, client_id,
        assigned_reviewer_team_member_id, review_notes,
    } = req.body || {};

    if (!review_title || !String(review_title).trim()) return res.status(400).json({ error: 'review_title is required.' });
    if (!review_type || !REVIEW_TYPES.includes(review_type)) {
        return res.status(400).json({ error: `review_type is required. Allowed: ${REVIEW_TYPES.join(', ')}` });
    }
    if (linked_type && !LINKED_TYPES.includes(linked_type)) {
        return res.status(400).json({ error: `Invalid linked_type. Allowed: ${LINKED_TYPES.join(', ')}` });
    }
    if (linked_type && !linked_id) {
        return res.status(400).json({ error: 'linked_id is required when linked_type is provided.' });
    }

    try {
        if (linked_type) {
            const belongsToCompany = await _verifyLinkedRecordOwnership(cid, linked_type, Number(linked_id));
            if (!belongsToCompany) {
                return res.status(404).json({ error: `Linked ${linked_type} record not found for this company.` });
            }
            const existing = await _findActiveReviewForLink(cid, linked_type, Number(linked_id));
            if (existing) {
                return res.status(409).json({
                    error: `An active quality review already exists for this ${linked_type}.`,
                    existing_review_id: existing.id,
                });
            }
        }

        const { data: review, error } = await supabase
            .from('practice_quality_reviews')
            .insert({
                company_id:                       cid,
                review_title:                     String(review_title).trim(),
                review_type,
                linked_type:                       linked_type || null,
                linked_id:                         linked_type ? Number(linked_id) : null,
                client_id:                         client_id ? Number(client_id) : null,
                assigned_reviewer_team_member_id:  assigned_reviewer_team_member_id ? Number(assigned_reviewer_team_member_id) : null,
                status:                            'draft',
                review_notes:                      review_notes || null,
                created_by:                        req.user?.userId,
                updated_by:                        req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, null, cid, 'review_created', null, 'draft', req.user?.userId, null, { review_type, linked_type });
        await auditFromReq(req, 'qms_review_created', 'quality_review', review.id, { review_type, linked_type });

        return res.status(201).json(review);
    } catch (err) {
        console.error('POST /api/practice/qms/reviews', err);
        return res.status(500).json({ error: 'Failed to create quality review.' });
    }
});

// ── Create-from-source helpers ───────────────────────────────────────────────
// Each verifies the source record belongs to this company, applies the
// duplicate guard, and pre-fills review_type + linked_type + client_id
// (where the source table carries a client_id) automatically.

async function _createFromSource(req, res, opts) {
    const cid = req.companyId;
    const { sourceIdField, sourceTable, linkedType, reviewType, defaultTitlePrefix, hasClientId } = opts;
    const sourceId = Number(req.body?.[sourceIdField]);

    if (!sourceId || isNaN(sourceId)) {
        return res.status(400).json({ error: `${sourceIdField} is required.` });
    }

    try {
        const selectCols = hasClientId ? 'id, client_id' : 'id';
        const { data: source } = await supabase
            .from(sourceTable)
            .select(selectCols)
            .eq('id', sourceId)
            .eq('company_id', cid)
            .maybeSingle();
        if (!source) return res.status(404).json({ error: 'Source record not found or access denied.' });

        const existing = await _findActiveReviewForLink(cid, linkedType, sourceId);
        if (existing) {
            return res.status(409).json({
                error: `An active quality review already exists for this ${linkedType}.`,
                existing_review_id: existing.id,
            });
        }

        const title = (req.body?.review_title && req.body.review_title.trim())
            || `${defaultTitlePrefix} — #${sourceId}`;

        const clientId = req.body?.client_id
            ? Number(req.body.client_id)
            : (hasClientId ? (source.client_id || null) : null);

        const { data: review, error } = await supabase
            .from('practice_quality_reviews')
            .insert({
                company_id:                       cid,
                review_title:                     title,
                review_type:                       reviewType,
                linked_type:                       linkedType,
                linked_id:                         sourceId,
                client_id:                         clientId,
                assigned_reviewer_team_member_id:  req.body?.assigned_reviewer_team_member_id ? Number(req.body.assigned_reviewer_team_member_id) : null,
                status:                            'draft',
                review_notes:                      req.body?.review_notes || null,
                created_by:                        req.user?.userId,
                updated_by:                        req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, null, cid, 'review_created', null, 'draft', req.user?.userId, null, {
            source: linkedType, source_id: sourceId,
        });
        await auditFromReq(req, 'qms_review_created', 'quality_review', review.id, { source: linkedType, source_id: sourceId });

        return res.status(201).json(review);
    } catch (err) {
        console.error(`POST /api/practice/qms/create-from-${linkedType}`, err);
        return res.status(500).json({ error: 'Failed to create quality review from source.' });
    }
}

router.post('/create-from-task', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'task_id', sourceTable: 'practice_tasks', linkedType: 'task',
    reviewType: 'task_review', defaultTitlePrefix: 'Task Review', hasClientId: true,
}));

router.post('/create-from-workflow', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'workflow_run_id', sourceTable: 'practice_workflow_runs', linkedType: 'workflow',
    reviewType: 'workflow_review', defaultTitlePrefix: 'Workflow Review', hasClientId: false,
}));

router.post('/create-from-completion-pack', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'completion_pack_id', sourceTable: 'practice_tax_completion_packs', linkedType: 'completion_pack',
    reviewType: 'completion_pack_review', defaultTitlePrefix: 'Completion Pack Review', hasClientId: true,
}));

router.post('/create-from-sop', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'sop_id', sourceTable: 'practice_sop_templates', linkedType: 'sop',
    reviewType: 'sop_compliance_review', defaultTitlePrefix: 'SOP Compliance Review', hasClientId: false,
}));

// ── GET /reviews/:id ──────────────────────────────────────────────────────────

router.get('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });
        const [enriched] = await _enrichClientNames([review], cid);
        return res.json(enriched);
    } catch (err) {
        console.error('GET /api/practice/qms/reviews/:id', err);
        return res.status(500).json({ error: 'Failed to load quality review.' });
    }
});

// ── PUT /reviews/:id (update non-status fields) ──────────────────────────────

router.put('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = [
        'review_title', 'client_id', 'assigned_reviewer_team_member_id',
        'review_notes', 'quality_score',
    ];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if ('quality_score' in patch && patch.quality_score != null) {
        const score = Number(patch.quality_score);
        if (isNaN(score) || score < 0 || score > 100) {
            return res.status(400).json({ error: 'quality_score must be between 0 and 100.' });
        }
        patch.quality_score = score;
    }
    if ('client_id' in patch) patch.client_id = patch.client_id ? Number(patch.client_id) : null;
    if ('assigned_reviewer_team_member_id' in patch) {
        patch.assigned_reviewer_team_member_id = patch.assigned_reviewer_team_member_id ? Number(patch.assigned_reviewer_team_member_id) : null;
    }

    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });
        if (REVIEW_TERMINAL_STATUSES.includes(review.status)) {
            return res.status(422).json({ error: `Cannot edit a ${review.status} review.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_quality_reviews')
            .update({ ...patch, updated_by: req.user?.userId })
            .eq('id', review.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, null, cid, 'review_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'qms_review_updated', 'quality_review', review.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/qms/reviews/:id', err);
        return res.status(500).json({ error: 'Failed to update quality review.' });
    }
});

// ── DELETE /reviews/:id (soft cancel) ─────────────────────────────────────────

router.delete('/reviews/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });
        if (review.status === 'completed') return res.status(422).json({ error: 'A completed review cannot be cancelled.' });
        if (review.status === 'cancelled') return res.status(422).json({ error: 'Review is already cancelled.' });

        const { data: updated, error } = await supabase
            .from('practice_quality_reviews')
            .update({ status: 'cancelled', updated_by: req.user?.userId })
            .eq('id', review.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, null, cid, 'review_cancelled', review.status, 'cancelled', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'qms_review_cancelled', 'quality_review', review.id, { previous_status: review.status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/qms/reviews/:id', err);
        return res.status(500).json({ error: 'Failed to cancel quality review.' });
    }
});

// ── Shared action helper ──────────────────────────────────────────────────────

async function _applyReviewAction(req, res, allowedFrom, newStatus, eventType, extraPatch) {
    const cid = req.companyId;
    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });
        if (REVIEW_TERMINAL_STATUSES.includes(review.status)) {
            return res.status(422).json({ error: `Cannot act on a ${review.status} review.` });
        }
        if (!allowedFrom.includes(review.status)) {
            return res.status(422).json({
                error: `Action not allowed from status: ${review.status}. Allowed from: ${allowedFrom.join(', ')}`,
            });
        }

        const patch = { status: newStatus, updated_by: req.user?.userId, ...extraPatch };
        const { data: updated, error } = await supabase
            .from('practice_quality_reviews')
            .update(patch)
            .eq('id', review.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, null, cid, eventType, review.status, newStatus, req.user?.userId, req.body?.notes || null, extraPatch);
        await auditFromReq(req, `qms_review_${eventType}`, 'quality_review', review.id, { old_status: review.status, new_status: newStatus });

        return res.json(updated);
    } catch (err) {
        console.error(`PUT /api/practice/qms/reviews/:id/${eventType}`, err);
        return res.status(500).json({ error: 'Failed to apply review action.' });
    }
}

// ── PUT /reviews/:id/start ────────────────────────────────────────────────────
// Transition: draft → in_review, or needs_correction → in_review (re-review)

router.put('/reviews/:id/start', (req, res) =>
    _applyReviewAction(req, res, ['draft', 'needs_correction'], 'in_review', 'started', {})
);

// ── PUT /reviews/:id/pass ─────────────────────────────────────────────────────

router.put('/reviews/:id/pass', (req, res) => {
    const extra = {};
    if (req.body?.quality_score != null) extra.quality_score = Number(req.body.quality_score);
    extra.reviewed_at = new Date().toISOString();
    extra.reviewed_by = req.user?.userId || null;
    return _applyReviewAction(req, res, ['in_review'], 'passed', 'passed', extra);
});

// ── PUT /reviews/:id/fail ─────────────────────────────────────────────────────

router.put('/reviews/:id/fail', (req, res) => {
    const extra = {};
    if (req.body?.quality_score != null) extra.quality_score = Number(req.body.quality_score);
    extra.reviewed_at = new Date().toISOString();
    extra.reviewed_by = req.user?.userId || null;
    return _applyReviewAction(req, res, ['in_review'], 'failed', 'failed', extra);
});

// ── PUT /reviews/:id/complete ─────────────────────────────────────────────────

router.put('/reviews/:id/complete', (req, res) => {
    const extra = {};
    if (req.body?.quality_score != null) extra.quality_score = Number(req.body.quality_score);
    return _applyReviewAction(req, res, ['passed', 'failed'], 'completed', 'completed', extra);
});

// ── GET /reviews/:id/findings ─────────────────────────────────────────────────

router.get('/reviews/:id/findings', async (req, res) => {
    const cid = req.companyId;
    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });

        const { data, error } = await supabase
            .from('practice_quality_findings')
            .select('*')
            .eq('review_id', review.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ findings: data || [] });
    } catch (err) {
        console.error('GET /api/practice/qms/reviews/:id/findings', err);
        return res.status(500).json({ error: 'Failed to load findings.' });
    }
});

// ── POST /reviews/:id/findings ────────────────────────────────────────────────
// Adding a finding while a review is in_review automatically moves the review
// to needs_correction — a finding means something needs to be fixed before the
// review can pass. Staff re-open with PUT /reviews/:id/start once addressed.

router.post('/reviews/:id/findings', async (req, res) => {
    const cid = req.companyId;
    const {
        finding_type, severity, finding_title, finding_description, root_cause,
        corrective_action, preventive_action, due_date, responsible_team_member_id,
    } = req.body || {};

    if (!finding_type || !FINDING_TYPES.includes(finding_type)) {
        return res.status(400).json({ error: `finding_type is required. Allowed: ${FINDING_TYPES.join(', ')}` });
    }
    if (!severity || !SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `severity is required. Allowed: ${SEVERITIES.join(', ')}` });
    }
    if (!finding_title || !String(finding_title).trim()) {
        return res.status(400).json({ error: 'finding_title is required.' });
    }

    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });
        if (REVIEW_TERMINAL_STATUSES.includes(review.status)) {
            return res.status(422).json({ error: `Cannot add findings to a ${review.status} review.` });
        }

        const { data: finding, error } = await supabase
            .from('practice_quality_findings')
            .insert({
                company_id:                cid,
                review_id:                 review.id,
                finding_type,
                severity,
                finding_title:             String(finding_title).trim(),
                finding_description:       finding_description || null,
                root_cause:                root_cause          || null,
                corrective_action:         corrective_action   || null,
                preventive_action:         preventive_action   || null,
                status:                    'open',
                due_date:                  due_date || null,
                responsible_team_member_id: responsible_team_member_id ? Number(responsible_team_member_id) : null,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(review.id, finding.id, cid, 'finding_added', null, null, req.user?.userId, null, {
            finding_type, severity, finding_title: finding.finding_title,
        });

        // Auto-transition: an in_review review with a new finding needs correction.
        let updatedReview = review;
        if (review.status === 'in_review') {
            const { data: rr } = await supabase
                .from('practice_quality_reviews')
                .update({ status: 'needs_correction', updated_by: req.user?.userId })
                .eq('id', review.id)
                .eq('company_id', cid)
                .select()
                .single();
            updatedReview = rr || review;
            await _writeEvent(review.id, null, cid, 'review_needs_correction', 'in_review', 'needs_correction', req.user?.userId, null, {
                triggered_by_finding_id: finding.id,
            });
        }

        await auditFromReq(req, 'qms_finding_added', 'quality_finding', finding.id, { review_id: review.id, finding_type, severity });

        return res.status(201).json({ finding, review: updatedReview });
    } catch (err) {
        console.error('POST /api/practice/qms/reviews/:id/findings', err);
        return res.status(500).json({ error: 'Failed to add finding.' });
    }
});

// ── GET /reviews/:id/events (append-only audit log) ───────────────────────────

router.get('/reviews/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const review = await _verifyReview(req.params.id, cid);
        if (!review) return res.status(404).json({ error: 'Quality review not found.' });

        const { data, error } = await supabase
            .from('practice_quality_events')
            .select('*')
            .eq('review_id', review.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/qms/reviews/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

// ── PUT /findings/:findingId (update non-status fields) ──────────────────────

router.put('/findings/:findingId', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = [
        'finding_title', 'finding_description', 'root_cause', 'corrective_action',
        'preventive_action', 'due_date', 'responsible_team_member_id', 'severity',
    ];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if (patch.severity && !SEVERITIES.includes(patch.severity)) {
        return res.status(400).json({ error: `Invalid severity. Allowed: ${SEVERITIES.join(', ')}` });
    }
    if ('responsible_team_member_id' in patch) {
        patch.responsible_team_member_id = patch.responsible_team_member_id ? Number(patch.responsible_team_member_id) : null;
    }

    try {
        const finding = await _verifyFinding(req.params.findingId, cid);
        if (!finding) return res.status(404).json({ error: 'Finding not found.' });
        if (FINDING_TERMINAL_STATUSES.includes(finding.status)) {
            return res.status(422).json({ error: `Cannot edit a ${finding.status} finding.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_quality_findings')
            .update(patch)
            .eq('id', finding.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(finding.review_id, finding.id, cid, 'finding_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'qms_finding_updated', 'quality_finding', finding.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/qms/findings/:findingId', err);
        return res.status(500).json({ error: 'Failed to update finding.' });
    }
});

// ── PUT /findings/:findingId/resolve ──────────────────────────────────────────
// Transition: open/in_progress → resolved

router.put('/findings/:findingId/resolve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const finding = await _verifyFinding(req.params.findingId, cid);
        if (!finding) return res.status(404).json({ error: 'Finding not found.' });
        if (!['open', 'in_progress'].includes(finding.status)) {
            return res.status(422).json({ error: `Finding must be "open" or "in_progress" to resolve. Current: "${finding.status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_quality_findings')
            .update({
                status:       'resolved',
                completed_at: new Date().toISOString(),
                completed_by: req.user?.userId || null,
            })
            .eq('id', finding.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(finding.review_id, finding.id, cid, 'finding_resolved', finding.status, 'resolved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'qms_finding_resolved', 'quality_finding', finding.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/qms/findings/:findingId/resolve', err);
        return res.status(500).json({ error: 'Failed to resolve finding.' });
    }
});

// ── PUT /findings/:findingId/verify ───────────────────────────────────────────
// Transition: resolved → verified (independent sign-off that the fix held)

router.put('/findings/:findingId/verify', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const finding = await _verifyFinding(req.params.findingId, cid);
        if (!finding) return res.status(404).json({ error: 'Finding not found.' });
        if (finding.status !== 'resolved') {
            return res.status(422).json({ error: `Finding must be "resolved" status to verify. Current: "${finding.status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_quality_findings')
            .update({ status: 'verified' })
            .eq('id', finding.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(finding.review_id, finding.id, cid, 'finding_verified', 'resolved', 'verified', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'qms_finding_verified', 'quality_finding', finding.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/qms/findings/:findingId/verify', err);
        return res.status(500).json({ error: 'Failed to verify finding.' });
    }
});

// ── DELETE /findings/:findingId (soft cancel) ─────────────────────────────────

router.delete('/findings/:findingId', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const finding = await _verifyFinding(req.params.findingId, cid);
        if (!finding) return res.status(404).json({ error: 'Finding not found.' });
        if (FINDING_TERMINAL_STATUSES.includes(finding.status)) {
            return res.status(422).json({ error: `Finding is already ${finding.status}.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_quality_findings')
            .update({ status: 'cancelled' })
            .eq('id', finding.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(finding.review_id, finding.id, cid, 'finding_cancelled', finding.status, 'cancelled', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'qms_finding_cancelled', 'quality_finding', finding.id, { previous_status: finding.status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/qms/findings/:findingId', err);
        return res.status(500).json({ error: 'Failed to cancel finding.' });
    }
});

module.exports = router;
