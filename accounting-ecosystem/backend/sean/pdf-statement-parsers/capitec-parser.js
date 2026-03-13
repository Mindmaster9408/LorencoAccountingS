/**
 * ============================================================================
 * Capitec Bank PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from Capitec Bank Online Banking.
 *
 * Expected layout:
 *   Date          Description                  Amount      Balance
 *   2026-01-01    Opening Balance                          5 000.00
 *   2026-01-02    PAYMENT RECEIVED             5 000.00   10 000.00
 *   2026-01-05    DEBIT ORDER VODACOM         -235.00      9 765.00
 *
 * Date format: YYYY-MM-DD (ISO format, characteristic of Capitec)
 * Single signed Amount column (positive = in, negative = out).
 * ============================================================================
 */

const BaseParser = require('./base-parser');

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

// Full: YYYY-MM-DD + description + amount + balance
const TXN_RE = /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})\s+([\d\s,]+\.\d{2})\s*$/;

const TXN_LOOSE_RE = /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];

class CapitecParser extends BaseParser {

  static get PARSER_ID() { return 'capitec-v1'; }
  static get BANK_NAME() { return 'Capitec'; }

  static canParse(text) {
    // Only scan the header portion (first 800 chars) for bank name — avoids
    // false positives when "Capitec" appears in a transaction description
    // on another bank's statement (e.g. "CAPITEC PAYMENT").
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('capitec bank')) { score += 0.7; details.fullName = true; }
    else if (header.includes('capitec')) { score += 0.5; details.name = true; }
    // Capitec branch code: 470010
    if (/470010/.test(text)) { score += 0.2; details.branchCode = true; }
    // ISO date format (YYYY-MM-DD) is very characteristic of Capitec exports
    const isoCount = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length;
    if (isoCount > 3) { score += 0.15; details.dateFormat = 'YYYY-MM-DD'; }

    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const lines = this.toLines(text);

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!DATE_RE.test(line)) continue;

      const lowerLine = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lowerLine.includes(k))) {
        result.skippedLines++;
        continue;
      }

      // Try full pattern
      let m = line.match(TXN_RE);
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

      // Loose: single number (ambiguous)
      m = line.match(TXN_LOOSE_RE);
      if (m) {
        result.skippedLines++;
        result.warnings.push(`Ambiguous line (single amount, skipped): ${line}`);
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted. Capitec statement may use an unsupported layout variant.');
    }

    return result;
  }
}

module.exports = CapitecParser;
