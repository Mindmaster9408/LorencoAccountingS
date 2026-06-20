/**
 * Lorenco Practice — Service Catalog + Client Engagements Router
 *
 * Service Catalog: master list of services the practice offers.
 * Client Engagements: formal, per-client service relationships.
 *
 * IMPORTANT: auto_create_workflow and auto_create_deadline flags are stored
 * in the database for future use but are NEVER executed by this router.
 * workflow_template_id is stored for reference only — no workflows are
 * created automatically.
 *
 * All routes require company context from JWT (req.companyId).
 * Rule D: no localStorage for business data — all state via API.
 */

const express = require('express');
const router  = express.Router();
const { supabase }      = require('../../config/database');
const { auditFromReq }  = require('../../middleware/audit');
const workflowService   = require('./services/workflowService');

// ─── Allowed values (validated at API layer, not DB) ─────────────────────────

const SERVICE_CATEGORIES = [
  'vat', 'paye', 'emp501', 'income_tax', 'annual_financials',
  'bookkeeping', 'payroll', 'secretarial', 'consulting', 'cipc', 'other'
];

const FEE_FREQUENCIES = [
  'monthly', 'quarterly', 'biannual', 'annual', 'once_off', 'per_hour'
];

const BILLING_TYPES = ['fixed', 'hourly', 'retainer'];

const ENGAGEMENT_STATUSES = ['active', 'paused', 'ended', 'cancelled'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchEngagement(companyId, engagementId) {
  const { data } = await supabase
    .from('practice_client_engagements')
    .select('*')
    .eq('id', parseInt(engagementId))
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
      old_status:    opts.oldStatus    || null,
      new_status:    opts.newStatus    || null,
      actor_user_id: opts.actorUserId  || null,
      notes:         opts.notes        || null,
      metadata:      opts.metadata     || {}
    });
  } catch (_) { /* non-fatal — event log failures must not abort operations */ }
}

function sanitizeCatalogBody(body) {
  const allowed = [
    'service_code', 'service_name', 'service_category', 'description',
    'default_fee_amount', 'default_fee_frequency', 'default_billing_type',
    'default_hourly_rate', 'estimated_hours_per_period',
    'default_workflow_template_id',
    'auto_create_workflow', 'auto_create_deadline',
    'is_active', 'display_order', 'notes', 'settings'
  ];
  const out = {};
  for (const k of allowed) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

function sanitizeEngagementBody(body) {
  const allowed = [
    'service_catalog_id', 'engagement_name', 'service_category', 'description',
    'start_date', 'end_date',
    'responsible_team_member_id', 'reviewer_team_member_id', 'partner_team_member_id',
    'fee_amount', 'fee_frequency', 'billing_type', 'hourly_rate',
    'estimated_hours_per_period', 'currency',
    'workflow_template_id',
    'auto_create_workflow', 'auto_create_deadline',
    'notes', 'internal_notes', 'settings',
    'recurrence_type', 'recurrence_start_date', 'recurrence_end_date',
    'recurrence_day', 'recurrence_month', 'recurrence_notes'
  ];
  const out = {};
  for (const k of allowed) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

// ═══ SERVICE CATALOG ═════════════════════════════════════════════════════════

// List services — optional ?category= and ?active= filters
router.get('/services', async (req, res) => {
  const { category, active } = req.query;

  let q = supabase
    .from('practice_service_catalog')
    .select('*')
    .eq('company_id', req.companyId)
    .order('display_order', { ascending: true })
    .order('service_name', { ascending: true });

  if (category && SERVICE_CATEGORIES.includes(category)) q = q.eq('service_category', category);
  if (active !== 'all') q = q.eq('is_active', active !== 'false');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ services: data || [] });
});

// Get single service
router.get('/services/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_service_catalog')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: data });
});

