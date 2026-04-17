/**
 * ============================================================================
 * Image Statement Import Service
 * ============================================================================
 * Orchestrates the bank statement photo/image import pipeline:
 *
 *   A → OCR text extraction from image buffer (tesseract via OcrService)
 *   B → Normalize OCR output (fix digit substitutions, spacing artifacts)
 *   C → Select best parser from registry (same parsers as PDF import)
 *   D → Parse transactions
 *   E → Validate parsed rows
 *   F → Enrich with external IDs (image-prefixed for traceability)
 *   G → Return structured result for frontend review + CSV export
 *
 * IMPORTANT: This service does NOT write to the database.
 * The caller (bank import route) returns the result to the frontend for
 * user review. The user can then export to CSV.
 * No journals, no bank_transactions, no VAT logic are triggered here.
 *
 * Supported image types: JPEG, JPG, PNG, WEBP
 * Maximum recommended image size: 15 MB per file
 *
 * Usage:
 *   const service = require('./image-statement-import-service');
 *   const result = await service.parseImage(buffer, filename);
 *
 * Result shape mirrors PdfStatementImportService.parsePdf() with additions:
 *   isImageOcr: true          — always set; identifies image-origin results
 *   rawTextSample: string     — included when 0 transactions extracted (diagnostic)
 *
 * ============================================================================
 */

'use strict';

const path = require('path');

const OcrService = require('./ocr-service');
const ParserRegistry = require('./pdf-statement-parsers/parser-registry');
// Re-use the normalizer from PdfStatementImportService — same OCR artifact fixes apply.
const PdfStatementImportService = require('./pdf-statement-import-service');

// ── Allowed MIME types and extensions ────────────────────────────────────────

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

// A low word-count from OCR is a strong signal of a bad scan.
// Below MIN_WORDS we return an extraction failure rather than feeding
// garbage through the parser.
const MIN_WORDS = 15;

// ── Public service class ──────────────────────────────────────────────────────

class ImageStatementImportService {

  /**
   * Validate that a file is an accepted image type.
   * @param {string} mimetype - e.g. 'image/png'
   * @param {string} [filename] - e.g. 'statement.jpg'
   * @returns {boolean}
   */
  static isAllowedFile(mimetype, filename) {
    const mime = (mimetype || '').toLowerCase().split(';')[0].trim();
    if (ALLOWED_MIMES.has(mime)) return true;
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }

