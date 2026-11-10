/**
 * ============================================================================
 * Slips — slip text parser (pure functions, no I/O)
 * ============================================================================
 * Turns OCR text of a till slip / invoice into SUGGESTED fields, each with a
 * confidence ('high' | 'medium' | 'low') and the reason it was chosen, plus
 * self-checks (do VAT, payment and total agree with each other?).
 *
 * Built for till slips (short lines, TOTAL / CASH / CARD / CHANGE / VAT 15%),
 * which the Leo supplier-invoice parser (sean/invoice-ocr-service.js) was not
 * designed for. Tolerates common OCR mistakes in numbers (O→0, l→1, S→5).
 *
 * Nothing here is ever "truth": a person confirms every field before saving.
 * ============================================================================
 */

'use strict';

const DEFAULT_VAT_RATE = 0.15; // ZA standard rate; caller may pass another

// ── Amounts ──────────────────────────────────────────────────────────────────

// Fix OCR letter/digit confusions inside a token that is otherwise numeric.
function fixDigits(token) {
  return token
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[S]/g, '5')
    .replace(/[B]/g, '8');
}

// 1 234.50 | 1,234.50 | 1234,50 | 450.00 | R450.00 | -12.00
const AMOUNT_RE = /-?\d{1,3}(?:[ ,]\d{3})+[.,]\d{2}(?![\d])|-?\d+[.,]\d{2}(?![\d])/g;

function toNumber(raw) {
  let s = raw.replace(/\s/g, '');
  // last separator is the decimal one
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  s = s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + s.slice(lastSep + 1);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** All money amounts on one line, left to right. */
function amountsInLine(line) {
  // Repair numeric-looking tokens before matching (e.g. "45O.OO" → "450.00").
  const repaired = line.replace(/\b[\dOoIlSB|][\dOoIlSB|,.]*[.,][\dOoIlSB|]{2}\b/g, m =>
    (/\d/.test(m) ? fixDigits(m) : m));
  const out = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(repaired)) !== null) {
    const n = toNumber(m[0]);
    if (n !== null) out.push(n);
  }
  return out;
}

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// ── Line classification ──────────────────────────────────────────────────────

const RE_TOTAL = /\b(grand\s*total|total\s*(due|payable|amount|incl?\.?\s*(vat|tax|btw)?)|amount\s*(due|payable)|balance\s*(due)?|to\s*pay|te\s*betaal|totaal|total|bedrag)\b/i;
const RE_NOT_TOTAL = /\b(sub\s*-?\s*tota(l|al)|total\s*(vat|tax|btw|savings?|saved|discount|items?|qty|quantity|excl?\.?|ex\b|points?)|vat\s*total|tax\s*total|savings?|you\s*saved|items?\s*sold|no\s*of\s*items|points|available\s*bal(ance)?|bal(ance)?\s*(b\/?f|brought|available))\b/i;
const RE_TENDER = /\b(cash|card|tendered|debit|credit|visa|master\s*card|mastercard|paid|eft|speedpoint|snapscan|zapper|kontant|kaart)\b/i;
const RE_CHANGE = /\b(change|kleingeld|wisselgeld)\b/i;
const RE_VAT_LINE = /\b(vat|tax|btw)\b/i;
const RE_VAT_NOT_AMOUNT = /\b(vatable|excl?\.?|exempt|zero|no\.?|nr\.?|number|reg)\b/i;
const RE_EXCL_LINE = /\b(vatable|excl?\.?\s*(vat|tax|btw)|total\s*excl?)\b/i;

// ── Field extractors ─────────────────────────────────────────────────────────

