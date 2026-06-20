/* =============================================================
   Practice Client Communication Log  (Codebox 22)
   Manual communication logging only. No email/SMS/WhatsApp sending.
   No external integrations. No cron. In-app only.
   Mounted at /api/practice/communications
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const COMM_TYPES = [
    'call', 'email_note', 'whatsapp_note', 'meeting',
    'document_request', 'sars_followup', 'cipc_followup',
    'billing_followup', 'general_note', 'internal_note',
];

const DIRECTIONS       = ['inbound', 'outbound', 'internal'];
const RESPONSE_STATUSES = ['not_required', 'waiting', 'received', 'overdue', 'cancelled'];
const VISIBILITIES     = ['practice', 'manager_only', 'partner_only'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function getMondayStr() {
    var d = new Date();
    var day = d.getDay();
    var diff = (day === 0) ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
}

async function verifyBelongsToCompany(cid, table, id) {
    if (!id) return true;
    const { data } = await supabase
        .from(table).select('id').eq('id', id).eq('company_id', cid).single();
    return !!data;
}

async function verifyCommOwnership(cid, commId) {
    const { data } = await supabase
        .from('practice_client_communications')
        .select('*')
        .eq('id', commId)
        .eq('company_id', cid)
        .is('cancelled_at', null)
        .single();
    return data || null;
}

function enrichComm(c) {
    const t = todayStr();
    const effectiveResponseStatus =
        c.response_status === 'waiting' && c.response_due_date && c.response_due_date < t
            ? 'overdue'
            : c.response_status;
    return { ...c, effective_response_status: effectiveResponseStatus };
}

// ─── GET /summary ─────────────────────────────────────────────────────────────
// MUST be before GET /:id to prevent 'summary' matching as :id

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase
            .from('practice_client_communications')
            .select('communication_type, response_status, response_due_date, created_at')
            .eq('company_id', cid)
            .is('cancelled_at', null);

        if (error) {
            console.error('Comms /summary error:', error.message);
            return res.status(500).json({ error: 'Failed to load summary' });
        }

        const t         = todayStr();
        const weekStart = getMondayStr();
        const counts    = {
            total:                  0,
            waiting_responses:      0,
            overdue_responses:      0,
            document_requests_open: 0,
            this_week:              0,
        };

        for (const c of (data || [])) {
            counts.total++;
            if (c.created_at >= weekStart) counts.this_week++;
            if (c.response_status === 'waiting') {
                counts.waiting_responses++;
                if (c.response_due_date && c.response_due_date < t) counts.overdue_responses++;
            }
            if (c.communication_type === 'document_request' && c.response_status === 'waiting') {
                counts.document_requests_open++;
            }
        }

        res.json({ summary: counts });
    } catch (err) {
        console.error('Comms /summary exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET / — list communications ──────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, communication_type, direction, response_status,
        assigned_team_member_id, response_required, due_from, due_to,
        search, limit = '200',
    } = req.query;

    try {
        let query = supabase
            .from('practice_client_communications')
            .select('*')
            .eq('company_id', cid)
            .is('cancelled_at', null)
            .order('communication_date', { ascending: false })
            .limit(parseInt(limit, 10) || 200);

        if (client_id)               query = query.eq('client_id', parseInt(client_id, 10));
        if (communication_type)      query = query.eq('communication_type', communication_type);
        if (direction)               query = query.eq('direction', direction);
        if (assigned_team_member_id) query = query.eq('assigned_team_member_id', parseInt(assigned_team_member_id, 10));
        if (response_required !== undefined && response_required !== '')
            query = query.eq('response_required', response_required === 'true');
        if (due_from) query = query.gte('response_due_date', due_from);
        if (due_to)   query = query.lte('response_due_date', due_to);

        // response_status filter: 'overdue' is a virtual status — map to DB check
        if (response_status === 'overdue') {
            const t = todayStr();
            query = query.eq('response_status', 'waiting').lt('response_due_date', t);
        } else if (response_status) {
            query = query.eq('response_status', response_status);
        }

        const { data, error } = await query;
        if (error) {
            console.error('Comms GET / error:', error.message);
            return res.status(500).json({ error: 'Failed to load communications' });
        }

        let enriched = (data || []).map(enrichComm);

        // Client-side text search (search in subject + body + contact_name)
        if (search) {
            const s = search.toLowerCase();
            enriched = enriched.filter(function (c) {
                return (c.subject || '').toLowerCase().includes(s) ||
                    (c.body || '').toLowerCase().includes(s) ||
                    (c.contact_name || '').toLowerCase().includes(s);
            });
        }

        // Enrich with client + team member names
        const clientIds = [...new Set(enriched.map(c => c.client_id).filter(Boolean))];
        const memberIds = [...new Set(enriched.map(c => c.assigned_team_member_id).filter(Boolean))];

        const [clientsRes, membersRes] = await Promise.all([
            clientIds.length
                ? supabase.from('practice_clients').select('id, client_name').in('id', clientIds).eq('company_id', cid)
                : { data: [] },
            memberIds.length
                ? supabase.from('practice_team_members').select('id, display_name').in('id', memberIds).eq('company_id', cid)
                : { data: [] },
        ]);

        const clientMap = Object.fromEntries((clientsRes.data || []).map(c => [c.id, c.client_name]));
        const memberMap = Object.fromEntries((membersRes.data || []).map(m => [m.id, m.display_name]));

        enriched = enriched.map(c => ({
            ...c,
            client_name:   c.client_id               ? (clientMap[c.client_id]               || null) : null,
            assignee_name: c.assigned_team_member_id  ? (memberMap[c.assigned_team_member_id]  || null) : null,
        }));

        res.json({ communications: enriched, total: enriched.length });
    } catch (err) {
        console.error('Comms GET / exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST / — create communication ───────────────────────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, communication_type, direction = 'outbound',
        subject, body, contact_person_id, contact_name, contact_email, contact_phone,
        related_task_id, related_deadline_id, related_engagement_id,
        related_reminder_id, related_health_action_id,
        response_required = false, response_due_date,
        assigned_team_member_id, communication_date,
        is_internal = false, visibility = 'practice',
        attachments_note, tags, settings,
    } = req.body;

    if (!client_id)           return res.status(400).json({ error: 'client_id is required' });
    if (!communication_type)  return res.status(400).json({ error: 'communication_type is required' });
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'subject is required' });
    if (!COMM_TYPES.includes(communication_type))  return res.status(400).json({ error: 'Invalid communication_type' });
    if (!DIRECTIONS.includes(direction))           return res.status(400).json({ error: 'Invalid direction' });
    if (visibility && !VISIBILITIES.includes(visibility)) return res.status(400).json({ error: 'Invalid visibility' });

    try {
        // Verify all linked records belong to this company (parallel checks)
        const [clientOk, taskOk, deadlineOk, engOk, reminderOk, healthOk, memberOk] = await Promise.all([
            verifyBelongsToCompany(cid, 'practice_clients',               client_id),
            verifyBelongsToCompany(cid, 'practice_tasks',                 related_task_id),
            verifyBelongsToCompany(cid, 'practice_deadlines',             related_deadline_id),
            verifyBelongsToCompany(cid, 'practice_client_engagements',    related_engagement_id),
            verifyBelongsToCompany(cid, 'practice_reminders',             related_reminder_id),
            verifyBelongsToCompany(cid, 'practice_client_health_actions', related_health_action_id),
            verifyBelongsToCompany(cid, 'practice_team_members',          assigned_team_member_id),
        ]);

        if (!clientOk)  return res.status(403).json({ error: 'Client not found' });
        if (!taskOk)    return res.status(403).json({ error: 'Related task not found' });
        if (!deadlineOk) return res.status(403).json({ error: 'Related deadline not found' });
        if (!engOk)     return res.status(403).json({ error: 'Related engagement not found' });
        if (!reminderOk) return res.status(403).json({ error: 'Related reminder not found' });
        if (!healthOk)  return res.status(403).json({ error: 'Related health action not found' });
        if (!memberOk)  return res.status(403).json({ error: 'Team member not found' });

        // Auto-set response_status when response_required
        let resolvedStatus = 'not_required';
        if (response_required) {
            resolvedStatus = 'waiting';
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_client_communications')
            .insert({
                company_id:              cid,
                client_id:               parseInt(client_id, 10),
                communication_type,
                direction,
                subject:                 subject.trim(),
                body:                    body || null,
                contact_person_id:       contact_person_id || null,
                contact_name:            contact_name      || null,
                contact_email:           contact_email     || null,
                contact_phone:           contact_phone     || null,
                related_task_id:         related_task_id         || null,
                related_deadline_id:     related_deadline_id     || null,
                related_engagement_id:   related_engagement_id   || null,
                related_reminder_id:     related_reminder_id     || null,
                related_health_action_id: related_health_action_id || null,
                response_required:       !!response_required,
                response_due_date:       response_due_date  || null,
                response_status:         resolvedStatus,
                assigned_team_member_id: assigned_team_member_id || null,
                communication_date:      communication_date || now,
                is_internal:             !!is_internal,
                visibility:              visibility || 'practice',
                attachments_note:        attachments_note || null,
                tags:                    tags     || [],
                settings:                settings || {},
                created_at:              now,
                updated_at:              now,
                created_by:              req.user.userId,
            })
            .select()
            .single();

        if (error) {
            console.error('Comms POST / insert error:', error.message);
            return res.status(500).json({ error: 'Failed to create communication' });
        }

        await auditFromReq(req, 'CREATE', 'practice_client_communication', data.id, {
            module: 'practice', action: 'communication_created',
            client_id, communication_type, direction,
        });

        res.status(201).json({ communication: enrichComm(data) });
    } catch (err) {
        console.error('Comms POST / exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET /:id — single communication ─────────────────────────────────────────
// After GET /summary and POST / to avoid literal path collisions

router.get('/:id', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const { data, error } = await supabase
            .from('practice_client_communications')
            .select('*')
            .eq('id', commId)
            .eq('company_id', cid)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Communication not found' });

        res.json({ communication: enrichComm(data) });
    } catch (err) {
        console.error('Comms GET /:id exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST /:id/create-reminder ────────────────────────────────────────────────
// 3-segment POST — no conflict with 2-segment PUT /:id or 1-segment GET /:id

router.post('/:id/create-reminder', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    const { due_date, severity, assigned_team_member_id, title, message } = req.body;

    try {
        const comm = await verifyCommOwnership(cid, commId);
        if (!comm) return res.status(404).json({ error: 'Communication not found' });

        const now          = new Date().toISOString();
        const reminderTitle = (title || ('Follow-up: ' + comm.subject)).substring(0, 200);

        const { data: reminder, error: remErr } = await supabase
            .from('practice_reminders')
            .insert({
                company_id:              cid,
                reminder_type:           'general',
                source_type:             'system',
                client_id:               comm.client_id,
                assigned_team_member_id: assigned_team_member_id || comm.assigned_team_member_id || null,
                title:                   reminderTitle,
                message:                 message || ('Communication: ' + comm.communication_type + ' — ' + comm.subject),
                severity:                severity || 'normal',
                status:                  'open',
                due_date:                due_date || comm.response_due_date || null,
                action_url:              '/practice/communications.html',
                created_at:              now,
                updated_at:              now,
                created_by:              req.user.userId,
            })
            .select('id')
            .single();

        if (remErr) {
            console.error('Comms create-reminder insert error:', remErr.message);
            return res.status(500).json({ error: 'Failed to create reminder' });
        }

        // Link reminder back to communication if not already linked
        if (!comm.related_reminder_id) {
            await supabase
                .from('practice_client_communications')
                .update({ related_reminder_id: reminder.id, updated_at: now, updated_by: req.user.userId })
                .eq('id', commId)
                .eq('company_id', cid);
        }

        await auditFromReq(req, 'CREATE', 'practice_reminder', reminder.id, {
            module: 'practice', action: 'communication_reminder_created',
            communication_id: commId, client_id: comm.client_id,
        });

        res.status(201).json({ reminder_id: reminder.id });
    } catch (err) {
        console.error('Comms create-reminder exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST /:id/create-task ────────────────────────────────────────────────────

router.post('/:id/create-task', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    const { due_date, assigned_team_member_id, title } = req.body;

    try {
        const comm = await verifyCommOwnership(cid, commId);
        if (!comm) return res.status(404).json({ error: 'Communication not found' });

        const taskTitle = (title || ('Follow-up: ' + comm.subject)).substring(0, 200);
        const now       = new Date().toISOString();

        const { data: task, error: taskErr } = await supabase
            .from('practice_tasks')
            .insert({
                company_id:               cid,
                client_id:                comm.client_id,
                title:                    taskTitle,
                description:              'Created from communication. Type: ' + comm.communication_type + '. Subject: ' + comm.subject,
                type:                     'general',
                priority:                 'normal',
                status:                   'open',
                review_status:            'not_required',
                approval_status:          'not_required',
                qa_status:                'none',
                review_required:          false,
                approval_required:        false,
                due_date:                 due_date || comm.response_due_date || null,
                preparer_team_member_id:  assigned_team_member_id || comm.assigned_team_member_id || null,
                created_by:               req.user.userId,
            })
            .select('id')
            .single();

        if (taskErr) {
            console.error('Comms create-task insert error:', taskErr.message);
            return res.status(500).json({ error: 'Failed to create task' });
        }

        // Link task back to communication if not already linked
        if (!comm.related_task_id) {
            await supabase
                .from('practice_client_communications')
                .update({ related_task_id: task.id, updated_at: now, updated_by: req.user.userId })
                .eq('id', commId)
                .eq('company_id', cid);
        }

        await auditFromReq(req, 'CREATE', 'practice_task', task.id, {
            module: 'practice', action: 'communication_followup_task_created',
            communication_id: commId, client_id: comm.client_id,
        });

        res.status(201).json({ task_id: task.id });
    } catch (err) {
        console.error('Comms create-task exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id/mark-responded ──────────────────────────────────────────────────
// 3-segment — before 2-segment PUT /:id

router.put('/:id/mark-responded', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const comm = await verifyCommOwnership(cid, commId);
        if (!comm) return res.status(404).json({ error: 'Communication not found' });
        if (!comm.response_required) return res.status(409).json({ error: 'This communication does not require a response' });
        if (comm.response_status === 'received') return res.status(409).json({ error: 'Response already marked as received' });

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_client_communications')
            .update({
                response_status: 'received',
                responded_at:    now,
                responded_by:    req.user.userId,
                updated_at:      now,
                updated_by:      req.user.userId,
            })
            .eq('id', commId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Comms mark-responded error:', error.message);
            return res.status(500).json({ error: 'Failed to update' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_client_communication', commId, {
            module: 'practice', action: 'communication_response_received',
        });

        res.json({ communication: enrichComm(data) });
    } catch (err) {
        console.error('Comms mark-responded exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id/cancel-response ─────────────────────────────────────────────────

router.put('/:id/cancel-response', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const comm = await verifyCommOwnership(cid, commId);
        if (!comm) return res.status(404).json({ error: 'Communication not found' });

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('practice_client_communications')
            .update({
                response_status:  'cancelled',
                response_required: false,
                updated_at:       now,
                updated_by:       req.user.userId,
            })
            .eq('id', commId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Comms cancel-response error:', error.message);
            return res.status(500).json({ error: 'Failed to update' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_client_communication', commId, {
            module: 'practice', action: 'communication_response_cancelled',
        });

        res.json({ communication: enrichComm(data) });
    } catch (err) {
        console.error('Comms cancel-response exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT /:id — generic update ────────────────────────────────────────────────
// 2-segment — after all 3-segment PUT routes

router.put('/:id', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    const allowed = [
        'communication_type', 'direction', 'subject', 'body',
        'contact_name', 'contact_email', 'contact_phone',
        'related_task_id', 'related_deadline_id', 'related_engagement_id',
        'related_reminder_id', 'related_health_action_id',
        'response_required', 'response_due_date',
        'assigned_team_member_id', 'communication_date',
        'is_internal', 'visibility', 'attachments_note', 'tags', 'settings',
    ];

    const updates = {};
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
    }

    if (updates.communication_type && !COMM_TYPES.includes(updates.communication_type)) {
        return res.status(400).json({ error: 'Invalid communication_type' });
    }
    if (updates.direction && !DIRECTIONS.includes(updates.direction)) {
        return res.status(400).json({ error: 'Invalid direction' });
    }
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
    }

    try {
        const existing = await verifyCommOwnership(cid, commId);
        if (!existing) return res.status(404).json({ error: 'Communication not found' });

        // If response_required is being set to true and status is not_required, auto-set to waiting
        if (updates.response_required === true && existing.response_status === 'not_required') {
            updates.response_status = 'waiting';
        }

        updates.updated_at = new Date().toISOString();
        updates.updated_by = req.user.userId;

        const { data, error } = await supabase
            .from('practice_client_communications')
            .update(updates)
            .eq('id', commId)
            .eq('company_id', cid)
            .select()
            .single();

        if (error) {
            console.error('Comms PUT /:id error:', error.message);
            return res.status(500).json({ error: 'Failed to update' });
        }

        await auditFromReq(req, 'UPDATE', 'practice_client_communication', commId, {
            module: 'practice', action: 'communication_updated', fields: Object.keys(updates),
        });

        res.json({ communication: enrichComm(data) });
    } catch (err) {
        console.error('Comms PUT /:id exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DELETE /:id — soft cancel ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid    = req.companyId;
    const commId = parseInt(req.params.id, 10);
    if (isNaN(commId)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const existing = await verifyCommOwnership(cid, commId);
        if (!existing) return res.status(404).json({ error: 'Communication not found or already cancelled' });

        const now = new Date().toISOString();
        const { error } = await supabase
            .from('practice_client_communications')
            .update({ cancelled_at: now, updated_at: now, updated_by: req.user.userId })
            .eq('id', commId)
            .eq('company_id', cid);

        if (error) {
            console.error('Comms DELETE /:id error:', error.message);
            return res.status(500).json({ error: 'Failed to cancel communication' });
        }

        await auditFromReq(req, 'DELETE', 'practice_client_communication', commId, {
            module: 'practice', action: 'communication_cancelled',
        });

        res.json({ ok: true });
    } catch (err) {
        console.error('Comms DELETE /:id exception:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
