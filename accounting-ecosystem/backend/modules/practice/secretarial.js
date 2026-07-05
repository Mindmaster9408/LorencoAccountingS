'use strict';

// Codebox 62 — Practice Secretarial Foundation
// "I know everything about this company's statutory position." Corporate
// profile, director register, shareholder register, annual return tracking,
// and a timeline of statutory events — all per client.
//
// NOT accounting. NOT tax. NOT payroll. NOT a client CRM. NOT document
// management (practice_clients, tax modules, and document-requests.js stay
// the owners of those domains — this module only references them). NOT a
// CIPC API integration, NOT automatic submissions, NOT e-signatures, NOT
// document generation, NOT trust accounting, NOT estate planning. Fully
// manager-controlled, deterministic, explainable.
//
// This is a FOUNDATION — it stores statutory information. It does NOT manage
// statutory CHANGE as a workflow (approvals/checklists/deadlines around a
// director appointment, for instance) — that is Codebox 63.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_TYPES = ['pty_ltd', 'cc', 'npc', 'trust', 'partnership', 'sole_proprietor', 'other'];
const COMPANY_STATUSES = ['active', 'dormant', 'deregistration_process', 'deregistered', 'in_liquidation', 'other'];
const DIRECTOR_ROLES = ['executive', 'non_executive', 'alternate'];
const DIRECTOR_STATUSES = ['active', 'resigned'];
const SHAREHOLDER_TYPES = ['individual', 'company', 'trust'];
const SHAREHOLDER_STATUSES = ['active', 'transferred', 'cancelled'];
const RETURN_STATUSES = ['pending', 'submitted', 'overdue', 'exempted'];

// Annual returns due (or overdue) within this many days count as an
// "upcoming statutory action" / Planning Board warning. Plain constant, not
// a rule engine — Alert Rules (Codebox 53) governs cross-module thresholds
// that partners tune; this is a fixed, spec-scoped window for one field.
const UPCOMING_RETURN_WINDOW_DAYS = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString().split('T')[0]; }

