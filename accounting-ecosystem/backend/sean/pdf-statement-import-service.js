/**
 * ============================================================================
 * PDF Statement Import Service
 * ============================================================================
 * Orchestrates the full PDF bank statement import pipeline:
 *
 *   A → Extract text from PDF buffer (pdf-parse)
 *   B → Select best parser from registry
 *   C → Parse transactions
 *   D → Validate parsed rows
 *   E → Deduplicate against existing transactions (optional, with DB client)
 *   F → Return structured result for frontend review
 *
 * This service does NOT write to the database. Actual import uses the existing
 * POST /api/bank/import endpoint after user review.
 *
 * Usage:
 *   const service = require('./pdf-statement-import-service');
 *   const result = await service.parsePdf(buffer, filename, { dbClient, bankAccountId });
 * ============================================================================
 */

// pdf-parse: v1.x exports the function directly; v2.x wraps it under .default
const _pdfParseLib = require('pdf-parse');
const pdfParse = typeof _pdfParseLib === 'function'
  ? _pdfParseLib
  : (_pdfParseLib.default || _pdfParseLib.parse || null);

if (typeof pdfParse !== 'function') {
  // Fail at module load time with a clear message rather than at runtime
  throw new Error(
    '[PdfStatementImportService] pdf-parse did not export a callable function. ' +
    'Ensure pdf-parse is installed: run `npm install pdf-parse` in backend/.'
  );
}

const ParserRegistry = require('./pdf-statement-parsers/parser-registry');
const OcrService     = require('./ocr-service');

// Minimum number of extracted characters to consider PDF text-parseable
const MIN_TEXT_LENGTH = 100;

// If PDF text contains very few words (likely scanned/image-only), bail early
const MIN_WORD_COUNT = 20;

class PdfStatementImportService {