// Create service
router.post('/services', async (req, res) => {
  const body = sanitizeCatalogBody(req.body);
  if (!body.service_name)     return res.status(400).json({ error: 'service_name is required' });
  if (!body.service_category) return res.status(400).json({ error: 'service_category is required' });
  if (!SERVICE_CATEGORIES.includes(body.service_category)) return res.status(400).json({ error: 'Invalid service_category' });
  if (body.default_fee_frequency && !FEE_FREQUENCIES.includes(body.default_fee_frequency)) return res.status(400).json({ error: 'Invalid default_fee_frequency' });
  if (body.default_billing_type  && !BILLING_TYPES.includes(body.default_billing_type))    return res.status(400).json({ error: 'Invalid default_billing_type' });

  body.company_id = req.companyId;
  if (req.userId) body.created_by = req.userId;

  const { data, error } = await supabase
    .from('practice_service_catalog')
    .insert(body)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_service_catalog', data.id, { module: 'practice' });
  res.status(201).json({ service: data });
});

// Update service
router.put('/services/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_service_catalog')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Service not found' });

  const body = sanitizeCatalogBody(req.body);
  if (body.service_category      && !SERVICE_CATEGORIES.includes(body.service_category))      return res.status(400).json({ error: 'Invalid service_category' });
  if (body.default_fee_frequency && !FEE_FREQUENCIES.includes(body.default_fee_frequency))    return res.status(400).json({ error: 'Invalid default_fee_frequency' });
  if (body.default_billing_type  && !BILLING_TYPES.includes(body.default_billing_type))        return res.status(400).json({ error: 'Invalid default_billing_type' });
  body.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('practice_service_catalog')
    .update(body)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'UPDATE', 'practice_service_catalog', data.id, { module: 'practice' });
  res.json({ service: data });
});

// Soft-deactivate service (DELETE → sets is_active = false)
router.delete('/services/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_service_catalog')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Service not found' });

  const { error } = await supabase
    .from('practice_service_catalog')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DEACTIVATE', 'practice_service_catalog', parseInt(req.params.id), { module: 'practice' });
  res.json({ success: true });
});

// ═══ CLIENT ENGAGEMENTS ═══════════════════════════════════════════════════════

// List engagements for a client — optional ?status= filter
router.get('/clients/:clientId/engagements', async (req, res) => {
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  const { data: client } = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', clientId)
    .eq('company_id', req.companyId)
    .single();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { status } = req.query;
  let q = supabase
    .from('practice_client_engagements')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (status && ENGAGEMENT_STATUSES.includes(status)) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ engagements: data || [] });
});

// Create engagement for a client
router.post('/clients/:clientId/engagements', async (req, res) => {
  const clientId = parseInt(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: 'Invalid client ID' });

  const { data: client } = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', clientId)
    .eq('company_id', req.companyId)
    .single();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const body = sanitizeEngagementBody(req.body);
  if (!body.engagement_name)  return res.status(400).json({ error: 'engagement_name is required' });
  if (!body.service_category) return res.status(400).json({ error: 'service_category is required' });
  if (!SERVICE_CATEGORIES.includes(body.service_category)) return res.status(400).json({ error: 'Invalid service_category' });
  if (body.fee_frequency && !FEE_FREQUENCIES.includes(body.fee_frequency)) return res.status(400).json({ error: 'Invalid fee_frequency' });
  if (body.billing_type  && !BILLING_TYPES.includes(body.billing_type))    return res.status(400).json({ error: 'Invalid billing_type' });

  body.company_id = req.companyId;
  body.client_id  = clientId;
  body.status     = 'active';
  if (req.userId) body.created_by = req.userId;

  const { data, error } = await supabase
    .from('practice_client_engagements')
    .insert(body)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, data.id, 'engagement_created', {
    actorUserId: req.userId || null,
    newStatus:   'active',
    metadata:    { engagement_name: body.engagement_name, service_category: body.service_category }
  });
  await auditFromReq(req, 'CREATE', 'practice_client_engagement', data.id, { module: 'practice', client_id: clientId });
  res.status(201).json({ engagement: data });
});

