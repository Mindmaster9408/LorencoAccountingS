'use strict';

// Codebox 59 — Practice Skills Matrix + Competency Framework
// Gives managers visibility into who is qualified for what. NOT AI
// recommendations. NOT auto-delegation. NOT an HR module. NOT payroll
// integration. NOT performance reviews. NOT training automation.
//
// This module ADVISES. It never assigns work, never blocks delegation, and
// never overrides a manager's decision — every consuming page (Delegation,
// Planning Board, Resource Forecast) treats getCompetency()'s output as a
// warning label, not a gate. Fully manager controlled: there is no
// self-service editing of one's own competency data anywhere in this file.

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
const LEVELS = { 0: 'No Exposure', 1: 'Basic', 2: 'Working Knowledge', 3: 'Independent', 4: 'Advanced', 5: 'Expert' };
const CERT_STATUSES = ['active', 'expired', 'pending', 'revoked'];
const EVENT_TYPES = [
    'category_created', 'category_updated', 'category_archived',
    'skill_created', 'skill_updated', 'skill_archived',
    'team_skill_updated', 'team_skill_archived',
    'certification_created', 'certification_updated', 'certification_archived',
    'team_certification_added', 'team_certification_updated', 'team_certification_archived',
    'skills_seeded',
];

// Default category/skill set — matches the spec's own examples exactly,
// extended logically where the spec explicitly allowed it ("developer may
// expand/extend"). Seeded via POST /seed-defaults, idempotently, same
// pattern as Codebox 53's Alert Rules.
const SEED_CATEGORIES = [
    { key: 'tax', name: 'Tax', sort_order: 1 },
    { key: 'accounting', name: 'Accounting', sort_order: 2 },
    { key: 'payroll', name: 'Payroll', sort_order: 3 },
    { key: 'compliance', name: 'Compliance', sort_order: 4 },
    { key: 'secretarial', name: 'Secretarial', sort_order: 5 },
    { key: 'qms', name: 'QMS', sort_order: 6 },
    { key: 'risk', name: 'Risk', sort_order: 7 },
    { key: 'advisory', name: 'Advisory', sort_order: 8 },
    { key: 'administration', name: 'Administration', sort_order: 9 },
    { key: 'client_service', name: 'Client Service', sort_order: 10 },
    { key: 'software', name: 'Software', sort_order: 11 },
    { key: 'leadership', name: 'Leadership', sort_order: 12 },
];

const SEED_SKILLS = [
    { key: 'prepare_vat_return', name: 'Prepare VAT Return', category: 'tax' },
    { key: 'review_vat_return', name: 'Review VAT Return', category: 'tax' },
    { key: 'income_tax', name: 'Income Tax', category: 'tax', maps_to_source_module: 'tax-individual' },
    { key: 'company_tax', name: 'Company Tax', category: 'tax', maps_to_source_module: 'tax-company' },
    { key: 'provisional_tax', name: 'Provisional Tax', category: 'tax' },
    { key: 'emp501', name: 'EMP501', category: 'tax' },
    { key: 'prepare_afs', name: 'Prepare Annual Financial Statements', category: 'accounting' },
    { key: 'review_afs', name: 'Review Annual Financial Statements', category: 'accounting' },
    { key: 'payroll_processing', name: 'Payroll Processing', category: 'payroll' },
    { key: 'payroll_review', name: 'Payroll Review', category: 'payroll' },
    { key: 'cipc_annual_return', name: 'CIPC Annual Return', category: 'secretarial' },
    { key: 'beneficial_ownership', name: 'Beneficial Ownership Filing', category: 'secretarial' },
    { key: 'compliance_deadline_management', name: 'Compliance Deadline Management', category: 'compliance' },
    { key: 'qms_review', name: 'QMS Review', category: 'qms', maps_to_source_module: 'qms-review' },
    { key: 'risk_review', name: 'Risk Review', category: 'risk', maps_to_source_module: 'risk-register' },
    { key: 'client_advisory', name: 'Client Advisory', category: 'advisory' },
    { key: 'workflow_design', name: 'Workflow Design', category: 'administration' },
    { key: 'client_meeting', name: 'Client Meeting', category: 'client_service' },
    { key: 'xero', name: 'Xero', category: 'software' },
    { key: 'pastel', name: 'Pastel', category: 'software' },
    { key: 'excel', name: 'Excel', category: 'software' },
    { key: 'sean_ai', name: 'Sean AI', category: 'software' },
    { key: 'team_supervision', name: 'Team Supervision', category: 'leadership' },
    { key: 'staff_mentoring', name: 'Staff Mentoring', category: 'leadership' },
];

