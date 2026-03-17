/**
 * ============================================================================
 * Nedbank PDF Statement Parser
 * ============================================================================
 * Date format: DD/MM/YYYY. Debit/Credit columns.
 *
 * Parsing strategy: right-side amount scanning (see absa-parser.js).
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

const DATE_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];

const CREDIT_RE = /\b(?:received|deposit|salary|credit|transfer\s+in|payment\s+from|refund|reversal)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|fee|charge|levy)\b/i;

class NedbankParser extends BaseParser {

  static get PARSER_ID() { return 'nedbank-v1'; }
  static get BANK_NAME() { return 'Nedbank'; }

  static canParse(text, filename = '') {
    if (/nedbank|nedgroup/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};
    if (header.includes('nedbank'))  { score += 0.6; details.name = true; }
    if (header.includes('nedgroup')) { score += 0.2; details.nedgroup = true; }
    if (/branch\s*code\s*[:\s]+19\d{4}/i.test(text)) { score += 0.2; details.branchCode = true; }
    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename = '') {
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
      result.warnings.push('No transactions extracted from this Nedbank statement. The statement may use an unsupported layout variant.');
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

  static _sign(amt, desc) {
    if (DEBIT_RE.test(desc))  return -Math.abs(amt);
    if (CREDIT_RE.test(desc)) return  Math.abs(amt);
    return Math.abs(amt);
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

module.exports = NedbankParser;
