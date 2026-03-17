/**
 * ============================================================================
 * Capitec Bank PDF Statement Parser
 * ============================================================================
 * Date format: YYYY-MM-DD (ISO). Single signed amount.
 *
 * Parsing strategy: right-side amount scanning (see absa-parser.js).
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

const DATE_ISO_RE  = /^\d{4}-\d{2}-\d{2}/;
const DATE_DDMM_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;
const DATE_RE = new RegExp(`^(?:${DATE_ISO_RE.source}|${DATE_DDMM_RE.source})`);

const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal', 'service fee'
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
    if (/470010/.test(text))             { score += 0.2;  details.branchCode = true; }
    const isoCount = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length;
    if (isoCount > 3) { score += 0.15; details.dateFormat = 'YYYY-MM-DD'; }
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
      result.warnings.push('No transactions extracted from this Capitec statement. The statement may use an unsupported layout variant.');
    }
    return result;
  }

  static _parseLine(line, prevBalance) {
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))/);
    if (!dateMatch) return null;
    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;
    const rest = line.slice(dateMatch[0].length).trim();

    AMT_TOKEN_RE.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = AMT_TOKEN_RE.exec(rest)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) tokens.push({ raw: m[0].trim(), value: v, start: m.index });
    }
    if (tokens.length < 2) return null;

    const description = rest.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description) return null;

    const balance = tokens[tokens.length - 1].value;
    // Capitec uses single signed amount — the second-to-last IS the signed amount
    const rawAmt = tokens[tokens.length - 2].value;

    // Capitec's own PDFs already embed the sign (-235.00 for debits)
    // so we trust parseAmount result directly; fall back to balance delta
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

    return { date, description, reference: null, amount, balance, rawLine: line };
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
