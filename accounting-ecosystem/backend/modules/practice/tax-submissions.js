'use strict';

const express    = require('express');
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

const VALID_SOURCE_TYPES    = ['individual_tax_return', 'company_tax_return', 'provisional_tax_plan'];
const SUBMISSION_STATUSES   = ['draft','submitted','acknowledged','assessed','correction_required','objection_required','completed','cancelled'];
const SUBMISSION_TYPES      = ['itr12','itr14','irp6_p1','irp6_p2','irp6_topup','emp501','custom'];
const SUBMISSION_METHODS    = ['efiling','branch','email','manual','other'];
const ASSESSMENT_OUTCOMES   = ['accepted','changed','additional_tax','refund','nil','disputed','unknown'];
const EVIDENCE_TYPES        = ['submission_confirmation','acknowledgement','assessment','payment_proof','supporting_document','correspondence','other'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _now() { return new Date().toISOString(); }

async function _verifySubmission(id, cid) {
    const { data } = await supabase
        .from('practice_tax_submissions')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _verifyEvidence(submissionId, evidenceId, cid) {
    const { data } = await supabase
        .from('practice_tax_submission_evidence')
        .select('*')
        .eq('id', evidenceId)
        .eq('submission_id', submissionId)
        .eq('company_id', cid)
        .eq('is_deleted', false)
        .single();
    return data || null;
}

async function _extractClientId(sourceType, sourceId, cid) {
    const table = sourceType === 'individual_tax_return' ? 'practice_individual_tax_returns'
                : sourceType === 'company_tax_return'    ? 'practice_company_tax_returns'
                : 'practice_provisional_tax_plans';
    const { data } = await supabase
        .from(table)
        .select('id, client_id, tax_year')
        .eq('id', sourceId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _writeEvent(cid, submissionId, eventType, oldStatus, newStatus, userId, notes, metadata) {
    await supabase.from('practice_tax_submission_events').insert({
        company_id:    cid,
        submission_id: submissionId,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: userId || null,
        notes:         notes || null,
        metadata:      metadata || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: all } = await supabase
            .from('practice_tax_submissions')
            .select('submission_status, follow_up_required, payment_due_date, follow_up_due_date')
            .eq('company_id', cid);

        const today   = new Date().toISOString().split('T')[0];
        const counts  = {};
        SUBMISSION_STATUSES.forEach(s => { counts[s] = 0; });
        let followUpRequired = 0;
        let paymentsDue      = 0;

        (all || []).forEach(r => {
            if (counts[r.submission_status] !== undefined) counts[r.submission_status]++;
            const active = !['cancelled','completed'].includes(r.submission_status);
            if (active && r.follow_up_required) followUpRequired++;
            if (active && r.payment_due_date && r.payment_due_date <= today) paymentsDue++;
        });

        await auditFromReq(req, 'VIEW', 'tax_submission', null, { action: 'summary' });
        res.json({ by_status: counts, follow_up_required: followUpRequired, payments_due: paymentsDue, total: (all || []).length });
    } catch (err) {
        console.error('[tax-submissions] summary error:', err);
        res.status(500).json({ error: 'Failed to load submission summary' });
    }
});

// ── POST /create-from-pipeline ────────────────────────────────────────────────
// Must be registered before /:id routes to avoid Express param capture

router.post('/create-from-pipeline', async (req, res) => {
    const cid = req.companyId;
    const { source_type, source_id, submission_type, tax_year } = req.body;

    if (!VALID_SOURCE_TYPES.includes(source_type))    return res.status(400).json({ error: 'Invalid source_type' });
    if (!source_id || isNaN(Number(source_id)))       return res.status(400).json({ error: 'Invalid source_id' });
    if (!SUBMISSION_TYPES.includes(submission_type))  return res.status(400).json({ error: 'Invalid submission_type' });

    const sid = Number(source_id);
    try {
        // Verify source record belongs to this company and extract client_id
        const source = await _extractClientId(source_type, sid, cid);
        if (!source) return res.status(404).json({ error: 'Source record not found or access denied' });

        // Prevent duplicate active submission for same source+type
        const { data: existing } = await supabase
            .from('practice_tax_submissions')
            .select('id, submission_status')
            .eq('company_id', cid)
            .eq('source_type', source_type)
            .eq('source_id', sid)
            .eq('submission_type', submission_type)
            .neq('submission_status', 'cancelled')
            .limit(1);

        if (existing && existing.length > 0) {
            return res.status(409).json({
                error:          'An active submission record already exists for this return and type',
                existing_id:    existing[0].id,
                existing_status: existing[0].submission_status,
            });
        }

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_submissions')
            .insert({
                company_id:        cid,
                client_id:         source.client_id,
                source_type,
                source_id:         sid,
                tax_year:          tax_year || source.tax_year || null,
                submission_type,
                submission_status: 'draft',
                created_by:        req.userId || null,
            })
            .select('id, submission_status, source_type, source_id, submission_type, tax_year, client_id, created_at')
            .single();

        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'submission_created', null, 'draft', req.userId, 'Created from pipeline', { source_type, source_id: sid, submission_type });
        await auditFromReq(req, 'CREATE', 'tax_submission', created.id, { source_type, source_id: sid, via: 'pipeline' });
        res.status(201).json({ ok: true, submission: created });
    } catch (err) {
        console.error('[tax-submissions] create-from-pipeline error:', err);
        res.status(500).json({ error: 'Failed to create submission from pipeline' });
    }
});

// ── GET / (list with filters + pagination) ────────────────────────────────────

router.get('/', async (req, res) => {
    const cid   = req.companyId;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    try {
        let q = supabase
            .from('practice_tax_submissions')
            .select('id, company_id, client_id, source_type, source_id, tax_year, submission_type, submission_status, submitted_at, submission_reference, assessment_outcome, assessed_amount, amount_payable, refund_amount, payment_due_date, follow_up_required, follow_up_due_date, responsible_team_member_id, created_at, updated_at', { count: 'exact' })
            .eq('company_id', cid);

        if (req.query.source_type && VALID_SOURCE_TYPES.includes(req.query.source_type)) {
            q = q.eq('source_type', req.query.source_type);
        }
        if (req.query.source_id)                         q = q.eq('source_id', Number(req.query.source_id));
        if (req.query.client_id)                         q = q.eq('client_id', Number(req.query.client_id));
        if (req.query.tax_year)                          q = q.eq('tax_year', Number(req.query.tax_year));
        if (req.query.submission_type && SUBMISSION_TYPES.includes(req.query.submission_type)) {
            q = q.eq('submission_type', req.query.submission_type);
        }
        if (req.query.submission_status && SUBMISSION_STATUSES.includes(req.query.submission_status)) {
            q = q.eq('submission_status', req.query.submission_status);
        }
        if (req.query.responsible_team_member_id) {
            q = q.eq('responsible_team_member_id', Number(req.query.responsible_team_member_id));
        }
        if (req.query.payment_due_from) q = q.gte('payment_due_date', req.query.payment_due_from);
        if (req.query.payment_due_to)   q = q.lte('payment_due_date', req.query.payment_due_to);

        const { data, count, error } = await q
            .order('updated_at', { ascending: false })
            .range(from, to);

        if (error) throw error;

        await auditFromReq(req, 'VIEW', 'tax_submission', null, { action: 'list', count: data ? data.length : 0 });
        res.json({ submissions: data || [], total: count || 0, page, limit });
    } catch (err) {
        console.error('[tax-submissions] list error:', err);
        res.status(500).json({ error: 'Failed to load submissions' });
    }
});

// ── POST / (create) ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        source_type, source_id, submission_type, tax_year,
        notes, internal_notes, responsible_team_member_id,
        related_deadline_id, related_compliance_pack_id,
        related_review_pack_id, related_calculation_id,
    } = req.body;

    if (!VALID_SOURCE_TYPES.includes(source_type))    return res.status(400).json({ error: 'Invalid source_type' });
    if (!source_id || isNaN(Number(source_id)))       return res.status(400).json({ error: 'Invalid source_id' });
    if (!SUBMISSION_TYPES.includes(submission_type))  return res.status(400).json({ error: 'Invalid submission_type' });

    const sid = Number(source_id);
    try {
        const source = await _extractClientId(source_type, sid, cid);
        if (!source) return res.status(404).json({ error: 'Source record not found or access denied' });

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_submissions')
            .insert({
                company_id:                cid,
                client_id:                 source.client_id,
                source_type,
                source_id:                 sid,
                tax_year:                  tax_year || source.tax_year || null,
                submission_type,
                submission_status:         'draft',
                notes:                     notes || null,
                internal_notes:            internal_notes || null,
                responsible_team_member_id: responsible_team_member_id || null,
                related_deadline_id:       related_deadline_id || null,
                related_compliance_pack_id: related_compliance_pack_id || null,
                related_review_pack_id:    related_review_pack_id || null,
                related_calculation_id:    related_calculation_id || null,
                created_by:                req.userId || null,
            })
            .select('*')
            .single();

        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'submission_created', null, 'draft', req.userId, null, { source_type, source_id: sid, submission_type });
        await auditFromReq(req, 'CREATE', 'tax_submission', created.id, { source_type, source_id: sid, submission_type });
        res.status(201).json({ ok: true, submission: created });
    } catch (err) {
        console.error('[tax-submissions] create error:', err);
        res.status(500).json({ error: 'Failed to create submission' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });

        // Fetch evidence count
        const { count: evidenceCount } = await supabase
            .from('practice_tax_submission_evidence')
            .select('id', { count: 'exact', head: true })
            .eq('submission_id', id)
            .eq('company_id', cid)
            .eq('is_deleted', false);

        await auditFromReq(req, 'VIEW', 'tax_submission', id, {});
        res.json({ ...sub, evidence_count: evidenceCount || 0 });
    } catch (err) {
        console.error('[tax-submissions] get error:', err);
        res.status(500).json({ error: 'Failed to load submission' });
    }
});

