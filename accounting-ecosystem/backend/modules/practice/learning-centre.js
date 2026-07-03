'use strict';

// Codebox 60 — Practice Learning, Development & Training Centre
// "How do we grow this person?" Complements the Skills Matrix (Codebox 59)
// with manager-driven development plans, goals, activities, and CPD
// tracking. NOT AI coaching. NOT automatic development plans. NOT an LMS.
// NOT external learning provider integration. NOT performance reviews.
//
// Fully manager controlled — there is no self-service editing of one's own
// plans/goals/activities/CPD anywhere in this file, matching the same
// discipline as Codebox 59's Skills Matrix.

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
const PLAN_STATUSES = ['draft', 'active', 'on_hold', 'completed', 'cancelled'];
const GOAL_STATUSES = ['not_started', 'in_progress', 'completed', 'on_hold', 'cancelled'];
const ACTIVITY_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];
const ACTIVITY_TYPES = ['internal_training', 'external_course', 'workshop', 'reading', 'case_study', 'mentoring_session', 'shadowing', 'client_meeting_observation', 'research', 'other'];
const CPD_STATUSES = ['recorded', 'verified', 'expired'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

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
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can edit the Learning Centre.' });
        return null;
    }
    return member;
}

async function _writeEvent(cid, eventType, entityType, entityId, actorUserId, notes, meta) {
    await supabase.from('practice_learning_events').insert({
        company_id: cid, event_type: eventType, entity_type: entityType || null, entity_id: entityId || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyPlan(id, cid) {
    const { data } = await supabase.from('practice_learning_plans').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _verifyGoal(id, cid) {
    const { data } = await supabase.from('practice_learning_goals').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}
async function _verifyActivity(id, cid) {
    const { data } = await supabase.from('practice_learning_activities').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

function _canView(plan, member) {
    if (_isManager(member)) return true;
    if (!member) return false;
    return plan.team_member_id === member.id || plan.mentor_team_member_id === member.id;
}

// ── Progress Engine — calculateLearningProgress() ────────────────────────────
// Deterministic, no AI. Every number here is a plain sum/average/ratio of
// already-stored fields — documented per-goal below. Also rewrites the
// plan's cached overall_progress column so it never drifts from what this
// function would compute live.
//
// Per-goal progress:
//   status = 'completed'              -> 100
//   target_level set (> 0)            -> current_level / target_level, capped at 100
//   otherwise, has activities         -> completed_hours / planned_hours across its activities
//   otherwise                          -> 0 (nothing to measure yet)
// Plan overall_progress = simple average of its goals' progress (0 if no goals).
// CPD hours accumulated is practice-wide for the team member (not plan-scoped)
// since CPD is a personal professional requirement independent of any one plan.
async function calculateLearningProgress(cid, planId) {
    const plan = await _verifyPlan(planId, cid);
    if (!plan) throw new Error('Learning plan not found.');

    const { data: goals } = await supabase.from('practice_learning_goals').select('*').eq('company_id', cid).eq('learning_plan_id', planId);
    const goalRows = goals || [];
    const goalIds = goalRows.map(g => g.id);

    let activityRows = [];
    if (goalIds.length) {
        const { data: activities } = await supabase.from('practice_learning_activities').select('*').eq('company_id', cid).in('goal_id', goalIds);
        activityRows = activities || [];
    }
    const activitiesByGoal = {};
    activityRows.forEach(a => { (activitiesByGoal[a.goal_id] = activitiesByGoal[a.goal_id] || []).push(a); });

    const goalProgress = goalRows.map(g => {
        let pct, reason;
        if (g.status === 'completed') { pct = 100; reason = 'Goal marked completed'; }
        else if (g.target_level != null && g.target_level > 0) {
            pct = Math.min(100, ((g.current_level || 0) / g.target_level) * 100);
            reason = `Competency ${g.current_level || 0}/${g.target_level}`;
        } else {
            const acts = activitiesByGoal[g.id] || [];
            const planned = acts.reduce((s, a) => s + (Number(a.planned_hours) || 0), 0);
            const completed = acts.reduce((s, a) => s + (Number(a.completed_hours) || 0), 0);
            pct = planned > 0 ? Math.min(100, (completed / planned) * 100) : 0;
            reason = planned > 0 ? `${completed}/${planned} planned hours completed` : 'No target level or activity hours recorded yet';
        }
        return { goal_id: g.id, goal_title: g.goal_title, status: g.status, progress_pct: Math.round(pct * 10) / 10, reason };
    });

    const overallProgress = goalProgress.length ? Math.round((goalProgress.reduce((s, g) => s + g.progress_pct, 0) / goalProgress.length) * 10) / 10 : 0;
    const goalsCompleted = goalRows.filter(g => g.status === 'completed').length;

    const hoursPlanned = activityRows.reduce((s, a) => s + (Number(a.planned_hours) || 0), 0);
    const hoursCompleted = activityRows.reduce((s, a) => s + (Number(a.completed_hours) || 0), 0);

    const { data: cpdRows } = await supabase.from('practice_cpd_records').select('hours').eq('company_id', cid).eq('team_member_id', plan.team_member_id).eq('is_active', true);
    const cpdHoursAccumulated = (cpdRows || []).reduce((s, r) => s + (Number(r.hours) || 0), 0);

    await supabase.from('practice_learning_plans').update({ overall_progress: overallProgress }).eq('id', planId).eq('company_id', cid);

    return {
        plan_id: planId, team_member_id: plan.team_member_id,
        overall_progress: overallProgress,
        goals_total: goalRows.length, goals_completed: goalsCompleted, goals_remaining: goalRows.length - goalsCompleted,
        goal_progress: goalProgress,
        hours_planned: Math.round(hoursPlanned * 10) / 10, hours_completed: Math.round(hoursCompleted * 10) / 10,
        hours_remaining: Math.round(Math.max(0, hoursPlanned - hoursCompleted) * 10) / 10,
        cpd_hours_accumulated: Math.round(cpdHoursAccumulated * 10) / 10,
    };
}

// Recalculates and re-caches a plan's progress after any goal/activity
// write — swallows errors so a progress-recalc failure never blocks the
// underlying CRUD operation that triggered it.
async function _recalc(cid, planId) {
    try { await calculateLearningProgress(cid, planId); } catch (e) { console.error('[learning-centre] progress recalc failed — non-fatal', e.message); }
}

// ── Codebox 58 (Delegation) advisory helper ───────────────────────────────────
// "In Development" or "Mentored" — badge only, never a gate. Prefers a plan
// whose goals target the given skill; falls back to any active plan if the
// person is in development generally but not for that specific skill.
async function getDevelopmentBadge(cid, teamMemberId, skillId) {
    const { data: plans } = await supabase.from('practice_learning_plans').select('id, mentor_team_member_id').eq('company_id', cid).eq('team_member_id', teamMemberId).eq('status', 'active');
    if (!plans || !plans.length) return null;

    let relevant = plans;
    if (skillId) {
        const planIds = plans.map(p => p.id);
        const { data: goals } = await supabase.from('practice_learning_goals').select('learning_plan_id').eq('company_id', cid).eq('skill_id', skillId).in('learning_plan_id', planIds).not('status', 'in', '("completed","cancelled")');
        const matchingIds = new Set((goals || []).map(g => g.learning_plan_id));
        const matched = plans.filter(p => matchingIds.has(p.id));
        if (matched.length) relevant = matched;
        // else: no skill-specific active goal — fall through to "relevant = plans" (general in-development signal)
    }
    return relevant.some(p => p.mentor_team_member_id != null) ? 'mentored' : 'in_development';
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const today = new Date().toISOString().slice(0, 10);

        const [plansRes, goalsRes, cpdRes] = await Promise.all([
            supabase.from('practice_learning_plans').select('status, target_completion_date, mentor_team_member_id').eq('company_id', cid),
            supabase.from('practice_learning_goals').select('status').eq('company_id', cid),
            supabase.from('practice_cpd_records').select('hours').eq('company_id', cid).eq('is_active', true),
        ]);

        const plans = plansRes.data || [];
        const goals = goalsRes.data || [];
        const cpd = cpdRes.data || [];

        res.json({
            active_plans: plans.filter(p => p.status === 'active').length,
            draft_plans: plans.filter(p => p.status === 'draft').length,
            completed_plans: plans.filter(p => p.status === 'completed').length,
            plans_overdue: plans.filter(p => p.status === 'active' && p.target_completion_date && p.target_completion_date < today).length,
            mentoring_relationships: new Set(plans.filter(p => p.status === 'active' && p.mentor_team_member_id != null).map(p => p.mentor_team_member_id)).size,
            total_goals: goals.length,
            goals_completed: goals.filter(g => g.status === 'completed').length,
            goals_in_progress: goals.filter(g => g.status === 'in_progress').length,
            total_cpd_hours: Math.round(cpd.reduce((s, r) => s + (Number(r.hours) || 0), 0) * 10) / 10,
            cpd_record_count: cpd.length,
        });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/summary', err);
        res.status(500).json({ error: 'Failed to load learning centre summary.' });
    }
});

// ── Learning Plans CRUD ───────────────────────────────────────────────────────

router.get('/plans', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        let q = supabase.from('practice_learning_plans').select('*').eq('company_id', cid).order('created_at', { ascending: false });
        if (req.query.status) q = q.eq('status', req.query.status);

        if (req.query.team_member_id) {
            const requestedId = parseInt(req.query.team_member_id, 10);
            if (!_isManager(me) && (!me || (me.id !== requestedId))) return res.status(403).json({ error: 'You can only view your own learning plans.' });
            q = q.eq('team_member_id', requestedId);
        } else if (!_isManager(me)) {
            if (!me) return res.json({ plans: [] });
            q = q.or(`team_member_id.eq.${me.id},mentor_team_member_id.eq.${me.id}`);
        }

        const { data, error } = await q;
        if (error) throw error;

        const memberIds = [...new Set((data || []).flatMap(p => [p.team_member_id, p.mentor_team_member_id]).filter(id => id != null))];
        let membersById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds);
            (members || []).forEach(m => { membersById[m.id] = m.display_name; });
        }

        const rows = (data || []).map(p => Object.assign({}, p, {
            team_member_name: membersById[p.team_member_id] || null,
            mentor_name: p.mentor_team_member_id != null ? (membersById[p.mentor_team_member_id] || null) : null,
        }));
        res.json({ plans: rows });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/plans', err);
        res.status(500).json({ error: 'Failed to load learning plans.' });
    }
});

