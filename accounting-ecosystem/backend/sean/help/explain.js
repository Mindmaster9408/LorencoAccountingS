/**
 * ============================================================================
 * Help bots — "explain step by step" (Pip, Lenny) — Ruan 2026-11-17
 * ============================================================================
 * The first answer is always the approved article (no AI). Only when the client
 * asks further does the local AI explain THAT article in small, simple steps,
 * as a conversation. Four locks keep it to "how does the app work":
 *   1. tax/advice questions never reach the AI (knowledge.isAdviceQuestion)
 *   2. the AI only gets the matched approved article(s) + the conversation
 *   3. NOT_COVERED when the question is not about the article
 *   4. checkAnswer(): the server rejects any answer with numbers, codes, links
 *      or tax/advice words that are not in the article — the client then just
 *      keeps the article, and the answer goes to SEVCO for review.
 * Server-side prompt (the worker only passes `messages` to Ollama), so the
 * wording can change without touching the computer that runs the model.
 * ============================================================================
 */

'use strict';

const { APPS } = require('./knowledge');

const MAX_PER_THREAD = 12;      // follow-ups on one first question
const MAX_PER_COMPANY_HOUR = 40; // the model runs on one computer

const DEFAULT_MESSAGE = {
  AF: 'Verduidelik dit asseblief stap vir stap.',
  EN: 'Please explain this step by step.'
};

// Rules are always in English: the small local model follows English
// instructions far better (an Afrikaans prompt made it answer with only the
// closing sentence — trial 2026-11-17). The ANSWER language is set by LANG_LINE.
// The "tell me when you are there" line is added by the widget, not the model.
const PROMPT = [
  'You are {BOT}, the help assistant of Lorenco {APP}. The user read the help article below but does not fully understand it yet.',
  'Explain how to do it in {APP}, step by step, like a patient colleague sitting next to them.',
  'Rules:',
  '- Use ONLY what is in the article. Add nothing: no numbers, codes, percentages, links or rules that are not in the article.',
  '- Answer with short numbered steps (one action per step), in simple words. Always give the steps themselves.',
  '- Use the exact button and screen names from the article.',
  '- If the user says where they are or where they are stuck, start from the NEXT step after that point. Do not repeat steps they already did.',
  '- Do not give tax or accounting advice. If asked for that, say you cannot help with that and that they should ask their accountant.',
  '- {LANG_LINE}',
  '- If the question is not about this article at all, answer with just this one word: NOT_COVERED'
].join('\n');
const LANG_LINE = {
  AF: 'Write the answer in simple South African Afrikaans (not Dutch). Keep the button and screen names exactly as they are in the article.',
  EN: 'Write the answer in English.'
};

function articlesText(articles) {
  return (articles || []).map((a, i) => '### Article ' + (i + 1) + ': ' + a.title +
    (a.screen_name ? ' (screen: ' + a.screen_name + ')' : '') + '\n' + a.body).join('\n\n');
}

/**
 * The chat for Ollama: system (rules + article), the first question, the
 * earlier follow-ups that got an answer, and the new message.
 */
function buildExplainMessages({ app, language, articles, rootQuestion, history, message, atStep }) {
  const L = language === 'EN' ? 'EN' : 'AF';
  const cfg = APPS[app] || {};
  const system = PROMPT.split('{APP}').join(cfg.name || app).split('{BOT}').join(cfg.bot || 'Pip')
    .replace('{LANG_LINE}', LANG_LINE[L]) + '\n\n' + articlesText(articles);
  const shown = (L === 'EN' ? 'I showed you this help article: ' : 'Ek het vir jou hierdie hulpartikel gewys: ') +
    (articles || []).map(a => a.title).join('; ');
  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: String(rootQuestion || '').slice(0, 1000) },
    { role: 'assistant', content: shown }
  ];
  (history || []).slice(-6).forEach(h => {
    if (!h || !h.ai_answer) return;
    msgs.push({ role: 'user', content: String(h.question || '').slice(0, 1000) });
    msgs.push({ role: 'assistant', content: String(h.ai_answer).slice(0, 1500) });
  });
  let last = String(message || DEFAULT_MESSAGE[L]).slice(0, 1000);
  const n = parseInt(atStep, 10);
  if (n > 0) last += L === 'EN' ? ` (I have already done steps 1 to ${n} of the article.)` : ` (Ek het al stappe 1 tot ${n} van die artikel gedoen.)`;
  msgs.push({ role: 'user', content: last });
  return msgs;
}

