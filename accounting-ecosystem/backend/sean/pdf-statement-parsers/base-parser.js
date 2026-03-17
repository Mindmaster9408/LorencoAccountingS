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
   * Also normalises common OCR artifacts (pipe→slash, O→0).
   * Returns YYYY-MM-DD string or null.
   */
  static parseDate(str) {
    if (!str) return null;
    // Normalise common OCR artifacts before matching
    let s = str.toString().trim()
      .replace(/(\d{1,2})\|(\d{1,2})\|(\d{2,4})/, '$1/$2/$3') // pipe used as slash
      .replace(/\bO(\d)/g, '0$1')   // capital O used as zero at start of number
      .replace(/(\d)O\b/g, '$10');  // capital O used as zero at end of number

    const MONTHS = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };

    // DD/MM/YYYY or DD-MM-YYYY (1 or 2 digit day/month)
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }

    // DD/MM/YY (2-digit year — used by some ABSA and Nedbank exports)
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
    if (m) {
      const year = parseInt(m[3], 10) >= 50 ? `19${m[3]}` : `20${m[3]}`;
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }

    // YYYY/MM/DD or YYYY-MM-DD (Standard Bank, Capitec ISO)
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
   *
   * Handles all common SA bank formats:
   *   "15 000.00"        → 15000.00   (space thousands)
   *   "15,000.00"        → 15000.00   (comma thousands)
   *   "-1 500.00"        → -1500.00   (leading minus)
   *   "1 500.00 DR"      → -1500.00   (DR suffix = debit = out)
   *   "1 500.00 CR"      →  1500.00   (CR suffix = credit = in)
   *   "1500.00-"         → -1500.00   (trailing minus)
   *   "R 1 500.00"       → 15000.00   (R currency prefix)
   *   "(1 500.00)"       → -1500.00   (brackets = negative)
   *   "1 500,00"         → 1500.00    (comma decimal — some exports)
   *
   * @param {string} str
   * @param {'debit'|'credit'|null} forceType  — if known from separate column
   * @returns {number|null}
   */
  static parseAmount(str, forceType = null) {
    if (str === null || str === undefined || str === '') return null;
    let s = str.toString().trim();
    if (!s) return null;

    // Remove currency prefix (R or ZAR)
    s = s.replace(/^(?:ZAR|R)\s*/i, '');

    // Brackets format: (1 500.00) = negative
    let bracketNeg = false;
    const bracketMatch = s.match(/^\((.+)\)$/);
    if (bracketMatch) {
      bracketNeg = true;
      s = bracketMatch[1].trim();
    }

    // Detect sign from explicit DR/Db/CR/Cr suffix (case-insensitive)
    let sign = null;
    if (/\b(?:DR|Db)\b/i.test(s)) { sign = -1; s = s.replace(/\b(?:DR|Db)\b/ig, '').trim(); }
    else if (/\bCR?\b/i.test(s))  { sign = +1; s = s.replace(/\bCR?\b/ig, '').trim(); }

    // Trailing minus ("1 500.00-")
    if (s.trimEnd().endsWith('-')) { sign = sign ?? -1; s = s.trimEnd().slice(0, -1).trim(); }

    // Leading minus
    if (s.trimStart().startsWith('-')) { sign = sign ?? -1; s = s.trimStart().slice(1).trim(); }

    // Normalise European comma-decimal format: "1 500,00" → "1 500.00"
    // Only apply when there is no period already present and there IS a comma
    if (!s.includes('.') && /,\d{2}$/.test(s)) {
      s = s.replace(',', '.');
    }

    // Remove comma thousands separator ("15,000.00" → "15000.00")
    s = s.replace(/,(?=\d{3}(?:[.,\s]|$))/g, '');
    // Remove space thousands separator ("15 000.00" → "15000.00")
    s = s.replace(/\s+(?=\d{3}(?:\.|$))/g, '');

    s = s.trim();
    if (!s) return null;
    const val = parseFloat(s);
    if (isNaN(val)) return null;

    // Apply bracket negative first, then explicit sign, then forceType
    if (bracketNeg) sign = (sign ?? -1) < 0 ? -1 : -1; // brackets always negative
    if (forceType === 'debit')  return -Math.abs(val);
    if (forceType === 'credit') return  Math.abs(val);
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
   * Join continuation lines into the preceding transaction line.
   *
   * Bank PDFs often break long descriptions across two lines:
   *   "01/01/2026  SOME LONG DESCRIPTION        1 500.00  10 000.00"
   *   "            continued description text"
   *
   * The continuation line starts with whitespace (empty after trim) in the
   * original, but in our array it's non-empty text that does NOT start with
   * a date pattern and does NOT look like a header/footer.
   *
   * @param {string[]} lines - Already trimmed lines from toLines()
   * @param {function} isDateLine - returns true if line starts a new transaction
   * @returns {string[]} lines with continuations joined to preceding line
   */
  static joinContinuationLines(lines, isDateLine) {
    const result = [];
    for (const line of lines) {
      if (result.length === 0 || isDateLine(line) || this.isPageNoise(line)) {
        result.push(line);
      } else if (!isDateLine(line) && result.length > 0) {
        // Append to the last line if it started with a date
        const prev = result[result.length - 1];
        if (isDateLine(prev)) {
          result[result.length - 1] = prev + ' ' + line;
        } else {
          result.push(line);
        }
      }
    }
    return result;
  }

  /**
   * Check whether a line looks like a page header/footer we should skip.
   */
  static isPageNoise(line) {
    const lower = line.toLowerCase();
    return (
      /^page\s+\d+\s+of\s+\d+/i.test(line) ||
      /^statement\s+of\s+account/i.test(line) ||
      /^\s*date\s+description/i.test(line) ||
      /^\s*date\s+details/i.test(line) ||
      /^\s*date\s+narration/i.test(line) ||
      /^\s*date\s+transaction/i.test(line) ||
      /account\s+number\s*:/i.test(line) ||
      /branch\s+code\s*:/i.test(line) ||
      /^opening\s+balance/i.test(line) ||
      /^closing\s+balance/i.test(line) ||
      lower.startsWith('balance brought forward') ||
      lower.startsWith('balance carried forward') ||
      lower.startsWith('total') ||
      lower.startsWith('sub-total') ||
      /^\*+$/.test(line) ||
      /^-+$/.test(line) ||
      /^=+$/.test(line) ||
      // Header rows with "Debit Credit Balance" column names
      /\bdebit\s+credit\s+balance\b/i.test(line) ||
      /\bamount\s+balance\b/i.test(line)
    );
  }

  /**
   * Determine if a string looks like it starts with a date.
   * Handles text-based and OCR-artifact date formats.
   */
  static startsWithDate(str) {
    return (
      /^\d{1,2}[\/\-\|]\d{1,2}[\/\-\|]\d{2,4}/.test(str) ||   // DD/MM/YYYY or DD/MM/YY
      /^\d{4}[\/\-]\d{2}[\/\-]\d{2}/.test(str) ||              // YYYY-MM-DD or YYYY/MM/DD
      /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i.test(str) ||
      /^\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}/i.test(str) ||
      // OCR: leading O mistaken for 0
      /^[O0]\d[\/\-\|]\d{1,2}[\/\-\|]\d{2,4}/.test(str)
    );
  }

  /**
   * Extract account number from statement header text.
   */
  static extractAccountNumber(text) {
    // "Account: 1234567890" or "Account Number: 123..." or "Acc No: ..."
    const m = text.match(/account\s*(?:number|no\.?)?\s*[:\-]?\s*(\d[\d\s\-]{4,20}\d)/i);
    return m ? m[1].replace(/\s+/g, '') : null;
  }

  /**
   * Extract statement period from text.
   * Returns { from: 'YYYY-MM-DD'|null, to: 'YYYY-MM-DD'|null }
   */
  static extractPeriod(text) {
    // "Period: 01/01/2026 to 31/01/2026" or "From: ... To: ..."
    const DATE_PAT = /\d{1,2}[\/\-]\d{1,2}[\/\-](?:\d{2}|\d{4})|\d{4}[\/\-]\d{2}[\/\-]\d{2}/;
    const m = text.match(
      new RegExp(`(?:period|from)[:\\s]+(${DATE_PAT.source})\\s*(?:to|-|–)\\s*(${DATE_PAT.source})`, 'i')
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