function findTotal(lines) {
  const candidates = [];
  lines.forEach((line, i) => {
    if (!RE_TOTAL.test(line) || RE_NOT_TOTAL.test(line)) return;
    const amounts = amountsInLine(line);
    if (!amounts.length) {
      // "TOTAL" alone, amount on the next line
      const next = lines[i + 1] ? amountsInLine(lines[i + 1]) : [];
      if (next.length && !RE_TOTAL.test(lines[i + 1])) candidates.push({ value: next[next.length - 1], line: i, strong: false });
      return;
    }
    const strong = /\b(grand\s*total|total\s*(due|payable|incl)|amount\s*due|balance\s*due|to\s*pay|te\s*betaal)\b/i.test(line);
    candidates.push({ value: amounts[amounts.length - 1], line: i, strong });
  });

  // Payment evidence: tendered - change, or a card line amount.
  const tenders = [];
  let change = null;
  lines.forEach(line => {
    const amounts = amountsInLine(line);
    if (!amounts.length) return;
    if (RE_CHANGE.test(line)) change = amounts[amounts.length - 1];
    else if (RE_TENDER.test(line) && !RE_TOTAL.test(line)) tenders.push(amounts[amounts.length - 1]);
  });
  const paid = [];
  for (const t of tenders) {
    paid.push(t);
    if (change !== null && change >= 0) paid.push(Math.round((t - change) * 100) / 100);
  }

  for (const c of candidates) {
    c.confirmedByPayment = paid.some(p => near(p, c.value));
  }

  if (candidates.length) {
    // Best: confirmed by payment; then strong label; then the last plain TOTAL.
    const ranked = candidates.slice().sort((a, b) =>
      (b.confirmedByPayment - a.confirmedByPayment) || (b.strong - a.strong) || (b.line - a.line));
    const best = ranked[0];
    const distinct = new Set(candidates.map(c => c.value)).size;
    let confidence = best.confirmedByPayment ? 'high' : (distinct === 1 ? 'medium' : 'low');
    if (best.value <= 0) confidence = 'low';
    return {
      value: best.value,
      confidence,
      reason: best.confirmedByPayment ? 'TOTAL line matches the payment on the slip' : 'TOTAL line',
      paymentEvidence: paid,
    };
  }

  // No TOTAL label: amount paid (tendered - change) is the next best evidence.
  if (change !== null && tenders.length) {
    const v = Math.round((tenders[0] - change) * 100) / 100;
    if (v > 0) return { value: v, confidence: 'medium', reason: 'amount tendered minus change', paymentEvidence: paid };
  }
  if (tenders.length === 1 && tenders[0] > 0) {
    return { value: tenders[0], confidence: 'low', reason: 'payment line', paymentEvidence: paid };
  }
  return null;
}

function findVat(lines, total, vatRate) {
  const expected = total ? Math.round((total * vatRate / (1 + vatRate)) * 100) / 100 : null;
  let fallback = null;
  for (const line of lines) {
    if (!RE_VAT_LINE.test(line)) continue;
    if (RE_VAT_NOT_AMOUNT.test(line) && !/\bvat\s*\d{1,2}\s*%/i.test(line)) continue;
    if (/\b4\d{9}\b/.test(line)) continue; // VAT registration number line
    const amounts = amountsInLine(line).filter(a => a >= 0 && (!total || a < total));
    for (const a of amounts.reverse()) {
      if (expected !== null && near(a, expected, 0.05)) {
        return { value: a, confidence: 'high', reason: `matches ${Math.round(vatRate * 100)}% of the total` };
      }
      if (!fallback) fallback = a;
    }
  }
  // Derive from an "excl. VAT / vatable" amount when there's no VAT line.
  if (total) {
    for (const line of lines) {
      if (!RE_EXCL_LINE.test(line)) continue;
      const excl = amountsInLine(line).filter(a => a > 0 && a < total).pop();
      if (excl !== undefined) {
        const v = Math.round((total - excl) * 100) / 100;
        if (expected !== null && near(v, expected, 0.05)) {
          return { value: v, confidence: 'high', reason: 'total minus the amount excl. VAT' };
        }
      }
    }
  }
  // VAT line read unclearly (e.g. "117.39" → "T1039"): accept the expected
  // VAT only when the smudged digits differ from it by at most one character.
  if (expected !== null && expected > 0) {
    const want = expected.toFixed(2).replace('.', '');
    for (const line of lines) {
      if (!RE_VAT_LINE.test(line) || /\b4\d{9}\b/.test(line) || RE_EXCL_LINE.test(line)) continue;
      const tokens = line.replace(/\d{1,2}\s*%/g, ' ').split(/\s+/).filter(t => /[\dOoDQIlT|SsBZzGA]{3,}/.test(t));
      const last = tokens[tokens.length - 1];
      if (!last) continue;
      const digits = smudgedDigits(last);
      if (digits.length >= want.length - 1 && editDistance(digits, want) <= 1) {
        return { value: expected, confidence: 'medium', reason: `VAT read unclearly, but matches ${Math.round(vatRate * 100)}% of the total — check` };
      }
    }
  }
  if (fallback !== null) return { value: fallback, confidence: 'low', reason: 'VAT line (does not match the total — check)' };
  return null;
}

