/**
 * ============================================================================
 * Capitec Bank PDF Statement Parser
 * ============================================================================
 * 1. Date format: YYYY-MM-DD (ISO). Single signed amount.
 *    Parsing strategy: right-side amount scanning (see absa-parser.js).
 *
 * 2. Capitec Business "Date | Description | Reference | Amount (or Money in /
 *    Money out) | Fees | Balance" — both the PDF statement and the
 *    "Transaction History" export. A transaction is a block: dated line,
 *    description lines, then "amount[fee]balance" (sometimes amount and
 *    balance on separate lines, sometimes across a page break). Debits and
 *    fees carry "-". See _parseBusiness().
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// ── Capitec Business layout ─────────────────────────────────────────────────
const BIZ_HEADER_RE = /^date\s*description\s*reference\s*(?:money\s*in\s*money\s*out|amount)\s*fees\*?\s*balance$/i;
const BIZ_DATE_RE   = /^(\d{2})\/(\d{2})\/(\d{4})/;
const BIZ_AMT       = '\\d{1,3}(?:[ ,]\\d{3})*\\.\\d{2}';
// Amount, fee and balance can each sit on their own line ("-300.00 -1.00 60,702.10" once joined)
const BIZ_WITH_FEE_RE = new RegExp(`^(.*?)(-?${BIZ_AMT}) ?(-${BIZ_AMT}) ?(-?${BIZ_AMT})$`);
const BIZ_NO_FEE_RE   = new RegExp(`^(.*?)(-?${BIZ_AMT}) ?(-?${BIZ_AMT})$`);
// Page furniture: a start marker switches noise on until the table resumes
const BIZ_NOISE_START_RE = [/^24hr\s+business\s+banking/i, /^page\s+\d+$/i, /^transaction\s+history$/i];
const BIZ_NOISE_END_RE   = [BIZ_HEADER_RE, /^unique\s+document\s+no/i];
const BIZ_NOISE_LINE_RE  = [
  /^capitec\s+(?:business\s+)?bank\s+(?:limited\s+)?is\s+an\s+authorised/i,
  /bancs\s+digital$/i, /^balance\s+brought\s+forward/i, /^\d{1,3}$/,
];
const BIZ_TABLE_END_RE   = /^total-?\d/i;
const BIZ_MAX_BLOCK_LINES = 14;

const DATE_ISO_RE  = /^\d{4}-\d{2}-\d{2}/;
// Prefer 4-digit year first (prevents DD/MM/25 matching as DD/MM/2 with 2-digit group)
const DATE_DDMM_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})/;
const DATE_RE = new RegExp(`^(?:${DATE_ISO_RE.source}|${DATE_DDMM_RE.source})`);

// [+-]? captures explicit + prefix on credits/balances (e.g. +2 900.00, +35 835.25)
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[+-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'fee total', 'vat total'
];

const CREDIT_RE = /\b(?:received|deposit|salary|credit|transfer\s+in|payment\s+from|refund|reversal|cashback)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|fee|charge|levy)\b/i;

class CapitecParser extends BaseParser {

  static get PARSER_ID() { return 'capitec-v1'; }
  static get BANK_NAME() { return 'Capitec'; }

  static canParse(text, filename = '') {
    if (/capitec/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};
    if (header.includes('capitec bank'))  { score += 0.7; details.fullName = true; }
    else if (header.includes('capitec')) { score += 0.5;  details.name = true; }
    if (/450105|470010/.test(text))      { score += 0.2;  details.branchCode = true; }
    const isoCount = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length;
    if (isoCount > 3) { score += 0.15; details.dateFormat = 'YYYY-MM-DD'; }
    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename = '') {
    if (this.toLines(text).some(l => BIZ_HEADER_RE.test(l))) return this._parseBusiness(text);

    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    // Summary footer lines (Fee Total, VAT Total) must be treated as line-starts
    // so joinContinuationLines does NOT append them to the preceding transaction.
    const SUMMARY_LINE_RE = /\b(?:fee|vat)\s+total\b/i;
    const isStart = l => DATE_RE.test(l) || SUMMARY_LINE_RE.test(l);
    const lines = this.joinContinuationLines(this.toLines(text), isStart);
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
      result.warnings.push('No transactions extracted from this Capitec statement. The statement may use an unsupported layout variant.');
    }
    return result;
  }

  static _parseLine(line, prevBalance) {
    // Prefer 4-digit year to avoid DD/MM/25 matching as DD/MM/2 (2-digit year)
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))/);
    if (!dateMatch) return null;
    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;
    let rest = line.slice(dateMatch[0].length).trim();

    // Handle dual-date columns (Capitec Business Account: Post Date + Trans. Date).
    // If rest begins with another DD/MM/YY date, strip it and use as the
    // transaction date (Trans. Date is more accurate than Post Date for accounting).
    let txnDate = date;
    const secondDateMatch = rest.match(/^(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))\s+/);
    if (secondDateMatch) {
      const parsed2 = this.parseDate(secondDateMatch[1]);
      if (parsed2) txnDate = parsed2;
      rest = rest.slice(secondDateMatch[0].length);
    }

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
    // The second-to-last token is always the Amount column value.
    // For rows with a Fees column (3+ tokens), Amount = tokens[-2], Fee = tokens[-3].
    // For rows without a Fees column (2 tokens), Amount = tokens[-2] (same rule).
    const rawAmt = tokens[tokens.length - 2].value;

    // Real Capitec Business statements embed explicit signs (+/-).
    // Trust parseAmount result directly; fall back to balance delta for unsigned values.
    let amount = rawAmt;
    if (rawAmt > 0 && prevBalance !== null) {
      const delta = balance - prevBalance;
      if (Math.abs(Math.abs(delta) - Math.abs(rawAmt)) < 0.02) {
        amount = delta >= 0 ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      }
    } else if (rawAmt > 0) {
      if (DEBIT_RE.test(description))  amount = -Math.abs(rawAmt);
      if (CREDIT_RE.test(description)) amount =  Math.abs(rawAmt);
    }

    return { date: txnDate, description, reference: null, amount, balance, rawLine: line };
  }

  // ── Capitec Business layout ─────────────────────────────────────────────────

  static _parseBusiness(text) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    const acct = text.match(/account\s+number\s*:?\s*(\d{8,})/i);
    result.accountNumber = acct ? acct[1] : this.extractAccountNumber(text);

    const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const longDate = s => {
      const m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
      return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
    };
    const p1 = text.match(/statement\s+period\s*-\s*(\d{1,2} [A-Za-z]+ \d{4})\s*(\d{1,2} [A-Za-z]+ \d{4})/i);
    const p2 = text.match(/transaction\s+from\s+(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (p1) result.statementPeriod = { from: longDate(p1[1]), to: longDate(p1[2]) };
    else if (p2) result.statementPeriod = { from: this.parseDate(p2[1]), to: this.parseDate(p2[2]) };

    const num = s => Number(s.replace(/[ ,]/g, ''));
    const round = v => Math.round(v * 100) / 100;

    const open = text.match(new RegExp(`(?:opening\\s+balance\\s*R?|balance\\s+brought\\s+forward\\s*:)\\s*(-?${BIZ_AMT})`, 'i'));
    let prevBalance = open ? num(open[1]) : null;

    // 1. Strip page furniture and group lines into dated blocks
    const blocks = [];
    let noise = false;
    let block = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (BIZ_TABLE_END_RE.test(line)) break;
      if (BIZ_NOISE_END_RE.some(re => re.test(line))) { noise = false; continue; }
      if (BIZ_NOISE_START_RE.some(re => re.test(line))) { noise = true; continue; }
      if (noise || !line || BIZ_NOISE_LINE_RE.some(re => re.test(line))) continue;
      if (BIZ_DATE_RE.test(line)) { block = [line]; blocks.push(block); continue; }
      if (block && block.length < BIZ_MAX_BLOCK_LINES) block.push(line);
    }

    // 2. Read the amounts: try "amount fee balance" and "amount balance";
    //    keep the reading that continues the running balance. A reference
    //    number glued to the amount ("PosSettle 251024" + "48.94") is
    //    recovered from the balance delta.
    const read = (body) => {
      const cands = [];
      const w = body.match(BIZ_WITH_FEE_RE);
      if (w) cands.push({ desc: w[1], amtStr: w[2], money: num(w[2]), fee: num(w[3]), balance: num(w[4]) });
      const n = body.match(BIZ_NO_FEE_RE);
      if (n) cands.push({ desc: n[1], amtStr: n[2], money: num(n[2]), fee: 0, balance: num(n[3]) });
      if (cands.length === 0) return null;
      if (prevBalance !== null) {
        const exact = cands.find(c => Math.abs(prevBalance + c.money + c.fee - c.balance) < 0.005);
        if (exact) return exact;
        for (const c of cands) {
          const want = round(c.balance - prevBalance - c.fee);
          const wantStr = Math.abs(want).toFixed(2);
          const digits = c.amtStr.replace(/[- ,]/g, '');
          if ((want < 0) === c.amtStr.startsWith('-') && digits !== wantStr && digits.endsWith(wantStr)) {
            return { ...c, desc: c.desc + digits.slice(0, digits.length - wantStr.length), money: want };
          }
        }
      }
      return cands[0];
    };

    for (const b of blocks) {
      const dm = b[0].match(BIZ_DATE_RE);
      const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
      // Add lines until the amounts are found. A partial read can look valid
      // ("-300.00-1.00" read as amount/balance before the real balance line),
      // so prefer the first reading that continues the running balance.
      let parsed = null;
      for (let n = 1; n <= b.length; n++) {
        const r = read([b[0].slice(dm[0].length), ...b.slice(1, n)].join(' ').replace(/\s+/g, ' ').trim());
        if (!r) continue;
        if (!parsed) parsed = r;
        if (prevBalance !== null && Math.abs(prevBalance + r.money + r.fee - r.balance) < 0.005) { parsed = r; break; }
      }
      if (!parsed) {
        // A dated block without amounts is the wrapped second description row of
        // the previous transaction ("21/09/2024***** 4016… DNR Potch Mooirivier")
        const last = result.transactions[result.transactions.length - 1];
        if (last && last.date === date) {
          last.description = `${last.description} ${b.join(' ').slice(dm[0].length)}`.replace(/\s+/g, ' ').trim();
          continue;
        }
        result.skippedLines++;
        result.warnings.push(`[skip] No amount/balance found: ${b.join(' | ').slice(0, 120)}`);
        continue;
      }
      const description = parsed.desc.replace(/\s+/g, ' ').trim() || 'Capitec transaction';

      if (prevBalance !== null && Math.abs(prevBalance + parsed.money + parsed.fee - parsed.balance) > 0.005) {
        result.warnings.push(
          `Balance check failed on ${date} "${description.slice(0, 60)}": ` +
          `${prevBalance.toFixed(2)} + ${round(parsed.money + parsed.fee).toFixed(2)} ≠ ${parsed.balance.toFixed(2)} — a line may have been misread.`
        );
      }
      const rawLine = b.join(' | ');
      if (parsed.money !== 0) {
        result.transactions.push({ date, description, reference: null, amount: parsed.money,
          balance: round(parsed.balance - parsed.fee), rawLine });
      }
      if (parsed.fee !== 0) {
        result.transactions.push({ date, description: `Fee: ${description}`, reference: null, amount: parsed.fee,
          balance: parsed.balance, rawLine });
      }
      prevBalance = parsed.balance;
    }

    const closing = text.match(new RegExp(`closing\\s+balance\\s*R?\\s*(-?${BIZ_AMT})`, 'i'))
      || text.match(new RegExp(`^total-?${BIZ_AMT}-?${BIZ_AMT}(-?${BIZ_AMT})$`, 'im'));
    if (closing && prevBalance !== null && Math.abs(num(closing[1]) - prevBalance) > 0.005) {
      result.warnings.push(
        `Closing balance on statement is ${num(closing[1]).toFixed(2)} but the last imported line shows ${prevBalance.toFixed(2)} — a line may have been missed.`
      );
    }
    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted from this Capitec statement. The statement may use an unsupported layout variant.');
    }
    return result;
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

module.exports = CapitecParser;