// ── PUT /:id (general update) ─────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status === 'cancelled') return res.status(422).json({ error: 'Cannot update a cancelled submission' });

        const allowed = [
            'tax_year','notes','internal_notes','responsible_team_member_id',
            'related_deadline_id','related_compliance_pack_id','related_workflow_run_id',
            'related_review_pack_id','related_calculation_id',
            'evidence_summary','acknowledgement_file_note','assessment_file_note',
            'supporting_document_notes','follow_up_required','follow_up_due_date','follow_up_notes',
        ];
        const updates = _pick(req.body, allowed);
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });
        updates.updated_by = req.userId || null;

        const { data: updated, error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update(updates)
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'submission_updated', sub.submission_status, sub.submission_status, req.userId, null, { fields: Object.keys(updates) });
        await auditFromReq(req, 'UPDATE', 'tax_submission', id, { fields: Object.keys(updates) });
        res.json({ ok: true, submission: updated });
    } catch (err) {
        console.error('[tax-submissions] update error:', err);
        res.status(500).json({ error: 'Failed to update submission' });
    }
});

// ── DELETE /:id (soft cancel) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status === 'cancelled') return res.status(422).json({ error: 'Submission is already cancelled' });
        if (sub.submission_status === 'completed') return res.status(422).json({ error: 'Completed submissions cannot be cancelled' });

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({ submission_status: 'cancelled', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'submission_cancelled', sub.submission_status, 'cancelled', req.userId, req.body.notes || null, {});
        await auditFromReq(req, 'tax_submission_cancelled', 'tax_submission', id, { old_status: sub.submission_status });
        res.json({ ok: true, id, submission_status: 'cancelled' });
    } catch (err) {
        console.error('[tax-submissions] cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel submission' });
    }
});