// Delegation source_module → relevant skill_key(s). Advisory only, and
// deliberately incomplete — several delegation source types (tasks,
// deadlines, compliance-packs, document-requests, reminders) don't map
// cleanly onto one specific skill, and guessing would be exactly the kind
// of "hidden logic" this module must avoid. Unmapped modules fall back to
// a general competency profile in getCompetency() rather than a
// fabricated specific-skill match.
const MODULE_SKILL_MAP = {
    'risk-register': ['risk_review'],
    'qms-review': ['qms_review'],
    'qms-finding': ['qms_review'],
    'tax-individual': ['income_tax'],
    'tax-company': ['company_tax'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role').eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!_isManager(member)) {
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can edit the Skills Matrix.' });
        return null;
    }
    return member;
}

async function _writeEvent(cid, eventType, entityType, entityId, actorUserId, notes, meta) {
    await supabase.from('practice_skill_events').insert({
        company_id: cid, event_type: eventType, entity_type: entityType || null, entity_id: entityId || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const [categories, skills, teamSkills, certifications, teamCerts] = await Promise.all([
            supabase.from('practice_skill_categories').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
            supabase.from('practice_skills').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
            supabase.from('practice_team_skills').select('current_level, target_level').eq('company_id', cid),
            supabase.from('practice_certifications').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
            supabase.from('practice_team_certifications').select('status, expiry_date').eq('company_id', cid).eq('is_active', true),
        ]);

        const tsRows = teamSkills.data || [];
        const expertCount = tsRows.filter(r => r.current_level === 5).length;
        const advancedCount = tsRows.filter(r => r.current_level === 4).length;
        const trainingNeededCount = tsRows.filter(r => r.target_level != null && r.target_level > r.current_level).length;

        const today = new Date().toISOString().slice(0, 10);
        const tcRows = teamCerts.data || [];
        const expiringSoonCount = tcRows.filter(r => r.expiry_date && r.expiry_date >= today && r.expiry_date <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)).length;
        const expiredCount = tcRows.filter(r => r.status === 'expired' || (r.expiry_date && r.expiry_date < today)).length;

        res.json({
            category_count: categories.count || 0,
            skill_count: skills.count || 0,
            team_skill_record_count: tsRows.length,
            certification_type_count: certifications.count || 0,
            team_certification_count: tcRows.length,
            expert_count: expertCount,
            advanced_count: advancedCount,
            training_needed_count: trainingNeededCount,
            certifications_expiring_soon: expiringSoonCount,
            certifications_expired: expiredCount,
            seeded: (categories.count || 0) > 0,
        });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/summary', err);
        res.status(500).json({ error: 'Failed to load skills matrix summary.' });
    }
});

// ── POST /seed-defaults ───────────────────────────────────────────────────────