router.post('/plans', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.team_member_id || !body.plan_name) return res.status(422).json({ error: 'team_member_id and plan_name are required.' });
        if (body.status && !PLAN_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${PLAN_STATUSES.join(', ')}.` });

        const { data, error } = await supabase.from('practice_learning_plans').insert({
            company_id: cid, team_member_id: parseInt(body.team_member_id, 10), plan_name: body.plan_name,
            description: body.description || null, start_date: body.start_date || null, target_completion_date: body.target_completion_date || null,
            status: body.status || 'draft', mentor_team_member_id: body.mentor_team_member_id ? parseInt(body.mentor_team_member_id, 10) : null,
            notes: body.notes || null, metadata: body.metadata || {}, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;
        await _writeEvent(cid, 'plan_created', 'plan', data.id, req.user?.userId);
        res.status(201).json({ plan: data });
    } catch (err) {
        console.error('POST /api/practice/learning-centre/plans', err);
        res.status(500).json({ error: 'Failed to create learning plan.' });
    }
});

router.get('/plans/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const plan = await _verifyPlan(req.params.id, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });
        if (!_canView(plan, me)) return res.status(403).json({ error: 'You cannot view this learning plan.' });

        const { data: goals } = await supabase.from('practice_learning_goals').select('*, practice_skills:skill_id(skill_key, display_name)').eq('company_id', cid).eq('learning_plan_id', plan.id).order('created_at');
        const goalIds = (goals || []).map(g => g.id);
        let activities = [];
        if (goalIds.length) {
            const { data } = await supabase.from('practice_learning_activities').select('*').eq('company_id', cid).in('goal_id', goalIds).order('created_at');
            activities = data || [];
        }

        res.json({ plan, goals: goals || [], activities });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/plans/:id', err);
        res.status(500).json({ error: 'Failed to load learning plan.' });
    }
});

router.put('/plans/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (body.status && !PLAN_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${PLAN_STATUSES.join(', ')}.` });

        const patch = _pick(body, ['plan_name', 'description', 'start_date', 'target_completion_date', 'status', 'notes', 'metadata']);
        if (body.mentor_team_member_id !== undefined) patch.mentor_team_member_id = body.mentor_team_member_id ? parseInt(body.mentor_team_member_id, 10) : null;

        const { data, error } = await supabase.from('practice_learning_plans').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Learning plan not found.' });
        await _writeEvent(cid, 'plan_updated', 'plan', data.id, req.user?.userId);
        res.json({ plan: data });
    } catch (err) {
        console.error('PUT /api/practice/learning-centre/plans/:id', err);
        res.status(500).json({ error: 'Failed to update learning plan.' });
    }
});

