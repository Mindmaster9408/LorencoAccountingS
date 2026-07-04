'use strict';

// Codebox 65 — Secretarial Beneficial Ownership + Ownership Chain Foundation
// "Who ultimately owns or controls this client?" and "Are we ready to
// file/confirm BO information?" — within seconds.
//
// NOT CIPC API. NOT automatic filing. NOT legal advice. NOT document
// generation. Structured BO recordkeeping and readiness tracking only —
// future CIPC filing must plug into this foundation, not replace it.
//
// This module does NOT duplicate practice_company_shareholders (Codebox 62)
// — getBeneficialOwnershipProfile() reads it live. Beneficial owners are an
// ADDITIONAL layer answering "who is ultimately behind the shareholder,"
// never a replacement for the shareholder register.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

const OWNER_TYPES = ['natural_person', 'company', 'trust', 'partnership', 'nominee', 'other'];
const CONTROL_TYPES = ['shareholding', 'voting_rights', 'board_control', 'trustee_control', 'beneficiary_control', 'nominee_control', 'agreement_control', 'other_control'];
const OWNER_STATUSES = ['draft', 'active', 'incomplete', 'verified', 'not_reportable', 'archived'];
const VERIFICATION_STATUSES = ['not_started', 'requested', 'documents_received', 'verified', 'rejected', 'expired'];

