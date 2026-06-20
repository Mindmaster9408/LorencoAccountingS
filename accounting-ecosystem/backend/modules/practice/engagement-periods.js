/**
 * Lorenco Practice — Engagement Period Queue Router (Codebox 16)
 *
 * Manages the manual period queue for recurring client engagements.
 * A period represents one discrete service window (e.g. "January 2026 VAT").
 * Periods are created manually by the user via preview → confirm.
 * Workflow generation from a period is also triggered manually — one period at a time.
 *
 * NO cron. NO auto-generation. NO invoicing. NO SARS tax math.
 *
 * Multi-tenant: every operation verifies req.companyId against DB rows.
 * Rule D: no localStorage/KV for business data — all state via API.
 */

'use strict';

const express         = require('express');
const router          = express.Router();
const { supabase }    = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const workflowService = require('./services/workflowService');

// ─── Constants ────────────────────────────────────────────────────────────────

const PERIOD_STATUSES   = ['queued', 'ready', 'generated', 'skipped', 'cancelled'];
const RECURRENCE_TYPES  = ['monthly', 'quarterly', 'annual', 'once_off', 'ad_hoc'];
const MAX_PERIODS_LIMIT = 36;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchEngagement(companyId, engagementId) {
  const { data } = await supabase
    .from('practice_client_engagements')
    .select('*')
    .eq('id', parseInt(engagementId))
    .eq('company_id', companyId)
    .single();
  return data || null;
}

async function fetchPeriod(companyId, periodId) {
  const { data } = await supabase
    .from('practice_engagement_periods')
    .select('*')
    .eq('id', parseInt(periodId))
    .eq('company_id', companyId)
    .single();
  return data || null;
}

async function logEngagementEvent(companyId, engagementId, eventType, opts = {}) {
  try {
    await supabase.from('practice_client_engagement_events').insert({
      company_id:    companyId,
      engagement_id: parseInt(engagementId),
      event_type:    eventType,
      actor_user_id: opts.actorUserId || null,
      notes:         opts.notes       || null,
      metadata:      opts.metadata    || {}
    });
  } catch (_) { /* non-fatal */ }
}

// Parse date string YYYY-MM-DD without timezone shift.
function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// Format a UTC date to YYYY-MM-DD string.
function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

