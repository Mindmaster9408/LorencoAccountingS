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
