'use strict';

// Codebox 64 — Secretarial Resolutions + Minutes Register Foundation
// "Here is the governance evidence behind the company record." NOT "here is
// another document folder." Structured governance record keeping — who
// approved what, when, under which authority, which resolution/meeting
// supports it, and which statutory change case (Codebox 63) it links to.
//
// NOT PDF generation. NOT e-signature. NOT CIPC submission. NOT document
// storage. Future PDF/e-signature must plug into these records, not
// replace them.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const secretarial = require('./secretarial');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const RESOLUTION_TYPES = ['directors_resolution', 'shareholders_resolution', 'written_resolution', 'ordinary_resolution', 'special_resolution', 'trustee_resolution', 'member_resolution', 'custom'];
const RESOLUTION_STATUSES = ['draft', 'prepared', 'approved', 'signed', 'implemented', 'archived', 'cancelled'];
const MEETING_TYPES = ['directors_meeting', 'shareholders_meeting', 'annual_general_meeting', 'special_general_meeting', 'trustees_meeting', 'members_meeting', 'custom'];
const MEETING_STATUSES = ['planned', 'held', 'minutes_draft', 'minutes_approved', 'completed', 'cancelled'];
const ATTENDEE_TYPES = ['director', 'shareholder', 'trustee', 'member', 'advisor', 'staff', 'other'];
const ATTENDANCE_STATUSES = ['invited', 'present', 'absent', 'proxy', 'apology'];
const DECISION_TYPES = ['approval', 'rejection', 'instruction', 'noting', 'delegation', 'statutory_change', 'financial', 'governance', 'custom'];
const DECISION_STATUSES = ['draft', 'approved', 'implemented', 'cancelled'];

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage governance records.' });
        return null;
    }
    return member;
}

// No frontend company_id trusted — every linked record is re-verified
// server-side against req.companyId (and, where relevant, the same client_id).

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}
async function _verifyChangeCase(cid, clientId, changeCaseId) {
    if (!changeCaseId) return true;
    const { data } = await supabase.from('practice_secretarial_change_cases').select('id').eq('id', changeCaseId).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    return !!data;
}
async function _verifyMeeting(cid, clientId, meetingId) {
    if (!meetingId) return true;
    const { data } = await supabase.from('practice_secretarial_meetings').select('id').eq('id', meetingId).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    return !!data;
}
async function _verifyResolution(cid, clientId, resolutionId) {
    if (!resolutionId) return true;
    const { data } = await supabase.from('practice_secretarial_resolutions').select('id').eq('id', resolutionId).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    return !!data;
}