  /**
   * Main entry point. Parse a PDF buffer into structured transactions.
   *
   * @param {Buffer} pdfBuffer - Raw PDF file buffer
   * @param {string} filename - Original filename for metadata
   * @param {object} options
   *   @param {object} [options.dbClient] - pg DB client for duplicate detection
   *   @param {number} [options.bankAccountId] - bank account to check duplicates against
   * @returns {Promise<ImportResult>}
   *
   * ImportResult:
   * {
   *   success: boolean,
   *   error: string|null,               // top-level parse failure
   *   isPdfScanned: boolean,            // true if no extractable text
   *   bank: string,                     // detected bank name
   *   parserId: string,                 // which parser was used
   *   parserConfidence: number,         // 0-1
   *   isGenericFallback: boolean,
   *   accountNumber: string|null,
   *   statementPeriod: { from, to },
   *   transactions: ReviewTransaction[], // for user review
   *   duplicateCount: number,
   *   warnings: string[],
   *   skippedLines: number,
   *   importedAt: string               // ISO timestamp
   * }
   *
   * ReviewTransaction:
   * {
   *   date: string,           // YYYY-MM-DD
   *   description: string,
   *   reference: string|null,
   *   amount: number,         // positive=in, negative=out
   *   moneyIn: number|null,   // UI-friendly split
   *   moneyOut: number|null,
   *   balance: number|null,
   *   isDuplicate: boolean,
   *   duplicateId: number|null, // id of existing transaction if duplicate
   *   externalId: string      // stable hash for this transaction row
   * }
   */
  static async parsePdf(pdfBuffer, filename, options = {}) {
    const { dbClient = null, bankAccountId = null } = options;
    const warnings = [];

    // ─── STEP A: Extract text from PDF ──────────────────────────────────────
    let pdfData;
    try {
      // pdf-parse option: do not throw on encrypted/malformed PDFs
      pdfData = await pdfParse(pdfBuffer, {
        // Disable the test-file-based rendering path (faster, avoids issues)
        pagerender: null
      });
    } catch (err) {
      return this._error(`Failed to read PDF: ${err.message}. The file may be corrupted or password-protected.`);
    }

    // Preprocess extracted text — normalise artifacts common in bank PDF exports
    let text = this._preprocessPdfText((pdfData.text || '').trim());
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    // Scanned PDF detection — attempt OCR fallback before giving up
    if (text.length < MIN_TEXT_LENGTH || wordCount < MIN_WORD_COUNT) {
      const caps = OcrService.isAvailable();
      if (caps.pdfOcr) {
        warnings.push('Scanned (image-based) PDF detected — running OCR to extract text. This may take a moment.');
        let ocrResult;
        try {
          // 300 DPI: minimum for reliable digit recognition (200 DPI causes OCR errors on numbers).
          // PSM 6: "assume single uniform block of text" — best for bank statement tables.
          ocrResult = await OcrService.extractTextFromScannedPdf(pdfBuffer, { dpi: 300, psm: 6 });
        } catch (ocrErr) {
          return this._error(
            `This is a scanned PDF and OCR failed: ${ocrErr.message}. ` +
            `Please export your statement as a CSV from your bank's online portal.`
          );
        }
        const ocrText = ocrResult.text || '';
        const ocrWords = ocrText.split(/\s+/).filter(w => w.length > 0).length;
        // Only bail if OCR produced essentially nothing (< 10 words).
        // A short but real statement may have few words — attempt parsing anyway.
        if (ocrWords < 10) {
          return {
            success: false,
            error: 'OCR ran but could not extract readable text from this scanned PDF. ' +
                   'The scan quality may be too low, or the document may not be a bank statement.',
            isPdfScanned: true,
            bank: null, parserId: null, parserConfidence: 0, isGenericFallback: false,
            accountNumber: null, statementPeriod: { from: null, to: null },
            transactions: [], duplicateCount: 0, warnings, skippedLines: 0,
            importedAt: new Date().toISOString()
          };
        }
        // Normalize OCR output before feeding parsers (fixes digit substitutions, spacing)
        text = this._normalizeOcrText(ocrText);
        warnings.push(`OCR extracted ${ocrWords} words across ${ocrResult.pageCount} page(s).`);
      } else {
        return {
          success: false,
          error: 'This appears to be a scanned (image-based) PDF. ' +
                 'OCR is not currently available on this server. ' +
                 'Please export your statement as a CSV from your bank\'s online portal, ' +
                 'or contact your bank for a text-based PDF.',
          isPdfScanned: true,
          bank: null, parserId: null, parserConfidence: 0, isGenericFallback: false,
          accountNumber: null, statementPeriod: { from: null, to: null },
          transactions: [], duplicateCount: 0, warnings: [], skippedLines: 0,
          importedAt: new Date().toISOString()
        };
      }
    }

    // ─── STEP B: Select parser ───────────────────────────────────────────────
    const selection = ParserRegistry.selectParser(text, filename || '');

    if (selection.isGenericFallback) {
      warnings.push(
        `Bank not identified from statement. Using generic parser — results may be less accurate. ` +
        `All scores: ${selection.allScores.map(s => `${s.bank}=${(s.confidence * 100).toFixed(0)}%`).join(', ')}`
      );
    }

    // ─── STEP C: Parse transactions ──────────────────────────────────────────
    let parseResult;
    try {
      parseResult = selection.parser.parse(text, filename);
    } catch (err) {
      return this._error(`Parser error (${selection.parser.PARSER_ID}): ${err.message}`);
    }

    warnings.push(...parseResult.warnings);

    // Debug: log raw text sample when no transactions found — helps diagnose layout issues
    if (parseResult.transactions.length === 0) {
      const sample = text.slice(0, 800).replace(/\n/g, ' ↵ ');
      console.warn(`[PDF Import] 0 transactions extracted by ${selection.parser.PARSER_ID}. Raw text sample:\n${sample}`);
    }

    // ─── STEP D: Validate and enrich transactions ────────────────────────────
    const validTransactions = parseResult.transactions.filter(txn => {
      if (!txn.date || txn.amount === null || isNaN(txn.amount)) return false;
      if (!txn.description || txn.description.trim().length === 0) return false;
      return true;
    });

    if (validTransactions.length < parseResult.transactions.length) {
      const dropped = parseResult.transactions.length - validTransactions.length;
      warnings.push(`${dropped} transaction(s) removed during validation (missing date, amount, or description).`);
    }

    // ─── STEP E: Duplicate detection ────────────────────────────────────────
    let duplicateCount = 0;
    const reviewTransactions = await this._enrichTransactions(
      validTransactions, dbClient, bankAccountId, (count) => { duplicateCount = count; }
    );

    // ─── STEP F: Build result ────────────────────────────────────────────────
    const result = {
      success: true,
      error: null,
      isPdfScanned: false,
      bank: parseResult.bank,
      parserId: parseResult.parserId,
      parserConfidence: selection.confidence,
      isGenericFallback: selection.isGenericFallback,
      accountNumber: parseResult.accountNumber,
      statementPeriod: parseResult.statementPeriod,
      transactions: reviewTransactions,
      duplicateCount,
      warnings,
      skippedLines: parseResult.skippedLines,
      importedAt: new Date().toISOString()
    };

    // Include a raw text sample when 0 transactions extracted — diagnostic aid
    // for identifying layout issues without having to read server logs.
    if (reviewTransactions.length === 0) {
      result.rawTextSample = text.slice(0, 600);
    }

    return result;
  }

