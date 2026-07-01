'use strict';

// Codebox 44 — Tax Dispute / Correction / Objection Tracker
// Manual internal tracking for SARS assessment corrections, objections,
// NOO, ADR, appeal, tax court escalation.
//
// NOT SARS API. NOT eFiling objection submission.
// All data is manually entered and tracked by practice staff.

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

const SOURCE_TYPES      = ['tax_submission', 'sars_statement_line', 'assessment', 'payment_case', 'manual'];
const CASE_TYPES        = ['correction', 'objection', 'noo', 'adr', 'appeal', 'tax_court', 'manual_review'];
const CASE_STATUSES     = ['open', 'pending_submission', 'submitted', 'acknowledged', 'under_review',
                           'response_received', 'accepted', 'rejected', 'escalated', 'appealing',
                           'completed', 'cancelled'];
const TERMINAL_STATUSES = ['completed', 'cancelled'];
const TAX_TYPES         = ['itr12', 'itr14', 'irp6', 'emp201', 'emp501', 'vat201', 'other'];
const PRIORITIES        = ['low', 'medium', 'high', 'urgent'];
const EVIDENCE_TYPES    = ['sars_correspondence', 'supporting_document', 'objection_form', 'legal_advice',
                           'tax_calculation', 'payment_proof', 'acknowledgement', 'other'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyCase(id, cid) {
    const { data } = await supabase
        .from('practice_tax_dispute_cases')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _verifyEvidence(id, caseId, cid) {
    const { data } = await supabase
        .from('practice_tax_dispute_evidence')
        .select('*')
        .eq('id', id)
        .eq('dispute_case_id', caseId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _writeEvent(cid, caseId, eventType, oldStatus, newStatus, actorId, notes, metadata) {
    await supabase.from('practice_tax_dispute_events').insert({
        company_id:      cid,
        dispute_case_id: caseId,
        event_type:      eventType,
        old_status:      oldStatus || null,
        new_status:      newStatus || null,
        actor_user_id:   actorId   || null,
        notes:           notes     || null,
        metadata:        metadata  || {},
    });
}

async function _enrichWithClientNames(cases, cid) {
    if (!cases.length) return cases;
    const ids = [...new Set(cases.map(c => c.client_id).filter(Boolean))];
    if (!ids.length) return cases;
    const { data: clients } = await supabase
        .from('practice_clients')
        .select('id, client_name')
        .eq('company_id', cid)
        .in('id', ids);
    const map = {};
    (clients || []).forEach(c => { map[c.id] = c.client_name; });
    return cases.map(c => ({ ...c, client_name: map[c.client_id] || null }));
}

async function _checkDuplicate(cid, clientId, sourceType, sourceId, caseType) {
    if (!sourceId) return null;
    const { data } = await supabase
        .from('practice_tax_dispute_cases')
        .select('id')
        .eq('company_id', cid)
        .eq('client_id', clientId)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId)
        .eq('case_type', caseType)
        .not('case_status', 'in', '("completed","cancelled")')
        .limit(1)
        .maybeSingle();
    return data || null;
}

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const today = new Date().toISOString().slice(0, 10);
        const { data: cases } = await supabase
            .from('practice_tax_dispute_cases')
            .select('case_status, case_type, priority, submission_deadline, response_deadline')
            .eq('company_id', cid);

        const byStatus = {};
        CASE_STATUSES.forEach(s => { byStatus[s] = 0; });
        const byType = {};
        CASE_TYPES.forEach(t => { byType[t] = 0; });

        let openCount    = 0;
        let overdueCount = 0;

        (cases || []).forEach(c => {
            if (byStatus[c.case_status] !== undefined) byStatus[c.case_status]++;
            if (byType[c.case_type]     !== undefined) byType[c.case_type]++;
            if (!TERMINAL_STATUSES.includes(c.case_status)) {
                openCount++;
                const deadlines = [c.submission_deadline, c.response_deadline].filter(Boolean);
                if (deadlines.some(d => d < today)) overdueCount++;
            }
        });

        await auditFromReq(req, 'VIEW', 'tax_disputes', null, { action: 'summary' });
        res.json({
            by_status:     byStatus,
            by_type:       byType,
            open_count:    openCount,
            overdue_count: overdueCount,
            total_cases:   (cases || []).length,
        });
    } catch (err) {
        console.error('[tax-disputes] summary error:', err);
        res.status(500).json({ error: 'Failed to load dispute summary' });
    }
});

