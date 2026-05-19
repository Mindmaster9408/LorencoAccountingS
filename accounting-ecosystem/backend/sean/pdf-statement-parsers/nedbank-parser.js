/**
 * ============================================================================
 * Nedbank PDF Statement Parser
 * ============================================================================
 * Supports two layout variants:
 *
 * 1. eConfirm English — "Opening balance" / "Closing balance"
 *    Columns: Tran-list-no | Date | Description | Amount | Balance
 *
 * 2. Geldmark / Afrikaans eConfirm — "Beginsaldo" / "Eindsaldo"
 *    Columns: Tran-lys-nr | Datum | Beskrywing | Geld (R) | Debiete (R) | Krediete (R) | Saldo (R)
 *
 * Key parsing challenges for the Afrikaans variant:
 *   A. "Beginsaldo" must be recognised and used to seed prevBalance — without it,
 *      the first real transaction has no prevBalance for delta-based sign detection.
 *   B. "Eindsaldo 214,602.17" (undated, end of transaction table) must NOT be
 *      appended to the preceding transaction line by joinContinuationLines.
 *   C. Debiete (R) and Krediete (R) both render as bare amounts in extracted text —
 *      balance delta is the only reliable debit/credit discriminator.
 *   D. Amounts may carry a trailing asterisk (*) marking bank charges; the
 *      AMT_TOKEN_RE ignores it correctly as non-numeric noise.
 *   E. JB Marks 38385 style rows carry a Geld (R) column value plus a Debiete value.
 *      The balance-delta on the second-to-last token gives the correct net debit.
 *
 * Parsing strategy: right-side amount scanning with balance-delta debit/credit detection.
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// Prefer 4-digit year first — prevents DD/MM/2025 matching as DD/MM/20 (2-digit year)
const DATE_RE = /^\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})/;
// Strict amount token regex — comma-only thousands separators prevent false matches
// like "02 7.80" or "0087999451 7.80" being consumed as a single token.
const AMT_TOKEN_RE = /(?:R\s*)?(?:\(\d+(?:,\d{3})*\.\d{2}\)|[-]?\s*\d+(?:,\d{3})*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

// English balance keywords (eConfirm format)
const SKIP_KEYWORDS_EN = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'total', 'subtotal'
];
// Afrikaans balance keywords (Geldmark / Afrikaans eConfirm format)
const SKIP_KEYWORDS_AF = ['beginsaldo', 'eindsaldo'];
const ALL_SKIP_KEYWORDS = [...SKIP_KEYWORDS_EN, ...SKIP_KEYWORDS_AF];

const CREDIT_RE = /\b(?:received|deposit|salary|credit|transfer\s+in|payment\s+from|refund|reversal)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|fee|charge|levy)\b/i;

class NedbankParser extends BaseParser {

  static get PARSER_ID() { return 'nedbank-v1'; }
  static get BANK_NAME() { return 'Nedbank'; }

  static canParse(text, filename = '') {
    if (/nedbank|nedgroup/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }
    // Scan a wider slice — Nedbank Afrikaans PDFs may have branding deep in page 1
    const header = text.slice(0, 1500).toLowerCase();
    let score = 0;
    const details = {};
    if (header.includes('nedbank'))      { score += 0.6; details.name = true; }
    if (header.includes('nedgroup'))     { score += 0.2; details.nedgroup = true; }
    if (/branch\s*code\s*[:\s]+19\d{4}/i.test(text)) { score += 0.2; details.branchCode = true; }
    // Afrikaans Nedbank fingerprints (Geldmark / Afrikaans eConfirm format)
    if (header.includes('tran-lys-nr'))      { score += 0.4; details.tranLysNr = true; }
    if (header.includes('geldmark'))         { score += 0.2; details.geldmark = true; }
    if (header.includes('beginsaldo'))       { score += 0.2; details.beginsaldo = true; }
    if (header.includes('sien geld anders')) { score += 0.3; details.sienGeldAnders = true; }
    if (header.includes('rekeningnommer'))   { score += 0.1; details.rekeningnommer = true; }
    return { confidence: Math.min(score, 1.0), details };
  }

  // Nedbank eConfirm format has optional "Tran list no" column before the date:
  // e.g.  "000091 12/02/2025 Notification Fee: E-mail 0.50 8,439.77"
  static _TRAN_NO_RE = /^\d{4,6}\s+(?=\d{1,2}\/\d{1,2}\/)/;

  // Afrikaans balance lines — used in isStart to prevent them from being appended
  // to the preceding dated transaction line by joinContinuationLines.
  // "Eindsaldo 214,602.17" has NO date prefix, so without this it would be
  // concatenated onto the last real transaction and corrupt its amount parsing.
  static _AFRIKAANS_BAL_RE = /\b(?:beginsaldo|eindsaldo)\b/i;

  // ── Afrikaans extraction helpers ──────────────────────────────────────────

  /**
   * Extract opening balance from the Afrikaans "Beginsaldo" line.
   * Handles both the dated transaction-table form ("01/03/2023 Beginsaldo 292,147.92")
   * and the undated summary form ("Beginsaldo R292,147.92").
   */
  static _extractOpeningBalanceAF(text) {
    // Dated form (transaction table): "01/03/2023 Beginsaldo 292,147.92"
    const m = text.match(/\d{1,2}\/\d{1,2}\/\d{4}\s+Beginsaldo\s+([\d,]+\.\d{2})/i);
    if (m) return this.parseAmount(m[1]);
    // Undated summary form: "Beginsaldo R292,147.92"
    const m2 = text.match(/Beginsaldo\s+(R?\s*[\d,]+\.\d{2})/i);
    if (m2) return this.parseAmount(m2[1]);
    return null;
  }

  /**
   * Extract closing balance from the Afrikaans "Eindsaldo" line.
   */
  static _extractClosingBalanceAF(text) {
    const m = text.match(/Eindsaldo\s+(R?\s*[\d,]+\.\d{2})/i);
    if (m) return this.parseAmount(m[1]);
    return null;
  }

  /**
   * Extract account number from Afrikaans "Rekeningnommer" or "Geldmark NNNNNN" form.
   */
  static _extractAccountNumberAF(text) {
    const m = text.match(/Rekeningnommer\s+(\d{8,12})/i);
    if (m) return m[1];
    const m2 = text.match(/Geldmark\s+(\d{8,12})/i);
    if (m2) return m2[1];
    return null;
  }

  /**
   * Extract statement period from Afrikaans "Tydperk van staat: DD/MM/YYYY – DD/MM/YYYY".
   */
  static _extractPeriodAF(text) {
    // NOTE: 4-digit year must come first in the alternation — (?:\d{4}|\d{2}) — otherwise
    // "2023" would match as 2-digit year "20", giving the wrong year (2020 instead of 2023).
    const DATE_PAT = /\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})/;
    const m = text.match(
      new RegExp(
        `Tydperk\\s+van\\s+staat\\s*[:\\s]+(${DATE_PAT.source})\\s*[–\\-]\\s*(${DATE_PAT.source})`,
        'i'
      )
    );
    if (m) return { from: this.parseDate(m[1]), to: this.parseDate(m[2]) };
    return null;
  }

  /**
   * Extract stated total credits/debits from the Afrikaans summary section.
   * Matches "Fondse ontvang/Krediete R11,145.72" and "Fondse gebruik/Debiete R88,691.47"
   * in either the short or "Totale fondse" long-form labels.
   */
  static _extractAfrikaansTotals(text) {
    const totals = {};
    const credMatch = text.match(
      /(?:fondse\s+ontvang|totale\s+fondse\s+ontvang)[^\d]+([\d,]+\.\d{2})/i
    );
    if (credMatch) totals.statedCredits = this.parseAmount(credMatch[1]);
    const debMatch = text.match(
      /(?:fondse\s+gebruik|totale\s+fondse\s+gebruik)[^\d]+([\d,]+\.\d{2})/i
    );
    if (debMatch) totals.statedDebits = this.parseAmount(debMatch[1]);
    return totals;
  }

  // ── Main parse entry point ─────────────────────────────────────────────────

  static parse(text, filename = '') {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);

    // Account number: English label first, fall back to Afrikaans
    result.accountNumber = this.extractAccountNumber(text) || this._extractAccountNumberAF(text);

    // Statement period: English label first, fall back to Afrikaans
    const engPeriod = this.extractPeriod(text);
    const afPeriod  = this._extractPeriodAF(text);
    result.statementPeriod = (engPeriod.from || engPeriod.to) ? engPeriod : (afPeriod || { from: null, to: null });

    // Pre-seed prevBalance from Afrikaans "Beginsaldo" (CRITICAL for first transaction).
    // Without this, the first real transaction has no prevBalance for balance-delta
    // sign detection and falls back to English keyword guessing (_sign()), which
    // returns the wrong sign for Afrikaans descriptions like "J Turkstra 2".
    const afrikaansOpeningBal = this._extractOpeningBalanceAF(text);

    // isStart: date lines, tran-list-no lines, English balance lines, AND Afrikaans
    // balance lines.  The last item is critical: "Eindsaldo 214,602.17" has no date
    // prefix — without _AFRIKAANS_BAL_RE it would be appended by joinContinuationLines
    // onto the preceding dated transaction, corrupting its amount extraction.
    const BALANCE_LINE_RE = /\b(?:opening|closing)\s+balance\b/i;
    const isStart = l =>
      DATE_RE.test(l) ||
      this._TRAN_NO_RE.test(l) ||
      BALANCE_LINE_RE.test(l) ||
      this._AFRIKAANS_BAL_RE.test(l);

    const lines = this.joinContinuationLines(this.toLines(text), isStart);
    let prevBalance = afrikaansOpeningBal; // null if not an Afrikaans format statement

    for (let line of lines) {
      if (this.isPageNoise(line)) continue;

      // Strip optional tran-list-no prefix so date is at position 0
      line = line.replace(this._TRAN_NO_RE, '');

      if (!DATE_RE.test(line)) continue;

      const lower = line.toLowerCase();

      // Balance lines (English or Afrikaans): capture running balance, do not add as transaction
      if (ALL_SKIP_KEYWORDS.some(k => lower.includes(k))) {
        const bal = this._lastAmt(line);
        if (bal !== null) prevBalance = bal;
        result.skippedLines++;
        continue;
      }

      const txn = this._parseLine(line, prevBalance);
      if (!txn) { result.skippedLines++; continue; }
      if (txn.balance !== null) prevBalance = txn.balance;

      // Skip zero-amount annotation rows (e.g. "BTW 24/02-27/03 = R0.42 0.00 ...")
      if (txn.amount === 0) {
        result.warnings.push(`Skipped zero-amount annotation row: ${line.slice(0, 80)}`);
        result.skippedLines++;
        continue;
      }

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
        'No transactions extracted from this Nedbank statement. ' +
        'The statement may use an unsupported layout variant.'
      );
    }

    // ── Post-parse validation against Afrikaans statement summary totals ──────
    const afTotals = this._extractAfrikaansTotals(text);
    if (afTotals.statedCredits !== undefined || afTotals.statedDebits !== undefined) {
      const parsedCredits = result.transactions
        .filter(t => t.amount > 0)
        .reduce((s, t) => s + t.amount, 0);
      const parsedDebits = result.transactions
        .filter(t => t.amount < 0)
        .reduce((s, t) => s + Math.abs(t.amount), 0);

      if (afTotals.statedCredits !== undefined) {
        const diff = Math.abs(parsedCredits - afTotals.statedCredits);
        if (diff > 0.05) {
          result.warnings.push(
            `Total credits mismatch: parsed ${parsedCredits.toFixed(2)}, ` +
            `stated ${afTotals.statedCredits.toFixed(2)} (diff ${diff.toFixed(2)})`
          );
        }
      }
      if (afTotals.statedDebits !== undefined) {
        const diff = Math.abs(parsedDebits - afTotals.statedDebits);
        if (diff > 0.05) {
          result.warnings.push(
            `Total debits mismatch: parsed ${parsedDebits.toFixed(2)}, ` +
            `stated ${afTotals.statedDebits.toFixed(2)} (diff ${diff.toFixed(2)})`
          );
        }
      }
    }

    // ── Closing balance cross-check ────────────────────────────────────────────
    const statedClosing = this._extractClosingBalanceAF(text);
    if (statedClosing !== null && result.transactions.length > 0) {
      const lastBalance = result.transactions[result.transactions.length - 1].balance;
      if (lastBalance !== null && Math.abs(lastBalance - statedClosing) > 0.02) {
        result.warnings.push(
          `Closing balance mismatch: last parsed balance ${lastBalance.toFixed(2)}, ` +
          `stated Eindsaldo ${statedClosing.toFixed(2)}`
        );
      }
    }

    return result;
  }

  static _parseLine(line, prevBalance) {
    const dateMatch = line.match(/^(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))/);
    if (!dateMatch) return null;
    const date = this.parseDate(dateMatch[1]);
    if (!date) return null;
    const rest = line.slice(dateMatch[0].length).trim();

    AMT_TOKEN_RE.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = AMT_TOKEN_RE.exec(rest)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) tokens.push({ raw: m[0].trim(), value: v, start: m.index, end: m.index + m[0].length });
    }
    if (tokens.length < 2) return null;

    let description = rest.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description) return null;
    const afterLast = rest.slice(tokens[tokens.length - 1].end).trim();
    if (afterLast) description = (description + ' ' + afterLast).trim();

    const balance = tokens[tokens.length - 1].value;
    const rawAmt  = tokens[tokens.length - 2].value;
    const rawTok  = tokens[tokens.length - 2].raw;

    let amount;
    const hasSuffix = /[Dd][Rr]?|[Cc][Rr]/i.test(rawTok);
    const hasMinus  = rawTok.startsWith('-') || rawTok.startsWith('(');

    if (hasSuffix || hasMinus) {
      amount = rawAmt;
    } else if (prevBalance !== null) {
      const delta = balance - prevBalance;
      if (Math.abs(Math.abs(delta) - Math.abs(rawAmt)) < 0.02) {
        amount = delta >= 0 ? Math.abs(rawAmt) : -Math.abs(rawAmt);
      } else {
        amount = this._sign(rawAmt, description);
      }
    } else {
      amount = this._sign(rawAmt, description);
    }

    return { date, description, reference: null, amount, balance, rawLine: line };
  }

  static _sign(amt, desc) {
    if (DEBIT_RE.test(desc))  return -Math.abs(amt);
    if (CREDIT_RE.test(desc)) return  Math.abs(amt);
    return Math.abs(amt);
  }

  static _lastAmt(line) {
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

module.exports = NedbankParser;