router.post('/seed-defaults', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: existingCats } = await supabase.from('practice_skill_categories').select('id, category_key').eq('company_id', cid);
        const catIdByKey = {};
        (existingCats || []).forEach(c => { catIdByKey[c.category_key] = c.id; });

        const catsToInsert = SEED_CATEGORIES.filter(c => !catIdByKey[c.key]).map(c => ({
            company_id: cid, category_key: c.key, display_name: c.name, sort_order: c.sort_order, created_by: req.user?.userId || null,
        }));
        let insertedCats = [];
        if (catsToInsert.length) {
            const { data, error } = await supabase.from('practice_skill_categories').insert(catsToInsert).select();
            if (error) throw error;
            insertedCats = data || [];
            insertedCats.forEach(c => { catIdByKey[c.category_key] = c.id; });
        }

        const { data: existingSkills } = await supabase.from('practice_skills').select('skill_key').eq('company_id', cid);
        const existingSkillKeys = new Set((existingSkills || []).map(s => s.skill_key));

        const skillsToInsert = SEED_SKILLS.filter(s => !existingSkillKeys.has(s.key)).map((s, idx) => ({
            company_id: cid, category_id: catIdByKey[s.category] || null, skill_key: s.key, display_name: s.name,
            sort_order: idx, created_by: req.user?.userId || null,
            metadata: s.maps_to_source_module ? { maps_to_source_module: s.maps_to_source_module } : {},
        }));
        let insertedSkills = [];
        if (skillsToInsert.length) {
            const { data, error } = await supabase.from('practice_skills').insert(skillsToInsert).select();
            if (error) throw error;
            insertedSkills = data || [];
        }

        await _writeEvent(cid, 'skills_seeded', null, null, req.user?.userId, `Seeded ${insertedCats.length} categories and ${insertedSkills.length} skills.`, { categories: insertedCats.length, skills: insertedSkills.length });

        res.json({ categories_created: insertedCats.length, skills_created: insertedSkills.length, already_seeded: insertedCats.length === 0 && insertedSkills.length === 0 });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/seed-defaults', err);
        res.status(500).json({ error: 'Failed to seed default skills.' });
    }
});

// ── Categories CRUD ───────────────────────────────────────────────────────────

router.get('/categories', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_skill_categories').select('*').eq('company_id', cid).order('sort_order');
        if (req.query.include_archived !== 'true') q = q.eq('is_active', true);
        const { data, error } = await q;
        if (error) throw error;
        res.json({ categories: data || [] });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/categories', err);
        res.status(500).json({ error: 'Failed to load categories.' });
    }
});

router.post('/categories', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.category_key || !body.display_name) return res.status(422).json({ error: 'category_key and display_name are required.' });

        const { data, error } = await supabase.from('practice_skill_categories').insert({
            company_id: cid, category_key: body.category_key, display_name: body.display_name,
            description: body.description || null, sort_order: body.sort_order || 0, created_by: req.user?.userId || null,
        }).select().single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'A category with this category_key already exists.' });
            throw error;
        }
        await _writeEvent(cid, 'category_created', 'category', data.id, req.user?.userId);
        res.status(201).json({ category: data });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/categories', err);
        res.status(500).json({ error: 'Failed to create category.' });
    }
});

router.put('/categories/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const patch = _pick(req.body || {}, ['display_name', 'description', 'sort_order']);
        const { data, error } = await supabase.from('practice_skill_categories').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Category not found.' });
        await _writeEvent(cid, 'category_updated', 'category', data.id, req.user?.userId);
        res.json({ category: data });
    } catch (err) {
        console.error('PUT /api/practice/skills-matrix/categories/:id', err);
        res.status(500).json({ error: 'Failed to update category.' });
    }
});

router.delete('/categories/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_skill_categories').update({ is_active: false }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Category not found.' });
        await _writeEvent(cid, 'category_archived', 'category', data.id, req.user?.userId);
        res.json({ category: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/skills-matrix/categories/:id', err);
        res.status(500).json({ error: 'Failed to archive category.' });
    }
});

// ── Skills CRUD ───────────────────────────────────────────────────────────────

router.get('/skills', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_skills').select('*, practice_skill_categories:category_id(category_key, display_name)').eq('company_id', cid).order('sort_order');
        if (req.query.include_archived !== 'true') q = q.eq('is_active', true);
        if (req.query.category_id) q = q.eq('category_id', parseInt(req.query.category_id, 10));
        const { data, error } = await q;
        if (error) throw error;

        let rows = data || [];
        if (req.query.search) {
            const s = String(req.query.search).toLowerCase();
            rows = rows.filter(r => `${r.skill_key} ${r.display_name}`.toLowerCase().includes(s));
        }
        res.json({ skills: rows });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/skills', err);
        res.status(500).json({ error: 'Failed to load skills.' });
    }
});

