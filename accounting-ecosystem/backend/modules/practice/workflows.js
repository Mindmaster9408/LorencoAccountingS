const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const workflowService = require('./services/workflowService');

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const list = await workflowService.listTemplates(req);
    res.json({ templates: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const tpl = await workflowService.createTemplate(req, req.body);
    await auditFromReq(req, 'CREATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.status(201).json({ template: tpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.getTemplate(req, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: tpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.updateTemplate(req, req.params.id, req.body);
    await auditFromReq(req, 'UPDATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.json({ template: tpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft-delete (deactivate) template
router.delete('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.updateTemplate(req, req.params.id, { is_active: false });
    await auditFromReq(req, 'DEACTIVATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Template steps ────────────────────────────────────────────────────────────

router.get('/templates/:id/steps', async (req, res) => {
  try {
    const steps = await workflowService.listSteps(req, parseInt(req.params.id));
    res.json({ steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates/:id/steps', async (req, res) => {
  try {
    const step = await workflowService.createStep(req, parseInt(req.params.id), req.body);
    await auditFromReq(req, 'CREATE', 'practice_workflow_template_step', step.id, { module: 'practice' });
    res.status(201).json({ step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/templates/:templateId/steps/:stepId', async (req, res) => {
  try {
    const step = await workflowService.updateStep(req, parseInt(req.params.stepId), req.body);
    await auditFromReq(req, 'UPDATE', 'practice_workflow_template_step', step.id, { module: 'practice' });
    res.json({ step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/templates/:templateId/steps/:stepId', async (req, res) => {
  try {
    await workflowService.deleteStep(req, parseInt(req.params.stepId));
    await auditFromReq(req, 'DELETE', 'practice_workflow_template_step', parseInt(req.params.stepId), { module: 'practice' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder template steps (must be registered BEFORE /templates/:id/steps/:stepId
// to avoid :stepId matching the literal "reorder")
router.put('/templates/:id/steps/reorder', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const { stepIds } = req.body || {};
    if (!Array.isArray(stepIds)) return res.status(400).json({ error: 'stepIds must be an array' });
    await workflowService.reorderSteps(req, templateId, stepIds);
    await auditFromReq(req, 'UPDATE', 'workflow_template_steps_reordered', templateId, { module: 'practice', metadata: { stepIds } });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Generate (create run + tasks + optional deadline) ─────────────────────────

router.post('/generate', async (req, res) => {
  try {
    const {
      template_id, client_id, start_date, source_type,
      // Deadline-creation params (all optional)
      create_deadline,
      deadline_title, compliance_area, deadline_type,
      period_start, period_end, due_date, priority,
      responsible_team_member_id, reviewer_team_member_id
    } = req.body;

    if (!template_id) return res.status(400).json({ error: 'template_id is required' });

    const result = await workflowService.createRunAndGenerateTasks(req, {
      template_id, client_id, start_date, source_type,
      create_deadline, deadline_title, compliance_area, deadline_type,
      period_start, period_end, due_date, priority,
      responsible_team_member_id, reviewer_team_member_id
    });

    await auditFromReq(req, 'CREATE', 'practice_workflow_run', result.run.id, {
      module: 'practice',
      deadline_id: result.deadline ? result.deadline.id : null
    });

    if (result.deadline) {
      await auditFromReq(req, 'CREATE', 'practice_deadline', result.deadline.id, {
        module: 'practice',
        source: 'workflow_generate',
        workflow_run_id: result.run.id
      });
    }

    const response = { run: result.run, tasks: result.tasks, deadline: result.deadline || null };
    if (result.warning) response.warning = result.warning;
    res.status(201).json(response);
  } catch (err) {
    const status = err.message && (
      err.message.includes('required') ||
      err.message.includes('Invalid') ||
      err.message.includes('must be')
    ) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Runs ──────────────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('practice_workflow_runs')
      .select('*')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ runs: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('practice_workflow_runs')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();
    if (error) return res.status(404).json({ error: 'Run not found' });
    const { data: steps } = await supabase
      .from('practice_workflow_run_steps')
      .select('*')
      .eq('run_id', req.params.id)
      .order('ordinal', { ascending: true });
    res.json({ run: data, steps: steps || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get the compliance deadline linked to a run
router.get('/runs/:id/deadline', async (req, res) => {
  try {
    const runId = req.params.id;

    // Verify run belongs to this company
    const { data: run, error: rErr } = await supabase
      .from('practice_workflow_runs')
      .select('id, deadline_id, company_id')
      .eq('id', runId)
      .eq('company_id', req.companyId)
      .single();
    if (rErr || !run) return res.status(404).json({ error: 'Run not found' });

    if (!run.deadline_id) return res.json({ deadline: null });

    const { data: deadline, error: dErr } = await supabase
      .from('practice_deadlines')
      .select('*')
      .eq('id', run.deadline_id)
      .eq('company_id', req.companyId)
      .single();
    if (dErr) return res.status(404).json({ error: 'Deadline not found' });

    res.json({ deadline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link an existing deadline to a run (and update both sides of the link)
router.put('/runs/:id/link-deadline', async (req, res) => {
  try {
    const runId = req.params.id;
    const { deadline_id } = req.body;

    if (!deadline_id) return res.status(400).json({ error: 'deadline_id is required' });

    // Verify run ownership
    const { data: run, error: rErr } = await supabase
      .from('practice_workflow_runs')
      .select('id, deadline_id, company_id')
      .eq('id', runId)
      .eq('company_id', req.companyId)
      .single();
    if (rErr || !run) return res.status(404).json({ error: 'Run not found' });

    // Verify deadline ownership
    const { data: deadline, error: dErr } = await supabase
      .from('practice_deadlines')
      .select('id, company_id, is_active')
      .eq('id', deadline_id)
      .eq('company_id', req.companyId)
      .single();
    if (dErr || !deadline) return res.status(404).json({ error: 'Deadline not found' });
    if (!deadline.is_active) return res.status(400).json({ error: 'Cannot link a cancelled deadline' });

    // Update run.deadline_id
    const { error: uRErr } = await supabase
      .from('practice_workflow_runs')
      .update({ deadline_id: parseInt(deadline_id), updated_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('company_id', req.companyId);
    if (uRErr) throw uRErr;

    // Update deadline.workflow_run_id (back-link)
    await supabase
      .from('practice_deadlines')
      .update({ workflow_run_id: parseInt(runId), updated_at: new Date().toISOString(), updated_by: req.user ? req.user.userId : null })
      .eq('id', deadline_id)
      .eq('company_id', req.companyId);

    // Log deadline event
    await supabase.from('practice_deadline_events').insert({
      company_id:    req.companyId,
      deadline_id:   parseInt(deadline_id),
      event_type:    'workflow_linked',
      actor_user_id: req.user ? req.user.userId : null,
      metadata:      { workflow_run_id: parseInt(runId) }
    });

    await auditFromReq(req, 'UPDATE', 'practice_workflow_run', runId, { module: 'practice', linked_deadline_id: deadline_id });

    res.json({ success: true, run_id: parseInt(runId), deadline_id: parseInt(deadline_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove the deadline link from a run (both sides cleared)
router.put('/runs/:id/unlink-deadline', async (req, res) => {
  try {
    const runId = req.params.id;

    // Verify run ownership and get current link
    const { data: run, error: rErr } = await supabase
      .from('practice_workflow_runs')
      .select('id, deadline_id, company_id')
      .eq('id', runId)
      .eq('company_id', req.companyId)
      .single();
    if (rErr || !run) return res.status(404).json({ error: 'Run not found' });

    const prevDeadlineId = run.deadline_id;
    if (!prevDeadlineId) return res.json({ success: true, message: 'No deadline was linked' });

    // Clear run.deadline_id
    const { error: uRErr } = await supabase
      .from('practice_workflow_runs')
      .update({ deadline_id: null, updated_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('company_id', req.companyId);
    if (uRErr) throw uRErr;

    // Clear deadline.workflow_run_id back-link (only if it points to this run)
    await supabase
      .from('practice_deadlines')
      .update({ workflow_run_id: null, updated_at: new Date().toISOString(), updated_by: req.user ? req.user.userId : null })
      .eq('id', prevDeadlineId)
      .eq('company_id', req.companyId)
      .eq('workflow_run_id', parseInt(runId));

    // Log deadline event
    await supabase.from('practice_deadline_events').insert({
      company_id:    req.companyId,
      deadline_id:   prevDeadlineId,
      event_type:    'workflow_unlinked',
      actor_user_id: req.user ? req.user.userId : null,
      metadata:      { workflow_run_id: parseInt(runId) }
    });

    await auditFromReq(req, 'UPDATE', 'practice_workflow_run', runId, { module: 'practice', unlinked_deadline_id: prevDeadlineId });

    res.json({ success: true, unlinked_deadline_id: prevDeadlineId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
