/**
 * ============================================================================
 * /api/local-ai — the API the local AI worker (Ruan's computer) calls
 * ============================================================================
 * Not a user API: no JWT. The worker sends header `x-worker-token`, compared in
 * constant time with LOCAL_AI_WORKER_TOKEN. Without that variable every route
 * answers 404, so the feature is invisible until it is configured.
 *
 *   POST /claim                {worker_id, kinds?}          → { job, payload } | { job: null }
 *   POST /jobs/:id/result      {worker_id, model, duration_ms, fields}
 *   POST /jobs/:id/fail        {worker_id, error, retry?}
 *   POST /heartbeat            {worker_id, info?}
 * The worker only ever produces suggestions; the person confirms in the app.
 * ============================================================================
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../../config/database');
const queue = require('../services/localAiQueue');

const router = express.Router();
const LEASE_SECONDS = 600;

// kind → handler { payload(job), complete(job, output) }; only modules that are enabled.
function handlerFor(kind) {
  if (kind === 'slip_read') return require('../../modules/slips/services/localAiSlipJob');
  if (kind === 'help_answer') return require('../../sean/help/helpJob');
  return null;
}
const KINDS = ['slip_read', 'help_answer'];

function tokenOk(req) {
  const want = process.env.LOCAL_AI_WORKER_TOKEN || '';
  const got = String(req.get('x-worker-token') || '');
  if (!queue.enabled() || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

router.use((req, res, next) => (tokenOk(req) ? next() : res.status(404).json({ error: 'Not found' })));

const workerId = (req) => String((req.body && req.body.worker_id) || 'worker').replace(/[^\w.-]/g, '').slice(0, 60) || 'worker';

async function heartbeat(id, info) {
  await supabase.from('local_ai_workers')
    .upsert({ worker_id: id, last_seen: new Date().toISOString(), info: info || {} }, { onConflict: 'worker_id' });
}

router.post('/heartbeat', async (req, res) => {
  try { await heartbeat(workerId(req), req.body && req.body.info); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/claim', async (req, res) => {
  const id = workerId(req);
  try {
    await heartbeat(id, req.body && req.body.info);
    const kinds = (Array.isArray(req.body && req.body.kinds) ? req.body.kinds : KINDS).filter(k => KINDS.includes(k));
    const { data, error } = await supabase.rpc('local_ai_claim', { p_worker: id, p_kinds: kinds, p_lease_seconds: LEASE_SECONDS });
    if (error) throw new Error(error.message);
    const job = Array.isArray(data) ? data[0] : data;
    if (!job) return res.json({ job: null });
    try {
      const payload = await handlerFor(job.kind).payload(job);
      res.json({ job: { id: job.id, kind: job.kind, attempt: job.attempts }, payload });
    } catch (err) {
      await finish(job.id, id, err.permanent ? 'failed' : 'queued', err.message);
      res.json({ job: null, skipped: { id: job.id, error: err.message } });
    }
  } catch (err) {
    console.error('[local-ai] claim failed:', err.message);
    res.status(500).json({ error: 'Could not claim a job' });
  }
});

async function ownJob(jobId, worker) {
  const { data, error } = await supabase.from('local_ai_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) throw new Error(error.message);
  return data && data.status === 'claimed' && data.claimed_by === worker ? data : null;
}

async function finish(jobId, worker, status, errorText) {
  const patch = { status, error: errorText ? String(errorText).slice(0, 500) : null, updated_at: new Date().toISOString() };
  if (status === 'done' || status === 'failed') patch.done_at = patch.updated_at;
  if (status === 'queued') { patch.claimed_by = null; patch.lease_until = null; }
  await supabase.from('local_ai_jobs').update(patch).eq('id', jobId).eq('claimed_by', worker);
}

router.post('/jobs/:id/result', async (req, res) => {
  const id = workerId(req);
  try {
    const job = await ownJob(req.params.id, id);
    if (!job) return res.status(409).json({ error: 'Job is not claimed by this worker (lease ran out?)' });
    const fields = req.body && req.body.fields;
    if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields is required' });
    const out = await handlerFor(job.kind).complete(job, { fields, model: req.body.model, duration_ms: req.body.duration_ms });
    await finish(job.id, id, 'done', null);
    res.json(Object.assign({ ok: true }, out));
  } catch (err) {
    console.error('[local-ai] result failed:', err.message);
    res.status(500).json({ error: 'Could not store the result' });
  }
});

router.post('/jobs/:id/fail', async (req, res) => {
  const id = workerId(req);
  try {
    const job = await ownJob(req.params.id, id);
    if (!job) return res.status(409).json({ error: 'Job is not claimed by this worker' });
    const retry = req.body && req.body.retry !== false && job.attempts < job.max_attempts;
    await finish(job.id, id, retry ? 'queued' : 'failed', req.body && req.body.error);
    res.json({ ok: true, status: retry ? 'queued' : 'failed' });
  } catch (err) {
    res.status(500).json({ error: 'Could not record the failure' });
  }
});

module.exports = router;