const SMUDGE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', T: '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', A: '4' };
function smudgedDigits(token) {
  return token.split('').map(c => (/\d/.test(c) ? c : (SMUDGE[c] || ''))).join('');
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function findVatNumber(lines) {
  const labelled = /\b(?:vat|btw|tax)\s*(?:reg(?:istration)?\.?\s*)?(?:no|nr|num(?:ber)?|#)?\.?\s*[:.]?\s*(4[\dOoIlS]{9})\b/i;
  for (const line of lines) {
    const m = line.match(labelled);
    if (m) {
      const v = fixDigits(m[1]);
      if (/^4\d{9}$/.test(v)) return { value: v, confidence: 'high', reason: 'labelled VAT number' };
    }
  }
  for (const line of lines) {
    if (/\*{2,}|card|acc(oun)?t|tel|phone|fax|cell/i.test(line)) continue;
    const m = line.match(/(?<![\d])4\d{9}(?![\d])/);
    if (m) return { value: m[0], confidence: 'low', reason: '10-digit number starting with 4' };
  }
  return null;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
};

function isoOrNull(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function findDate(lines, today) {
  const todayIso = (today || new Date()).toISOString().slice(0, 10);
  const maxIso = new Date(Date.parse(todayIso) + 86400000).toISOString().slice(0, 10);
  const found = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
    const labelled = /\b(date|datum)\b/i.test(line);
    let m;
    const ymd = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
    while ((m = ymd.exec(line))) found.push({ iso: isoOrNull(+m[1], +m[2], +m[3]), i, labelled });
    const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g;
    while ((m = dmy.exec(line))) {
      // South African order is day/month; only flip when day/month is impossible otherwise.
      let d = +m[1], mo = +m[2];
      if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
      found.push({ iso: isoOrNull(+m[3], mo, d), i, labelled });
    }
    const dMonY = /\b(\d{1,2})[\s\-.]*([A-Za-z]{3,9})[\s\-.,]*(\d{4}|\d{2})\b/g;
    while ((m = dMonY.exec(line))) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
      if (mo) found.push({ iso: isoOrNull(+m[3], mo, +m[1]), i, labelled });
    }
    const monDY = /\b([A-Za-z]{3,9})[\s.]+(\d{1,2}),?\s+(\d{4})\b/g;
    while ((m = monDY.exec(line))) {
      const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
      if (mo) found.push({ iso: isoOrNull(+m[3], mo, +m[2]), i, labelled });
    }
  });
  const valid = found.filter(f => f.iso && f.iso >= '2000-01-01' && f.iso <= maxIso);
  if (!valid.length) return null;
  valid.sort((a, b) => (b.labelled - a.labelled) || (a.i - b.i));
  const best = valid[0];
  const ageDays = (Date.parse(todayIso) - Date.parse(best.iso)) / 86400000;
  return {
    value: best.iso,
    confidence: ageDays <= 400 ? (best.labelled || valid.every(v => v.iso === best.iso) ? 'high' : 'medium') : 'low',
    reason: ageDays > 400 ? 'date is more than a year ago — check' : (best.labelled ? 'labelled date' : 'date on slip'),
  };
}

const RE_NOT_SUPPLIER = /(tax\s*invoice|invoice|receipt|slip|welcome|thank|vat|btw|tel|phone|fax|cell|www|http|@|reg\b|reg\.|street|\bstr\b|road|\brd\b|p\.?\s*o\.?\s*box|branch|store\s*no|till|cashier|operator|date|time|\d{3,})/i;

// Texture at the edge of a photo (table, shadow) comes out as e.g.
// "BN Eee mmesSTEET": mostly tiny "words" and case flipping inside a word.
function looksLikeOcrNoise(line) {
  const words = line.split(' ').filter(w => /[A-Za-z]/.test(w));
  const short = words.filter(w => w.replace(/[^A-Za-z]/g, '').length <= 3).length;
  if (words.length >= 2 && short / words.length > 0.5) return true;
  return words.some(w => /[a-z][A-Z]/.test(w) && !/^(Mc|Mac)[A-Z]/.test(w));
}

