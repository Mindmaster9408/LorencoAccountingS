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
//          optional trailing DR/Db/CR/Cr suffix OR trailing minus sign.
// Trailing minus ("1 116.33-") is how Absa prints negative (overdraft) balances.
// Key: we only match numbers that have a decimal point — this excludes
// reference numbers and account numbers (which are integers).
// A leading minus only counts when it touches the digits: a lone "-" in an
// empty Debit/Credit column ("-     6000.00") is a placeholder, not a sign.
const AMT_TOKEN_RE = /(?:R\s*)?(?:\([\d]+(?:[,\s]\d{3})*\.\d{2}\)|-?\d[\d,\s]*\.\d{2})\s*(?:[Dd][Rb]?|[Cc][Rr]|-)?/g;

// ── Lines to always skip ─────────────────────────────────────────────────────
const SKIP_KEYWORDS = [
  'opening balance', 'closing balance', 'balance brought',
  'balance carried', 'sub-total', 'total fees', 'total debit',
  'total credit', 'interest charged', 'service fee',
  'carry forward', 'brought forward'
];

// ── "Transaction history" layout (savings / investment, e.g. BizStart,
//    Liquidity Plus): decimal comma, space thousands, debit = trailing "-",
//    columns "date | description | transaction amount R | balance R". ────────
const HIST_LAYOUT_RE  = /date\s*description\s*transaction\s+amount\s+R\s*balance\s+R/i;
const HIST_DATE_RE    = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})/;
const HIST_PERIOD_RE  = /^\d{1,2} [A-Za-z]{3} \d{4}\s*to\s*\d{1,2} [A-Za-z]{3} \d{4}$/;
const HIST_AMT        = '(\\d{1,3}(?: \\d{3})*,\\d{2})(-?)';
const HIST_TWO_AMT_RE = new RegExp(`^(.*?)${HIST_AMT}${HIST_AMT}$`);
const HIST_ONE_AMT_RE = new RegExp(`^(.*?)${HIST_AMT}$`);
// Page header/footer text that must not be glued onto a transaction
const HIST_NOISE_RE = [
  /please\s+turn\s+over/i, /^date\s*description/i, /^dgp\d/i, /^absa\s+bank\s+limited/i,
  /^transaction\s+history/i, /page\s*\d+\s*of\s*\d+/i, /statement$/i, /^account\s+(?:number|summary)/i,
  /^statement\s+number/i, /^if\s+entries\s+on\s+this\s+statement/i, /^this\s+will\s+expedite/i,
  /currency\s+conversion/i, /international/i, /^important$/i, /^return\s+address/i,
  /^our\s+privacy\s+notice/i, /^registration\s+number/i, /^vat\s+registration/i,
];
const HIST_MAX_DETAIL_LINES = 3;

// ── Cheque-statement footer lines (pricing / interest summary) ──────────────
// "SERVICE FEE: 200.00/0.00/200.00 …" starts the block; everything after it up
// to the next dated line is footer. The other patterns catch stray lines.
const FOOTER_START_RE = /^service\s+fee\s*:/i;
const FOOTER_RE = [
  FOOTER_START_RE,
  /^(?:credit|debit|excess)\s+interest\s+rate\b/i,
  /^\*\s*=\s*vat\b/i,                       // "* = VAT R549.52- INCLUDED"
  /^charge\s*:\s*[A-Z]\s*=/i,               // "CHARGE:   A = ADMINISTRATION …"
];

