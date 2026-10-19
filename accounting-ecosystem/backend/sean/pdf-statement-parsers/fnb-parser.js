/**
 * ============================================================================
 * FNB (First National Bank) PDF Statement Parser
 * ============================================================================
 * 1. FNB single signed amount column. Date format: DD/MM/YYYY.
 *    Parsing strategy: right-side amount scanning (see absa-parser.js).
 *    pdf-parse collapses column spacing, so we scan for all X.XX tokens
 *    and resolve sign via DR/Cr suffix, balance delta, or keywords.
 *
 * 2. Business statement "Transactions in RAND (ZAR)" (e.g. Gold Business):
 *    "DD Mon<description><amount>[Cr]<balance>[Cr|Dr][<accrued charge>]"
 *      - amount without suffix = debit, "Cr" = credit
 *      - balance "Cr" = in credit, no suffix / "Dr" = overdrawn
 *      - accrued bank charge after the balance does not move the balance
 *      - no year on the date — taken from "Statement Period : … to …"
 *      - a line can be split: "30 Nov" / "Fees" / "5.0040.39Cr"
 *    See _parseBusiness().
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// ── Business "Transactions in RAND" layout ──────────────────────────────────
const BIZ_LAYOUT_RE   = /transactions\s+in\s+rand/i;
const BIZ_PERIOD_RE   = /statement\s+period\s*:\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})\s+to\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i;
const BIZ_DATE_RE     = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?![a-z])/;
const BIZ_AMT         = '(\\d{1,3}(?:,\\d{3})*\\.\\d{2})';
// amount[Cr] balance[Cr|Dr] [accrued charge] — with and without the charge
const BIZ_WITH_CHARGE_RE = new RegExp(`^(.*?)${BIZ_AMT}(Cr)?${BIZ_AMT}(Cr|Dr)?${BIZ_AMT}$`);
const BIZ_NO_CHARGE_RE   = new RegExp(`^(.*?)${BIZ_AMT}(Cr)?${BIZ_AMT}(Cr|Dr)?$`);
const BIZ_TABLE_END_RE   = /^(?:closing\s+balance|turnover\s+for\s+statement)/i;
const BIZ_MAX_BLOCK_LINES = 4;
const BIZ_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const DATE_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;

// Amount token — decimal-pointed numbers only (not integer reference numbers)
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'subtotal', 'sub-total', 'total fees',
  'interest charged', 'total interest', 'service fee'
];

const CREDIT_RE = /\b(?:received|deposit|salary|credit|payment\s+from|transfer\s+in|proceeds|refund|reversal|cashback)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|levy|fee|charge)\b/i;

class FNBParser extends BaseParser {

  static get PARSER_ID() { return 'fnb-v1'; }
  static get BANK_NAME() { return 'FNB'; }

  static canParse(text, filename = '') {
    if (/fnb|first.?national/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};
    if (header.includes('first national bank')) { score += 0.6; details.bankName = true; }
    if (header.includes('fnb'))                 { score += 0.15; details.fnbAbbr = true; }
    if (header.includes('firstrand'))           { score += 0.2;  details.firstrand = true; }
    if (/branch\s*code\s*[:\s]+25[012]\d{3}/i.test(text)) { score += 0.1; details.branchCode = true; }
    // Business statements carry the bank name only in the footer
    if (score < 0.6 && /first\s+national\s+bank\s*-\s*a\s+division\s+of\s+firstrand/i.test(text)) {
      score += 0.6; details.footerName = true;
    }
    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename = '') {
    if (BIZ_LAYOUT_RE.test(text) && BIZ_PERIOD_RE.test(text)) return this._parseBusiness(text);

    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const lines = this.joinContinuationLines(this.toLines(text), l => DATE_RE.test(l));
    let prevBalance = null;

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!DATE_RE.test(line))    continue;

      const lower = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lower.includes(k))) {
        const bal = this._lastAmt(line);
        if (bal !== null) prevBalance = bal;
        result.skippedLines++;
        continue;
      }

      const txn = this._parseLine(line, prevBalance);
      if (!txn) { result.skippedLines++; continue; }
      if (txn.balance !== null) prevBalance = txn.balance;

      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Skipped (${warns.join(', ')}): ${line.slice(0, 100)}`);
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted from this FNB statement. The statement may use an unsupported FNB layout variant.');
    }
    return result;
  }

  static _parseLine(line, prevBalance) {
    const dateMatch = line.match(/^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))/);
    if (!dateMatch) return null;
    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;
    const rest = line.slice(dateMatch[0].length).trim();

    AMT_TOKEN_RE.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = AMT_TOKEN_RE.exec(rest)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) tokens.push({ raw: m[0].trim(), value: v, start: m.index, end: m.index + m[0].length });
    }
    if (tokens.length < 2) return null;

    let description = rest.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description) return null;
    const afterLast = rest.slice(tokens[tokens.length - 1].end).trim();
    if (afterLast) description = (description + ' ' + afterLast).trim();

    const balance = tokens[tokens.length - 1].value;
    const rawAmt  = tokens[tokens.length - 2].value;
    const rawTok  = tokens[tokens.length - 2].raw;

    let amount;
    const hasSuffix = /[Dd][Rr]?|[Cc][Rr]/i.test(rawTok);
    const hasMinus  = rawTok.startsWith('-') || rawTok.startsWith('(');

    if (hasSuffix || hasMinus) {
      amount = rawAmt;
    } else if (prevBalance !== null) {
      const delta = balance - prevBalance;
      if (Math.abs(Math.abs(delta) - Math.abs(rawAmt)) < 0.02) {
        amount = delta >= 0 ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      } else {
        amount = this._sign(rawAmt, description);
      }
    } else {
      amount = this._sign(rawAmt, description);
    }

    return { date, description, reference: null, amount, balance, rawLine: line };
  }

  // ── Business "Transactions in RAND" layout ──────────────────────────────────

  static _parseBusiness(text) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    const acct = text.match(/account\s*:\s*(\d{9,})/i);
    result.accountNumber = acct ? acct[1] : this.extractAccountNumber(text);

    const p = text.match(BIZ_PERIOD_RE);
    const iso = (d, mon, y) => {
      const mo = BIZ_MONTHS[mon.slice(0, 3).toLowerCase()];
      return mo ? `${y}-${String(mo).padStart(2, '0')}-${d.padStart(2, '0')}` : null;
    };
    result.statementPeriod = { from: iso(p[1], p[2], p[3]), to: iso(p[4], p[5], p[6]) };
    const toY = parseInt(p[6], 10);
    const toM = BIZ_MONTHS[p[5].slice(0, 3).toLowerCase()];
    const toD = parseInt(p[4], 10);

    const num = s => Number(s.replace(/,/g, ''));
    const balOf = (digits, suffix) => (suffix === 'Cr' ? num(digits) : -num(digits));

    // Summary block prints "5,761.38 Cr" (with a space); the table prints "5,761.38Cr"
    const opening = text.match(/opening\s+balance\s*(\d{1,3}(?:,\d{3})*\.\d{2})\s*(Cr|Dr)?/i);
    let prevBalance = opening ? balOf(opening[1], opening[2]) : null;

    // Collect dated blocks inside the transaction table(s)
    const blocks = [];
    let inTable = false;
    let block = null;
    for (const line of this.toLines(text)) {
      if (BIZ_LAYOUT_RE.test(line)) { inTable = true; block = null; continue; }
      if (!inTable) continue;
      if (BIZ_TABLE_END_RE.test(line)) { inTable = false; block = null; continue; }
      if (BIZ_DATE_RE.test(line)) { block = [line]; blocks.push(block); continue; }
      if (block && block.length < BIZ_MAX_BLOCK_LINES) block.push(line);
    }

    // Read one block: try "with charge" and "without charge" readings and keep
    // the one that continues the running balance. A card/reference number
    // glued to the amount ("…75742550.00") is recovered from the balance delta.
    const read = (body) => {
      const candidates = [];
      for (const [re, hasCharge] of [[BIZ_NO_CHARGE_RE, false], [BIZ_WITH_CHARGE_RE, true]]) {
        const m = body.match(re);
        if (!m) continue;
        candidates.push({
          desc: m[1], amtStr: m[2], amount: m[3] === 'Cr' ? num(m[2]) : -num(m[2]),
          balance: balOf(m[4], m[5]), balSuffix: !!m[5], charge: hasCharge ? num(m[6]) : null
        });
      }
      if (candidates.length === 0) return null;
      if (prevBalance !== null) {
        const exact = candidates.find(c => Math.abs(prevBalance + c.amount - c.balance) < 0.005);
        if (exact) return exact;
        for (const c of candidates) {
          const delta = Math.round((c.balance - prevBalance) * 100) / 100;
          const want = Math.abs(delta).toFixed(2);
          const digits = c.amtStr.replace(/,/g, '');
          if ((delta < 0) === (c.amount < 0) && digits !== want && digits.endsWith(want)) {
            return { ...c, desc: c.desc + digits.slice(0, digits.length - want.length), amount: delta };
          }
        }
      }
      return candidates.find(c => c.balSuffix && c.charge === null) || candidates[0];
    };

    let infoLines = 0;
    for (const b of blocks) {
      const dm = b[0].match(BIZ_DATE_RE);
      // Join progressively: the amounts may sit 1–2 lines below the date
      let parsed = null;
      let used = 0;
      for (let n = 1; n <= b.length && !parsed; n++) {
        const body = [b[0].slice(dm[0].length), ...b.slice(1, n)].join(' ').replace(/\s+/g, ' ').trim();
        parsed = read(body);
        used = n;
      }
      if (!parsed) {
        result.skippedLines++;
        result.warnings.push(`[skip] No amount/balance found: ${b.join(' | ').slice(0, 120)}`);
        continue;
      }
      if (parsed.amount === 0) { infoLines++; prevBalance = parsed.balance; continue; }

      const mm = BIZ_MONTHS[dm[2].toLowerCase()];
      const dd = parseInt(dm[1], 10);
      const year = (mm > toM || (mm === toM && dd > toD)) ? toY - 1 : toY;
      const date = `${year}-${String(mm).padStart(2, '0')}-${dm[1]}`;
      const description = parsed.desc.replace(/\s+/g, ' ').trim() || 'Bank charges';

      if (prevBalance !== null && Math.abs(prevBalance + parsed.amount - parsed.balance) > 0.005) {
        result.warnings.push(
          `Balance check failed on ${date} "${description.slice(0, 60)}": ` +
          `${prevBalance.toFixed(2)} + ${parsed.amount.toFixed(2)} ≠ ${parsed.balance.toFixed(2)} — a line may have been misread.`
        );
      }
      prevBalance = parsed.balance;
      result.transactions.push({
        date, description, reference: null, amount: parsed.amount, balance: parsed.balance,
        rawLine: b.slice(0, used).join(' | ')
      });
    }

    if (infoLines > 0) {
      result.warnings.push(`${infoLines} information line(s) with a zero amount (e.g. interest-rate notices) not imported.`);
    }
    const closing = text.match(/closing\s+balance\s*(\d{1,3}(?:,\d{3})*\.\d{2})\s*(Cr|Dr)?/i);
    if (closing && prevBalance !== null) {
      const c = balOf(closing[1], closing[2]);
      if (Math.abs(c - prevBalance) > 0.005) {
        result.warnings.push(
          `Closing balance on statement is ${c.toFixed(2)} but the last imported line shows ${prevBalance.toFixed(2)} — a line may have been missed.`
        );
      }
    }
    return result;
  }

  static _sign(amt, desc) {
    if (DEBIT_RE.test(desc))  return -Math.abs(amt);
    if (CREDIT_RE.test(desc)) return  Math.abs(amt);
    // FNB amounts can be signed already in the PDF — if rawAmt is negative, keep it
    return amt;
  }

  static _lastAmt(line) {
    AMT_TOKEN_RE.lastIndex = 0;
    let last = null;
    let m;
    while ((m = AMT_TOKEN_RE.exec(line)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) last = v;
    }
    return last;
  }
}

module.exports = FNBParser;