// Soft-close — sets status='cancelled' (never a hard delete). Reuses the
// existing status enum's terminal value rather than adding a redundant
// is_active column, since 'cancelled' already means exactly this.
router.delete('/plans/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_learning_plans').update({ status: 'cancelled' }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Learning plan not found.' });
        await _writeEvent(cid, 'plan_archived', 'plan', data.id, req.user?.userId);
        res.json({ plan: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/learning-centre/plans/:id', err);
        res.status(500).json({ error: 'Failed to archive learning plan.' });
    }
});

// ── Goals CRUD ────────────────────────────────────────────────────────────────

router.get('/goals', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        if (!req.query.learning_plan_id) return res.status(422).json({ error: 'learning_plan_id query param is required.' });

        const plan = await _verifyPlan(req.query.learning_plan_id, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });
        if (!_canView(plan, me)) return res.status(403).json({ error: 'You cannot view goals for this learning plan.' });

        const { data, error } = await supabase.from('practice_learning_goals').select('*, practice_skills:skill_id(skill_key, display_name)').eq('company_id', cid).eq('learning_plan_id', plan.id).order('created_at');
        if (error) throw error;
        res.json({ goals: data || [] });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/goals', err);
        res.status(500).json({ error: 'Failed to load goals.' });
    }
});

