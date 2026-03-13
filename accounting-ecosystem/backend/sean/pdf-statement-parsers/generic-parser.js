/**
 * ============================================================================
 * Generic PDF Statement Parser (Fallback)
 * ============================================================================
 * Used when no bank-specific parser matches with sufficient confidence.
 *
 * Strategy:
 *  1. Find a header row containing "date" + "description" + amount keywords
 *  2. Identify which columns map to date / description / debit / credit / amount / balance
 *  3. Parse each subsequent row that starts with a date pattern
 *
 * Limitations:
 *  - Less reliable than bank-specific parsers
 *  - Debit/credit sign assignment is heuristic when only one amount column exists
 *  - PDFs with complex multi-column layouts may not parse correctly
 *
 * confidence returned: 0.3 (always low — only used as last resort)
 * ============================================================================
 */

const BaseParser = require('./base-parser');

const AMOUNT_RE = /^[-]?[\d\s,]+\.\d{2}$/;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal', 'interest charged'
];

class GenericParser extends BaseParser {

  static get PARSER_ID() { return 'generic-v1'; }
  static get BANK_NAME() { return 'Unknown'; }

  /**
   * Generic parser always returns low confidence — it is the last-resort fallback.
   */
  static canParse(text) {
    // Only offer generic if text looks like a financial statement at all
    const hasAmounts = (text.match(/[\d,]+\.\d{2}/g) || []).length > 3;
    const hasDateLike = this.startsWithDate(text.split('\n').find(l => this.startsWithDate(l.trim())) || '');
    if (hasAmounts && hasDateLike) {
      return { confidence: 0.3, details: { generic: true } };
    }
    return { confidence: 0.1, details: { generic: true, insufficientSignals: true } };
  }

  static parse(text, filename) {
    const result = this.emptyResult('Unknown', this.PARSER_ID);
    result.accountNumber = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const lines = this.toLines(text);

    // Step 1: Detect column layout from header row
    const layout = this._detectLayout(lines);
    if (layout) {
      result.warnings.push(`Generic parser: detected layout — ${JSON.stringify(layout.hint)}`);
    }

    // Step 2: Parse transaction rows
    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!this.startsWithDate(line)) continue;

      const lowerLine = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lowerLine.includes(k))) {
        result.skippedLines++;
        continue;
      }

      const txn = this._parseLine(line, layout);
      if (!txn) { result.skippedLines++; continue; }

      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Line skipped (${warns.join(', ')}): ${line}`);
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push(
        'Generic parser could not extract transactions. ' +
        'The PDF may be a scanned image, use an unsupported layout, or have complex formatting. ' +
        'First version supports text-based PDFs only. ' +
        'Try exporting as CSV from your bank\'s online portal instead.'
      );
    } else {
      result.warnings.push(
        'Transactions parsed by generic fallback parser. ' +
        'Debit/credit sign assignment is heuristic — please review before importing.'
      );
    }

    return result;
  }

  /**
   * Try to detect whether the statement uses:
   *  - Single Amount column (signed)
   *  - Debit + Credit columns
   *  - Debit + Credit + Balance columns
   */
  static _detectLayout(lines) {
    for (const line of lines.slice(0, 30)) {
      const lower = line.toLowerCase();
      if (lower.includes('date') && lower.includes('description')) {
        const hasDebit = lower.includes('debit');
        const hasCredit = lower.includes('credit');
        const hasAmount = lower.includes('amount');
        const hasBalance = lower.includes('balance');

        return {
          type: (hasDebit && hasCredit) ? 'debit-credit' : 'single-amount',
          hasBalance,
          hint: { hasDebit, hasCredit, hasAmount, hasBalance }
        };
      }
    }
    return null;
  }

  /**
   * Parse a single transaction line using heuristic column detection.
   */
  static _parseLine(line, layout) {
    // Extract the date from the start
    const dateMatch = line.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/);
    if (!dateMatch) return null;

    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;

    const rest = line.slice(dateMatch[0].length).trim();

    // Extract all number-like tokens from the rest of the line
    const numberPattern = /[-]?[\d,\s]+\.\d{2}/g;
    const numbers = [];
    let lastIndex = 0;
    let numMatch;
    while ((numMatch = numberPattern.exec(rest)) !== null) {
      numbers.push({ value: this.parseAmount(numMatch[0]), index: numMatch.index });
      lastIndex = numMatch.index + numMatch[0].length;
    }

    if (numbers.length === 0) return null;

    // Description is the text before the first number
    const firstNumStart = numbers[0].index;
    const description = rest.slice(0, firstNumStart).trim();
    if (!description) return null;

    let amount, balance;

    if (numbers.length >= 3) {
      // 3 numbers: debit|credit + other + balance
      // Convention: last = balance, others indicate debit/credit
      balance = numbers[numbers.length - 1].value;
      // Try debit/credit pattern: one should be 0 or absent
      const n1 = numbers[0].value;
      const n2 = numbers[1].value;
      if (n1 === 0 || n1 === null) {
        amount = n2; // credit
      } else if (n2 === 0 || n2 === null) {
        amount = -Math.abs(n1); // debit
      } else {
        // Both non-zero: use heuristic
        const isCredit = /\b(received|deposit|credit|salary|transfer in|payment from)\b/i.test(description);
        amount = isCredit ? Math.abs(n1) : -Math.abs(n1);
      }
    } else if (numbers.length === 2) {
      // 2 numbers: amount + balance
      balance = numbers[1].value;
      amount = numbers[0].value; // sign already embedded (from parseAmount)
    } else {
      // 1 number: ambiguous
      amount = numbers[0].value;
      balance = null;
    }

    if (amount === null || isNaN(amount)) return null;

    return { date, description, reference: null, amount, balance, rawLine: line };
  }
}

module.exports = GenericParser;