// ── GET / (list with filters + pagination) ────────────────────────────────────
// NOTE: create-from-* helpers are mounted BEFORE /:id to avoid ID collision.

router.get('/', async (req, res) => {
    const cid = req.companyId;
    try {
        const page    = Math.max(1, Number(req.query.page)     || 1);
        const perPage = Math.min(100, Math.max(10, Number(req.query.per_page) || 50));
        const offset  = (page - 1) * perPage;

        let q = supabase
            .from('practice_tax_dispute_cases')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (req.query.client_id)     q = q.eq('client_id', Number(req.query.client_id));
        if (req.query.submission_id) q = q.eq('submission_id', Number(req.query.submission_id));
        if (req.query.source_type && SOURCE_TYPES.includes(req.query.source_type))
            q = q.eq('source_type', req.query.source_type);
        if (req.query.source_id)     q = q.eq('source_id', Number(req.query.source_id));
        if (req.query.case_type && CASE_TYPES.includes(req.query.case_type))
            q = q.eq('case_type', req.query.case_type);
        if (req.query.case_status && CASE_STATUSES.includes(req.query.case_status))
            q = q.eq('case_status', req.query.case_status);
        if (req.query.tax_type && TAX_TYPES.includes(req.query.tax_type))
            q = q.eq('tax_type', req.query.tax_type);
        if (req.query.tax_year)      q = q.eq('tax_year', req.query.tax_year);
        if (req.query.priority && PRIORITIES.includes(req.query.priority))
            q = q.eq('priority', req.query.priority);
        if (req.query.date_from)     q = q.gte('date_opened', req.query.date_from);
        if (req.query.date_to)       q = q.lte('date_opened', req.query.date_to);
        if (req.query.search) {
            const s = req.query.search.trim();
            q = q.or(`title.ilike.%${s}%,sars_case_number.ilike.%${s}%,assessment_reference.ilike.%${s}%`);
        }
        if (req.query.active === '1') {
            q = q.not('case_status', 'in', '("completed","cancelled")');
        }

        const { data, count, error } = await q
            .order('created_at', { ascending: false })
            .range(offset, offset + perPage - 1);
        if (error) throw error;

        const enriched = await _enrichWithClientNames(data || [], cid);

        await auditFromReq(req, 'VIEW', 'tax_disputes', null, { action: 'list', count: enriched.length });
        res.json({ cases: enriched, total: count || 0, page, per_page: perPage });
    } catch (err) {
        console.error('[tax-disputes] list error:', err);
        res.status(500).json({ error: 'Failed to load dispute cases' });
    }
});

// ── POST /create-from-submission ──────────────────────────────────────────────

router.post('/create-from-submission', async (req, res) => {
    const cid = req.companyId;
    const { submission_id, case_type, title, priority, notes } = req.body;

    if (!submission_id || isNaN(Number(submission_id)))
        return res.status(400).json({ error: 'submission_id is required' });
    const ct = case_type || 'correction';
    if (!CASE_TYPES.includes(ct))
        return res.status(400).json({ error: `Invalid case_type. Allowed: ${CASE_TYPES.join(', ')}` });

    try {
        const { data: sub } = await supabase
            .from('practice_tax_submissions')
            .select('id, company_id, client_id, submission_type, tax_year')
            .eq('id', Number(submission_id))
            .eq('company_id', cid)
            .maybeSingle();
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });

        const dup = await _checkDuplicate(cid, sub.client_id, 'tax_submission', Number(submission_id), ct);
        if (dup) {
            return res.status(409).json({
                error: `An active ${ct} case already exists for this submission.`,
                code:  'DUPLICATE_DISPUTE_CASE',
                existing_case_id: dup.id,
            });
        }

        const autoTitle = (title && title.trim())
            ? title.trim()
            : `${ct.charAt(0).toUpperCase() + ct.slice(1)} — ${sub.submission_type || 'Submission'} ${sub.tax_year || ''}`.trim();

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_dispute_cases')
            .insert({
                company_id:    cid,
                source_type:   'tax_submission',
                source_id:     Number(submission_id),
                case_type:     ct,
                case_status:   'open',
                title:         autoTitle,
                client_id:     sub.client_id,
                submission_id: Number(submission_id),
                date_opened:   new Date().toISOString().slice(0, 10),
                priority:      priority || 'medium',
                notes:         notes    || null,
                created_by:    req.userId || null,
                updated_by:    req.userId || null,
            })
            .select()
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'dispute_case_created', null, 'open', req.userId, notes,
            { source_type: 'tax_submission', source_id: Number(submission_id), case_type: ct });
        await auditFromReq(req, 'tax_dispute_created_from_submission', 'tax_dispute', created.id, { submission_id, case_type: ct });
        res.status(201).json({ ok: true, case: created });
    } catch (err) {
        console.error('[tax-disputes] create-from-submission error:', err);
        res.status(500).json({ error: 'Failed to create dispute case from submission' });
    }
});

