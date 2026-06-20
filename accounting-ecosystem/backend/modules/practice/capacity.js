// Practice Capacity Planning — Operational Resource Visibility
// Provides 4 endpoints aggregating team capacity, task workload, and risk signals.
// All routes scoped to req.companyId from JWT — no cross-tenant leakage.
//
// Capacity calculation rules (transparent, no AI):
//   estimated_task_hours = SUM(task.estimated_hours) for open tasks (null → 0, flagged in risks)
//   utilization          = (estimated_task_hours / weekly_capacity_hours) × 100
//   status thresholds:
//     unknown       — no weekly_capacity_hours set (null or 0)
//     underutilized — utilization < 50%
//     normal        — 50% ≤ utilization ≤ 85%
//     high          — 85% < utilization ≤ 100%
//     overloaded    — utilization > 100%

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../config/database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function capacityStatus(allocatedHours, weeklyCapacity) {
  if (!weeklyCapacity || weeklyCapacity <= 0) return 'unknown';
  const pct = (allocatedHours / weeklyCapacity) * 100;
  if (pct > 100)  return 'overloaded';
  if (pct > 85)   return 'high';
  if (pct >= 50)  return 'normal';
  return 'underutilized';
}

function utilizationPct(allocatedHours, weeklyCapacity) {
  if (!weeklyCapacity || weeklyCapacity <= 0) return null;
  return Math.round((allocatedHours / weeklyCapacity) * 100 * 10) / 10;
}

// ─── Shared: build per-member capacity data ────────────────────────────────────
// Used by both /summary and /team to avoid duplicate query logic.
// Returns an array of member objects with all capacity fields populated.

async function buildTeamCapacity(cid) {
  const t = today();

  const [members, tasks, deadlines, engagements, periods] = await Promise.all([

    supabase.from('practice_team_members')
      .select('id, display_name, role, weekly_capacity_hours, daily_capacity_hours, capacity_notes, capacity_is_active, is_active')
      .eq('company_id', cid)
      .eq('is_active', true)
      .order('display_name'),

    // Open tasks — fetch estimated_hours, preparer, reviewer
    supabase.from('practice_tasks')
      .select('id, preparer_team_member_id, reviewer_team_member_id, review_status, estimated_hours, status')
      .eq('company_id', cid)
      .not('status', 'in', '(completed,cancelled)'),

    // Open compliance deadlines
    supabase.from('practice_deadlines')
      .select('id, responsible_team_member_id')
      .eq('company_id', cid)
      .not('status', 'in', '(completed,submitted,missed,cancelled)'),

    // Active engagements — responsible member + estimated_hours_per_period
    supabase.from('practice_client_engagements')
      .select('id, responsible_team_member_id, estimated_hours_per_period, status')
      .eq('company_id', cid)
      .eq('status', 'active'),

    // Queued periods — join to engagement to get responsible member
    supabase.from('practice_engagement_periods')
      .select('id, engagement_id, status, practice_client_engagements:engagement_id(responsible_team_member_id)')
      .eq('company_id', cid)
      .in('status', ['queued', 'ready']),
  ]);

  if (members.error) throw members.error;

  // Build member map
  const map = {};
  for (const m of (members.data || [])) {
    map[m.id] = {
      member_id:              m.id,
      display_name:           m.display_name,
      role:                   m.role,
      weekly_capacity_hours:  m.weekly_capacity_hours  ? parseFloat(m.weekly_capacity_hours)  : null,
      daily_capacity_hours:   m.daily_capacity_hours   ? parseFloat(m.daily_capacity_hours)   : null,
      capacity_notes:         m.capacity_notes         || null,
      capacity_is_active:     m.capacity_is_active,
      active_task_count:      0,
      estimated_task_hours:   0,
      tasks_missing_hours:    0,
      review_pending_count:   0,
      owned_deadlines_count:  0,
      owned_engagements_count: 0,
      queued_periods_count:   0,
    };
  }

  // Aggregate tasks
  for (const t of (tasks.data || [])) {
    const prep = t.preparer_team_member_id;
    if (prep && map[prep]) {
      map[prep].active_task_count++;
      if (t.estimated_hours != null) {
        map[prep].estimated_task_hours += parseFloat(t.estimated_hours);
      } else {
        map[prep].tasks_missing_hours++;
      }
    }
    const rev = t.reviewer_team_member_id;
    if (rev && map[rev] && (t.review_status === 'pending' || t.review_status === 'in_review')) {
      map[rev].review_pending_count++;
    }
  }

  // Aggregate deadlines
  for (const d of (deadlines.data || [])) {
    if (d.responsible_team_member_id && map[d.responsible_team_member_id]) {
      map[d.responsible_team_member_id].owned_deadlines_count++;
    }
  }

  // Aggregate engagements
  for (const e of (engagements.data || [])) {
    if (e.responsible_team_member_id && map[e.responsible_team_member_id]) {
      map[e.responsible_team_member_id].owned_engagements_count++;
    }
  }

  // Aggregate queued periods (via engagement's responsible member)
  for (const p of (periods.data || [])) {
    const eng = p.practice_client_engagements;
    const rm = eng?.responsible_team_member_id;
    if (rm && map[rm]) {
      map[rm].queued_periods_count++;
    }
  }

  // Compute utilization + status per member
  return Object.values(map).map(m => ({
    ...m,
    estimated_task_hours:   Math.round(m.estimated_task_hours * 100) / 100,
    utilization_percentage: utilizationPct(m.estimated_task_hours, m.weekly_capacity_hours),
    capacity_status:        capacityStatus(m.estimated_task_hours, m.weekly_capacity_hours),
  })).sort((a, b) => {
    const statusOrder = { overloaded: 0, high: 1, normal: 2, underutilized: 3, unknown: 4 };
    return (statusOrder[a.capacity_status] ?? 5) - (statusOrder[b.capacity_status] ?? 5);
  });
}

