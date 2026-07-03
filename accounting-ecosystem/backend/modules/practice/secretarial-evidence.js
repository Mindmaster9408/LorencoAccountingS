'use strict';

// Codebox 66 — Secretarial Document Checklist + Governance Evidence Requests
// An EVIDENCE LAYER on top of the existing Document Requests module — what
// evidence is required, why, whether it's been received, whether it's been
// verified. NEVER a second document system.
//
// DO NOT BUILD: document storage, file uploads, an attachment system, a
// document viewer, duplicate document requests, duplicate document tables.
// practice_document_requests (migration 073, document-requests.js) remains
// the sole owner of documents — this module only links to it.
//
// "BO readiness uses evidence completion. No duplicate readiness logic."
// For source_type = 'bo_verification', this module never tracks its own
// items — it delegates entirely to practice_bo_readiness_items (Codebox 65)
// via beneficial-ownership.js's exported generateReadinessItems() and
// getBeneficialOwnershipProfile(). See migration 124's header.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const beneficialOwnership = require('./beneficial-ownership');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const TEMPLATE_TYPES = [
    'director_appointment', 'director_resignation', 'share_transfer',
    'company_name_change', 'registered_address_change', 'beneficial_ownership',
    'annual_return', 'resolution', 'minutes', 'trustee_appointment',
    'company_secretary', 'accounting_officer', 'auditor', 'financial_year_end', 'custom',
];
const SOURCE_TYPES = ['change_case', 'governance_resolution', 'governance_meeting', 'bo_verification', 'annual_return', 'manual'];
const ITEM_STATUSES = ['waiting', 'requested', 'received', 'verified', 'waived', 'blocked'];
const ITEM_DONE_STATUSES_NO_VERIFICATION = ['received', 'verified', 'waived'];

// Maps Codebox 63's change_case change_type onto this module's template_type
// vocabulary — a many-to-one, deliberate simplification (several change
// types genuinely need the same evidence shape, e.g. both address-change
// types). Anything unmapped falls back to 'custom'.
const CHANGE_TYPE_TO_TEMPLATE_TYPE = {
    director_appointment: 'director_appointment',
    director_resignation: 'director_resignation',
    share_transfer: 'share_transfer',
    company_name_change: 'company_name_change',
    registered_address_change: 'registered_address_change',
    postal_address_change: 'registered_address_change',
    annual_return: 'annual_return',
    company_secretary_change: 'company_secretary',
    auditor_change: 'auditor',
    accounting_officer_change: 'accounting_officer',
    financial_year_end_change: 'financial_year_end',
};