// ── POST /create-from-sars-line ───────────────────────────────────────────────

router.post('/create-from-sars-line', async (req, res) => {
    const cid = req.companyId;
    const { statement_line_id, case_type, title, priority, notes } = req.body;

    if (!statement_line_id || isNaN(Number(statement_line_id)))
        return res.status(400).json({ error: 'statement_line_id is required' });
    const ct = case_type || 'objection';
    if (!CASE_TYPES.includes(ct))
        return res.status(400).json({ error: `Invalid case_type. Allowed: ${CASE_TYPES.join(', ')}` });

    try {
        const { data: line } = await supabase
            .from('practice_sars_statement_lines')
            .select('id, company_id, client_id, tax_type, tax_year, description, reference_number, transaction_type')
            .eq('id', Number(statement_line_id))
            .eq('company_id', cid)
            .maybeSingle();
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });

        const dup = await _checkDuplicate(cid, line.client_id, 'sars_statement_line', Number(statement_line_id), ct);
        if (dup) {
            return res.status(409).json({
                error: `An active ${ct} case already exists for this statement line.`,
                code:  'DUPLICATE_DISPUTE_CASE',
                existing_case_id: dup.id,
            });
        }

        const autoTitle = (title && title.trim())
            ? title.trim()
            : `${ct.charAt(0).toUpperCase() + ct.slice(1)} — SARS ${line.transaction_type || ''} ${line.reference_number || ''}`.trim();

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_dispute_cases')
            .insert({
                company_id:  cid,
                source_type: 'sars_statement_line',
                source_id:   Number(statement_line_id),
                case_type:   ct,
                case_status: 'open',
                title:       autoTitle,
                client_id:   line.client_id,
                tax_type:    line.tax_type  || null,
                tax_year:    line.tax_year  || null,
                date_opened: new Date().toISOString().slice(0, 10),
                priority:    priority || 'medium',
                notes:       notes    || null,
                created_by:  req.userId || null,
                updated_by:  req.userId || null,
            })
            .select()
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'dispute_case_created', null, 'open', req.userId, notes,
            { source_type: 'sars_statement_line', source_id: Number(statement_line_id), case_type: ct });
        await auditFromReq(req, 'tax_dispute_created_from_sars_line', 'tax_dispute', created.id, { statement_line_id, case_type: ct });
        res.status(201).json({ ok: true, case: created });
    } catch (err) {
        console.error('[tax-disputes] create-from-sars-line error:', err);
        res.status(500).json({ error: 'Failed to create dispute case from SARS statement line' });
    }
});

// ── POST /create-from-assessment ─────────────────────────────────────────────