// ─── GET /summary ─────────────────────────────────────────────────────────────
// Aggregated practice-wide capacity KPIs.

router.get('/summary', async (req, res) => {
  const cid = req.companyId;
  const t   = today();

  try {
    const [members, overdueDeadlines, queuedPeriods] = await Promise.all([
      // Defer heavy per-member aggregation to buildTeamCapacity
      buildTeamCapacity(cid),

      supabase.from('practice_deadlines')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .lt('due_date', t),

      supabase.from('practice_engagement_periods')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .in('status', ['queued', 'ready']),
    ]);

    const totalCapacity     = members.filter(m => m.capacity_is_active)
                                      .reduce((s, m) => s + (m.weekly_capacity_hours || 0), 0);
    const allocatedHours    = members.reduce((s, m) => s + m.estimated_task_hours, 0);
    const reviewTaskCount   = members.reduce((s, m) => s + m.review_pending_count, 0);
    const overloadedCount   = members.filter(m => m.capacity_status === 'overloaded').length;
    const underutilizedCount = members.filter(m => m.capacity_status === 'underutilized').length;

    res.json({
      total_team_capacity_hours:  Math.round(totalCapacity * 100) / 100,
      allocated_task_hours:       Math.round(allocatedHours * 100) / 100,
      review_task_count:          reviewTaskCount,
      overdue_deadline_count:     overdueDeadlines.count ?? 0,
      queued_period_count:        queuedPeriods.count ?? 0,
      utilization_percentage:     totalCapacity > 0
                                    ? Math.round((allocatedHours / totalCapacity) * 1000) / 10
                                    : null,
      overloaded_count:           overloadedCount,
      underutilized_count:        underutilizedCount,
    });
  } catch (err) {
    console.error('Capacity /summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /team ────────────────────────────────────────────────────────────────
// Full per-team-member capacity breakdown.

router.get('/team', async (req, res) => {
  const { member_id } = req.query;
  try {
    let members = await buildTeamCapacity(req.companyId);
    if (member_id) {
      members = members.filter(m => String(m.member_id) === String(member_id));
    }
    res.json({ team: members });
  } catch (err) {
    console.error('Capacity /team error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /clients ─────────────────────────────────────────────────────────────
// Per-client workload breakdown.

router.get('/clients', async (req, res) => {
  const cid = req.companyId;
  const t   = today();

  try {
    const [clients, tasks, workflows, deadlines, periods, engagements] = await Promise.all([

      supabase.from('practice_clients')
        .select('id, name')
        .eq('company_id', cid)
        .eq('is_active', true)
        .order('name'),

      // Open tasks per client
      supabase.from('practice_tasks')
        .select('id, client_id, estimated_hours')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,cancelled)'),

      // Active workflow runs per client
      supabase.from('practice_workflow_runs')
        .select('id, client_id')
        .eq('company_id', cid)
        .in('status', ['pending', 'in_progress']),

      // Overdue deadlines per client
      supabase.from('practice_deadlines')
        .select('id, client_id')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .lt('due_date', t),

      // Queued periods per client
      supabase.from('practice_engagement_periods')
        .select('id, client_id')
        .eq('company_id', cid)
        .in('status', ['queued', 'ready']),

      // Active engagements per client
      supabase.from('practice_client_engagements')
        .select('id, client_id')
        .eq('company_id', cid)
        .eq('status', 'active'),
    ]);

    if (clients.error) throw clients.error;

    // Build client map
    const clientMap = {};
    for (const c of (clients.data || [])) {
      clientMap[c.id] = {
        client_id:        c.id,
        client_name:      c.name,
        active_tasks:     0,
        estimated_hours:  0,
        active_workflows: 0,
        overdue_deadlines: 0,
        queued_periods:   0,
        active_engagements: 0,
      };
    }

    for (const r of (tasks.data || []))       { if (clientMap[r.client_id]) { clientMap[r.client_id].active_tasks++; clientMap[r.client_id].estimated_hours += (r.estimated_hours ? parseFloat(r.estimated_hours) : 0); } }
    for (const r of (workflows.data || []))   { if (clientMap[r.client_id]) clientMap[r.client_id].active_workflows++; }
    for (const r of (deadlines.data || []))   { if (clientMap[r.client_id]) clientMap[r.client_id].overdue_deadlines++; }
    for (const r of (periods.data || []))     { if (clientMap[r.client_id]) clientMap[r.client_id].queued_periods++; }
    for (const r of (engagements.data || [])) { if (clientMap[r.client_id]) clientMap[r.client_id].active_engagements++; }

    const result = Object.values(clientMap)
      .map(c => ({ ...c, estimated_hours: Math.round(c.estimated_hours * 100) / 100 }))
      .sort((a, b) => (b.active_tasks + b.overdue_deadlines) - (a.active_tasks + a.overdue_deadlines));

    res.json({ clients: result });
  } catch (err) {
    console.error('Capacity /clients error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /risks ────────────────────────────────────────────────────────────────
// Risk signals for capacity planning: overloaded members, unassigned work,
// missing data, and structural gaps. All counts, no AI.

router.get('/risks', async (req, res) => {
  const cid = req.companyId;

  try {
    const [
      memberCapacity,
      unassignedTasks,
      engagementsNoOwner,
      deadlinesNoOwner,
      periodsNoTemplate,
      tasksNoHours,
    ] = await Promise.all([

      // Overloaded + members with no capacity set
      buildTeamCapacity(cid),

      // Tasks with no preparer assigned (unassigned work)
      supabase.from('practice_tasks')
        .select('id, title, due_date, practice_clients:client_id(name)')
        .eq('company_id', cid)
        .is('preparer_team_member_id', null)
        .not('status', 'in', '(completed,cancelled)')
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(15),

      // Active engagements with no responsible team member
      supabase.from('practice_client_engagements')
        .select('id, engagement_name, practice_clients:client_id(name)')
        .eq('company_id', cid)
        .eq('status', 'active')
        .is('responsible_team_member_id', null)
        .order('engagement_name')
        .limit(15),

      // Open deadlines with no responsible team member
      supabase.from('practice_deadlines')
        .select('id, title, due_date, practice_clients:client_id(name)')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .is('responsible_team_member_id', null)
        .order('due_date', { ascending: true })
        .limit(15),

      // Queued periods whose engagement has no workflow template (cannot auto-generate)
      supabase.from('practice_engagement_periods')
        .select('id, period_label, practice_clients:client_id(name), practice_client_engagements:engagement_id(engagement_name, workflow_template_id)')
        .eq('company_id', cid)
        .in('status', ['queued', 'ready'])
        .order('created_at', { ascending: true })
        .limit(15),

      // Open tasks missing estimated_hours (cannot contribute to utilization calc)
      supabase.from('practice_tasks')
        .select('id, title, due_date, practice_clients:client_id(name), preparer:preparer_team_member_id(display_name)')
        .eq('company_id', cid)
        .is('estimated_hours', null)
        .not('status', 'in', '(completed,cancelled)')
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(15),
    ]);

    const overloaded = memberCapacity.filter(m => m.capacity_status === 'overloaded');
    const noCapacity = memberCapacity.filter(m => m.capacity_status === 'unknown' && m.active_task_count > 0);

    // Filter periods: only those where the engagement has no workflow_template_id
    const periodsWithNoTemplate = (periodsNoTemplate.data || []).filter(p => {
      return !p.practice_client_engagements?.workflow_template_id;
    });

    res.json({
      overloaded_team_members: overloaded.map(m => ({
        member_id:             m.member_id,
        display_name:          m.display_name,
        role:                  m.role,
        weekly_capacity_hours: m.weekly_capacity_hours,
        estimated_task_hours:  m.estimated_task_hours,
        utilization_percentage: m.utilization_percentage,
        active_task_count:     m.active_task_count,
      })),

      members_no_capacity_set: noCapacity.map(m => ({
        member_id:         m.member_id,
        display_name:      m.display_name,
        active_task_count: m.active_task_count,
      })),

      clients_with_unassigned_work: (unassignedTasks.data || []).map(r => ({
        id:          r.id,
        title:       r.title,
        due_date:    r.due_date,
        client_name: r.practice_clients?.name || null,
      })),

      engagements_without_owner: (engagementsNoOwner.data || []).map(r => ({
        id:              r.id,
        engagement_name: r.engagement_name,
        client_name:     r.practice_clients?.name || null,
      })),

      deadlines_without_owner: (deadlinesNoOwner.data || []).map(r => ({
        id:          r.id,
        title:       r.title,
        due_date:    r.due_date,
        client_name: r.practice_clients?.name || null,
      })),

      queued_periods_without_template: periodsWithNoTemplate.map(p => ({
        id:              p.id,
        period_label:    p.period_label,
        client_name:     p.practice_clients?.name || null,
        engagement_name: p.practice_client_engagements?.engagement_name || null,
      })),

      tasks_without_estimated_hours: (tasksNoHours.data || []).map(r => ({
        id:          r.id,
        title:       r.title,
        due_date:    r.due_date,
        client_name: r.practice_clients?.name || null,
        preparer:    r.preparer?.display_name || null,
      })),
    });
  } catch (err) {
    console.error('Capacity /risks error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
