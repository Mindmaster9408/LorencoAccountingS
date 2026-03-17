/**
 * ============================================================================
 * FNB (First National Bank) PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from FNB Online Banking.
 *
 * Layout:
 *   Date        Description                        Amount      Balance
 *   01/01/2026  OPENING BALANCE                                5 000.00
 *   02/01/2026  PAYMENT RECEIVED REF 12345        5 000.00    10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM               -235.00      9 765.00
 *
 * FNB uses a single signed Amount column (positive = credit, negative = debit).
 * Some FNB exports use DR/Cr suffixes or bracket negatives.
 * Date format: DD/MM/YYYY (1 or 2 digit day/month)
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// DD/MM/YYYY date starter (1-digit day/month allowed)
const DATE_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;

// Full: date + desc + amount + balance (amount may have DR/Cr suffix or brackets)
const TXN_RE = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([-]?R?\s*(?:\([\d\s,]+\.\d{2}\)|[\d\s,]+\.\d{2})\s*(?:[Dd][Rr]?|[Cc][Rr])?)\s{2,}(R?\s*[\d\s,]+\.\d{2})\s*$/;

// Loose: date + desc + one number at end (balance-only or ambiguous lines)
const TXN_LOOSE_RE = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s+(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2})\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'subtotal', 'sub-total', 'total fees',
  'interest charged', 'total interest', 'service fee'
];

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
    // FNB branch codes: 250655 (JHB), 252005 (CPT), 251005 (DBN), etc.
    if (/branch\s*code\s*[:\s]+25[012]\d{3}/i.test(text)) { score += 0.1; details.branchCode = true; }

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

      // Full pattern: date + desc + amount + balance
      let m = line.match(TXN_RE);
      if (m) {
        const date    = this.parseDate(m[1]);
        const desc    = m[2].trim();
        const amount  = this.parseAmount(m[3]);
        const balance = this.parseAmount(m[4]);

        if (!date || amount === null) { result.skippedLines++; continue; }

        const txn = { date, description: desc, reference: null, amount, balance, rawLine: line };
        const warns = this.validateTransaction(txn);
        if (warns.length === 0) {
          result.transactions.push(txn);
        } else {
          result.warnings.push(`Skipped (${warns.join(', ')}): ${line.slice(0, 80)}`);
          result.skippedLines++;
        }
        continue;
      }

      // Loose pattern: single number — FNB format means it's balance-only (no amount), skip
      m = line.match(TXN_LOOSE_RE);
      if (m) {
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push(
        'No transactions extracted from this FNB statement. ' +
        'The statement may use an unsupported FNB layout variant.'
      );
    }

    return result;
  }
}

module.exports = FNBParser;
