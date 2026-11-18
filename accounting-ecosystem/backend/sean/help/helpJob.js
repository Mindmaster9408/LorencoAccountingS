/**
 * ============================================================================
 * SEVCO help chatbot — the 'help_answer' job for the local AI worker
 * ============================================================================
 *   payload(job)       → the question + the APPROVED articles that matched it
 *                        (follow-ups: + the conversation, as ready `messages`)
 *   complete(job, out) → store the answer on sevco_help_questions
 * Since 2026-11-17 only follow-ups ("explain step by step", kind 'explain') are
 * queued; first questions get the article only. Every follow-up answer passes
 * explain.checkAnswer() before a client can see it (lock 4).
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../config/database');
const { approvedArticles } = require('./routes');
const { APPS } = require('./knowledge');
const E = require('./explain');

async function loadQuestion(job) {
  const { data, error } = await supabase.from('sevco_help_questions').select('*')
    .eq('id', job.ref_id).eq('company_id', job.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw Object.assign(new Error('Question not found'), { permanent: true });
  return data;
}

// A follow-up explains only the BEST matching article — more articles confused
// the small model (trial 2026-11-17: "verlof" also pulled in "add users").
async function articlesFor(q) {
  const all = await approvedArticles(q.app, q.language);
  const slugs = (q.matched_slugs || []).slice(0, q.kind === 'explain' ? 1 : undefined);
  return slugs.map(s => all.find(a => a.slug === s)).filter(Boolean)
    .map(a => ({ title: a.title, body: a.body, screen_name: a.screen_name || null }));
}

async function threadOf(q) {
  const { data: root, error } = await supabase.from('sevco_help_questions').select('*')
    .eq('id', q.parent_id).eq('company_id', q.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!root) throw Object.assign(new Error('First question not found'), { permanent: true });
  const { data: history, error: hErr } = await supabase.from('sevco_help_questions')
    .select('id, question, ai_answer, ai_status').eq('parent_id', root.id).eq('company_id', q.company_id)
    .lt('id', q.id).eq('ai_status', 'done').order('id');
  if (hErr) throw new Error(hErr.message);
  return { root, history: history || [] };
}

async function payload(job) {
  const q = await loadQuestion(job);
  const articles = await articlesFor(q);
  if (!articles.length) throw Object.assign(new Error('The matched articles are no longer approved'), { permanent: true });
  const cfg = APPS[q.app] || {};
  const out = { kind: 'help_answer', question: q.question, language: q.language, app: q.app,
    app_name: cfg.name || q.app, bot_name: cfg.bot || 'Pip', articles };
  if (q.kind === 'explain' && q.parent_id) {
    const { root, history } = await threadOf(q);
    out.mode = 'explain';
    out.messages = E.buildExplainMessages({ app: q.app, language: q.language, articles,
      rootQuestion: root.question, history, message: q.question, atStep: q.at_step });
  }
  return out;
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
  // A follow-up that is off the article: the widget asks it as a new question instead.
  if (notCovered && q.kind !== 'explain') patch.status = 'unmatched';

  // Lock 4 — nothing with numbers, codes, links or tax words that the article
  // doesn't have reaches the client. Kept (marked) for SEVCO review.
  if (answer) {
    const check = E.checkAnswer(answer, await articlesFor(q), q.language);
    if (!check.ok) {
      patch.ai_status = 'blocked';
      patch.ai_answer = ('[blocked: ' + check.reason + ']\n' + answer).slice(0, 3000);
    }
  }
  let { error } = await supabase.from('sevco_help_questions').update(patch).eq('id', q.id);
  if (error && patch.ai_status === 'blocked' && /ai_status_check|violates check/i.test(error.message || '')) {
    patch.ai_status = 'failed';   // migration 185 not run yet — still never shown
    ({ error } = await supabase.from('sevco_help_questions').update(patch).eq('id', q.id));
  }
  if (error) throw new Error(error.message);
  return { needs_review: false };
}

module.exports = { payload, complete };
