const { supabase } = require('../../../config/database');

// Allowed values — kept in sync with migration 059 and compliance module enums
const COMPLIANCE_AREAS = [
  'vat','paye','emp501','provisional_tax','income_tax',
  'cipc','bo','annual_financials','bookkeeping','payroll','internal','other'
];
const DEADLINE_TYPE_EXTENDED = [
  'vat201','emp201','emp501','irp6','itr12','itr14',
  'cipc_annual_return','beneficial_ownership','annual_financial_statements',
  'management_accounts','monthly_bookkeeping','payroll_month_end','custom'
];
const DEADLINE_PRIORITIES = ['low','normal','high','urgent'];
const OFFSET_BASIS_VALUES = [
  'anchor_date','period_start','period_end','financial_year_end','tax_year_end'
];

// Allowed body fields for template create/update.
// createTemplate / updateTemplate previously used Object.assign with no filter —
// now sanitised to prevent unexpected column writes.
const TEMPLATE_ALLOWED_FIELDS = [
  'name', 'description', 'slug', 'category', 'priority', 'recurrence',
  'is_active', 'settings',
  // Compliance / deadline defaults (added migration 059)
  'creates_compliance_deadline',
  'default_compliance_area', 'default_deadline_type', 'default_deadline_title',
  'default_deadline_priority', 'default_deadline_offset_days', 'default_deadline_offset_basis'
];

