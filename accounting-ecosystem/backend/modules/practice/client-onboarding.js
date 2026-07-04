'use strict';

// Codebox 70 — Practice Client Onboarding + Entity Formation Foundation
// "What is still required before this client is fully operational?"
//
// NOT CIPC incorporation. NOT SARS registration. NOT banking integration.
// NOT a client portal. This module prepares the Practice to perform those
// activities — it builds an internal onboarding workspace over an EXISTING
// practice_clients row and tracks progress toward "fully operational."
//
// Reuse over duplication, one step further than every prior codebox: rather
// than re-implement the get-or-create pattern for each of the Secretarial
// suite's per-client profiles, this module calls directly into the OTHER
// modules' own idempotent helpers (secretarial.getOrInitProfile,
// entityLifecycle.getEntityLifecycleProfile, clientSuccess.getOrInitSuccessRow,
// beneficialOwnership.generateReadinessItems, secretarialEvidence.
// ensureDefaultTemplates — the last three newly exported additively for this
// codebox). See buildOnboardingWorkspace() below and docs/new-app/
// 70_client_onboarding.md for exactly which modules are TRUE initializers
// (idempotent create-if-missing) vs. DETECTION-ONLY (never auto-created,
// because a sensible value cannot be set without guessing).

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const secretarial = require('./secretarial');
const entityLifecycle = require('./entity-lifecycle');
const clientSuccess = require('./client-success');
const beneficialOwnership = require('./beneficial-ownership');
const secretarialEvidence = require('./secretarial-evidence');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const ENTITY_TYPES = ['pty_ltd', 'cc', 'trust', 'partnership', 'sole_proprietor', 'npc', 'other'];
const ONBOARDING_STATUSES = ['draft', 'information_collection', 'document_collection', 'secretarial_setup', 'tax_setup', 'practice_setup', 'review', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped', 'blocked'];
const CHECKLIST_ITEM_TYPES = ['information', 'document', 'registration', 'secretarial', 'tax', 'practice', 'review', 'custom'];

// entity_type values match practice_secretarial_profiles.company_type
// exactly (both pty_ltd/cc/npc/trust/partnership/sole_proprietor/other) — no
// translation needed. practice_entity_lifecycle_profiles.entity_category
// uses different spellings for 3 of the 7 values — see migration 125's own
// enum vs. this module's ENTITY_TYPES. Mapped once here.
const ENTITY_TYPE_TO_LIFECYCLE_CATEGORY = {
    pty_ltd: 'company', cc: 'close_corporation', npc: 'non_profit',
    trust: 'trust', partnership: 'partnership', sole_proprietor: 'sole_proprietor', other: 'other',
};

// The 13 named steps, in order — exactly as specified.
const STEP_DEFAULTS = [
    'Client accepted', 'Engagement signed', 'Information received', 'Documents received',
    'Secretarial initialized', 'Entity lifecycle created', 'BO initialized', 'Evidence initialized',
    'Statutory calendar initialized', 'Tax profile created', 'Practice setup completed',
    'Review completed', 'Go-live approved',
];
// Steps auto-completed by buildOnboardingWorkspace() when the corresponding
// module is successfully initialized (created or already existed) — the
// rest are always manager-completed manually via PUT /steps/:id.
const AUTO_COMPLETABLE_STEPS = {
    'Secretarial initialized': 'secretarial',
    'Entity lifecycle created': 'entity_lifecycle',
    'BO initialized': 'beneficial_ownership',
    'Evidence initialized': 'evidence_templates',
};

// Deterministic, developer-authored per-entity-type onboarding checklists —
// the spec names PTY/Trust/NPC/Sole Proprietor as examples, not exact item
// lists. See docs/new-app/70_client_onboarding.md Architect Freedom.
function _item(name, type) { return { item_name: name, item_type: type }; }
const ONBOARDING_CHECKLIST_DEFAULTS = {
    pty_ltd: [
        _item('Certified ID copies of directors', 'document'),
        _item('Proof of registered address', 'document'),
        _item('CIPC registration documents', 'document'),
        _item('Director register captured', 'information'),
        _item('Shareholder register captured', 'information'),
        _item('Beneficial ownership information captured', 'information'),
        _item('Engagement letter signed', 'practice'),
        _item('Tax registration numbers captured', 'tax'),
        _item('Banking details captured', 'information'),
        _item('SARS eFiling access confirmed', 'tax'),
    ],
    trust: [
        _item('Certified ID copies of trustees', 'document'),
        _item('Trust deed obtained', 'document'),
        _item('Proof of registered address', 'document'),
        _item('Trustee register captured', 'information'),
        _item('Beneficiary information captured', 'information'),
        _item('Engagement letter signed', 'practice'),
        _item('Tax registration numbers captured', 'tax'),
    ],
    npc: [
        _item('Certified ID copies of directors/members', 'document'),
        _item('NPC registration documents', 'document'),
        _item('Proof of registered address', 'document'),
        _item('Director/member register captured', 'information'),
        _item('Engagement letter signed', 'practice'),
        _item('Tax exemption status confirmed', 'tax'),
    ],
    sole_proprietor: [
        _item('Certified ID copy of proprietor', 'document'),
        _item('Proof of address', 'document'),
        _item('Engagement letter signed', 'practice'),
        _item('Tax registration numbers captured', 'tax'),
    ],
    partnership: [
        _item('Certified ID copies of partners', 'document'),
        _item('Partnership agreement obtained', 'document'),
        _item('Proof of address', 'document'),
        _item('Partner register captured', 'information'),
        _item('Engagement letter signed', 'practice'),
        _item('Tax registration numbers captured', 'tax'),
    ],
};
// cc uses the same set as pty_ltd (both have a director + shareholder register).
ONBOARDING_CHECKLIST_DEFAULTS.cc = ONBOARDING_CHECKLIST_DEFAULTS.pty_ltd;
// other: minimal generic set.
ONBOARDING_CHECKLIST_DEFAULTS.other = [
    _item('Engagement letter signed', 'practice'),
    _item('Information captured', 'information'),
    _item('Documents received', 'document'),
];

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage client onboarding.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_onboarding_events').insert({
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

async function _getProfile(cid, clientId) {
    const { data } = await supabase.from('practice_onboarding_profiles').select('*').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    return data || null;
}

// ── Completion % — server-calculated only, never accepted from the client ───

async function _recomputeCompletion(cid, profileId) {
    const [stepsRes, checklistRes] = await Promise.all([
        supabase.from('practice_onboarding_steps').select('status').eq('company_id', cid).eq('profile_id', profileId),
        supabase.from('practice_onboarding_checklists').select('required, completed').eq('company_id', cid).eq('profile_id', profileId),
    ]);
    const steps = stepsRes.data || [];
    const checklist = checklistRes.data || [];

    const stepTotal = steps.length;
    const stepDone = steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const requiredItems = checklist.filter(c => c.required);
    const itemTotal = requiredItems.length;
    const itemDone = requiredItems.filter(c => c.completed).length;

    const totalUnits = stepTotal + itemTotal;
    const doneUnits = stepDone + itemDone;
    const pct = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0;

    await supabase.from('practice_onboarding_profiles').update({ completion_percentage: pct, updated_at: new Date().toISOString() }).eq('id', profileId).eq('company_id', cid);
    return pct;
}

// ── Onboarding Engine — buildOnboardingWorkspace() ───────────────────────────
// Creates the profile + 13 default steps + entity-type checklist on first
// call, then initializes (or detects) the Secretarial suite's per-client
// records. Every sub-step is independently wrapped so one failing
// initializer never blocks the rest — "No silent initialization" per the
// spec, paired with "one failure must never stop the whole workspace build,"
// the same discipline established in Codebox 69's audit engine.

async function _safeInit(label, fn) {
    try { return await fn(); } catch (e) { console.error(`[client-onboarding] initializer "${label}" failed:`, e.message); return { module: label, status: 'error', detail: e.message }; }
}

async function buildOnboardingWorkspace(cid, clientId, entityType, actorUserId) {
    const client = await _verifyClient(cid, clientId);
    if (!client) return null;

    let profile = await _getProfile(cid, clientId);
    let justCreated = false;
    if (!profile) {
        const { data: created, error } = await supabase.from('practice_onboarding_profiles')
            .insert({ company_id: cid, client_id: clientId, entity_type: entityType, created_by: actorUserId }).select().single();
        if (error) throw new Error(error.message);
        profile = created;
        justCreated = true;
        await _writeEvent(cid, clientId, 'profile', profile.id, 'profile_created', null, profile.onboarding_status, actorUserId, null, { entity_type: entityType });
    }

    // Steps — created once, idempotent (only inserts if none exist yet).
    const { count: stepCount } = await supabase.from('practice_onboarding_steps').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('profile_id', profile.id);
    let steps = [];
    if (!stepCount) {
        const rows = STEP_DEFAULTS.map((name, i) => ({ company_id: cid, client_id: clientId, profile_id: profile.id, step_name: name, sort_order: i }));
        const { data, error } = await supabase.from('practice_onboarding_steps').insert(rows).select();
        if (error) throw new Error(error.message);
        steps = data || [];
        await Promise.all(steps.map(s => _writeEvent(cid, clientId, 'step', s.id, 'step_created', null, s.status, actorUserId, s.step_name, {})));
    } else {
        const { data } = await supabase.from('practice_onboarding_steps').select('*').eq('company_id', cid).eq('profile_id', profile.id);
        steps = data || [];
    }

    // Checklist — generated once per entity_type, idempotent (only if the
    // checklist is currently empty; regeneration is a separate, explicit
    // manager action — see POST /profiles/:clientId/checklist/generate).
    const { count: checklistCount } = await supabase.from('practice_onboarding_checklists').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('profile_id', profile.id);
    if (!checklistCount) {
        await _generateChecklist(cid, clientId, profile, actorUserId, false);
    }

    // Cross-module initialization — each independently fault-tolerant.
    const initResults = [];
    initResults.push(await _safeInit('secretarial', () => _initSecretarial(cid, clientId, entityType, actorUserId)));
    initResults.push(await _safeInit('entity_lifecycle', () => _initEntityLifecycle(cid, clientId, entityType)));
    initResults.push(await _safeInit('client_success', () => _initClientSuccess(cid, clientId)));
    initResults.push(await _safeInit('beneficial_ownership', () => _initBeneficialOwnership(cid, clientId, actorUserId)));
    initResults.push(await _safeInit('evidence_templates', () => _initEvidenceTemplates(cid, actorUserId)));

    // Auto-complete the matching step for any initializer that succeeded
    // (created or already existed — both mean "the module is ready").
    for (const stepName of Object.keys(AUTO_COMPLETABLE_STEPS)) {
        const moduleName = AUTO_COMPLETABLE_STEPS[stepName];
        const result = initResults.find(r => r.module === moduleName);
        if (!result || result.status === 'error') continue;
        const step = steps.find(s => s.step_name === stepName);
        if (step && step.status !== 'completed') {
            await _completeStep(cid, clientId, step, actorUserId, `Auto-completed — ${moduleName} ${result.status}.`);
        }
    }

    await _recomputeCompletion(cid, profile.id);
    const refreshedProfile = await _getProfile(cid, clientId);

    return { profile: refreshedProfile, just_created: justCreated, module_initialization: initResults };
}

async function _completeStep(cid, clientId, step, actorUserId, notes) {
    const { data, error } = await supabase.from('practice_onboarding_steps')
        .update({ status: 'completed', completed_by: actorUserId, completed_at: new Date().toISOString(), notes: notes || step.notes })
        .eq('id', step.id).eq('company_id', cid).select().single();
    if (error) throw new Error(error.message);
    await _writeEvent(cid, clientId, 'step', step.id, 'step_completed', step.status, 'completed', actorUserId, notes || null, {});
    return data;
}

async function _generateChecklist(cid, clientId, profile, actorUserId, force) {
    if (force) {
        // Regeneration only ADDS missing items — never removes or resets
        // existing ones, matching the migration's own comment.
    }
    const { data: existing } = await supabase.from('practice_onboarding_checklists').select('item_name').eq('company_id', cid).eq('profile_id', profile.id);
    const existingNames = new Set((existing || []).map(i => i.item_name));
    const defaults = ONBOARDING_CHECKLIST_DEFAULTS[profile.entity_type] || ONBOARDING_CHECKLIST_DEFAULTS.other;
    const toInsert = defaults.filter(d => !existingNames.has(d.item_name)).map((d, i) => ({
        company_id: cid, client_id: clientId, profile_id: profile.id, item_name: d.item_name, item_type: d.item_type, sort_order: (existing || []).length + i,
    }));
    if (!toInsert.length) return [];
    const { data, error } = await supabase.from('practice_onboarding_checklists').insert(toInsert).select();
    if (error) throw new Error(error.message);
    await _writeEvent(cid, clientId, 'profile', profile.id, 'checklist_generated', null, null, actorUserId, null, { count: data.length, entity_type: profile.entity_type });
    return data;
}

// ── TRUE Initializers — idempotent create-if-missing, no guessed data ───────

async function _initSecretarial(cid, clientId, entityType, actorUserId) {
    const { data: existing } = await supabase.from('practice_secretarial_profiles').select('id, company_type').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return { module: 'secretarial', status: 'existing', detail: { id: existing.id } };
    const { data: created, error } = await supabase.from('practice_secretarial_profiles')
        .insert({ company_id: cid, client_id: clientId, company_type: entityType, created_by: actorUserId }).select().single();
    if (error) throw new Error(error.message);
    return { module: 'secretarial', status: 'created', detail: { id: created.id } };
}

async function _initEntityLifecycle(cid, clientId, entityType) {
    const { data: existing } = await supabase.from('practice_entity_lifecycle_profiles').select('id, current_lifecycle_status').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return { module: 'entity_lifecycle', status: 'existing', detail: { id: existing.id, current_status: existing.current_lifecycle_status } };
    // getEntityLifecycleProfile() lazily creates with entity_category
    // defaulting to 'company' — we want the onboarding's known entity_type
    // reflected on FIRST creation, so we insert directly here rather than
    // reuse that helper for the create path (see docs Architect Freedom).
    const { data: created, error } = await supabase.from('practice_entity_lifecycle_profiles')
        .insert({ company_id: cid, client_id: clientId, entity_category: ENTITY_TYPE_TO_LIFECYCLE_CATEGORY[entityType] || 'other' }).select().single();
    if (error) throw new Error(error.message);
    return { module: 'entity_lifecycle', status: 'created', detail: { id: created.id, current_status: created.current_lifecycle_status } };
}

async function _initClientSuccess(cid, clientId) {
    const { data: existing } = await supabase.from('practice_client_success').select('id').eq('company_id', cid).eq('client_id', clientId).maybeSingle();
    if (existing) return { module: 'client_success', status: 'existing', detail: { id: existing.id } };
    const row = await clientSuccess.getOrInitSuccessRow(cid, clientId);
    return { module: 'client_success', status: 'created', detail: { id: row.id } };
}

async function _initBeneficialOwnership(cid, clientId, actorUserId) {
    const { count: before } = await supabase.from('practice_bo_readiness_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId);
    const created = await beneficialOwnership.generateReadinessItems(cid, clientId, actorUserId);
    return { module: 'beneficial_ownership', status: (before || 0) > 0 ? 'existing' : 'created', detail: { items_created: created.length } };
}

async function _initEvidenceTemplates(cid, actorUserId) {
    const { count: before } = await supabase.from('practice_secretarial_evidence_templates').select('id', { count: 'exact', head: true }).eq('company_id', cid);
    await secretarialEvidence.ensureDefaultTemplates(cid, actorUserId);
    const { count: after } = await supabase.from('practice_secretarial_evidence_templates').select('id', { count: 'exact', head: true }).eq('company_id', cid);
    return { module: 'evidence_templates', status: (after || 0) > (before || 0) ? 'created' : 'existing', detail: { templates_total: after || 0 } };
}

// ── DETECTION-ONLY Reads — never auto-created (would require guessing) ─────
// Statutory obligations need a registration_date/financial_year_end due_rule
// anchor; Evidence checklists need a triggering source event; Integrity
// findings are only ever produced by an explicit "Run Audit" (Codebox 69);
// Risk Register entries need a human likelihood/impact judgment; Knowledge
// Links need a human-picked relevant article. None of these can be safely
// fabricated — see docs/new-app/70_client_onboarding.md.

async function _detectModules(cid, clientId) {
    const [obligations, evidenceChecklists, integrityFindings, riskEntries, knowledgeLinks, taxpayerProfiles] = await Promise.all([
        supabase.from('practice_statutory_obligations').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId),
        supabase.from('practice_secretarial_evidence_checklists').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId),
        supabase.from('practice_secretarial_integrity_findings').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId).eq('status', 'open'),
        supabase.from('practice_risks').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('linked_client_id', clientId),
        supabase.from('practice_knowledge_links').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('linked_type', 'client').eq('linked_id', clientId),
        supabase.from('practice_taxpayer_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('client_id', clientId),
    ]);
    return {
        statutory_calendar: { count: obligations.count || 0, initialized: (obligations.count || 0) > 0 },
        evidence_checklists: { count: evidenceChecklists.count || 0, initialized: (evidenceChecklists.count || 0) > 0 },
        integrity_open_findings: { count: integrityFindings.count || 0, initialized: true }, // absence of findings is not "uninitialized"
        risk_register: { count: riskEntries.count || 0, initialized: (riskEntries.count || 0) > 0 },
        knowledge_links: { count: knowledgeLinks.count || 0, initialized: (knowledgeLinks.count || 0) > 0 },
        tax_profile: { count: taxpayerProfiles.count || 0, initialized: (taxpayerProfiles.count || 0) > 0 },
    };
}