router.post('/goals', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.learning_plan_id || !body.goal_title) return res.status(422).json({ error: 'learning_plan_id and goal_title are required.' });
        if (body.priority && !PRIORITIES.includes(body.priority)) return res.status(422).json({ error: `priority must be one of ${PRIORITIES.join(', ')}.` });
        if (body.status && !GOAL_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${GOAL_STATUSES.join(', ')}.` });

        const planId = parseInt(body.learning_plan_id, 10);
        const plan = await _verifyPlan(planId, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });

        const { data, error } = await supabase.from('practice_learning_goals').insert({
            company_id: cid, learning_plan_id: planId, skill_id: body.skill_id ? parseInt(body.skill_id, 10) : null,
            goal_title: body.goal_title, goal_description: body.goal_description || null,
            priority: body.priority || 'medium', target_level: body.target_level != null ? parseInt(body.target_level, 10) : null,
            current_level: body.current_level != null ? parseInt(body.current_level, 10) : null,
            status: body.status || 'not_started', target_date: body.target_date || null,
            metadata: body.metadata || {}, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, 'goal_created', 'goal', data.id, req.user?.userId);
        await _recalc(cid, planId);
        res.status(201).json({ goal: data });
    } catch (err) {
        console.error('POST /api/practice/learning-centre/goals', err);
        res.status(500).json({ error: 'Failed to create goal.' });
    }
});

router.put('/goals/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const goal = await _verifyGoal(req.params.id, cid);
        if (!goal) return res.status(404).json({ error: 'Goal not found.' });

        const body = req.body || {};
        if (body.priority && !PRIORITIES.includes(body.priority)) return res.status(422).json({ error: `priority must be one of ${PRIORITIES.join(', ')}.` });
        if (body.status && !GOAL_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${GOAL_STATUSES.join(', ')}.` });

        const patch = _pick(body, ['goal_title', 'goal_description', 'priority', 'target_level', 'current_level', 'status', 'target_date', 'metadata']);
        if (patch.status === 'completed' && !body.completed_date) patch.completed_date = new Date().toISOString().slice(0, 10);
        else if (body.completed_date !== undefined) patch.completed_date = body.completed_date;

        const { data, error } = await supabase.from('practice_learning_goals').update(patch).eq('id', goal.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeEvent(cid, patch.status === 'completed' ? 'goal_completed' : 'goal_updated', 'goal', data.id, req.user?.userId);
        await _recalc(cid, goal.learning_plan_id);
        res.json({ goal: data });
    } catch (err) {
        console.error('PUT /api/practice/learning-centre/goals/:id', err);
        res.status(500).json({ error: 'Failed to update goal.' });
    }
});