router.post('/skills', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.skill_key || !body.display_name) return res.status(422).json({ error: 'skill_key and display_name are required.' });

        const { data, error } = await supabase.from('practice_skills').insert({
            company_id: cid, category_id: body.category_id ? parseInt(body.category_id, 10) : null,
            skill_key: body.skill_key, display_name: body.display_name, description: body.description || null,
            sort_order: body.sort_order || 0, metadata: body.metadata || {}, created_by: req.user?.userId || null,
        }).select().single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'A skill with this skill_key already exists.' });
            throw error;
        }
        await _writeEvent(cid, 'skill_created', 'skill', data.id, req.user?.userId);
        res.status(201).json({ skill: data });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/skills', err);
        res.status(500).json({ error: 'Failed to create skill.' });
    }
});

router.put('/skills/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const patch = _pick(req.body || {}, ['display_name', 'description', 'category_id', 'sort_order', 'metadata']);
        if (patch.category_id !== undefined) patch.category_id = patch.category_id ? parseInt(patch.category_id, 10) : null;
        const { data, error } = await supabase.from('practice_skills').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Skill not found.' });
        await _writeEvent(cid, 'skill_updated', 'skill', data.id, req.user?.userId);
        res.json({ skill: data });
    } catch (err) {
        console.error('PUT /api/practice/skills-matrix/skills/:id', err);
        res.status(500).json({ error: 'Failed to update skill.' });
    }
});

router.delete('/skills/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_skills').update({ is_active: false }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Skill not found.' });
        await _writeEvent(cid, 'skill_archived', 'skill', data.id, req.user?.userId);
        res.json({ skill: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/skills-matrix/skills/:id', err);
        res.status(500).json({ error: 'Failed to archive skill.' });
    }
});

// ── Team Skills CRUD ──────────────────────────────────────────────────────────
// Fully manager controlled — GET is scoped (managers see everyone, everyone
// else sees only their own record, so "what should I learn next" stays
// available without exposing colleagues' competency ratings), all writes
// require a manager regardless of whose record is being touched.

router.get('/team-skills', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        let q = supabase.from('practice_team_skills').select('*, practice_skills:skill_id(skill_key, display_name, category_id)').eq('company_id', cid);

        if (req.query.team_member_id) {
            const requestedId = parseInt(req.query.team_member_id, 10);
            if (!_isManager(me) && (!me || me.id !== requestedId)) return res.status(403).json({ error: 'You can only view your own skill records.' });
            q = q.eq('team_member_id', requestedId);
        } else if (!_isManager(me)) {
            if (!me) return res.json({ team_skills: [] });
            q = q.eq('team_member_id', me.id);
        }
        if (req.query.skill_id) q = q.eq('skill_id', parseInt(req.query.skill_id, 10));

        const { data, error } = await q;
        if (error) throw error;

        const memberIds = [...new Set((data || []).map(r => r.team_member_id))];
        let membersById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds);
            (members || []).forEach(m => { membersById[m.id] = m.display_name; });
        }

        let rows = (data || []).map(r => Object.assign({}, r, { team_member_name: membersById[r.team_member_id] || null, level_label: LEVELS[r.current_level] }));
        if (req.query.category_id) rows = rows.filter(r => r.practice_skills?.category_id === parseInt(req.query.category_id, 10));

        res.json({ team_skills: rows });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/team-skills', err);
        res.status(500).json({ error: 'Failed to load team skills.' });
    }
});

