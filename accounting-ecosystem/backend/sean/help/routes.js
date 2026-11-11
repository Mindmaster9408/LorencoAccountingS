/**
 * ============================================================================
 * SEVCO help chatbot — API (Ruan 2026-11-10)
 * ============================================================================
 *   /api/help        every user of the app (module access like the app itself)
 *     POST /ask                  {app, question, language} → matched articles now,
 *                                 local AI answer later (queued) when available
 *     GET  /questions/:id        poll for the AI answer (own questions only)
 *     POST /questions/:id/feedback {feedback: 'up'|'down', note?}
 *     GET  /available?app=       is the assistant ready (table + at least one approved article)?
 *   /api/sevco/help  super users only — the brain's knowledge
 *     GET  /articles?app=        all current articles (both languages)
 *     PUT  /articles             create / edit (an edit of an approved article is a new DRAFT version)
 *     POST /articles/approve     {app, slug} — DRAFT → APPROVED, old version SUPERSEDED
 *     POST /articles/archive     {app, slug}
 *     GET  /questions?app=&open=1  unmatched / thumbs-down questions to deal with
 *     POST /questions/:id/reviewed
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../config/database');
const { requireSuperAdmin } = require('../../middleware/auth');
const { requireModule } = require('../../middleware/module-check');
const { auditFromReq } = require('../../middleware/audit');
const localAi = require('../../shared/services/localAiQueue');
const K = require('./knowledge');

const userRouter = express.Router();
const adminRouter = express.Router();

const NEEDS_176 = 'The help chatbot needs database update 176 first.';
const LANGS = ['AF', 'EN'];
const lang = (v) => (String(v || '').toUpperCase() === 'EN' ? 'EN' : 'AF');
const missingTable = (err) => err && /sevco_help_questions|does not exist|schema cache/i.test(err.message || '');

async function currentRows(domain) {
  const { data, error } = await supabase.from('sean_knowledge_items')
    .select('id, slug, title, content, language, status, version, tags, source_url, source_section, approved_at, updated_at, superseded_by_id')
    .eq('domain', domain).eq('layer', 'APP_HELP').is('company_id', null).in('status', ['DRAFT', 'APPROVED', 'ARCHIVED']);
  if (error) throw new Error(error.message);
  return data || [];
}

/** Approved articles in the asked language; the other language fills gaps. */
async function approvedArticles(app, language) {
  const rows = (await currentRows(K.APPS[app].domain)).filter(r => r.status === 'APPROVED');
  const by = {};
  rows.forEach(r => {
    const prev = by[r.slug];
    if (!prev || (r.language === language && prev.language !== language)) by[r.slug] = r;
  });
  return Object.values(by).map(r => ({ slug: r.slug, title: r.title, body: r.content, tags: r.tags || [],
    language: r.language, screen_url: r.source_url, screen_name: r.source_section }));
}

function appFromReq(req, res) {
  const app = String((req.body && req.body.app) || req.query.app || '').toLowerCase();
  if (!K.APPS[app]) { res.status(400).json({ error: 'Unknown app' }); return null; }
  return app;
}

// ─── users ──────────────────────────────────────────────────────────────────

// The widget only shows its button when this says yes — so nothing appears for users
// before migration 176 has run and a super user has approved at least one article.
userRouter.get('/available', async (req, res) => {
  try {
    const app = String(req.query.app || '').toLowerCase();
    if (!K.APPS[app]) return res.json({ available: false });
    const { error: tErr } = await supabase.from('sevco_help_questions').select('id').limit(1);
    if (tErr) return res.json({ available: false });
    const { data, error } = await supabase.from('sean_knowledge_items').select('id')
      .eq('domain', K.APPS[app].domain).eq('layer', 'APP_HELP').eq('status', 'APPROVED').is('company_id', null).limit(1);
    res.json({ available: !error && (data || []).length > 0 });
  } catch (err) {
    res.json({ available: false });
  }
});


