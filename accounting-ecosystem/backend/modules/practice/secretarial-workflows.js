'use strict';

// Codebox 63 — Practice Secretarial Workflows + Statutory Change Management
// Turns Secretarial (Codebox 62) from registers into controlled statutory
// change management. "Every statutory change is controlled" — NOT "anyone
// can edit the register."
//
// NOT CIPC API. NOT automatic CIPC filing. NOT document generation. NOT
// e-signatures. A manual internal workflow foundation — future CIPC
// integration must plug into this workflow, not replace it.
//
// THE CONTROL POINT: Codebox 62's registers (practice_company_directors,
// practice_company_shareholders, practice_secretarial_profiles,
// practice_annual_returns) are never edited through THIS module except via
// PUT /:id/implement, which is itself gated on case_status = 'approved'.
// secretarial.html's own direct-edit routes (Codebox 62) remain available
// for corrections/administration — this module adds a controlled path
// alongside them, it does not remove the foundation's own CRUD.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const secretarial = require('./secretarial');
const { notify } = require('./notifications');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const CHANGE_TYPES = [
    'director_appointment', 'director_resignation',
    'share_transfer', 'share_issue', 'share_cancellation',
    'registered_address_change', 'postal_address_change',
    'company_name_change', 'financial_year_end_change',
    'company_secretary_change', 'auditor_change',
    'accounting_officer_change', 'public_officer_change',
    'company_status_change', 'annual_return', 'custom',
];
const CASE_STATUSES = ['draft', 'preparing', 'awaiting_documents', 'ready_for_review', 'approved', 'implemented', 'completed', 'rejected', 'cancelled'];
const CHECKLIST_ITEM_TYPES = ['document', 'approval', 'register_update', 'cipc_step', 'client_confirmation', 'internal_review', 'resolution', 'minute', 'custom'];
const COMPANY_STATUSES = ['active', 'dormant', 'deregistration_process', 'deregistered', 'in_liquidation', 'other'];

const TERMINAL_STATUSES = ['completed', 'rejected', 'cancelled'];
const PRE_REVIEW_STATUSES = ['draft', 'preparing', 'awaiting_documents'];

// ── Checklist defaults per change_type ──────────────────────────────────────────
// Five sets exactly as specified. The rest are a deliberate, sensible-minimal
// extension under "Architect Freedom" (spec: "Custom: no defaults unless
// developer adds sensible minimal items") — a generic 4-item set covering
// approval/register/CIPC/client-confirmation for change types the spec
// didn't give an explicit checklist for. 'custom' gets none, as specified.

function _item(name, type) { return { item_name: name, item_type: type }; }

const CHECKLIST_DEFAULTS = {
    director_appointment: [
        _item('Signed consent', 'document'),
        _item('ID document', 'document'),
        _item('Resolution', 'resolution'),
        _item('Update director register', 'register_update'),
        _item('CIPC filing step', 'cipc_step'),
        _item('Client confirmation', 'client_confirmation'),
    ],
    director_resignation: [
        _item('Resignation letter', 'document'),
        _item('Resolution/minute', 'minute'),
        _item('Update director register', 'register_update'),
        _item('CIPC filing step', 'cipc_step'),
        _item('Client confirmation', 'client_confirmation'),
    ],
    share_transfer: [
        _item('Transfer agreement', 'document'),
        _item('Share certificate review', 'internal_review'),
        _item('Resolution', 'resolution'),
        _item('Update securities/shareholder register', 'register_update'),
        _item('Client confirmation', 'client_confirmation'),
    ],
    registered_address_change: [
        _item('Proof of address', 'document'),
        _item('Resolution/approval', 'approval'),
        _item('Update registered office register', 'register_update'),
        _item('CIPC filing step', 'cipc_step'),
        _item('Client confirmation', 'client_confirmation'),
    ],
    annual_return: [
        _item('Turnover confirmation', 'client_confirmation'),
        _item('CIPC fee check', 'internal_review'),
        _item('Submit annual return', 'cipc_step'),
        _item('Beneficial ownership check', 'internal_review'),
        _item('Client confirmation', 'client_confirmation'),
    ],
    custom: [],
};
// "Address Change" in the spec covers both registered and postal address —
// reuse the same default set for postal_address_change.
CHECKLIST_DEFAULTS.postal_address_change = CHECKLIST_DEFAULTS.registered_address_change;

