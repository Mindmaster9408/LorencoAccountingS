/**
 * ============================================================================
 * Nedbank PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from Nedbank Online Banking.
 *
 * Expected layout:
 *   Date        Description              Debit       Credit      Balance
 *   01/01/2026  Opening Balance                                  5 000.00
 *   02/01/2026  PAYMENT RECEIVED                    5 000.00   10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM      235.00                  9 765.00
 *
 * Date format: DD/MM/YYYY
 * Uses separate Debit / Credit columns.
 * ============================================================================
 */

const BaseParser = require('./base-parser');

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}/;

// Full: DD/MM/YYYY + description + debit (or empty) + credit (or empty) + balance
// Allow for amounts separated by 2+ spaces
const TXN_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s{2,}([\d\s,]+\.\d{2})?\s{2,}([\d\s,]+\.\d{2})?\s{2,}([\d\s,]+\.\d{2})\s*$/;

// Loose: date + description + 1-3 numbers
const TXN_LOOSE_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([\d\s,]+\.\d{2})(?:\s+([\d\s,]+\.\d{2}))?(?:\s+([\d\s,]+\.\d{2}))?\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];

class NedbankParser extends BaseParser {

  static get PARSER_ID() { return 'nedbank-v1'; }
  static get BANK_NAME() { return 'Nedbank'; }

  static canParse(text) {
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('nedbank')) { score += 0.6; details.name = true; }
    if (header.includes('nedgroup')) { score += 0.2; details.nedgroup = true; }
    // Nedbank branch codes start with 19
    if (/branch\s*code\s*[:\s]+19\d{4}/i.test(text)) { score += 0.2; details.branchCode = true; }

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

      const m = line.match(TXN_LOOSE_RE);
      if (!m) { result.skippedLines++; continue; }

      const date = this.parseDate(m[1]);
      const description = m[2].trim();
      const nums = [m[3], m[4], m[5]].filter(Boolean).map(n => this.parseAmount(n));

      if (!date || nums.length === 0) { result.skippedLines++; continue; }

      let amount, balance;

      if (nums.length === 3) {
        // debit + credit + balance — one of debit/credit will be 0 or null
        // Nedbank: debit column comes first, then credit, then balance
        const debit = nums[0];
        const credit = nums[1];
        balance = nums[2];
        // Whichever is non-zero (and non-null) is the transaction amount
        if (credit && credit > 0) {
          amount = Math.abs(credit);
        } else if (debit && debit > 0) {
          amount = -Math.abs(debit);
        } else {
          result.skippedLines++;
          continue;
        }
      } else if (nums.length === 2) {
        // Either (debit|credit) + balance  or  amount + balance
        const first = nums[0];
        balance = nums[1];
        // If description suggests inbound, treat as credit; otherwise debit
        const isCredit = /\b(received|deposit|credit|salary|transfer in|payment from)\b/i.test(description);
        amount = isCredit ? Math.abs(first) : -Math.abs(first);
      } else {
        result.skippedLines++;
        result.warnings.push(`Ambiguous line (single amount): ${line}`);
        continue;
      }

      const txn = { date, description, reference: null, amount, balance, rawLine: line };
      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Line skipped (${warns.join(', ')}): ${line}`);
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push('No transactions extracted. Nedbank statement may use an unsupported layout variant.');
    }

    return result;
  }
}

module.exports = NedbankParser;