// ── PUT /:id/mark-submitted ───────────────────────────────────────────────────

router.put('/:id/mark-submitted', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const {
        submitted_at, submission_reference, submission_method,
        submitted_by_team_member_id, evidence_summary,
    } = req.body;

    if (!submitted_at) return res.status(400).json({ error: 'submitted_at is required' });
    if (submission_method && !SUBMISSION_METHODS.includes(submission_method)) {
        return res.status(400).json({ error: 'Invalid submission_method' });
    }

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (!['draft'].includes(sub.submission_status)) {
            return res.status(422).json({ error: `Cannot mark submitted from status: ${sub.submission_status}` });
        }

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({
                submission_status:          'submitted',
                submitted_at,
                submission_reference:       submission_reference || null,
                submission_method:          submission_method || null,
                submitted_by_team_member_id: submitted_by_team_member_id || null,
                evidence_summary:           evidence_summary || null,
                updated_by:                 req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'submission_marked_submitted', 'draft', 'submitted', req.userId, null, { submission_reference, submission_method });
        await auditFromReq(req, 'tax_submission_marked_submitted', 'tax_submission', id, { submitted_at, submission_reference });
        res.json({ ok: true, id, submission_status: 'submitted' });
    } catch (err) {
        console.error('[tax-submissions] mark-submitted error:', err);
        res.status(500).json({ error: 'Failed to mark as submitted' });
    }
});

