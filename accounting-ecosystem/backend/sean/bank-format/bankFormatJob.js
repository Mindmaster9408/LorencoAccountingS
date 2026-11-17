/**
 * ============================================================================
 * Local AI job 'bank_format' — learn a bank statement FORMAT
 * ============================================================================
 *   payload(job)       → a sample of the statement + feedback from the last try
 *   complete(job, out) → check the model's recipe against the WHOLE statement
 *                        with the balance chain (plus small variations);
 *                        good → store it as this company's format;
 *                        not good → feedback and another try (max 3).
 * The model's answer is never trusted on its own.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');
const reader = require('./recipeReader');
const { MAX_ATTEMPTS } = require('./formatStore');

async function loadRequest(job) {
  const { data, error } = await supabase.from('bank_format_requests').select('*')
    .eq('id', job.ref_id).eq('company_id', job.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw Object.assign(new Error('Request not found'), { permanent: true });
  if (!['queued', 'retry'].includes(data.status) || !data.statement_text) {
    throw Object.assign(new Error('Request is no longer open'), { permanent: true });
  }
  return data;
}

async function payload(job) {
  const r = await loadRequest(job);
  return {
    sample: reader.sampleOf(r.statement_text),
    feedback: r.feedback || '',
    date_formats: reader.DATE_FORMATS,
  };
}

/** Pure: what to tell the model when its recipe did not reconcile. */
function feedbackFor(recipe, res) {
  if (!res.rows.length) {
    return `Your previous answer ${JSON.stringify(recipe)} found NO transaction lines. Check date_format against the very start of the transaction lines.`;
  }
  const bad = res.rows.find(r => !r.verified);
  return `Your previous answer ${JSON.stringify(recipe)} did not reconcile: ${res.unverified} line(s) where no printed amount matches the change in balance` +
    (bad ? ` (e.g. the line dated ${bad.date})` : '') +
    (res.closing !== null && !res.closingOk ? ', and the closing balance does not match' : '') +
    '. Check the number format, the negative balance marker and the opening balance label.';
}

/** Pure: judge a model answer against the statement text. */
function judge(text, fields) {
  const best = reader.bestVariant(text, fields || {});
  const verified = best.res.rows.filter(r => r.verified).length;
  return {
    recipe: best.recipe,
    res: best.res,
    ok: reader.acceptable(best.res),
    counts: { rows: best.res.rows.length, verified, unverified: best.res.unverified, closing_ok: best.res.closingOk },
  };
}

async function complete(job, output) {
  const r = await loadRequest(job);
  const fields = output.fields || {};
  const j = judge(r.statement_text, fields);
  const attempts = r.attempts + 1;
  const now = new Date().toISOString();

  if (j.ok) {
    const { data: fmt, error } = await supabase.from('bank_statement_formats').insert({
      company_id: r.company_id,
      bank_name: reader.sanitizeBankName(fields.bank_name),
      recipe: j.recipe,
      rows_verified: j.counts.verified,
      learned_by: String(output.model || 'local-ai').slice(0, 60),
    }).select('id').single();
    if (error) throw new Error('Could not store the format: ' + error.message);
    await supabase.from('bank_format_requests').update({
      status: 'learned', attempts, format_id: fmt.id, result: j.counts,
      statement_text: null, feedback: null, updated_at: now,   // client text no longer needed
    }).eq('id', r.id);
    return { learned: true, format_id: fmt.id, needs_review: false };
  }

  const giveUp = attempts >= MAX_ATTEMPTS;
  await supabase.from('bank_format_requests').update({
    status: giveUp ? 'failed' : 'retry', attempts, result: j.counts,
    feedback: giveUp ? null : feedbackFor(reader.sanitizeRecipe(fields), j.res),
    statement_text: giveUp ? null : r.statement_text,
    error: giveUp ? 'Sean could not work out this format' : null, updated_at: now,
  }).eq('id', r.id);
  if (!giveUp) {
    // The current job is finished right after this returns; queue the next try then.
    // (The import screen's status check re-queues as well, in case this is missed.)
    setTimeout(() => {
      require('../../shared/services/localAiQueue').enqueue('bank_format', r.company_id, r.id).catch(() => {});
    }, 3000).unref();
  }
  return { learned: false, retry: !giveUp, needs_review: true };
}

module.exports = { payload, complete, judge, feedbackFor };
