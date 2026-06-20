// Practice Dashboard — Operational Command Centre
// Provides 4 endpoints aggregating practice-wide KPI, workload, risk, and activity data.
// All routes are company-scoped via req.companyId from JWT — no cross-tenant leakage possible.

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../config/database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
}

// ─── GET /summary ─────────────────────────────────────────────────────────────
// 9 KPI counts for the command centre header cards.
// All counts come from transparent DB queries — no AI scoring, no heuristics.

router.get('/summary', async (req, res) => {
  const cid = req.companyId;
  const t   = today();
  const w7  = daysFromNow(7);

  try {
    const [
      activeClients,
      activeEngagements,
      overdueDeadlines,
      dueThisWeek,
      tasksInReview,
      tasksPendingApproval,
      activeWorkflows,
      billingPending,
      periodsPending,
    ] = await Promise.all([

      // Active clients
      supabase.from('practice_clients')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid).eq('is_active', true),

      // Active engagements
      supabase.from('practice_client_engagements')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid).eq('status', 'active'),

      // Overdue compliance deadlines (past due, not yet resolved)
      supabase.from('practice_deadlines')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .lt('due_date', t),

      // Deadlines due in next 7 days (still open)
      supabase.from('practice_deadlines')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .gte('due_date', t)
        .lte('due_date', w7),

      // Tasks sitting in review (reviewer has not acted yet)
      supabase.from('practice_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .in('review_status', ['pending', 'in_review'])
        .not('status', 'in', '(completed,cancelled)'),

      // Tasks pending partner/manager approval
      supabase.from('practice_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .eq('approval_status', 'pending')
        .not('status', 'in', '(completed,cancelled)'),

      // Active workflow runs (not yet completed or cancelled)
      supabase.from('practice_workflow_runs')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .in('status', ['pending', 'in_progress']),

      // Billing packs awaiting review or approval
      supabase.from('practice_billing_packs')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .in('status', ['draft', 'reviewed']),

      // Queued or ready service periods (no workflow generated yet)
      supabase.from('practice_engagement_periods')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid)
        .in('status', ['queued', 'ready']),
    ]);

    res.json({
      active_clients:         activeClients.count         ?? 0,
      active_engagements:     activeEngagements.count     ?? 0,
      overdue_deadlines:      overdueDeadlines.count      ?? 0,
      due_this_week:          dueThisWeek.count           ?? 0,
      tasks_in_review:        tasksInReview.count         ?? 0,
      tasks_pending_approval: tasksPendingApproval.count  ?? 0,
      active_workflows:       activeWorkflows.count       ?? 0,
      billing_pending:        billingPending.count        ?? 0,
      periods_pending:        periodsPending.count        ?? 0,
    });
  } catch (err) {
    console.error('Dashboard /summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /workload ────────────────────────────────────────────────────────────
// Per-team-member workload breakdown.
// Fetches all active team members + open tasks, deadlines, engagements in one
// parallel batch, then aggregates in JS — avoids N+1 per member queries.

router.get('/workload', async (req, res) => {
  const cid = req.companyId;

  try {
    const [members, tasks, deadlines, engagements] = await Promise.all([

      supabase.from('practice_team_members')
        .select('id, display_name, role, is_active')
        .eq('company_id', cid)
        .eq('is_active', true)
        .order('display_name'),

      // Open tasks — we track by preparer (doer) and reviewer
      supabase.from('practice_tasks')
        .select('id, preparer_team_member_id, reviewer_team_member_id, status, review_status')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,cancelled)'),

      // Open compliance deadlines — track by responsible member
      supabase.from('practice_deadlines')
        .select('id, responsible_team_member_id, status')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)'),

      // Active engagements — track by responsible member
      supabase.from('practice_client_engagements')
        .select('id, responsible_team_member_id, status')
        .eq('company_id', cid)
        .eq('status', 'active'),
    ]);

    if (members.error) throw members.error;

    const map = {};
    for (const m of (members.data || [])) {
      map[m.id] = {
        member_id:        m.id,
        display_name:     m.display_name,
        role:             m.role,
        active_tasks:     0,
        review_tasks:     0,
        deadlines_owned:  0,
        engagements_owned: 0,
      };
    }

    for (const t of (tasks.data || [])) {
      if (t.preparer_team_member_id && map[t.preparer_team_member_id]) {
        map[t.preparer_team_member_id].active_tasks++;
      }
      if (t.reviewer_team_member_id && map[t.reviewer_team_member_id] &&
          (t.review_status === 'pending' || t.review_status === 'in_review')) {
        map[t.reviewer_team_member_id].review_tasks++;
      }
    }

    for (const d of (deadlines.data || [])) {
      if (d.responsible_team_member_id && map[d.responsible_team_member_id]) {
        map[d.responsible_team_member_id].deadlines_owned++;
      }
    }

    for (const e of (engagements.data || [])) {
      if (e.responsible_team_member_id && map[e.responsible_team_member_id]) {
        map[e.responsible_team_member_id].engagements_owned++;
      }
    }

    const workload = Object.values(map).sort((a, b) =>
      (b.active_tasks + b.review_tasks + b.deadlines_owned) -
      (a.active_tasks + a.review_tasks + a.deadlines_owned)
    );

    res.json({ workload });
  } catch (err) {
    console.error('Dashboard /workload error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /risk ────────────────────────────────────────────────────────────────
// Risk items grouped by category.
// Returns top 10 items per list — enough for the dashboard panels without
// creating oversized payloads. Each list is ordered by urgency (due_date asc).
// RED/AMBER/GREEN is determined client-side from counts — no AI scoring here.

router.get('/risk', async (req, res) => {
  const cid = req.companyId;
  const t   = today();

  try {
    const [overdueDeadlines, dueThisWeek, reviewBacklog, approvalBacklog, billingPending, periodsPending] = await Promise.all([

      // Overdue compliance deadlines
      supabase.from('practice_deadlines')
        .select('id, title, due_date, status, priority, compliance_area, deadline_type, responsible_team_member_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .lt('due_date', t)
        .order('due_date', { ascending: true })
        .limit(10),

      // Deadlines due in next 7 days
      supabase.from('practice_deadlines')
        .select('id, title, due_date, status, priority, compliance_area, deadline_type, responsible_team_member_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,submitted,missed,cancelled)')
        .gte('due_date', t)
        .lte('due_date', daysFromNow(7))
        .order('due_date', { ascending: true })
        .limit(10),

      // Tasks in review queue (oldest first)
      supabase.from('practice_tasks')
        .select('id, title, status, review_status, due_date, preparer_team_member_id, reviewer_team_member_id, practice_clients:client_id(name), practice_team_members!reviewer_team_member_id(display_name)')
        .eq('company_id', cid)
        .in('review_status', ['pending', 'in_review'])
        .not('status', 'in', '(completed,cancelled)')
        .order('created_at', { ascending: true })
        .limit(10),

      // Tasks pending approval (oldest first)
      supabase.from('practice_tasks')
        .select('id, title, status, approval_status, due_date, approver_team_member_id, practice_clients:client_id(name), practice_team_members!approver_team_member_id(display_name)')
        .eq('company_id', cid)
        .eq('approval_status', 'pending')
        .not('status', 'in', '(completed,cancelled)')
        .order('created_at', { ascending: true })
        .limit(10),

      // Billing packs in draft/reviewed (oldest first)
      supabase.from('practice_billing_packs')
        .select('id, pack_number, pack_name, status, total_value, created_at, practice_clients:client_id(name)')
        .eq('company_id', cid)
        .in('status', ['draft', 'reviewed'])
        .order('created_at', { ascending: true })
        .limit(10),

      // Pending service periods — queued but no workflow yet (earliest period_end first)
      supabase.from('practice_engagement_periods')
        .select('id, period_label, status, period_end, due_date, practice_client_engagements:engagement_id(engagement_name), practice_clients:client_id(name)')
        .eq('company_id', cid)
        .in('status', ['queued', 'ready'])
        .order('period_end', { ascending: true })
        .limit(10),
    ]);

    const fmt = (rows, transform) => (rows.data || []).map(transform);

    res.json({
      overdue_deadlines: fmt(overdueDeadlines, r => ({
        id:             r.id,
        title:          r.title,
        due_date:       r.due_date,
        status:         r.status,
        priority:       r.priority,
        compliance_area: r.compliance_area,
        client_name:    r.practice_clients?.name || null,
        responsible:    r.practice_team_members?.display_name || null,
        days_overdue:   Math.floor((new Date(t) - new Date(r.due_date)) / 86400000),
      })),

      due_this_week: fmt(dueThisWeek, r => ({
        id:             r.id,
        title:          r.title,
        due_date:       r.due_date,
        status:         r.status,
        priority:       r.priority,
        compliance_area: r.compliance_area,
        client_name:    r.practice_clients?.name || null,
        responsible:    r.practice_team_members?.display_name || null,
        days_until:     Math.floor((new Date(r.due_date) - new Date(t)) / 86400000),
      })),

      review_backlog: fmt(reviewBacklog, r => ({
        id:           r.id,
        title:        r.title,
        review_status: r.review_status,
        due_date:     r.due_date,
        client_name:  r.practice_clients?.name || null,
        reviewer:     r.practice_team_members?.display_name || null,
      })),

      approval_backlog: fmt(approvalBacklog, r => ({
        id:              r.id,
        title:           r.title,
        approval_status: r.approval_status,
        due_date:        r.due_date,
        client_name:     r.practice_clients?.name || null,
        approver:        r.practice_team_members?.display_name || null,
      })),

      billing_pending: fmt(billingPending, r => ({
        id:          r.id,
        pack_number: r.pack_number,
        pack_name:   r.pack_name,
        status:      r.status,
        total_value: r.total_value,
        created_at:  r.created_at,
        client_name: r.practice_clients?.name || null,
      })),

      periods_pending: fmt(periodsPending, r => ({
        id:              r.id,
        period_label:    r.period_label,
        status:          r.status,
        period_end:      r.period_end,
        due_date:        r.due_date,
        engagement_name: r.practice_client_engagements?.engagement_name || null,
        client_name:     r.practice_clients?.name || null,
      })),
    });
  } catch (err) {
    console.error('Dashboard /risk error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /activity ────────────────────────────────────────────────────────────
// Last 50 events across engagement events, deadline events, and billing pack events.
// Returns a unified chronological feed.
//
// Note: practice_client_engagement_events.engagement_id has no FK constraint,
// so Supabase PostgREST cannot do an embedded join. We do a two-step fetch:
// (1) fetch raw events, (2) look up engagement + client names by IDs.

router.get('/activity', async (req, res) => {
  const cid = req.companyId;

  try {
    const [engEvents, deadlineEvents, billingEvents] = await Promise.all([

      // Raw engagement events — no embedded join (no FK constraint on engagement_id)
      supabase.from('practice_client_engagement_events')
        .select('id, event_type, created_at, actor_user_id, notes, engagement_id')
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(25),

      // Deadline events — FK exists so embedded join works
      supabase.from('practice_deadline_events')
        .select('id, event_type, old_status, new_status, created_at, created_by, practice_deadlines:deadline_id(title, practice_clients:client_id(name))')
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(15),

      // Billing pack events — FK exists so embedded join works
      supabase.from('practice_billing_pack_events')
        .select('id, event_type, old_status, new_status, created_at, created_by, practice_billing_packs:billing_pack_id(pack_number, pack_name, practice_clients:client_id(name))')
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(15),
    ]);

    // Look up engagement names + client names for the engagement event IDs
    const engIds = [...new Set((engEvents.data || []).map(e => e.engagement_id).filter(Boolean))];
    let engMap = {};
    if (engIds.length) {
      const { data: engs } = await supabase
        .from('practice_client_engagements')
        .select('id, engagement_name, practice_clients:client_id(name)')
        .eq('company_id', cid)
        .in('id', engIds);
      for (const eng of (engs || [])) {
        engMap[eng.id] = { name: eng.engagement_name, client: eng.practice_clients?.name || null };
      }
    }

    const events = [];

    for (const e of (engEvents.data || [])) {
      const eng = engMap[e.engagement_id] || {};
      events.push({
        source:      'engagement',
        event_type:  e.event_type,
        created_at:  e.created_at,
        created_by:  e.actor_user_id ? String(e.actor_user_id) : null,
        label:       eng.name || null,
        client_name: eng.client || null,
      });
    }

    for (const e of (deadlineEvents.data || [])) {
      const dl = e.practice_deadlines;
      events.push({
        source:      'deadline',
        event_type:  e.event_type,
        old_status:  e.old_status,
        new_status:  e.new_status,
        created_at:  e.created_at,
        created_by:  e.created_by ? String(e.created_by) : null,
        label:       dl?.title || null,
        client_name: dl?.practice_clients?.name || null,
      });
    }

    for (const e of (billingEvents.data || [])) {
      const pk = e.practice_billing_packs;
      events.push({
        source:      'billing',
        event_type:  e.event_type,
        old_status:  e.old_status,
        new_status:  e.new_status,
        created_at:  e.created_at,
        created_by:  e.created_by ? String(e.created_by) : null,
        label:       pk ? `Pack #${pk.pack_number}${pk.pack_name ? ' — ' + pk.pack_name : ''}` : null,
        client_name: pk?.practice_clients?.name || null,
      });
    }

    events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ events: events.slice(0, 50) });
  } catch (err) {
    console.error('Dashboard /activity error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
