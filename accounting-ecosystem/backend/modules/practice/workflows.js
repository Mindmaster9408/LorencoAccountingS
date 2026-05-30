const express = require('express');
const router = express.Router();
const { auditFromReq } = require('../../middleware/audit');
const workflowService = require('./services/workflowService');

// List templates
router.get('/templates', async (req, res) => {
  try {
    const list = await workflowService.listTemplates(req);
    res.json({ templates: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create template
router.post('/templates', async (req, res) => {
  try {
    const tpl = await workflowService.createTemplate(req, req.body);
    await auditFromReq(req, 'CREATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.status(201).json({ template: tpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get template
router.get('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.getTemplate(req, req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: tpl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update template
router.put('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.updateTemplate(req, req.params.id, req.body);
    await auditFromReq(req, 'UPDATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.json({ template: tpl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft-delete (deactivate) template
router.delete('/templates/:id', async (req, res) => {
  try {
    const tpl = await workflowService.updateTemplate(req, req.params.id, { is_active: false });
    await auditFromReq(req, 'DEACTIVATE', 'practice_workflow_template', tpl.id, { module: 'practice' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generate a workflow run and create tasks
router.post('/generate', async (req, res) => {
  try {
    const { template_id, client_id, start_date, source_type } = req.body;
    if (!template_id) return res.status(400).json({ error: 'template_id is required' });
    const result = await workflowService.createRunAndGenerateTasks(req, { template_id, client_id, start_date, source_type });
    await auditFromReq(req, 'CREATE', 'practice_workflow_run', result.run.id, { module: 'practice' });
    res.status(201).json({ run: result.run, tasks: result.tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List runs
router.get('/runs', async (req, res) => {
  try {
    const { supabase } = require('../../config/database');
    const { data, error } = await supabase.from('practice_workflow_runs').select('*').eq('company_id', req.companyId).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ runs: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Template steps CRUD
router.get('/templates/:id/steps', async (req, res) => {
  try {
    const steps = await workflowService.listSteps(req, parseInt(req.params.id));
    res.json({ steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/templates/:id/steps', async (req, res) => {
  try {
    const step = await workflowService.createStep(req, parseInt(req.params.id), req.body);
    await auditFromReq(req, 'CREATE', 'practice_workflow_template_step', step.id, { module: 'practice' });
    res.status(201).json({ step });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/templates/:templateId/steps/:stepId', async (req, res) => {
  try {
    const step = await workflowService.updateStep(req, parseInt(req.params.stepId), req.body);
    await auditFromReq(req, 'UPDATE', 'practice_workflow_template_step', step.id, { module: 'practice' });
    res.json({ step });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/templates/:templateId/steps/:stepId', async (req, res) => {
  try {
    await workflowService.deleteStep(req, parseInt(req.params.stepId));
    await auditFromReq(req, 'DELETE', 'practice_workflow_template_step', parseInt(req.params.stepId), { module: 'practice' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reorder template steps (atomic-ish)
router.put('/templates/:id/steps/reorder', async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const { stepIds } = req.body || {};
    if (!Array.isArray(stepIds)) return res.status(400).json({ error: 'stepIds must be an array' });
    await workflowService.reorderSteps(req, templateId, stepIds);
    await auditFromReq(req, 'UPDATE', 'workflow_template_steps_reordered', templateId, { module: 'practice', metadata: { stepIds } });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Get run details
router.get('/runs/:id', async (req, res) => {
  try {
    const { supabase } = require('../../config/database');
    const { data, error } = await supabase.from('practice_workflow_runs').select('*').eq('id', req.params.id).eq('company_id', req.companyId).single();
    if (error) return res.status(404).json({ error: 'Run not found' });
    const { data: steps } = await supabase.from('practice_workflow_run_steps').select('*').eq('run_id', req.params.id).order('ordinal', { ascending: true });
    res.json({ run: data, steps: steps || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
