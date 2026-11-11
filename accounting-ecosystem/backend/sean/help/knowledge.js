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

// bot = the assistant's name the local AI uses in its prompt (Pip for Paytime).
const APPS = {
  paytime: { domain: 'PAYTIME_HELP', module: 'payroll',    name: 'Paytime',    bot: 'Pip' },
  leo:     { domain: 'LEO_HELP',     module: 'accounting', name: 'Ledger Leo', bot: 'Leo' }   // 2026-11-11
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
  ['irp5', 'it3a', 'sertifikaat', 'certificate', 'certificates'], ['maand', 'month', 'maande', 'months', 'periode', 'period'], ['uitvoer', 'execute', 'run', 'loop', 'hardloop'], ['nuwe', 'new', 'byvoeg', 'add', 'voeg', 'sit', 'put'],
  // Ledger Leo (2026-11-11)
  ['faktuur', 'fakture', 'invoice', 'invoices'], ['kwotasie', 'kwotasies', 'quote', 'quotes', 'quotation', 'estimate'],
  ['kredietnota', 'krediet', 'credit', 'creditnote'],
  ['klient', 'kliente', 'customer', 'customers', 'debiteur', 'debiteure', 'debtor', 'debtors'],
  ['verskaffer', 'verskaffers', 'supplier', 'suppliers', 'krediteur', 'krediteure', 'creditor', 'creditors', 'vendor'],
  ['joernaal', 'joernale', 'journal', 'journals'], ['btw', 'vat', 'vat201'],
  ['rekeningplan', 'chart', 'grootboek', 'ledger', 'gl'], ['bankstaat', 'statement', 'statements', 'state'],
  ['rekonsiliasie', 'rekonsilieer', 'reconciliation', 'reconcile', 'recon'], ['toeken', 'toekenning', 'allocate', 'allocation', 'allokeer'],
  ['ontvangs', 'ontvangste', 'receipt', 'receipts'], ['produk', 'produkte', 'product', 'products', 'diens', 'dienste', 'service', 'services'],
  ['wins', 'verlies', 'profit', 'loss', 'inkomstestaat'], ['balansstaat', 'balance'], ['proefbalans', 'trial'],
  ['ouderdom', 'aged', 'ageing', 'aging', 'uitstaande', 'outstanding'], ['openingsaldo', 'opening', 'openingsaldos'],
  ['import', 'oplaai', 'upload'], ['epos', 'email', 'stuur', 'send']
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

// ─── language of a question (Ruan 2026-11-11: no AF/EN switch — answer in the language asked) ───
// Common words that only (or mostly) occur in one of the two languages. Words both share
// ("is", "my", "in", "op"/"of" lookalikes) are left out so they never tip the balance.
const AF_WORDS = new Set(('hoe wat waar hoekom wanneer watter ek jy julle ons hulle nie die n \'n van vir sit kry moet sal kan ' +
  'wil gaan doen maak werk werknemer werknemers salaris betaal betaling maand maande oortyd korttyd verander byvoeg bygevoeg ' +
  'en om te het word deur hierdie daardie asseblief dankie ure loon belasting jaar skerm knoppie bladsy hulp beëindig dit').split(/\s+/));
const EN_WORDS = new Set(('how what where why when which i you we they not the a an of for put get should will can could ' +
  'want go do does did make work employee employees salary pay payment month months overtime change add added ' +
  'and to have has by this that please thanks hours wage tax year screen button page help terminate it').split(/\s+/));
// "kan" (af) vs "can" (en), "werk" vs "work" etc. are distinct spellings, so a plain lookup is enough.

/**
 * 'AF' or 'EN' for a question, or `fallback` when it cannot tell (e.g. one word like "payslip").
 */
function detectLanguage(text, fallback = 'EN') {
  const toks = String(text || '').toLowerCase().replace(/[’`]/g, "'").match(/'n|[a-zëêéèôûîï']+/g) || [];
  let af = 0, en = 0;
  for (const t of toks) { if (AF_WORDS.has(t)) af++; if (EN_WORDS.has(t)) en++; }
  if (af > en) return 'AF';
  if (en > af) return 'EN';
  return fallback === 'AF' ? 'AF' : 'EN';
}

// ─── advice questions (Ruan 2026-11-11) ──────────────────────────────────────
// Pip is free and explains HOW THE APP WORKS. Questions asking for a tax/compliance
// judgement ("is X taxable?", "which IRP5 code?", "should I deduct UIF?") are the paid
// Sean AI add-on, so Pip must not try to answer them from a how-to article.
// "How do I set an item to 80% taxable?" is an app question and must NOT match here.
const TAX = '(tax|taxed|taxable|paye|uif|sdl|sars|irp5|it3a|vat|btw|deduct\\w*|exempt\\w*|belasting\\w*|belasbaar|aftrek\\w*|vrygestel\\w*)';
const ADVICE_PATTERNS = [
  // "is a cellphone allowance taxable?" / "is 'n selfoontoelae belasbaar?"
  /\b(is|are|was|word)\b[^?.!]{0,60}\b(taxable|non-taxable|tax[- ]?free|deductible|exempt|belasbaar|belastingvry|aftrekbaar|vrygestel)\b/,
  // "which IRP5 code must I use for commission?" / "watter kode gebruik ek vir …"
  /\b(which|what|watter|wat is die)\b[^?.!]{0,25}\b(irp5|sars|source|bron)?[- ]?(code|kode)s?\b/,
  // "how much tax/UIF …" / "hoeveel belasting …"
  new RegExp('\\b(how much|hoeveel)\\b[^?.!]{0,30}\\b' + TAX),
  // "should I / do I have to / am I allowed / moet ek / mag ek … (tax word)"
  new RegExp('\\b(should (i|we)|do (i|we) (have|need) to|must (i|we)|am i allowed|are we allowed|moet (ek|ons)|mag (ek|ons)|is ek verplig)\\b[^?.!]{0,80}\\b' + TAX),
  // legality / rules
  /\b(is (it|this|that) legal|is dit wettig|wat s[êe] (sars|die wet)|what does (sars|the law) say)\b/,
  /\b(sars|tax) (rule|rules|rate|rates|limit|limits|reël|reëls|tarief|perk)\b/,
  // Ledger Leo (2026-11-11): VAT / accounting judgement is advice too
  /\b(is|are|word)\b[^?.!]{0,60}\b(vatable|zero[- ]?rated|nulkoers\w*|btw[- ]?pligtig)\b/,
  /\b(can|may|kan|mag) (i|we|ek|ons) (claim|eis)\b[^?.!]{0,40}\b(vat|btw|input|insette?|expense|uitgawe)\b/,
  /\b(vat|btw) (rule|rules|rate|reël|reëls|tarief)\b/
];
// Questions that clearly ask where/how in the app stay app questions even with tax words.
const APP_HOWTO = /^\s*(how (do|can|to)|where (do|can|is)|hoe (sit|doen|kan|maak|voeg|stel|verander|kry|druk)|waar (sit|kry|is|stel|druk))\b/;

function isAdviceQuestion(text) {
  const q = String(text || '').toLowerCase().replace(/[’`]/g, "'");
  if (APP_HOWTO.test(q) && !/\b(taxable|belasbaar|deductible|aftrekbaar)\s*\?/.test(q)) return false;
  return ADVICE_PATTERNS.some(re => re.test(q));
}

module.exports = { APPS, words, rank, groupArticles, SYNONYMS, detectLanguage, isAdviceQuestion };
