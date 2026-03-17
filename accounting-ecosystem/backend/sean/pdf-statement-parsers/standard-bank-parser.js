/**
 * ============================================================================
 * Standard Bank PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from Standard Bank Online Banking.
 *
 * Layout (separate Debit / Credit columns):
 *   Date        Description              Debit       Credit      Balance
 *   2026/01/01  Opening Balance                                  5 000.00
 *   2026/01/02  PAYMENT RECEIVED                    5 000.00   10 000.00
 *   2026/01/05  DEBIT ORDER VODACOM      235.00                  9 765.00
 *
 * Standard Bank date format: YYYY/MM/DD (primary) or DD/MM/YYYY (some exports)
 * Uses separate Debit / Credit columns; balance always present.
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// YYYY/MM/DD (primary Standard Bank format)
const DATE_YYYYMMDD = /^\d{4}\/\d{2}\/\d{2}/;
// DD/MM/YYYY fallback (some Standard Bank business exports)
const DATE_DDMMYYYY = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;

const DATE_RE = new RegExp(`^(?:${DATE_YYYYMMDD.source}|${DATE_DDMMYYYY.source})`);

// Layout A: YYYY/MM/DD + desc + debit (opt) + credit (opt) + balance
// Columns separated by 2+ spaces; debit and credit may be absent
const RE_DEBIT_CREDIT = /^(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s{2,}([\d\s,]+\.\d{2}|)\s{2,}([\d\s,]+\.\d{2}|)\s{2,}([\d\s,]+\.\d{2})\s*$/;

// Layout B: YYYY/MM/DD + desc + one or two numbers
const RE_LOOSE = /^(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2})(?:\s{2,}(R?\s*[\d\s,]+\.\d{2}))?\s*$/;

// Layout C: DD/MM/YYYY fallback (same loose structure)
const RE_LOOSE_DD = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2})(?:\s{2,}(R?\s*[\d\s,]+\.\d{2}))?\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal', 'fees', 'service charge'
];

// Keywords that strongly suggest a credit (money in)
const CREDIT_KEYWORDS = /\b(payment\s+received|deposit|salary|credit|transfer\s+in|proceeds|refund|reversal\s+credit)\b/i;

class StandardBankParser extends BaseParser {

  static get PARSER_ID() { return 'standardbank-v1'; }
  static get BANK_NAME() { return 'Standard Bank'; }

  static canParse(text, filename = '') {
    if (/standard.?bank|stanbic/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }

    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('the standard bank of south africa')) { score += 0.7; details.fullName = true; }
    else if (header.includes('standard bank'))               { score += 0.55; details.name = true; }
    if (header.includes('stanbic'))                         { score += 0.3;  details.stanbic = true; }
    // Standard Bank branch codes start with 05
    if (/branch\s*code\s*[:\s]+05\d{4}/i.test(text)) { score += 0.1; details.branchCode = true; }
    // YYYY/MM/DD is characteristic of Standard Bank
    const yyyyCount = (text.match(/\b\d{4}\/\d{2}\/\d{2}\b/g) || []).length;
    if (yyyyCount > 3) { score += 0.1; details.dateFormat = 'YYYY/MM/DD'; }

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
      result.warnings.push(
        'No transactions extracted from this Standard Bank statement. ' +
        'Note: debit/credit assignment is heuristic — try CSV export for exact data.'
      );
    }

    return result;
  }

  static _parseLine(line) {
    // Try debit/credit column layout first (most definitive)
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

    // YYYY/MM/DD loose
    m = line.match(RE_LOOSE);
    if (m) return this._resolveLoose(m[1], m[2], m[3], m[4] || null, line);

    // DD/MM/YYYY fallback
    m = line.match(RE_LOOSE_DD);
    if (m) return this._resolveLoose(m[1], m[2], m[3], m[4] || null, line);

    return null;
  }

  static _resolveLoose(dateStr, desc, num1Str, num2Str, rawLine) {
    const date = this.parseDate(dateStr);
    if (!date) return null;
    const num1 = this.parseAmount(num1Str);
    const num2 = num2Str ? this.parseAmount(num2Str) : null;
    if (num1 === null) return null;

    let amount, balance;
    if (num2 !== null) {
      // Two numbers: first is debit or credit, second is balance
      balance = num2;
      const isCredit = CREDIT_KEYWORDS.test(desc);
      amount = isCredit ? Math.abs(num1) : -Math.abs(num1);
    } else {
      // Single number — ambiguous, skip
      return null;
    }

    return { date, description: desc.trim(), reference: null, amount, balance, rawLine };
  }
}

module.exports = StandardBankParser;
