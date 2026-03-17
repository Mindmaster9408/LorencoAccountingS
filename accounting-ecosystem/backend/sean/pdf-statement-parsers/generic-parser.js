/**
 * ============================================================================
 * Generic PDF Statement Parser (Fallback)
 * ============================================================================
 * Used when no bank-specific parser matches with sufficient confidence.
 *
 * Strategy:
 *  1. Detect column layout from header row (debit/credit vs single amount)
 *  2. For each line starting with a date, extract all numbers and resolve them
 *  3. Assign debit/credit sign using description keyword heuristics
 *
 * Supports date formats: DD/MM/YYYY, DD/MM/YY, YYYY-MM-DD, YYYY/MM/DD,
 *                        DD Mon YYYY, DD-Mon-YYYY
 * Supports amounts: space/comma thousands, R prefix, DR/Cr suffix, brackets
 *
 * confidence returned: 0.3 (always low — only used as last resort)
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// All supported date starters
const DATE_RE = /^(?:\d{1,2}[\/\-\|]\d{1,2}[\/\-\|]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}-[A-Za-z]{3}-\d{4})/i;

const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal', 'interest charged',
  'service fee', 'bank charges'
];

// Description keywords that strongly suggest money IN
const CREDIT_RE = /\b(received|deposit|salary|credit|transfer\s+in|proceeds|refund|reversal\s+credit|payment\s+from)\b/i;
// Description keywords that strongly suggest money OUT
const DEBIT_RE  = /\b(debit\s+order|payment\s+to|purchase|withdrawal|atm|fee|charge|transfer\s+out|levy)\b/i;

class GenericParser extends BaseParser {

  static get PARSER_ID() { return 'generic-v1'; }
  static get BANK_NAME() { return 'Unknown'; }

  static canParse(text) {
    const hasAmounts  = (text.match(/[\d,]+\.\d{2}/g) || []).length > 3;
    const firstLine   = text.split('\n').find(l => DATE_RE.test(l.trim())) || '';
    const hasDateLike = DATE_RE.test(firstLine.trim());
    if (hasAmounts && hasDateLike) {
      return { confidence: 0.3, details: { generic: true } };
    }
    return { confidence: 0.1, details: { generic: true, insufficientSignals: true } };
  }

  static parse(text, filename = '') {
    const result = this.emptyResult('Unknown', this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const rawLines = this.toLines(text);
    const lines = this.joinContinuationLines(rawLines, l => DATE_RE.test(l));

    // Detect column layout from header rows
    const layout = this._detectLayout(lines.slice(0, 30));
    if (layout) {
      result.warnings.push(`Generic parser: detected layout — ${layout.type}`);
    }

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!DATE_RE.test(line))   continue;

      const lower = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lower.includes(k))) { result.skippedLines++; continue; }

      const txn = this._parseLine(line, layout);
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
        'Generic parser could not extract transactions. ' +
        'The PDF may use a custom layout or be an image-based scan. ' +
        'Try exporting as CSV from your bank\'s online portal.'
      );
    } else {
      result.warnings.push(
        'Parsed by generic fallback parser — debit/credit sign assignment is heuristic. ' +
        'Please review all amounts before importing.'
      );
    }

    return result;
  }

  // ── Layout detection ────────────────────────────────────────────────────────

  static _detectLayout(lines) {
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes('date') && lower.includes('description')) {
        return {
          type: (lower.includes('debit') && lower.includes('credit'))
            ? 'debit-credit'
            : 'single-amount',
          hasBalance: lower.includes('balance')
        };
      }
    }
    return null;
  }

  // ── Line parser ─────────────────────────────────────────────────────────────

  static _parseLine(line, layout) {
    // Extract the date from the start of the line
    const dateMatch = line.match(
      /^(\d{1,2}[\/\-\|]\d{1,2}[\/\-\|]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}-[A-Za-z]{3}-\d{4})/i
    );
    if (!dateMatch) return null;

    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;

    const rest = line.slice(dateMatch[0].length).trim();

    // Extract all amount-like tokens (with R prefix, DR/Cr suffix, brackets)
    const AMT_PATTERN = /(?:R\s*)?(?:\([\d\s,]+\.\d{2}\)|[-]?[\d,\s]+\.\d{2})\s*(?:[Dd][Rr]?|[Cc][Rr])?/g;
    const numbers = [];
    let numMatch;
    while ((numMatch = AMT_PATTERN.exec(rest)) !== null) {
      const val = this.parseAmount(numMatch[0]);
      if (val !== null) {
        numbers.push({ value: val, index: numMatch.index, raw: numMatch[0].trim() });
      }
    }

    if (numbers.length === 0) return null;

    // Description is everything before the first number
    const description = rest.slice(0, numbers[0].index).trim();
    if (!description) return null;

    let amount, balance;

    if (numbers.length >= 3 && layout && layout.type === 'debit-credit') {
      // Last number is always balance; first two are debit + credit
      balance = numbers[numbers.length - 1].value;
      const n1 = numbers[0].value;
      const n2 = numbers[1].value;
      // In debit/credit layout, one column is 0/absent; non-zero wins
      if (Math.abs(n2) > 0)      amount = Math.abs(n2);   // credit column → positive
      else if (Math.abs(n1) > 0) amount = -Math.abs(n1);  // debit column → negative
      else                        return null;
    } else if (numbers.length >= 2) {
      // Last = balance, second-to-last (or only) = amount
      balance = numbers[numbers.length - 1].value;
      const raw = numbers[numbers.length - 2].value;
      // If the raw value already carries a sign from DR/Cr suffix, trust it
      amount = raw;
      // If unsigned (>0) and no explicit suffix, use description heuristics
      if (amount > 0 && !DEBIT_RE.test(description) && !CREDIT_RE.test(description)) {
        // No clear signal — leave positive (conservative, user reviews anyway)
        amount = raw;
      } else if (amount > 0 && DEBIT_RE.test(description)) {
        amount = -Math.abs(raw);
      } else if (amount > 0 && CREDIT_RE.test(description)) {
        amount = Math.abs(raw);
      }
    } else {
      // Only one number — ambiguous: could be amount only, no balance
      amount  = numbers[0].value;
      balance = null;
    }

    if (amount === null || isNaN(amount)) return null;

    return { date, description, reference: null, amount, balance, rawLine: line };
  }
}

module.exports = GenericParser;
