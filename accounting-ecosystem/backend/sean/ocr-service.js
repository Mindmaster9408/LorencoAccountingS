/**
 * ============================================================================
 * OCR Service — Extract text from images and scanned documents
 * ============================================================================
 * Uses system tesseract (OCR engine) + pdftoppm (PDF→image conversion).
 * Both are installed in the Docker image via apk.
 *
 * Reusable across the entire Lorenco ecosystem:
 *   - Bank statement import (scanned PDFs)
 *   - Invoice / receipt scanning
 *   - Any document requiring text extraction from images
 *
 * Supported inputs:
 *   - Images: JPEG, PNG, TIFF, BMP, WEBP, GIF
 *   - PDFs: Text-based (fast, via pdf-parse) or scanned (OCR via tesseract)
 *
 * Exports:
 *   extractTextFromImage(buffer, options)    → { text, success }
 *   extractTextFromScannedPdf(buffer, opts)  → { text, pageCount, success }
 *   extractText(buffer, mimeType, options)   → { text, method, success }
 *   isAvailable()                            → { tesseract, pdftoppm }
 * ============================================================================
 */

'use strict';

const { execFile, execFileSync } = require('child_process');
const { promisify }              = require('util');
const fs                         = require('fs');
const path                       = require('path');
const os                         = require('os');
const crypto                     = require('crypto');

const execFileAsync = promisify(execFile);

// ── Capability detection (runs once at module load) ─────────────────────────

function _checkBin(bin, args) {
  try { execFileSync(bin, args, { stdio: 'ignore', timeout: 3000 }); return true; }
  catch { return false; }
}

const HAS_TESSERACT = _checkBin('tesseract', ['--version']);
const HAS_PDFTOPPM  = _checkBin('pdftoppm',  ['-v']);

if (!HAS_TESSERACT) {
  console.warn('[OCR] tesseract not found — image OCR will be unavailable.');
  console.warn('      Install: apk add tesseract-ocr tesseract-ocr-data-eng');
}
if (!HAS_PDFTOPPM) {
  console.warn('[OCR] pdftoppm not found — scanned-PDF OCR will be unavailable.');
  console.warn('      Install: apk add poppler-utils');
}

// ── Supported MIME types ─────────────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/tiff',
  'image/bmp',  'image/gif', 'image/webp',
]);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif', '.webp',
]);

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Run tesseract on a file path, return the extracted text string. */
async function _tesseract(imagePath, langs = ['eng']) {
  const outBase = path.join(os.tmpdir(), `ocr-out-${crypto.randomUUID()}`);
  try {
    await execFileAsync('tesseract', [
      imagePath,
      outBase,
      '-l', langs.join('+'),
      '--oem', '3',   // LSTM + legacy combo
      '--psm', '3',   // Fully automatic page segmentation
    ], { timeout: 60000 });
    const txt = fs.readFileSync(outBase + '.txt', 'utf8');
    return txt.trim();
  } finally {
    try { fs.unlinkSync(outBase + '.txt'); } catch (_) { /* ignore */ }
  }
}

