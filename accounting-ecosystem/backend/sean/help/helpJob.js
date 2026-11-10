/**
 * ============================================================================
 * SEVCO help chatbot — the 'help_answer' job for the local AI worker
 * ============================================================================
 *   payload(job)       → the question + the APPROVED articles that matched it
 *   complete(job, out) → store the answer on sevco_help_questions
 * The model may only answer from those articles (the worker's prompt says so);
 * the articles themselves are always shown to the user as well, with links.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');
const { approvedArticles } = require('./routes');

async function loadQuestion(job) {
  const { data, error } = await supabase.from('sevco_help_questions').select('*')
    .eq('id', job.ref_id).eq('company_id', job.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw Object.assign(new Error('Question not found'), { permanent: true });
  return data;
}

async function payload(job) {
  const q = await loadQuestion(job);
  const all = await approvedArticles(q.app, q.language);
  const articles = (q.matched_slugs || []).map(s => all.find(a => a.slug === s)).filter(Boolean)
    .map(a => ({ title: a.title, body: a.body, screen_name: a.screen_name || null }));
  if (!articles.length) throw Object.assign(new Error('The matched articles are no longer approved'), { permanent: true });
  return { kind: 'help_answer', question: q.question, language: q.language, app: q.app, articles };
}

async function complete(job, output) {
  const q = await loadQuestion(job);
  const f = output.fields || {};
  let answer = String(f.answer || '').trim().slice(0, 3000);
  // The model says NOT_COVERED when the articles don't answer the question: no free-text
  // "I don't know" from a small model (its Afrikaans drifts to Dutch); the widget keeps the
  // article(s) and the question goes to SEVCO's "questions to deal with" list.
  const notCovered = /NOT_COVERED/i.test(answer);
  if (notCovered) answer = '';
  const patch = {
    ai_status: answer || notCovered ? 'done' : 'failed',
    ai_answer: answer || null,
    ai_model: String(output.model || '').slice(0, 80) || null
  };
  if (notCovered) patch.status = 'unmatched';
  const { error } = await supabase.from('sevco_help_questions').update(patch).eq('id', q.id);
  if (error) throw new Error(error.message);
  return { needs_review: false };
}

module.exports = { payload, complete };