router.post('/create-from-assessment', async (req, res) => {
    const cid = req.companyId;
    const { client_id, case_type, title, assessment_reference, tax_type, tax_year, period_label, priority, notes } = req.body;

    if (!client_id || isNaN(Number(client_id)))
        return res.status(400).json({ error: 'client_id is required' });
    const ct = case_type || 'objection';
    if (!CASE_TYPES.includes(ct))
        return res.status(400).json({ error: `Invalid case_type. Allowed: ${CASE_TYPES.join(', ')}` });
    if (!assessment_reference || !assessment_reference.trim())
        return res.status(400).json({ error: 'assessment_reference is required' });
    if (tax_type && !TAX_TYPES.includes(tax_type))
        return res.status(400).json({ error: `Invalid tax_type. Allowed: ${TAX_TYPES.join(', ')}` });

    const { data: client } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('id', Number(client_id))
        .eq('company_id', cid)
        .maybeSingle();
    if (!client) return res.status(400).json({ error: 'Client not found or access denied' });

    try {
        const autoTitle = (title && title.trim())
            ? title.trim()
            : `${ct.charAt(0).toUpperCase() + ct.slice(1)} — Assessment ${assessment_reference.trim()}`;

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_dispute_cases')
            .insert({
                company_id:           cid,
                source_type:          'assessment',
                source_id:            null,
                case_type:            ct,
                case_status:          'open',
                title:                autoTitle,
                client_id:            Number(client_id),
                assessment_reference: assessment_reference.trim(),
                tax_type:             tax_type     || null,
                tax_year:             tax_year     || null,
                period_label:         period_label || null,
                date_opened:          new Date().toISOString().slice(0, 10),
                priority:             priority     || 'medium',
                notes:                notes        || null,
                created_by:           req.userId   || null,
                updated_by:           req.userId   || null,
            })
            .select()
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'dispute_case_created', null, 'open', req.userId, notes,
            { source_type: 'assessment', assessment_reference: assessment_reference.trim(), case_type: ct });
        await auditFromReq(req, 'tax_dispute_created_from_assessment', 'tax_dispute', created.id, { assessment_reference, case_type: ct });
        res.status(201).json({ ok: true, case: created });
    } catch (err) {
        console.error('[tax-disputes] create-from-assessment error:', err);
        res.status(500).json({ error: 'Failed to create dispute case from assessment' });
    }
});

// ── POST / (general create) ───────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, source_type, source_id, case_type, title, description,
        submission_id, assessment_reference, sars_case_number, sars_dispute_reference,
        tax_type, tax_year, period_label, date_opened, submission_deadline, response_deadline,
        priority, responsible_team_member_id, notes, internal_notes,
    } = req.body;

    if (!client_id || isNaN(Number(client_id)))
        return res.status(400).json({ error: 'client_id is required' });
    if (!source_type || !SOURCE_TYPES.includes(source_type))
        return res.status(400).json({ error: `Invalid source_type. Allowed: ${SOURCE_TYPES.join(', ')}` });
    if (!case_type || !CASE_TYPES.includes(case_type))
        return res.status(400).json({ error: `Invalid case_type. Allowed: ${CASE_TYPES.join(', ')}` });
    if (!title || !title.trim())
        return res.status(400).json({ error: 'title is required' });
    if (tax_type && !TAX_TYPES.includes(tax_type))
        return res.status(400).json({ error: `Invalid tax_type. Allowed: ${TAX_TYPES.join(', ')}` });
    if (priority && !PRIORITIES.includes(priority))
        return res.status(400).json({ error: `Invalid priority. Allowed: ${PRIORITIES.join(', ')}` });

    const { data: client } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('id', Number(client_id))
        .eq('company_id', cid)
        .maybeSingle();
    if (!client) return res.status(400).json({ error: 'Client not found or access denied' });

    try {
        const dup = await _checkDuplicate(cid, Number(client_id), source_type, source_id ? Number(source_id) : null, case_type);
        if (dup) {
            return res.status(409).json({
                error: `An active ${case_type} case already exists for this source.`,
                code:  'DUPLICATE_DISPUTE_CASE',
                existing_case_id: dup.id,
            });
        }

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_dispute_cases')
            .insert({
                company_id:                cid,
                source_type,
                source_id:                 source_id ? Number(source_id) : null,
                case_type,
                case_status:               'open',
                title:                     title.trim(),
                description:               description || null,
                client_id:                 Number(client_id),
                submission_id:             submission_id ? Number(submission_id) : null,
                assessment_reference:      assessment_reference || null,
                sars_case_number:          sars_case_number     || null,
                sars_dispute_reference:    sars_dispute_reference || null,
                tax_type:                  tax_type    || null,
                tax_year:                  tax_year    || null,
                period_label:              period_label || null,
                date_opened:               date_opened  || new Date().toISOString().slice(0, 10),
                submission_deadline:       submission_deadline || null,
                response_deadline:         response_deadline   || null,
                priority:                  priority    || 'medium',
                responsible_team_member_id: responsible_team_member_id ? Number(responsible_team_member_id) : null,
                notes:                     notes          || null,
                internal_notes:            internal_notes || null,
                created_by:                req.userId     || null,
                updated_by:                req.userId     || null,
            })
            .select()
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'dispute_case_created', null, 'open', req.userId, notes, { source_type, case_type });
        await auditFromReq(req, 'tax_dispute_case_created', 'tax_dispute', created.id, { case_type, source_type });
        res.status(201).json({ ok: true, case: created });
    } catch (err) {
        console.error('[tax-disputes] create error:', err);
        res.status(500).json({ error: 'Failed to create dispute case' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const c = await _verifyCase(id, cid);
    if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });

    const enriched = (await _enrichWithClientNames([c], cid))[0];
    await auditFromReq(req, 'VIEW', 'tax_dispute', id, {});
    res.json({ case: enriched });
});