// Get single engagement
router.get('/engagements/:id', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  res.json({ engagement: eng });
});

// Update engagement fields (status changes use dedicated routes)
router.put('/engagements/:id', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (eng.status === 'cancelled') return res.status(409).json({ error: 'Cannot edit a cancelled engagement' });

  const body = sanitizeEngagementBody(req.body);
  delete body.status; // Status only changed via dedicated routes below

  if (body.service_category && !SERVICE_CATEGORIES.includes(body.service_category)) return res.status(400).json({ error: 'Invalid service_category' });
  if (body.fee_frequency     && !FEE_FREQUENCIES.includes(body.fee_frequency))       return res.status(400).json({ error: 'Invalid fee_frequency' });
  if (body.billing_type      && !BILLING_TYPES.includes(body.billing_type))           return res.status(400).json({ error: 'Invalid billing_type' });

  body.updated_at = new Date().toISOString();
  if (req.userId) body.updated_by = req.userId;

  const { data, error } = await supabase
    .from('practice_client_engagements')
    .update(body)
    .eq('id', eng.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, eng.id, 'engagement_updated', { actorUserId: req.userId || null });
  await auditFromReq(req, 'UPDATE', 'practice_client_engagement', eng.id, { module: 'practice' });
  res.json({ engagement: data });
});

// Pause an active engagement
router.put('/engagements/:id/pause', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (eng.status !== 'active') return res.status(409).json({ error: 'Only active engagements can be paused' });

  const actor = req.userId || null;
  const { data, error } = await supabase
    .from('practice_client_engagements')
    .update({ status: 'paused', updated_at: new Date().toISOString(), updated_by: actor })
    .eq('id', eng.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, eng.id, 'engagement_paused', {
    oldStatus: 'active', newStatus: 'paused', actorUserId: actor, notes: req.body.notes || null
  });
  await auditFromReq(req, 'PAUSE', 'practice_client_engagement', eng.id, { module: 'practice' });
  res.json({ engagement: data });
});

// Reactivate a paused engagement
router.put('/engagements/:id/reactivate', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (eng.status !== 'paused') return res.status(409).json({ error: 'Only paused engagements can be reactivated' });

  const actor = req.userId || null;
  const { data, error } = await supabase
    .from('practice_client_engagements')
    .update({ status: 'active', updated_at: new Date().toISOString(), updated_by: actor })
    .eq('id', eng.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, eng.id, 'engagement_reactivated', {
    oldStatus: 'paused', newStatus: 'active', actorUserId: actor, notes: req.body.notes || null
  });
  await auditFromReq(req, 'REACTIVATE', 'practice_client_engagement', eng.id, { module: 'practice' });
  res.json({ engagement: data });
});

// End an engagement (graceful completion)
router.put('/engagements/:id/end', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (['ended', 'cancelled'].includes(eng.status)) return res.status(409).json({ error: 'Engagement is already ended or cancelled' });

  const now   = new Date().toISOString();
  const actor = req.userId || null;
  const { data, error } = await supabase
    .from('practice_client_engagements')
    .update({ status: 'ended', ended_at: now, ended_by: actor, updated_at: now, updated_by: actor })
    .eq('id', eng.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, eng.id, 'engagement_ended', {
    oldStatus: eng.status, newStatus: 'ended', actorUserId: actor, notes: req.body.notes || null
  });
  await auditFromReq(req, 'END', 'practice_client_engagement', eng.id, { module: 'practice' });
  res.json({ engagement: data });
});