// Upsert — assigning/updating a competency level is naturally idempotent;
// a manager repeats this action over time as someone's skill develops.
router.post('/team-skills', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.team_member_id || !body.skill_id) return res.status(422).json({ error: 'team_member_id and skill_id are required.' });
        const currentLevel = body.current_level != null ? parseInt(body.current_level, 10) : 0;
        if (isNaN(currentLevel) || currentLevel < 0 || currentLevel > 5) return res.status(422).json({ error: 'current_level must be between 0 and 5.' });

        const row = {
            company_id: cid, team_member_id: parseInt(body.team_member_id, 10), skill_id: parseInt(body.skill_id, 10),
            current_level: currentLevel,
            target_level: body.target_level != null ? parseInt(body.target_level, 10) : null,
            is_preferred: !!body.is_preferred, is_restricted: !!body.is_restricted,
            last_reviewed_date: body.last_reviewed_date || new Date().toISOString().slice(0, 10),
            review_notes: body.review_notes || null, metadata: body.metadata || {},
            updated_by: req.user?.userId || null,
        };

        const { data, error } = await supabase.from('practice_team_skills').upsert(row, { onConflict: 'company_id,team_member_id,skill_id' }).select().single();
        if (error) throw error;

        await _writeEvent(cid, 'team_skill_updated', 'team_skill', data.id, req.user?.userId, body.review_notes || null, { current_level: currentLevel, target_level: row.target_level });
        res.status(201).json({ team_skill: data });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/team-skills', err);
        res.status(500).json({ error: 'Failed to assign skill.' });
    }
});

router.put('/team-skills/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const patch = _pick(req.body || {}, ['current_level', 'target_level', 'is_preferred', 'is_restricted', 'last_reviewed_date', 'review_notes', 'metadata']);
        if (patch.current_level != null && (patch.current_level < 0 || patch.current_level > 5)) return res.status(422).json({ error: 'current_level must be between 0 and 5.' });
        patch.updated_by = req.user?.userId || null;

        const { data, error } = await supabase.from('practice_team_skills').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Team skill record not found.' });

        await _writeEvent(cid, 'team_skill_updated', 'team_skill', data.id, req.user?.userId, patch.review_notes || null);
        res.json({ team_skill: data });
    } catch (err) {
        console.error('PUT /api/practice/skills-matrix/team-skills/:id', err);
        res.status(500).json({ error: 'Failed to update team skill.' });
    }
});

// Soft "remove" — resets to level 0 (No Exposure) rather than deleting the
// row, preserving history. See docs for why this table has no is_active
// column of its own.
router.delete('/team-skills/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_team_skills').update({ current_level: 0, target_level: null, is_preferred: false, is_restricted: false, updated_by: req.user?.userId || null }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Team skill record not found.' });
        await _writeEvent(cid, 'team_skill_archived', 'team_skill', data.id, req.user?.userId);
        res.json({ team_skill: data, reset: true });
    } catch (err) {
        console.error('DELETE /api/practice/skills-matrix/team-skills/:id', err);
        res.status(500).json({ error: 'Failed to reset team skill.' });
    }
});

// ── Certifications CRUD (catalog) ────────────────────────────────────────────

router.get('/certifications', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_certifications').select('*').eq('company_id', cid).order('certification_name');
        if (req.query.include_archived !== 'true') q = q.eq('is_active', true);
        const { data, error } = await q;
        if (error) throw error;
        res.json({ certifications: data || [] });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/certifications', err);
        res.status(500).json({ error: 'Failed to load certifications.' });
    }
});

router.post('/certifications', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.certification_name) return res.status(422).json({ error: 'certification_name is required.' });

        const { data, error } = await supabase.from('practice_certifications').insert({
            company_id: cid, certification_name: body.certification_name, issuer: body.issuer || null,
            category_id: body.category_id ? parseInt(body.category_id, 10) : null, description: body.description || null,
            created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;
        await _writeEvent(cid, 'certification_created', 'certification', data.id, req.user?.userId);
        res.status(201).json({ certification: data });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/certifications', err);
        res.status(500).json({ error: 'Failed to create certification.' });
    }
});

router.put('/certifications/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const patch = _pick(req.body || {}, ['certification_name', 'issuer', 'category_id', 'description']);
        if (patch.category_id !== undefined) patch.category_id = patch.category_id ? parseInt(patch.category_id, 10) : null;
        const { data, error } = await supabase.from('practice_certifications').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Certification not found.' });
        await _writeEvent(cid, 'certification_updated', 'certification', data.id, req.user?.userId);
        res.json({ certification: data });
    } catch (err) {
        console.error('PUT /api/practice/skills-matrix/certifications/:id', err);
        res.status(500).json({ error: 'Failed to update certification.' });
    }
});

