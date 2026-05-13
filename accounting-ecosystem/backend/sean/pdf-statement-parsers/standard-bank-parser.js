/**
 * ============================================================================
 * Standard Bank PDF Statement Parser
 * ============================================================================
 * Supports two date formats:
 *   - DD Mon YY / DD Mon YYYY  (e.g. "27 Nov 24" or "27 Nov 2024")  — primary for 3-month statements
 *   - YYYY/MM/DD                                                     — legacy format
 *
 * Column layout: Payments | Deposits | Balance  (NOT Debit/Credit)
 *
 * Parsing strategy: block-based — date line starts a block, following lines
 * are collected until the next date line. Amounts extracted from combined text.
 * ============================================================================
 */

'use strict';

const BaseParser = require('./base-parser');

// ─── Date patterns ────────────────────────────────────────────────────────────
// Primary format for 3-month statements: DD Mon YY or DD Mon YYYY  (e.g. "27 Nov 24" or "27 Nov 2024")
// NOTE: no trailing (?:\s|$) — real PDFs concatenate date+description with no space (e.g. "27 Nov 24DF CTOTS")
const DATE_RE_MON = /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4}/i;
// Legacy format: YYYY/MM/DD only — DD/MM/YYYY removed because it matches print/generation dates
const DATE_RE_NUM = /^\d{4}\/\d{2}\/\d{2}/;

// Amount token — handles comma/space thousands, brackets, minus, DR/CR suffix, R prefix
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|[-]?\s*\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr])?/g;

// Month map for DD Mon YY parsing
const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

// Lines that start a transaction-like block but must be skipped
const SKIP_KEYWORDS = [
  'statement opening balance', 'opening balance', 'closing balance',
  'balance brought', 'balance carried'
];

// Regex patterns for lines that are page noise between transaction blocks
const BLOCK_NOISE_RE = [
  /^customer\s+care\s*:/i,
  /^website\s*:\s*www\./i,
  /^the\s+standard\s+bank\s+of\s+south\s+africa/i,
  /^we\s+subscribe\s+to\s+the\s+code/i,
  /^pg\s+\d+\s+of\s*\d+/i,                // "Pg 1 of 3" — with space
  /^\d+\s+pg\s+\d+\s+of\s*\d+/i,          // "051001 Pg 1 of3" — account number prefix + no space before page count
  /^transaction\s+details/i,
  /^available\s+balance\s*:/i,
  /^account\s+(?:number|holder|name|type)/i,
  /^product\s+name/i,
  /^statement\s+opening\s+balance/i,
  /^date\s*description\s*payments/i,        // handles both spaced and merged ("DateDescriptionPayments")
  /^3\s+month\s+statement/i,
  /^from\s*:\s/i,
  /^to\s*:\s/i,
];

// Section end — everything after "Statement Summary" is not a transaction
const SECTION_END_RE = /^statement\s+summary/i;

// Keyword heuristics for signing amounts when balance-delta method can't be used
const CREDIT_RE = /\b(?:payment\s+received|deposit|salary|credit|transfer\s+in|proceeds|refund|reversal|magtape\s+credit)\b/i;
const DEBIT_RE  = /\b(?:debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|fee|charge|levy|authorisation)\b/i;

class StandardBankParser extends BaseParser {

  static get PARSER_ID() { return 'standardbank-v1'; }
  static get BANK_NAME() { return 'Standard Bank'; }

