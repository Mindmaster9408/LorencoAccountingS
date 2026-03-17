/**
 * ============================================================================
 * Nedbank PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from Nedbank Online Banking.
 *
 * Layout (separate Debit / Credit columns):
 *   Date        Description              Debit       Credit      Balance
 *   01/01/2026  Opening Balance                                  5 000.00
 *   02/01/2026  PAYMENT RECEIVED                    5 000.00   10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM      235.00                  9 765.00
 *
 * Date format: DD/MM/YYYY (1 or 2 digit day/month)
 * Uses separate Debit / Credit columns; balance always last.
 * Some Nedbank exports use a single signed amount column with DR/Cr suffix.
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

const DATE_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;

// Layout A: debit/credit columns separated by 2+ spaces
const RE_DEBIT_CREDIT = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([\d\s,]+\.\d{2}|)\s{2,}([\d\s,]+\.\d{2}|)\s{2,}([\d\s,]+\.\d{2})\s*$/;

// Layout B: up to 3 numbers (debit + credit + balance, or amount + balance, or just balance)
const RE_LOOSE = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([\d\s,]+\.\d{2})(?:\s{2,}([\d\s,]+\.\d{2}))?(?:\s{2,}([\d\s,]+\.\d{2}))?\s*$/;

// Layout C: signed amount + balance (some Nedbank Online exports)
const RE_SIGNED = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2}\s*(?:[Dd][Rr]?|[Cc][Rr])?)\s{2,}(R?\s*[\d\s,]+\.\d{2})\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];

const CREDIT_KEYWORDS = /\b(received|deposit|credit|salary|transfer\s+in|payment\s+from|refund)\b/i;

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
    // Nedbank branch codes start with 19
    if (/branch\s*code\s*[:\s]+19\d{4}/i.test(text)) { score += 0.2; details.branchCode = true; }

    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename = '') {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const rawLines = this.toLines(text);
    const lines = this.joinContinuationLines(rawLines, l => DATE_RE.test(l));

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!DATE_RE.test(line))    continue;

      const lower = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lower.includes(k))) { result.skippedLines++; continue; }

      const txn = this._parseLine(line);
      if (!txn) { result.skippedLines++; continue; }

      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Skipped (${warns.join(', ')}): ${line.slice(0, 80)}`);
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted from this Nedbank statement. The statement may use an unsupported layout variant.');
    }

    return result;
  }

  static _parseLine(line) {
    // Try debit/credit column layout (most definitive)
    let m = line.match(RE_DEBIT_CREDIT);
    if (m) {
      const date      = this.parseDate(m[1]);
      const desc      = m[2].trim();
      const debitStr  = m[3].trim();
      const creditStr = m[4].trim();
      const bal       = this.parseAmount(m[5]);
      if (!date) return null;

      let amount = null;
      if (creditStr) {
        const c = this.parseAmount(creditStr);
        if (c !== null && c !== 0) amount = Math.abs(c);
      }
      if (amount === null && debitStr) {
        const d = this.parseAmount(debitStr);
        if (d !== null && d !== 0) amount = -Math.abs(d);
      }
      if (amount === null) return null;
      return { date, description: desc, reference: null, amount, balance: bal, rawLine: line };
    }

    // Signed amount + balance (DR/Cr suffix handled by parseAmount)
    m = line.match(RE_SIGNED);
    if (m) {
      const date   = this.parseDate(m[1]);
      const desc   = m[2].trim();
      const amount = this.parseAmount(m[3]);
      const bal    = this.parseAmount(m[4]);
      if (date && amount !== null) return { date, description: desc, reference: null, amount, balance: bal, rawLine: line };
    }

    // Loose: 1-3 numbers
    m = line.match(RE_LOOSE);
    if (m) {
      const date = this.parseDate(m[1]);
      const desc = m[2].trim();
      if (!date) return null;
      const nums = [m[3], m[4], m[5]].filter(Boolean).map(n => this.parseAmount(n));

      if (nums.length === 3) {
        // debit + credit + balance
        const [debit, credit, bal] = nums;
        if (credit > 0) return { date, description: desc, reference: null, amount: Math.abs(credit), balance: bal, rawLine: line };
        if (debit  > 0) return { date, description: desc, reference: null, amount: -Math.abs(debit), balance: bal, rawLine: line };
      } else if (nums.length === 2) {
        const [first, bal] = nums;
        if (first === null) return null;
        const isCredit = CREDIT_KEYWORDS.test(desc);
        return { date, description: desc, reference: null, amount: isCredit ? Math.abs(first) : -Math.abs(first), balance: bal, rawLine: line };
      }
      // Single number — ambiguous, skip
    }

    return null;
  }
}

module.exports = NedbankParser;