// Cancel (soft delete) an engagement
router.delete('/engagements/:id', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });
  if (eng.status === 'cancelled') return res.status(409).json({ error: 'Engagement is already cancelled' });

  const now   = new Date().toISOString();
  const actor = req.userId || null;
  const { error } = await supabase
    .from('practice_client_engagements')
    .update({ status: 'cancelled', cancelled_at: now, cancelled_by: actor, updated_at: now, updated_by: actor })
    .eq('id', eng.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });

  await logEngagementEvent(req.companyId, eng.id, 'engagement_cancelled', {
    oldStatus: eng.status, newStatus: 'cancelled', actorUserId: actor, notes: req.body.reason || null
  });
  await auditFromReq(req, 'CANCEL', 'practice_client_engagement', eng.id, { module: 'practice' });
  res.json({ success: true });
});

// Engagement event history
router.get('/engagements/:id/history', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });

  const { data, error } = await supabase
    .from('practice_client_engagement_events')
    .select('*')
    .eq('engagement_id', eng.id)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [], engagement_id: eng.id, engagement_name: eng.engagement_name });
});

// ── Generation preview ─────────────────────────────────────────────────────
// Returns engagement details, linked template, expected task count, and whether
// a compliance deadline will be created. Allows the frontend to show a safe
// confirmation before the user triggers generation.
router.get('/engagements/:id/generation-preview', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });

  // Fetch client (must belong to same company)
  const { data: client } = await supabase
    .from('practice_clients')
    .select('id, name, client_type')
    .eq('id', eng.client_id)
    .eq('company_id', req.companyId)
    .single();

  // Fetch linked workflow template
  let template   = null;
  let step_count = 0;

  if (eng.workflow_template_id) {
    const { data: tpl } = await supabase
      .from('practice_workflow_templates')
      .select(
        'id, name, creates_compliance_deadline, default_compliance_area, ' +
        'default_deadline_type, default_deadline_title, default_deadline_offset_days, ' +
        'default_deadline_offset_basis, default_deadline_priority'
      )
      .eq('id', eng.workflow_template_id)
      .eq('company_id', req.companyId)
      .single();

    template = tpl || null;

    if (template) {
      const { count } = await supabase
        .from('practice_workflow_template_steps')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', eng.workflow_template_id)
        .eq('company_id', req.companyId);
      step_count = count || 0;
    }
  }

  res.json({
    engagement: {
      id:                             eng.id,
      engagement_name:                eng.engagement_name,
      service_category:               eng.service_category,
      status:                         eng.status,
      client_id:                      eng.client_id,
      workflow_template_id:           eng.workflow_template_id,
      service_catalog_id:             eng.service_catalog_id     || null,
      last_generated_at:              eng.last_generated_at      || null,
      last_generated_workflow_run_id: eng.last_generated_workflow_run_id || null,
      generation_count:               eng.generation_count       || 0
    },
    client:               client   || null,
    template:             template || null,
    expected_task_count:  step_count,
    will_create_deadline: template ? !!template.creates_compliance_deadline : false,
    compliance_area:      template ? (template.default_compliance_area || null) : null,
    deadline_type:        template ? (template.default_deadline_type   || null) : null,
    can_generate:         !!(eng.workflow_template_id && eng.status === 'active' && template)
  });
});

