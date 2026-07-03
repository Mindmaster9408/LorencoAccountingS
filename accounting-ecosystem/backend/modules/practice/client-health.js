// Practice Client Health Scoring — Transparent Rule-Based Risk Layer
//
// This is NOT AI. NOT predictive modelling.
// All scoring is transparent, count-based, and auditable.
//
// Scoring rules (start at 100, subtract penalties):
//   -25  any overdue deadline
//   -15  >3 overdue deadlines
//   -15  pending review tasks > 5
//   -10  unassigned active tasks > 0
//   -15  queued periods past period_start date
//   -10  active engagement has no responsible_team_member_id
//   -10  recurring engagement missing recurrence_start_date or recurrence_day
//   -15  approved/draft/reviewed WIP billing pack older than 30 days
//   -10  write-off percentage > 20%
//   -10  client has no responsible_team_member_id
//
// Status thresholds:
//   85–100 → good
//   65–84  → watch
//   40–64  → at_risk
//   0–39   → critical
//   null   → unknown (client has zero activity data)

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }
function thirtyDaysAgo() { return new Date(Date.now() - 30 * 86400000).toISOString(); }

function statusFromScore(score) {
  if (score === null) return 'unknown';
  if (score >= 85) return 'good';
  if (score >= 65) return 'watch';
  if (score >= 40) return 'at_risk';
  return 'critical';
}

// ─── Core scoring engine ───────────────────────────────────────────────────────
// Accepts one client object + pre-fetched arrays scoped to the company.
// Each array is filtered to the client inside this function.

