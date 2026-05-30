const { supabase } = require('../../../config/database');

async function createTemplate(req, body) {
  const data = Object.assign({}, body);
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
  const updates = Object.assign({}, body);
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

async function listTemplates(req, opts = {}) {
  let q = supabase.from('practice_workflow_templates').select('*').eq('company_id', req.companyId).order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Steps management
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
  const { data, error } = await supabase.from('practice_workflow_template_steps').insert(row).select().single();
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

// Reorder steps for a template. stepIds is an array of step IDs in the desired order.
async function reorderSteps(req, template_id, stepIds) {
  if (!Array.isArray(stepIds) || stepIds.length === 0) throw new Error('stepIds must be a non-empty array');
  const unique = new Set(stepIds.map(id => parseInt(id)));
  if (unique.size !== stepIds.length) throw new Error('Duplicate step IDs are not allowed');

  // Fetch the steps and validate ownership/template
  const { data: steps, error: fErr } = await supabase
    .from('practice_workflow_template_steps')
    .select('id,template_id,company_id')
    .in('id', stepIds);
  if (fErr) throw fErr;
  if (!steps || steps.length !== stepIds.length) throw new Error('Some steps not found');

  const templateIds = new Set(steps.map(s => s.template_id));
  if (templateIds.size !== 1 || [...templateIds][0] !== template_id) throw new Error('All steps must belong to the same template');

  const companyIds = new Set(steps.map(s => s.company_id));
  if (companyIds.size !== 1 || [...companyIds][0] !== req.companyId) throw new Error('Steps must belong to the authenticated company');

  // Apply new ordinals. We do sequential updates but ensure final ordinals are unique.
  for (let i = 0; i < stepIds.length; i++) {
    const id = parseInt(stepIds[i]);
    const ordinal = i + 1;
    const { error: uErr } = await supabase
      .from('practice_workflow_template_steps')
      .update({ ordinal })
      .eq('id', id)
      .eq('company_id', req.companyId);
    if (uErr) throw uErr;
  }

  return true;
}

async function createRunAndGenerateTasks(req, { template_id, client_id = null, start_date = null, source_type = 'manual' }) {
  // Load template and steps
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

  const runRow = {
    company_id: req.companyId,
    template_id: template_id,
    source_type: source_type || 'manual',
    status: 'pending',
    requested_by: req.user ? req.user.userId : null
  };

  const { data: run, error: rErr } = await supabase
    .from('practice_workflow_runs')
    .insert(runRow)
    .select()
    .single();
  if (rErr) throw rErr;

  // snapshot steps
  const runSteps = (steps || []).map(s => ({
    run_id: run.id,
    template_step_id: s.id,
    ordinal: s.ordinal,
    title: s.title,
    description: s.description || null,
    task_type: s.task_type || null,
    priority: s.priority || null,
    assigned_role: s.assigned_role || null,
    assigned_user_id: s.assigned_user_id || null,
    due_date: null
  }));

  if (runSteps.length) {
    const { error: rsErr } = await supabase.from('practice_workflow_run_steps').insert(runSteps);
    if (rsErr) {
      // Best-effort cleanup of run
      await supabase.from('practice_workflow_runs').delete().eq('id', run.id).eq('company_id', req.companyId);
      throw rsErr;
    }
  }

  // Build tasks for insertion
  const sd = start_date ? new Date(start_date) : new Date();
  const tasksToInsert = (steps || []).map(s => {
    const due = (s.due_offset_days !== null && s.due_offset_days !== undefined)
      ? new Date(sd.getTime() + (parseInt(s.due_offset_days || 0) * 86400000))
      : null;
    return {
      company_id: req.companyId,
      client_id: client_id ? parseInt(client_id) : null,
      title: s.title,
      description: s.description || null,
      type: s.task_type || 'general',
      priority: s.priority || 'medium',
      due_date: due ? due.toISOString().split('T')[0] : null,
      assigned_to: s.assigned_user_id || null,
      notes: null,
      status: 'open',
      created_by: req.user ? req.user.userId : null,
      source_type: 'workflow_template',
      source_id: run.id
    };
  });

  if (!tasksToInsert.length) return { run, tasks: [] };

  const { data: insertedTasks, error: tiErr } = await supabase
    .from('practice_tasks')
    .insert(tasksToInsert)
    .select();

  if (tiErr) {
    // cleanup run and run_steps
    await supabase.from('practice_workflow_run_steps').delete().eq('run_id', run.id);
    await supabase.from('practice_workflow_runs').delete().eq('id', run.id).eq('company_id', req.companyId);
    throw tiErr;
  }

  // mark run in_progress -> completed depending on config — keep pending for manual review
  return { run, tasks: insertedTasks };
}

module.exports = {
  createTemplate, updateTemplate, getTemplate, listTemplates, createRunAndGenerateTasks,
  listSteps, createStep, updateStep, deleteStep, reorderSteps
};