// ── PUT /:id/record-acknowledgement ──────────────────────────────────────────

router.put('/:id/record-acknowledgement', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { acknowledgement_reference, acknowledgement_received_at, acknowledgement_file_note } = req.body;
    if (!acknowledgement_received_at) return res.status(400).json({ error: 'acknowledgement_received_at is required' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status !== 'submitted') {
            return res.status(422).json({ error: `Acknowledgement can only be recorded on submitted submissions (current: ${sub.submission_status})` });
        }

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({
                submission_status:          'acknowledged',
                acknowledgement_reference:  acknowledgement_reference || null,
                acknowledgement_received_at,
                acknowledgement_file_note:  acknowledgement_file_note || null,
                updated_by:                 req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'acknowledgement_recorded', 'submitted', 'acknowledged', req.userId, null, { acknowledgement_reference });
        await auditFromReq(req, 'tax_acknowledgement_recorded', 'tax_submission', id, { acknowledgement_reference });
        res.json({ ok: true, id, submission_status: 'acknowledged' });
    } catch (err) {
        console.error('[tax-submissions] record-acknowledgement error:', err);
        res.status(500).json({ error: 'Failed to record acknowledgement' });
    }
});

// ── PUT /:id/record-assessment ────────────────────────────────────────────────

router.put('/:id/record-assessment', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const {
        assessment_reference, assessment_received_at, assessment_outcome,
        assessed_amount, refund_amount, amount_payable, payment_due_date,
        assessment_file_note,
    } = req.body;

    if (!assessment_received_at) return res.status(400).json({ error: 'assessment_received_at is required' });
    if (!assessment_outcome || !ASSESSMENT_OUTCOMES.includes(assessment_outcome)) {
        return res.status(400).json({ error: `Invalid assessment_outcome. Allowed: ${ASSESSMENT_OUTCOMES.join(', ')}` });
    }

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (!['submitted','acknowledged'].includes(sub.submission_status)) {
            return res.status(422).json({ error: `Assessment can only be recorded on submitted or acknowledged submissions (current: ${sub.submission_status})` });
        }

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({
                submission_status:      'assessed',
                assessment_reference:   assessment_reference  || null,
                assessment_received_at,
                assessment_outcome,
                assessed_amount:        assessed_amount  != null ? Number(assessed_amount)  : null,
                refund_amount:          refund_amount    != null ? Number(refund_amount)    : null,
                amount_payable:         amount_payable   != null ? Number(amount_payable)   : null,
                payment_due_date:       payment_due_date || null,
                assessment_file_note:   assessment_file_note || null,
                updated_by:             req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'assessment_recorded', sub.submission_status, 'assessed', req.userId, null, { assessment_outcome, assessment_reference });
        await auditFromReq(req, 'tax_assessment_recorded', 'tax_submission', id, { assessment_outcome, assessment_reference });
        res.json({ ok: true, id, submission_status: 'assessed', assessment_outcome });
    } catch (err) {
        console.error('[tax-submissions] record-assessment error:', err);
        res.status(500).json({ error: 'Failed to record assessment' });
    }
});

// ── PUT /:id/set-follow-up ────────────────────────────────────────────────────

router.put('/:id/set-follow-up', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { follow_up_required, follow_up_due_date, follow_up_notes, responsible_team_member_id } = req.body;

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status === 'cancelled') return res.status(422).json({ error: 'Cannot set follow-up on a cancelled submission' });

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({
                follow_up_required:         follow_up_required !== undefined ? Boolean(follow_up_required) : sub.follow_up_required,
                follow_up_due_date:         follow_up_due_date  || null,
                follow_up_notes:            follow_up_notes     || null,
                responsible_team_member_id: responsible_team_member_id || sub.responsible_team_member_id || null,
                updated_by:                 req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'follow_up_set', sub.submission_status, sub.submission_status, req.userId, null, { follow_up_required, follow_up_due_date });
        await auditFromReq(req, 'tax_follow_up_set', 'tax_submission', id, { follow_up_required, follow_up_due_date });
        res.json({ ok: true, id, follow_up_required: Boolean(follow_up_required), follow_up_due_date: follow_up_due_date || null });
    } catch (err) {
        console.error('[tax-submissions] set-follow-up error:', err);
        res.status(500).json({ error: 'Failed to set follow-up' });
    }
});

