/**
 * ============================================================================
 * ABSA PDF Statement Parser
 * ============================================================================
 * Supports all common ABSA bank statement PDF layouts:
 *
 * Layout A — Debit/Credit columns (classic Internet Banking export):
 *   Date        Description              Debit       Credit      Balance
 *   01/01/2026  OPENING BALANCE                                  5 000.00
 *   02/01/2026  PAYMENT RECEIVED         -           5 000.00   10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM      235.00      -           9 765.00
 *
 * Layout B — Single amount with DR/Cr suffix:
 *   Date        Description                        Amount      Balance
 *   01/01/2026  PAYMENT RECEIVED REF:12345       5 000.00 Cr  10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM                235.00 Dr   9 765.00
 *
 * Layout C — Single signed amount (some ABSA ChequeCard / Business exports):
 *   01/01/2026  PAYMENT RECEIVED REF:12345       5 000.00     10 000.00
 *   05/01/2026  DEBIT ORDER VODACOM             -235.00        9 765.00
 *
 * Layout D — Month-name dates:
 *   01 Jan 2026  PAYMENT RECEIVED               5 000.00     10 000.00
 *
 * Layout E — Bracket negatives (some ABSA business formats):
 *   05/01/2026  DEBIT ORDER VODACOM          (235.00)         9 765.00
 *
 * Date formats supported: DD/MM/YYYY, DD/MM/YY, DD Mon YYYY, DD-Mon-YYYY
 * Amounts: space/comma thousands, R prefix, DR/Cr/DR/CR suffix, brackets
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// ── Date patterns ────────────────────────────────────────────────────────────

// DD/MM/YYYY or DD/MM/YY (1-digit day/month allowed)
const DATE_SLASH = /\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})/;
// DD Mon YYYY or DD-Mon-YYYY
const DATE_MON   = /\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-]\d{4}/;

const ANY_DATE_RE = new RegExp(
  `^(?:${DATE_SLASH.source}|${DATE_MON.source})`
);

// ── Amount building block ────────────────────────────────────────────────────
// Matches: optional R, optional brackets, digits/space/comma, decimal
// followed by optional DR/Cr/CR suffix
const AMT_CORE = /(?:R\s*)?(?:\([\d\s,]+\.\d{2}\)|[\d\s,]+\.\d{2})\s*(?:[Dd][Rr]?|[Cc][Rr])?/;

// ── Layout A: debit/credit column format ────────────────────────────────────
// date  desc  debit(or - or blank)  credit(or - or blank)  balance
// Columns separated by 2+ spaces
const RE_LAYOUT_A = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s{1,}(.+?)\s{2,}([\d\s,]*\.\d{2}|[-]|)\s{2,}([\d\s,]*\.\d{2}|[-]|)\s{2,}([\d\s,]+\.\d{2})\s*$/;

// ── Layout B: single amount with DR/Cr suffix ────────────────────────────────
// date  desc  amount  Dr|Cr  balance
const RE_LAYOUT_B = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s{1,}(.+?)\s{2,}(R?\s*[\d\s,]+\.\d{2})\s*([Dd][Rr]?|[Cc][Rr])\s{1,}(R?\s*[\d\s,]+\.\d{2})\s*$/;

// ── Layout C: signed single amount, no suffix ────────────────────────────────
// date  desc  [-]amount  balance
const RE_LAYOUT_C = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s{1,}(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2})\s{2,}(R?\s*[\d\s,]+\.\d{2})\s*$/;

// ── Layout D: month-name dates (DD Mon YYYY) ─────────────────────────────────
const RE_LAYOUT_D = /^(\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-]\d{4})\s{1,}(.+?)\s{2,}([-]?R?\s*[\d\s,]+\.\d{2})(?:\s{2,}(R?\s*[\d\s,]+\.\d{2}))?\s*$/;

// ── Layout E: bracket negative amounts ───────────────────────────────────────
// date  desc  (amount)  balance   — same as C but amount is in brackets
const RE_LAYOUT_E = /^(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\s{1,}(.+?)\s{2,}(\([\d\s,]+\.\d{2}\))\s{1,}(R?\s*[\d\s,]+\.\d{2})\s*$/;

// ── Lines to skip ─────────────────────────────────────────────────────────────
const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'sub-total', 'total fees', 'total debit',
  'total credit', 'interest charged', 'service fee'
];

class ABSAParser extends BaseParser {

  static get PARSER_ID() { return 'absa-v1'; }
  static get BANK_NAME() { return 'ABSA'; }

  // ── Bank detection ──────────────────────────────────────────────────────────

  static canParse(text, filename = '') {
    // Check filename first — reliable signal without reading body
    if (/absa/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }

    // Only scan first 1200 characters — prevents transaction descriptions
    // like "ABSA PAYMENT" on another bank's statement from triggering false positives
    const header = text.slice(0, 1200).toLowerCase();
    let score = 0;
    const details = {};

    if (header.includes('absa bank limited'))     { score += 0.7; details.fullLegal = true; }
    else if (header.includes('absa bank'))        { score += 0.65; details.absaBank = true; }
    else if (header.includes('absa'))             { score += 0.45; details.absa = true; }
    if (header.includes('amalgamated banks'))     { score += 0.3;  details.fullName = true; }
    // ABSA branch codes start with 6 (e.g. 632005, 630000)
    if (/branch\s*(?:code)?\s*[:\s]+6\d{5}/i.test(text)) { score += 0.15; details.branchCode = true; }
    // ABSA ChequeCard / TransactPlus account types
    if (/cheque(?:card)?|transact\s*plus|gold\s*value/i.test(header)) { score += 0.1; details.accountType = true; }

    return { confidence: Math.min(score, 1.0), details };
  }

  // ── Main parse ──────────────────────────────────────────────────────────────

  static parse(text, filename = '') {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber  = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    const rawLines = this.toLines(text);

    // Join continuation lines (description wrapped to next line) before parsing
    const lines = this.joinContinuationLines(rawLines, l => ANY_DATE_RE.test(l));

    // Detect primary layout from header section (first 40 lines)
    const layoutHint = this._detectLayout(lines.slice(0, 40));
    if (layoutHint) {
      result.warnings.push(`Detected ABSA layout: ${layoutHint}`);
    }

    for (const line of lines) {
      if (this.isPageNoise(line)) continue;
      if (!ANY_DATE_RE.test(line))  continue;

      const lower = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lower.includes(k))) { result.skippedLines++; continue; }

      const txn = this._parseLine(line);
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
        'No transactions extracted from this ABSA statement. ' +
        'The statement may use an unsupported layout variant. ' +
        'Try the CSV export from ABSA Internet Banking as an alternative.'
      );
    }

    return result;
  }

  // ── Layout detection ────────────────────────────────────────────────────────

  static _detectLayout(lines) {
    for (const line of lines) {
      const l = line.toLowerCase();
      if (/\bdebit\b.+\bcredit\b.+\bbalance\b/.test(l)) return 'A (Debit/Credit columns)';
      if (/\bamount\b.+\bbalance\b/.test(l))             return 'B/C (Amount/Balance)';
    }
    return null;
  }

  // ── Line parser — tries all layouts in priority order ─────────────────────

  static _parseLine(line) {
    // Layout B first (DR/Cr suffix is the most unambiguous signal)
    let m = line.match(RE_LAYOUT_B);
    if (m) {
      const date  = this.parseDate(m[1]);
      const desc  = m[2].trim();
      const amt   = this.parseAmount(m[3] + ' ' + m[4]); // includes suffix
      const bal   = this.parseAmount(m[5]);
      if (date && amt !== null) return { date, description: desc, reference: null, amount: amt, balance: bal, rawLine: line };
    }

    // Layout E (bracket negatives)
    m = line.match(RE_LAYOUT_E);
    if (m) {
      const date = this.parseDate(m[1]);
      const desc = m[2].trim();
      const amt  = this.parseAmount(m[3]); // parseAmount handles brackets → negative
      const bal  = this.parseAmount(m[4]);
      if (date && amt !== null) return { date, description: desc, reference: null, amount: amt, balance: bal, rawLine: line };
    }

    // Layout A (debit/credit columns — most common ABSA Internet Banking format)
    m = line.match(RE_LAYOUT_A);
    if (m) {
      const date      = this.parseDate(m[1]);
      const desc      = m[2].trim();
      const debitStr  = m[3].trim();
      const creditStr = m[4].trim();
      const bal       = this.parseAmount(m[5]);

      if (!date) return null;

      let amount = null;
      // Credit column populated → money in (positive)
      if (creditStr && creditStr !== '-' && creditStr !== '') {
        amount = Math.abs(this.parseAmount(creditStr) ?? 0) || null;
        if (amount === 0) amount = null;
      }
      // Debit column populated → money out (negative)
      if (amount === null && debitStr && debitStr !== '-' && debitStr !== '') {
        const d = this.parseAmount(debitStr);
        if (d !== null && d !== 0) amount = -Math.abs(d);
      }

      if (amount !== null) return { date, description: desc, reference: null, amount, balance: bal, rawLine: line };
    }

    // Layout C (signed single amount)
    m = line.match(RE_LAYOUT_C);
    if (m) {
      const date = this.parseDate(m[1]);
      const desc = m[2].trim();
      const amt  = this.parseAmount(m[3]);
      const bal  = this.parseAmount(m[4]);
      if (date && amt !== null) return { date, description: desc, reference: null, amount: amt, balance: bal, rawLine: line };
    }

    // Layout D (month-name dates)
    m = line.match(RE_LAYOUT_D);
    if (m) {
      const date = this.parseDate(m[1]);
      const desc = m[2].trim();
      const amt  = this.parseAmount(m[3]);
      const bal  = m[4] ? this.parseAmount(m[4]) : null;
      if (date && amt !== null) return { date, description: desc, reference: null, amount: amt, balance: bal, rawLine: line };
    }

    return null;
  }
}

module.exports = ABSAParser;