function scoreClientFromData(client, data) {
  const { deadlines, tasks, periods, engagements, recurringEngagements, wipPacks, t, tda } = data;
  const cid = client.id;

  // Filter to this client
  const od = deadlines.filter(r =>
    r.client_id === cid &&
    r.due_date < t &&
    !['completed', 'submitted', 'missed', 'cancelled'].includes(r.status)
  );
  const rt = tasks.filter(r =>
    r.client_id === cid &&
    ['pending', 'in_review'].includes(r.review_status) &&
    !['completed', 'cancelled'].includes(r.status)
  );
  const ua = tasks.filter(r =>
    r.client_id === cid &&
    !r.preparer_team_member_id &&
    !['completed', 'cancelled'].includes(r.status)
  );
  const qp = periods.filter(r =>
    r.client_id === cid &&
    ['queued', 'ready'].includes(r.status) &&
    r.period_start < t
  );
  const ae = engagements.filter(r =>
    r.client_id === cid && r.status === 'active'
  );
  const re = recurringEngagements.filter(r =>
    r.client_id === cid &&
    r.status === 'active' &&
    r.recurrence_type &&
    !['once_off', 'ad_hoc'].includes(r.recurrence_type)
  );
  const wp = wipPacks.filter(r => r.client_id === cid);

  // Determine if there is enough activity data to score
  const totalActivity = od.length + rt.length + ua.length + qp.length + ae.length + wp.length;
  if (totalActivity === 0) {
    return buildResult(client, null, 'unknown', [], {
      overdue_deadlines:       0,
      pending_reviews:         0,
      unassigned_tasks:        0,
      queued_overdue_periods:  0,
      active_engagements:      0,
      engagements_no_owner:    0,
      missing_recurrence:      0,
      old_wip_count:           0,
      writeoff_percentage:     0,
    });
  }

  let score = 100;
  const riskFactors = [];

  // ── Overdue deadlines ────────────────────────────────────────────────────────
  if (od.length > 0) {
    score -= 25;
    riskFactors.push({ code: 'overdue_deadlines', label: 'Overdue deadlines', count: od.length, severity: 'critical',
      items: od.slice(0, 5).map(r => ({ id: r.id, label: r.title, due_date: r.due_date })) });
  }
  if (od.length > 3) {
    score -= 15;
    riskFactors.push({ code: 'many_overdue_deadlines', label: 'Multiple overdue deadlines (>3)', count: od.length, severity: 'critical' });
  }

  // ── Pending review tasks ─────────────────────────────────────────────────────
  if (rt.length > 5) {
    score -= 15;
    riskFactors.push({ code: 'review_backlog', label: 'Review backlog (>5 tasks pending)', count: rt.length, severity: 'warning',
      items: rt.slice(0, 5).map(r => ({ id: r.id, label: r.title })) });
  }

  // ── Unassigned active tasks ──────────────────────────────────────────────────
  if (ua.length > 0) {
    score -= 10;
    riskFactors.push({ code: 'unassigned_tasks', label: 'Unassigned active tasks', count: ua.length, severity: 'warning',
      items: ua.slice(0, 5).map(r => ({ id: r.id, label: r.title })) });
  }

  // ── Queued periods past period_start ─────────────────────────────────────────
  if (qp.length > 0) {
    score -= 15;
    riskFactors.push({ code: 'overdue_periods', label: 'Queued periods past start date', count: qp.length, severity: 'warning',
      items: qp.slice(0, 5).map(r => ({ id: r.id, label: r.period_label, period_start: r.period_start })) });
  }

  // ── Active engagement with no owner ─────────────────────────────────────────
  const engNoOwner = ae.filter(e => !e.responsible_team_member_id);
  if (engNoOwner.length > 0) {
    score -= 10;
    riskFactors.push({ code: 'engagement_no_owner', label: 'Active engagements without owner', count: engNoOwner.length, severity: 'warning',
      items: engNoOwner.slice(0, 5).map(r => ({ id: r.id, label: r.engagement_name })) });
  }

  // ── Recurring engagements missing recurrence config ──────────────────────────
  const engMissingRecurrence = re.filter(e => !e.recurrence_start_date || !e.recurrence_day);
  if (engMissingRecurrence.length > 0) {
    score -= 10;
    riskFactors.push({ code: 'missing_recurrence', label: 'Recurring engagements missing recurrence config', count: engMissingRecurrence.length, severity: 'info',
      items: engMissingRecurrence.slice(0, 5).map(r => ({ id: r.id, label: r.engagement_name })) });
  }

  // ── WIP billing packs older than 30 days ─────────────────────────────────────
  const tda30 = tda; // thirtyDaysAgo()
  const oldWip = wp.filter(p => {
    if (p.status === 'approved' && p.approved_at) return new Date(p.approved_at) < new Date(tda30);
    if (['draft', 'reviewed'].includes(p.status)) return new Date(p.created_at) < new Date(tda30);
    return false;
  });
  if (oldWip.length > 0) {
    score -= 15;
    riskFactors.push({ code: 'old_wip', label: 'WIP billing packs older than 30 days', count: oldWip.length, severity: 'warning',
      items: oldWip.slice(0, 5).map(r => ({ id: r.id, label: r.pack_name || ('Pack ' + r.id), status: r.status })) });
  }

  // ── Write-off percentage ─────────────────────────────────────────────────────
  const totalRecoverable = wp.reduce((s, p) => s + parseFloat(p.recoverable_value || 0), 0);
  const totalWriteoff    = wp.reduce((s, p) => s + parseFloat(p.writeoff_value    || 0), 0);
  const wipTotal         = totalRecoverable + totalWriteoff;
  const writeoffPct      = wipTotal > 0 ? Math.round((totalWriteoff / wipTotal) * 1000) / 10 : 0;
  if (writeoffPct > 20) {
    score -= 10;
    riskFactors.push({ code: 'high_writeoff', label: 'High write-off percentage (>20%)', value: writeoffPct + '%', severity: 'warning' });
  }

  // ── No responsible team member on client ─────────────────────────────────────
  if (!client.responsible_team_member_id) {
    score -= 10;
    riskFactors.push({ code: 'no_client_owner', label: 'No responsible team member assigned to client', severity: 'info' });
  }

  score = Math.max(0, score);
  const status = statusFromScore(score);

  const metrics = {
    overdue_deadlines:       od.length,
    pending_reviews:         rt.length,
    unassigned_tasks:        ua.length,
    queued_overdue_periods:  qp.length,
    active_engagements:      ae.length,
    engagements_no_owner:    engNoOwner.length,
    missing_recurrence:      engMissingRecurrence.length,
    old_wip_count:           oldWip.length,
    wip_pack_count:          wp.length,
    writeoff_percentage:     writeoffPct,
  };

  return buildResult(client, score, status, riskFactors, metrics);
}