router.delete('/goals/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const goal = await _verifyGoal(req.params.id, cid);
        if (!goal) return res.status(404).json({ error: 'Goal not found.' });

        const { data, error } = await supabase.from('practice_learning_goals').update({ status: 'cancelled' }).eq('id', goal.id).eq('company_id', cid).select().single();
        if (error) throw error;
        await _writeEvent(cid, 'goal_archived', 'goal', data.id, req.user?.userId);
        await _recalc(cid, goal.learning_plan_id);
        res.json({ goal: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/learning-centre/goals/:id', err);
        res.status(500).json({ error: 'Failed to archive goal.' });
    }
});

// ── Activities CRUD ───────────────────────────────────────────────────────────

router.get('/activities', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        if (!req.query.goal_id) return res.status(422).json({ error: 'goal_id query param is required.' });

        const goal = await _verifyGoal(req.query.goal_id, cid);
        if (!goal) return res.status(404).json({ error: 'Goal not found.' });
        const plan = await _verifyPlan(goal.learning_plan_id, cid);
        if (!plan || !_canView(plan, me)) return res.status(403).json({ error: 'You cannot view activities for this goal.' });

        const { data, error } = await supabase.from('practice_learning_activities').select('*').eq('company_id', cid).eq('goal_id', goal.id).order('created_at');
        if (error) throw error;
        res.json({ activities: data || [] });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/activities', err);
        res.status(500).json({ error: 'Failed to load activities.' });
    }
});

router.post('/activities', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.goal_id || !body.title) return res.status(422).json({ error: 'goal_id and title are required.' });
        if (!body.activity_type || !ACTIVITY_TYPES.includes(body.activity_type)) return res.status(422).json({ error: `activity_type must be one of ${ACTIVITY_TYPES.join(', ')}.` });
        if (body.status && !ACTIVITY_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${ACTIVITY_STATUSES.join(', ')}.` });

        const goalId = parseInt(body.goal_id, 10);
        const goal = await _verifyGoal(goalId, cid);
        if (!goal) return res.status(404).json({ error: 'Goal not found.' });

        const { data, error } = await supabase.from('practice_learning_activities').insert({
            company_id: cid, goal_id: goalId, activity_type: body.activity_type, title: body.title, description: body.description || null,
            planned_hours: body.planned_hours != null ? Number(body.planned_hours) : null, completed_hours: body.completed_hours != null ? Number(body.completed_hours) : null,
            status: body.status || 'planned', completion_date: body.completion_date || null, evidence_notes: body.evidence_notes || null,
            metadata: body.metadata || {}, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, 'activity_created', 'activity', data.id, req.user?.userId);
        await _recalc(cid, goal.learning_plan_id);
        res.status(201).json({ activity: data });
    } catch (err) {
        console.error('POST /api/practice/learning-centre/activities', err);
        res.status(500).json({ error: 'Failed to create activity.' });
    }
});

router.put('/activities/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const activity = await _verifyActivity(req.params.id, cid);
        if (!activity) return res.status(404).json({ error: 'Activity not found.' });

        const body = req.body || {};
        if (body.activity_type && !ACTIVITY_TYPES.includes(body.activity_type)) return res.status(422).json({ error: `activity_type must be one of ${ACTIVITY_TYPES.join(', ')}.` });
        if (body.status && !ACTIVITY_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${ACTIVITY_STATUSES.join(', ')}.` });

        const patch = _pick(body, ['activity_type', 'title', 'description', 'planned_hours', 'completed_hours', 'status', 'completion_date', 'evidence_notes', 'metadata']);
        if (patch.status === 'completed' && !body.completion_date) patch.completion_date = new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase.from('practice_learning_activities').update(patch).eq('id', activity.id).eq('company_id', cid).select().single();
        if (error) throw error;

        const goal = await _verifyGoal(activity.goal_id, cid);
        await _writeEvent(cid, patch.status === 'completed' ? 'activity_completed' : 'activity_updated', 'activity', data.id, req.user?.userId);
        if (goal) await _recalc(cid, goal.learning_plan_id);
        res.json({ activity: data });
    } catch (err) {
        console.error('PUT /api/practice/learning-centre/activities/:id', err);
        res.status(500).json({ error: 'Failed to update activity.' });
    }
});

