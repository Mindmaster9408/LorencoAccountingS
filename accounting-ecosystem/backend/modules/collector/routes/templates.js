/**
 * Collector — Requirement Templates (staff, authenticated)
 * The recurring checklist definition per client. Editing a template never
 * touches already-open/closed periods' snapshotted period_items.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router({ mergeParams: true });

const DOC_TYPES = ['bank_statement', 'petty_cash', 'payroll_report', 'sales_invoices', 'purchase_receipts', 'ar_ap', 'other'];
const FREQUENCIES = ['monthly', 'quarterly', 'annual'];

async function verifyClient(companyId, clientId) {
  const { data } = await supabase
    .from('collector_clients').select('id')
    .eq('id', clientId).eq('company_id', companyId).maybeSingle();
  return !!data;
}

function sanitizeTemplateBody(body) {
  const allowed = ['doc_type', 'label', 'description', 'frequency', 'is_required', 'active', 'sort_order'];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

router.get('/clients/:clientId/templates', async (req, res) => {
  if (!(await verifyClient(req.companyId, req.params.clientId))) {
    return res.status(404).json({ error: 'Client not found' });
  }
  const { active = 'true' } = req.query;
  let q = supabase
    .from('collector_requirement_templates').select('*')
    .eq('client_id', req.params.clientId).eq('company_id', req.companyId)
    .order('sort_order');
  if (active !== 'all') q = q.eq('active', active === 'true');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ templates: data || [] });
});

router.post('/clients/:clientId/templates', async (req, res) => {
  if (!(await verifyClient(req.companyId, req.params.clientId))) {
    return res.status(404).json({ error: 'Client not found' });
  }
  const body = sanitizeTemplateBody(req.body);
  if (!body.label) return res.status(400).json({ error: 'label is required' });
  if (body.doc_type && !DOC_TYPES.includes(body.doc_type)) {
    return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}` });
  }
  if (body.frequency && !FREQUENCIES.includes(body.frequency)) {
    return res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(', ')}` });
  }
  body.client_id = parseInt(req.params.clientId, 10);
  body.company_id = req.companyId;

  const { data, error } = await supabase.from('collector_requirement_templates').insert(body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'collector_requirement_template', data.id, { module: 'collector' });
  res.status(201).json({ template: data });
});

router.put('/templates/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('collector_requirement_templates').select('id')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  const body = sanitizeTemplateBody(req.body);
  if (body.doc_type && !DOC_TYPES.includes(body.doc_type)) {
    return res.status(400).json({ error: `doc_type must be one of: ${DOC_TYPES.join(', ')}` });
  }
  if (body.frequency && !FREQUENCIES.includes(body.frequency)) {
    return res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(', ')}` });
  }
  body.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('collector_requirement_templates').update(body)
    .eq('id', req.params.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'UPDATE', 'collector_requirement_template', data.id, { module: 'collector' });
  res.json({ template: data });
});

router.delete('/templates/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('collector_requirement_templates').select('id')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  const { error } = await supabase
    .from('collector_requirement_templates')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DEACTIVATE', 'collector_requirement_template', parseInt(req.params.id, 10), { module: 'collector' });
  res.json({ success: true });
});

module.exports = router;