  /**
   * Normalise text extracted from a standard (text-based) PDF by pdf-parse.
   *
   * pdf-parse can produce:
   *   - Ligature characters (ﬁ → fi, ﬂ → fl, etc.)
   *   - Non-breaking spaces (U+00A0) instead of regular spaces
   *   - Tab characters for column spacing
   *   - Windows CRLF line endings
   *   - Form-feed characters (U+000C) at page boundaries
   *   - Multiple consecutive blank lines
   *   - Smart/curly quotes
   */
  static _preprocessPdfText(text) {
    return text
      // Windows + old Mac line endings → Unix
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      // Form feed (page break) → single newline
      .replace(/\f/g, '\n')
      // Non-breaking space → regular space
      .replace(/\u00A0/g, ' ')
      // Tabs → two spaces (preserve column intent without breaking regex)
      .replace(/\t/g, '  ')
      // Common PDF ligatures → readable ASCII
      .replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
      .replace(/\uFB03/g, 'ffi').replace(/\uFB04/g, 'ffl')
      // Smart / curly quotes → straight quotes
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      // En-dash / em-dash in amount positions → hyphen-minus
      .replace(/[\u2013\u2014]/g, '-')
      // Collapse 3+ consecutive blank lines to 2 (preserve paragraph structure)
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * Normalize raw OCR text before feeding it into bank statement parsers.
   *
   * Tesseract on tabular financial documents produces characteristic errors:
   *   - Capital O substituted for 0 in numeric contexts
   *   - Lowercase l/I substituted for 1
   *   - Amounts split across lines: "1 234\n.56" → should be "1 234.56"
   *   - Date separators mangled: "01/01/ 2026" → "01/01/2026"
   *   - Pipe characters instead of slash in dates: "01|01|2026"
   *   - Excessive whitespace between columns on the same row
   *   - Page-break markers inserted by multi-page OCR
   */
  static _normalizeOcrText(text) {
    let t = text;

    // 1. Normalize page-break separators inserted by the OCR pipeline
    t = t.replace(/\n\n---\s*PAGE BREAK\s*---\n\n/g, '\n');

    // 2. Fix pipe | used instead of / in date fields (01|01|2026 → 01/01/2026)
    t = t.replace(/(\d{1,2})\|(\d{1,2})\|(\d{4})/g, '$1/$2/$3');

    // 3. Fix spaces accidentally inserted into date separators ("01/01/ 2026")
    t = t.replace(/(\d{2}\/\d{2}\/)\s+(\d{4})/g, '$1$2');

    // 4. Replace capital O with 0 when surrounded by digits or at start of a number
    //    "1O 500.00" → "10 500.00", "O1/O1/2026" → "01/01/2026"
    t = t.replace(/(?<=\d)O(?=\d)/g, '0');
    t = t.replace(/\bO(?=\d)/g, '0');

    // 5. Replace lowercase l with 1 when in a numeric context
    //    "l5 000.00" or "0l/01/2026"
    t = t.replace(/(?<=\d)l(?=\d)/g, '1');
    t = t.replace(/\bl(?=\d{1,2}[\/\-])/g, '1');  // leading l before date-like pattern

    // 6. Fix amounts split across a newline: "1 234\n.56" → "1 234.56"
    t = t.replace(/(\d+)\n\.(\d{2})\b/g, '$1.$2');

    // 7. Collapse runs of more than two spaces on a single line to two spaces
    //    (preserves column separation but removes excessive padding)
    t = t.split('\n').map(line => line.replace(/  {2,}/g, '  ')).join('\n');

    // 8. Remove stray non-printable characters that tesseract occasionally emits
    // eslint-disable-next-line no-control-regex
    t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    return t;
  }

  /**
   * Enrich transactions with UI-friendly fields and duplicate detection.
   */
  static async _enrichTransactions(transactions, dbClient, bankAccountId, onDuplicateCount) {
    let duplicateCount = 0;

    const enriched = await Promise.all(transactions.map(async (txn) => {
      const externalId = this._makeExternalId(txn);
      let isDuplicate = false;
      let duplicateId = null;

      // Check for duplicates if db client and bank account provided
      if (dbClient && bankAccountId) {
        try {
          // Check by external_id first (exact match)
          const exactCheck = await dbClient.query(
            'SELECT id FROM bank_transactions WHERE bank_account_id = $1 AND external_id = $2',
            [bankAccountId, externalId]
          );
          if (exactCheck.rows.length > 0) {
            isDuplicate = true;
            duplicateId = exactCheck.rows[0].id;
          } else {
            // Fuzzy check: same date + similar amount + similar description
            const fuzzyCheck = await dbClient.query(
              `SELECT id FROM bank_transactions
               WHERE bank_account_id = $1
                 AND date = $2
                 AND ABS(amount - $3) < 0.01
                 AND LOWER(LEFT(description, 30)) = LOWER(LEFT($4, 30))`,
              [bankAccountId, txn.date, txn.amount, txn.description]
            );
            if (fuzzyCheck.rows.length > 0) {
              isDuplicate = true;
              duplicateId = fuzzyCheck.rows[0].id;
            }
          }
        } catch (_) {
          // Duplicate check failed — continue without flagging
        }
      }

      if (isDuplicate) duplicateCount++;

      return {
        date: txn.date,
        description: txn.description,
        reference: txn.reference || null,
        amount: txn.amount,
        moneyIn: txn.amount > 0 ? txn.amount : null,
        moneyOut: txn.amount < 0 ? Math.abs(txn.amount) : null,
        balance: txn.balance,
        isDuplicate,
        duplicateId,
        externalId
      };
    }));

    onDuplicateCount(duplicateCount);
    return enriched;
  }

  /**
   * Generate a stable external ID for a transaction.
   * This is used as the `external_id` in bank_transactions for duplicate prevention.
   *
   * Format: pdf-{date}-{amount_cents}-{desc_hash}
   * Not globally unique across all banks — it's scoped to the bank account level.
   */
  static _makeExternalId(txn) {
    const date = txn.date || 'nodate';
    const amountCents = Math.round((txn.amount || 0) * 100);
    const descKey = (txn.description || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20);
    return `pdf-${date}-${amountCents}-${descKey}`;
  }

  /**
   * Build a standard error result.
   */
  static _error(message) {
    return {
      success: false,
      error: message,
      isPdfScanned: false,
      bank: null,
      parserId: null,
      parserConfidence: 0,
      isGenericFallback: false,
      accountNumber: null,
      statementPeriod: { from: null, to: null },
      transactions: [],
      duplicateCount: 0,
      warnings: [],
      skippedLines: 0,
      importedAt: new Date().toISOString()
    };
  }
}

module.exports = PdfStatementImportService;
