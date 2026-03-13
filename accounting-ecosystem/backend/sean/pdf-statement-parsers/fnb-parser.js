/**
 * ============================================================================
 * FNB (First National Bank) PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from FNB Online Banking.
 *
 * Expected layout:
 *   Date        Description                        Amount      Balance
 *   01/01/2026  OPENING BALANCE                                5 000.00
 *   02/01/2026  PAYMENT RECEIVED REF 12345        5 000.00    10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM               -235.00      9 765.00
 *
 * FNB uses a single signed Amount column (positive = credit, negative = debit).
 * Date format: DD/MM/YYYY
 * ============================================================================
 */

const BaseParser = require('./base-parser');

// Matches:  DD/MM/YYYY  <description text>  <amount>  <balance>
// Amount and balance are optional (opening balance line has no amount).
const TXN_LINE_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})\s+([\d\s,]+\.\d{2})\s*$/;

// Looser pattern: date + description + single number at end (for lines with only balance)
const TXN_LINE_LOOSE_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})\s*$/;

// Lines to skip even if they start with a date
const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'subtotal', 'sub-total', 'total fees',
  'interest charged', 'total interest'
];

class FNBParser extends BaseParser {

  static get PARSER_ID() { return 'fnb-v1'; }
  static get BANK_NAME() { return 'FNB'; }

  static canParse(text) {
    // Scan only the header section (first 800 chars) to prevent transaction
    // descriptions from triggering false positive bank detection.
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('first national bank')) { score += 0.6; details.bankName = true; }
    if (header.includes('fnb')) { score += 0.15; details.fnbAbbr = true; }
    if (header.includes('firstrand')) { score += 0.2; details.firstrand = true; }
    // FNB typically shows branch code 250655 (Johannesburg) or 252005 (Cape Town)
    if (/branch\s*code\s*[:\s]+25[02]\d{3}/i.test(text)) { score += 0.1; details.branchCode = true; }

    return { confidence: Math.min(score, 1.0), details };
  }

  static parse(text, filename) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const lines = this.toLines(text);

    for (const line of lines) {
      // Skip page noise and non-transaction lines
      if (this.isPageNoise(line)) continue;
      if (!this.startsWithDate(line)) continue;

      // Skip known non-transaction date lines (opening/closing balance etc.)
      const lowerLine = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lowerLine.includes(k))) {
        result.skippedLines++;
        continue;
      }

      // Try full pattern: date + description + amount + balance
      let m = line.match(TXN_LINE_RE);
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

      // Loose pattern: date + description + single number (might be balance-only line)
      m = line.match(TXN_LINE_LOOSE_RE);
      if (m) {
        // Single number at end is ambiguous — could be amount or balance.
        // FNB format: if only one number, it's likely a balance-only line (skip as non-transaction).
        result.skippedLines++;
        result.warnings.push(`Ambiguous line (single amount, skipped): ${line}`);
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted. The statement may use an unsupported FNB layout variant.');
    }

    return result;
  }
}

module.exports = FNBParser;
