/**
 * ============================================================================
 * Local AI worker queue (migration 174) — shared, generic by `kind`
 * ============================================================================
 * Ruan 2026-11-10: a model runs on his own computer (Ollama) until there is
 * budget for Claude. The cloud app cannot reach that computer, so the worker
 * there asks for work (see shared/routes/localAiWorker.js and local-ai-worker/
 * in the repo root). Switched on by LOCAL_AI_WORKER_TOKEN; without it nothing is
 * queued and the app behaves exactly as before.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');

const ONLINE_SECONDS = 120;

function enabled() {
  return !!(process.env.LOCAL_AI_WORKER_TOKEN && String(process.env.LOCAL_AI_WORKER_TOKEN).length >= 24);
}

let _hasTable = false;
async function hasTable() {
  if (_hasTable) return true;
  try {
    const { error } = await supabase.from('local_ai_jobs').select('id').limit(1);
    if (!error) _hasTable = true;
  } catch (_) { /* not there yet */ }
  return _hasTable;
}

/** Queue a job unless one is already open for this item. Never throws into the caller. */
async function enqueue(kind, companyId, refId) {
  try {
    if (!enabled() || !(await hasTable())) return { queued: false, reason: 'disabled' };
    const { data, error } = await supabase.from('local_ai_jobs')
      .insert({ kind, company_id: companyId, ref_id: refId }).select('id').single();
    if (error) {
      if (error.code === '23505') return { queued: false, reason: 'already_open' };
      console.warn('[local-ai] enqueue failed:', error.message);
      return { queued: false, reason: 'error' };
    }
    return { queued: true, job_id: data.id };
  } catch (err) {
    console.warn('[local-ai] enqueue failed:', err.message);
    return { queued: false, reason: 'error' };
  }
}

/** Latest job for an item (null when none / feature off). */
async function latestJob(kind, refId) {
  if (!(await hasTable())) return null;
  const { data } = await supabase.from('local_ai_jobs')
    .select('id, status, attempts, error, created_at, done_at')
    .eq('kind', kind).eq('ref_id', refId).order('id', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

/** Is any worker alive, and how many jobs wait? */
async function status() {
  if (!enabled() || !(await hasTable())) return { enabled: false };
  const since = new Date(Date.now() - ONLINE_SECONDS * 1000).toISOString();
  const [{ data: workers }, { count }] = await Promise.all([
    supabase.from('local_ai_workers').select('worker_id, last_seen').gte('last_seen', since),
    supabase.from('local_ai_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'claimed'])
  ]);
  return { enabled: true, online: (workers || []).length > 0, waiting: count || 0 };
}

module.exports = { enabled, hasTable, enqueue, latestJob, status, ONLINE_SECONDS };
