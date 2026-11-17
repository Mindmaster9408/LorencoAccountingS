/**
 * ============================================================================
 * Bank statement formats — store, lookup, learning requests
 * ============================================================================
 * Lookup: a company may use the formats learned in its own company plus the
 * formats a super user approved for everyone (Rule B2). There are few
 * formats, so every candidate is simply tried and the balance chain picks
 * the winner — no fragile "which bank is this" guessing.
 *
 * Learning: an upload Leo cannot read becomes a request; the local AI worker
 * (job kind 'bank_format') proposes a recipe; bankFormatJob.js checks it.
 * The statement text is kept only while learning, then cleared.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');
const reader = require('./recipeReader');
const localAi = require('../../shared/services/localAiQueue');

const MAX_ATTEMPTS = 3;

/** Formats this company may use: its own + globally approved. Never throws. */
async function candidatesFor(companyId) {
  try {
    const { data, error } = await supabase.from('bank_statement_formats')
      .select('id, company_id, bank_name, recipe, global_status')
      .or(`company_id.eq.${Number(companyId)},global_status.eq.approved`)
      .order('id', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.error('[bank-format] lookup failed:', err.message);
    return [];
  }
}

/**
 * Pure: try each format on the text, return the best acceptable reading.
 * Own-company formats win ties (they were confirmed on this client's files).
 */
function pickBest(text, formats, companyId, opts) {
  let best = null;
  for (const f of formats) {
    const res = reader.readWithRecipe(text, reader.sanitizeRecipe(f.recipe), opts);
    if (!reader.acceptable(res)) continue;
    const s = reader.score(res) + (f.company_id === companyId ? 0.5 : 0);
    if (!best || s > best.s) best = { s, format: f, res };
  }
  return best;
}

/** Read with a learned format, or null. */
async function readWithLearned(text, companyId) {
  const formats = await candidatesFor(companyId);
  if (!formats.length) return null;
  const best = pickBest(text, formats, companyId);
  if (!best) return null;
  supabase.from('bank_statement_formats').update({ last_used_at: new Date().toISOString() })
    .eq('id', best.format.id).then(() => {}, () => {});
  return best;
}

/**
 * Ask Sean to learn this statement's format. Re-uses an open request for the
 * same file. Returns { requestId, status, queued, worker } — never throws.
 */
async function requestLearning({ companyId, text, fileHash, filename, userId }) {
  try {
    if (!localAi.enabled()) return { status: 'unavailable' };
    if (fileHash) {
      const { data: open } = await supabase.from('bank_format_requests')
        .select('id, status').eq('company_id', companyId).eq('file_hash', fileHash)
        .in('status', ['queued', 'retry']).limit(1);
      if (open && open[0]) return { requestId: open[0].id, status: open[0].status, reused: true };
    }
    const { data: reqRow, error } = await supabase.from('bank_format_requests').insert({
      company_id: companyId, file_hash: fileHash || null, filename: String(filename || '').slice(0, 200),
      statement_text: String(text || '').slice(0, 200000), status: 'queued', created_by: userId || null,
    }).select('id, status').single();
    if (error) throw new Error(error.message);
    const q = await localAi.enqueue('bank_format', companyId, reqRow.id);
    return { requestId: reqRow.id, status: reqRow.status, queued: !!q.queued };
  } catch (err) {
    console.error('[bank-format] request failed:', err.message);
    return { status: 'error' };
  }
}

/**
 * Status for the import screen. A request waiting for a retry gets its job
 * re-queued here as well (the worker's job must be finished first).
 */
async function requestStatus(companyId, requestId) {
  const { data: r } = await supabase.from('bank_format_requests')
    .select('id, status, attempts, format_id, result, error, created_at, updated_at')
    .eq('id', requestId).eq('company_id', companyId).maybeSingle();
  if (!r) return null;
  if (r.status === 'retry' || r.status === 'queued') {
    const job = await localAi.latestJob('bank_format', r.id);
    if (!job || job.status === 'done' || job.status === 'failed') await localAi.enqueue('bank_format', companyId, r.id);
  }
  const worker = await localAi.status();
  let format = null;
  if (r.format_id) {
    const { data } = await supabase.from('bank_statement_formats').select('id, bank_name').eq('id', r.format_id).maybeSingle();
    format = data || null;
  }
  return { ...r, format, worker: worker.enabled ? { online: worker.online, waiting: worker.waiting } : null };
}

// ── Super-user review (Rule B2) ─────────────────────────────────────────────

async function listForReview() {
  const { data, error } = await supabase.from('bank_statement_formats')
    .select('id, bank_name, recipe, global_status, statements_verified, rows_verified, created_at, last_used_at, rejection_reason')
    .order('id', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

async function decide(formatId, userId, approve, reason) {
  const now = new Date().toISOString();
  const patch = approve
    ? { global_status: 'approved', approved_by: userId, approved_at: now, updated_at: now }
    : { global_status: 'rejected', rejected_by: userId, rejected_at: now, rejection_reason: reason || null, updated_at: now };
  const { data, error } = await supabase.from('bank_statement_formats')
    .update(patch).eq('id', formatId).eq('global_status', 'pending').select('id, global_status').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Format not found or already decided');
  return data;
}

module.exports = {
  MAX_ATTEMPTS, candidatesFor, pickBest, readWithLearned, requestLearning, requestStatus, listForReview, decide,
};