// Generic sensible-minimal set for change types the spec didn't enumerate
// explicit checklists for (Architect Freedom — see migration 120 header).
const GENERIC_DEFAULTS = [
    _item('Resolution/approval', 'approval'),
    _item('Update register', 'register_update'),
    _item('CIPC filing step', 'cipc_step'),
    _item('Client confirmation', 'client_confirmation'),
];
['share_issue', 'share_cancellation', 'company_name_change', 'financial_year_end_change',
 'company_secretary_change', 'auditor_change', 'accounting_officer_change',
 'public_officer_change', 'company_status_change'].forEach(t => { CHECKLIST_DEFAULTS[t] = GENERIC_DEFAULTS; });

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage statutory change cases.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name')
        .eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _getCase(cid, id) {
    const { data } = await supabase.from('practice_secretarial_change_cases').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeCaseEvent(cid, caseId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_secretarial_change_events').insert({
        company_id: cid, change_case_id: caseId, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// ── Register-update implementations ─────────────────────────────────────────────
// Each returns { error } (blocks the implement with 422, register untouched)
// or { success: true, before, after, timelineEvent }. Never guesses — a
// missing/ambiguous required payload field is always an { error }, never a
// best-effort default. See migration 120 header + docs Architect Freedom.

async function _implDirectorAppointment(cid, clientId, payload) {
    const { director_name, role, appointment_date, id_or_passport_number, shareholding_pct, signing_authority } = payload;
    if (!director_name) return { error: 'payload.director_name is required to appoint a director.' };
    const { data, error } = await supabase.from('practice_company_directors').insert({
        company_id: cid, client_id: clientId, director_name,
        role: role || 'executive', appointment_date: appointment_date || null,
        id_or_passport_number: id_or_passport_number || null,
        shareholding_pct: shareholding_pct != null ? parseFloat(shareholding_pct) : null,
        signing_authority: !!signing_authority, status: 'active',
    }).select().single();
    if (error) return { error: error.message };
    return { success: true, before: null, after: data, timelineEvent: { event_type: 'director_appointed', entity_type: 'director', entity_id: data.id, notes: director_name } };
}

async function _implDirectorResignation(cid, clientId, payload, effectiveDate) {
    const { director_id } = payload;
    if (!director_id) return { error: 'payload.director_id is required to resign a director (identifies which existing director record to update).' };
    const { data: existing } = await supabase.from('practice_company_directors').select('*').eq('id', director_id).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (!existing) return { error: 'payload.director_id does not match an existing director for this client.' };
    const { data, error } = await supabase.from('practice_company_directors')
        .update({ status: 'resigned', resignation_date: effectiveDate || today(), updated_at: new Date().toISOString() })
        .eq('id', director_id).select().single();
    if (error) return { error: error.message };
    return { success: true, before: existing, after: data, timelineEvent: { event_type: 'director_resigned', entity_type: 'director', entity_id: data.id, notes: existing.director_name } };
}

async function _implShareTransfer(cid, clientId, payload, effectiveDate) {
    const { shareholder_id } = payload;
    if (!shareholder_id) {
        // Safer alternative explicitly offered by the spec: don't guess which
        // shareholder row this refers to — record the event, skip the mutation.
        return {
            success: true, before: null, after: null, skippedMutation: true,
            timelineEvent: { event_type: 'company_detail_changed', entity_type: 'shareholder', entity_id: null,
                notes: 'Share transfer case implemented without an automatic register update — no shareholder_id in payload. Update the Shareholder register manually.' },
        };
    }
    const { data: existing } = await supabase.from('practice_company_shareholders').select('*').eq('id', shareholder_id).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (!existing) return { error: 'payload.shareholder_id does not match an existing shareholder for this client.' };
    const { data, error } = await supabase.from('practice_company_shareholders')
        .update({ status: 'transferred', transfer_date: effectiveDate || today(), updated_at: new Date().toISOString() })
        .eq('id', shareholder_id).select().single();
    if (error) return { error: error.message };
    return { success: true, before: existing, after: data, timelineEvent: { event_type: 'share_transferred', entity_type: 'shareholder', entity_id: data.id, notes: existing.shareholder_name } };
}

function _implProfileField(field, label) {
    return async function (cid, clientId, payload) {
        const value = payload[field];
        if (value == null || value === '') return { error: `payload.${field} is required.` };
        const before = await secretarial.getOrInitProfile(cid, clientId);
        const { data, error } = await supabase.from('practice_secretarial_profiles')
            .update({ [field]: value, updated_at: new Date().toISOString() }).eq('company_id', cid).eq('client_id', clientId).select().single();
        if (error) return { error: error.message };
        return { success: true, before, after: data, timelineEvent: { event_type: 'company_detail_changed', entity_type: 'profile', entity_id: data.id, notes: `${label} updated` } };
    };
}

async function _implCompanyStatusChange(cid, clientId, payload) {
    const { company_status } = payload;
    if (!company_status || !COMPANY_STATUSES.includes(company_status)) return { error: 'payload.company_status is required and must be a valid status.' };
    const before = await secretarial.getOrInitProfile(cid, clientId);
    const { data, error } = await supabase.from('practice_secretarial_profiles')
        .update({ company_status, updated_at: new Date().toISOString() }).eq('company_id', cid).eq('client_id', clientId).select().single();
    if (error) return { error: error.message };
    return { success: true, before, after: data, timelineEvent: { event_type: 'company_detail_changed', entity_type: 'profile', entity_id: data.id, notes: `Company status changed to ${company_status}` } };
}

async function _implAnnualReturn(cid, clientId, payload) {
    const { return_year, due_date, submission_date, status, reference } = payload;
    if (!return_year) return { error: 'payload.return_year is required.' };
    const { data: existing } = await supabase.from('practice_annual_returns').select('*').eq('company_id', cid).eq('client_id', clientId).eq('return_year', parseInt(return_year)).maybeSingle();
    const body = {
        company_id: cid, client_id: clientId, return_year: parseInt(return_year),
        due_date: due_date || existing?.due_date || null,
        submission_date: submission_date || existing?.submission_date || null,
        status: status || existing?.status || 'pending',
        reference: reference || existing?.reference || null,
        updated_at: new Date().toISOString(),
    };
    let data, error;
    if (existing) {
        ({ data, error } = await supabase.from('practice_annual_returns').update(body).eq('id', existing.id).select().single());
    } else {
        ({ data, error } = await supabase.from('practice_annual_returns').insert(body).select().single());
    }
    if (error) return { error: error.message };
    return { success: true, before: existing || null, after: data, timelineEvent: { event_type: existing ? 'annual_return_updated' : 'annual_return_created', entity_type: 'annual_return', entity_id: data.id, notes: `Year ${return_year}` } };
}

// The definitive, single source of truth for which change_types are safe to
// auto-implement. Anything NOT in this map always blocks PUT /:id/implement
// with 422 unless the caller explicitly passes manual=true (see route) — no
// silent guessing, ever. See migration 120 header for why company_name_change,
// financial_year_end_change, accounting_officer_change, public_officer_change,
// share_issue, and share_cancellation are deliberately absent.
const IMPLEMENTATION_RULES = {
    director_appointment: _implDirectorAppointment,
    director_resignation: _implDirectorResignation,
    share_transfer: _implShareTransfer,
    registered_address_change: _implProfileField('registered_address', 'Registered address'),
    postal_address_change: _implProfileField('postal_address', 'Postal address'),
    company_secretary_change: _implProfileField('company_secretary', 'Company secretary'),
    auditor_change: _implProfileField('auditor', 'Auditor'),
    company_status_change: _implCompanyStatusChange,
    annual_return: _implAnnualReturn,
};

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases').select('case_status, change_type, effective_date').eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });

        const statusCounts = {};
        CASE_STATUSES.forEach(s => { statusCounts[s] = 0; });
        const t = today();
        let overdueEffective = 0;
        for (const c of (data || [])) {
            if (c.case_status in statusCounts) statusCounts[c.case_status]++;
            if (['approved'].includes(c.case_status) && c.effective_date && c.effective_date < t) overdueEffective++;
        }

        res.json({
            total: (data || []).length,
            by_status: statusCounts,
            active: (data || []).filter(c => !TERMINAL_STATUSES.includes(c.case_status)).length,
            approved_awaiting_implementation: statusCounts.approved,
            overdue_for_implementation: overdueEffective,
        });
    } catch (err) {
        console.error('Secretarial-workflows /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CASE LIST / DETAIL / CRUD
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { client_id, change_type, case_status, effective_from, effective_to, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_change_cases').select('*', { count: 'exact' }).eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (change_type) q = q.eq('change_type', change_type);
        if (case_status) q = q.eq('case_status', case_status);
        if (effective_from) q = q.gte('effective_date', effective_from);
        if (effective_to) q = q.lte('effective_date', effective_to);

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);
        const from = (pageNum - 1) * limitNum;
        q = q.range(from, from + limitNum - 1);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(c => c.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }

        res.json({ cases: (data || []).map(c => ({ ...c, client_name: nameById[c.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Secretarial-workflows GET / error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    try {
        const kase = await _getCase(cid, id);
        if (!kase) return res.status(404).json({ error: 'Change case not found' });

        const [client, checklist] = await Promise.all([
            supabase.from('practice_clients').select('id, name').eq('id', kase.client_id).eq('company_id', cid).maybeSingle(),
            supabase.from('practice_secretarial_change_checklist_items').select('*').eq('company_id', cid).eq('change_case_id', id).order('sort_order'),
        ]);

        res.json({ case: kase, client: client.data || null, checklist: checklist.data || [] });
    } catch (err) {
        console.error('Secretarial-workflows GET /:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, change_type, change_title, change_summary, requested_by_name, requested_date, effective_date, payload, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!CHANGE_TYPES.includes(change_type)) return res.status(400).json({ error: 'Invalid change_type' });
    if (!change_title) return res.status(400).json({ error: 'change_title is required' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases').insert({
            company_id: cid, client_id: clientId, change_type, change_title,
            change_summary: change_summary || null, requested_by_name: requested_by_name || null,
            requested_date: requested_date || null, effective_date: effective_date || null,
            payload: payload || {}, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, data.id, 'change_case_created', null, data.case_status, req.user.userId, change_title, { change_type });
        res.status(201).json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows POST / error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _getCase(cid, id);
    if (!existing) return res.status(404).json({ error: 'Change case not found' });
    if (TERMINAL_STATUSES.includes(existing.case_status)) return res.status(400).json({ error: `Cannot edit a case that is already ${existing.case_status}.` });

    const allowed = ['change_title', 'change_summary', 'requested_by_name', 'requested_date', 'effective_date', 'payload', 'notes', 'internal_notes', 'settings', 'case_status'];
    const update = _pick(req.body, allowed);
    if (update.case_status) {
        if (!PRE_REVIEW_STATUSES.includes(update.case_status)) return res.status(400).json({ error: 'PUT /:id may only move case_status between draft/preparing/awaiting_documents. Use the dedicated action endpoints (submit-review/approve/reject/implement/complete) for workflow transitions.' });
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_case_updated', existing.case_status, data.case_status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows PUT /:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Soft cancel only — never a real delete.
router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _getCase(cid, id);
    if (!existing) return res.status(404).json({ error: 'Change case not found' });
    if (existing.case_status === 'completed') return res.status(400).json({ error: 'Cannot cancel a completed case.' });
    if (existing.case_status === 'cancelled') return res.status(400).json({ error: 'Case is already cancelled.' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({ case_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_cancelled', existing.case_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows DELETE /:id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:id/generate-checklist', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });

    try {
        const { count } = await supabase.from('practice_secretarial_change_checklist_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('change_case_id', id);
        if (count > 0 && req.query.force !== 'true') {
            return res.status(400).json({ error: 'Checklist already generated for this case. Pass ?force=true to regenerate (existing items are kept; this only adds any missing defaults is not supported — force clears and rebuilds).' });
        }
        if (count > 0 && req.query.force === 'true') {
            await supabase.from('practice_secretarial_change_checklist_items').delete().eq('company_id', cid).eq('change_case_id', id);
        }

        const defaults = CHECKLIST_DEFAULTS[kase.change_type] || [];
        if (!defaults.length) {
            return res.json({ checklist: [], message: `No default checklist for change_type "${kase.change_type}" — add items manually.` });
        }

        const rows = defaults.map((d, i) => ({
            company_id: cid, change_case_id: id, item_name: d.item_name, item_type: d.item_type,
            required: true, sort_order: i,
        }));
        const { data, error } = await supabase.from('practice_secretarial_change_checklist_items').insert(rows).select();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'checklist_generated', kase.case_status, kase.case_status, req.user.userId, null, { count: data.length });
        res.status(201).json({ checklist: data });
    } catch (err) {
        console.error('Secretarial-workflows generate-checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id/checklist', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });
    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_checklist_items').select('*').eq('company_id', cid).eq('change_case_id', id).order('sort_order');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ checklist: data || [] });
    } catch (err) {
        console.error('Secretarial-workflows GET checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/checklist/:itemId', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    if (!id || !itemId) return res.status(400).json({ error: 'Invalid case or item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });

    const existing = await supabase.from('practice_secretarial_change_checklist_items').select('*').eq('id', itemId).eq('change_case_id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Checklist item not found' });

    const allowed = ['item_name', 'item_type', 'required', 'completed', 'notes', 'sort_order'];
    const update = _pick(req.body, allowed);
    if (update.item_type && !CHECKLIST_ITEM_TYPES.includes(update.item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (update.completed === true && !existing.data.completed) { update.completed_at = new Date().toISOString(); update.completed_by = req.user.userId; }
    if (update.completed === false) { update.completed_at = null; update.completed_by = null; }
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_checklist_items').update(update).eq('id', itemId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'checklist_item_updated', kase.case_status, kase.case_status, req.user.userId, existing.data.item_name, { completed: data.completed });
        res.json({ item: data });
    } catch (err) {
        console.error('Secretarial-workflows PUT checklist item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });
    if (!PRE_REVIEW_STATUSES.includes(kase.case_status)) return res.status(400).json({ error: `Cannot submit for review from status "${kase.case_status}".` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({ case_status: 'ready_for_review', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'submitted_for_review', kase.case_status, 'ready_for_review', req.user.userId, null, {});
        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows submit-review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });
    if (kase.case_status !== 'ready_for_review') return res.status(400).json({ error: `Cannot approve from status "${kase.case_status}" — case must be ready_for_review.` });

    const { override_reason } = req.body;

    try {
        const { data: checklist } = await supabase.from('practice_secretarial_change_checklist_items').select('required, completed').eq('company_id', cid).eq('change_case_id', id);
        const incomplete = (checklist || []).filter(i => i.required && !i.completed);
        if (incomplete.length && !override_reason) {
            return res.status(400).json({ error: `${incomplete.length} required checklist item(s) incomplete. Provide override_reason to approve anyway.`, incomplete_count: incomplete.length });
        }

        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({ case_status: 'approved', approved_by: req.user.userId, approved_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_approved', kase.case_status, 'approved', req.user.userId, override_reason || null, { checklist_override: !!(incomplete.length && override_reason) });

        notify({
            cid, notificationKey: `secretarial_change_approved_${id}`,
            title: `Statutory change approved: ${kase.change_title}`,
            message: 'Ready for implementation.',
            category: 'compliance', severity: 'medium', sourceModule: 'secretarial-workflows', sourceType: 'change_case', sourceId: id,
            createdBy: req.user.userId, assignment: { role: 'owner', clientId: kase.client_id },
        }).catch(() => {});

        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows approve error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/reject', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });
    if (TERMINAL_STATUSES.includes(kase.case_status) || kase.case_status === 'implemented') return res.status(400).json({ error: `Cannot reject a case that is already ${kase.case_status}.` });

    const { rejection_reason } = req.body;
    if (!rejection_reason) return res.status(400).json({ error: 'rejection_reason is required' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({ case_status: 'rejected', rejection_reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_rejected', kase.case_status, 'rejected', req.user.userId, rejection_reason, {});
        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows reject error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/implement', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });
    if (kase.case_status !== 'approved') return res.status(400).json({ error: `Cannot implement from status "${kase.case_status}" — case must be approved.` });

    const effectiveDate = req.body.effective_date || kase.effective_date;
    if (!effectiveDate) return res.status(400).json({ error: 'effective_date is required (on the case or in this request) before implementation.' });

    const mergedPayload = Object.assign({}, kase.payload || {}, req.body.payload || {});
    const manual = req.body.manual === true || !IMPLEMENTATION_RULES[kase.change_type];

    try {
        let before = null, after = null, timelineEvent = null, skippedMutation = false;

        if (manual) {
            skippedMutation = true;
            if (!req.body.manual_reason) {
                return res.status(422).json({
                    error: IMPLEMENTATION_RULES[kase.change_type]
                        ? 'manual_reason is required to implement manually.'
                        : `Change type "${kase.change_type}" has no safe automatic register update. Update the relevant register manually, then call this endpoint with manual: true and a manual_reason.`,
                    manual_implementation_required: true,
                });
            }
            after = req.body.after_snapshot || null;
        } else {
            const result = await IMPLEMENTATION_RULES[kase.change_type](cid, kase.client_id, mergedPayload, effectiveDate);
            if (result.error) {
                return res.status(422).json({ error: result.error, manual_implementation_required: true });
            }
            before = result.before;
            after = result.after;
            timelineEvent = result.timelineEvent;
            skippedMutation = !!result.skippedMutation;
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({
                case_status: 'implemented', implemented_by: req.user.userId, implemented_at: now,
                effective_date: effectiveDate, payload: mergedPayload,
                before_snapshot: before, after_snapshot: after,
                updated_by: req.user.userId, updated_at: now,
            })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_implemented', kase.case_status, 'implemented', req.user.userId, manual ? req.body.manual_reason : null, { manual, change_type: kase.change_type });
        if (!manual && !skippedMutation) await _writeCaseEvent(cid, id, 'register_updated', 'implemented', 'implemented', req.user.userId, null, { entity_type: timelineEvent?.entity_type, entity_id: timelineEvent?.entity_id });

        // Push into Secretarial's own Timeline (Codebox 62) — not a second,
        // competing timeline. See secretarial.js's writeSecretarialEvent export.
        const tl = timelineEvent || { event_type: 'company_detail_changed', entity_type: 'change_case', entity_id: id, notes: `Manual implementation: ${req.body.manual_reason}` };
        await secretarial.writeSecretarialEvent(cid, kase.client_id, tl.event_type, tl.entity_type, tl.entity_id, req.user.userId, tl.notes, { change_case_id: id });
        await _writeCaseEvent(cid, id, 'timeline_event_created', 'implemented', 'implemented', req.user.userId, null, { event_type: tl.event_type });

        notify({
            cid, notificationKey: `secretarial_change_implemented_${id}`,
            title: `Statutory change implemented: ${kase.change_title}`,
            message: skippedMutation ? 'Marked implemented — no automatic register update was made.' : 'Register updated.',
            category: 'compliance', severity: 'info', sourceModule: 'secretarial-workflows', sourceType: 'change_case', sourceId: id,
            createdBy: req.user.userId, assignment: { role: 'owner', clientId: kase.client_id },
        }).catch(() => {});

        res.json({ case: data, register_updated: !skippedMutation, skipped_mutation: skippedMutation });
    } catch (err) {
        console.error('Secretarial-workflows implement error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/complete', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });
    if (kase.case_status !== 'implemented') return res.status(400).json({ error: `Cannot complete from status "${kase.case_status}" — case must be implemented.` });

    const { completion_reason } = req.body;
    if (kase.after_snapshot == null && !completion_reason) {
        return res.status(400).json({ error: 'This case has no after_snapshot (manual implementation) — completion_reason is required.' });
    }

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_cases')
            .update({ case_status: 'completed', completed_by: req.user.userId, completed_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeCaseEvent(cid, id, 'change_completed', kase.case_status, 'completed', req.user.userId, completion_reason || null, {});

        notify({
            cid, notificationKey: `secretarial_change_completed_${id}`,
            title: `Statutory change completed: ${kase.change_title}`,
            message: 'Case closed.',
            category: 'compliance', severity: 'info', sourceModule: 'secretarial-workflows', sourceType: 'change_case', sourceId: id,
            createdBy: req.user.userId, assignment: { role: 'owner', clientId: kase.client_id },
        }).catch(() => {});

        res.json({ case: data });
    } catch (err) {
        console.error('Secretarial-workflows complete error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid case ID' });
    const kase = await _getCase(cid, id);
    if (!kase) return res.status(404).json({ error: 'Change case not found' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_change_events').select('*').eq('company_id', cid).eq('change_case_id', id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-workflows GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/63_secretarial_workflows.md
module.exports.CHANGE_TYPES = CHANGE_TYPES;
module.exports.CASE_STATUSES = CASE_STATUSES;
