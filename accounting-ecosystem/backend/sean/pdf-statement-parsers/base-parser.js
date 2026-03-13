/**
 * ============================================================================
 * Base PDF Statement Parser
 * ============================================================================
 * All bank-specific parsers extend this class.
 *
 * Contract:
 *   static canParse(text: string): { confidence: number, details: object }
 *   static parse(text: string, filename: string): ParseResult
 *
 * ParseResult:
 *   {
 *     bank: string,          // e.g. 'FNB'
 *     parserId: string,      // e.g. 'fnb-v1'
 *     accountNumber: string|null,
 *     statementPeriod: { from: string|null, to: string|null },
 *     transactions: Transaction[],
 *     warnings: string[],
 *     skippedLines: number
 *   }
 *
 * Transaction:
 *   {
 *     date: string,          // YYYY-MM-DD
 *     description: string,
 *     reference: string|null,
 *     amount: number,        // positive = money in, negative = money out
 *     balance: number|null,
 *     rawLine: string        // original line for debugging
 *   }
 * ============================================================================
 */

class BaseParser {

  static get PARSER_ID() { return 'base'; }
  static get BANK_NAME() { return 'Unknown'; }

  /**
   * Determine whether this parser can handle the given PDF text.
   * @param {string} text - Full extracted PDF text
   * @returns {{ confidence: number, details: object }}
   *   confidence: 0.0 (cannot parse) to 1.0 (certain match)
   */
  static canParse(text) { // eslint-disable-line no-unused-vars
    return { confidence: 0, details: {} };
  }

  /**
   * Parse the full PDF text into structured transactions.
   * @param {string} text - Full extracted PDF text
   * @param {string} filename - Original filename (for metadata)
   * @returns {ParseResult}
   */
  static parse(text, filename) { // eslint-disable-line no-unused-vars
    throw new Error(`Parser ${this.PARSER_ID} must implement parse()`);
  }

  // =========================================================================
  // SHARED UTILITIES — available to all subclass parsers
  // =========================================================================

  /**
   * Parse a date string in any common South African bank format.
   * Returns YYYY-MM-DD string or null.
   */
  static parseDate(str) {
    if (!str) return null;
    const s = str.toString().trim();

    const MONTHS = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };

    // DD/MM/YYYY or DD-MM-YYYY
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }

    // YYYY/MM/DD or YYYY-MM-DD
    m = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    // DD Mon YYYY  (e.g. "01 Jan 2026" or "1 January 2026")
    m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
      if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
    }

    // DD-Mon-YYYY (e.g. "01-Jan-2026")
    m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/i);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()];
      if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
    }

    return null;
  }

  /**
   * Parse an amount string into a signed float.
   * Handles: "15 000.00", "15,000.00", "-1 500.00", "1 500.00 DR", "1 500.00 CR",
   *          "1500.00-", "R 1 500.00"
   * @param {string} str
   * @param {'debit'|'credit'|null} forceType  — if known from separate column
   * @returns {number|null}
   */
  static parseAmount(str, forceType = null) {
    if (!str && str !== 0) return null;
    let s = str.toString().trim();
    if (!s) return null;

    // Remove currency prefix
    s = s.replace(/^R\s*/i, '');

    // Detect sign from explicit DR/CR suffix
    let sign = null;
    if (/\bDR\b/i.test(s)) { sign = -1; s = s.replace(/\bDR\b/ig, ''); }
    else if (/\bCR\b/i.test(s)) { sign = 1; s = s.replace(/\bCR\b/ig, ''); }

    // Detect trailing minus (some banks use "1 500.00-" for debits)
    if (s.trimEnd().endsWith('-')) { sign = sign ?? -1; s = s.trimEnd().slice(0, -1); }

    // Detect leading minus
    if (s.trimStart().startsWith('-')) { sign = sign ?? -1; s = s.trimStart().slice(1); }

    // Remove comma thousands separator
    s = s.replace(/,(?=\d{3}(?:[.,\s]|$))/g, '');
    // Remove space thousands separator (space before exactly 3 digits then period or end)
    s = s.replace(/\s+(?=\d{3}(?:\.|$))/g, '');

    s = s.trim();
    const val = parseFloat(s);
    if (isNaN(val)) return null;

    // Apply explicit type if provided
    if (forceType === 'debit') return -Math.abs(val);
    if (forceType === 'credit') return Math.abs(val);

    // Apply detected sign, default to positive if no sign found
    return val * (sign ?? 1);
  }

  /**
   * Split PDF text into clean, non-empty lines.
   */
  static toLines(text) {
    return text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);
  }

  /**
   * Check whether a line looks like a page header/footer we should skip.
   * Common across all banks.
   */
  static isPageNoise(line) {
    const lower = line.toLowerCase();
    return (
      /^page\s+\d+\s+of\s+\d+/i.test(line) ||
      /^statement\s+of\s+account/i.test(line) ||
      /^\s*date\s+description/i.test(line) ||   // header row
      /^\s*date\s+details/i.test(line) ||
      /account\s+number\s*:/i.test(line) ||
      /branch\s+code\s*:/i.test(line) ||
      /^opening\s+balance/i.test(line) ||
      /^closing\s+balance/i.test(line) ||
      lower.startsWith('balance brought forward') ||
      lower.startsWith('balance carried forward') ||
      lower.startsWith('total') ||
      lower.startsWith('sub-total') ||
      /^\*+$/.test(line) ||
      /^-+$/.test(line)
    );
  }

  /**
   * Determine if a string looks like it starts with a date.
   */
  static startsWithDate(str) {
    return (
      /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(str) ||
      /^\d{4}[\/\-]\d{2}[\/\-]\d{2}/.test(str) ||
      /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(str) ||
      /^\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}/i.test(str)
    );
  }

  /**
   * Extract account number from statement header text.
   * Looks for common patterns like "Account: 1234567890" or "Account Number: 123..."
   */
  static extractAccountNumber(text) {
    const m = text.match(/account\s*(?:number)?\s*[:\-]?\s*(\d[\d\s\-]{4,20}\d)/i);
    return m ? m[1].replace(/\s+/g, '') : null;
  }

  /**
   * Extract statement period from text.
   * Returns { from: 'YYYY-MM-DD'|null, to: 'YYYY-MM-DD'|null }
   */
  static extractPeriod(text) {
    // "Period: 01/01/2026 to 31/01/2026" or "From: ... To: ..."
    const m = text.match(
      /(?:period|from)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\s*(?:to|-|–)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})/i
    );
    if (m) {
      return { from: this.parseDate(m[1]), to: this.parseDate(m[2]) };
    }
    return { from: null, to: null };
  }

  /**
   * Build an empty ParseResult skeleton.
   */
  static emptyResult(bank, parserId) {
    return {
      bank,
      parserId,
      accountNumber: null,
      statementPeriod: { from: null, to: null },
      transactions: [],
      warnings: [],
      skippedLines: 0
    };
  }

  /**
   * Validate a parsed transaction object.
   * Returns array of warning strings (empty = valid).
   */
  static validateTransaction(txn) {
    const warn = [];
    if (!txn.date) warn.push('Missing date');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(txn.date)) warn.push(`Invalid date format: ${txn.date}`);
    if (!txn.description) warn.push('Missing description');
    if (txn.amount === null || txn.amount === undefined || isNaN(txn.amount)) {
      warn.push('Missing or invalid amount');
    }
    return warn;
  }
}

module.exports = BaseParser;