function buildResult(client, score, status, riskFactors, metrics) {
  return {
    client_id:    client.id,
    client_name:  client.name,
    health_score: score,
    health_status: status,
    risk_factors: riskFactors,
    metrics,
    top_risks: riskFactors.filter(r => r.severity === 'critical' || r.severity === 'warning').slice(0, 3),
  };
}

// ─── Fetch all health-relevant data for a company (optionally filtered to one client) ──

async function fetchHealthData(cid, clientId = null) {
  const t   = today();
  const tda = thirtyDaysAgo();

  const applyClient = (q) => clientId ? q.eq('client_id', clientId) : q;

  const [clients, deadlines, tasks, periods, engagements, recurringEngagements, wipPacks] = await Promise.all([

    (() => {
      let q = supabase.from('practice_clients').select('*').eq('company_id', cid).eq('is_active', true);
      if (clientId) q = q.eq('id', clientId);
      return q;
    })(),

    // All deadlines — scored on overdue status in scoreClientFromData
    applyClient(
      supabase.from('practice_deadlines')
        .select('id, client_id, title, due_date, status')
        .eq('company_id', cid)
    ),

    // All open tasks — scored on review_status and preparer assignment
    applyClient(
      supabase.from('practice_tasks')
        .select('id, client_id, title, review_status, preparer_team_member_id, status')
        .eq('company_id', cid)
        .not('status', 'in', '(completed,cancelled)')
    ),

    // All queued/ready periods — scored on period_start vs today
    applyClient(
      supabase.from('practice_engagement_periods')
        .select('id, client_id, period_label, period_start, status')
        .eq('company_id', cid)
        .in('status', ['queued', 'ready'])
    ),

    // All active engagements — scored on owner presence
    applyClient(
      supabase.from('practice_client_engagements')
        .select('id, client_id, engagement_name, responsible_team_member_id, status')
        .eq('company_id', cid)
        .eq('status', 'active')
    ),

    // Active recurring engagements — scored on recurrence config completeness
    applyClient(
      supabase.from('practice_client_engagements')
        .select('id, client_id, engagement_name, recurrence_type, recurrence_start_date, recurrence_day, status')
        .eq('company_id', cid)
        .eq('status', 'active')
        .not('recurrence_type', 'is', null)
    ),

    // WIP billing packs (non-locked, non-cancelled) — scored on age and write-off
    applyClient(
      supabase.from('practice_billing_packs')
        .select('id, client_id, pack_name, status, approved_at, created_at, writeoff_value, recoverable_value')
        .eq('company_id', cid)
        .not('status', 'in', '(locked,cancelled)')
    ),
  ]);

  if (clients.error) throw new Error(clients.error.message);

  return {
    clients:               clients.data              || [],
    deadlines:             deadlines.data            || [],
    tasks:                 tasks.data                || [],
    periods:               periods.data              || [],
    engagements:           engagements.data          || [],
    recurringEngagements:  recurringEngagements.data || [],
    wipPacks:              wipPacks.data             || [],
    t,
    tda,
  };
}

// ─── Write score back to practice_clients + insert snapshot ──────────────────

async function persistScore(cid, result, calculatedBy) {
  const [clientUpdate, snapshotInsert] = await Promise.all([
    supabase.from('practice_clients')
      .update({
        health_score:              result.health_score,
        health_status:             result.health_status,
        health_last_calculated_at: new Date().toISOString(),
        updated_at:                new Date().toISOString(),
      })
      .eq('id', result.client_id)
      .eq('company_id', cid),

    supabase.from('practice_client_health_snapshots')
      .insert({
        company_id:    cid,
        client_id:     result.client_id,
        health_score:  result.health_score ?? 0,
        health_status: result.health_status,
        risk_factors:  result.risk_factors,
        metrics:       result.metrics,
        calculated_by: calculatedBy || null,
      }),
  ]);

  if (clientUpdate.error) throw new Error(clientUpdate.error.message);
  return result;
}

// ─── GET /summary ─────────────────────────────────────────────────────────────
// Reads cached health_status from practice_clients. Fast single query.

