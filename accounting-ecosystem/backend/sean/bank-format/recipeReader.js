/**
 * ============================================================================
 * Bank statement FORMAT recipes — reader (pure functions, no I/O)
 * ============================================================================
 * Ruan 2026-11-13: when a statement in a new format is uploaded, Sean (the
 * local Ollama model) works out the format, and Leo remembers it.
 *
 * A recipe describes a FORMAT, never transactions:
 *   { date_format, thousands_separator, decimal_separator,
 *     negative_balance_marker, opening_balance_label, closing_balance_label }
 *
 * The balance chain is the judge. A row is VERIFIED only when an amount
 * printed in the row (or amount + fee) equals the change in the printed
 * balance. Nothing is derived from the chain alone:
 *   - a date line that changes nothing and is followed by a row that
 *     verifies against the same balance is skipped as noise (headers);
 *   - anything else that does not verify is returned as UNVERIFIED, so a
 *     person checks it — never silently accepted.
 * ============================================================================
 */

'use strict';

const MONTHS = { jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };

const DATE_RES = {
  'DD/MM/YYYY': /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/,
  'DD/MM/YY': /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2})(?!\d)/,
  'YYYY/MM/DD': /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})/,
  'DD MMM YYYY': /^(\d{1,2}) ?([A-Za-z]{3})[a-z]* ?(\d{4})/,
  'DD MMM YY': /^(\d{1,2}) ?([A-Za-z]{3})[a-z]* ?(\d{2})(?!\d)/,
  'DD MMM': /^(\d{1,2}) ?([A-Za-z]{3})(?![a-z])/,
};
const DATE_FORMATS = Object.keys(DATE_RES);

const near = (a, b) => Math.abs(a - b) < 0.005;
const round2 = n => Math.round(n * 100) / 100;

// ── Recipe hygiene ───────────────────────────────────────────────────────────

/**
 * Keep only known fields with safe values. Labels are letters/spaces only
 * (max 40) so no amounts, account numbers or dates can be stored — a recipe
 * may become global and must never carry a client's data.
 */
function sanitizeRecipe(raw) {
  const r = raw || {};
  const label = v => String(v || '').replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
  const neg = String(r.negative_balance_marker || '').toUpperCase();
  return {
    date_format: pick(r.date_format, DATE_FORMATS, 'DD/MM/YYYY'),
    thousands_separator: pick(r.thousands_separator, [',', ' ', ''], ','),
    decimal_separator: pick(r.decimal_separator, ['.', ','], '.'),
    negative_balance_marker: neg === 'DR' ? 'DR' : neg === '-' ? '-' : 'none',
    opening_balance_label: label(r.opening_balance_label),
    closing_balance_label: label(r.closing_balance_label),
  };
}

function sanitizeBankName(v) {
  return String(v || '').replace(/[^A-Za-z&' .\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function parseDateAtStart(line, fmt, endYear, today) {
  const m = line.match(DATE_RES[fmt]);
  if (!m) return null;
  let y, mo, d;
  if (fmt === 'YYYY/MM/DD') { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (fmt.startsWith('DD/MM')) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = m[3] ? +m[3] : null; if (!mo) return null; }
  if (y !== null && y < 100) y += 2000;
  if (y === null) {
    y = endYear;
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe > new Date(today.getTime() + 86400000)) y -= 1;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(dt) || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { iso: dt.toISOString().slice(0, 10), rest: line.slice(m[0].length) };
}

function moneyRe(recipe) {
  const t = recipe.thousands_separator;
  const th = t === ',' ? '(?:,\\d{3})*' : t === ' ' ? '(?: \\d{3})*' : '';
  const dec = recipe.decimal_separator === ',' ? ',' : '\\.';
  // No look-ahead after the 2 decimals: PDF text often glues columns
  // together ("17,659.462,985,566.97CR" = 17,659.46 | 2,985,566.97 CR).
  return new RegExp(`(-)?(\\d{1,3}${th}|\\d+)${dec}(\\d{2})\\s?(CR|DR|Cr|Dr|cr|dr|-)?`, 'g');
}

function moneyTokens(text, recipe) {
  const re = moneyRe(recipe);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[2].replace(/[ ,]/g, '') + '.' + m[3]);
    const suffix = (m[4] || '').toUpperCase();
    const neg = !!m[1]
      || (suffix === 'DR' && recipe.negative_balance_marker === 'DR')
      || (suffix === '-' && recipe.negative_balance_marker === '-');
    out.push({ abs: n, signed: neg ? -n : n });
  }
  return out;
}

