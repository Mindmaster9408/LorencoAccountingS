/**
 * ============================================================================
 * Paytime Sean Chat — Recipe Parser
 * ============================================================================
 * Deterministic, bilingual (Afrikaans/English) pattern matching for chat-
 * driven payroll requests. Explicitly NOT an LLM call — same approach as
 * backend/sean/calculations.js's parseCalculationRequest() and
 * backend/sean/decision-engine.js's classifyIntent() cascade, applied to a
 * new domain (payroll actions instead of tax calculations).
 *
 * Employee-name resolution is deliberately NOT done here — this module only
 * extracts candidate name words from the raw text. Matching those against
 * the real employee list for the target company happens in routes.js, which
 * has DB access; guessing a name via regex alone would be unreliable and
 * unsafe for a feature that writes real payroll data.
 * ============================================================================
 */

'use strict';

const RECIPES = ['ADD_OVERTIME', 'ADD_SHORT_TIME', 'ADD_PAYSLIP_ITEM', 'ADJUST_SALARY'];

// Words that are structural to a request (recipe keywords, units, connectors)
// rather than part of an employee's name — stripped out before candidate
// name words are returned, so "gee Jan 5 ure oortyd" leaves just "jan".
const STOP_WORDS = new Set([
  'gee', 'give', 'sit', 'add', 'vir', 'for', 'aan', 'to', 'die', 'the', 'a', 'an',
  'ure', 'uur', 'hours', 'hour', 'hrs', 'hr',
  'oortyd', 'overtime', 'kort', 'korttyd', 'tyd', 'short', 'time',
  'bonus', 'toelaag', 'allowance', 'aftrekking', 'deduction', 'trek', 'af', 'deduct',
  'salaris', 'salary', 'basiese', 'basic', 'stel', 'set', 'verander', 'change', 'adjust', 'pas', 'aan',
  'met', 'with', 'van', 'of', 'na', 'this', 'hierdie', 'maand', 'month',
]);

const HOURS_RE = /(\d+(?:[.,]\d+)?)\s*(?:ure|uur|hours?|hrs?)\b/i;
const MONEY_RE = /r\s*(\d[\d\s,]*(?:\.\d{2})?)|(\d[\d\s,]*(?:\.\d{2})?)\s*rand/i;
const BARE_NUMBER_RE = /(\d[\d\s,]*(?:\.\d{2})?)/;

function extractHours(text) {
  const m = text.match(HOURS_RE);
  if (!m) return undefined;
  return parseFloat(m[1].replace(',', '.'));
}

function extractAmount(text) {
  const m = text.match(MONEY_RE);
  const raw = m ? (m[1] || m[2]) : null;
  if (raw) return parseFloat(raw.replace(/[\s,]/g, ''));
  const bare = text.match(BARE_NUMBER_RE);
  return bare ? parseFloat(bare[1].replace(/[\s,]/g, '')) : undefined;
}

/**
 * Extracts candidate employee-name words: original-case tokens from the raw
 * text, minus stop words and any pure-number tokens. Caller (routes.js)
 * matches these against the real employee list for the target company.
 */
function extractNameCandidates(rawText) {
  return rawText
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 1)
    .filter(w => !/^\d+$/.test(w))          // pure numbers
    .filter(w => !/^r\d[\d.,]*$/i.test(w))  // money like "R2000"/"R500.50"
    .filter(w => !STOP_WORDS.has(w.toLowerCase()));
}

/**
 * Parses a chat message into a recipe + slots. Returns null recipe (with
 * no slots) if nothing matched — callers must show "didn't understand"
 * rather than guessing.
 */
function parseRecipeRequest(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { recipe: null, slots: {}, nameCandidates: [] };
  }

  const t = rawText.toLowerCase();
  const nameCandidates = extractNameCandidates(rawText);

  // Short-time before overtime: "kort tyd" contains no overlap with "oortyd",
  // but check both explicitly rather than relying on substring order luck.
  const isShortTime = /\bkort\s*tyd\b|\bkorttyd\b|\bshort[\s-]?time\b/.test(t);
  const isOvertime  = /\boortyd\b|\bovertime\b/.test(t);
  const isSalary    = /\bsalaris\b|\bsalary\b|\bbasiese\s+salaris\b|\bbasic\s+salary\b/.test(t);
  // "trek ... af" doesn't require adjacency — "trek R500 af by Jan" must still match.
  const isDeduction = /\baftrekking\b|\bdeduction\b|\bdeduct\b/.test(t)
    || (/\btrek\b/.test(t) && /\baf\b/.test(t));
  const isEarningItem = /\bbonus\b|\btoelaag\b|\ballowance\b|\bbyvoeging\b/.test(t);

  if (isShortTime) {
    return {
      recipe: 'ADD_SHORT_TIME',
      slots: { hours: extractHours(t), description: 'Short time' },
      nameCandidates,
    };
  }

  if (isOvertime) {
    return {
      recipe: 'ADD_OVERTIME',
      slots: { hours: extractHours(t), description: 'Overtime' },
      nameCandidates,
    };
  }

  if (isSalary) {
    return {
      recipe: 'ADJUST_SALARY',
      slots: { amount: extractAmount(t) },
      nameCandidates,
    };
  }

  if (isDeduction || isEarningItem) {
    return {
      recipe: 'ADD_PAYSLIP_ITEM',
      slots: {
        amount: extractAmount(t),
        itemType: isDeduction ? 'deduction' : 'earning',
        description: isDeduction ? 'Deduction' : 'Bonus',
      },
      nameCandidates,
    };
  }

  return { recipe: null, slots: {}, nameCandidates };
}

module.exports = { parseRecipeRequest, RECIPES };
