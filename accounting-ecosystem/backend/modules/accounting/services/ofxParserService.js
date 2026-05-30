'use strict';

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// OFXParserService
// Parses OFX 1.x (SGML) and OFX 2.x (XML) bank statement files.
//
// Both variants share the same transaction element name <STMTTRN>.
// OFX 1.x uses open tags only (SGML): <TRNAMT>-125.50
// OFX 2.x uses closed tags (XML):    <TRNAMT>-125.50</TRNAMT>
//
// South African banks typically export OFX 1.x.
// QFX (Quicken) is structurally identical to OFX — same parser handles it.
// ─────────────────────────────────────────────────────────────────────────────
class OFXParserService {

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Parse an OFX / QFX file buffer and return structured transaction data.
   *
   * @param {Buffer} buffer        — raw file bytes
   * @param {string} [filename]    — original filename (used for format hint only)
   * @returns {{
   *   success: boolean,
   *   format?: 'ofx1'|'ofx2',
   *   transactions?: Array,
   *   closingBalance?: number|null,
   *   statementPeriod?: string|null,
   *   warnings?: string[],
   *   skippedLines?: number,
   *   error?: string
   * }}
   */
  static parse(buffer, filename = '') {
    // Guard: normalise encoding (OFX 1.x may declare CHARSET:1252 but is usually ASCII-clean)
    const raw = buffer.toString('utf8');

    if (!/<STMTTRN>/i.test(raw)) {
      return {
        success: false,
        error: 'No transaction data found. Ensure this is a valid OFX or QFX bank statement export.',
      };
    }

    // Strip SGML headers — everything before the first <OFX> tag
    const ofxIdx = raw.search(/<OFX>/i);
    const body   = ofxIdx >= 0 ? raw.slice(ofxIdx) : raw;

    // Closing balance from LEDGERBAL (optional, informational)
    const balMatch = body.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^\r\n<]+)/i);
    const closingBalance = balMatch ? parseFloat(balMatch[1].trim()) : null;

    // Statement period (optional, informational)
    const dtStart = OFXParserService._field(body, 'DTSTART');
    const dtEnd   = OFXParserService._field(body, 'DTEND');
    const statementPeriod = (dtStart && dtEnd)
      ? `${OFXParserService._parseDate(dtStart)} – ${OFXParserService._parseDate(dtEnd)}`
      : null;

    const transactions = [];
    const warnings     = [];
    let   skippedCount = 0;
    let   usedXml      = false;

    // ── Attempt 1: XML-style closed tags <STMTTRN>...</STMTTRN> ──────────────
    const xmlPat = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    let m;
    while ((m = xmlPat.exec(body)) !== null) {
      usedXml = true;
      const txn = OFXParserService._parseTxnBlock(m[1]);
      if (txn) transactions.push(txn);
      else skippedCount++;
    }

    // ── Attempt 2: SGML open-tag style (no closing </STMTTRN>) ───────────────
    if (!usedXml) {
      const blocks = OFXParserService._sgmlBlocks(body);
      blocks.forEach(block => {
        const txn = OFXParserService._parseTxnBlock(block);
        if (txn) transactions.push(txn);
        else skippedCount++;
      });
    }

    if (transactions.length === 0) {
      return {
        success: false,
        error: 'No valid transactions could be parsed from this file. '
             + 'The file may be empty, already processed, or in an unsupported OFX variant.',
      };
    }

    if (skippedCount > 0) {
      warnings.push(
        `${skippedCount} transaction(s) skipped — missing required date or amount field.`
      );
    }

    return {
      success: true,
      format: usedXml ? 'ofx2' : 'ofx1',
      transactions,
      closingBalance:   isNaN(closingBalance) ? null : closingBalance,
      statementPeriod,
      warnings,
      skippedLines: skippedCount,
    };
  }

  /**
   * Compute SHA-256 hash of buffer for batch-level duplicate detection.
   * Matches the interface used by DuplicateDetectionService.computeFileHash().
   */
  static computeFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Returns true if the file extension is .ofx or .qfx.
   */
  static isAllowedFile(mimetype, originalname) {
    const ext = (originalname || '').toLowerCase().split('.').pop();
    return ext === 'ofx' || ext === 'qfx';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Extract SGML blocks: split on <STMTTRN> open tags, each block ends at the
   * next <STMTTRN> or </BANKTRANLIST>.
   */
  static _sgmlBlocks(content) {
    const blocks = [];
    const parts  = content.split(/<STMTTRN>/i);
    for (let i = 1; i < parts.length; i++) {
      const end = parts[i].search(/<\/BANKTRANLIST>|<STMTTRN>/i);
      blocks.push(end >= 0 ? parts[i].slice(0, end) : parts[i]);
    }
    return blocks;
  }

  /**
   * Parse a single STMTTRN block (content between the STMTTRN tags).
   * Returns null if date or amount is missing/invalid.
   */
  static _parseTxnBlock(block) {
    const dateStr   = OFXParserService._field(block, 'DTPOSTED');
    const amountStr = OFXParserService._field(block, 'TRNAMT');
    if (!dateStr || !amountStr) return null;

    const date   = OFXParserService._parseDate(dateStr);
    if (!date) return null;

    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return null;

    const fitid    = OFXParserService._field(block, 'FITID');
    const name     = OFXParserService._field(block, 'NAME');
    const memo     = OFXParserService._field(block, 'MEMO');
    const checknum = OFXParserService._field(block, 'CHECKNUM');

    const description = (OFXParserService._buildDescription(name, memo)
      || fitid
      || 'OFX Transaction'
    ).slice(0, 500);

    return {
      date,
      description,
      amount,
      moneyIn:    amount > 0 ? Math.abs(amount) : null,
      moneyOut:   amount < 0 ? Math.abs(amount) : null,
      reference:  checknum || null,
      externalId: fitid    || null,
      balance:    null,  // OFX per-transaction balance not standard; use closingBalance
    };
  }

  /**
   * Build human-readable description from NAME and/or MEMO fields.
   * Combines both when they carry different information.
   */
  static _buildDescription(name, memo) {
    const n = (name || '').trim();
    const m = (memo || '').trim();
    if (n && m && m.toLowerCase() !== n.toLowerCase()) return `${n} - ${m}`;
    return m || n;
  }

  /**
   * Extract a named OFX field value from a block of text.
   * Handles both <TAG>value and <TAG>value</TAG>.
   * Returns null when not present.
   */
  static _field(block, tag) {
    const re = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i');
    const m  = block.match(re);
    return m ? m[1].trim() : null;
  }

  /**
   * Convert OFX date string to YYYY-MM-DD.
   *
   * OFX date formats:
   *   YYYYMMDD
   *   YYYYMMDDHHMMSS
   *   YYYYMMDDHHMMSS.mmm
   *   YYYYMMDDHHMMSS[-TZ:TZName]   e.g. 20240531120000[-2:SAST]
   */
  static _parseDate(raw) {
    if (!raw) return null;
    // Strip sub-second and timezone parts
    const cleaned = raw.trim().replace(/\[.*\]/, '').replace(/\.\d+/, '');
    const digits  = cleaned.replace(/\D/g, '');
    if (digits.length < 8) return null;

    const year  = digits.slice(0, 4);
    const month = digits.slice(4, 6);
    const day   = digits.slice(6, 8);

    const mo = parseInt(month, 10);
    const dy = parseInt(day,   10);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;

    return `${year}-${month}-${day}`;
  }
}

module.exports = OFXParserService;