// ── PUT /:id (update non-status fields) ───────────────────────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const c = await _verifyCase(id, cid);
        if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
        if (c.case_status === 'cancelled') return res.status(422).json({ error: 'Cannot update a cancelled case' });

        const allowed = [
            'title', 'description', 'assessment_reference', 'sars_case_number', 'sars_dispute_reference',
            'tax_type', 'tax_year', 'period_label', 'date_opened', 'submission_deadline', 'response_deadline',
            'sars_response_date', 'priority', 'responsible_team_member_id', 'notes', 'internal_notes',
            'outcome', 'outcome_amount', 'outcome_notes', 'submission_id',
        ];
        const patch = _pick(req.body, allowed);

        if (patch.tax_type && !TAX_TYPES.includes(patch.tax_type))
            return res.status(400).json({ error: `Invalid tax_type` });
        if (patch.priority && !PRIORITIES.includes(patch.priority))
            return res.status(400).json({ error: `Invalid priority` });
        if (patch.outcome_amount != null) patch.outcome_amount = _round2(patch.outcome_amount);

        patch.updated_by = req.userId || null;

        const { error: updateErr } = await supabase
            .from('practice_tax_dispute_cases')
            .update(patch)
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'dispute_case_updated', c.case_status, c.case_status, req.userId,
            req.body.notes || null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'tax_dispute_case_updated', 'tax_dispute', id, { fields: Object.keys(patch) });
        res.json({ ok: true, id });
    } catch (err) {
        console.error('[tax-disputes] update error:', err);
        res.status(500).json({ error: 'Failed to update dispute case' });
    }
});

// ── DELETE /:id (soft cancel) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const c = await _verifyCase(id, cid);
        if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
        if (c.case_status === 'cancelled') return res.status(422).json({ error: 'Case is already cancelled' });
        if (c.case_status === 'completed') return res.status(422).json({ error: 'Completed cases cannot be cancelled' });

        const notes = req.body.notes || null;
        const { error: updateErr } = await supabase
            .from('practice_tax_dispute_cases')
            .update({ case_status: 'cancelled', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'dispute_case_cancelled', c.case_status, 'cancelled', req.userId, notes, {});
        await auditFromReq(req, 'tax_dispute_case_cancelled', 'tax_dispute', id, { old_status: c.case_status });
        res.json({ ok: true, id, case_status: 'cancelled' });
    } catch (err) {
        console.error('[tax-disputes] cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel dispute case' });
    }
});

// ── Shared action helper ──────────────────────────────────────────────────────

async function _applyAction(req, res, allowedFrom, newStatus, eventType, extraPatch, auditAction) {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const c = await _verifyCase(id, cid);
        if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
        if (TERMINAL_STATUSES.includes(c.case_status))
            return res.status(422).json({ error: `Cannot apply action to a ${c.case_status} case` });
        if (allowedFrom && !allowedFrom.includes(c.case_status))
            return res.status(422).json({
                error: `Action not allowed from status: ${c.case_status}. Allowed from: ${allowedFrom.join(', ')}`,
            });

        const patch = { case_status: newStatus, updated_by: req.userId || null, ...extraPatch };
        const { error: updateErr } = await supabase
            .from('practice_tax_dispute_cases')
            .update(patch)
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, eventType, c.case_status, newStatus, req.userId, req.body.notes || null, extraPatch);
        await auditFromReq(req, auditAction, 'tax_dispute', id, { old_status: c.case_status, new_status: newStatus });
        res.json({ ok: true, id, case_status: newStatus });
    } catch (err) {
        console.error(`[tax-disputes] ${eventType} error:`, err);
        res.status(500).json({ error: `Failed to apply action` });
    }
}