// Last day of a UTC month.
function lastDayOfMonth(year, month) {
  // month is 1-based; go to first of next month then subtract 1 day
  return new Date(Date.UTC(year, month, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// RECURRENCE ENGINE
// Generates an array of period descriptors from fromDate to toDate.
// Returns: { periods: [{period_label, period_start, period_end, due_date, anchor_date}], warnings: [] }
// No tax math. No SARS dates. Operational periods only.
// ─────────────────────────────────────────────────────────────────────────────

function buildPeriods(engagement, fromDateStr, toDateStr, maxPeriods) {
  const recType  = engagement.recurrence_type || 'ad_hoc';
  const max      = Math.min(maxPeriods || MAX_PERIODS_LIMIT, MAX_PERIODS_LIMIT);
  const warnings = [];
  const periods  = [];

  const fromDate = parseDate(fromDateStr);
  const toDate   = parseDate(toDateStr);

  if (!fromDate || !toDate) {
    return { periods: [], warnings: ['Invalid from_date or to_date'] };
  }
  if (fromDate > toDate) {
    return { periods: [], warnings: ['from_date must be on or before to_date'] };
  }

  // For ad_hoc: no automatic preview — caller must supply manual dates
  if (recType === 'ad_hoc') {
    return {
      periods: [],
      warnings: ['Engagement uses ad_hoc recurrence — periods cannot be auto-previewed. Create periods manually by specifying exact dates.']
    };
  }

  // once_off: exactly one period covering the entire from/to range
  if (recType === 'once_off') {
    const yr   = fromDate.getUTCFullYear();
    const mo   = fromDate.getUTCMonth() + 1;
    const dy   = fromDate.getUTCDate();
    periods.push({
      period_label: 'Once-off: ' + fromDateStr + ' to ' + toDateStr,
      period_start: fromDateStr,
      period_end:   toDateStr,
      due_date:     null,
      anchor_date:  fromDateStr
    });
    return { periods, warnings };
  }

  // monthly: one period per calendar month
  if (recType === 'monthly') {
    let cur = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];

    while (cur <= toDate && periods.length < max) {
      const y   = cur.getUTCFullYear();
      const m   = cur.getUTCMonth(); // 0-based
      const m1  = m + 1;            // 1-based
      const startDay = engagement.recurrence_day
        ? Math.min(engagement.recurrence_day, 28)
        : 1;
      const pStart = new Date(Date.UTC(y, m, startDay));
      const pEnd   = lastDayOfMonth(y, m1);

      periods.push({
        period_label: monthNames[m] + ' ' + y,
        period_start: fmtDate(pStart),
        period_end:   fmtDate(pEnd),
        due_date:     null,
        anchor_date:  fmtDate(pStart)
      });
      // Advance to first of next month
      cur = new Date(Date.UTC(y, m + 1, 1));
    }

    if (periods.length >= max && cur <= toDate) {
      warnings.push('max_periods limit reached (' + max + '). Not all months in range were previewed.');
    }
    return { periods, warnings };
  }

  // quarterly: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec
  if (recType === 'quarterly') {
    const QUARTERS = [
      { months: [0,1,2],  label: 'Q1' },
      { months: [3,4,5],  label: 'Q2' },
      { months: [6,7,8],  label: 'Q3' },
      { months: [9,10,11], label: 'Q4' }
    ];

    const startYear    = fromDate.getUTCFullYear();
    const startQtr     = Math.floor(fromDate.getUTCMonth() / 3);  // 0-3
    const endYear      = toDate.getUTCFullYear();
    const endQtr       = Math.floor(toDate.getUTCMonth() / 3);

    let curYear = startYear;
    let curQtr  = startQtr;

    while (periods.length < max) {
      if (curYear > endYear) break;
      if (curYear === endYear && curQtr > endQtr) break;

      const q       = QUARTERS[curQtr];
      const y       = curYear;
      const firstM  = q.months[0];  // 0-based
      const lastM   = q.months[2];  // 0-based
      const pStart  = new Date(Date.UTC(y, firstM, 1));
      const pEnd    = lastDayOfMonth(y, lastM + 1);

      periods.push({
        period_label: q.label + ' ' + y,
        period_start: fmtDate(pStart),
        period_end:   fmtDate(pEnd),
        due_date:     null,
        anchor_date:  fmtDate(pStart)
      });

      curQtr++;
      if (curQtr > 3) { curQtr = 0; curYear++; }
    }

    if (periods.length >= max) {
      warnings.push('max_periods limit reached (' + max + '). Not all quarters in range were previewed.');
    }
    return { periods, warnings };
  }

  // annual: one period per calendar year
  if (recType === 'annual') {
    const startYear = fromDate.getUTCFullYear();
    const endYear   = toDate.getUTCFullYear();

    for (let y = startYear; y <= endYear && periods.length < max; y++) {
      const startMonth = engagement.recurrence_month
        ? Math.min(Math.max(engagement.recurrence_month, 1), 12) - 1  // 0-based
        : 0;
      const pStart = new Date(Date.UTC(y, startMonth, 1));
      // Period ends last day of the month before the same month next year
      const endMonth = startMonth === 0 ? 11 : startMonth - 1;
      const endYear2 = startMonth === 0 ? y : y + 1;
      const pEnd   = lastDayOfMonth(endYear2, endMonth + 1);

      periods.push({
        period_label: startMonth === 0 ? String(y) : ('FY' + y + '/' + String(y + 1).slice(-2)),
        period_start: fmtDate(pStart),
        period_end:   fmtDate(pEnd),
        due_date:     null,
        anchor_date:  fmtDate(pStart)
      });
    }

    if (periods.length >= max) {
      warnings.push('max_periods limit reached (' + max + ').');
    }
    return { periods, warnings };
  }

  return { periods: [], warnings: ['Unknown recurrence_type: ' + recType] };
}

// ─── Load existing periods for duplicate detection ────────────────────────────

async function loadExistingPeriods(companyId, engagementId) {
  const { data } = await supabase
    .from('practice_engagement_periods')
    .select('period_start, period_end, status, id')
    .eq('company_id', companyId)
    .eq('engagement_id', engagementId)
    .neq('status', 'cancelled');
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/practice/engagement-periods
// List periods with filters.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const {
    client_id, engagement_id, status,
    due_from, due_to, period_from, period_to
  } = req.query;

  const page  = Math.max(1,   parseInt(req.query.page  || 1));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50)));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let q = supabase
    .from('practice_engagement_periods')
    .select(
      `*,
       practice_clients:client_id(name),
       practice_client_engagements:engagement_id(engagement_name, recurrence_type, status)`,
      { count: 'exact' }
    )
    .eq('company_id', req.companyId)
    .order('period_start', { ascending: true })
    .order('id',           { ascending: true })
    .range(from, to);

  if (client_id)    q = q.eq('client_id',    parseInt(client_id));
  if (engagement_id) q = q.eq('engagement_id', parseInt(engagement_id));
  if (status && PERIOD_STATUSES.includes(status)) q = q.eq('status', status);
  if (due_from)     q = q.gte('due_date',     due_from);
  if (due_to)       q = q.lte('due_date',     due_to);
  if (period_from)  q = q.gte('period_start', period_from);
  if (period_to)    q = q.lte('period_end',   period_to);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ periods: data || [], total: count || 0, page, limit });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/practice/engagements/:id/periods/generate-preview