router.delete('/activities/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const activity = await _verifyActivity(req.params.id, cid);
        if (!activity) return res.status(404).json({ error: 'Activity not found.' });

        const { data, error } = await supabase.from('practice_learning_activities').update({ status: 'cancelled' }).eq('id', activity.id).eq('company_id', cid).select().single();
        if (error) throw error;

        const goal = await _verifyGoal(activity.goal_id, cid);
        await _writeEvent(cid, 'activity_archived', 'activity', data.id, req.user?.userId);
        if (goal) await _recalc(cid, goal.learning_plan_id);
        res.json({ activity: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/learning-centre/activities/:id', err);
        res.status(500).json({ error: 'Failed to archive activity.' });
    }
});

// ── Progress ──────────────────────────────────────────────────────────────────

router.get('/progress/:plan_id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const plan = await _verifyPlan(req.params.plan_id, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });
        if (!_canView(plan, me)) return res.status(403).json({ error: 'You cannot view progress for this learning plan.' });

        const progress = await calculateLearningProgress(cid, plan.id);
        res.json({ progress });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/progress/:plan_id', err);
        res.status(500).json({ error: 'Failed to calculate progress.' });
    }
});

router.post('/progress/:plan_id/snapshot', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const plan = await _verifyPlan(req.params.plan_id, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });

        const progress = await calculateLearningProgress(cid, plan.id);
        const { data, error } = await supabase.from('practice_learning_progress').insert({
            company_id: cid, learning_plan_id: plan.id, overall_progress: progress.overall_progress,
            goals_total: progress.goals_total, goals_completed: progress.goals_completed,
            hours_planned: progress.hours_planned, hours_completed: progress.hours_completed,
            notes: req.body?.notes || null, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;

        await _writeEvent(cid, 'progress_snapshot_created', 'progress_snapshot', data.id, req.user?.userId, req.body?.notes || null);
        res.status(201).json({ snapshot: data, progress });
    } catch (err) {
        console.error('POST /api/practice/learning-centre/progress/:plan_id/snapshot', err);
        res.status(500).json({ error: 'Failed to capture progress snapshot.' });
    }
});

router.get('/progress/:plan_id/history', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const plan = await _verifyPlan(req.params.plan_id, cid);
        if (!plan) return res.status(404).json({ error: 'Learning plan not found.' });
        if (!_canView(plan, me)) return res.status(403).json({ error: 'You cannot view progress history for this learning plan.' });

        const { data, error } = await supabase.from('practice_learning_progress').select('*').eq('company_id', cid).eq('learning_plan_id', plan.id).order('snapshot_date', { ascending: false });
        if (error) throw error;
        res.json({ snapshots: data || [] });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/progress/:plan_id/history', err);
        res.status(500).json({ error: 'Failed to load progress history.' });
    }
});

// ── CPD CRUD ──────────────────────────────────────────────────────────────────

router.get('/cpd', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        let q = supabase.from('practice_cpd_records').select('*').eq('company_id', cid).eq('is_active', true).order('issue_date', { ascending: false });

        if (req.query.team_member_id) {
            const requestedId = parseInt(req.query.team_member_id, 10);
            if (!_isManager(me) && (!me || me.id !== requestedId)) return res.status(403).json({ error: 'You can only view your own CPD records.' });
            q = q.eq('team_member_id', requestedId);
        } else if (!_isManager(me)) {
            if (!me) return res.json({ cpd_records: [] });
            q = q.eq('team_member_id', me.id);
        }

        const { data, error } = await q;
        if (error) throw error;

        const today = new Date().toISOString().slice(0, 10);
        const memberIds = [...new Set((data || []).map(r => r.team_member_id))];
        let membersById = {};
        if (memberIds.length) {
            const { data: members } = await supabase.from('practice_team_members').select('id, display_name').in('id', memberIds);
            (members || []).forEach(m => { membersById[m.id] = m.display_name; });
        }
        const rows = (data || []).map(r => Object.assign({}, r, { team_member_name: membersById[r.team_member_id] || null, is_expired: !!(r.expiry_date && r.expiry_date < today) }));
        res.json({ cpd_records: rows });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/cpd', err);
        res.status(500).json({ error: 'Failed to load CPD records.' });
    }
});