// ─── lock 4: the answer check ────────────────────────────────────────────────

// Words that mean tax/compliance/advice. Allowed only when the article itself uses them.
const RISKY = [
  /\btaxable\b/, /\bnon-taxable\b/, /\btax[- ]?free\b/, /\bdeductible\b/, /\bexempt(ion)?\b/,
  /\bbelasbaar\b/, /\bbelastingvry\b/, /\baftrekbaar\b/, /\bvrygestel\w*/,
  /\bsars\b/, /\birp5\b/, /\bit3a\b/, /\bemp201\b/, /\bemp501\b/, /\bvat\b/, /\bbtw\b/,
  /\bfringe benefit/, /\bbyvoordeel/, /\bpenalt(y|ies)\b/, /\bboete\b/, /\blegal\b/, /\bwettig\b/,
  /\bi (would )?(recommend|advise)\b/, /\bek (beveel|raai)\b/, /\bjy behoort\b/, /\byou should claim\b/
];

const norm = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'");
// "1%" and "1" are different facts — keep the % sign in the key.
const numKey = (s) => s.replace(/\s/g, '').replace(/,/g, '.').replace(/\.$/, '');
const unlist = (t) => t.replace(/^\s*\d{1,2}[.)]\s/gm, ' ');

function numbersIn(text) {
  return (norm(text).match(/\d+(?:[.,]\d+)*\s?%?/g) || []).map(numKey);
}

/**
 * { ok: true } or { ok: false, reason }. Strict on purpose: a rejected answer
 * costs nothing (the client keeps the article); a wrong one costs trust.
 */
// Signs the small model drifted: echoing our own context line, or (Afrikaans
// answers) English chatter / Dutch words — trial 2026-11-17.
const ECHO = /(ek het vir jou hierdie hulpartikel gewys|i showed you this help article)/;
const AF_DRIFT = [/\blet's\b/, /\byou've\b/, /\bwhere you\b/, /\byou are\b/, /\bgeef\b/, /\bniet\b/, /\bhet is\b/, /\bu kunt\b/, /\balstublieft\b/, /\bdan kunt\b/,
  /\bnieuwe?\b/, /\bverzoek\w*/, /\bsysteem\b/, /\bwordt\b/, /\bworden\b/, /\bmaken\b/, /\bsla\b/, /\bvoegen\b/, /\bkunnen\b/];

function checkAnswer(answer, articles, language) {
  const a = norm(answer).trim();
  if (ECHO.test(a)) return { ok: false, reason: 'echoed context' };
  if (!a) return { ok: false, reason: 'empty' };
  // A real explanation has at least one step; "tell me when you are there" alone is not one.
  if (a.length < 40) return { ok: false, reason: 'too short' };
  if (a.length > 1500) return { ok: false, reason: 'too long' };
  const source = norm((articles || []).map(x => [x.title, x.screen_name, x.body].join('\n')).join('\n'));

  if (/https?:\/\/|www\./.test(a) && !/https?:\/\/|www\./.test(source)) return { ok: false, reason: 'link' };

  // Numbers: list markers ("1." at a line start) and step references ("step 2",
  // "stap 2") are fine; anything else (amounts, rates, %, hours, codes, dates)
  // must appear in the article.
  const stripped = unlist(a).replace(/\b(step|steps|stap|stappe)\s+\d{1,2}\b/g, ' ');
  const allowed = new Set(numbersIn(unlist(source)));
  for (const n of numbersIn(stripped)) {
    if (!allowed.has(n)) return { ok: false, reason: 'number not in article: ' + n };
  }

  for (const re of RISKY) {
    if (re.test(a) && !re.test(source)) return { ok: false, reason: 'advice word: ' + re.source };
  }
  if (language === 'AF') {
    for (const re of AF_DRIFT) {
      if (re.test(a) && !re.test(source)) return { ok: false, reason: 'language drift: ' + re.source };
    }
  }
  return { ok: true };
}

module.exports = { buildExplainMessages, checkAnswer, articlesText, DEFAULT_MESSAGE, MAX_PER_THREAD, MAX_PER_COMPANY_HOUR };
