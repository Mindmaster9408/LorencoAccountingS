/**
 * Collector — Clients (staff, authenticated)
 * CRUD for collector_clients. practice_client_id is an optional convenience
 * link for Lorenco's own use (Firmflow already knows about e.g. Turkstra) —
 * never required, never assumed non-null downstream.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

const JURISDICTIONS = ['ZA', 'UK', 'AU_NZ', 'US'];
const STATUSES = ['active', 'paused', 'archived'];

function sanitizeClientBody(body) {
  const allowed = [
    'practice_client_id', 'display_name', 'primary_contact_name', 'primary_contact_email',
    'cc_emails', 'jurisdiction', 'timezone', 'status', 'notes',
  ];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

router.get('/', async (req, res) => {
  const { status = 'active' } = req.query;
  let q = supabase.from('collector_clients').select('*').eq('company_id', req.companyId).order('display_name');
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: data || [] });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('collector_clients').select('*')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (error || !data) return res.status(404).json({ error: 'Client not found' });
  res.json({ client: data });
});

router.post('/', async (req, res) => {
  const body = sanitizeClientBody(req.body);
  if (!body.display_name) return res.status(400).json({ error: 'display_name is required' });
  if (!body.primary_contact_email) return res.status(400).json({ error: 'primary_contact_email is required' });
  if (body.jurisdiction && !JURISDICTIONS.includes(body.jurisdiction)) {
    return res.status(400).json({ error: `jurisdiction must be one of: ${JURISDICTIONS.join(', ')}` });
  }
  body.company_id = req.companyId;
  if (req.user?.userId) body.created_by_user_id = req.user.userId;

  const { data, error } = await supabase.from('collector_clients').insert(body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'collector_client', data.id, { module: 'collector' });
  res.status(201).json({ client: data });
});

router.put('/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('collector_clients').select('id')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const body = sanitizeClientBody(req.body);
  if (body.jurisdiction && !JURISDICTIONS.includes(body.jurisdiction)) {
    return res.status(400).json({ error: `jurisdiction must be one of: ${JURISDICTIONS.join(', ')}` });
  }
  if (body.status && !STATUSES.includes(body.status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  body.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('collector_clients').update(body)
    .eq('id', req.params.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'UPDATE', 'collector_client', data.id, { module: 'collector' });
  res.json({ client: data });
});

router.delete('/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('collector_clients').select('id')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const { error } = await supabase
    .from('collector_clients')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'ARCHIVE', 'collector_client', parseInt(req.params.id, 10), { module: 'collector' });
  res.json({ success: true });
});

module.exports = router;