// ── PUT /:id/mark-submitted ───────────────────────────────────────────────────

router.put('/:id/mark-submitted', (req, res) =>
    _applyAction(req, res,
        ['open', 'pending_submission', 'acknowledged', 'escalated'],
        'submitted', 'dispute_submitted',
        { sars_dispute_reference: req.body.submission_reference || null },
        'tax_dispute_submitted'
    )
);

// ── PUT /:id/record-acknowledgement ──────────────────────────────────────────

router.put('/:id/record-acknowledgement', (req, res) =>
    _applyAction(req, res,
        ['submitted', 'escalated', 'appealing'],
        'acknowledged', 'dispute_acknowledged',
        {
            sars_case_number:   req.body.sars_case_number   || null,
            sars_response_date: req.body.acknowledgement_date || null,
        },
        'tax_dispute_acknowledged'
    )
);

// ── PUT /:id/record-response ──────────────────────────────────────────────────

router.put('/:id/record-response', (req, res) =>
    _applyAction(req, res,
        ['submitted', 'acknowledged', 'under_review', 'escalated', 'appealing'],
        'response_received', 'dispute_response_received',
        { sars_response_date: req.body.response_date || null },
        'tax_dispute_response_received'
    )
);

// ── PUT /:id/accept ───────────────────────────────────────────────────────────

router.put('/:id/accept', (req, res) =>
    _applyAction(req, res,
        ['response_received', 'under_review', 'acknowledged', 'escalated'],
        'accepted', 'dispute_accepted',
        {
            outcome:        'accepted',
            outcome_amount: req.body.outcome_amount != null ? _round2(req.body.outcome_amount) : null,
            outcome_notes:  req.body.outcome_notes  || null,
        },
        'tax_dispute_accepted'
    )
);

// ── PUT /:id/reject ───────────────────────────────────────────────────────────

router.put('/:id/reject', (req, res) =>
    _applyAction(req, res,
        ['response_received', 'under_review', 'acknowledged', 'escalated'],
        'rejected', 'dispute_rejected',
        { outcome: 'rejected', outcome_notes: req.body.outcome_notes || null },
        'tax_dispute_rejected'
    )
);

// ── PUT /:id/escalate ─────────────────────────────────────────────────────────

router.put('/:id/escalate', async (req, res) => {
    if (!req.body.notes || !String(req.body.notes).trim())
        return res.status(400).json({ error: 'notes are required when escalating' });
    return _applyAction(req, res, null, 'escalated', 'dispute_escalated', {}, 'tax_dispute_escalated');
});

// ── PUT /:id/complete ─────────────────────────────────────────────────────────

router.put('/:id/complete', (req, res) =>
    _applyAction(req, res, null, 'completed', 'dispute_completed',
        {
            outcome:        req.body.outcome        || null,
            outcome_amount: req.body.outcome_amount != null ? _round2(req.body.outcome_amount) : null,
            outcome_notes:  req.body.outcome_notes  || null,
        },
        'tax_dispute_completed'
    )
);

// ── GET /:id/evidence ─────────────────────────────────────────────────────────

router.get('/:id/evidence', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const c = await _verifyCase(id, cid);
    if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });

    try {
        const { data, error } = await supabase
            .from('practice_tax_dispute_evidence')
            .select('*')
            .eq('dispute_case_id', id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ evidence: data || [] });
    } catch (err) {
        console.error('[tax-disputes] evidence list error:', err);
        res.status(500).json({ error: 'Failed to load evidence' });
    }
});

// ── POST /:id/evidence ────────────────────────────────────────────────────────

