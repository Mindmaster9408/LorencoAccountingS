/**
 * ============================================================================
 * SEVCO help knowledge — the brain every app's chatbot asks (Ruan 2026-11-10)
 * ============================================================================
 * Articles live in sean_knowledge_items (no new table):
 *   domain        '<APP>_HELP'        e.g. PAYTIME_HELP
 *   layer         'APP_HELP'          content_type 'help_article'
 *   language      'AF' | 'EN'         one row per language, sharing `slug`
 *   status        DRAFT → APPROVED (a super user) → SUPERSEDED / ARCHIVED
 *   version       +1 per edit; the old row gets superseded_by_id
 *   source_url    the screen the article is about (link in the chat)
 *   source_section the screen's name   tags = extra search words
 * Only APPROVED, GLOBAL (company_id NULL) rows answer questions.
 *
 * Search is plain word matching (Afrikaans + English, a small synonym list) —
 * good for a few hundred short articles, needs no AI and works when the local
 * AI computer is off. The AI only rewrites the matched articles into an answer.
 * ============================================================================
 */

'use strict';

const APPS = {
  paytime: { domain: 'PAYTIME_HELP', module: 'payroll', name: 'Paytime' }
};

const STOP = new Set((
  'the a an and or to of in on for is are be it i my me we our you your how do does can what where when which why with from at by this that ' +
  'die n en of om te van in op vir is was word dit ek my ons jy jou hoe doen kan wat waar wanneer watter hoekom met by uit hierdie daardie nie ' +
  'moet sal wil asb asseblief please').split(/\s+/));

// Both directions are added at load time. Keep to app words people actually type.
const SYNONYMS = [
  ['oortyd', 'overtime'], ['korttyd', 'shorttime', 'short'], ['salaris', 'salary', 'basic', 'basies'],
  ['payslip', 'betaalstrokie', 'salarisstrokie', 'strokie'], ['item', 'items', 'itemme', 'toelae', 'allowance', 'aftrekking', 'deduction'],
  ['werknemer', 'employee', 'werknemers', 'employees', 'personeel', 'staff'], ['finaliseer', 'finalize', 'finalise', 'finalisering', 'sluit', 'lock'],
  ['omkeer', 'reverse', 'reversal', 'ontsluit', 'unlock'], ['belasting', 'tax', 'paye'], ['bonus', 'dertiende', '13th'],
  ['verlof', 'leave'], ['bank', 'eft', 'banklêer', 'bankfile'], ['verhoging', 'increase', 'raise'], ['agterstallig', 'backpay', 'back'],
  ['motor', 'car', 'vehicle', 'voertuig'], ['pensioen', 'pension', 'voorsorg', 'provident', 'aftree', 'retirement'],
  ['mediese', 'medical', 'medies'], ['bywoning', 'attendance', 'ure', 'hours'], ['verslag', 'report', 'verslae', 'reports'],
  ['irp5', 'emp501', 'emp201', 'sars'], ['maand', 'month', 'maande', 'months', 'periode', 'period'], ['uitvoer', 'execute', 'run', 'loop', 'hardloop'], ['nuwe', 'new', 'byvoeg', 'add', 'voeg', 'sit', 'put']
];
const SYN = new Map();
SYNONYMS.forEach(group => group.forEach(w => SYN.set(w, group)));

function stem(w) {
  return w.replace(/(ings|ing|es|s|e)$/,'');
}

/** Words of a text, lower-case, accents removed, stop words dropped (pure). */
function words(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));
}

/** Each question word with its synonyms (stemmed) — one group per word. */
function expandEach(ws) {
  return [...new Set(ws)].map(w => new Set([stem(w)].concat((SYN.get(w) || []).map(stem))));
}

/**
 * Rank articles for a question (pure).
 * @param articles [{ slug, title, body, tags }] in one language (fallback rows allowed)
 * @returns [{ slug, score }] best first, only those above the threshold
 */
function rank(articles, question, { limit = 3, threshold = 1.5 } = {}) {
  const q = expandEach(words(question));
  if (!q.length) return [];
  return (articles || []).map(a => {
    const title = new Set(words(a.title).map(stem));
    const tags = new Set(words((a.tags || []).join(' ')).map(stem));
    const body = new Set(words(a.body).map(stem));
    // Each question word counts once: the best place one of its forms appears.
    let score = 0;
    q.forEach(forms => {
      let best = 0;
      forms.forEach(f => { best = Math.max(best, title.has(f) ? 3 : tags.has(f) ? 2 : body.has(f) ? 0.75 : 0); });
      score += best;
    });
    return { slug: a.slug, score: Math.round((score / Math.sqrt(q.length)) * 1000) / 1000 };
  }).filter(r => r.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Group rows into articles { slug, af, en, status, version, screen_url, screen_name, tags } (pure). */
function groupArticles(rows) {
  const by = {};
  (rows || []).forEach(r => {
    const a = by[r.slug] || (by[r.slug] = { slug: r.slug, status: r.status, version: r.version, screen_url: r.source_url,
      screen_name: r.source_section, tags: r.tags || [], approved_at: r.approved_at, updated_at: r.updated_at });
    a[String(r.language || 'EN').toLowerCase()] = { id: r.id, title: r.title, body: r.content, status: r.status };
    if (r.status === 'DRAFT') a.status = 'DRAFT';     // a pending edit shows as draft
  });
  return Object.values(by).sort((x, y) => x.slug.localeCompare(y.slug));
}

module.exports = { APPS, words, rank, groupArticles, SYNONYMS };