function sanitizeTemplateBody(body) {
  const out = {};
  for (const k of TEMPLATE_ALLOWED_FIELDS) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

// ── Template CRUD ─────────────────────────────────────────────────────────────

async function createTemplate(req, body) {
  const data = sanitizeTemplateBody(body);
  data.company_id = req.companyId;
  data.created_by = req.user ? req.user.userId : null;
  const { data: inserted, error } = await supabase
    .from('practice_workflow_templates')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return inserted;
}

async function updateTemplate(req, id, body) {
  const updates = sanitizeTemplateBody(body);
  updates.updated_at = new Date().toISOString();
  updates.updated_by = req.user ? req.user.userId : null;
  const { data, error } = await supabase
    .from('practice_workflow_templates')
    .update(updates)
    .eq('id', id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getTemplate(req, id) {
  const { data, error } = await supabase
    .from('practice_workflow_templates')
    .select('*')
    .eq('id', id)
    .eq('company_id', req.companyId)
    .single();
  if (error) throw error;
  return data;
}

async function listTemplates(req) {
  const { data, error } = await supabase
    .from('practice_workflow_templates')
    .select('*')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── Steps management ──────────────────────────────────────────────────────────

async function listSteps(req, template_id) {
  const { data, error } = await supabase
    .from('practice_workflow_template_steps')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('template_id', template_id)
    .order('ordinal', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createStep(req, template_id, body) {
  const row = Object.assign({}, body);
  row.company_id = req.companyId;
  row.template_id = template_id;
  const { data, error } = await supabase
    .from('practice_workflow_template_steps')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateStep(req, id, body) {
  const updates = Object.assign({}, body);
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_workflow_template_steps')
    .update(updates)
    .eq('id', id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteStep(req, id) {
  const { error } = await supabase
    .from('practice_workflow_template_steps')
    .delete()
    .eq('id', id)
    .eq('company_id', req.companyId);
  if (error) throw error;
  return true;
}

async function reorderSteps(req, template_id, stepIds) {
  if (!Array.isArray(stepIds) || stepIds.length === 0)
    throw new Error('stepIds must be a non-empty array');
  const unique = new Set(stepIds.map(id => parseInt(id)));
  if (unique.size !== stepIds.length)
    throw new Error('Duplicate step IDs are not allowed');

  const { data: steps, error: fErr } = await supabase
    .from('practice_workflow_template_steps')
    .select('id,template_id,company_id')
    .in('id', stepIds);
  if (fErr) throw fErr;
  if (!steps || steps.length !== stepIds.length)
    throw new Error('Some steps not found');

  const templateIds = new Set(steps.map(s => s.template_id));
  if (templateIds.size !== 1 || [...templateIds][0] !== template_id)
    throw new Error('All steps must belong to the same template');
  const companyIds = new Set(steps.map(s => s.company_id));
  if (companyIds.size !== 1 || [...companyIds][0] !== req.companyId)
    throw new Error('Steps must belong to the authenticated company');

  for (let i = 0; i < stepIds.length; i++) {
    const { error: uErr } = await supabase
      .from('practice_workflow_template_steps')
      .update({ ordinal: i + 1 })
      .eq('id', parseInt(stepIds[i]))
      .eq('company_id', req.companyId);
    if (uErr) throw uErr;
  }
  return true;
}

// ── Workflow generation ───────────────────────────────────────────────────────
//
// Extended in Codebox 08 to optionally create a linked compliance deadline.
//
// Deadline creation rules:
//   1. If create_deadline === false → no deadline created regardless of template
//   2. If create_deadline === true → always create deadline (due_date required)
//   3. If create_deadline not provided but template.creates_compliance_deadline === true →
//      create deadline using template defaults (due_date required)
//   4. Otherwise → no deadline created (existing behavior preserved)
//
// due_date calculation when not provided:
//   - if template.default_deadline_offset_days is set → anchor_date + offset_days
//   - if offset_days not set → 400 error asking caller to supply due_date

async function createRunAndGenerateTasks(req, {
  template_id,
  client_id = null,
  start_date = null,
  source_type = 'manual',
  // Traceability — set when generating from an engagement (Codebox 15)
  engagement_id     = null,
  service_id        = null,
  generation_source = null,
  // Deadline-linking params (all optional)
  create_deadline,
  deadline_title,
  compliance_area,
  deadline_type,
  period_start,
  period_end,
  due_date,
  priority: dl_priority,
  responsible_team_member_id,
  reviewer_team_member_id
}) {
  // ── Load template + steps ──────────────────────────────────────────────────
  const { data: template, error: tErr } = await supabase
    .from('practice_workflow_templates')
    .select('*')
    .eq('id', template_id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !template) throw tErr || new Error('Template not found');

  const { data: steps, error: sErr } = await supabase
    .from('practice_workflow_template_steps')
    .select('*')
    .eq('template_id', template_id)
    .eq('company_id', req.companyId)
    .order('ordinal', { ascending: true });
  if (sErr) throw sErr;

  // ── Determine whether to create a deadline ─────────────────────────────────
  const shouldCreateDeadline =
    create_deadline === true ||
    create_deadline === 'true' ||
    (create_deadline !== false && create_deadline !== 'false' && template.creates_compliance_deadline === true);

  // Resolve deadline field values — provided params take priority over template defaults
  const resolvedComplianceArea  = compliance_area  || template.default_compliance_area  || null;
  const resolvedDeadlineType    = deadline_type    || template.default_deadline_type    || null;
  const resolvedDeadlineTitle   = deadline_title   || template.default_deadline_title   || template.name;
  const resolvedPriority        = dl_priority      || template.default_deadline_priority || 'normal';

  // Resolve due_date
  let resolvedDueDate = due_date || null;
  if (shouldCreateDeadline && !resolvedDueDate) {
    const offsetDays = template.default_deadline_offset_days;
    if (offsetDays !== null && offsetDays !== undefined) {
      const anchor = start_date ? new Date(start_date) : new Date();
      const d = new Date(anchor.getTime() + (parseInt(offsetDays) * 86400000));
      resolvedDueDate = d.toISOString().split('T')[0];
    } else {
      throw new Error(
        'due_date is required when creating a compliance deadline. ' +
        'Supply due_date in the request or set default_deadline_offset_days on the template.'
      );
    }
  }

  // Validate compliance field values
  if (shouldCreateDeadline) {
    if (resolvedComplianceArea && !COMPLIANCE_AREAS.includes(resolvedComplianceArea)) {
      throw new Error(`Invalid compliance_area: ${resolvedComplianceArea}`);
    }
    if (resolvedDeadlineType && !DEADLINE_TYPE_EXTENDED.includes(resolvedDeadlineType)) {
      throw new Error(`Invalid deadline_type: ${resolvedDeadlineType}`);
    }
    if (!DEADLINE_PRIORITIES.includes(resolvedPriority)) {
      throw new Error(`Invalid priority: ${resolvedPriority}`);
    }
    if (period_start && period_end && period_start > period_end) {
      throw new Error('period_start must be on or before period_end');
    }
  }

  // ── Create run ─────────────────────────────────────────────────────────────
  const runRow = {
    company_id:      req.companyId,
    template_id:     template_id,
    client_id:       client_id ? parseInt(client_id) : null,
    source_type:     source_type || 'manual',
    status:          'pending',
    requested_by:    req.user ? req.user.userId : null,
    // Snapshot compliance context on the run
    compliance_area: resolvedComplianceArea,
    deadline_type:   resolvedDeadlineType,
    period_start:    period_start || null,
    period_end:      period_end   || null,
    ...(engagement_id     != null ? { engagement_id:     parseInt(engagement_id) } : {}),
    ...(service_id        != null ? { service_id:        parseInt(service_id) }    : {}),
    ...(generation_source         ? { generation_source }                          : {})
  };

  const { data: run, error: rErr } = await supabase
    .from('practice_workflow_runs')
    .insert(runRow)
    .select()
    .single();
  if (rErr) throw rErr;

  // ── Snapshot steps → run_steps ─────────────────────────────────────────────
  const runSteps = (steps || []).map(s => ({
    run_id:             run.id,
    template_step_id:   s.id,
    ordinal:            s.ordinal,
    title:              s.title,
    description:        s.description || null,
    task_type:          s.task_type   || null,
    priority:           s.priority    || null,
    assigned_role:      s.assigned_role   || null,
    assigned_user_id:   s.assigned_user_id || null,
    due_date:           null
  }));

  if (runSteps.length) {
    const { error: rsErr } = await supabase
      .from('practice_workflow_run_steps')
      .insert(runSteps);
    if (rsErr) {
      await supabase.from('practice_workflow_runs').delete().eq('id', run.id).eq('company_id', req.companyId);
      throw rsErr;
    }
  }

  // ── Build + insert tasks ───────────────────────────────────────────────────
  const sd = start_date ? new Date(start_date) : new Date();
  const tasksToInsert = (steps || []).map(s => {
    const due = (s.due_offset_days !== null && s.due_offset_days !== undefined)
      ? new Date(sd.getTime() + (parseInt(s.due_offset_days || 0) * 86400000))
      : null;
    const needsReview   = s.requires_review   === true;
    const needsApproval = s.requires_approval === true;
    return {
      company_id:       req.companyId,
      client_id:        client_id ? parseInt(client_id) : null,
      title:            s.title,
      description:      s.description || null,
      type:             s.task_type || 'general',
      priority:         s.priority  || 'medium',
      due_date:         due ? due.toISOString().split('T')[0] : null,
      assigned_to:      s.assigned_user_id || null,
      notes:            null,
      status:           'open',
      created_by:       req.user ? req.user.userId : null,
      source_type:      'workflow_template',
      source_id:        run.id,
      workflow_run_id:  run.id,  // typed FK added in migration 059
      // Review/approval flags inherited from template step (migration 060)
      review_required:   needsReview,
      approval_required: needsApproval,
      review_status:     'not_required',
      approval_status:   'not_required',
      qa_status:         needsReview ? 'required' : 'none',
      // deadline_id will be set in a batch update after deadline creation
      ...(engagement_id != null ? { engagement_id: parseInt(engagement_id) } : {}),
      ...(service_id    != null ? { service_id:    parseInt(service_id) }    : {})
    };
  });

  let insertedTasks = [];
  if (tasksToInsert.length) {
    const { data: tData, error: tiErr } = await supabase
      .from('practice_tasks')
      .insert(tasksToInsert)
      .select();
    if (tiErr) {
      await supabase.from('practice_workflow_run_steps').delete().eq('run_id', run.id);
      await supabase.from('practice_workflow_runs').delete().eq('id', run.id).eq('company_id', req.companyId);
      throw tiErr;
    }
    insertedTasks = tData || [];
  }

  // ── Optionally create compliance deadline ──────────────────────────────────
  let deadline = null;
  if (shouldCreateDeadline) {
    try {
      const deadlineRow = {
        company_id:                 req.companyId,
        client_id:                  client_id ? parseInt(client_id) : null,
        title:                      resolvedDeadlineTitle,
        type:                       'general',     // legacy `type` column kept
        compliance_area:            resolvedComplianceArea,
        deadline_type:              resolvedDeadlineType,
        period_start:               period_start || null,
        period_end:                 period_end   || null,
        due_date:                   resolvedDueDate,
        priority:                   resolvedPriority,
        status:                     'open',
        is_active:                  true,
        workflow_run_id:            run.id,
        responsible_team_member_id: responsible_team_member_id ? parseInt(responsible_team_member_id) : null,
        reviewer_team_member_id:    reviewer_team_member_id    ? parseInt(reviewer_team_member_id)    : null,
        created_by:                 req.user ? req.user.userId : null,
        ...(engagement_id != null ? { engagement_id: parseInt(engagement_id) } : {}),
        ...(service_id    != null ? { service_id:    parseInt(service_id) }    : {})
      };

      const { data: dl, error: dlErr } = await supabase
        .from('practice_deadlines')
        .insert(deadlineRow)
        .select()
        .single();

      if (dlErr) throw dlErr;
      deadline = dl;

      // Link deadline back onto the run
      await supabase
        .from('practice_workflow_runs')
        .update({ deadline_id: deadline.id, updated_at: new Date().toISOString() })
        .eq('id', run.id)
        .eq('company_id', req.companyId);

      // Update the run object in memory too
      run.deadline_id = deadline.id;

      // Batch-update tasks with deadline_id
      if (insertedTasks.length) {
        const taskIds = insertedTasks.map(t => t.id);
        await supabase
          .from('practice_tasks')
          .update({ deadline_id: deadline.id })
          .in('id', taskIds)
          .eq('company_id', req.companyId);
        insertedTasks = insertedTasks.map(t => ({ ...t, deadline_id: deadline.id }));
      }

      // Log deadline event
      await supabase.from('practice_deadline_events').insert({
        company_id:    req.companyId,
        deadline_id:   deadline.id,
        event_type:    'created',
        new_status:    'open',
        actor_user_id: req.user ? req.user.userId : null,
        metadata: {
          source:          'workflow_generate',
          workflow_run_id: run.id,
          template_id:     template_id
        }
      });

    } catch (dlCreateErr) {
      // Deadline creation failed — run and tasks were created successfully.
      // Return partial result with a clear warning so the caller can surface it.
      return {
        run,
        tasks: insertedTasks,
        deadline: null,
        warning: `Workflow and tasks created but deadline creation failed: ${dlCreateErr.message}`
      };
    }
  }

  return { run, tasks: insertedTasks, deadline };
}

module.exports = {
  createTemplate, updateTemplate, getTemplate, listTemplates,
  createRunAndGenerateTasks,
  listSteps, createStep, updateStep, deleteStep, reorderSteps,
  // Exposed for use in routes
  COMPLIANCE_AREAS, DEADLINE_TYPE_EXTENDED, DEADLINE_PRIORITIES, OFFSET_BASIS_VALUES
};