const CHAIN_STATUSES = ['draft', 'active', 'verified', 'incomplete', 'archived'];
const ROOT_HOLDER_TYPES = ['shareholder', 'company', 'trust', 'natural_person', 'nominee', 'other'];
const CALCULATION_METHODS = ['direct', 'multiplied_chain', 'manual_override', 'unknown'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'];

const READINESS_ITEM_TYPES = ['owner_identity', 'owner_address', 'ownership_percentage', 'chain_support', 'trust_deed', 'company_register', 'nominee_declaration', 'resolution', 'cipc_form', 'review', 'custom'];
const READINESS_STATUSES = ['required', 'requested', 'received', 'verified', 'waived', 'blocked', 'not_applicable'];
const READINESS_DONE_STATUSES = ['received', 'verified', 'waived'];

const DEFAULT_REPORTING_THRESHOLD_PCT = 5;

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage beneficial ownership records.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_beneficial_ownership_events').insert({
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

// ─── Percentage Logic — never guesses ──────────────────────────────────────────
// Shared by beneficial owners (no chain_path — manual > direct > unknown) and
// ownership chains (manual > multiplied chain_path > direct fallback > unknown).
// See docs/new-app/65_beneficial_ownership.md for the full rationale.

function _calcEffectivePercentage({ effective_percentage, direct_percentage, chain_path }) {
    if (effective_percentage != null && effective_percentage !== '') {
        return { effective_percentage: parseFloat(effective_percentage), calculation_method: 'manual_override', confidence: 'high', missing_information: null };
    }
    if (Array.isArray(chain_path) && chain_path.length && chain_path.every(step => step && step.percentage != null && step.percentage !== '')) {
        const multiplied = chain_path.reduce((acc, step) => acc * (parseFloat(step.percentage) / 100), 1) * 100;
        return {
            effective_percentage: Math.round(multiplied * 100) / 100, calculation_method: 'multiplied_chain', confidence: 'medium', missing_information: null,
        };
    }
    if (direct_percentage != null && direct_percentage !== '') {
        return { effective_percentage: parseFloat(direct_percentage), calculation_method: 'direct', confidence: 'high', missing_information: null };
    }
    return {
        effective_percentage: null, calculation_method: 'unknown', confidence: 'unknown',
        missing_information: 'Insufficient data to calculate effective percentage — provide direct_percentage, a fully-populated chain_path (every step needs a percentage), or a manual effective_percentage.',
    };
}

// ─── Reportable Logic — deterministic, no guessing ─────────────────────────────

function _calcReportable({ is_natural_person, effective_percentage, force_reportable, thresholdPct }) {
    let thresholdMet = null; // unknown by default — never assume false when data is missing
    if (effective_percentage != null) thresholdMet = effective_percentage >= thresholdPct;

    let isReportable = false;
    if (is_natural_person && thresholdMet === true) isReportable = true;
    if (force_reportable === true) isReportable = true; // manager-marked control-type reportability, regardless of percentage

    return { reporting_threshold_met: thresholdMet, is_reportable: isReportable };
}

// ─── Readiness Logic ────────────────────────────────────────────────────────────

// Deterministic default item generation per owner/chain characteristics.
// Idempotent by design: only inserts items that don't already exist for the
// same (beneficial_owner_id | ownership_chain_id, item_type) pair, so it is
// safe to re-run as new owners/chains are added later — unlike a one-shot
// generator, there is no "already generated, blocked" wall to work around.
async function _generateReadinessItems(cid, clientId, actorUserId) {
    const [ownersRes, chainsRes, existingRes] = await Promise.all([
        supabase.from('practice_beneficial_owners').select('*').eq('company_id', cid).eq('client_id', clientId).neq('status', 'archived'),
        supabase.from('practice_ownership_chains').select('*').eq('company_id', cid).eq('client_id', clientId).neq('chain_status', 'archived'),
        supabase.from('practice_bo_readiness_items').select('beneficial_owner_id, ownership_chain_id, item_type').eq('company_id', cid).eq('client_id', clientId),
    ]);
    const owners = ownersRes.data || [];
    const chains = chainsRes.data || [];
    const existing = existingRes.data || [];
    const existingKey = (ownerId, chainId, type) => `${ownerId || ''}|${chainId || ''}|${type}`;
    const existingSet = new Set(existing.map(e => existingKey(e.beneficial_owner_id, e.ownership_chain_id, e.item_type)));

    const toInsert = [];
    const addItem = (ownerId, chainId, itemType, itemName) => {
        const key = existingKey(ownerId, chainId, itemType);
        if (existingSet.has(key)) return;
        existingSet.add(key);
        toInsert.push({ company_id: cid, client_id: clientId, beneficial_owner_id: ownerId || null, ownership_chain_id: chainId || null, item_type: itemType, item_name: itemName, required: true, status: 'required' });
    };

    for (const o of owners) {
        addItem(o.id, null, 'owner_identity', `Confirm identity of ${o.owner_name}`);
        if (o.owner_type === 'natural_person') addItem(o.id, null, 'owner_address', `Confirm residential address of ${o.owner_name}`);
        if (o.owner_type === 'company') addItem(o.id, null, 'company_register', `Company register / CIPC disclosure for ${o.owner_name}`);
        if (o.owner_type === 'trust') addItem(o.id, null, 'trust_deed', `Trust deed for ${o.owner_name}`);
        if (o.owner_type === 'nominee') addItem(o.id, null, 'nominee_declaration', `Nominee declaration for ${o.owner_name}`);
        if (o.is_reportable) addItem(o.id, null, 'ownership_percentage', `Confirm effective percentage for ${o.owner_name}`);
    }
    for (const c of chains) {
        addItem(null, c.id, 'chain_support', `Supporting documentation for ownership chain: ${c.chain_name}`);
    }
    // One client-level review item, not tied to a specific owner/chain.
    addItem(null, null, 'review', 'Manager review of Beneficial Ownership register');

    if (!toInsert.length) return [];
    const { data, error } = await supabase.from('practice_bo_readiness_items').insert(toInsert).select();
    if (error) throw new Error(error.message);

    await Promise.all(data.map(item => _writeEvent(cid, clientId, 'readiness_item', item.id, 'readiness_item_created', null, item.status, actorUserId, item.item_name, {})));
    return data;
}

// Pure computation over current item statuses — never stored, always
// recomputed live so it can never drift from the underlying items.
function _computeReadiness(items) {
    const required = items.filter(i => i.required && i.status !== 'not_applicable');
    if (!required.length) return { score: 0, status: 'unknown', done_count: 0, required_count: 0, blocked_count: 0 };

    const blocked = required.filter(i => i.status === 'blocked');
    const done = required.filter(i => READINESS_DONE_STATUSES.includes(i.status));
    const score = Math.round((done.length / required.length) * 1000) / 10;

    let status;
    if (blocked.length) status = 'blocked';
    else if (score >= 85) status = 'ready';
    else if (score >= 50) status = 'partial';
    else status = 'incomplete';

    return { score, status, done_count: done.length, required_count: required.length, blocked_count: blocked.length };
}

// ─── BO Engine — getBeneficialOwnershipProfile() ───────────────────────────────
// Pure aggregation. Reuses practice_company_shareholders live — never copies
// or duplicates it.

async function getBeneficialOwnershipProfile(cid, clientId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    const [shareholdersRes, ownersRes, chainsRes, readinessRes] = await Promise.all([
        supabase.from('practice_company_shareholders').select('*').eq('company_id', cid).eq('client_id', clientId).eq('status', 'active'),
        supabase.from('practice_beneficial_owners').select('*').eq('company_id', cid).eq('client_id', clientId).neq('status', 'archived'),
        supabase.from('practice_ownership_chains').select('*').eq('company_id', cid).eq('client_id', clientId).neq('chain_status', 'archived'),
        supabase.from('practice_bo_readiness_items').select('*').eq('company_id', cid).eq('client_id', clientId),
    ]);

    const owners = ownersRes.data || [];
    const chains = chainsRes.data || [];
    const readinessItems = readinessRes.data || [];
    const readiness = _computeReadiness(readinessItems);

    const reportableOwners = owners.filter(o => o.is_reportable);
    const missingInfoOwners = owners.filter(o => o.effective_percentage == null);
    const missingInfoChains = chains.filter(c => c.effective_percentage == null || c.confidence === 'unknown');

    return {
        client,
        direct_shareholders: shareholdersRes.data || [],
        beneficial_owners: owners,
        ownership_chains: chains,
        readiness: { items: readinessItems, ...readiness },
        reportable_owners: reportableOwners,
        missing_information_count: missingInfoOwners.length + missingInfoChains.length,
        cipc_readiness_status: readiness.status,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [owners, chains, readinessItems] = await Promise.all([
            supabase.from('practice_beneficial_owners').select('status, is_reportable, is_natural_person, client_id').eq('company_id', cid),
            supabase.from('practice_ownership_chains').select('chain_status, confidence, client_id').eq('company_id', cid),
            supabase.from('practice_bo_readiness_items').select('client_id, status, required').eq('company_id', cid),
        ]);

        const ownerRows = owners.data || [];
        const chainRows = chains.data || [];
        const readinessRows = readinessItems.data || [];

        const statusCounts = {}; OWNER_STATUSES.forEach(s => { statusCounts[s] = 0; });
        ownerRows.forEach(o => { if (o.status in statusCounts) statusCounts[o.status]++; });

        // Per-client readiness status, computed the same way getBeneficialOwnershipProfile() does.
        const byClient = {};
        readinessRows.forEach(r => { if (!byClient[r.client_id]) byClient[r.client_id] = []; byClient[r.client_id].push(r); });
        let readyCount = 0, partialCount = 0, incompleteCount = 0, blockedCount = 0, unknownCount = 0;
        const clientsWithBO = new Set([...ownerRows.map(o => o.client_id), ...chainRows.map(c => c.client_id)]);
        clientsWithBO.forEach(clientId => {
            const r = _computeReadiness(byClient[clientId] || []);
            if (r.status === 'ready') readyCount++;
            else if (r.status === 'partial') partialCount++;
            else if (r.status === 'incomplete') incompleteCount++;
            else if (r.status === 'blocked') blockedCount++;
            else unknownCount++;
        });

        res.json({
            owners_total: ownerRows.length,
            owners_by_status: statusCounts,
            reportable_owners: ownerRows.filter(o => o.is_reportable).length,
            natural_person_owners: ownerRows.filter(o => o.is_natural_person).length,
            chains_total: chainRows.length,
            chains_low_confidence: chainRows.filter(c => c.confidence === 'low' || c.confidence === 'unknown').length,
            clients_with_bo_records: clientsWithBO.size,
            readiness: { ready: readyCount, partial: partialCount, incomplete: incompleteCount, blocked: blockedCount, unknown: unknownCount },
        });
    } catch (err) {
        console.error('Beneficial-ownership /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT BO PROFILE
// ═══════════════════════════════════════════════════════════════════════════

router.get('/client/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    try {
        const result = await getBeneficialOwnershipProfile(cid, clientId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.json(result);
    } catch (err) {
        console.error('Beneficial-ownership GET /client/:clientId error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// BENEFICIAL OWNERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/owners', async (req, res) => {
    const cid = req.companyId;
    const { client_id, owner_type, status, verification_status, is_reportable, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_beneficial_owners').select('*', { count: 'exact' }).eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (owner_type) q = q.eq('owner_type', owner_type);
        if (status) q = q.eq('status', status);
        if (verification_status) q = q.eq('verification_status', verification_status);
        if (is_reportable !== undefined) q = q.eq('is_reportable', is_reportable === 'true');

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, parseInt(limit) || 50);
        const from = (pageNum - 1) * limitNum;
        q = q.range(from, from + limitNum - 1);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(o => o.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }

        res.json({ owners: (data || []).map(o => ({ ...o, client_name: nameById[o.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Beneficial-ownership GET owners error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/owners', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const {
        client_id, owner_type, owner_name, id_number, registration_number, trust_number, tax_number, nationality, country_of_residence,
        control_type, direct_percentage, effective_percentage, is_natural_person, force_reportable, source_note, notes,
    } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!OWNER_TYPES.includes(owner_type)) return res.status(400).json({ error: 'Invalid owner_type' });
    if (!owner_name) return res.status(400).json({ error: 'owner_name is required' });
    if (!CONTROL_TYPES.includes(control_type)) return res.status(400).json({ error: 'Invalid control_type' });

    const isNaturalPerson = is_natural_person != null ? !!is_natural_person : owner_type === 'natural_person';
    const pct = _calcEffectivePercentage({ effective_percentage, direct_percentage, chain_path: null });
    const thresholdPct = (req.body.settings && req.body.settings.reporting_threshold_pct) || DEFAULT_REPORTING_THRESHOLD_PCT;
    const reportable = _calcReportable({ is_natural_person: isNaturalPerson, effective_percentage: pct.effective_percentage, force_reportable, thresholdPct });

    try {
        const { data, error } = await supabase.from('practice_beneficial_owners').insert({
            company_id: cid, client_id: clientId, owner_type, owner_name,
            id_number: id_number || null, registration_number: registration_number || null, trust_number: trust_number || null,
            tax_number: tax_number || null, nationality: nationality || null, country_of_residence: country_of_residence || null,
            control_type, direct_percentage: direct_percentage != null ? parseFloat(direct_percentage) : null,
            effective_percentage: pct.effective_percentage, is_natural_person: isNaturalPerson,
            is_reportable: reportable.is_reportable, reporting_threshold_met: reportable.reporting_threshold_met,
            source_note: source_note || null, notes: notes || null,
            settings: Object.assign({ reporting_threshold_pct: thresholdPct }, req.body.settings || {}),
            created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'beneficial_owner', data.id, 'bo_owner_created', null, data.status, req.user.userId, owner_name, { calculation_method: pct.calculation_method });
        res.status(201).json({ owner: data, calculation: pct });
    } catch (err) {
        console.error('Beneficial-ownership POST owners error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/owners/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid owner ID' });
    try {
        const { data, error } = await supabase.from('practice_beneficial_owners').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Beneficial owner not found' });
        res.json({ owner: data });
    } catch (err) {
        console.error('Beneficial-ownership GET owner error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/owners/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid owner ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_beneficial_owners').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Beneficial owner not found' });
    const o = existing.data;

    const allowed = [
        'owner_type', 'owner_name', 'id_number', 'registration_number', 'trust_number', 'tax_number', 'nationality', 'country_of_residence',
        'control_type', 'direct_percentage', 'effective_percentage', 'is_natural_person', 'force_reportable',
        'status', 'verification_status', 'source_note', 'verification_notes', 'notes', 'internal_notes', 'settings',
    ];
    const update = _pick(req.body, allowed);
    if (update.owner_type && !OWNER_TYPES.includes(update.owner_type)) return res.status(400).json({ error: 'Invalid owner_type' });
    if (update.control_type && !CONTROL_TYPES.includes(update.control_type)) return res.status(400).json({ error: 'Invalid control_type' });
    if (update.status && !OWNER_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'verified' || update.status === 'archived') return res.status(400).json({ error: 'Use the dedicated /verify or /archive endpoints for those transitions.' });
    if (update.verification_status && !VERIFICATION_STATUSES.includes(update.verification_status)) return res.status(400).json({ error: 'Invalid verification_status' });

    // Recompute percentage/reportable whenever any input to those calculations changes.
    const percentageInputsTouched = ['direct_percentage', 'effective_percentage'].some(k => k in update);
    const forceReportableProvided = 'force_reportable' in update;
    if (percentageInputsTouched || forceReportableProvided) {
        const directPct = 'direct_percentage' in update ? update.direct_percentage : o.direct_percentage;
        const effPct = 'effective_percentage' in update ? update.effective_percentage : undefined;
        const pct = _calcEffectivePercentage({ effective_percentage: effPct, direct_percentage: directPct, chain_path: null });
        const isNaturalPerson = 'is_natural_person' in update ? update.is_natural_person : o.is_natural_person;
        const thresholdPct = (o.settings && o.settings.reporting_threshold_pct) || DEFAULT_REPORTING_THRESHOLD_PCT;
        const forceReportable = forceReportableProvided ? update.force_reportable : undefined;
        const reportable = _calcReportable({ is_natural_person: isNaturalPerson, effective_percentage: pct.effective_percentage, force_reportable: forceReportable, thresholdPct });
        update.effective_percentage = pct.effective_percentage;
        update.reporting_threshold_met = reportable.reporting_threshold_met;
        update.is_reportable = reportable.is_reportable;
    }
    delete update.force_reportable; // not a stored column — only used to drive is_reportable above

    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_beneficial_owners').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, o.client_id, 'beneficial_owner', id, 'bo_owner_updated', o.status, data.status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ owner: data });
    } catch (err) {
        console.error('Beneficial-ownership PUT owner error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/owners/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid owner ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_beneficial_owners').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Beneficial owner not found' });
    if (existing.data.status === 'archived') return res.status(400).json({ error: 'Owner is already archived.' });

    try {
        const { data, error } = await supabase.from('practice_beneficial_owners')
            .update({ status: 'archived', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'beneficial_owner', id, 'bo_owner_archived', existing.data.status, 'archived', req.user.userId, req.body.reason || null, {});
        res.json({ owner: data });
    } catch (err) {
        console.error('Beneficial-ownership DELETE owner error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/owners/:id/verify', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid owner ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_beneficial_owners').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Beneficial owner not found' });
    if (existing.data.status === 'archived') return res.status(400).json({ error: 'Cannot verify an archived owner.' });

    try {
        const { data, error } = await supabase.from('practice_beneficial_owners')
            .update({ status: 'verified', verification_status: 'verified', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'beneficial_owner', id, 'bo_owner_verified', existing.data.status, 'verified', req.user.userId, null, {});
        res.json({ owner: data });
    } catch (err) {
        console.error('Beneficial-ownership verify owner error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/owners/:id/archive', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid owner ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_beneficial_owners').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Beneficial owner not found' });
    if (existing.data.status === 'archived') return res.status(400).json({ error: 'Owner is already archived.' });

    try {
        const { data, error } = await supabase.from('practice_beneficial_owners')
            .update({ status: 'archived', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'beneficial_owner', id, 'bo_owner_archived', existing.data.status, 'archived', req.user.userId, req.body.reason || null, {});
        res.json({ owner: data });
    } catch (err) {
        console.error('Beneficial-ownership archive owner error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// OWNERSHIP CHAINS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/chains', async (req, res) => {
    const cid = req.companyId;
    const { client_id, chain_status, confidence, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_ownership_chains').select('*', { count: 'exact' }).eq('company_id', cid).order('created_at', { ascending: false });
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (chain_status) q = q.eq('chain_status', chain_status);
        if (confidence) q = q.eq('confidence', confidence);

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

        res.json({ chains: (data || []).map(c => ({ ...c, client_name: nameById[c.client_id] || null })), total: count || 0 });
    } catch (err) {
        console.error('Beneficial-ownership GET chains error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/chains', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, chain_name, root_holder_type, root_holder_name, root_holder_reference_id, ultimate_owner_id, chain_path, effective_percentage, direct_percentage, notes } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!ROOT_HOLDER_TYPES.includes(root_holder_type)) return res.status(400).json({ error: 'Invalid root_holder_type' });
    if (!chain_name) return res.status(400).json({ error: 'chain_name is required' });
    if (!root_holder_name) return res.status(400).json({ error: 'root_holder_name is required' });

    if (root_holder_reference_id) {
        const { data: sh } = await supabase.from('practice_company_shareholders').select('id').eq('id', root_holder_reference_id).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        if (!sh) return res.status(400).json({ error: 'root_holder_reference_id does not match an existing shareholder for this client.' });
    }
    if (ultimate_owner_id) {
        const { data: bo } = await supabase.from('practice_beneficial_owners').select('id').eq('id', ultimate_owner_id).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        if (!bo) return res.status(400).json({ error: 'ultimate_owner_id does not match an existing beneficial owner for this client.' });
    }

    const parsedChainPath = Array.isArray(chain_path) ? chain_path : [];
    const pct = _calcEffectivePercentage({ effective_percentage, direct_percentage, chain_path: parsedChainPath });

    try {
        const { data, error } = await supabase.from('practice_ownership_chains').insert({
            company_id: cid, client_id: clientId, chain_name, root_holder_type, root_holder_name,
            root_holder_reference_id: root_holder_reference_id ? parseInt(root_holder_reference_id) : null,
            ultimate_owner_id: ultimate_owner_id ? parseInt(ultimate_owner_id) : null,
            chain_path: parsedChainPath, direct_percentage: direct_percentage != null ? parseFloat(direct_percentage) : null,
            effective_percentage: pct.effective_percentage, calculation_method: pct.calculation_method, confidence: pct.confidence,
            missing_information: pct.missing_information, notes: notes || null, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, clientId, 'ownership_chain', data.id, 'ownership_chain_created', null, data.chain_status, req.user.userId, chain_name, { calculation_method: pct.calculation_method });
        res.status(201).json({ chain: data, calculation: pct });
    } catch (err) {
        console.error('Beneficial-ownership POST chains error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/chains/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid chain ID' });
    try {
        const { data, error } = await supabase.from('practice_ownership_chains').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Ownership chain not found' });
        res.json({ chain: data });
    } catch (err) {
        console.error('Beneficial-ownership GET chain error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/chains/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid chain ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_ownership_chains').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Ownership chain not found' });
    const c = existing.data;

    const allowed = [
        'chain_name', 'chain_status', 'root_holder_type', 'root_holder_name', 'root_holder_reference_id', 'ultimate_owner_id',
        'chain_path', 'direct_percentage', 'effective_percentage', 'missing_information', 'notes', 'internal_notes', 'settings',
    ];
    const update = _pick(req.body, allowed);
    if (update.root_holder_type && !ROOT_HOLDER_TYPES.includes(update.root_holder_type)) return res.status(400).json({ error: 'Invalid root_holder_type' });
    if (update.chain_status && !CHAIN_STATUSES.includes(update.chain_status)) return res.status(400).json({ error: 'Invalid chain_status' });
    if (update.chain_status === 'verified' || update.chain_status === 'archived') return res.status(400).json({ error: 'Use the dedicated /verify or /archive endpoints for those transitions.' });

    if (update.ultimate_owner_id) {
        const { data: bo } = await supabase.from('practice_beneficial_owners').select('id').eq('id', update.ultimate_owner_id).eq('company_id', cid).eq('client_id', c.client_id).maybeSingle();
        if (!bo) return res.status(400).json({ error: 'ultimate_owner_id does not match an existing beneficial owner for this client.' });
    }

    const percentageInputsTouched = ['direct_percentage', 'effective_percentage', 'chain_path'].some(k => k in update);
    if (percentageInputsTouched) {
        const chainPath = 'chain_path' in update ? update.chain_path : c.chain_path;
        const directPct = 'direct_percentage' in update ? update.direct_percentage : c.direct_percentage;
        const effPct = 'effective_percentage' in update ? update.effective_percentage : undefined;
        const pct = _calcEffectivePercentage({ effective_percentage: effPct, direct_percentage: directPct, chain_path: chainPath });
        update.effective_percentage = pct.effective_percentage;
        update.calculation_method = pct.calculation_method;
        update.confidence = pct.confidence;
        update.missing_information = pct.missing_information;
    }
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_ownership_chains').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, c.client_id, 'ownership_chain', id, 'ownership_chain_updated', c.chain_status, data.chain_status, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ chain: data });
    } catch (err) {
        console.error('Beneficial-ownership PUT chain error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/chains/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid chain ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_ownership_chains').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Ownership chain not found' });
    if (existing.data.chain_status === 'archived') return res.status(400).json({ error: 'Chain is already archived.' });

    try {
        const { data, error } = await supabase.from('practice_ownership_chains')
            .update({ chain_status: 'archived', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'ownership_chain', id, 'ownership_chain_archived', existing.data.chain_status, 'archived', req.user.userId, req.body.reason || null, {});
        res.json({ chain: data });
    } catch (err) {
        console.error('Beneficial-ownership DELETE chain error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/chains/:id/verify', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid chain ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_ownership_chains').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Ownership chain not found' });
    if (existing.data.chain_status === 'archived') return res.status(400).json({ error: 'Cannot verify an archived chain.' });

    try {
        const { data, error } = await supabase.from('practice_ownership_chains')
            .update({ chain_status: 'verified', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'ownership_chain', id, 'ownership_chain_verified', existing.data.chain_status, 'verified', req.user.userId, null, {});
        res.json({ chain: data });
    } catch (err) {
        console.error('Beneficial-ownership verify chain error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/chains/:id/archive', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid chain ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_ownership_chains').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Ownership chain not found' });
    if (existing.data.chain_status === 'archived') return res.status(400).json({ error: 'Chain is already archived.' });

    try {
        const { data, error } = await supabase.from('practice_ownership_chains')
            .update({ chain_status: 'archived', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'ownership_chain', id, 'ownership_chain_archived', existing.data.chain_status, 'archived', req.user.userId, req.body.reason || null, {});
        res.json({ chain: data });
    } catch (err) {
        console.error('Beneficial-ownership archive chain error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// READINESS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/client/:clientId/readiness', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_bo_readiness_items').select('*').eq('company_id', cid).eq('client_id', clientId).order('item_type');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ items: data || [], ..._computeReadiness(data || []) });
    } catch (err) {
        console.error('Beneficial-ownership GET readiness error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/client/:clientId/generate-readiness', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const created = await _generateReadinessItems(cid, clientId, req.user.userId);
        res.status(201).json({ created_count: created.length, items: created });
    } catch (err) {
        console.error('Beneficial-ownership generate-readiness error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/readiness/:itemId', async (req, res) => {
    const cid = req.companyId;
    const itemId = parseInt(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'Invalid readiness item ID' });

    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_bo_readiness_items').select('*').eq('id', itemId).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Readiness item not found' });

    const allowed = ['item_name', 'item_type', 'status', 'required', 'due_date', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.item_type && !READINESS_ITEM_TYPES.includes(update.item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (update.status && !READINESS_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_bo_readiness_items').update(update).eq('id', itemId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, existing.data.client_id, 'readiness_item', itemId, 'readiness_item_updated', existing.data.status, data.status, req.user.userId, existing.data.item_name, {});
        res.json({ item: data });
    } catch (err) {
        console.error('Beneficial-ownership PUT readiness item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/client/:clientId/recalculate-readiness', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
        const { data, error } = await supabase.from('practice_bo_readiness_items').select('*').eq('company_id', cid).eq('client_id', clientId);
        if (error) return res.status(500).json({ error: error.message });

        const result = _computeReadiness(data || []);
        // bo_readiness_recalculated is a client-level event, not tied to one
        // readiness_item row — the schema's source_type enum has no 'client'
        // option, so source_type='readiness_item' is reused with source_id
        // set to clientId (no FK constraint per Codebox 41 convention). The
        // event's own client_id column is the reliable field for filtering;
        // source_id here is a placeholder, not a real readiness_item id.
        await _writeEvent(cid, clientId, 'readiness_item', clientId, 'bo_readiness_recalculated', null, result.status, req.user.userId, null, result);
        res.json({ items: data || [], ...result });
    } catch (err) {
        console.error('Beneficial-ownership recalculate-readiness error:', err.message);
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
        let q = supabase.from('practice_beneficial_ownership_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Beneficial-ownership GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:sourceType/:sourceId/events', async (req, res) => {
    const cid = req.companyId;
    const sourceType = req.params.sourceType;
    const sourceId = parseInt(req.params.sourceId);
    if (!['beneficial_owner', 'ownership_chain', 'readiness_item'].includes(sourceType)) return res.status(400).json({ error: 'Invalid sourceType' });
    if (!sourceId) return res.status(400).json({ error: 'Invalid sourceId' });

    try {
        const { data, error } = await supabase.from('practice_beneficial_ownership_events').select('*')
            .eq('company_id', cid).eq('source_type', sourceType).eq('source_id', sourceId).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Beneficial-ownership GET source events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/65_beneficial_ownership.md
module.exports.getBeneficialOwnershipProfile = getBeneficialOwnershipProfile;

// Codebox 66 — secretarial-evidence.js delegates BO checklist generation
// here instead of re-tracking BO evidence items in its own tables ("BO
// readiness uses evidence completion, no duplicate readiness logic").
// Purely additive export — zero change to any existing route's behavior.
module.exports.generateReadinessItems = _generateReadinessItems;

// Codebox 69 — secretarial-integrity.js reuses this exact readiness
// computation over a bulk-fetched, per-client-grouped items array instead of
// re-implementing the score/status thresholds a second time for its
// company-wide audit scan. Purely additive export — zero change to any
// existing route's behavior.
module.exports.computeReadinessFromItems = _computeReadiness;
