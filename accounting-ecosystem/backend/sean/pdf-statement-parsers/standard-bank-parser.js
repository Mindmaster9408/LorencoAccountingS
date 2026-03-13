/**
 * ============================================================================
 * Standard Bank PDF Statement Parser
 * ============================================================================
 * Supports text-based PDF statements from Standard Bank Online Banking.
 *
 * Expected layout:
 *   Date        Description              Debit       Credit      Balance
 *   2026/01/01  Opening Balance                                  5 000.00
 *   2026/01/02  PAYMENT RECEIVED                    5 000.00   10 000.00
 *   2026/01/05  DEBIT ORDER VODACOM      235.00                  9 765.00
 *
 * Standard Bank date format: YYYY/MM/DD
 * Uses separate Debit / Credit columns.
 * ============================================================================
 */

const BaseParser = require('./base-parser');

// YYYY/MM/DD pattern
const DATE_RE = /^\d{4}\/\d{2}\/\d{2}/;

// Full row: YYYY/MM/DD + description + optional debit + optional credit + balance
const TXN_RE = /^(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s+([\d\s,]+\.\d{2})?\s*([\d\s,]+\.\d{2})?\s*([\d\s,]+\.\d{2})\s*$/;

// Simpler: date + description + one or two numbers
const TXN_LOOSE_RE = /^(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s+([-]?[\d\s,]+\.\d{2})(?:\s+([-]?[\d\s,]+\.\d{2}))?\s*$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal', 'fees'
];

class StandardBankParser extends BaseParser {

  static get PARSER_ID() { return 'standardbank-v1'; }
  static get BANK_NAME() { return 'Standard Bank'; }

  static canParse(text) {
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('the standard bank of south africa')) { score += 0.7; details.fullName = true; }
    else if (header.includes('standard bank')) { score += 0.55; details.name = true; }
    if (header.includes('stanbic')) { score += 0.3; details.stanbic = true; }
    // Standard Bank branch codes start with 05
    if (/branch\s*code\s*[:\s]+05\d{4}/i.test(text)) { score += 0.1; details.branchCode = true; }
    // Date format hint: YYYY/MM/DD is characteristic of Standard Bank
    const yyyymmddCount = (text.match(/\b\d{4}\/\d{2}\/\d{2}\b/g) || []).length;
    if (yyyymmddCount > 3) { score += 0.1; details.dateFormat = 'YYYY/MM/DD'; }

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

      // Extract all numbers from the line to determine debit/credit/balance
      const m = line.match(TXN_LOOSE_RE);
      if (!m) { result.skippedLines++; continue; }

      const date = this.parseDate(m[1]);
      const description = m[2].trim();
      const num1 = this.parseAmount(m[3]);  // could be debit, credit, or balance
      const num2 = m[4] ? this.parseAmount(m[4]) : null;

      if (!date || num1 === null) { result.skippedLines++; continue; }

      // Standard Bank: when two numbers present, first is debit OR credit, second is balance.
      // Determine debit vs credit from description keywords.
      let amount, balance;
      if (num2 !== null) {
        balance = num2;
        // Heuristic: if description contains payment/deposit/salary/transfer in, it's credit
        const isCredit = /\b(payment received|deposit|salary|credit|transfer in|proceeds)\b/i.test(description);
        amount = isCredit ? Math.abs(num1) : -Math.abs(num1);
      } else {
        // Single number — ambiguous, treat as 0 amount with balance
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
      result.warnings.push('No transactions extracted. Standard Bank statement may use an unsupported layout variant. Note: debit/credit column detection is heuristic-based.');
    }

    return result;
  }
}

module.exports = StandardBankParser;