// ── Readiness — deterministic, no AI ─────────────────────────────────────────

function _computeReadiness(profile, steps, checklist, detected) {
    const stepTotal = steps.length;
    const stepDone = steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const requiredItems = checklist.filter(c => c.required);
    const itemDone = requiredItems.filter(c => c.completed).length;

    const missingModules = Object.entries(detected).filter(([, v]) => !v.initialized).map(([k]) => k);
    const missingInformation = [];
    if (!profile.client_contact_name) missingInformation.push('client_contact_name');
    if (!profile.client_contact_email) missingInformation.push('client_contact_email');
    if (!profile.assigned_team_member_id) missingInformation.push('assigned_team_member_id');
    if (!profile.expected_go_live_date) missingInformation.push('expected_go_live_date');

    const recommendedActions = [];
    if (stepDone < stepTotal) recommendedActions.push(`${stepTotal - stepDone} onboarding step(s) still outstanding.`);
    if (itemDone < requiredItems.length) recommendedActions.push(`${requiredItems.length - itemDone} required checklist item(s) still outstanding.`);
    if (missingModules.length) recommendedActions.push(`Not yet set up: ${missingModules.join(', ')}.`);
    if (missingInformation.length) recommendedActions.push(`Missing basic information: ${missingInformation.join(', ')}.`);
    if (!recommendedActions.length) recommendedActions.push('All tracked onboarding items are complete — ready for review.');

    let overall = 'not_ready';
    if (profile.onboarding_status === 'completed') overall = 'ready';
    else if (stepDone === stepTotal && itemDone === requiredItems.length && !missingModules.length) overall = 'ready_for_review';
    else if (stepDone > 0 || itemDone > 0) overall = 'in_progress';

    return {
        overall_readiness: overall,
        module_readiness: detected,
        missing_modules: missingModules,
        missing_information: missingInformation,
        recommended_next_actions: recommendedActions,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: profiles } = await supabase.from('practice_onboarding_profiles').select('onboarding_status, expected_go_live_date, completion_percentage, created_at').eq('company_id', cid);
        const rows = profiles || [];
        const statusCounts = {}; ONBOARDING_STATUSES.forEach(s => { statusCounts[s] = 0; });
        rows.forEach(p => { if (p.onboarding_status in statusCounts) statusCounts[p.onboarding_status]++; });

        const t = today();
        const monthStart = t.slice(0, 7) + '-01';
        const active = rows.filter(p => !['completed', 'cancelled'].includes(p.onboarding_status));
        const delayed = active.filter(p => p.expected_go_live_date && p.expected_go_live_date < t);
        const avgCompletion = active.length ? Math.round(active.reduce((s, p) => s + (p.completion_percentage || 0), 0) / active.length) : 0;
        const newThisMonth = rows.filter(p => p.created_at && p.created_at.slice(0, 10) >= monthStart).length;

        res.json({
            profiles_total: rows.length,
            by_status: statusCounts,
            active_onboardings: active.length,
            delayed_onboardings: delayed.length,
            avg_completion_pct: avgCompletion,
            new_clients_this_month: newThisMonth,
        });
    } catch (err) {
        console.error('Client-onboarding /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PROFILES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/profiles', async (req, res) => {
    const cid = req.companyId;
    const { status, assigned_team_member_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_onboarding_profiles').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(300, parseInt(limit) || 100));
        if (status) q = q.eq('onboarding_status', status);
        if (assigned_team_member_id) q = q.eq('assigned_team_member_id', parseInt(assigned_team_member_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(p => p.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ profiles: (data || []).map(p => ({ ...p, client_name: nameById[p.client_id] || null })) });
    } catch (err) {
        console.error('Client-onboarding GET profiles error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/profiles/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    try {
        const client = await _verifyClient(cid, clientId);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const profile = await _getProfile(cid, clientId);
        if (!profile) return res.json({ client, profile: null });

        const [stepsRes, checklistRes, detected] = await Promise.all([
            supabase.from('practice_onboarding_steps').select('*').eq('company_id', cid).eq('profile_id', profile.id).order('sort_order'),
            supabase.from('practice_onboarding_checklists').select('*').eq('company_id', cid).eq('profile_id', profile.id).order('sort_order'),
            _detectModules(cid, clientId),
        ]);
        const steps = stepsRes.data || [];
        const checklist = checklistRes.data || [];
        const readiness = _computeReadiness(profile, steps, checklist, detected);

        res.json({ client, profile, steps, checklist, readiness });
    } catch (err) {
        console.error('Client-onboarding GET profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/profiles', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, entity_type } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!ENTITY_TYPES.includes(entity_type)) return res.status(400).json({ error: 'Invalid entity_type' });

    try {
        const result = await buildOnboardingWorkspace(cid, clientId, entity_type, req.user.userId);
        if (!result) return res.status(404).json({ error: 'Client not found' });
        res.status(201).json(result);
    } catch (err) {
        console.error('Client-onboarding POST profiles error:', err.message);
        res.status(500).json({ error: 'Failed to build onboarding workspace.' });
    }
});

router.put('/profiles/:clientId', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

    const member = await _requireManager(req, res);
    if (!member) return;
    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found — create one first via POST /profiles.' });

    const allowed = ['priority', 'assigned_team_member_id', 'client_contact_name', 'client_contact_email', 'client_contact_phone', 'expected_go_live_date', 'risk_level', 'notes', 'internal_notes', 'settings'];
    const update = _pick(req.body, allowed);
    if (update.priority && !PRIORITIES.includes(update.priority)) return res.status(400).json({ error: 'Invalid priority' });
    if (update.risk_level && !RISK_LEVELS.includes(update.risk_level)) return res.status(400).json({ error: 'Invalid risk_level' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles').update(update).eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding PUT profile error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// STEPS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/profiles/:clientId/steps', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    try {
        const { data, error } = await supabase.from('practice_onboarding_steps').select('*').eq('company_id', cid).eq('profile_id', profile.id).order('sort_order');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ steps: data || [] });
    } catch (err) {
        console.error('Client-onboarding GET steps error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/steps/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid step ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_onboarding_steps').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Step not found' });

    const allowed = ['status', 'notes'];
    const update = _pick(req.body, allowed);
    if (update.status && !STEP_STATUSES.includes(update.status)) return res.status(400).json({ error: 'Invalid status' });
    if (update.status === 'completed' && existing.data.status !== 'completed') { update.completed_by = req.user.userId; update.completed_at = new Date().toISOString(); }
    if (update.status && update.status !== 'completed') { update.completed_by = null; update.completed_at = null; }
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_onboarding_steps').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        if (update.status) {
            await _writeEvent(cid, existing.data.client_id, 'step', id, update.status === 'completed' ? 'step_completed' : 'status_changed', existing.data.status, update.status, req.user.userId, update.notes || null, {});
        }
        await _recomputeCompletion(cid, existing.data.profile_id);
        res.json({ step: data });
    } catch (err) {
        console.error('Client-onboarding PUT step error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECKLIST
// ═══════════════════════════════════════════════════════════════════════════

router.post('/profiles/:clientId/checklist/generate', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });

    try {
        const created = await _generateChecklist(cid, clientId, profile, req.user.userId, true);
        await _recomputeCompletion(cid, profile.id);
        res.status(201).json({ checklist_items_created: created.length });
    } catch (err) {
        console.error('Client-onboarding generate checklist error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/checklist/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid checklist item ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await supabase.from('practice_onboarding_checklists').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Checklist item not found' });

    const allowed = ['item_name', 'item_type', 'required', 'completed', 'notes', 'sort_order'];
    const update = _pick(req.body, allowed);
    if (update.item_type && !CHECKLIST_ITEM_TYPES.includes(update.item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (update.completed === true && !existing.data.completed) { update.completed_at = new Date().toISOString(); update.completed_by = req.user.userId; }
    if (update.completed === false) { update.completed_at = null; update.completed_by = null; }
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_onboarding_checklists').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _recomputeCompletion(cid, existing.data.profile_id);
        res.json({ item: data });
    } catch (err) {
        console.error('Client-onboarding PUT checklist item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

router.put('/profiles/:clientId/status', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    const { onboarding_status } = req.body;
    if (!ONBOARDING_STATUSES.includes(onboarding_status)) return res.status(400).json({ error: 'Invalid onboarding_status' });
    if (['completed', 'cancelled'].includes(profile.onboarding_status)) return res.status(400).json({ error: `Cannot change status of an onboarding that is already ${profile.onboarding_status}.` });

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles')
            .update({ onboarding_status, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, clientId, 'profile', profile.id, 'status_changed', profile.onboarding_status, onboarding_status, req.user.userId, req.body.notes || null, {});
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding PUT status error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/profiles/:clientId/submit-review', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    if (['review', 'completed', 'cancelled'].includes(profile.onboarding_status)) {
        return res.status(400).json({ error: `Cannot submit for review from status "${profile.onboarding_status}".` });
    }

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles')
            .update({ onboarding_status: 'review', updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, clientId, 'profile', profile.id, 'status_changed', profile.onboarding_status, 'review', req.user.userId, null, {});
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding submit-review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/profiles/:clientId/approve', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    if (profile.onboarding_status !== 'review') return res.status(400).json({ error: `Cannot approve from status "${profile.onboarding_status}" — onboarding must be in review.` });

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles')
            .update({ reviewed_by: req.user.userId, reviewed_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const { data: reviewStep } = await supabase.from('practice_onboarding_steps').select('*').eq('company_id', cid).eq('profile_id', profile.id).eq('step_name', 'Review completed').maybeSingle();
        if (reviewStep && reviewStep.status !== 'completed') await _completeStep(cid, clientId, reviewStep, req.user.userId, req.body.notes || 'Approved by manager review.');

        await _writeEvent(cid, clientId, 'profile', profile.id, 'review_completed', profile.onboarding_status, profile.onboarding_status, req.user.userId, req.body.notes || null, {});
        await _recomputeCompletion(cid, profile.id);
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding approve error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/profiles/:clientId/complete', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    if (profile.onboarding_status !== 'review') return res.status(400).json({ error: `Cannot complete from status "${profile.onboarding_status}" — onboarding must be in review (and approved) first.` });
    if (!profile.reviewed_at) return res.status(400).json({ error: 'Onboarding must be approved (PUT /approve) before it can be completed.' });

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles')
            .update({ onboarding_status: 'completed', completed_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });

        const { data: goLiveStep } = await supabase.from('practice_onboarding_steps').select('*').eq('company_id', cid).eq('profile_id', profile.id).eq('step_name', 'Go-live approved').maybeSingle();
        if (goLiveStep && goLiveStep.status !== 'completed') await _completeStep(cid, clientId, goLiveStep, req.user.userId, req.body.notes || 'Onboarding completed.');

        await _writeEvent(cid, clientId, 'profile', profile.id, 'onboarding_completed', profile.onboarding_status, 'completed', req.user.userId, req.body.notes || null, {});
        await _recomputeCompletion(cid, profile.id);
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding complete error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/profiles/:clientId/cancel', async (req, res) => {
    const cid = req.companyId;
    const clientId = parseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const profile = await _getProfile(cid, clientId);
    if (!profile) return res.status(404).json({ error: 'Onboarding profile not found' });
    if (['completed', 'cancelled'].includes(profile.onboarding_status)) return res.status(400).json({ error: `Cannot cancel an onboarding that is already ${profile.onboarding_status}.` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel an onboarding.' });

    try {
        const { data, error } = await supabase.from('practice_onboarding_profiles')
            .update({ onboarding_status: 'cancelled', cancelled_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', profile.id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, clientId, 'profile', profile.id, 'status_changed', profile.onboarding_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ profile: data });
    } catch (err) {
        console.error('Client-onboarding cancel error:', err.message);
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
        let q = supabase.from('practice_onboarding_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Client-onboarding GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules — see docs/new-app/70_client_onboarding.md
module.exports.buildOnboardingWorkspace = buildOnboardingWorkspace;