// Returns what would be created — no DB writes.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/engagements/:id/periods/generate-preview', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });

  const { from_date, to_date, max_periods } = req.body;
  if (!from_date) return res.status(400).json({ error: 'from_date is required' });
  if (!to_date)   return res.status(400).json({ error: 'to_date is required' });
  if (from_date > to_date) return res.status(400).json({ error: 'from_date must be on or before to_date' });

  const maxP = max_periods ? Math.min(parseInt(max_periods), MAX_PERIODS_LIMIT) : MAX_PERIODS_LIMIT;
  const { periods, warnings } = buildPeriods(eng, from_date, to_date, maxP);

  // Identify duplicates against existing non-cancelled periods
  const existing = await loadExistingPeriods(req.companyId, eng.id);
  const existingSet = new Set(existing.map(r => r.period_start + '|' + r.period_end));

  const newPeriods  = periods.filter(p => !existingSet.has(p.period_start + '|' + p.period_end));
  const duplicates  = periods.filter(p =>  existingSet.has(p.period_start + '|' + p.period_end));

  if (duplicates.length) {
    warnings.push(duplicates.length + ' period(s) already exist and will be skipped if you proceed.');
  }

  await logEngagementEvent(req.companyId, eng.id, 'engagement_periods_previewed', {
    actorUserId: req.userId || null,
    metadata:    { from_date, to_date, previewed: periods.length, duplicates: duplicates.length, new: newPeriods.length }
  });

  res.json({
    engagement_id: eng.id,
    recurrence_type: eng.recurrence_type || null,
    periods: newPeriods,
    duplicates,
    warnings,
    can_create: newPeriods.length > 0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/practice/engagements/:id/periods/generate
// Create queued period rows (no workflows generated yet).
// ─────────────────────────────────────────────────────────────────────────────

router.post('/engagements/:id/periods/generate', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (eng.status !== 'active') {
    return res.status(409).json({ error: `Engagement is ${eng.status} — only active engagements can have periods queued` });
  }
  if (!eng.recurrence_type || eng.recurrence_type === 'ad_hoc') {
    return res.status(400).json({ error: 'Engagement has no recurrence type set (or uses ad_hoc). Update recurrence_type before generating periods.' });
  }

  const { from_date, to_date, max_periods } = req.body;
  if (!from_date) return res.status(400).json({ error: 'from_date is required' });
  if (!to_date)   return res.status(400).json({ error: 'to_date is required' });
  if (from_date > to_date) return res.status(400).json({ error: 'from_date must be on or before to_date' });

  const maxP     = max_periods ? Math.min(parseInt(max_periods), MAX_PERIODS_LIMIT) : MAX_PERIODS_LIMIT;
  const { periods, warnings } = buildPeriods(eng, from_date, to_date, maxP);

  if (!periods.length) {
    return res.status(400).json({ error: 'No periods could be generated for the given range and recurrence type.', warnings });
  }

  // Filter out duplicates server-side (idempotent — safe to call multiple times)
  const existing   = await loadExistingPeriods(req.companyId, eng.id);
  const existingSet = new Set(existing.map(r => r.period_start + '|' + r.period_end));
  const toInsert   = periods.filter(p => !existingSet.has(p.period_start + '|' + p.period_end));
  const skipped    = periods.length - toInsert.length;

  if (!toInsert.length) {
    return res.status(409).json({
      error:    'All periods in the given range already exist.',
      skipped:  periods.length,
      created:  0,
      warnings
    });
  }

  const now   = new Date().toISOString();
  const actor = req.userId || null;

  const rows = toInsert.map(p => ({
    company_id:    req.companyId,
    engagement_id: eng.id,
    client_id:     eng.client_id,
    service_id:    eng.service_catalog_id || null,
    period_label:  p.period_label,
    period_start:  p.period_start,
    period_end:    p.period_end,
    due_date:      p.due_date     || null,
    anchor_date:   p.anchor_date  || null,
    status:        'queued',
    created_at:    now,
    updated_at:    now,
    created_by:    actor
  }));

  // Insert in batches of 50 to stay within Supabase payload limits
  const BATCH = 50;
  let created = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await supabase
      .from('practice_engagement_periods')
      .insert(rows.slice(i, i + BATCH))
      .select();
    if (error) {
      // Duplicate key = race condition; treat as already-exists, not a failure
      if (error.code !== '23505') {
        return res.status(500).json({ error: error.message, created: created.length });
      }
    } else {
      created = created.concat(data || []);
    }
  }

  // Update engagement next_period hints (non-critical)
  if (toInsert.length) {
    const last = toInsert[toInsert.length - 1];
    await supabase
      .from('practice_client_engagements')
      .update({
        updated_at:        now,
        updated_by:        actor
      })
      .eq('id', eng.id)
      .eq('company_id', req.companyId);
  }

  await logEngagementEvent(req.companyId, eng.id, 'engagement_periods_created', {
    actorUserId: actor,
    metadata:    { from_date, to_date, created: created.length, skipped_duplicates: skipped }
  });
  await auditFromReq(req, 'CREATE', 'practice_engagement_periods_batch', eng.id, {
    module: 'practice', count: created.length
  });

  res.status(201).json({
    created:          created.length,
    skipped:          skipped,
    periods:          created,
    warnings
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/practice/engagement-periods/:id/generate-workflow
// Trigger workflow + deadline generation for a single queued/ready period.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/engagement-periods/:id/generate-workflow', async (req, res) => {
  const period = await fetchPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  if (!['queued', 'ready'].includes(period.status)) {
    return res.status(409).json({
      error: `Period status is "${period.status}" — only queued or ready periods can generate workflows`
    });
  }

  const eng = await fetchEngagement(req.companyId, period.engagement_id);
  if (!eng) return res.status(404).json({ error: 'Linked engagement not found' });

  if (eng.status !== 'active') {
    return res.status(409).json({
      error: `Engagement is ${eng.status} — only active engagements can generate workflows`
    });
  }

  if (!eng.workflow_template_id) {
    return res.status(400).json({
      error: 'Engagement has no workflow template linked. Set workflow_template_id on the engagement before generating.'
    });
  }

  // Verify client belongs to company
  const { data: client } = await supabase
    .from('practice_clients')
    .select('id, name')
    .eq('id', eng.client_id)
    .eq('company_id', req.companyId)
    .single();
  if (!client) return res.status(404).json({ error: 'Client not found or access denied' });

  const actor = req.userId || null;
  const { due_date, anchor_date, deadline_title, create_deadline, notes } = req.body;

  // Resolve due_date: request body → period.due_date → null (let workflowService decide via offset)
  const resolvedDueDate    = due_date    || period.due_date    || null;
  const resolvedAnchorDate = anchor_date || period.anchor_date || period.period_start || null;

  let createDeadlineBool;
  if (create_deadline === true  || create_deadline === 'true')  createDeadlineBool = true;
  else if (create_deadline === false || create_deadline === 'false') createDeadlineBool = false;

  try {
    const result = await workflowService.createRunAndGenerateTasks(req, {
      template_id:       eng.workflow_template_id,
      client_id:         eng.client_id,
      start_date:        resolvedAnchorDate,
      source_type:       'manual',
      generation_source: 'engagement_period',
      engagement_id:     eng.id,
      service_id:        eng.service_catalog_id || null,
      create_deadline:   createDeadlineBool,
      deadline_title:    deadline_title  || null,
      period_start:      period.period_start,
      period_end:        period.period_end,
      due_date:          resolvedDueDate
    });

    const now = new Date().toISOString();

    // Update period to generated
    const periodUpdates = {
      status:          'generated',
      workflow_run_id: result.run.id,
      generated_at:    now,
      generated_by:    actor,
      updated_at:      now,
      updated_by:      actor
    };
    if (result.deadline) {
      periodUpdates.deadline_id = result.deadline.id;
    }

    await supabase
      .from('practice_engagement_periods')
      .update(periodUpdates)
      .eq('id', period.id)
      .eq('company_id', req.companyId);

    // Update engagement generation tracking
    const engUpdate = {
      last_generated_at:              now,
      last_generated_workflow_run_id: result.run.id,
      generation_count:               (eng.generation_count || 0) + 1,
      updated_at:                     now,
      updated_by:                     actor
    };
    if (result.deadline) engUpdate.last_generated_deadline_id = result.deadline.id;
    await supabase
      .from('practice_client_engagements')
      .update(engUpdate)
      .eq('id', eng.id)
      .eq('company_id', req.companyId);

    await logEngagementEvent(req.companyId, eng.id, 'engagement_period_workflow_generated', {
      actorUserId: actor,
      notes:       notes || null,
      metadata: {
        period_id:       period.id,
        period_label:    period.period_label,
        workflow_run_id: result.run.id,
        task_count:      result.tasks.length,
        deadline_id:     result.deadline ? result.deadline.id : null
      }
    });
    await auditFromReq(req, 'GENERATE_WORKFLOW_FROM_PERIOD', 'practice_engagement_periods', period.id, {
      module: 'practice', workflow_run_id: result.run.id
    });

    const response = {
      success:         true,
      period_id:       period.id,
      workflow_run_id: result.run.id,
      task_count:      result.tasks.length,
      deadline_id:     result.deadline ? result.deadline.id : null,
      period_label:    period.period_label
    };
    if (result.warning) response.warning = result.warning;
    res.status(201).json(response);

  } catch (err) {
    await logEngagementEvent(req.companyId, eng.id, 'engagement_period_workflow_failed', {
      actorUserId: actor,
      notes:       err.message,
      metadata:    { period_id: period.id }
    });

    const is400 = (
      err.message.includes('due_date is required') ||
      err.message.includes('Invalid compliance_area') ||
      err.message.includes('Invalid deadline_type') ||
      err.message.includes('Invalid priority') ||
      err.message.includes('period_start must be')
    );
    res.status(is400 ? 400 : 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/practice/engagement-periods/:id/skip
// ─────────────────────────────────────────────────────────────────────────────

router.put('/engagement-periods/:id/skip', async (req, res) => {
  const period = await fetchPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  if (period.status === 'generated') {
    return res.status(409).json({ error: 'Cannot skip a period that has already generated a workflow' });
  }
  if (period.status === 'cancelled') {
    return res.status(409).json({ error: 'Period is already cancelled' });
  }
  if (period.status === 'skipped') {
    return res.status(409).json({ error: 'Period is already skipped' });
  }

  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason is required to skip a period' });
  }

  const actor = req.userId || null;
  const now   = new Date().toISOString();

  const { data, error } = await supabase
    .from('practice_engagement_periods')
    .update({
      status:     'skipped',
      skipped_at: now,
      skipped_by: actor,
      skip_reason: String(reason).trim(),
      updated_at: now,
      updated_by: actor
    })
    .eq('id', period.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, period.engagement_id, 'engagement_period_skipped', {
    actorUserId: actor,
    notes:       String(reason).trim(),
    metadata:    { period_id: period.id, period_label: period.period_label }
  });
  await auditFromReq(req, 'SKIP', 'practice_engagement_periods', period.id, { module: 'practice' });
  res.json({ period: data });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/practice/engagement-periods/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────

router.put('/engagement-periods/:id/cancel', async (req, res) => {
  const period = await fetchPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  if (period.status === 'generated') {
    return res.status(409).json({ error: 'Cannot cancel a period that has already generated a workflow' });
  }
  if (period.status === 'cancelled') {
    return res.status(409).json({ error: 'Period is already cancelled' });
  }

  const actor = req.userId || null;
  const now   = new Date().toISOString();

  const { data, error } = await supabase
    .from('practice_engagement_periods')
    .update({
      status:     'cancelled',
      updated_at: now,
      updated_by: actor
    })
    .eq('id', period.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, period.engagement_id, 'engagement_period_cancelled', {
    actorUserId: actor,
    notes:       req.body.reason || null,
    metadata:    { period_id: period.id, period_label: period.period_label }
  });
  await auditFromReq(req, 'CANCEL', 'practice_engagement_periods', period.id, { module: 'practice' });
  res.json({ period: data });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/practice/engagement-periods/:id
// Single period detail.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/engagement-periods/:id', async (req, res) => {
  const period = await fetchPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });
  res.json({ period });
});

module.exports = router;