router.post('/cpd', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (!body.team_member_id || !body.course_name) return res.status(422).json({ error: 'team_member_id and course_name are required.' });
        if (body.status && !CPD_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${CPD_STATUSES.join(', ')}.` });

        const { data, error } = await supabase.from('practice_cpd_records').insert({
            company_id: cid, team_member_id: parseInt(body.team_member_id, 10), provider: body.provider || null, course_name: body.course_name,
            hours: body.hours != null ? Number(body.hours) : 0, category: body.category || null, certificate_number: body.certificate_number || null,
            issue_date: body.issue_date || null, expiry_date: body.expiry_date || null, evidence: body.evidence || null,
            status: body.status || 'recorded', notes: body.notes || null, created_by: req.user?.userId || null,
        }).select().single();
        if (error) throw error;
        await _writeEvent(cid, 'cpd_recorded', 'cpd_record', data.id, req.user?.userId);
        res.status(201).json({ cpd_record: data });
    } catch (err) {
        console.error('POST /api/practice/learning-centre/cpd', err);
        res.status(500).json({ error: 'Failed to record CPD entry.' });
    }
});

router.put('/cpd/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const body = req.body || {};
        if (body.status && !CPD_STATUSES.includes(body.status)) return res.status(422).json({ error: `status must be one of ${CPD_STATUSES.join(', ')}.` });
        const patch = _pick(body, ['provider', 'course_name', 'hours', 'category', 'certificate_number', 'issue_date', 'expiry_date', 'evidence', 'status', 'notes']);

        const { data, error } = await supabase.from('practice_cpd_records').update(patch).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'CPD record not found.' });
        await _writeEvent(cid, 'cpd_updated', 'cpd_record', data.id, req.user?.userId);
        res.json({ cpd_record: data });
    } catch (err) {
        console.error('PUT /api/practice/learning-centre/cpd/:id', err);
        res.status(500).json({ error: 'Failed to update CPD record.' });
    }
});

router.delete('/cpd/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const manager = await _requireManager(req, res);
        if (!manager) return;
        const { data, error } = await supabase.from('practice_cpd_records').update({ is_active: false }).eq('id', req.params.id).eq('company_id', cid).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'CPD record not found.' });
        await _writeEvent(cid, 'cpd_archived', 'cpd_record', data.id, req.user?.userId);
        res.json({ cpd_record: data, archived: true });
    } catch (err) {
        console.error('DELETE /api/practice/learning-centre/cpd/:id', err);
        res.status(500).json({ error: 'Failed to archive CPD record.' });
    }
});

// ── Skills Matrix integration — suggested development goals ─────────────────
// Direct read of practice_team_skills (owned by Codebox 59) — no scoring
// logic to duplicate, just the same target>current gap filter already used
// on the Skills Matrix's own Training Needs tab. A manager may turn any
// suggestion into a real goal, or ignore it entirely — nothing automatic.

router.get('/suggested-goals/:team_member_id', async (req, res) => {
    try {
        const cid = req.companyId;
        const me = await _myTeamMember(cid, req.user?.userId);
        const requestedId = parseInt(req.params.team_member_id, 10);
        if (!_isManager(me) && (!me || me.id !== requestedId)) return res.status(403).json({ error: 'You can only view your own suggested goals.' });

        const { data, error } = await supabase.from('practice_team_skills').select('*, practice_skills:skill_id(skill_key, display_name)').eq('company_id', cid).eq('team_member_id', requestedId);
        if (error) throw error;

        const suggestions = (data || [])
            .filter(r => r.target_level != null && r.target_level > r.current_level)
            .map(r => ({
                skill_id: r.skill_id, skill_name: r.practice_skills?.display_name || null,
                current_level: r.current_level, target_level: r.target_level, gap: r.target_level - r.current_level,
            }))
            .sort((a, b) => b.gap - a.gap);

        res.json({ suggested_goals: suggestions });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/suggested-goals/:team_member_id', err);
        res.status(500).json({ error: 'Failed to load suggested development goals.' });
    }
});

// ── GET /events ───────────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_learning_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(200);
        if (req.query.entity_type) q = q.eq('entity_type', req.query.entity_type);
        if (req.query.entity_id) q = q.eq('entity_id', parseInt(req.query.entity_id, 10));
        const { data, error } = await q;
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/learning-centre/events', err);
        res.status(500).json({ error: 'Failed to load learning centre history.' });
    }
});

module.exports = router;

// Reusable helpers — Delegation (Codebox 58) calls getDevelopmentBadge() for
// its advisory; any future module can call calculateLearningProgress()
// in-process instead of re-implementing the progress formula.
module.exports.calculateLearningProgress = calculateLearningProgress;
module.exports.getDevelopmentBadge = getDevelopmentBadge;