/** Does a printed amount (or amount + fee) explain the move from prev to some printed balance? */
function verify(prev, toks) {
  if (prev === null) return null;
  for (let bi = toks.length - 1; bi >= 0; bi--) {
    const diff = round2(toks[bi].signed - prev);
    if (near(diff, 0)) continue;
    const want = Math.abs(diff);
    if (toks.some((t, i) => i !== bi && near(t.abs, want))) return { amount: diff, balance: toks[bi].signed };
    // Amount + fee printed in separate columns: keep them as two rows so the
    // fee can be allocated to bank charges on its own.
    for (let i = 0; i < bi; i++) {
      for (let j = i + 1; j < bi; j++) {
        if (!near(toks[i].abs + toks[j].abs, want)) continue;
        const sign = diff < 0 ? -1 : 1;
        return { amount: diff, balance: toks[bi].signed, split: [sign * toks[i].abs, sign * toks[j].abs] };
      }
    }
  }
  return null;
}

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * @param {string} text   statement text (pdf-parse, preprocessed)
 * @param {object} recipe sanitized recipe
 * @returns {{ rows, opening, closing, unverified, skipped, closingOk }}
 *   rows: { date, description, amount, balance, verified }
 */
function readWithRecipe(text, recipe, opts = {}) {
  const today = opts.today || new Date();
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const years = (String(text).match(/\b20\d{2}\b/g) || []).map(Number).filter(y => y <= today.getUTCFullYear() + 1);
  const endYear = years.length ? Math.max(...years) : today.getUTCFullYear();
  const openLbl = (recipe.opening_balance_label || '').toLowerCase();
  const closeLbl = (recipe.closing_balance_label || '').toLowerCase();

  let opening = null, closing = null;
  const records = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (openLbl && low.includes(openLbl)) {
      const t = moneyTokens(line, recipe);
      if (t.length && opening === null) opening = t[t.length - 1].signed;
      continue;
    }
    if (closeLbl && low.includes(closeLbl)) {
      const t = moneyTokens(line, recipe);
      if (t.length) closing = t[t.length - 1].signed;
      continue;
    }
    const d = parseDateAtStart(line, recipe.date_format, endYear, today);
    if (d) {
      let rest = d.rest;
      const second = parseDateAtStart(rest.trim(), recipe.date_format, endYear, today); // glued value date
      if (second) rest = second.rest;
      records.push({ date: d.iso, parts: [rest] });
    } else if (records.length) {
      records[records.length - 1].parts.push(line);
    }
  }

  const re = moneyRe(recipe);
  const describe = r => r.parts.join(' ').replace(re, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const toksOf = r => r.parts.flatMap(p => moneyTokens(p, recipe));

  const rows = [];
  let prev = opening, unverified = 0, skipped = 0;
  for (let i = 0; i < records.length; i++) {
    const toks = toksOf(records[i]);
    if (!toks.length) { skipped++; continue; }
    const found = verify(prev, toks);
    if (found) {
      const desc = describe(records[i]);
      if (found.split) {
        const [main, fee] = found.split;
        rows.push({ date: records[i].date, description: desc, amount: main, balance: round2(prev + main), verified: true });
        rows.push({ date: records[i].date, description: ('Fee: ' + desc).slice(0, 200), amount: fee, balance: found.balance, verified: true });
      } else {
        rows.push({ date: records[i].date, description: desc, amount: found.amount, balance: found.balance, verified: true });
      }
      prev = found.balance;
      continue;
    }
    // Noise? (e.g. a header line that starts with a date) — the next row still
    // verifies against the SAME balance, so this line moved no money.
    const next = records[i + 1] ? verify(prev, toksOf(records[i + 1])) : null;
    if (next && prev !== null) { skipped++; continue; }
    if (toks.length < 2) { skipped++; continue; }
    const bal = toks[toks.length - 1].signed;
    const amount = prev === null ? toks[toks.length - 2].signed : round2(bal - prev);
    rows.push({ date: records[i].date, description: describe(records[i]), amount, balance: bal, verified: false });
    unverified++;
    prev = bal;
  }
  const last = rows.length ? rows[rows.length - 1].balance : null;
  return { rows, opening, closing, unverified, skipped, closingOk: closing !== null && last !== null && near(closing, last) };
}