router.delete('/certifications/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_certifications').update({ is_active: false }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Certification not found.' });
        await _writeEvent(cid, 'certification_archived', 'certification', data.id, req.user?.userId);
        res.json({ certification: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/skills-matrix/certifications/:id', err);
        res.status(500).json({ error: 'Failed to archive certification.' });
    }
});

// ── Team Certifications CRUD ──────────────────────────────────────────────────

router.get('/team-certifications', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        let q = supabase.from('practice_team_certifications').select('*, practice_certifications:certification_id(certification_name, issuer)').eq('company_id', cid).eq('is_active', true);

        if (req.query.team_member_id) {
            const requestedId = parseInt(req.query.team_member_id, 10);
            if (!_isManager(me) && (!me || me.id !== requestedId)) return res.status(403).json({ error: 'You can only view your own certifications.' });
            q = q.eq('team_member_id', requestedId);
        } else if (!_isManager(me)) {
            if (!me) return res.json({ team_certifications: [] });
            q = q.eq('team_member_id', me.id);
        }

        const { data, error } = await q;
        if (error) throw error;

        const memberIds = [...new Set((data || []).map(r => r.team_member_id))];
        let membersById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds);
            (members || []).forEach(m => { membersById[m.id] = m.display_name; });
        }

        const today = new Date().toISOString().slice(0, 10);
        const rows = (data || []).map(r => Object.assign({}, r, {
            team_member_name: membersById[r.team_member_id] || null,
            is_expired: !!(r.expiry_date && r.expiry_date < today),
        }));
        res.json({ team_certifications: rows });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/team-certifications', err);
        res.status(500).json({ error: 'Failed to load team certifications.' });
    }
});

router.post('/team-certifications', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.team_member_id || !body.certification_id) return res.status(422).json({ error: 'team_member_id and certification_id are required.' });
        if (body.status && !CERT_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${CERT_STATUSES.join(', ')}.` });

        const { data, error } = await supabase.from('practice_team_certifications').insert({
            company_id: cid, team_member_id: parseInt(body.team_member_id, 10), certification_id: parseInt(body.certification_id, 10),
            issue_date: body.issue_date || null, expiry_date: body.expiry_date || null, status: body.status || 'active',
            certificate_number: body.certificate_number || null, notes: body.notes || null, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;
        await _writeEvent(cid, 'team_certification_added', 'team_certification', data.id, req.user?.userId);
        res.status(201).json({ team_certification: data });
    } catch (err) {
        console.error('POST /api/practice/skills-matrix/team-certifications', err);
        res.status(500).json({ error: 'Failed to add team certification.' });
    }
});

router.put('/team-certifications/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (body.status && !CERT_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${CERT_STATUSES.join(', ')}.` });
        const patch = _pick(body, ['issue_date', 'expiry_date', 'status', 'certificate_number', 'notes']);

        const { data, error } = await supabase.from('practice_team_certifications').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Team certification not found.' });
        await _writeEvent(cid, 'team_certification_updated', 'team_certification', data.id, req.user?.userId);
        res.json({ team_certification: data });
    } catch (err) {
        console.error('PUT /api/practice/skills-matrix/team-certifications/:id', err);
        res.status(500).json({ error: 'Failed to update team certification.' });
    }
});

router.delete('/team-certifications/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_team_certifications').update({ is_active: false }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Team certification not found.' });
        await _writeEvent(cid, 'team_certification_archived', 'team_certification', data.id, req.user?.userId);
        res.json({ team_certification: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/skills-matrix/team-certifications/:id', err);
        res.status(500).json({ error: 'Failed to archive team certification.' });
    }
});