// ── GET /:id/evidence ─────────────────────────────────────────────────────────

router.get('/:id/evidence', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });

        const { data, error } = await supabase
            .from('practice_tax_submission_evidence')
            .select('*')
            .eq('submission_id', id)
            .eq('company_id', cid)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (error) throw error;

        await auditFromReq(req, 'VIEW', 'tax_submission_evidence', id, {});
        res.json({ evidence: data || [] });
    } catch (err) {
        console.error('[tax-submissions] get-evidence error:', err);
        res.status(500).json({ error: 'Failed to load evidence' });
    }
});

// ── POST /:id/evidence ────────────────────────────────────────────────────────

router.post('/:id/evidence', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { evidence_type, evidence_title, evidence_note, external_reference, related_document_request_id, uploaded_file_url, file_name, file_mime_type, file_size_bytes } = req.body;

    if (!EVIDENCE_TYPES.includes(evidence_type)) return res.status(400).json({ error: `Invalid evidence_type. Allowed: ${EVIDENCE_TYPES.join(', ')}` });
    if (!evidence_title || !evidence_title.trim()) return res.status(400).json({ error: 'evidence_title is required' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status === 'cancelled') return res.status(422).json({ error: 'Cannot add evidence to a cancelled submission' });

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_submission_evidence')
            .insert({
                company_id:                 cid,
                submission_id:              id,
                evidence_type,
                evidence_title:             evidence_title.trim(),
                evidence_note:              evidence_note              || null,
                external_reference:         external_reference         || null,
                related_document_request_id: related_document_request_id || null,
                uploaded_file_url:          uploaded_file_url          || null,
                file_name:                  file_name                  || null,
                file_mime_type:             file_mime_type             || null,
                file_size_bytes:            file_size_bytes            || null,
                created_by:                 req.userId                 || null,
            })
            .select('*')
            .single();

        if (insertErr) throw insertErr;

        await _writeEvent(cid, id, 'evidence_added', sub.submission_status, sub.submission_status, req.userId, null, { evidence_type, evidence_title });
        await auditFromReq(req, 'CREATE', 'tax_submission_evidence', created.id, { submission_id: id, evidence_type });
        res.status(201).json({ ok: true, evidence: created });
    } catch (err) {
        console.error('[tax-submissions] add-evidence error:', err);
        res.status(500).json({ error: 'Failed to add evidence' });
    }
});

// ── PUT /:id/evidence/:evidenceId ─────────────────────────────────────────────

router.put('/:id/evidence/:evidenceId', async (req, res) => {
    const cid        = req.companyId;
    const id         = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!id || isNaN(id) || !evidenceId || isNaN(evidenceId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const ev = await _verifyEvidence(id, evidenceId, cid);
        if (!ev) return res.status(404).json({ error: 'Evidence not found or access denied' });

        const allowed = ['evidence_type','evidence_title','evidence_note','external_reference','uploaded_file_url','file_name','file_mime_type','file_size_bytes'];
        const updates = _pick(req.body, allowed);
        if (updates.evidence_type && !EVIDENCE_TYPES.includes(updates.evidence_type)) {
            return res.status(400).json({ error: 'Invalid evidence_type' });
        }
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });

        const { data: updated, error: updateErr } = await supabase
            .from('practice_tax_submission_evidence')
            .update(updates)
            .eq('id', evidenceId)
            .eq('submission_id', id)
            .eq('company_id', cid)
            .select('*')
            .single();

        if (updateErr) throw updateErr;
        res.json({ ok: true, evidence: updated });
    } catch (err) {
        console.error('[tax-submissions] update-evidence error:', err);
        res.status(500).json({ error: 'Failed to update evidence' });
    }
});

// ── PUT /:id/evidence/:evidenceId/verify ─────────────────────────────────────