// Default evidence sets — a persisted, manager-editable analog of Codebox
// 63's CHECKLIST_DEFAULTS constant. Seeded on first use per company (see
// _ensureDefaultTemplates()), never silently regenerated after that so a
// manager's edits are never overwritten.
function _ev(evidence_type, item_name, verificationRequired, docCategory) {
    return { evidence_type, item_name, required: true, verification_required: !!verificationRequired, recommended_document_category: docCategory || null };
}
const DEFAULT_TEMPLATES = {
    director_appointment: { name: 'Director Appointment', evidence: [
        _ev('signed_consent', 'Signed consent to act', false, 'cipc'),
        _ev('id_document', 'ID document', true, 'identity'),
        _ev('resolution', 'Appointment resolution', false, 'legal'),
    ] },
    director_resignation: { name: 'Director Resignation', evidence: [
        _ev('resignation_letter', 'Resignation letter', false, 'cipc'),
        _ev('resolution', 'Resolution/minute noting resignation', false, 'legal'),
    ] },
    share_transfer: { name: 'Share Transfer', evidence: [
        _ev('transfer_agreement', 'Transfer agreement', false, 'legal'),
        _ev('share_certificate', 'Share certificate review', true, 'legal'),
        _ev('resolution', 'Resolution', false, 'legal'),
    ] },
    company_name_change: { name: 'Company Name Change', evidence: [
        _ev('resolution', 'Special resolution', false, 'legal'),
        _ev('cipc_confirmation', 'CIPC name reservation/confirmation', false, 'cipc'),
    ] },
    registered_address_change: { name: 'Address Change', evidence: [
        _ev('proof_of_address', 'Proof of address', false, 'compliance'),
        _ev('resolution', 'Resolution/approval', false, 'legal'),
    ] },
    beneficial_ownership: { name: 'Beneficial Ownership', evidence: [] }, // delegated — never populated, see module header
    annual_return: { name: 'Annual Return', evidence: [
        _ev('turnover_confirmation', 'Turnover confirmation', false, 'financials'),
        _ev('cipc_fee_check', 'CIPC fee check', false, 'cipc'),
        _ev('bo_check', 'Beneficial ownership check', false, 'compliance'),
    ] },
    resolution: { name: 'Resolution', evidence: [
        _ev('signed_resolution', 'Signed resolution', true, 'legal'),
    ] },
    minutes: { name: 'Minutes', evidence: [
        _ev('signed_minutes', 'Signed minutes', true, 'legal'),
        _ev('attendance_record', 'Attendance record', false, 'legal'),
    ] },
    trustee_appointment: { name: 'Trustee Appointment', evidence: [
        _ev('signed_consent', 'Signed consent to act', false, 'trust'),
        _ev('id_document', 'ID document', true, 'identity'),
        _ev('trust_deed_amendment', 'Trust deed amendment', false, 'trust'),
    ] },
    company_secretary: { name: 'Company Secretary Change', evidence: [
        _ev('resolution', 'Resolution/approval', false, 'legal'),
        _ev('consent', 'Signed consent to act', false, 'cipc'),
    ] },
    accounting_officer: { name: 'Accounting Officer Change', evidence: [
        _ev('resolution', 'Resolution/approval', false, 'legal'),
        _ev('consent', 'Signed consent to act', false, 'compliance'),
    ] },
    auditor: { name: 'Auditor Change', evidence: [
        _ev('resolution', 'Resolution/approval', false, 'legal'),
        _ev('consent', 'Signed consent to act', false, 'compliance'),
    ] },
    financial_year_end: { name: 'Financial Year-End Change', evidence: [
        _ev('resolution', 'Resolution/approval', false, 'legal'),
        _ev('cipc_confirmation', 'CIPC confirmation', false, 'cipc'),
    ] },
    custom: { name: 'Custom', evidence: [] },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role')
        .eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!_isManager(member)) {
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage secretarial evidence.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_secretarial_evidence_events').insert({
        company_id: cid, client_id: clientId || null, source_type: sourceType, source_id: sourceId,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// Seeds this company's template library the first time it's needed —
// idempotent (checks for an existing active template of each type first),
// never overwrites a manager's own edits on subsequent calls.
async function _ensureDefaultTemplates(cid, actorUserId) {
    const { data: existing } = await supabase.from('practice_secretarial_evidence_templates').select('template_type').eq('company_id', cid);
    const existingTypes = new Set((existing || []).map(t => t.template_type));

    const toInsert = Object.entries(DEFAULT_TEMPLATES)
        .filter(([type]) => !existingTypes.has(type))
        .map(([type, def]) => ({
            company_id: cid, template_type: type, template_name: def.name,
            required_evidence: def.evidence, created_by: actorUserId,
        }));
    if (!toInsert.length) return;

    const { data } = await supabase.from('practice_secretarial_evidence_templates').insert(toInsert).select();
    for (const t of (data || [])) {
        await _writeEvent(cid, null, 'template', t.id, 'template_created', null, null, actorUserId, t.template_name, { seeded: true });
    }
}

async function _resolveTemplateTypeFromSource(cid, sourceType, sourceId) {
    if (sourceType === 'change_case' && sourceId) {
        const { data } = await supabase.from('practice_secretarial_change_cases').select('change_type').eq('id', sourceId).eq('company_id', cid).maybeSingle();
        return (data && CHANGE_TYPE_TO_TEMPLATE_TYPE[data.change_type]) || 'custom';
    }
    if (sourceType === 'governance_resolution') return 'resolution';
    if (sourceType === 'governance_meeting') return 'minutes';
    if (sourceType === 'bo_verification') return 'beneficial_ownership';
    if (sourceType === 'annual_return') return 'annual_return';
    return 'custom';
}

// ── Document Request Integration ────────────────────────────────────────────────
// Reuses practice_document_requests (migration 073) directly — never a
// duplicate table. document-requests.js exports nothing, so integration is
// via direct, scoped queries/inserts using its exact existing column shape.

async function _createLinkedDocumentRequest(cid, clientId, item, actorUserId) {
    const { data, error } = await supabase.from('practice_document_requests').insert({
        company_id: cid, client_id: clientId, request_title: item.item_name,
        document_category: item.recommended_document_category || 'supporting_docs',
        request_status: 'requested', notes: `Linked to secretarial evidence item: ${item.item_name}`,
        created_by: actorUserId,
    }).select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
}

// Pulls the current status of an item's linked document request and maps it
// onto the evidence item's own status — always run live on read, never
// pushed from document-requests.js (which is never modified by this module).
async function _syncItemFromDocumentRequest(cid, item) {
    if (!item.linked_document_request_id) return item;
    const { data: docReq } = await supabase.from('practice_document_requests').select('request_status').eq('id', item.linked_document_request_id).eq('company_id', cid).maybeSingle();
    if (!docReq) return item;

    let mapped = item.status;
    if (['requested', 'reminder_sent', 'partially_received'].includes(docReq.request_status)) mapped = 'requested';
    else if (docReq.request_status === 'received') mapped = 'received'; // verification (if required) is always a separate, explicit manager action via PUT /items/:id/verify — never inferred here
    else if (docReq.request_status === 'waived') mapped = 'waived';
    // 'cancelled' on the document request side is left alone — evidence
    // status is a manager decision, not silently reset by a cancellation.

    if (mapped !== item.status && item.status !== 'verified') {
        const { data: updated } = await supabase.from('practice_secretarial_evidence_items')
            .update({ status: mapped, updated_at: new Date().toISOString() }).eq('id', item.id).eq('company_id', cid).select().single();
        if (updated) {
            await _writeEvent(cid, null, 'item', item.id, 'item_status_synced', item.status, mapped, null, 'Synced from linked document request', { document_request_id: item.linked_document_request_id });
            return updated;
        }
    }
    return item;
}

// ─── Evidence Engine ────────────────────────────────────────────────────────────

function _computeItemDone(item) {
    if (item.status === 'waived') return true;
    if (item.verification_required) return item.status === 'verified';
    return ITEM_DONE_STATUSES_NO_VERIFICATION.includes(item.status);
}

function _computeReadinessFromItems(items) {
    const required = items.filter(i => i.required);
    if (!required.length) return { score: 0, status: 'unknown', done_count: 0, required_count: 0, blocked_count: 0 };

    const blocked = required.filter(i => i.status === 'blocked');
    const done = required.filter(_computeItemDone);
    const score = Math.round((done.length / required.length) * 1000) / 10;

    let status;
    if (blocked.length) status = 'blocked';
    else if (score >= 85) status = 'ready';
    else if (score >= 50) status = 'partial';
    else status = 'incomplete';

    return { score, status, done_count: done.length, required_count: required.length, blocked_count: blocked.length };
}

// The evidence engine's single entry point for "is this checklist's evidence
// complete." For bo_verification, delegates entirely to Beneficial
// Ownership's own readiness (never re-tracked here — see module header).
async function getChecklistReadiness(cid, checklist) {
    if (checklist.source_type === 'bo_verification') {
        const profile = await beneficialOwnership.getBeneficialOwnershipProfile(cid, checklist.client_id);
        return profile ? { ...profile.readiness, delegated_to: 'beneficial_ownership' } : { score: 0, status: 'unknown', delegated_to: 'beneficial_ownership' };
    }
    const { data: items } = await supabase.from('practice_secretarial_evidence_items').select('*').eq('company_id', cid).eq('checklist_id', checklist.id);
    const synced = await Promise.all((items || []).map(i => _syncItemFromDocumentRequest(cid, i)));
    return { ..._computeReadinessFromItems(synced), items: synced };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

// Extracted so Management Dashboard (Codebox 67) can reuse this exact
// aggregation directly instead of re-deriving checklist readiness a second
// time — same reuse precedent as buildStatutoryCalendar()/getBeneficialOwnershipProfile().
async function getEvidenceSummary(cid) {
    const [checklistsRes, itemsRes] = await Promise.all([
        supabase.from('practice_secretarial_evidence_checklists').select('id, client_id, source_type').eq('company_id', cid),
        supabase.from('practice_secretarial_evidence_items').select('checklist_id, status, required').eq('company_id', cid),
    ]);
    const checklists = checklistsRes.data || [];
    const itemsByChecklist = {};
    (itemsRes.data || []).forEach(i => { if (!itemsByChecklist[i.checklist_id]) itemsByChecklist[i.checklist_id] = []; itemsByChecklist[i.checklist_id].push(i); });

    const counts = { ready: 0, partial: 0, incomplete: 0, blocked: 0, unknown: 0 };
    let boCount = 0;
    for (const c of checklists) {
        if (c.source_type === 'bo_verification') { boCount++; continue; } // delegated — not double-counted here, see BO's own summary
        const r = _computeReadinessFromItems(itemsByChecklist[c.id] || []);
        counts[r.status]++;
    }

    return {
        checklists_total: checklists.length,
        checklists_by_readiness: counts,
        bo_delegated_checklists: boCount,
        items_total: (itemsRes.data || []).length,
    };
}

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        res.json(await getEvidenceSummary(cid));
    } catch (err) {
        console.error('Secretarial-evidence /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/templates', async (req, res) => {
    const cid = req.companyId;
    try {
        await _ensureDefaultTemplates(cid, req.user?.userId);
        const { data, error } = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('company_id', cid).order('template_type');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ templates: data || [] });
    } catch (err) {
        console.error('Secretarial-evidence GET templates error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/templates', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { template_type, template_name, description, required_evidence, notes } = req.body;
    if (!TEMPLATE_TYPES.includes(template_type)) return res.status(400).json({ error: 'Invalid template_type' });
    if (!template_name) return res.status(400).json({ error: 'template_name is required' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_templates').insert({
            company_id: cid, template_type, template_name, description: description || null,
            required_evidence: Array.isArray(required_evidence) ? required_evidence : [],
            notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, null, 'template', data.id, 'template_created', null, null, req.user.userId, template_name, {});
        res.status(201).json({ template: data });
    } catch (err) {
        console.error('Secretarial-evidence POST templates error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/templates/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });
    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: data });
    } catch (err) {
        console.error('Secretarial-evidence GET template error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/templates/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Template not found' });

    const allowed = ['template_name', 'description', 'required_evidence', 'is_active', 'notes', 'settings'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_templates').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.is_active === false ? 'template_archived' : 'template_updated';
        await _writeEvent(cid, null, 'template', id, eventType, null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ template: data });
    } catch (err) {
        console.error('Secretarial-evidence PUT template error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/templates/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Template not found' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_templates')
            .update({ is_active: false, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, null, 'template', id, 'template_archived', null, null, req.user.userId, req.body.reason || null, {});
        res.json({ template: data });
    } catch (err) {
        console.error('Secretarial-evidence DELETE template error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECKLISTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/checklists', async (req, res) => {
    const cid = req.companyId;
    const { client_id, source_type } = req.query;
    try {
        let q = supabase.from('practice_secretarial_evidence_checklists').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (source_type) q = q.eq('source_type', source_type);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(c => c.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        const withReadiness = await Promise.all((data || []).map(async c => ({ ...c, client_name: nameById[c.client_id] || null, readiness: await getChecklistReadiness(cid, c) })));
        res.json({ checklists: withReadiness });
    } catch (err) {
        console.error('Secretarial-evidence GET checklists error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/checklists/generate', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, source_type, source_id, template_id, title } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!SOURCE_TYPES.includes(source_type)) return res.status(400).json({ error: 'Invalid source_type' });
    if (source_type !== 'manual' && !source_id) return res.status(400).json({ error: 'source_id is required unless source_type is manual' });

    try {
        if (source_id) {
            const { data: dup } = await supabase.from('practice_secretarial_evidence_checklists').select('id').eq('company_id', cid).eq('source_type', source_type).eq('source_id', source_id).maybeSingle();
            if (dup) return res.status(400).json({ error: `A checklist already exists for this ${source_type} (id ${dup.id}). Use /checklists/${dup.id}/regenerate to add any missing items.` });
        }

        await _ensureDefaultTemplates(cid, req.user.userId);
        const templateType = template_id ? null : await _resolveTemplateTypeFromSource(cid, source_type, source_id);
        let template;
        if (template_id) {
            const { data } = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('id', template_id).eq('company_id', cid).maybeSingle();
            template = data;
        } else {
            const { data } = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('company_id', cid).eq('template_type', templateType).eq('is_active', true).maybeSingle();
            template = data;
        }
        if (!template) return res.status(404).json({ error: 'No matching evidence template found (and none could be resolved automatically).' });

        const { data: checklist, error } = await supabase.from('practice_secretarial_evidence_checklists').insert({
            company_id: cid, client_id: clientId, source_type, source_id: source_id || null, template_id: template.id,
            title: title || template.template_name, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, clientId, 'checklist', checklist.id, 'checklist_generated', null, null, req.user.userId, checklist.title, { source_type, template_type: template.template_type });

        let items = [];
        if (source_type === 'bo_verification' || template.template_type === 'beneficial_ownership') {
            // Delegated — no items created here. See module header.
            await beneficialOwnership.generateReadinessItems(cid, clientId, req.user.userId);
        } else {
            const rows = (template.required_evidence || []).map(ev => ({
                company_id: cid, checklist_id: checklist.id, evidence_type: ev.evidence_type, item_name: ev.item_name,
                required: ev.required !== false, verification_required: !!ev.verification_required, status: 'waiting',
                created_by: req.user.userId,
            }));
            if (rows.length) {
                const { data: createdItems, error: itemsError } = await supabase.from('practice_secretarial_evidence_items').insert(rows).select();
                if (itemsError) return res.status(500).json({ error: itemsError.message });
                items = createdItems;
                await Promise.all(items.map(it => _writeEvent(cid, clientId, 'item', it.id, 'item_created', null, it.status, req.user.userId, it.item_name, {})));
            }
        }

        res.status(201).json({ checklist, items });
    } catch (err) {
        console.error('Secretarial-evidence generate checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/checklists/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist ID' });
    try {
        const { data: checklist, error } = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!checklist) return res.status(404).json({ error: 'Checklist not found' });

        const readiness = await getChecklistReadiness(cid, checklist);
        res.json({ checklist, readiness });
    } catch (err) {
        console.error('Secretarial-evidence GET checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/checklists/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Checklist not found' });

    const allowed = ['title', 'notes', 'internal_notes', 'settings'];
    const update = _pick(req.body, allowed);
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_checklists').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'checklist', id, 'checklist_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ checklist: data });
    } catch (err) {
        console.error('Secretarial-evidence PUT checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/checklists/:id/regenerate', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });

    try {
        if (checklist.source_type === 'bo_verification' || !checklist.template_id) {
            if (checklist.source_type === 'bo_verification') {
                const created = await beneficialOwnership.generateReadinessItems(cid, checklist.client_id, req.user.userId);
                await _writeEvent(cid, checklist.client_id, 'checklist', id, 'checklist_regenerated', null, null, req.user.userId, null, { delegated: 'beneficial_ownership', created_count: (created || []).length });
                return res.json({ checklist, created_count: (created || []).length });
            }
            return res.status(400).json({ error: 'This checklist has no template to regenerate from.' });
        }

        const { data: template } = await supabase.from('practice_secretarial_evidence_templates').select('*').eq('id', checklist.template_id).eq('company_id', cid).maybeSingle();
        if (!template) return res.status(404).json({ error: 'Template not found' });

        const { data: existingItems } = await supabase.from('practice_secretarial_evidence_items').select('evidence_type').eq('company_id', cid).eq('checklist_id', id);
        const existingTypes = new Set((existingItems || []).map(i => i.evidence_type));

        const rows = (template.required_evidence || [])
            .filter(ev => !existingTypes.has(ev.evidence_type))
            .map(ev => ({
                company_id: cid, checklist_id: id, evidence_type: ev.evidence_type, item_name: ev.item_name,
                required: ev.required !== false, verification_required: !!ev.verification_required, status: 'waiting',
                created_by: req.user.userId,
            }));

        let created = [];
        if (rows.length) {
            const { data, error } = await supabase.from('practice_secretarial_evidence_items').insert(rows).select();
            if (error) return res.status(500).json({ error: error.message });
            created = data;
            await Promise.all(created.map(it => _writeEvent(cid, checklist.client_id, 'item', it.id, 'item_created', null, it.status, req.user.userId, it.item_name, {})));
        }
        await _writeEvent(cid, checklist.client_id, 'checklist', id, 'checklist_regenerated', null, null, req.user.userId, null, { created_count: created.length });

        res.json({ checklist, created_count: created.length, created });
    } catch (err) {
        console.error('Secretarial-evidence regenerate error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/checklists/:id/sync', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist ID' });

    const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });

    try {
        const readiness = await getChecklistReadiness(cid, checklist);
        res.json({ readiness });
    } catch (err) {
        console.error('Secretarial-evidence sync error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ITEMS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/checklists/:id/items', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist ID' });
    try {
        const { data: items, error } = await supabase.from('practice_secretarial_evidence_items').select('*').eq('company_id', cid).eq('checklist_id', id).order('created_at');
        if (error) return res.status(500).json({ error: error.message });
        const synced = await Promise.all((items || []).map(i => _syncItemFromDocumentRequest(cid, i)));
        res.json({ items: synced });
    } catch (err) {
        console.error('Secretarial-evidence GET items error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/items/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Evidence item not found' });

    const allowed = ['item_name', 'required', 'verification_required', 'status', 'reviewer_team_member_id', 'verification_notes', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.status && !ITEM_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_items').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('client_id').eq('id', existing.data.checklist_id).maybeSingle();
        await _writeEvent(cid, checklist?.client_id, 'item', id, 'item_updated', existing.data.status, data.status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ item: data });
    } catch (err) {
        console.error('Secretarial-evidence PUT item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/items/:id/link-document-request', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Evidence item not found' });

    const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('client_id').eq('id', existing.data.checklist_id).maybeSingle();
    const { document_request_id } = req.body;
    if (!document_request_id) return res.status(400).json({ error: 'document_request_id is required' });

    const { data: docReq } = await supabase.from('practice_document_requests').select('id, client_id').eq('id', document_request_id).eq('company_id', cid).maybeSingle();
    if (!docReq || docReq.client_id !== checklist?.client_id) return res.status(400).json({ error: 'document_request_id does not belong to this checklist\'s client.' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_items')
            .update({ linked_document_request_id: document_request_id, status: 'requested', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, checklist?.client_id, 'item', id, 'item_updated', existing.data.status, data.status, req.user.userId, 'Linked to existing document request', { document_request_id });
        res.json({ item: data });
    } catch (err) {
        console.error('Secretarial-evidence link-document-request error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/items/:id/create-document-request', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Evidence item not found' });
    if (existing.data.linked_document_request_id) return res.status(400).json({ error: 'This item is already linked to a document request.' });

    const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('client_id').eq('id', existing.data.checklist_id).maybeSingle();
    if (!checklist) return res.status(404).json({ error: 'Checklist not found' });

    try {
        const documentRequestId = await _createLinkedDocumentRequest(cid, checklist.client_id, { item_name: existing.data.item_name, recommended_document_category: req.body.document_category }, req.user.userId);

        const { data, error } = await supabase.from('practice_secretarial_evidence_items')
            .update({ linked_document_request_id: documentRequestId, status: 'requested', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, checklist.client_id, 'item', id, 'item_updated', existing.data.status, data.status, req.user.userId, 'Created and linked a new document request', { document_request_id: documentRequestId });
        res.status(201).json({ item: data, document_request_id: documentRequestId });
    } catch (err) {
        console.error('Secretarial-evidence create-document-request error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/items/:id/verify', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Evidence item not found' });
    if (!['received', 'requested'].includes(existing.data.status)) return res.status(400).json({ error: `Cannot verify from status "${existing.data.status}" — evidence must be received first.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_items')
            .update({ status: 'verified', reviewer_team_member_id: member.id, verification_notes: req.body.verification_notes || null, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('client_id').eq('id', existing.data.checklist_id).maybeSingle();
        await _writeEvent(cid, checklist?.client_id, 'item', id, 'item_verified', existing.data.status, 'verified', req.user.userId, req.body.verification_notes || null, {});
        res.json({ item: data });
    } catch (err) {
        console.error('Secretarial-evidence verify item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/items/:id/waive', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_evidence_items').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Evidence item not found' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to waive an evidence item' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_items')
            .update({ status: 'waived', notes: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const { data: checklist } = await supabase.from('practice_secretarial_evidence_checklists').select('client_id').eq('id', existing.data.checklist_id).maybeSingle();
        await _writeEvent(cid, checklist?.client_id, 'item', id, 'item_waived', existing.data.status, 'waived', req.user.userId, req.body.reason, {});
        res.json({ item: data });
    } catch (err) {
        console.error('Secretarial-evidence waive item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { client_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_evidence_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-evidence GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const sourceType = req.params.sourceType;
    const sourceId = parseInt(req.params.sourceId);
    if (!['template', 'checklist', 'item'].includes(sourceType)) return res.status(400).json({ error: 'Invalid sourceType' });
    if (!sourceId) return res.status(400).json({ error: 'Invalid sourceId' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_evidence_events').select('*')
            .eq('company_id', cid).eq('source_type', sourceType).eq('source_id', sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-evidence GET source events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/66_secretarial_evidence.md
module.exports.getChecklistReadiness = getChecklistReadiness;
module.exports.getEvidenceSummary = getEvidenceSummary;