function findSupplier(lines) {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.replace(/[^A-Za-z0-9&'().,\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 3 || RE_NOT_SUPPLIER.test(line)) continue;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || letters / line.length < 0.6) continue;
    if (looksLikeOcrNoise(line)) continue;
    return { value: line.slice(0, 60), confidence: 'low', reason: 'name at the top of the slip' };
  }
  return null;
}

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * @param {string} text   OCR text
 * @param {object} [opts] { vatRate = 0.15, today = new Date() }
 * @returns {{ fields: object, checks: object[], score: number, needsReview: boolean }}
 */
function parseSlipText(text, opts = {}) {
  const vatRate = opts.vatRate ?? DEFAULT_VAT_RATE;
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const total = findTotal(lines);
  const vat = findVat(lines, total && total.value, vatRate);
  const vatNumber = findVatNumber(lines);
  const date = findDate(lines, opts.today);
  const supplier = findSupplier(lines);

  const fields = {};
  if (total) fields.amount = { value: total.value, confidence: total.confidence, source: 'ocr', reason: total.reason };
  if (vat) fields.vat_amount = { value: vat.value, confidence: vat.confidence, source: 'ocr', reason: vat.reason };
  if (vatNumber) fields.supplier_vat_number = { value: vatNumber.value, confidence: vatNumber.confidence, source: 'ocr', reason: vatNumber.reason };
  if (date) fields.slip_date = { value: date.value, confidence: date.confidence, source: 'ocr', reason: date.reason };
  if (supplier) fields.supplier_name = { value: supplier.value, confidence: supplier.confidence, source: 'ocr', reason: supplier.reason };

  const checks = buildChecks(fields, vatRate, total);
  return { fields, checks, score: scoreFields(fields), needsReview: needsReview(fields), lines };
}

function buildChecks(fields, vatRate, total) {
  const checks = [];
  checks.push(fields.amount
    ? { key: 'total_found', ok: true, message: 'Total found' }
    : { key: 'total_found', ok: false, message: 'Could not find the total' });
  if (fields.amount && total && total.paymentEvidence && total.paymentEvidence.length) {
    const ok = total.paymentEvidence.some(p => near(p, fields.amount.value));
    checks.push({ key: 'payment_matches_total', ok, message: ok ? 'Payment on the slip matches the total' : 'Payment on the slip does not match the total — check' });
  }
  if (fields.amount && fields.vat_amount) {
    const expected = fields.amount.value * vatRate / (1 + vatRate);
    const ok = near(fields.vat_amount.value, expected, 0.05);
    checks.push({ key: 'vat_matches_total', ok, message: ok ? `VAT is ${Math.round(vatRate * 100)}% of the total` : 'VAT does not match the total — check' });
  }
  if (fields.slip_date) {
    checks.push({ key: 'date_valid', ok: fields.slip_date.confidence !== 'low', message: fields.slip_date.confidence !== 'low' ? 'Date looks right' : fields.slip_date.reason });
  }
  return checks;
}

const CONF_POINTS = { high: 3, medium: 2, low: 1 };

function scoreFields(fields) {
  let s = 0;
  if (fields.amount) s += CONF_POINTS[fields.amount.confidence] * 2;
  if (fields.slip_date) s += CONF_POINTS[fields.slip_date.confidence];
  if (fields.vat_amount) s += CONF_POINTS[fields.vat_amount.confidence];
  if (fields.supplier_vat_number) s += CONF_POINTS[fields.supplier_vat_number.confidence] / 2;
  if (fields.supplier_name) s += 0.5;
  return s;
}

/** OCR got the essentials with confidence — no need for more OCR passes. */
function ocrGoodEnough(fields) {
  return !!fields.amount && fields.amount.confidence === 'high'
    && !!fields.slip_date && fields.slip_date.confidence !== 'low';
}

function needsReview(fields) {
  return !fields.amount || fields.amount.confidence !== 'high'
    || !fields.slip_date || fields.slip_date.confidence === 'low'
    || !fields.supplier_name || fields.supplier_name.confidence === 'low';
}

module.exports = { parseSlipText, amountsInLine, toNumber, scoreFields, needsReview, ocrGoodEnough, buildChecks, DEFAULT_VAT_RATE };