userRouter.post('/ask', (req, res, next) => {
  const app = appFromReq(req, res);
  if (!app) return;
  req._helpApp = app;
  return requireModule(K.APPS[app].module)(req, res, next);
}, async (req, res) => {
  try {
    const app = req._helpApp;
    const question = String(req.body.question || '').trim().slice(0, 1000);
    if (question.length < 2) return res.status(400).json({ error: 'Please type a question' });
    // Answer in the language the question was asked in; the widget's last language only breaks ties.
    const language = K.detectLanguage(question, lang(req.body.language));

    // Tax/advice questions are the paid Sean AI add-on — Pip (free) does not answer them.
    if (K.isAdviceQuestion(question)) {
      const base = { app, company_id: req.companyId, user_id: (req.user && req.user.userId) || null, language, question };
      let { data: q, error } = await supabase.from('sevco_help_questions')
        .insert(Object.assign({ status: 'advice' }, base)).select('id').single();
      if (error && /status_check|violates check/i.test(error.message || '')) {   // migration 177 not run yet
        ({ data: q, error } = await supabase.from('sevco_help_questions')
          .insert(Object.assign({ status: 'unmatched', feedback_note: 'advice question' }, base)).select('id').single());
      }
      if (error) return res.status(missingTable(error) ? 503 : 500).json({ error: missingTable(error) ? NEEDS_176 : error.message });
      return res.json({ question_id: q.id, language, advice: true, articles: [], ai: { status: 'none' } });
    }

    const articles = await approvedArticles(app, language);
    const ranked = K.rank(articles, question);
    const matched = ranked.map(r => articles.find(a => a.slug === r.slug));

    const { data: q, error } = await supabase.from('sevco_help_questions').insert({
      app, company_id: req.companyId, user_id: (req.user && req.user.userId) || null, language, question,
      matched_slugs: matched.map(a => a.slug), match_score: ranked.length ? ranked[0].score : null,
      status: matched.length ? 'matched' : 'unmatched'
    }).select('id').single();
    if (error) return res.status(missingTable(error) ? 503 : 500).json({ error: missingTable(error) ? NEEDS_176 : error.message });

    let ai = { status: 'none' };
    if (matched.length) {
      const queued = await localAi.enqueue('help_answer', req.companyId, q.id);
      if (queued.queued) {
        await supabase.from('sevco_help_questions').update({ ai_status: 'queued' }).eq('id', q.id);
        const st = await localAi.status();
        ai = { status: 'queued', online: !!st.online };
      }
    }
    res.json({
      question_id: q.id, language,
      articles: matched.map(a => ({ slug: a.slug, title: a.title, body: a.body, screen_url: a.screen_url, screen_name: a.screen_name, language: a.language })),
      ai
    });
  } catch (err) {
    console.error('[help] ask failed:', err.message);
    res.status(500).json({ error: 'The help assistant could not answer right now' });
  }
});

async function ownQuestion(req) {
  const { data } = await supabase.from('sevco_help_questions').select('*')
    .eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
  if (!data) return null;
  if (data.user_id && req.user && data.user_id !== req.user.userId && !req.user.isSuperAdmin) return null;
  return data;
}