async function _myTeamMember(cid, user) {
    return teamAccess.getMyTeamMember(supabase, cid, user);
}
function _isManager(member) { return teamAccess.isManager(member); }

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can edit Secretarial records.');
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients')
        .select('id, name, client_type, registration_number, vat_number, coida_registration_number, fiscal_year_end')
        .eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, eventType, entityType, entityId, actorUserId, notes, meta) {
    await supabase.from('practice_secretarial_events').insert({
        company_id: cid, client_id: clientId, event_type: eventType, entity_type: entityType || null,
        entity_id: entityId || null, actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _getOrInitProfile(cid, clientId) {
    const { data: existing } = await supabase.from('practice_secretarial_profiles')
        .select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase.from('practice_secretarial_profiles')
        .insert({ company_id: cid, client_id: clientId }).select().single();
    if (error) throw new Error(error.message);
    return created;
}

// ─── Secretarial Engine — getCorporateProfile() ────────────────────────────────
// Pure aggregation, as the spec requires: reads the secretarial profile,
// directors, shareholders, annual returns, and timeline, and cross-references
// identity/tax fields that already live on practice_clients and
// practice_taxpayer_profiles rather than re-storing them. No scoring, no
// business logic beyond "what's due soon."

async function getCorporateProfile(cid, clientId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    const [profileRes, taxpayerRes, directorsRes, shareholdersRes, returnsRes, timelineRes] = await Promise.all([
        supabase.from('practice_secretarial_profiles').select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle(),
        supabase.from('practice_taxpayer_profiles').select('income_tax_reference, financial_year_end').eq('company_id', cid).eq('client_id', clientId).maybeSingle(),
        supabase.from('practice_company_directors').select('*').eq('company_id', cid).eq('client_id', clientId).order('status').order('director_name'),
        supabase.from('practice_company_shareholders').select('*').eq('company_id', cid).eq('client_id', clientId).order('status').order('shareholder_name'),
        supabase.from('practice_annual_returns').select('*').eq('company_id', cid).eq('client_id', clientId).order('return_year', { ascending: false }),
        supabase.from('practice_secretarial_events').select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false }).limit(30),
    ]);

    const returns = returnsRes.data || [];
    const t = today();
    const window = daysFromNow(UPCOMING_RETURN_WINDOW_DAYS);
    const upcomingActions = returns
        .filter(r => ['pending', 'overdue'].includes(r.status) && r.due_date && r.due_date <= window)
        .map(r => ({
            type: 'annual_return',
            label: `Annual return ${r.return_year}${r.due_date < t ? ' — OVERDUE' : ' due'} (${r.due_date})`,
            due_date: r.due_date,
            overdue: r.due_date < t,
            entity_id: r.id,
        }))
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

    return {
        client: {
            id: client.id, name: client.name, client_type: client.client_type,
            registration_number: client.registration_number,
            vat_number: client.vat_number,
            coida_registration_number: client.coida_registration_number,
        },
        // Cross-referenced, not duplicated — see migration 119 header.
        income_tax_reference: taxpayerRes.data?.income_tax_reference || null,
        financial_year_end: taxpayerRes.data?.financial_year_end || null,
        profile: profileRes.data || null,
        directors: directorsRes.data || [],
        shareholders: shareholdersRes.data || [],
        annual_returns: returns,
        upcoming_statutory_actions: upcomingActions,
        timeline: timelineRes.data || [],
    };
}

// ─── Governance summary — for Client Success reuse (no duplicate logic) ────────
// Lightweight, deliberately not the full getCorporateProfile() aggregation —
// Client Success only needs a couple of counts to decide whether to show a
// governance concern, not the whole profile/director/shareholder payload.

async function getGovernanceSummary(cid, clientId) {
    const t = today();
    const [returnsRes, directorsRes] = await Promise.all([
        supabase.from('practice_annual_returns').select('id, status, due_date').eq('company_id', cid).eq('client_id', clientId).in('status', ['pending', 'overdue']),
        supabase.from('practice_company_directors').select('id').eq('company_id', cid).eq('client_id', clientId).eq('status', 'active'),
    ]);

    const outstandingReturns = (returnsRes.data || []).filter(r => r.status === 'overdue' || (r.due_date && r.due_date < t)).length;
    const activeDirectorCount = (directorsRes.data || []).length;

    let concern = null;
    if (outstandingReturns > 0) concern = `${outstandingReturns} outstanding annual return${outstandingReturns > 1 ? 's' : ''}`;
    else if (activeDirectorCount === 0) concern = 'No active directors on record';

    return {
        outstanding_annual_returns: outstandingReturns,
        active_director_count: activeDirectorCount,
        governance_concern: concern,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    const t = today();
    try {
        const [profiles, directors, returns] = await Promise.all([
            supabase.from('practice_secretarial_profiles').select('company_status').eq('company_id', cid),
            supabase.from('practice_company_directors').select('status').eq('company_id', cid).eq('status', 'active'),
            supabase.from('practice_annual_returns').select('status, due_date').eq('company_id', cid),
        ]);

        const statusCounts = { active: 0, dormant: 0, deregistration_process: 0, deregistered: 0, in_liquidation: 0, other: 0 };
        for (const p of (profiles.data || [])) { const k = p.company_status || 'active'; if (k in statusCounts) statusCounts[k]++; }

        let returnsOverdue = 0, returnsPending = 0, returnsSubmitted = 0;
        for (const r of (returns.data || [])) {
            if (r.status === 'submitted') returnsSubmitted++;
            else if (r.status === 'overdue' || (r.status === 'pending' && r.due_date && r.due_date < t)) returnsOverdue++;
            else if (r.status === 'pending') returnsPending++;
        }

        res.json({
            profiles_total: (profiles.data || []).length,
            company_status: statusCounts,
            active_directors: (directors.data || []).length,
            annual_returns: { overdue: returnsOverdue, pending: returnsPending, submitted: returnsSubmitted },
        });
    } catch (err) {
        console.error('Secretarial /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CORPORATE PROFILE
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    try {
        const result = await getCorporateProfile(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Secretarial GET /:clientId error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:clientId/profile', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const allowed = [
        'company_type', 'registration_date', 'registered_address', 'postal_address',
        'company_status', 'cipc_status', 'paye_number', 'sdl_number', 'uif_number',
        'auditor', 'company_secretary', 'financial_officer', 'notes',
    ];
    const update = _pick(req.body, allowed);
    if (update.company_type && !COMPANY_TYPES.includes(update.company_type)) return res.status(400).json({ error: 'Invalid company_type' });
    if (update.company_status && !COMPANY_STATUSES.includes(update.company_status)) return res.status(400).json({ error: 'Invalid company_status' });
    update.updated_at = new Date().toISOString();

    try {
        const existing = await _getOrInitProfile(cid, clientId);
        const { data, error } = await supabase.from('practice_secretarial_profiles')
            .update(update).eq('company_id', cid).eq('client_id', clientId).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = existing.created_at === existing.updated_at ? 'profile_created' : 'profile_updated';
        await _writeEvent(cid, clientId, eventType, 'profile', data.id, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ profile: data });
    } catch (err) {
        console.error('Secretarial PUT profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DIRECTORS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/directors', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_company_directors')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('status').order('director_name');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ directors: data || [] });
    } catch (err) {
        console.error('Secretarial GET directors error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/directors', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { director_name, id_or_passport_number, role, appointment_date, shareholding_pct, signing_authority, notes } = req.body;
    if (!director_name) return res.status(400).json({ error: 'director_name is required' });
    if (role && !DIRECTOR_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    try {
        const { data, error } = await supabase.from('practice_company_directors').insert({
            company_id: cid, client_id: clientId, director_name, id_or_passport_number: id_or_passport_number || null,
            role: role || 'executive', appointment_date: appointment_date || null,
            shareholding_pct: shareholding_pct != null ? parseFloat(shareholding_pct) : null,
            signing_authority: !!signing_authority, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'director_appointed', 'director', data.id, req.user.userId, director_name, { role: data.role });
        res.status(201).json({ director: data });
    } catch (err) {
        console.error('Secretarial POST directors error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/directors/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid director ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_company_directors').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Director not found' });

    const allowed = ['director_name', 'id_or_passport_number', 'role', 'appointment_date', 'resignation_date', 'status', 'shareholding_pct', 'signing_authority', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.role && !DIRECTOR_ROLES.includes(update.role)) return res.status(400).json({ error: 'Invalid role' });
    if (update.status && !DIRECTOR_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'resigned' && !update.resignation_date) update.resignation_date = today();
    if (update.shareholding_pct != null) update.shareholding_pct = parseFloat(update.shareholding_pct);
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_company_directors')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'resigned' ? 'director_resigned' : 'director_updated';
        await _writeEvent(cid, existing.data.client_id, eventType, 'director', id, req.user.userId, existing.data.director_name, {});
        res.json({ director: data });
    } catch (err) {
        console.error('Secretarial PUT directors error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// SHAREHOLDERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/shareholders', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_company_shareholders')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('status').order('shareholder_name');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ shareholders: data || [] });
    } catch (err) {
        console.error('Secretarial GET shareholders error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/shareholders', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { shareholder_name, shareholder_type, shares, percentage, issue_date, notes } = req.body;
    if (!shareholder_name) return res.status(400).json({ error: 'shareholder_name is required' });
    if (!SHAREHOLDER_TYPES.includes(shareholder_type)) return res.status(400).json({ error: 'Invalid shareholder_type' });

    try {
        const { data, error } = await supabase.from('practice_company_shareholders').insert({
            company_id: cid, client_id: clientId, shareholder_name, shareholder_type,
            shares: shares != null ? parseFloat(shares) : null, percentage: percentage != null ? parseFloat(percentage) : null,
            issue_date: issue_date || null, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'shareholder_added', 'shareholder', data.id, req.user.userId, shareholder_name, {});
        res.status(201).json({ shareholder: data });
    } catch (err) {
        console.error('Secretarial POST shareholders error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/shareholders/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid shareholder ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_company_shareholders').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Shareholder not found' });

    const allowed = ['shareholder_name', 'shareholder_type', 'shares', 'percentage', 'issue_date', 'transfer_date', 'status', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.shareholder_type && !SHAREHOLDER_TYPES.includes(update.shareholder_type)) return res.status(400).json({ error: 'Invalid shareholder_type' });
    if (update.status && !SHAREHOLDER_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'transferred' && !update.transfer_date) update.transfer_date = today();
    if (update.shares != null) update.shares = parseFloat(update.shares);
    if (update.percentage != null) update.percentage = parseFloat(update.percentage);
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_company_shareholders')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'transferred' ? 'share_transferred' : 'shareholder_updated';
        await _writeEvent(cid, existing.data.client_id, eventType, 'shareholder', id, req.user.userId, existing.data.shareholder_name, {});
        res.json({ shareholder: data });
    } catch (err) {
        console.error('Secretarial PUT shareholders error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ANNUAL RETURNS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/annual-returns', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_annual_returns')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('return_year', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ annual_returns: data || [] });
    } catch (err) {
        console.error('Secretarial GET annual-returns error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/annual-returns', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { return_year, due_date, reference, reminder_date, notes } = req.body;
    if (!return_year) return res.status(400).json({ error: 'return_year is required' });

    try {
        const { data, error } = await supabase.from('practice_annual_returns').insert({
            company_id: cid, client_id: clientId, return_year: parseInt(return_year), due_date: due_date || null,
            reference: reference || null, reminder_date: reminder_date || null, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'annual_return_created', 'annual_return', data.id, req.user.userId, `Year ${return_year}`, {});
        res.status(201).json({ annual_return: data });
    } catch (err) {
        console.error('Secretarial POST annual-returns error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/annual-returns/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid annual return ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_annual_returns').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Annual return not found' });

    const allowed = ['due_date', 'submission_date', 'status', 'reference', 'reminder_date', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.status && !RETURN_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'submitted' && !update.submission_date) update.submission_date = today();
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_annual_returns')
            .update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const eventType = update.status === 'submitted' ? 'annual_return_submitted' : 'annual_return_updated';
        await _writeEvent(cid, existing.data.client_id, eventType, 'annual_return', id, req.user.userId, `Year ${existing.data.return_year}`, {});
        res.json({ annual_return: data });
    } catch (err) {
        console.error('Secretarial PUT annual-returns error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE + EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:clientId/timeline', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { limit = 50 } = req.query;
        const { data, error } = await supabase.from('practice_secretarial_events')
            .select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false }).limit(Math.min(200, parseInt(limit) || 50));
        if (error) return res.status(500).json({ error: error.message });
        res.json({ timeline: data || [] });
    } catch (err) {
        console.error('Secretarial GET timeline error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:clientId/timeline/note', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { notes } = req.body;
    if (!notes) return res.status(400).json({ error: 'notes is required' });

    try {
        await _writeEvent(cid, clientId, 'manager_note', null, null, req.user.userId, notes, {});
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('Secretarial POST timeline note error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/events/log', async (req, res) => {
    const cid = req.companyId;
    const { client_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/62_secretarial_foundation.md
module.exports.getCorporateProfile = getCorporateProfile;
module.exports.getGovernanceSummary = getGovernanceSummary;

// Codebox 63 — secretarial-workflows.js writes into the SAME Timeline
// (practice_secretarial_events) that this module's own routes write to,
// rather than inventing a second, competing timeline. Purely additive
// exports — zero change to any existing route's behavior.
module.exports.writeSecretarialEvent = _writeEvent;
module.exports.getOrInitProfile = _getOrInitProfile;