/** Score used to compare recipes on the same statement (higher = better). */
function score(res) {
  const ok = res.rows.filter(r => r.verified).length;
  return ok - res.unverified * 2 + (res.closingOk ? 5 : 0);
}

/**
 * Good enough to import with: at least 2 verified rows (1 when the statement
 * has a single row and its closing balance agrees), at most 10% unverified
 * (rounded down — a short statement must reconcile fully), and the closing
 * balance agrees when one is printed. Strict on purpose: on a short
 * statement a wrong recipe can verify a row by coincidence.
 */
function acceptable(res) {
  const ok = res.rows.filter(r => r.verified).length;
  const minOk = res.rows.length === 1 && res.closingOk ? 1 : 2;
  if (ok < minOk) return false;
  if (res.unverified > Math.floor(res.rows.length * 0.1)) return false;
  return res.closing === null || res.closingOk;
}

/**
 * Try the recipe plus small variations (thousands separator, date format) and
 * keep the one the balance chain likes best. Small slips by the model are
 * fixed here instead of trusting it.
 */
function bestVariant(text, recipe, opts) {
  const base = sanitizeRecipe(recipe);
  let best = { recipe: base, res: readWithRecipe(text, base, opts) };
  for (const th of [',', ' ', '']) {
    for (const df of DATE_FORMATS) {
      if (th === base.thousands_separator && df === base.date_format) continue;
      const v = { ...base, thousands_separator: th, date_format: df };
      const res = readWithRecipe(text, v, opts);
      if (score(res) > score(best.res)) best = { recipe: v, res };
    }
  }
  return best;
}

/**
 * Balance check for rows from ANY parser: do consecutive balances agree with
 * the amounts? Used to decide whether an unknown statement needs learning.
 */
function chainCheck(rows) {
  let pairs = 0, ok = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.balance === null || a.balance === undefined || b.balance === null || b.balance === undefined) continue;
    pairs++;
    if (near(round2(a.balance + b.amount), b.balance)) ok++;
  }
  return { pairs, ok, reconciles: pairs > 0 && ok === pairs };
}

/** A short sample of the statement for the model: header + first transaction block. */
function sampleOf(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  const first = lines.findIndex(l => /^\d{1,4}[ /.\-]?([A-Za-z]{3}|\d{1,2})/.test(l.trim()) && /\d[.,]\d{2}/.test(l));
  const head = lines.slice(0, 25);
  const body = first >= 0 ? lines.slice(Math.max(0, first - 5), first + 45) : lines.slice(25, 90);
  return [...head, '...', ...body].join('\n').slice(0, 5000);
}

module.exports = {
  DATE_FORMATS, sanitizeRecipe, sanitizeBankName, readWithRecipe, bestVariant,
  acceptable, score, chainCheck, sampleOf, moneyTokens,
};