router.post('/:id/evidence', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const c = await _verifyCase(id, cid);
    if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
    if (c.case_status === 'cancelled') return res.status(422).json({ error: 'Cannot add evidence to a cancelled case' });

    const { evidence_type, evidence_title, evidence_date, evidence_note, external_reference } = req.body;
    if (!EVIDENCE_TYPES.includes(evidence_type))
        return res.status(400).json({ error: `Invalid evidence_type. Allowed: ${EVIDENCE_TYPES.join(', ')}` });
    if (!evidence_title || !evidence_title.trim())
        return res.status(400).json({ error: 'evidence_title is required' });

    try {
        const { data: ev, error: insertErr } = await supabase
            .from('practice_tax_dispute_evidence')
            .insert({
                company_id:         cid,
                dispute_case_id:    id,
                evidence_type,
                evidence_title:     evidence_title.trim(),
                evidence_date:      evidence_date       || null,
                evidence_note:      evidence_note       || null,
                external_reference: external_reference  || null,
                is_verified:        false,
                created_by:         req.userId || null,
                updated_by:         req.userId || null,
            })
            .select()
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, id, 'evidence_added', c.case_status, c.case_status, req.userId, null,
            { evidence_title: evidence_title.trim(), evidence_type });
        await auditFromReq(req, 'tax_dispute_evidence_added', 'tax_dispute_evidence', ev.id, { dispute_case_id: id });
        res.status(201).json({ ok: true, evidence: ev });
    } catch (err) {
        console.error('[tax-disputes] add evidence error:', err);
        res.status(500).json({ error: 'Failed to add evidence' });
    }
});

// ── DELETE /:id/evidence/:evidenceId ─────────────────────────────────────────

router.delete('/:id/evidence/:evidenceId', async (req, res) => {
    const cid        = req.companyId;
    const id         = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!id || isNaN(id) || !evidenceId || isNaN(evidenceId))
        return res.status(400).json({ error: 'Invalid id' });

    try {
        const c  = await _verifyCase(id, cid);
        if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
        const ev = await _verifyEvidence(evidenceId, id, cid);
        if (!ev) return res.status(404).json({ error: 'Evidence record not found or access denied' });

        const { error: delErr } = await supabase
            .from('practice_tax_dispute_evidence')
            .delete()
            .eq('id', evidenceId)
            .eq('company_id', cid);
        if (delErr) throw delErr;

        await _writeEvent(cid, id, 'evidence_removed', c.case_status, c.case_status, req.userId, null,
            { evidence_id: evidenceId, evidence_title: ev.evidence_title });
        await auditFromReq(req, 'tax_dispute_evidence_removed', 'tax_dispute_evidence', evidenceId, { dispute_case_id: id });
        res.json({ ok: true, id: evidenceId });
    } catch (err) {
        console.error('[tax-disputes] delete evidence error:', err);
        res.status(500).json({ error: 'Failed to remove evidence' });
    }
});

// ── PUT /:id/evidence/:evidenceId/verify ─────────────────────────────────────

router.put('/:id/evidence/:evidenceId/verify', async (req, res) => {
    const cid        = req.companyId;
    const id         = Number(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!id || isNaN(id) || !evidenceId || isNaN(evidenceId))
        return res.status(400).json({ error: 'Invalid id' });

    try {
        const c  = await _verifyCase(id, cid);
        if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });
        const ev = await _verifyEvidence(evidenceId, id, cid);
        if (!ev) return res.status(404).json({ error: 'Evidence record not found or access denied' });

        const { error: updateErr } = await supabase
            .from('practice_tax_dispute_evidence')
            .update({
                is_verified: true,
                verified_by: req.userId || null,
                verified_at: new Date().toISOString(),
                updated_by:  req.userId || null,
            })
            .eq('id', evidenceId)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'evidence_verified', c.case_status, c.case_status, req.userId, null,
            { evidence_id: evidenceId });
        await auditFromReq(req, 'tax_dispute_evidence_verified', 'tax_dispute_evidence', evidenceId, { dispute_case_id: id });
        res.json({ ok: true, id: evidenceId, is_verified: true });
    } catch (err) {
        console.error('[tax-disputes] verify evidence error:', err);
        res.status(500).json({ error: 'Failed to verify evidence' });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const c = await _verifyCase(id, cid);
    if (!c) return res.status(404).json({ error: 'Dispute case not found or access denied' });

    try {
        const { data, error } = await supabase
            .from('practice_tax_dispute_events')
            .select('*')
            .eq('dispute_case_id', id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('[tax-disputes] events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

module.exports = router;