// ── Generate workflow from engagement ──────────────────────────────────────
// Manual-only. No cron. No auto-execution. User clicks Generate Workflow.
//
// Payload (all optional):
//   anchor_date      — start date for task due-date offsets (defaults to now)
//   period_start     — compliance period start
//   period_end       — compliance period end
//   due_date         — deadline due date (required when creating deadline without offset)
//   create_deadline  — boolean; overrides template default
//   deadline_title   — overrides template default title
//   notes            — stored in engagement event log
//
// Multi-tenant: all entities verified against req.companyId — never trusted from body.
router.post('/engagements/:id/generate-workflow', async (req, res) => {
  const eng = await fetchEngagement(req.companyId, req.params.id);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });

  if (eng.status !== 'active') {
    return res.status(409).json({
      error: `Engagement is ${eng.status} — only active engagements can generate workflows`
    });
  }

  if (!eng.workflow_template_id) {
    return res.status(400).json({
      error: 'Engagement has no workflow template linked. Set workflow_template_id before generating.'
    });
  }

  // Verify client belongs to same company
  const { data: client, error: clErr } = await supabase
    .from('practice_clients')
    .select('id, name')
    .eq('id', eng.client_id)
    .eq('company_id', req.companyId)
    .single();
  if (clErr || !client) {
    return res.status(404).json({ error: 'Client not found or access denied' });
  }

  // Verify service catalog entry if linked (multi-tenant gate)
  if (eng.service_catalog_id) {
    const { data: svc } = await supabase
      .from('practice_service_catalog')
      .select('id')
      .eq('id', eng.service_catalog_id)
      .eq('company_id', req.companyId)
      .single();
    if (!svc) {
      return res.status(404).json({ error: 'Linked service catalog entry not found or access denied' });
    }
  }

  const {
    anchor_date,
    period_start,
    period_end,
    due_date,
    create_deadline,
    deadline_title,
    notes
  } = req.body;

  // Normalise create_deadline to boolean or undefined (let workflowService use template default)
  let createDeadlineBool;
  if (create_deadline === true  || create_deadline === 'true')  createDeadlineBool = true;
  else if (create_deadline === false || create_deadline === 'false') createDeadlineBool = false;
  // else leave undefined — workflowService will respect template.creates_compliance_deadline

  const actor = req.userId || null;

  try {
    const result = await workflowService.createRunAndGenerateTasks(req, {
      template_id:       eng.workflow_template_id,
      client_id:         eng.client_id,
      start_date:        anchor_date        || null,
      source_type:       'manual',
      generation_source: 'engagement',
      engagement_id:     eng.id,
      service_id:        eng.service_catalog_id || null,
      create_deadline:   createDeadlineBool,
      deadline_title:    deadline_title     || null,
      period_start:      period_start       || null,
      period_end:        period_end         || null,
      due_date:          due_date           || null
    });

    // Update engagement generation tracking (non-critical — run succeeded regardless)
    const now = new Date().toISOString();
    const updatePayload = {
      last_generated_at:              now,
      last_generated_workflow_run_id: result.run.id,
      generation_count:               (eng.generation_count || 0) + 1,
      updated_at:                     now,
      updated_by:                     actor
    };
    if (result.deadline) {
      updatePayload.last_generated_deadline_id = result.deadline.id;
    }

    await supabase
      .from('practice_client_engagements')
      .update(updatePayload)
      .eq('id', eng.id)
      .eq('company_id', req.companyId);

    // Log engagement event (non-fatal — already using logEngagementEvent try/catch internally)
    await logEngagementEvent(req.companyId, eng.id, 'workflow_generated_from_engagement', {
      actorUserId: actor,
      notes:       notes || null,
      metadata: {
        workflow_run_id:  result.run.id,
        task_count:       result.tasks.length,
        deadline_id:      result.deadline ? result.deadline.id : null,
        template_id:      eng.workflow_template_id,
        generation_count: updatePayload.generation_count
      }
    });

    await auditFromReq(req, 'GENERATE_WORKFLOW_FROM_ENGAGEMENT', 'practice_client_engagement', eng.id, {
      module: 'practice', workflow_run_id: result.run.id
    });

    const response = {
      success:          true,
      workflow_run_id:  result.run.id,
      task_count:       result.tasks.length,
      deadline_id:      result.deadline ? result.deadline.id : null,
      generation_count: updatePayload.generation_count
    };
    if (result.warning) response.warning = result.warning;

    res.status(201).json(response);

  } catch (err) {
    // Log generation failure (non-fatal)
    await logEngagementEvent(req.companyId, eng.id, 'workflow_generation_failed', {
      actorUserId: actor,
      notes:       err.message,
      metadata:    { template_id: eng.workflow_template_id }
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

module.exports = router;