userRouter.get('/questions/:id', async (req, res) => {
  try {
    const q = await ownQuestion(req);
    if (!q) return res.status(404).json({ error: 'Not found' });
    let online = null;
    if (q.ai_status === 'queued') online = !!(await localAi.status()).online;
    res.json({ ai_status: q.ai_status, ai_answer: q.ai_answer, online });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

userRouter.post('/questions/:id/feedback', async (req, res) => {
  try {
    const q = await ownQuestion(req);
    if (!q) return res.status(404).json({ error: 'Not found' });
    const fb = req.body.feedback === 'up' ? 'up' : req.body.feedback === 'down' ? 'down' : null;
    if (!fb) return res.status(400).json({ error: "feedback must be 'up' or 'down'" });
    const { error } = await supabase.from('sevco_help_questions')
      .update({ feedback: fb, feedback_note: req.body.note ? String(req.body.note).slice(0, 500) : null }).eq('id', q.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── super users: the brain's knowledge ─────────────────────────────────────

adminRouter.use(requireSuperAdmin);

adminRouter.get('/articles', async (req, res) => {
  try {
    const app = appFromReq(req, res);
    if (!app) return;
    res.json({ app, articles: K.groupArticles(await currentRows(K.APPS[app].domain)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SLUG_RE = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;

adminRouter.put('/articles', async (req, res) => {
  try {
    const app = appFromReq(req, res);
    if (!app) return;
    const domain = K.APPS[app].domain;
    const b = req.body;
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug) || slug.length > 120) return res.status(400).json({ error: 'slug: lower-case words separated by - or /' });
    const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','))
      .map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30);
    const meta = { source_url: b.screen_url ? String(b.screen_url).slice(0, 300) : null,
                   source_section: b.screen_name ? String(b.screen_name).slice(0, 120) : null, tags };

    const rows = (await currentRows(domain)).filter(r => r.slug === slug);
    const userId = req.user && req.user.userId ? String(req.user.userId) : null;
    const saved = [];
    for (const L of LANGS) {
      const part = b[L.toLowerCase()];
      if (!part) continue;
      const title = String(part.title || '').trim().slice(0, 200);
      const content = String(part.body || '').trim().slice(0, 8000);
      if (!title || !content) return res.status(400).json({ error: `${L}: title and body are required` });
      const draft = rows.find(r => r.language === L && r.status === 'DRAFT');
      const live = rows.find(r => r.language === L && r.status === 'APPROVED');
      if (draft) {
        const { error } = await supabase.from('sean_knowledge_items')
          .update(Object.assign({ title, content, content_text: content, updated_at: new Date().toISOString() }, meta)).eq('id', draft.id);
        if (error) throw new Error(error.message);
        saved.push({ language: L, id: draft.id, version: draft.version });
      } else {
        const version = Math.max(0, ...rows.filter(r => r.language === L).map(r => r.version || 0)) + 1;
        const { data, error } = await supabase.from('sean_knowledge_items').insert(Object.assign({
          title, content, content_text: content, domain, layer: 'APP_HELP', content_type: 'help_article', language: L,
          slug, status: 'DRAFT', version, kb_version: version, scope_type: 'GLOBAL', company_id: null,
          source_type: 'sevco_help', submitted_by_user_id: userId,
          citation_id: `HELP:${slug}:${L}:v${version}`,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }, meta)).select('id').single();
        if (error) throw new Error(error.message);
        saved.push({ language: L, id: data.id, version, replaces: live ? live.id : null });
      }
    }
    if (!saved.length) return res.status(400).json({ error: 'Give the article in af and/or en' });
    await auditFromReq(req, 'UPDATE', 'sevco_help_article', slug, { module: 'sevco', metadata: { app, saved } });
    res.json({ slug, saved, status: 'DRAFT' });
  } catch (err) {
    console.error('[sevco help] save failed:', err.message);
    res.status(500).json({ error: 'Could not save the article' });
  }
});

adminRouter.post('/articles/approve', async (req, res) => {
  try {
    const app = appFromReq(req, res);
    if (!app) return;
    const slug = String(req.body.slug || '');
    const rows = (await currentRows(K.APPS[app].domain)).filter(r => r.slug === slug);
    const drafts = rows.filter(r => r.status === 'DRAFT');
    if (!drafts.length) return res.status(409).json({ error: 'Nothing to approve for this article' });
    const now = new Date().toISOString();
    const userId = req.user && req.user.userId ? String(req.user.userId) : null;
    for (const d of drafts) {
      const old = rows.find(r => r.language === d.language && r.status === 'APPROVED');
      const { error } = await supabase.from('sean_knowledge_items')
        .update({ status: 'APPROVED', approved_by_user_id: userId, approved_at: now, updated_at: now }).eq('id', d.id);
      if (error) throw new Error(error.message);
      if (old) {
        await supabase.from('sean_knowledge_items')
          .update({ status: 'SUPERSEDED', superseded_by_id: d.id, updated_at: now }).eq('id', old.id);
      }
    }
    await auditFromReq(req, 'APPROVE', 'sevco_help_article', slug, { module: 'sevco', metadata: { app, languages: drafts.map(d => d.language) } });
    res.json({ slug, approved: drafts.map(d => d.language) });
  } catch (err) {
    res.status(500).json({ error: 'Could not approve the article' });
  }
});

adminRouter.post('/articles/archive', async (req, res) => {
  try {
    const app = appFromReq(req, res);
    if (!app) return;
    const slug = String(req.body.slug || '');
    const { data, error } = await supabase.from('sean_knowledge_items')
      .update({ status: 'ARCHIVED', updated_at: new Date().toISOString() })
      .eq('domain', K.APPS[app].domain).eq('layer', 'APP_HELP').eq('slug', slug).in('status', ['DRAFT', 'APPROVED']).select('id');
    if (error) throw new Error(error.message);
    await auditFromReq(req, 'ARCHIVE', 'sevco_help_article', slug, { module: 'sevco', metadata: { app } });
    res.json({ slug, archived: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: 'Could not archive the article' });
  }
});

adminRouter.get('/questions', async (req, res) => {
  try {
    const app = appFromReq(req, res);
    if (!app) return;
    let q = supabase.from('sevco_help_questions')
      .select('id, company_id, language, question, matched_slugs, status, ai_status, ai_answer, feedback, feedback_note, reviewed_at, created_at')
      .eq('app', app).order('created_at', { ascending: false }).limit(200);
    if (req.query.open === '1') q = q.is('reviewed_at', null).or('status.eq.unmatched,status.eq.advice,feedback.eq.down');
    const { data, error } = await q;
    if (error) return res.status(missingTable(error) ? 503 : 500).json({ error: missingTable(error) ? NEEDS_176 : error.message });
    res.json({ app, questions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.post('/questions/:id/reviewed', async (req, res) => {
  try {
    const { error } = await supabase.from('sevco_help_questions')
      .update({ reviewed_at: new Date().toISOString(), reviewed_by: (req.user && req.user.userId) || null }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { userRouter, adminRouter, approvedArticles };