// ── getCompetency() — the advisory helper other modules call ──────────────────
// Returns: overall level, relevant skills, certification status,
// restrictions, missing competencies. Advisory only — callers must never
// use this to block an action, only to show a warning. If sourceModule is
// given and maps to specific skill(s) (see MODULE_SKILL_MAP), the relevant
// skills are highlighted; otherwise the full profile is returned so the
// caller can still show something useful rather than nothing.
async function getCompetency(cid, teamMemberId, sourceModule) {
    const [memberRes, skillsRes, certsRes] = await Promise.all([
        supabase.from('practice_team_members').select('id, display_name').eq('id', teamMemberId).eq('company_id', cid).maybeSingle(),
        supabase.from('practice_team_skills').select('*, practice_skills:skill_id(skill_key, display_name, category_id)').eq('company_id', cid).eq('team_member_id', teamMemberId),
        supabase.from('practice_team_certifications').select('*, practice_certifications:certification_id(certification_name)').eq('company_id', cid).eq('team_member_id', teamMemberId).eq('is_active', true),
    ]);

    const member = memberRes.data;
    const allSkills = skillsRes.data || [];
    const certifications = (certsRes.data || []).map(c => ({
        certification_name: c.practice_certifications?.certification_name || 'Unknown certification',
        status: c.status, expiry_date: c.expiry_date,
    }));

    const relevantSkillKeys = sourceModule ? (MODULE_SKILL_MAP[sourceModule] || []) : [];
    const relevantSkills = relevantSkillKeys.length
        ? allSkills.filter(s => relevantSkillKeys.includes(s.practice_skills?.skill_key))
        : allSkills;

    const withLevel = allSkills.filter(s => s.current_level > 0);
    const overallLevel = withLevel.length ? Math.round((withLevel.reduce((sum, s) => sum + s.current_level, 0) / withLevel.length) * 10) / 10 : 0;

    const restrictions = allSkills.filter(s => s.is_restricted).map(s => s.practice_skills?.display_name).filter(Boolean);
    const missingCompetencies = allSkills.filter(s => s.target_level != null && s.target_level > s.current_level)
        .map(s => ({ skill: s.practice_skills?.display_name, current_level: s.current_level, target_level: s.target_level }));

    // The one specific number the Delegation page's "current/new owner
    // competency" comparison needs — null if no skill maps to this module,
    // in which case the caller falls back to overallLevel with a caveat.
    const specificLevel = relevantSkillKeys.length && relevantSkills.length
        ? Math.max(...relevantSkills.map(s => s.current_level))
        : null;

    return {
        team_member_id: teamMemberId,
        team_member_name: member ? member.display_name : null,
        overall_level: overallLevel,
        specific_level: specificLevel,
        specific_skill_matched: relevantSkillKeys.length > 0,
        relevant_skills: relevantSkills.map(s => ({
            skill_key: s.practice_skills?.skill_key, display_name: s.practice_skills?.display_name,
            current_level: s.current_level, target_level: s.target_level, level_label: LEVELS[s.current_level],
            is_preferred: s.is_preferred, is_restricted: s.is_restricted,
        })),
        certifications,
        restrictions,
        missing_competencies: missingCompetencies,
    };
}

// ── GET /competency/:team_member_id ───────────────────────────────────────────

router.get('/competency/:team_member_id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const requestedId = parseInt(req.params.team_member_id, 10);
        if (!_isManager(me) && (!me || me.id !== requestedId)) return res.status(403).json({ error: 'You can only view your own competency profile.' });

        const result = await getCompetency(cid, requestedId, req.query.source_module || null);
        res.json({ competency: result });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/competency/:team_member_id', err);
        res.status(500).json({ error: 'Failed to load competency profile.' });
    }
});

// ── GET /events ───────────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_skill_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(200);
        if (req.query.entity_type) q = q.eq('entity_type', req.query.entity_type);
        if (req.query.entity_id) q = q.eq('entity_id', parseInt(req.query.entity_id, 10));
        const { data, error } = await q;
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/skills-matrix/events', err);
        res.status(500).json({ error: 'Failed to load skills matrix history.' });
    }
});

module.exports = router;

// Reusable advisory helper — Delegation, Planning Board, and Resource
// Forecast all call this in-process rather than re-querying
// practice_team_skills/practice_team_certifications themselves.
module.exports.getCompetency = getCompetency;
module.exports.MODULE_SKILL_MAP = MODULE_SKILL_MAP;
module.exports.LEVELS = LEVELS;