// ── Description keywords used for sign heuristic ────────────────────────────
const CREDIT_RE = /\b(?:received|deposit|salary|credit|payment\s+from|transfer\s+in|proceeds|refund|reversal|interest\s+paid|cashback|crsettlement|crkrediet)\b/i;
// "Acb Debit" / "Acb Db" — bare \bdebit\b catches Absa's "Debit:" prefix style
const DEBIT_RE  = /\b(?:debit|debit\s+order|purchase|withdrawal|payment\s+to|transfer\s+to|atm|levy|fee|charge|subscription|acb\s+db)\b/i;

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
    if (HIST_LAYOUT_RE.test(text)) return this._parseHistoryLayout(text);

    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    result.accountNumber   = this.extractAccountNumber(text);
    result.statementPeriod = this.extractPeriod(text);

    // Drop statement-footer lines BEFORE joining, otherwise they are appended to
    // the last transaction and their numbers/keywords corrupt or drop it
    // (Turkstra, Mar 2026: "SERVICE FEE: 200.00/0.00/200.00" after the last line).
    let inFooter = false;
    const rawLines = this.toLines(text).filter(l => {
      if (ANY_DATE_RE.test(l)) inFooter = false;
      else if (FOOTER_START_RE.test(l)) inFooter = true;
      return !inFooter && !FOOTER_RE.some(re => re.test(l));
    });
    const lines    = this.joinContinuationLines(rawLines, l => ANY_DATE_RE.test(l));

    let prevBalance = null; // tracked for balance-delta sign resolution
    let chargeOnlyLines = 0;

    for (const line of lines) {
      // Only dated lines can be transactions. No isPageNoise() here: a joined
      // line also carries its continuation text, and a genuine transaction
      // must not be dropped because that text mentions e.g. "VAT on".
      if (!ANY_DATE_RE.test(line))  continue;

      // Summary keywords are matched on the line's own description only
      // (text before the first amount), never on appended continuation text.
      const dateLen = line.match(ANY_DATE_RE)[0].length;
      AMT_TOKEN_RE.lastIndex = 0;
      const firstAmt = AMT_TOKEN_RE.exec(line.slice(dateLen));
      const head = firstAmt ? line.slice(0, dateLen + firstAmt.index) : line;
      const lower = head.toLowerCase();
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
      if (txn.chargeOnly) { chargeOnlyLines++; continue; }

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

    // Business cheque statements print the closing balance as "Balance10 296,97"
    // (decimal comma) in the header block — a missed line shows up here.
    const closing = text.match(/^Balance(\d{1,3}(?: \d{3})*,\d{2})(-?)$/m);
    if (closing && prevBalance !== null) {
      const v = Number(closing[1].replace(/ /g, '').replace(',', '.')) * (closing[2] === '-' ? -1 : 1);
      if (Math.abs(v - prevBalance) > 0.005) {
        result.warnings.push(
          `Closing balance on statement is ${v.toFixed(2)} but the last imported line shows ${prevBalance.toFixed(2)} — a line may have been missed.`
        );
      }
    }

    if (chargeOnlyLines > 0) {
      result.warnings.push(
        `${chargeOnlyLines} charge-only line(s) not imported — they do not move the balance; ` +
        'Absa bills these charges later as a single "Transaction Charge" line, which is imported.'
      );
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

    // 2b. Business statements have a Charge column before Debit/Credit. A charge
    //     carries a charge-type letter glued to it ("1.25A", "10.00T") and does
    //     NOT move the balance on that line — Absa bills the accrued charges
    //     later as one "Transaction Charge" line. Drop it from the amounts.
    //     A line left with only a balance is a charge-only line: no movement.
    if (tokens.length >= 2 && /^[A-Z](?![a-z])/.test(rest.slice(tokens[0].end))) {
      tokens.shift();
      if (tokens.length === 1) return { chargeOnly: true };
    }

    // 3. Description = text before the FIRST amount token.
    //    Strip trailing dashes/spaces (the "-" dash in empty columns).
    let description = rest.slice(0, tokens[0].start).replace(/[\s\-]+$/, '').trim();
    if (!description) return null;

    // 3b. Continuation sub-lines (counterparty account number, name, etc.) are
    //     appended by joinContinuationLines AFTER the amounts in the joined string.
    //     Re-attach them to the description so the user can identify the transaction.
    //     e.g. "... 20 000.00 18 883.67 4071730751 Absa Bank Tjekrek 2" →
    //          description += " 4071730751 Absa Bank Tjekrek 2"
    const afterLast = rest.slice(tokens[tokens.length - 1].end).trim();
    if (afterLast) description = (description + ' ' + afterLast).trim();

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

    // Check whether parseAmount already embedded a sign from DR/Cr suffix or trailing minus
    const hasSuffix = /[Dd][Rr]?|[Cc][Rr]/i.test(rawToken);
    const hasLeadingMinus = rawToken.startsWith('-') || rawToken.startsWith('(');
    const hasTrailingMinus = rawToken.trimEnd().endsWith('-');

    if (hasSuffix || hasLeadingMinus || hasTrailingMinus) {
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

  // ── "Transaction history" layout (savings / investment) ─────────────────────

  /**
   * A transaction is a GROUP: a dated line, optionally followed by undated
   * sub-lines that carry their own amount + balance (fees). The dated line may
   * have an amount without a balance, or no amount at all:
   *   1 Jun 2026Cardless Cash Deposit3 100,00     ← deposit, no balance
   *   Cash Deposit Fee48,30-3 407,77              ← fee, balance after both
   *   3 Jun 2026Administration Fee                ← header only
   *   Administration Fee115,00-17 295,88          ← the actual fee
   *   2 Jun 2026Direct Credit2 781,0013 870,87    ← normal line
   *   Ons Hoop Volkskool                          ← detail line
   */
  static _parseHistoryLayout(text) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    const acct = text.match(/account\s+number\s*(\d[\d ]{6,}\d)/i);
    result.accountNumber = acct ? acct[1].replace(/\s+/g, '') : this.extractAccountNumber(text);

    const lines = this.toLines(text);
    const periodLine = lines.find(l => HIST_PERIOD_RE.test(l));
    if (periodLine) {
      const [from, to] = periodLine.split(/\s*to\s*/i);
      result.statementPeriod = { from: this._histDate(from), to: this._histDate(to) };
    }

    const num = (digits, minus) => {
      const v = Number(digits.replace(/ /g, '').replace(',', '.'));
      return minus === '-' ? -v : v;
    };
    const isNoise = l => HIST_NOISE_RE.some(re => re.test(l));

    let prevBalance = null;
    let started = false;
    let group = null;          // { date, desc, amount|null, subs: [], details: [] }
    let detailCount = 0;

    const flush = () => {
      if (!group) return;
      const out = [];
      if (group.amount !== null) {
        const balance = group.subs.length
          ? Math.round((group.subs[0].balance - group.subs[0].amount) * 100) / 100
          : (prevBalance !== null ? Math.round((prevBalance + group.amount) * 100) / 100 : null);
        out.push({ desc: group.desc, amount: group.amount, balance });
      }
      out.push(...group.subs);
      if (out.length === 0) {
        result.skippedLines++;
        result.warnings.push(`[skip] No amount found for: ${group.desc.slice(0, 80)}`);
      }
      const detail = group.details.join(' ');
      out.forEach((t, i) => {
        const description = (i === 0 && detail ? `${t.desc} ${detail}` : t.desc).replace(/\s+/g, ' ').trim();
        if (prevBalance !== null && t.balance !== null && Math.abs(prevBalance + t.amount - t.balance) > 0.005) {
          result.warnings.push(
            `Balance check failed on ${group.date} "${description.slice(0, 60)}": ` +
            `${prevBalance.toFixed(2)} + ${t.amount.toFixed(2)} ≠ ${t.balance.toFixed(2)} — a line may have been misread.`
          );
        }
        if (t.balance !== null) prevBalance = t.balance;
        result.transactions.push({
          date: group.date, description, reference: null, amount: t.amount, balance: t.balance,
          rawLine: group.raw.join(' | ')
        });
      });
      group = null;
    };

    // Two-amount line: the balance is unambiguous, but the amount's start can
    // swallow digits at the end of the description ("Inv1889" + "510,00").
    // When the running balance is known, take the amount from the balance delta.
    const splitTwo = (body) => {
      const m = body.match(HIST_TWO_AMT_RE);
      if (!m) return null;
      let desc = m[1];
      let amount = num(m[2], m[3]);
      const balance = num(m[4], m[5]);
      if (prevBalance !== null) {
        const delta = Math.round((balance - prevBalance) * 100) / 100;
        if (Math.abs(delta - amount) > 0.005) {
          const deltaStr = Math.abs(delta).toFixed(2).replace('.', ',');
          const amtStr = m[2].replace(/ /g, '');
          if ((delta < 0) === (m[3] === '-') && amtStr.endsWith(deltaStr) && amtStr !== deltaStr) {
            desc = desc + amtStr.slice(0, amtStr.length - deltaStr.length);
            amount = delta;
          }
        }
      }
      return { desc: desc.trim(), amount, balance };
    };

    for (const line of lines) {
      const d = line.match(HIST_DATE_RE);

      if (!started) {
        // Transactions start at the dated "Balance Brought Forward" line;
        // everything above it is the account summary.
        if (d && /balance\s+brought\s+forward/i.test(line)) {
          const m = line.match(HIST_ONE_AMT_RE);
          if (m) prevBalance = num(m[2], m[3]);
          started = true;
        }
        continue;
      }

      if (HIST_PERIOD_RE.test(line)) {
        // Page header of a continuation page: following lines can be the
        // previous transaction's detail that spilled over the page break.
        flush();
        detailCount = 0;
        continue;
      }

      if (d) {
        flush();
        const date = this._histDate(d[0]);
        const body = line.slice(d[0].length);
        group = { date, desc: '', amount: null, subs: [], details: [], raw: [line] };
        const two = splitTwo(body);
        if (two) {
          group.desc = two.desc;
          group.subs.push({ desc: two.desc, amount: two.amount, balance: two.balance });
        } else {
          const one = body.match(HIST_ONE_AMT_RE);
          if (one) { group.desc = one[1].trim(); group.amount = num(one[2], one[3]); }
          else group.desc = body.trim();
        }
        detailCount = 0;
        continue;
      }

      // Header/footer text ends detail collection until the next page header
      if (isNoise(line)) { detailCount = HIST_MAX_DETAIL_LINES; continue; }

      // Undated line carrying amount + balance → fee/sub-transaction of the group
      if (group) {
        if (group.amount !== null && group.subs.length === 0) {
          // Pending deposit: prevBalance must account for it before the delta check
          const saved = prevBalance;
          if (prevBalance !== null) prevBalance = Math.round((prevBalance + group.amount) * 100) / 100;
          const sub = splitTwo(line);
          prevBalance = saved;
          if (sub) { group.subs.push(sub); group.raw.push(line); continue; }
        } else {
          const savedPrev = prevBalance;
          const last = group.subs[group.subs.length - 1];
          if (last) prevBalance = last.balance;
          const sub = splitTwo(line);
          prevBalance = savedPrev;
          if (sub) { group.subs.push(sub); group.raw.push(line); continue; }
        }
      }

      // Plain text → detail of the current (or last, across a page break) transaction
      if (detailCount < HIST_MAX_DETAIL_LINES) {
        const target = group || (result.transactions.length ? result.transactions[result.transactions.length - 1] : null);
        if (group) group.details.push(line);
        else if (target) target.description = `${target.description} ${line}`.replace(/\s+/g, ' ').trim();
        detailCount++;
      }
    }
    flush();

    const closing = text.match(/balance\s+on\s*\d{1,2} [A-Za-z]{3} \d{4}\s*(\d{1,3}(?: \d{3})*,\d{2})(-?)/i);
    if (closing && prevBalance !== null) {
      const closingBal = num(closing[1], closing[2]);
      if (Math.abs(closingBal - prevBalance) > 0.005) {
        result.warnings.push(
          `Closing balance on statement is ${closingBal.toFixed(2)} but the last imported line shows ${prevBalance.toFixed(2)}.`
        );
      }
    }

    return result;
  }

  /** "1 Jun 2026" → "2026-06-01" */
  static _histDate(str) {
    const m = String(str).trim().match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
    return m ? this.parseDate(`${m[1]} ${m[2]} ${m[3]}`) : null;
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
