/**
 * ============================================================================
 * ABSA PDF Statement Parser
 * ============================================================================
 * Handles all common ABSA bank statement PDF layouts exported from
 * ABSA Internet Banking / Business Online.
 *
 * Parsing strategy: RIGHT-SIDE AMOUNT SCANNING
 * ─────────────────────────────────────────────
 * pdf-parse collapses column spacing to single spaces, making column-width
 * regexes unreliable. Instead we:
 *
 *   1. Find the date at the start of the line.
 *   2. Extract ALL decimal-pointed numbers (X.XX) from the rest of the line
 *      in left-to-right order.
 *   3. The LAST number is always the running balance.
 *   4. The SECOND-TO-LAST number is the transaction amount.
 *   5. If a third number exists it is the other debit/credit column.
 *   6. Everything before the first extracted number is the description.
 *   7. Sign is determined by:
 *        (a) Explicit DR/Db/CR/Cr suffix → parseAmount handles this.
 *        (b) Balance delta vs previous balance (most reliable).
 *        (c) Description keyword heuristic as last resort.
 *
 * Supported date formats:
 *   DD/MM/YYYY, DD/MM/YY, DD Mon YYYY, DD-Mon-YYYY, YYYY/MM/DD
 *
 * Supported amount formats:
 *   "1 234.56", "1,234.56", "R 1 234.56", "1 234.56 Dr", "(1 234.56)"
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// ── Date starter patterns ────────────────────────────────────────────────────
const ANY_DATE_RE = /^(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}-[A-Za-z]{3}-\d{4})/i;

// ── Amount token pattern ─────────────────────────────────────────────────────
// Matches: optional R, optional leading -, optional brackets,
//          digits with space/comma thousands sep, .XX,
//          optional trailing DR/Db/CR/Cr suffix.
// Key: we only match numbers that have a decimal point — this excludes
// reference numbers and account numbers (which are integers).
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

// ── Lines to always skip ─────────────────────────────────────────────────────
const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'sub-total', 'total fees', 'total debit',
  'total credit', 'interest charged', 'service fee',
  'carry forward', 'brought forward'
];

// ── Description keywords used for sign heuristic ────────────────────────────
const CREDIT_RE = /\b(?:received|deposit|salary|credit|payment\s+from|transfer\s+in|proceeds|refund|reversal|interest\s+paid|cashback)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|levy|fee|charge|subscription)\b/i;

class ABSAParser extends BaseParser {

  static get PARSER_ID() { return 'absa-v1'; }
  static get BANK_NAME() { return 'ABSA'; }

  // ── Bank detection ──────────────────────────────────────────────────────────

  static canParse(text, filename = '') {
    // Filename is the most reliable signal (no risk of false-positive from transaction descriptions)
    if (/absa/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }

    const header = text.slice(0, 1200).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('absa bank limited'))     { score += 0.7; details.fullLegal = true; }
    else if (header.includes('absa bank'))        { score += 0.65; details.absaBank = true; }
    else if (header.includes('absa'))             { score += 0.45; details.absa = true; }
    if (header.includes('amalgamated banks'))     { score += 0.3;  details.fullName = true; }
    if (/branch\s*(?:code)?\s*[:\s]+6\d{5}/i.test(text))             { score += 0.15; details.branchCode = true; }
    if (/cheque(?:card)?|transact\s*plus|gold\s*value/i.test(header)) { score += 0.1;  details.accountType = true; }

    return { confidence: Math.min(score, 1.0), details };
  }

  // ── Main parse ──────────────────────────────────────────────────────────────

  static parse(text, filename = '') {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const rawLines = this.toLines(text);
    const lines    = this.joinContinuationLines(rawLines, l => ANY_DATE_RE.test(l));

    let prevBalance = null; // tracked for balance-delta sign resolution

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!ANY_DATE_RE.test(line))  continue;

      const lower = line.toLowerCase();
      const isSkip = SKIP_KEYWORDS.some(k => lower.includes(k));

      if (isSkip) {
        // Still extract balance from balance-summary lines to seed prevBalance
        const bal = this._extractLastAmount(line);
        if (bal !== null) prevBalance = bal;
        result.skippedLines++;
        continue;
      }

      const txn = this._parseLine(line, prevBalance);
      if (!txn) { result.skippedLines++; continue; }

      // Advance prevBalance for next line's delta calculation
      if (txn.balance !== null) prevBalance = txn.balance;

      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Skipped (${warns.join(', ')}): ${line.slice(0, 100)}`);
        result.skippedLines++;
      }
    }

    if (result.transactions.length === 0) {
      result.warnings.push(
        'No transactions were extracted from this ABSA statement. ' +
        'The layout may differ from known variants. ' +
        'Try the CSV export from ABSA Internet Banking as an alternative.'
      );
    }

    return result;
  }

  // ── Line parser ─────────────────────────────────────────────────────────────

  /**
   * Parse one transaction line using right-side amount scanning.
   * This approach works regardless of column spacing, which pdf-parse does
   * not reliably preserve.
   *
   * @param {string} line       - Full trimmed transaction line
   * @param {number|null} prevBalance - Running balance before this transaction
   * @returns {Transaction|null}
   */
  static _parseLine(line, prevBalance) {
    // 1. Extract date from the start
    const dateMatch = line.match(
      /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}-[A-Za-z]{3}-\d{4})/i
    );
    if (!dateMatch) return null;

    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;

    const rest = line.slice(dateMatch[0].length).trim();
    if (!rest) return null;

    // 2. Find all decimal-pointed amount tokens in left→right order.
    //    Reset lastIndex to ensure clean iteration.
    AMT_TOKEN_RE.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = AMT_TOKEN_RE.exec(rest)) !== null) {
      const raw = m[0].trim();
      const val = this.parseAmount(raw);
      if (val !== null) {
        tokens.push({ raw, value: val, start: m.index, end: m.index + m[0].length });
      }
    }

    if (tokens.length === 0) return null;

    // 3. Description = everything before the FIRST amount token.
    //    Strip trailing dashes/spaces (the "-" dash in empty columns).
    const description = rest.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description) return null;

    // 4. Resolve balance and raw transaction amount from token positions.
    const balance = tokens[tokens.length - 1].value;
    let amount;

    if (tokens.length === 1) {
      // Only one number — ambiguous (could be balance-only line). Skip.
      return null;
    }

    // The second-to-last token is the transaction amount
    const rawAmt   = tokens[tokens.length - 2].value;
    const rawToken = tokens[tokens.length - 2].raw;

    // Check whether parseAmount already embedded a sign from DR/Cr suffix
    const hasSuffix = /[Dd][Rr]?|[Cc][Rr]/i.test(rawToken);
    const hasLeadingMinus = rawToken.startsWith('-') || rawToken.startsWith('(');

    if (hasSuffix || hasLeadingMinus) {
      // Sign is explicit in the amount string — trust parseAmount result
      amount = rawAmt;
    } else if (prevBalance !== null) {
      // Balance delta is the most reliable sign resolver
      const delta = balance - prevBalance;
      // Allow 0.02 tolerance for rounding
      if (Math.abs(Math.abs(delta) - Math.abs(rawAmt)) < 0.02) {
        amount = delta >= 0 ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      } else {
        // Delta doesn't match amount — fall back to keywords
        amount = this._signFromKeywords(rawAmt, description);
      }
    } else {
      // No prevBalance yet — use keyword heuristic
      amount = this._signFromKeywords(rawAmt, description);
    }

    return { date, description, reference: null, amount, balance, rawLine: line };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Apply description keywords to assign sign when no other signal is available. */
  static _signFromKeywords(absAmt, description) {
    if (DEBIT_RE.test(description))  return -Math.abs(absAmt);
    if (CREDIT_RE.test(description)) return  Math.abs(absAmt);
    // Default: leave positive (user reviews in the confirmation step)
    return Math.abs(absAmt);
  }

  /** Extract the last decimal-pointed number from a line (for balance seeding). */
  static _extractLastAmount(line) {
    AMT_TOKEN_RE.lastIndex = 0;
    let last = null;
    let m;
    while ((m = AMT_TOKEN_RE.exec(line)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) last = v;
    }
    return last;
  }
}

module.exports = ABSAParser;