router.put('/:id/evidence/:evidenceId/verify', async (req, res) => {
    const cid        = req.companyId;
    const id         = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!id || isNaN(id) || !evidenceId || isNaN(evidenceId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const ev = await _verifyEvidence(id, evidenceId, cid);
        if (!ev) return res.status(404).json({ error: 'Evidence not found or access denied' });
        if (ev.is_verified) return res.status(422).json({ error: 'Evidence is already verified' });

        const { error: updateErr } = await supabase
            .from('practice_tax_submission_evidence')
            .update({ is_verified: true, verified_at: _now(), verified_by: req.userId || null })
            .eq('id', evidenceId)
            .eq('submission_id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'evidence_verified', null, null, req.userId, null, { evidence_id: evidenceId, evidence_type: ev.evidence_type });
        await auditFromReq(req, 'evidence_verified', 'tax_submission_evidence', evidenceId, { submission_id: id });
        res.json({ ok: true, evidence_id: evidenceId, is_verified: true });
    } catch (err) {
        console.error('[tax-submissions] verify-evidence error:', err);
        res.status(500).json({ error: 'Failed to verify evidence' });
    }
});

// ── DELETE /:id/evidence/:evidenceId (soft delete) ────────────────────────────

router.delete('/:id/evidence/:evidenceId', async (req, res) => {
    const cid        = req.companyId;
    const id         = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!id || isNaN(id) || !evidenceId || isNaN(evidenceId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const ev = await _verifyEvidence(id, evidenceId, cid);
        if (!ev) return res.status(404).json({ error: 'Evidence not found or access denied' });

        const { error: updateErr } = await supabase
            .from('practice_tax_submission_evidence')
            .update({ is_deleted: true, deleted_at: _now(), deleted_by: req.userId || null })
            .eq('id', evidenceId)
            .eq('submission_id', id)
            .eq('company_id', cid);

        if (updateErr) throw updateErr;

        await auditFromReq(req, 'DELETE', 'tax_submission_evidence', evidenceId, { submission_id: id });
        res.json({ ok: true, evidence_id: evidenceId, deleted: true });
    } catch (err) {
        console.error('[tax-submissions] delete-evidence error:', err);
        res.status(500).json({ error: 'Failed to delete evidence' });
    }
});

// ── PUT /:id/mark-correction-required (Codebox 44) ───────────────────────────

router.put('/:id/mark-correction-required', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (['cancelled', 'completed'].includes(sub.submission_status))
            return res.status(422).json({ error: `Cannot mark correction required from status: ${sub.submission_status}` });

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({ submission_status: 'correction_required', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'correction_required', sub.submission_status, 'correction_required', req.userId, req.body.notes || null, {});
        await auditFromReq(req, 'tax_submission_correction_required', 'tax_submission', id, { old_status: sub.submission_status });
        res.json({ ok: true, id, submission_status: 'correction_required' });
    } catch (err) {
        console.error('[tax-submissions] mark-correction-required error:', err);
        res.status(500).json({ error: 'Failed to mark correction required' });
    }
});

// ── PUT /:id/mark-objection-required (Codebox 44) ─────────────────────────────

router.put('/:id/mark-objection-required', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (['cancelled', 'completed'].includes(sub.submission_status))
            return res.status(422).json({ error: `Cannot mark objection required from status: ${sub.submission_status}` });

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({ submission_status: 'objection_required', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'objection_required', sub.submission_status, 'objection_required', req.userId, req.body.notes || null, {});
        await auditFromReq(req, 'tax_submission_objection_required', 'tax_submission', id, { old_status: sub.submission_status });
        res.json({ ok: true, id, submission_status: 'objection_required' });
    } catch (err) {
        console.error('[tax-submissions] mark-objection-required error:', err);
        res.status(500).json({ error: 'Failed to mark objection required' });
    }
});

// ── PUT /:id/mark-completed (Codebox 44) ──────────────────────────────────────

router.put('/:id/mark-completed', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        if (sub.submission_status === 'cancelled')
            return res.status(422).json({ error: 'Cannot complete a cancelled submission' });
        if (sub.submission_status === 'completed')
            return res.status(422).json({ error: 'Submission is already completed' });

        const { error: updateErr } = await supabase
            .from('practice_tax_submissions')
            .update({ submission_status: 'completed', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'submission_completed', sub.submission_status, 'completed', req.userId, req.body.notes || null, {});
        await auditFromReq(req, 'tax_submission_completed', 'tax_submission', id, { old_status: sub.submission_status });
        res.json({ ok: true, id, submission_status: 'completed' });
    } catch (err) {
        console.error('[tax-submissions] mark-completed error:', err);
        res.status(500).json({ error: 'Failed to mark submission as completed' });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const sub = await _verifySubmission(id, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });

        const { data, error } = await supabase
            .from('practice_tax_submission_events')
            .select('id, event_type, old_status, new_status, actor_user_id, notes, metadata, created_at')
            .eq('submission_id', id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('[tax-submissions] get-events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

module.exports = router;