async function _writeGovEvent(cid, sourceType, sourceId, clientId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_secretarial_governance_events').insert({
        company_id: cid, source_type: sourceType, source_id: sourceId, client_id: clientId || null,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

// Pushes a governance milestone into Secretarial's EXISTING Timeline
// (practice_secretarial_events, Codebox 62) rather than building a second
// timeline table. That table's event_type enum predates this codebox and
// has no resolution/meeting/decision-specific values, so 'company_detail_changed'
// (the same general-purpose bucket Codebox 63 used for its own non-enumerated
// implementations) is reused, with descriptive notes carrying the specifics.
// Non-fatal — a Timeline push failure must never block the governance action
// that triggered it.
async function _pushTimeline(cid, clientId, notes) {
    try {
        await secretarial.writeSecretarialEvent(cid, clientId, 'company_detail_changed', 'governance', null, null, notes, {});
    } catch (e) { /* non-fatal, see comment above */ }
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [resolutions, meetings, decisions] = await Promise.all([
            supabase.from('practice_secretarial_resolutions').select('resolution_status').eq('company_id', cid),
            supabase.from('practice_secretarial_meetings').select('meeting_status').eq('company_id', cid),
            supabase.from('practice_secretarial_decisions').select('decision_status, follow_up_required, follow_up_due_date').eq('company_id', cid),
        ]);

        const resCounts = {}; RESOLUTION_STATUSES.forEach(s => { resCounts[s] = 0; });
        (resolutions.data || []).forEach(r => { if (r.resolution_status in resCounts) resCounts[r.resolution_status]++; });

        const meetCounts = {}; MEETING_STATUSES.forEach(s => { meetCounts[s] = 0; });
        (meetings.data || []).forEach(m => { if (m.meeting_status in meetCounts) meetCounts[m.meeting_status]++; });

        const decCounts = {}; DECISION_STATUSES.forEach(s => { decCounts[s] = 0; });
        const t = today();
        let followUpsOverdue = 0;
        (decisions.data || []).forEach(d => {
            if (d.decision_status in decCounts) decCounts[d.decision_status]++;
            if (d.follow_up_required && d.follow_up_due_date && d.follow_up_due_date < t && d.decision_status !== 'implemented') followUpsOverdue++;
        });

        res.json({
            resolutions: { total: (resolutions.data || []).length, by_status: resCounts },
            meetings: { total: (meetings.data || []).length, by_status: meetCounts },
            decisions: { total: (decisions.data || []).length, by_status: decCounts, follow_ups_overdue: followUpsOverdue },
        });
    } catch (err) {
        console.error('Secretarial-governance /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTIONS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/resolutions', async (req, res) => {
    const cid = req.companyId;
    const { client_id, change_case_id, resolution_type, resolution_status, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_resolutions').select('*', { count: 'exact' }).eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (change_case_id) q = q.eq('change_case_id', parseInt(change_case_id));
        if (resolution_type) q = q.eq('resolution_type', resolution_type);
        if (resolution_status) q = q.eq('resolution_status', resolution_status);

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);
        const from = (pageNum - 1) * limitNum;
        q = q.range(from, from + limitNum - 1);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(r => r.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }

        res.json({ resolutions: (data || []).map(r => ({ ...r, client_name: nameById[r.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Secretarial-governance GET resolutions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/resolutions', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, change_case_id, resolution_type, resolution_title, resolution_summary, resolution_date, effective_date, prepared_by, reference_number, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!RESOLUTION_TYPES.includes(resolution_type)) return res.status(400).json({ error: 'Invalid resolution_type' });
    if (!resolution_title) return res.status(400).json({ error: 'resolution_title is required' });
    if (change_case_id && !(await _verifyChangeCase(cid, clientId, parseInt(change_case_id)))) return res.status(400).json({ error: 'change_case_id does not belong to this client' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_resolutions').insert({
            company_id: cid, client_id: clientId, change_case_id: change_case_id ? parseInt(change_case_id) : null,
            resolution_type, resolution_title, resolution_summary: resolution_summary || null,
            resolution_date: resolution_date || null, effective_date: effective_date || null,
            prepared_by: prepared_by || null, reference_number: reference_number || null, notes: notes || null,
            created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'resolution', data.id, clientId, 'resolution_created', null, data.resolution_status, req.user.userId, resolution_title, {});
        res.status(201).json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance POST resolutions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/resolutions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });
    try {
        const { data, error } = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Resolution not found' });
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance GET resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/resolutions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Resolution not found' });
    const kase = existing.data;

    const allowed = ['resolution_title', 'resolution_summary', 'resolution_date', 'effective_date', 'prepared_by', 'reference_number', 'notes', 'internal_notes', 'settings', 'resolution_status'];
    const update = _pick(req.body, allowed);

    if (update.resolution_status) {
        const target = update.resolution_status;
        const selfServiceFromAny = ['draft', 'prepared'];
        const isCancel = target === 'cancelled' && !['implemented', 'archived', 'cancelled'].includes(kase.resolution_status);
        const isArchive = target === 'archived' && kase.resolution_status === 'implemented';
        if (!(selfServiceFromAny.includes(target) || isCancel || isArchive)) {
            return res.status(400).json({ error: 'PUT /:id may only set draft/prepared, cancel a non-implemented resolution, or archive an implemented one. Use approve/sign/implement for those transitions.' });
        }
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_resolutions').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.resolution_status === 'cancelled' ? 'resolution_cancelled' : 'resolution_updated';
        await _writeGovEvent(cid, 'resolution', id, kase.client_id, eventType, kase.resolution_status, data.resolution_status, req.user.userId, null, { fields: Object.keys(update) });
        if (update.resolution_status === 'cancelled') await _pushTimeline(cid, kase.client_id, `Resolution cancelled: ${kase.resolution_title}`);
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance PUT resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/resolutions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Resolution not found' });
    if (['implemented', 'archived', 'cancelled'].includes(existing.data.resolution_status)) return res.status(400).json({ error: `Cannot cancel a resolution that is already ${existing.data.resolution_status}.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_resolutions')
            .update({ resolution_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'resolution', id, existing.data.client_id, 'resolution_cancelled', existing.data.resolution_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        await _pushTimeline(cid, existing.data.client_id, `Resolution cancelled: ${existing.data.resolution_title}`);
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance DELETE resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/resolutions/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Resolution not found' });
    if (!['draft', 'prepared'].includes(existing.data.resolution_status)) return res.status(400).json({ error: `Cannot approve from status "${existing.data.resolution_status}".` });

    try {
        const now = new Date().toISOString();
        const { data, error } = await supabase.from('practice_secretarial_resolutions')
            .update({ resolution_status: 'approved', approved_by: req.user.userId, approved_at: now, updated_by: req.user.userId, updated_at: now })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'resolution', id, existing.data.client_id, 'resolution_approved', existing.data.resolution_status, 'approved', req.user.userId, null, {});
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance approve resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/resolutions/:id/sign', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Resolution not found' });
    if (existing.data.resolution_status !== 'approved') return res.status(400).json({ error: `Cannot sign from status "${existing.data.resolution_status}" — resolution must be approved.` });

    try {
        const now = new Date().toISOString();
        const r = existing.data;
        // Structured audit snapshot at the moment of signing — NOT a
        // generated/signed document (no PDF/e-signature here).
        const snapshot = {
            resolution_type: r.resolution_type, resolution_title: r.resolution_title, resolution_summary: r.resolution_summary,
            resolution_date: r.resolution_date, effective_date: r.effective_date,
            approved_by: r.approved_by, approved_at: r.approved_at, signed_at: now,
        };
        const { data, error } = await supabase.from('practice_secretarial_resolutions')
            .update({ resolution_status: 'signed', signed_at: now, content_snapshot: snapshot, updated_by: req.user.userId, updated_at: now })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'resolution', id, r.client_id, 'resolution_signed', r.resolution_status, 'signed', req.user.userId, null, {});
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance sign resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/resolutions/:id/implement', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid resolution ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_resolutions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Resolution not found' });
    if (existing.data.resolution_status !== 'signed') return res.status(400).json({ error: `Cannot implement from status "${existing.data.resolution_status}" — resolution must be signed.` });

    try {
        const now = new Date().toISOString();
        const { data, error } = await supabase.from('practice_secretarial_resolutions')
            .update({ resolution_status: 'implemented', implemented_at: now, updated_by: req.user.userId, updated_at: now })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'resolution', id, existing.data.client_id, 'resolution_implemented', existing.data.resolution_status, 'implemented', req.user.userId, null, {});
        await _pushTimeline(cid, existing.data.client_id, `Resolution implemented: ${existing.data.resolution_title}`);
        res.json({ resolution: data });
    } catch (err) {
        console.error('Secretarial-governance implement resolution error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// MEETINGS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/meetings', async (req, res) => {
    const cid = req.companyId;
    const { client_id, change_case_id, meeting_type, meeting_status, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_meetings').select('*', { count: 'exact' }).eq('company_id', cid).order('meeting_date', { ascending: false, nullsFirst: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (change_case_id) q = q.eq('change_case_id', parseInt(change_case_id));
        if (meeting_type) q = q.eq('meeting_type', meeting_type);
        if (meeting_status) q = q.eq('meeting_status', meeting_status);

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);
        const from = (pageNum - 1) * limitNum;
        q = q.range(from, from + limitNum - 1);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(m => m.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }

        res.json({ meetings: (data || []).map(m => ({ ...m, client_name: nameById[m.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Secretarial-governance GET meetings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/meetings', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, change_case_id, meeting_type, meeting_title, meeting_date, meeting_location, chairperson_name, minute_taker_name, agenda_summary, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!MEETING_TYPES.includes(meeting_type)) return res.status(400).json({ error: 'Invalid meeting_type' });
    if (!meeting_title) return res.status(400).json({ error: 'meeting_title is required' });
    if (change_case_id && !(await _verifyChangeCase(cid, clientId, parseInt(change_case_id)))) return res.status(400).json({ error: 'change_case_id does not belong to this client' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meetings').insert({
            company_id: cid, client_id: clientId, change_case_id: change_case_id ? parseInt(change_case_id) : null,
            meeting_type, meeting_title, meeting_date: meeting_date || null, meeting_location: meeting_location || null,
            chairperson_name: chairperson_name || null, minute_taker_name: minute_taker_name || null,
            agenda_summary: agenda_summary || null, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'meeting', data.id, clientId, 'meeting_created', null, data.meeting_status, req.user.userId, meeting_title, {});
        res.status(201).json({ meeting: data });
    } catch (err) {
        console.error('Secretarial-governance POST meetings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/meetings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });
    try {
        const [meeting, attendees] = await Promise.all([
            supabase.from('practice_secretarial_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle(),
            supabase.from('practice_secretarial_meeting_attendees').select('*').eq('meeting_id', id).eq('company_id', cid).order('attendee_name'),
        ]);
        if (!meeting.data) return res.status(404).json({ error: 'Meeting not found' });
        res.json({ meeting: meeting.data, attendees: attendees.data || [] });
    } catch (err) {
        console.error('Secretarial-governance GET meeting error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/meetings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Meeting not found' });
    const kase = existing.data;

    const allowed = ['meeting_title', 'meeting_date', 'meeting_location', 'chairperson_name', 'minute_taker_name', 'agenda_summary', 'minutes_summary', 'decisions_summary', 'next_meeting_date', 'notes', 'internal_notes', 'settings', 'meeting_status'];
    const update = _pick(req.body, allowed);

    if (update.meeting_status) {
        const target = update.meeting_status;
        const selfService = ['planned', 'minutes_draft'];
        const isCancel = target === 'cancelled' && kase.meeting_status !== 'completed' && kase.meeting_status !== 'cancelled';
        const isComplete = target === 'completed' && kase.meeting_status === 'minutes_approved';
        if (!(selfService.includes(target) || isCancel || isComplete)) {
            return res.status(400).json({ error: 'PUT /:id may only set planned/minutes_draft, cancel a non-completed meeting, or complete one whose minutes are approved. Use mark-held/approve-minutes for those transitions.' });
        }
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_meetings').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.meeting_status === 'cancelled' ? 'meeting_cancelled' : 'meeting_updated';
        await _writeGovEvent(cid, 'meeting', id, kase.client_id, eventType, kase.meeting_status, data.meeting_status, req.user.userId, null, { fields: Object.keys(update) });
        if (update.meeting_status === 'cancelled') await _pushTimeline(cid, kase.client_id, `Meeting cancelled: ${kase.meeting_title}`);
        res.json({ meeting: data });
    } catch (err) {
        console.error('Secretarial-governance PUT meeting error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/meetings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Meeting not found' });
    if (['completed', 'cancelled'].includes(existing.data.meeting_status)) return res.status(400).json({ error: `Cannot cancel a meeting that is already ${existing.data.meeting_status}.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meetings')
            .update({ meeting_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'meeting', id, existing.data.client_id, 'meeting_cancelled', existing.data.meeting_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        await _pushTimeline(cid, existing.data.client_id, `Meeting cancelled: ${existing.data.meeting_title}`);
        res.json({ meeting: data });
    } catch (err) {
        console.error('Secretarial-governance DELETE meeting error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/meetings/:id/mark-held', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Meeting not found' });
    if (existing.data.meeting_status !== 'planned') return res.status(400).json({ error: `Cannot mark held from status "${existing.data.meeting_status}" — meeting must be planned.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meetings')
            .update({ meeting_status: 'held', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'meeting', id, existing.data.client_id, 'meeting_held', existing.data.meeting_status, 'held', req.user.userId, null, {});
        res.json({ meeting: data });
    } catch (err) {
        console.error('Secretarial-governance mark-held error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/meetings/:id/approve-minutes', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meetings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Meeting not found' });
    if (!['held', 'minutes_draft'].includes(existing.data.meeting_status)) return res.status(400).json({ error: `Cannot approve minutes from status "${existing.data.meeting_status}" — meeting must be held or have draft minutes.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meetings')
            .update({ meeting_status: 'minutes_approved', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'meeting', id, existing.data.client_id, 'minutes_approved', existing.data.meeting_status, 'minutes_approved', req.user.userId, null, {});
        await _pushTimeline(cid, existing.data.client_id, `Minutes approved: ${existing.data.meeting_title}`);
        res.json({ meeting: data });
    } catch (err) {
        console.error('Secretarial-governance approve-minutes error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTENDEES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/meetings/:id/attendees', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });
    const meeting = await supabase.from('practice_secretarial_meetings').select('id').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!meeting.data) return res.status(404).json({ error: 'Meeting not found' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meeting_attendees').select('*').eq('meeting_id', id).eq('company_id', cid).order('attendee_name');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ attendees: data || [] });
    } catch (err) {
        console.error('Secretarial-governance GET attendees error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/meetings/:id/attendees', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid meeting ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const meeting = await supabase.from('practice_secretarial_meetings').select('id, client_id').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!meeting.data) return res.status(404).json({ error: 'Meeting not found' });

    const { attendee_name, attendee_role, attendee_type, attendance_status, email, notes } = req.body;
    if (!attendee_name) return res.status(400).json({ error: 'attendee_name is required' });
    if (!ATTENDEE_TYPES.includes(attendee_type)) return res.status(400).json({ error: 'Invalid attendee_type' });
    if (attendance_status && !ATTENDANCE_STATUSES.includes(attendance_status)) return res.status(400).json({ error: 'Invalid attendance_status' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_meeting_attendees').insert({
            company_id: cid, meeting_id: id, attendee_name, attendee_role: attendee_role || null, attendee_type,
            attendance_status: attendance_status || 'invited', email: email || null, notes: notes || null,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'attendee', data.id, meeting.data.client_id, 'attendee_added', null, data.attendance_status, req.user.userId, attendee_name, { meeting_id: id });
        res.status(201).json({ attendee: data });
    } catch (err) {
        console.error('Secretarial-governance POST attendees error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/attendees/:attendeeId', async (req, res) => {
    const cid = req.companyId;
    const attendeeId = parseInt(req.params.attendeeId);
    if (!attendeeId) return res.status(400).json({ error: 'Invalid attendee ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meeting_attendees').select('*').eq('id', attendeeId).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Attendee not found' });

    const allowed = ['attendee_name', 'attendee_role', 'attendee_type', 'attendance_status', 'email', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.attendee_type && !ATTENDEE_TYPES.includes(update.attendee_type)) return res.status(400).json({ error: 'Invalid attendee_type' });
    if (update.attendance_status && !ATTENDANCE_STATUSES.includes(update.attendance_status)) return res.status(400).json({ error: 'Invalid attendance_status' });
    update.updated_at = new Date().toISOString();

    try {
        const meeting = await supabase.from('practice_secretarial_meetings').select('client_id').eq('id', existing.data.meeting_id).eq('company_id', cid).maybeSingle();
        const { data, error } = await supabase.from('practice_secretarial_meeting_attendees').update(update).eq('id', attendeeId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'attendee', attendeeId, meeting.data?.client_id, 'attendee_updated', null, data.attendance_status, req.user.userId, existing.data.attendee_name, { meeting_id: existing.data.meeting_id });
        res.json({ attendee: data });
    } catch (err) {
        console.error('Secretarial-governance PUT attendee error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Attendee removal is a real delete (not a soft cancel) — correcting a
// data-entry mistake (added the wrong person) is not erasing governance
// evidence the way cancelling a resolution/meeting/decision would be.
router.delete('/attendees/:attendeeId', async (req, res) => {
    const cid = req.companyId;
    const attendeeId = parseInt(req.params.attendeeId);
    if (!attendeeId) return res.status(400).json({ error: 'Invalid attendee ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_meeting_attendees').select('*').eq('id', attendeeId).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Attendee not found' });

    try {
        const { error } = await supabase.from('practice_secretarial_meeting_attendees').delete().eq('id', attendeeId).eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        console.error('Secretarial-governance DELETE attendee error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DECISIONS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/decisions', async (req, res) => {
    const cid = req.companyId;
    const { client_id, meeting_id, resolution_id, change_case_id, decision_status, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_decisions').select('*', { count: 'exact' }).eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (meeting_id) q = q.eq('meeting_id', parseInt(meeting_id));
        if (resolution_id) q = q.eq('resolution_id', parseInt(resolution_id));
        if (change_case_id) q = q.eq('change_case_id', parseInt(change_case_id));
        if (decision_status) q = q.eq('decision_status', decision_status);

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);
        const from = (pageNum - 1) * limitNum;
        q = q.range(from, from + limitNum - 1);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(d => d.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }

        res.json({ decisions: (data || []).map(d => ({ ...d, client_name: nameById[d.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Secretarial-governance GET decisions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/decisions', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, meeting_id, resolution_id, change_case_id, decision_type, decision_title, decision_summary, decision_date, effective_date, responsible_team_member_id, follow_up_required, follow_up_due_date, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!DECISION_TYPES.includes(decision_type)) return res.status(400).json({ error: 'Invalid decision_type' });
    if (!decision_title) return res.status(400).json({ error: 'decision_title is required' });
    if (meeting_id && !(await _verifyMeeting(cid, clientId, parseInt(meeting_id)))) return res.status(400).json({ error: 'meeting_id does not belong to this client' });
    if (resolution_id && !(await _verifyResolution(cid, clientId, parseInt(resolution_id)))) return res.status(400).json({ error: 'resolution_id does not belong to this client' });
    if (change_case_id && !(await _verifyChangeCase(cid, clientId, parseInt(change_case_id)))) return res.status(400).json({ error: 'change_case_id does not belong to this client' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions').insert({
            company_id: cid, client_id: clientId,
            meeting_id: meeting_id ? parseInt(meeting_id) : null, resolution_id: resolution_id ? parseInt(resolution_id) : null,
            change_case_id: change_case_id ? parseInt(change_case_id) : null,
            decision_type, decision_title, decision_summary: decision_summary || null,
            decision_date: decision_date || null, effective_date: effective_date || null,
            responsible_team_member_id: responsible_team_member_id ? parseInt(responsible_team_member_id) : null,
            follow_up_required: !!follow_up_required, follow_up_due_date: follow_up_due_date || null,
            notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'decision', data.id, clientId, 'decision_created', null, data.decision_status, req.user.userId, decision_title, {});
        res.status(201).json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance POST decisions error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/decisions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid decision ID' });
    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Decision not found' });
        res.json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance GET decision error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/decisions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid decision ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Decision not found' });
    const kase = existing.data;

    const allowed = ['decision_title', 'decision_summary', 'decision_date', 'effective_date', 'responsible_team_member_id', 'follow_up_required', 'follow_up_due_date', 'notes', 'internal_notes', 'metadata', 'decision_status'];
    const update = _pick(req.body, allowed);

    if (update.decision_status) {
        const target = update.decision_status;
        const isCancel = target === 'cancelled' && kase.decision_status !== 'implemented' && kase.decision_status !== 'cancelled';
        if (!(target === 'draft' || isCancel)) {
            return res.status(400).json({ error: 'PUT /:id may only set draft or cancel a non-implemented decision. Use approve/implement for those transitions.' });
        }
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.decision_status === 'cancelled' ? 'decision_cancelled' : 'decision_updated';
        await _writeGovEvent(cid, 'decision', id, kase.client_id, eventType, kase.decision_status, data.decision_status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance PUT decision error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/decisions/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid decision ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Decision not found' });
    if (['implemented', 'cancelled'].includes(existing.data.decision_status)) return res.status(400).json({ error: `Cannot cancel a decision that is already ${existing.data.decision_status}.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions')
            .update({ decision_status: 'cancelled', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'decision', id, existing.data.client_id, 'decision_cancelled', existing.data.decision_status, 'cancelled', req.user.userId, req.body.reason || null, {});
        res.json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance DELETE decision error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/decisions/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid decision ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Decision not found' });
    if (existing.data.decision_status !== 'draft') return res.status(400).json({ error: `Cannot approve from status "${existing.data.decision_status}".` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions')
            .update({ decision_status: 'approved', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'decision', id, existing.data.client_id, 'decision_approved', existing.data.decision_status, 'approved', req.user.userId, null, {});
        res.json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance approve decision error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/decisions/:id/implement', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid decision ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_secretarial_decisions').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Decision not found' });
    if (existing.data.decision_status !== 'approved') return res.status(400).json({ error: `Cannot implement from status "${existing.data.decision_status}" — decision must be approved.` });

    try {
        const { data, error } = await supabase.from('practice_secretarial_decisions')
            .update({ decision_status: 'implemented', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeGovEvent(cid, 'decision', id, existing.data.client_id, 'decision_implemented', existing.data.decision_status, 'implemented', req.user.userId, null, {});
        await _pushTimeline(cid, existing.data.client_id, `Decision implemented: ${existing.data.decision_title}`);
        res.json({ decision: data });
    } catch (err) {
        console.error('Secretarial-governance implement decision error:', err.message);
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
        let q = supabase.from('practice_secretarial_governance_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-governance GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const sourceType = req.params.sourceType;
    const sourceId = parseInt(req.params.sourceId);
    if (!['resolution', 'meeting', 'attendee', 'decision'].includes(sourceType)) return res.status(400).json({ error: 'Invalid sourceType' });
    if (!sourceId) return res.status(400).json({ error: 'Invalid sourceId' });

    try {
        const { data, error } = await supabase.from('practice_secretarial_governance_events').select('*')
            .eq('company_id', cid).eq('source_type', sourceType).eq('source_id', sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-governance GET source events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