/** Write buffer to a temp file; caller must delete it. */
function _writeTmp(ext, buffer) {
  const p = path.join(os.tmpdir(), `ocr-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(p, buffer);
  return p;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract text from an image buffer using OCR.
 *
 * @param {Buffer}   imageBuffer
 * @param {object}   [options]
 * @param {string[]} [options.langs]  - Tesseract language codes (default: ['eng'])
 * @param {string}   [options.ext]    - File extension hint e.g. '.png'
 * @returns {Promise<{ text: string, method: string, success: true }>}
 */
async function extractTextFromImage(imageBuffer, options = {}) {
  if (!HAS_TESSERACT) {
    throw new Error('OCR unavailable: tesseract is not installed on this server.');
  }
  const langs = options.langs || ['eng'];
  const ext   = options.ext   || '.png';
  const tmp   = _writeTmp(ext, imageBuffer);
  try {
    const text = await _tesseract(tmp, langs);
    return { text, method: 'ocr-image', success: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

/**
 * OCR a scanned PDF by converting each page to an image first, then running
 * tesseract on each page image.
 *
 * @param {Buffer}   pdfBuffer
 * @param {object}   [options]
 * @param {string[]} [options.langs]     - Tesseract language codes (default: ['eng'])
 * @param {number}   [options.dpi]       - Render DPI (default: 200 — good quality/speed tradeoff)
 * @param {number}   [options.maxPages]  - Max pages to OCR (default: 15)
 * @returns {Promise<{ text: string, pageCount: number, method: string, success: true }>}
 */
async function extractTextFromScannedPdf(pdfBuffer, options = {}) {
  if (!HAS_TESSERACT) {
    throw new Error('OCR unavailable: tesseract is not installed on this server.');
  }
  if (!HAS_PDFTOPPM) {
    throw new Error('Scanned-PDF OCR unavailable: pdftoppm (poppler-utils) is not installed.');
  }

  const langs    = options.langs    || ['eng'];
  const dpi      = options.dpi      || 200;
  const maxPages = options.maxPages || 15;

  const tmpDir  = path.join(os.tmpdir(), `ocr-pdf-${crypto.randomUUID()}`);
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const imgBase = path.join(tmpDir, 'page');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Convert PDF pages → PNG images
    await execFileAsync('pdftoppm', [
      '-png',
      '-r', String(dpi),
      '-l', String(maxPages),
      pdfPath,
      imgBase,
    ], { timeout: 120000 });

    // Find generated page images (pdftoppm names them page-1.png, page-2.png …)
    const pageFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) {
      throw new Error('PDF-to-image conversion produced no output. The PDF may be empty or corrupted.');
    }

    // OCR each page
    const pageTexts = [];
    for (const file of pageFiles) {
      const text = await _tesseract(path.join(tmpDir, file), langs);
      if (text.trim()) pageTexts.push(text.trim());
    }

    return {
      text:      pageTexts.join('\n\n--- PAGE BREAK ---\n\n'),
      pageCount: pageFiles.length,
      method:    'ocr-pdf',
      success:   true,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/**
 * Auto-detect file type and extract text.
 * Routes image MIME types to extractTextFromImage,
 * PDFs to extractTextFromScannedPdf.
 *
 * @param {Buffer}  buffer
 * @param {string}  mimeType  - e.g. 'image/png', 'application/pdf'
 * @param {object}  [options]
 * @param {string}  [options.filename]  - Used to infer extension for temp file
 * @returns {Promise<{ text: string, method: string, pageCount?: number, success: true }>}
 */
async function extractText(buffer, mimeType, options = {}) {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const ext  = options.filename
    ? path.extname(options.filename).toLowerCase()
    : '';

  if (IMAGE_MIMES.has(mime) || IMAGE_EXTENSIONS.has(ext)) {
    return extractTextFromImage(buffer, { ...options, ext: ext || '.png' });
  }

  if (mime === 'application/pdf' || ext === '.pdf') {
    return extractTextFromScannedPdf(buffer, options);
  }

  throw new Error(`Unsupported file type for OCR: ${mimeType || ext || 'unknown'}`);
}

/**
 * Returns which OCR capabilities are available on this server.
 * @returns {{ tesseract: boolean, pdftoppm: boolean, imageOcr: boolean, pdfOcr: boolean }}
 */
function isAvailable() {
  return {
    tesseract:  HAS_TESSERACT,
    pdftoppm:   HAS_PDFTOPPM,
    imageOcr:   HAS_TESSERACT,
    pdfOcr:     HAS_TESSERACT && HAS_PDFTOPPM,
  };
}

module.exports = {
  extractText,
  extractTextFromImage,
  extractTextFromScannedPdf,
  isAvailable,
  SUPPORTED_IMAGE_MIMES: [...IMAGE_MIMES],
  SUPPORTED_IMAGE_EXTENSIONS: [...IMAGE_EXTENSIONS],
};
