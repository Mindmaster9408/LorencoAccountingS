/**
 * Collector — Periods (staff, authenticated)
 * Open/list/close periods; send the request/reminder email.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const { sendEmail } = require('../../../shared/services/email');
const { openPeriod, recomputePeriodStatus } = require('../services/periodService');
const { issueToken } = require('../services/tokenService');
const { renderRequestEmail } = require('../services/emailTemplates');

const router = express.Router({ mergeParams: true });

function buildUploadUrl(rawToken) {
  const base = (process.env.APP_URL || 'https://lorenco.zeabur.app').replace(/\/$/, '');
  return `${base}/collect/${rawToken}`;
}

async function verifyClient(companyId, clientId) {
  const { data } = await supabase
    .from('collector_clients').select('*')
    .eq('id', clientId).eq('company_id', companyId).maybeSingle();
  return data || null;
}

async function verifyPeriod(companyId, periodId) {
  const { data } = await supabase
    .from('collector_periods').select('*')
    .eq('id', periodId).eq('company_id', companyId).maybeSingle();
  return data || null;
}

router.get('/clients/:clientId/periods', async (req, res) => {
  if (!(await verifyClient(req.companyId, req.params.clientId))) {
    return res.status(404).json({ error: 'Client not found' });
  }
  const { data, error } = await supabase
    .from('collector_periods').select('*')
    .eq('client_id', req.params.clientId).eq('company_id', req.companyId)
    .order('period_label', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ periods: data || [] });
});

router.post('/clients/:clientId/periods', async (req, res) => {
  const client = await verifyClient(req.companyId, req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { period_label, period_start, period_end } = req.body;
  if (!period_label) return res.status(400).json({ error: 'period_label is required (e.g. "2026-08")' });

  try {
    const period = await openPeriod({
      companyId: req.companyId,
      clientId: client.id,
      periodLabel: period_label,
      periodStart: period_start,
      periodEnd: period_end,
      userId: req.user?.userId,
    });
    await auditFromReq(req, 'CREATE', 'collector_period', period.id, { module: 'collector' });
    res.status(201).json({ period });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/periods/:id', async (req, res) => {
  const period = await verifyPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  const { data: items, error: itemsErr } = await supabase
    .from('collector_period_items').select('*')
    .eq('period_id', period.id).order('id');
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  const { data: documents, error: docsErr } = await supabase
    .from('collector_documents').select('*')
    .eq('period_id', period.id).order('created_at', { ascending: false });
  if (docsErr) return res.status(500).json({ error: docsErr.message });

  res.json({ period, items: items || [], documents: documents || [] });
});

router.post('/periods/:id/send', async (req, res) => {
  const period = await verifyPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });
  if (period.status === 'closed') {
    return res.status(400).json({ error: 'This period is closed. Reopen it before sending a request.' });
  }

  const { data: client } = await supabase
    .from('collector_clients').select('*').eq('id', period.client_id).single();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data: items } = await supabase
    .from('collector_period_items').select('*').eq('period_id', period.id).order('id');

  const commType = req.body?.comm_type === 'reminder' ? 'reminder' : 'initial_request';

  let rawToken, tokenRow;
  try {
    ({ rawToken, tokenRow } = await issueToken(period, req.user?.userId));
  } catch (err) {
    return res.status(500).json({ error: `Failed to issue upload link: ${err.message}` });
  }

  const uploadUrl = buildUploadUrl(rawToken);
  const { subject, text, html } = renderRequestEmail({
    client, period, periodItems: items || [], uploadUrl, type: commType,
  });

  const emailResult = await sendEmail({
    to: client.primary_contact_email,
    subject,
    body: text,
    html,
  });

  const { data: logRow } = await supabase.from('collector_comms_log').insert({
    company_id: req.companyId,
    client_id: client.id,
    period_id: period.id,
    token_id: tokenRow.id,
    comm_type: commType,
    channel: 'email',
    recipient_email: client.primary_contact_email,
    subject,
    send_result: emailResult.success ? 'sent' : (emailResult.message === 'Email service not configured yet.' ? 'not_configured' : 'failed'),
    provider_message_id: emailResult.id || null,
    error_message: emailResult.success ? null : (emailResult.message || null),
    sent_by_user_id: req.user?.userId || null,
  }).select().single();

  await auditFromReq(req, 'SEND', 'collector_period', period.id, { module: 'collector', metadata: { comm_type: commType, send_result: emailResult.success } });

  if (!emailResult.success) {
    return res.status(502).json({
      error: emailResult.message || 'Failed to send email',
      comms_log: logRow || null,
    });
  }

  res.json({ success: true, comms_log: logRow, upload_url: uploadUrl });
});

router.post('/periods/:id/close', async (req, res) => {
  const period = await verifyPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  const { data, error } = await supabase
    .from('collector_periods')
    .update({ status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', period.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CLOSE', 'collector_period', period.id, { module: 'collector' });
  res.json({ period: data });
});

router.post('/periods/:id/reopen', async (req, res) => {
  const period = await verifyPeriod(req.companyId, req.params.id);
  if (!period) return res.status(404).json({ error: 'Period not found' });

  const updated = await recomputePeriodStatus(period.id);
  const { data, error } = await supabase
    .from('collector_periods')
    .update({ status: updated?.status === 'complete' ? 'complete' : 'open', closed_at: null, updated_at: new Date().toISOString() })
    .eq('id', period.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'REOPEN', 'collector_period', period.id, { module: 'collector' });
  res.json({ period: data });
});

module.exports = router;
