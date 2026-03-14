/**
 * ============================================================================
 * OCR API Routes
 * ============================================================================
 * POST /api/ocr/extract
 *   Upload any image or scanned PDF, get back extracted text.
 *   Authenticated — any logged-in user can call this.
 *
 * GET /api/ocr/status
 *   Returns which OCR capabilities are available on this server.
 * ============================================================================
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const OcrService = require('../../sean/ocr-service');

const router = express.Router();

// Memory storage — we pass the buffer straight to OcrService, no disk write
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      ...OcrService.SUPPORTED_IMAGE_MIMES,
      'application/pdf',
    ];
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    const allowedExts = [...OcrService.SUPPORTED_IMAGE_EXTENSIONS, '.pdf'];
    const mimeOk = allowed.includes(file.mimetype);
    const extOk  = allowedExts.includes('.' + ext);
    if (mimeOk || extOk) return cb(null, true);
    cb(new Error(`Unsupported file type. Allowed: images (JPEG, PNG, TIFF, BMP, WEBP) and PDF.`));
  },
});

/**
 * GET /api/ocr/status
 * Returns which OCR capabilities are available on this server.
 */
router.get('/status', (req, res) => {
  const caps = OcrService.isAvailable();
  res.json({
    available:   caps.imageOcr || caps.pdfOcr,
    imageOcr:    caps.imageOcr,
    pdfOcr:      caps.pdfOcr,
    tesseract:   caps.tesseract,
    pdftoppm:    caps.pdftoppm,
    supportedMimes: [
      ...OcrService.SUPPORTED_IMAGE_MIMES,
      'application/pdf',
    ],
  });
});

/**
 * POST /api/ocr/extract
 * Accepts: multipart/form-data with a single file field named "file"
 * Optional form fields:
 *   langs     — comma-separated Tesseract language codes (default: "eng")
 *   dpi       — PDF render DPI (default: 200)
 *   maxPages  — max PDF pages to OCR (default: 15)
 *
 * Returns:
 *   { success, text, method, pageCount?, charCount, wordCount, processingMs }
 */
router.post('/extract', upload.single('file'), async (req, res) => {
  const start = Date.now();

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use multipart/form-data with field name "file".' });
  }

  const caps = OcrService.isAvailable();
  if (!caps.tesseract) {
    return res.status(503).json({
      error: 'OCR service is not available on this server. ' +
             'The server needs tesseract-ocr installed.',
    });
  }

  // Parse options from form fields
  const langs    = req.body.langs    ? req.body.langs.split(',').map(l => l.trim()) : ['eng'];
  const dpi      = parseInt(req.body.dpi,      10) || 200;
  const maxPages = parseInt(req.body.maxPages, 10) || 15;

  try {
    const result = await OcrService.extractText(
      req.file.buffer,
      req.file.mimetype,
      {
        filename: req.file.originalname,
        langs,
        dpi,
        maxPages,
      }
    );

    const words = result.text.split(/\s+/).filter(w => w.length > 0).length;

    res.json({
      success:      true,
      text:         result.text,
      method:       result.method,
      pageCount:    result.pageCount || null,
      charCount:    result.text.length,
      wordCount:    words,
      processingMs: Date.now() - start,
      filename:     req.file.originalname,
    });

  } catch (err) {
    console.error('[OCR] Extract error:', err.message);
    const isCaps = err.message.includes('unavailable');
    res.status(isCaps ? 503 : 422).json({
      error:        err.message,
      processingMs: Date.now() - start,
    });
  }
});

module.exports = router;