  /**
   * Main entry point. Extract transactions from an image buffer.
   *
   * @param {Buffer} imageBuffer - Raw image file buffer
   * @param {string} filename    - Original filename (used for extension hint)
   * @param {object} [options]   - Reserved for future options (currently unused)
   * @returns {Promise<ImportResult>}
   *
   * ImportResult:
   * {
   *   success: boolean,
   *   error: string|null,
   *   isImageOcr: true,
   *   isLowQuality: boolean,           // true if OCR word count was suspiciously low
   *   bank: string|null,
   *   parserId: string|null,
   *   parserConfidence: number,        // 0-1
   *   isGenericFallback: boolean,
   *   accountNumber: string|null,
   *   statementPeriod: { from, to },
   *   transactions: ReviewTransaction[],
   *   warnings: string[],
   *   skippedLines: number,
   *   importedAt: string,
   *   rawTextSample: string|undefined  // only when 0 transactions extracted
   * }
   *
   * ReviewTransaction (same schema as PdfStatementImportService):
   * {
   *   date: string,
   *   description: string,
   *   reference: string|null,
   *   amount: number,
   *   moneyIn: number|null,
   *   moneyOut: number|null,
   *   balance: number|null,
   *   rawLine: string|null,  // preserved for traceability
   *   externalId: string     // img-{date}-{amountCents}-{descHash}
   * }
   */
  static async parseImage(imageBuffer, filename, options = {}) { // eslint-disable-line no-unused-vars
    const warnings = [];
    const ext = filename ? path.extname(filename).toLowerCase() : '.jpg';

    // ─── STEP A: Check OCR availability ─────────────────────────────────────
    const ocrCaps = OcrService.isAvailable();
    // TEMP DIAGNOSTIC — remove after verification
    console.log('OCR CAPS:', ocrCaps);
    if (!ocrCaps.imageOcr) {
      return this._error(
        'Image OCR is not available on this server. ' +
        'tesseract-ocr must be installed (apk add tesseract-ocr tesseract-ocr-data-eng).'
      );
    }

    // ─── STEP B: Extract text from image via OCR ─────────────────────────────
    let ocrResult;
    try {
      ocrResult = await OcrService.extractTextFromImage(imageBuffer, {
        langs: ['eng'],
        ext,
        // PSM 6 = "uniform block of text" — best for bank statement tables.
        // OcrService sets this internally as its default for extractTextFromImage.
      });
    } catch (err) {
      return this._error(
        `OCR extraction failed: ${err.message}. ` +
        `Please ensure the image is clear and contains a readable bank statement.`
      );
    }

    const rawText = ocrResult.text || '';
    const wordCount = rawText.split(/\s+/).filter(w => w.length > 0).length;

    // ─── Low-quality / unreadable image handling ─────────────────────────────
    if (wordCount < MIN_WORDS) {
      return {
        success: false,
        error:
          `OCR could not extract readable text from this image (only ${wordCount} word(s) found). ` +
          'Please use a clearer, higher-resolution photo taken in good lighting. ' +
          'Ensure the full statement page is visible and in focus.',
        isImageOcr: true,
        isLowQuality: true,
        bank: null,
        parserId: null,
        parserConfidence: 0,
        isGenericFallback: false,
        accountNumber: null,
        statementPeriod: { from: null, to: null },
        transactions: [],
        warnings,
        skippedLines: 0,
        importedAt: new Date().toISOString(),
      };
    }

    warnings.push(`OCR extracted ${wordCount} word(s) from the image.`);

    if (wordCount < 60) {
      warnings.push(
        `Low word count (${wordCount}) — OCR quality may be reduced. ` +
        'Review all extracted transactions carefully before exporting.'
      );
    }

    // ─── STEP C: Normalize OCR output ────────────────────────────────────────
    // PdfStatementImportService._normalizeOcrText() fixes the same tesseract
    // artifacts that appear in image OCR: O→0 substitutions, pipe-dates, split
    // amounts, excessive whitespace, etc.
    const text = PdfStatementImportService._normalizeOcrText(rawText);

    // ─── STEP D: Select parser ────────────────────────────────────────────────
    const selection = ParserRegistry.selectParser(text, filename || '');

    if (selection.isGenericFallback) {
      warnings.push(
        `Bank not identified from extracted text. Using generic parser — results may be less accurate. ` +
        `Parser scores: ${selection.allScores.map(s => `${s.bank}=${(s.confidence * 100).toFixed(0)}%`).join(', ')}`
      );
    }

    // ─── STEP E: Parse transactions ───────────────────────────────────────────
    let parseResult;
    try {
      parseResult = selection.parser.parse(text, filename || '');
    } catch (err) {
      return this._error(`Parser error (${selection.parser.PARSER_ID}): ${err.message}`);
    }

    warnings.push(...parseResult.warnings);

    if (parseResult.transactions.length === 0) {
      // Log a raw text sample to aid debugging without cluttering response payload
      const sample = text.slice(0, 800).replace(/\n/g, ' ↵ ');
      console.warn(
        `[ImageStatementImport] 0 transactions extracted by ${selection.parser.PARSER_ID}. ` +
        `Raw OCR text sample:\n${sample}`
      );
    }

    // ─── STEP F: Validate ─────────────────────────────────────────────────────
    const validTransactions = parseResult.transactions.filter(txn => {
      if (!txn.date || txn.amount === null || isNaN(txn.amount)) return false;
      if (!txn.description || txn.description.trim().length === 0) return false;
      return true;
    });

    const dropped = parseResult.transactions.length - validTransactions.length;
    if (dropped > 0) {
      warnings.push(
        `${dropped} transaction(s) removed during validation ` +
        `(missing date, amount, or description).`
      );
    }

    // ─── STEP G: Enrich with external IDs ─────────────────────────────────────
    // Image-origin IDs are prefixed 'img-' to distinguish them from PDF imports
    // when/if these transactions are later posted to a bank account.
    const reviewTransactions = validTransactions.map(txn => ({
      date: txn.date,
      description: txn.description,
      reference: txn.reference || null,
      amount: txn.amount,
      moneyIn: txn.amount > 0 ? txn.amount : null,
      moneyOut: txn.amount < 0 ? Math.abs(txn.amount) : null,
      balance: txn.balance,
      rawLine: txn.rawLine || null,
      externalId: this._makeExternalId(txn),
    }));

    // ─── STEP H: Build result ─────────────────────────────────────────────────
    const result = {
      success: true,
      error: null,
      isImageOcr: true,
      isLowQuality: wordCount < 60,
      bank: parseResult.bank,
      parserId: parseResult.parserId,
      parserConfidence: selection.confidence,
      isGenericFallback: selection.isGenericFallback,
      accountNumber: parseResult.accountNumber,
      statementPeriod: parseResult.statementPeriod,
      transactions: reviewTransactions,
      warnings,
      skippedLines: parseResult.skippedLines,
      importedAt: new Date().toISOString(),
    };

    // Include a raw text sample when 0 transactions extracted — diagnostic aid
    if (reviewTransactions.length === 0) {
      result.rawTextSample = text.slice(0, 600);
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Generate a stable external ID for an image-extracted transaction.
   * Prefixed 'img-' to distinguish from PDF-extracted IDs ('pdf-').
   */
  static _makeExternalId(txn) {
    const date = txn.date || 'nodate';
    const amountCents = Math.round((txn.amount || 0) * 100);
    const descKey = (txn.description || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20);
    return `img-${date}-${amountCents}-${descKey}`;
  }

  /**
   * Build a standard error result.
   */
  static _error(message) {
    return {
      success: false,
      error: message,
      isImageOcr: true,
      isLowQuality: false,
      bank: null,
      parserId: null,
      parserConfidence: 0,
      isGenericFallback: false,
      accountNumber: null,
      statementPeriod: { from: null, to: null },
      transactions: [],
      warnings: [],
      skippedLines: 0,
      importedAt: new Date().toISOString(),
    };
  }
}

module.exports = ImageStatementImportService;