  // ─── Detection ──────────────────────────────────────────────────────────────
  static canParse(text, filename = '') {
    if (/standard.?bank|stanbic/i.test(filename)) {
      return { confidence: 0.7, details: { filename: true } };
    }
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    const details = {};
    if (header.includes('the standard bank of south africa')) { score += 0.7; details.fullName = true; }
    else if (header.includes('standard bank'))               { score += 0.55; details.name = true; }
    if (header.includes('stanbic'))                         { score += 0.3;  details.stanbic = true; }
    if (/branch\s*code\s*[:\s]+05\d{4}/i.test(text))       { score += 0.1;  details.branchCode = true; }
    const yyyyCount  = (text.match(/\b\d{4}\/\d{2}\/\d{2}\b/g) || []).length;
    const ddMonCount = (text.match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4}\b/gi) || []).length;
    if (yyyyCount > 3 || ddMonCount > 3) { score += 0.1; details.dateFormat = yyyyCount > 3 ? 'YYYY/MM/DD' : 'DD Mon YY(YY)'; }
    if (/payments\s+deposits\s+balance/i.test(text)) { score += 0.15; details.columnHeader = true; }
    return { confidence: Math.min(score, 1.0), details };
  }

  // ─── Entry point ────────────────────────────────────────────────────────────
  static parse(text, filename = '') {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this._extractPeriodSB(text);

    const allLines = this.toLines(text);
    const blocks   = this._buildBlocks(allLines, result);

    let prevBalance = null;
    for (const block of blocks) {
      const txn = this._parseBlock(block, prevBalance);
      if (!txn) {
        result.skippedLines++;
        result.warnings.push(`[skip] No txn from block: ${block[0].slice(0, 120)}`);
        continue;
      }
      if (txn.balance !== null) prevBalance = txn.balance;
      const warns = this.validateTransaction(txn);
      if (warns.length === 0) {
        result.transactions.push(txn);
      } else {
        result.warnings.push(`Skipped (${warns.join(', ')}): ${block[0].slice(0, 100)}`);
        result.skippedLines++;
      }
    }

    return result;
  }

  // ─── Block builder ──────────────────────────────────────────────────────────
  // Groups raw lines into transaction blocks. Each block starts with a date line
  // and accumulates the following non-date lines (description/amount continuation).
  static _buildBlocks(lines, result) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (SECTION_END_RE.test(line)) break;

      if (!this._isDateLine(line)) { i++; continue; }

      const lower = line.toLowerCase();
      if (SKIP_KEYWORDS.some(k => lower.includes(k))) {
        i++;
        result.skippedLines++;
        continue;
      }

      const block = [line];
      i++;

      while (i < lines.length) {
        const next = lines[i];
        if (SECTION_END_RE.test(next)) break;
        if (this._isDateLine(next)) break;
        if (!this._isBlockNoise(next)) {
          block.push(next);
        }
        i++;
      }

      blocks.push(block);
    }
    return blocks;
  }

  // ─── Block parser ───────────────────────────────────────────────────────────
  static _parseBlock(block, prevBalance) {
    const firstLine = block[0];

    const dateStr = this._extractDateStr(firstLine);
    if (!dateStr) return null;
    const date = this._parseDateStr(dateStr);
    if (!date) return null;

    const dateEnd    = dateStr.length;
    const firstTail  = firstLine.slice(dateEnd).trim();
    const continuations = block.slice(1).map(l => l.trim()).filter(Boolean);
    const combined   = [firstTail, ...continuations].join(' ').trim();

    AMT_TOKEN_RE.lastIndex = 0;
    const tokens = [];
    let m;
    while ((m = AMT_TOKEN_RE.exec(combined)) !== null) {
      const v = this.parseAmount(m[0]);
      if (v !== null) tokens.push({ raw: m[0].trim(), value: v, start: m.index, end: m.index + m[0].length });
    }
    if (tokens.length < 2) return null;

    const balance = tokens[tokens.length - 1].value;
    const rawAmt  = tokens[tokens.length - 2].value;
    const rawTok  = tokens[tokens.length - 2].raw;

    let description = combined.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description && tokens.length > 2) {
      description = combined.slice(tokens[0].end, tokens[tokens.length - 2].start).trim();
    }
    const afterLast = combined.slice(tokens[tokens.length - 1].end).trim();
    if (afterLast) description = (description + ' ' + afterLast).trim();
    if (!description) return null;

    // Amount signing
    const hasMinus  = rawTok.startsWith('-') || rawTok.startsWith('(');
    const hasSuffix = /[Dd][Rr]?|[Cc][Rr]/i.test(rawTok);
    let amount;
    if (hasMinus || hasSuffix) {
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

    return { date, description, reference: null, amount, balance, rawLine: block.join(' | ') };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  static _isDateLine(line) {
    return DATE_RE_MON.test(line) || DATE_RE_NUM.test(line);
  }

  static _isBlockNoise(line) {
    if (this.isPageNoise(line)) return true;
    return BLOCK_NOISE_RE.some(re => re.test(line));
  }

  static _extractDateStr(line) {
    // No trailing (?:\s|$) — real PDFs may concatenate date+description with no space
    let m = line.match(/^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4})/i);
    if (m) return m[1];
    m = line.match(/^(\d{4}\/\d{2}\/\d{2}|\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))/);
    if (m) return m[1];
    return null;
  }

  // Handles DD Mon YY (2-digit year) and DD Mon YYYY (4-digit year)
  static _parseDateStr(str) {
    const m = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/i);
    if (m) {
      const mo = MONTH_MAP[m[2].toLowerCase()];
      if (mo) {
        let year;
        if (m[3].length === 4) {
          year = m[3]; // full year — no pivot needed
        } else {
          const yr = parseInt(m[3], 10);
          year = yr >= 50 ? `19${m[3].padStart(2, '0')}` : `20${m[3].padStart(2, '0')}`;
        }
        return `${year}-${mo}-${m[1].padStart(2, '0')}`;
      }
    }
    return BaseParser.parseDate(str);
  }

  static _sign(amt, desc) {
    if (DEBIT_RE.test(desc))  return -Math.abs(amt);
    if (CREDIT_RE.test(desc)) return  Math.abs(amt);
    return Math.abs(amt);
  }

  // Period extraction that also handles "From: DD Mon YY(YY)" header format
  static _extractPeriodSB(text) {
    const base = this.extractPeriod(text);
    if (base.from && base.to) return base;
    const fromM = text.match(/from\s*:\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/i);
    const toM   = text.match(/to\s*:\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/i);
    return {
      from: fromM ? this._parseDateStr(fromM[1]) : null,
      to:   toM   ? this._parseDateStr(toM[1])   : null
    };
  }
}

module.exports = StandardBankParser;