router.get('/summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('practice_clients')
      .select('health_status')
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    const counts = { total_clients: 0, good: 0, watch: 0, at_risk: 0, critical: 0, unknown: 0 };
    for (const c of (data || [])) {
      counts.total_clients++;
      const s = c.health_status || 'unknown';
      if (s in counts) counts[s]++;
      else counts.unknown++;
    }

    res.json(counts);
  } catch (err) {
    console.error('Client-health /summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET / — Client health list ───────────────────────────────────────────────
// Returns cached health fields per client + live overdue/review/period/WIP counts.

router.get('/', async (req, res) => {
  const cid = req.companyId;
  const { status, responsible_team_member_id, client_type, page = 1, limit = 100 } = req.query;
  const t   = today();
  const tda = thirtyDaysAgo();

  try {
    // Client query — reads cached health fields
    let clientQ = supabase
      .from('practice_clients')
      .select('id, name, client_type, responsible_team_member_id, health_score, health_status, health_last_calculated_at')
      .eq('company_id', cid)
      .eq('is_active', true)
      .order('name');

    if (status)                    clientQ = clientQ.eq('health_status',             status);
    if (responsible_team_member_id) clientQ = clientQ.eq('responsible_team_member_id', parseInt(responsible_team_member_id));
    if (client_type)               clientQ = clientQ.eq('client_type',               client_type);

    // Parallel: team members + live aggregate data
    const [clients, teamMembers, overdueDeadlines, reviewTasks, queuedPeriods, wipAll] = await Promise.all([
      clientQ,

      supabase.from('practice_team_members')
        .select('id, display_name')
        .eq('company_id', cid)
        .eq('is_active', true),

      supabase.from('practice_deadlines')
        .select('id, client_id')
        .eq('company_id', cid)
        .lt('due_date', t)
        .not('status', 'in', '(completed,submitted,missed,cancelled)'),

      supabase.from('practice_tasks')
        .select('id, client_id')
        .eq('company_id', cid)
        .in('review_status', ['pending', 'in_review'])
        .not('status', 'in', '(completed,cancelled)'),

      supabase.from('practice_engagement_periods')
        .select('id, client_id')
        .eq('company_id', cid)
        .in('status', ['queued', 'ready'])
        .lt('period_start', t),

      supabase.from('practice_billing_packs')
        .select('id, client_id, status, approved_at, created_at, writeoff_value, recoverable_value')
        .eq('company_id', cid)
        .not('status', 'in', '(locked,cancelled)'),
    ]);

    if (clients.error) return res.status(500).json({ error: clients.error.message });

    // Build member lookup
    const memberById = {};
    for (const m of (teamMembers.data || [])) memberById[m.id] = m.display_name;

    // Build per-client aggregate maps
    const odMap = {};
    for (const r of (overdueDeadlines.data || [])) odMap[r.client_id] = (odMap[r.client_id] || 0) + 1;

    const rtMap = {};
    for (const r of (reviewTasks.data || [])) rtMap[r.client_id] = (rtMap[r.client_id] || 0) + 1;

    const qpMap = {};
    for (const r of (queuedPeriods.data || [])) qpMap[r.client_id] = (qpMap[r.client_id] || 0) + 1;

    const wipMap = {};
    for (const p of (wipAll.data || [])) {
      if (!wipMap[p.client_id]) wipMap[p.client_id] = { old: 0, writeoff: 0, recoverable: 0 };
      const isOld = (p.status === 'approved' && p.approved_at && new Date(p.approved_at) < new Date(tda)) ||
                    (['draft', 'reviewed'].includes(p.status) && new Date(p.created_at) < new Date(tda));
      if (isOld) wipMap[p.client_id].old++;
      wipMap[p.client_id].writeoff   += parseFloat(p.writeoff_value    || 0);
      wipMap[p.client_id].recoverable += parseFloat(p.recoverable_value || 0);
    }

    const result = (clients.data || []).map(c => {
      const wip = wipMap[c.id] || { old: 0, writeoff: 0, recoverable: 0 };
      const wipTotal    = wip.writeoff + wip.recoverable;
      const writeoffPct = wipTotal > 0 ? Math.round((wip.writeoff / wipTotal) * 1000) / 10 : 0;

      // Derive top_risks from live counts (quick labels, no full rescore)
      const topRisks = [];
      if (odMap[c.id])  topRisks.push(odMap[c.id]  + ' overdue deadline'  + (odMap[c.id]  > 1 ? 's' : ''));
      if (rtMap[c.id])  topRisks.push(rtMap[c.id]  + ' review'            + (rtMap[c.id]  > 1 ? 's' : '') + ' pending');
      if (qpMap[c.id])  topRisks.push(qpMap[c.id]  + ' overdue period'    + (qpMap[c.id]  > 1 ? 's' : '') + ' queued');
      if (wip.old)      topRisks.push(wip.old       + ' old WIP pack'      + (wip.old      > 1 ? 's' : ''));
      if (writeoffPct > 20) topRisks.push(writeoffPct + '% write-off');

      return {
        client_id:                   c.id,
        client_name:                 c.name,
        client_type:                 c.client_type,
        responsible_team_member_id:  c.responsible_team_member_id,
        responsible:                 c.responsible_team_member_id ? (memberById[c.responsible_team_member_id] || null) : null,
        health_score:                c.health_score,
        health_status:               c.health_status || 'unknown',
        health_last_calculated_at:   c.health_last_calculated_at,
        top_risks:                   topRisks.slice(0, 3),
        overdue_deadlines:           odMap[c.id]  || 0,
        pending_reviews:             rtMap[c.id]  || 0,
        queued_periods:              qpMap[c.id]  || 0,
        high_wip:                    wip.old,
        writeoff_percentage:         writeoffPct,
      };
    });

    // Pagination
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(200, parseInt(limit) || 100);
    const from     = (pageNum - 1) * limitNum;

    res.json({ clients: result.slice(from, from + limitNum), total: result.length });
  } catch (err) {
    console.error('Client-health GET / error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /:clientId — Full client health detail ────────────────────────────────
// Always computes fresh (for accuracy). Does NOT write back to cache.

router.get('/:clientId', async (req, res) => {
  const cid      = req.companyId;
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  try {
    const data   = await fetchHealthData(cid, clientId);
    if (!data.clients.length) return res.status(404).json({ error: 'Client not found' });

    const result = scoreClientFromData(data.clients[0], data);

    // Also return the latest snapshot (for history context)
    const { data: latestSnap } = await supabase
      .from('practice_client_health_snapshots')
      .select('health_score, health_status, calculated_at, risk_factors, metrics')
      .eq('company_id', cid)
      .eq('client_id', clientId)
      .order('calculated_at', { ascending: false })
      .limit(1)
      .single();

    res.json({
      ...result,
      last_snapshot: latestSnap || null,
    });
  } catch (err) {
    console.error('Client-health GET /:clientId error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /recalculate ────────────────────────────────────────────────────────
// Recalculates health for one client or all active clients in the company.
// Writes score back to practice_clients and inserts a snapshot.

router.post('/recalculate', async (req, res) => {
  const cid      = req.companyId;
  const clientId = req.body.client_id ? parseInt(req.body.client_id) : null;

  // Resolve actor: prefer practice_team_members ID if available, else null
  const actorId = null; // Future: cross-ref req.user.userId → practice_team_members.user_id

  try {
    const data = await fetchHealthData(cid, clientId || null);

    if (clientId && !data.clients.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const results = [];
    for (const client of data.clients) {
      const result = scoreClientFromData(client, data);
      await persistScore(cid, result, actorId);
      results.push({ client_id: result.client_id, client_name: result.client_name, health_score: result.health_score, health_status: result.health_status });
    }

    // Audit log
    await auditFromReq(req, 'RECALCULATE', 'practice_client_health', clientId || 0, {
      module:         'practice',
      action:         'client_health_recalculated',
      client_id:      clientId,
      clients_scored: results.length,
    });

    res.json({
      recalculated: results.length,
      results,
    });
  } catch (err) {
    console.error('Client-health /recalculate error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// =============================================================================
// ACTIONS — Operational follow-up for client health risks
// =============================================================================
//
// Route map (all under /api/practice/client-health):
//   GET    /actions/summary              — company-wide action stats
//   GET    /:clientId/actions            — list actions for a client
//   POST   /:clientId/actions/from-risk  — create action from a risk factor
//   POST   /:clientId/actions            — create manual action
//   PUT    /actions/:id/complete         — mark complete (before generic PUT)
//   PUT    /actions/:id/dismiss          — mark dismissed
//   PUT    /actions/:id                  — generic field update
//
// Route ordering safety:
//   /actions/summary  (2-segment, literal) — no conflict with /:clientId (1-segment)
//   /:clientId/actions (2-segment)          — no conflict with /:clientId (1-segment)
//   /actions/:id/complete (3-segment)       — defined before /actions/:id (2-segment)
//
// Multi-tenant: every mutation verifies company ownership of client/action first.

const ACTION_TYPES = [
  'create_task', 'assign_owner', 'open_deadline', 'generate_period',
  'review_wip', 'fix_recurrence', 'fix_missing_owner', 'general_followup',
];
const ACTION_STATUSES = ['open', 'in_progress', 'completed', 'dismissed', 'cancelled'];

const RISK_TO_ACTION_TYPE = {
  overdue_deadlines:      'open_deadline',
  many_overdue_deadlines: 'open_deadline',
  review_backlog:         'create_task',
  unassigned_tasks:       'assign_owner',
  overdue_periods:        'generate_period',
  engagement_no_owner:    'fix_missing_owner',
  missing_recurrence:     'fix_recurrence',
  old_wip:                'review_wip',
  high_writeoff:          'review_wip',
  no_client_owner:        'assign_owner',
};

async function verifyClientBelongsToCompany(cid, clientId) {
  const { data } = await supabase
    .from('practice_clients')
    .select('id, name')
    .eq('id', clientId)
    .eq('company_id', cid)
    .eq('is_active', true)
    .single();
  return data || null;
}

async function verifyActionBelongsToCompany(cid, actionId) {
  const { data } = await supabase
    .from('practice_client_health_actions')
    .select('*')
    .eq('id', actionId)
    .eq('company_id', cid)
    .single();
  return data || null;
}

async function verifyTeamMemberLocal(cid, memberId) {
  if (!memberId) return true;
  const { data } = await supabase
    .from('practice_team_members')
    .select('id')
    .eq('id', parseInt(memberId))
    .eq('company_id', cid)
    .single();
  return !!data;
}

// ─── GET /actions/summary ─────────────────────────────────────────────────────

router.get('/actions/summary', async (req, res) => {
  const cid = req.companyId;
  const t   = today();
  try {
    const { data, error } = await supabase
      .from('practice_client_health_actions')
      .select('action_status, due_date')
      .eq('company_id', cid);
    if (error) return res.status(500).json({ error: error.message });

    const counts = { open: 0, in_progress: 0, completed: 0, dismissed: 0, overdue_actions: 0 };
    for (const a of (data || [])) {
      if (a.action_status === 'open')        counts.open++;
      if (a.action_status === 'in_progress') counts.in_progress++;
      if (a.action_status === 'completed')   counts.completed++;
      if (a.action_status === 'dismissed')   counts.dismissed++;
      if (['open', 'in_progress'].includes(a.action_status) && a.due_date && a.due_date < t) {
        counts.overdue_actions++;
      }
    }
    res.json(counts);
  } catch (err) {
    console.error('Health /actions/summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /:clientId/actions ───────────────────────────────────────────────────

router.get('/:clientId/actions', async (req, res) => {
  const cid      = req.companyId;
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  const client = await verifyClientBelongsToCompany(cid, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const [actions, members] = await Promise.all([
      supabase
        .from('practice_client_health_actions')
        .select('*')
        .eq('company_id', cid)
        .eq('client_id', clientId)
        .order('created_at', { ascending: false }),
      supabase
        .from('practice_team_members')
        .select('id, display_name')
        .eq('company_id', cid)
        .eq('is_active', true),
    ]);
    if (actions.error) return res.status(500).json({ error: actions.error.message });

    const memberById = {};
    for (const m of (members.data || [])) memberById[m.id] = m.display_name;

    const result = (actions.data || []).map(a => ({
      ...a,
      assigned_to_name: a.assigned_team_member_id
        ? (memberById[a.assigned_team_member_id] || null)
        : null,
    }));

    res.json({ actions: result });
  } catch (err) {
    console.error('Health GET /:clientId/actions error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /:clientId/actions/from-risk ───────────────────────────────────────
// Creates an action record. If action_type = create_task, also inserts a
// linked practice_task with the same title and due date.

router.post('/:clientId/actions/from-risk', async (req, res) => {
  const cid      = req.companyId;
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  const client = await verifyClientBelongsToCompany(cid, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { risk_code, risk_label, preferred_action_type, action_title,
          assigned_team_member_id, due_date, notes } = req.body;
  if (!risk_code) return res.status(400).json({ error: 'risk_code is required' });

  const actionType = preferred_action_type || RISK_TO_ACTION_TYPE[risk_code] || 'general_followup';
  if (!ACTION_TYPES.includes(actionType)) {
    return res.status(400).json({ error: 'Invalid action_type: ' + actionType });
  }

  const title      = action_title || ('Follow up: ' + (risk_label || risk_code));
  const assigneeId = assigned_team_member_id ? parseInt(assigned_team_member_id) : null;

  if (assigneeId) {
    const ok = await verifyTeamMemberLocal(cid, assigneeId);
    if (!ok) return res.status(400).json({ error: 'Assigned team member not found in this company' });
  }

  let linkedTaskId = null;

  try {
    if (actionType === 'create_task') {
      const { data: taskData, error: taskErr } = await supabase
        .from('practice_tasks')
        .insert({
          company_id:               cid,
          client_id:                clientId,
          title,
          description:              'Created from Client Health. Risk: ' + (risk_label || risk_code),
          type:                     'general',
          priority:                 'normal',
          due_date:                 due_date || null,
          status:                   'open',
          review_status:            'not_required',
          approval_status:          'not_required',
          qa_status:                'none',
          review_required:          false,
          approval_required:        false,
          preparer_team_member_id:  assigneeId || null,
          created_by:               req.user.userId,
        })
        .select('id')
        .single();

      if (taskErr) return res.status(500).json({ error: 'Failed to create task: ' + taskErr.message });
      linkedTaskId = taskData.id;

      await auditFromReq(req, 'CREATE', 'practice_task', linkedTaskId, {
        module: 'practice', action: 'health_action_task_created',
        client_id: clientId, risk_code,
      });
    }

    const { data: actionData, error: actionErr } = await supabase
      .from('practice_client_health_actions')
      .insert({
        company_id:               cid,
        client_id:                clientId,
        action_type:              actionType,
        action_title:             title,
        action_status:            'open',
        source_risk_code:         risk_code,
        source_risk_label:        risk_label || null,
        linked_task_id:           linkedTaskId,
        assigned_team_member_id:  assigneeId,
        due_date:                 due_date || null,
        notes:                    notes    || null,
        created_by:               req.user.userId,
      })
      .select()
      .single();

    if (actionErr) return res.status(500).json({ error: actionErr.message });

    await auditFromReq(req, 'CREATE', 'practice_client_health_action', actionData.id, {
      module: 'practice', action: 'health_action_created',
      client_id: clientId, action_type: actionType,
      risk_code, linked_task_id: linkedTaskId,
    });

    res.status(201).json({ action: actionData, linked_task_id: linkedTaskId });
  } catch (err) {
    console.error('Health POST from-risk error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /:clientId/actions — manual action ──────────────────────────────────

router.post('/:clientId/actions', async (req, res) => {
  const cid      = req.companyId;
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  const client = await verifyClientBelongsToCompany(cid, clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { action_type, action_title, source_risk_code, source_risk_label,
          assigned_team_member_id, due_date, notes } = req.body;

  if (!action_type)  return res.status(400).json({ error: 'action_type is required' });
  if (!action_title) return res.status(400).json({ error: 'action_title is required' });
  if (!ACTION_TYPES.includes(action_type)) {
    return res.status(400).json({ error: 'Invalid action_type: ' + action_type });
  }

  const assigneeId = assigned_team_member_id ? parseInt(assigned_team_member_id) : null;
  if (assigneeId) {
    const ok = await verifyTeamMemberLocal(cid, assigneeId);
    if (!ok) return res.status(400).json({ error: 'Assigned team member not found in this company' });
  }

  try {
    const { data, error } = await supabase
      .from('practice_client_health_actions')
      .insert({
        company_id:               cid,
        client_id:                clientId,
        action_type,
        action_title,
        action_status:            'open',
        source_risk_code:         source_risk_code  || null,
        source_risk_label:        source_risk_label || null,
        assigned_team_member_id:  assigneeId,
        due_date:                 due_date || null,
        notes:                    notes    || null,
        created_by:               req.user.userId,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'practice_client_health_action', data.id, {
      module: 'practice', action: 'health_action_created',
      client_id: clientId, action_type,
    });

    res.status(201).json({ action: data });
  } catch (err) {
    console.error('Health POST /:clientId/actions error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUT /actions/:id/complete ────────────────────────────────────────────────

router.put('/actions/:id/complete', async (req, res) => {
  const cid      = req.companyId;
  const actionId = parseInt(req.params.id);
  if (!actionId) return res.status(400).json({ error: 'Invalid action ID' });

  const existing = await verifyActionBelongsToCompany(cid, actionId);
  if (!existing) return res.status(404).json({ error: 'Action not found' });

  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('practice_client_health_actions')
      .update({
        action_status: 'completed',
        completed_at:  now,
        completed_by:  req.user.userId,
        updated_at:    now,
        updated_by:    req.user.userId,
      })
      .eq('id', actionId)
      .eq('company_id', cid)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_client_health_action', actionId, {
      module: 'practice', action: 'health_action_completed',
      client_id: existing.client_id,
    });
    res.json({ action: data });
  } catch (err) {
    console.error('Health PUT /actions/:id/complete error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUT /actions/:id/dismiss ─────────────────────────────────────────────────

router.put('/actions/:id/dismiss', async (req, res) => {
  const cid      = req.companyId;
  const actionId = parseInt(req.params.id);
  if (!actionId) return res.status(400).json({ error: 'Invalid action ID' });

  const existing = await verifyActionBelongsToCompany(cid, actionId);
  if (!existing) return res.status(404).json({ error: 'Action not found' });

  try {
    const { data, error } = await supabase
      .from('practice_client_health_actions')
      .update({
        action_status: 'dismissed',
        notes:         req.body.notes != null ? req.body.notes : (existing.notes || null),
        updated_at:    new Date().toISOString(),
        updated_by:    req.user.userId,
      })
      .eq('id', actionId)
      .eq('company_id', cid)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_client_health_action', actionId, {
      module: 'practice', action: 'health_action_dismissed',
      client_id: existing.client_id,
    });
    res.json({ action: data });
  } catch (err) {
    console.error('Health PUT /actions/:id/dismiss error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUT /actions/:id — generic update ────────────────────────────────────────

router.put('/actions/:id', async (req, res) => {
  const cid      = req.companyId;
  const actionId = parseInt(req.params.id);
  if (!actionId) return res.status(400).json({ error: 'Invalid action ID' });

  const existing = await verifyActionBelongsToCompany(cid, actionId);
  if (!existing) return res.status(404).json({ error: 'Action not found' });

  const allowed = ['action_title', 'action_type', 'action_status',
                   'assigned_team_member_id', 'due_date', 'notes', 'settings'];
  const update  = { updated_at: new Date().toISOString(), updated_by: req.user.userId };

  for (const k of allowed) {
    if (!(k in req.body)) continue;
    if (k === 'action_type'   && !ACTION_TYPES.includes(req.body[k]))    return res.status(400).json({ error: 'Invalid action_type' });
    if (k === 'action_status' && !ACTION_STATUSES.includes(req.body[k])) return res.status(400).json({ error: 'Invalid action_status' });
    update[k] = req.body[k];
  }

  if (update.assigned_team_member_id != null) {
    const ok = await verifyTeamMemberLocal(cid, update.assigned_team_member_id);
    if (!ok) return res.status(400).json({ error: 'Assigned team member not found in this company' });
    update.assigned_team_member_id = parseInt(update.assigned_team_member_id) || null;
  }

  try {
    const { data, error } = await supabase
      .from('practice_client_health_actions')
      .update(update)
      .eq('id', actionId)
      .eq('company_id', cid)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'practice_client_health_action', actionId, {
      module: 'practice', action: 'health_action_updated',
      client_id: existing.client_id,
    });
    res.json({ action: data });
  } catch (err) {
    console.error('Health PUT /actions/:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// ─── Exports for reuse by other modules (Codebox 41 convention) ───────────────
// Codebox 61 (client-success.js) composes operational health with relationship
// data instead of recomputing overdue-deadline/task/WIP logic — see
// calculateClientHealth() in client-success.js.
module.exports.scoreClientFromData = scoreClientFromData;
module.exports.fetchHealthData     = fetchHealthData;
module.exports.statusFromScore     = statusFromScore;
