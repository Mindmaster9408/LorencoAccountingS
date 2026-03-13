/**
 * ============================================================================
 * ABSA PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from ABSA Online Banking.
 *
 * Expected layout (separate Debit / Credit columns):
 *   Date        Description              Debit       Credit      Balance
 *   01/01/2026  OPENING BALANCE                                  5 000.00
 *   02/01/2026  PAYMENT RECEIVED         -           5 000.00   10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM      235.00      -           9 765.00
 *
 * ABSA uses separate Debit (money out) / Credit (money in) columns.
 * Date format: DD/MM/YYYY  (some exports: DD Mon YYYY)
 * ============================================================================
 */

const BaseParser = require('./base-parser');

// Pattern 1: date + description + debit + credit + balance
// Debit/credit may be "-" or empty when not applicable
const TXN_DEBIT_CREDIT_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([-\d\s,]*\.\d{2}|-)\s+([-\d\s,]*\.\d{2}|-)\s+([\d\s,]+\.\d{2})\s*$/;

// Pattern 2: date + description + single signed amount + balance (some ABSA exports)
const TXN_SINGLE_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})\s+([\d\s,]+\.\d{2})\s*$/;

// DD Mon YYYY variant
const TXN_MON_RE = /^(\d{2}\s+[A-Za-z]{3}\s+\d{4})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})(?:\s+([-]?[\d\s,]+\.\d{2}))?\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];

class ABSAParser extends BaseParser {

  static get PARSER_ID() { return 'absa-v1'; }
  static get BANK_NAME() { return 'ABSA'; }

  static canParse(text) {
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('absa bank')) { score += 0.6; details.absaBank = true; }
    else if (header.includes('absa')) { score += 0.4; details.absa = true; }
    if (header.includes('amalgamated banks')) { score += 0.4; details.fullName = true; }
    // ABSA branch codes start with 6
    if (/branch\s*code\s*[:\s]+6\d{5}/i.test(text)) { score += 0.1; details.branchCode = true; }

    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const lines = this.toLines(text);

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!this.startsWithDate(line)) continue;

      const lowerLine = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lowerLine.includes(k))) {
        result.skippedLines++;
        continue;
      }

      // Try debit/credit pattern
      let m = line.match(TXN_DEBIT_CREDIT_RE);
      if (m) {
        const date = this.parseDate(m[1]);
        const description = m[2].trim();
        const debitStr = m[3].trim();
        const creditStr = m[4].trim();
        const balance = this.parseAmount(m[5]);

        if (!date) { result.skippedLines++; continue; }

        let amount = null;
        if (creditStr && creditStr !== '-' && creditStr !== '') {
          amount = Math.abs(this.parseAmount(creditStr) ?? 0);
        } else if (debitStr && debitStr !== '-' && debitStr !== '') {
          amount = -Math.abs(this.parseAmount(debitStr) ?? 0);
        }

        if (amount === null) { result.skippedLines++; continue; }

        const txn = { date, description, reference: null, amount, balance, rawLine: line };
        const warns = this.validateTransaction(txn);
        if (warns.length === 0) {
          result.transactions.push(txn);
        } else {
          result.warnings.push(`Line skipped (${warns.join(', ')}): ${line}`);
          result.skippedLines++;
        }
        continue;
      }

      // Try single signed amount pattern
      m = line.match(TXN_SINGLE_RE);
      if (m) {
        const date = this.parseDate(m[1]);
        const description = m[2].trim();
        const amount = this.parseAmount(m[3]);
        const balance = this.parseAmount(m[4]);

        if (!date || amount === null) { result.skippedLines++; continue; }

        const txn = { date, description, reference: null, amount, balance, rawLine: line };
        const warns = this.validateTransaction(txn);
        if (warns.length === 0) {
          result.transactions.push(txn);
        } else {
          result.warnings.push(`Line skipped (${warns.join(', ')}): ${line}`);
          result.skippedLines++;
        }
        continue;
      }

      // Try Mon date variant
      m = line.match(TXN_MON_RE);
      if (m) {
        const date = this.parseDate(m[1]);
        const description = m[2].trim();
        const amount = this.parseAmount(m[3]);
        const balance = m[4] ? this.parseAmount(m[4]) : null;

        if (!date || amount === null) { result.skippedLines++; continue; }

        const txn = { date, description, reference: null, amount, balance, rawLine: line };
        const warns = this.validateTransaction(txn);
        if (warns.length === 0) {
          result.transactions.push(txn);
        } else {
          result.warnings.push(`Line skipped (${warns.join(', ')}): ${line}`);
          result.skippedLines++;
        }
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted. The statement may use an unsupported ABSA layout variant.');
    }

    return result;
  }
}

module.exports = ABSAParser;
