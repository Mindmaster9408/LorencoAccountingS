/**
 * ============================================================================
 * PDF Import Routes — Client Registration Document Extraction
 * ============================================================================
 * POST /api/import/pdf-extract
 *   Upload a company registration PDF, extract text, parse structured fields.
 *   Returns extracted fields + per-field confidence + duplicate warning.
 *
 * GET /api/import/check-duplicate?reg_number=&name=
 *   Check whether a company/client with this registration number or name
 *   already exists in the current practice.
 *
 * GET /api/import/parsers
 *   List available document parsers.
 * ============================================================================
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const { supabase }     = require('../../config/database');
const { authenticateToken } = require('../../middleware/auth');
const { parseDocument, listParsers } = require('../../services/documentParsers');
const OcrService = require('../../sean/ocr-service');

const router = express.Router();
router.use(authenticateToken);

// Memory storage — no disk writes, buffer passed directly to pdf-parse
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ext  = (file.originalname || '').split('.').pop().toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (mime === 'application/pdf' || ext === 'pdf') return cb(null, true);
    cb(new Error('Only PDF files are supported for company registration import.'));
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract text from PDF buffer. Tries pdf-parse first (text-based), falls back to OCR. */
async function extractPdfText(buffer) {
  // Step 1: Try pdf-parse — fast, works on digital/text-based PDFs
  try {
    const parsed = await pdfParse(buffer, { max: 10 }); // max 10 pages
    const text = (parsed.text || '').trim();
    if (text.length >= 80) {
      return { text, method: 'pdf-text', pageCount: parsed.numpages };
    }
    // Text too short — likely a scanned/image PDF
  } catch (pdfErr) {
    console.warn('[pdfImport] pdf-parse failed:', pdfErr.message);
  }

  // Step 2: Fall back to OCR (tesseract) for scanned PDFs
  const caps = OcrService.isAvailable();
  if (caps.pdfOcr) {
    const result = await OcrService.extractTextFromScannedPdf(buffer, { dpi: 200, maxPages: 5 });
    return { text: result.text, method: 'ocr', pageCount: result.pageCount };
  }

  // Neither method available for this document
  throw Object.assign(new Error(
    'This PDF appears to be scanned/image-only and OCR is not available on this server. ' +
    'Please use a text-based (digital) PDF, or contact support.'
  ), { code: 'SCANNED_PDF_UNSUPPORTED' });
}

/** Get the current user's practice company IDs for scoping duplicate checks. */
async function getPracticeIds(req) {
  if (req.user.isSuperAdmin) return null; // super admins check across all
  const companyId = req.companyId;
  if (companyId) return [companyId];

  const { data } = await supabase
    .from('user_company_access')
    .select('company_id')
    .eq('user_id', req.user.userId)
    .eq('is_active', true);
  return (data || []).map(r => r.company_id);
}

/** Check for duplicate clients by registration number and/or name. */
async function findDuplicates(regNumber, name, practiceIds) {
  const matches = [];

  if (regNumber) {
    let q = supabase
      .from('eco_clients')
      .select('id, name, id_number, company_id, client_type, is_active')
      .eq('id_number', regNumber);
    if (practiceIds) q = q.in('company_id', practiceIds);
    const { data } = await q;
    if (data && data.length > 0) {
      data.forEach(c => matches.push({ ...c, match_type: 'registration_number' }));
    }
  }

  // Also check by exact name match (case-insensitive) if no reg-number duplicate found
  if (name && matches.length === 0) {
    let q = supabase
      .from('eco_clients')
      .select('id, name, id_number, company_id, client_type, is_active')
      .ilike('name', name.trim());
    if (practiceIds) q = q.in('company_id', practiceIds);
    const { data } = await q;
    if (data && data.length > 0) {
      data.forEach(c => matches.push({ ...c, match_type: 'name' }));
    }
  }

  return matches;
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/import/parsers
 * Returns the list of available document parsers.
 */
router.get('/parsers', (req, res) => {
  res.json({ parsers: listParsers() });
});

/**
 * GET /api/import/check-duplicate
 * Query params: reg_number (optional), name (optional)
 * Returns duplicate matches found in current practice's eco_clients.
 */
router.get('/check-duplicate', async (req, res) => {
  try {
    const { reg_number, name } = req.query;
    if (!reg_number && !name) {
      return res.status(400).json({ error: 'Provide reg_number and/or name to check.' });
    }

    const practiceIds = await getPracticeIds(req);
    const duplicates  = await findDuplicates(reg_number || null, name || null, practiceIds);

    res.json({ isDuplicate: duplicates.length > 0, duplicates });
  } catch (err) {
    console.error('[pdfImport] check-duplicate error:', err.message);
    res.status(500).json({ error: 'Server error during duplicate check.' });
  }
});

/**
 * POST /api/import/pdf-extract
 * Accepts: multipart/form-data with field 'pdf'
 * Optional form field: 'parser_id' (defaults to auto-detect)
 *
 * Returns:
 * {
 *   parserId, parserName, recognized,
 *   fields:     { company_name, registration_number, company_type,
 *                 registration_date, address, directors },
 *   confidence: { ...per field: 'high'|'medium'|'low'|'not_found' },
 *   extractedTextLength: number,
 *   extractionMethod:    'pdf-text' | 'ocr',
 *   pageCount:           number,
 *   duplicate:           null | { id, name, id_number, match_type }[],
 *   warnings:            string[],
 * }
 */
router.post('/pdf-extract', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF uploaded. Use multipart/form-data with field name "pdf".' });
  }

  const parserId = req.body && req.body.parser_id ? req.body.parser_id : null;
  const warnings = [];

  try {
    // ── Step 1: Extract text from PDF ─────────────────────────────────────
    let extracted;
    try {
      extracted = await extractPdfText(req.file.buffer);
    } catch (extractErr) {
      if (extractErr.code === 'SCANNED_PDF_UNSUPPORTED') {
        return res.status(422).json({
          error: extractErr.message,
          code:  'SCANNED_PDF_UNSUPPORTED',
          hint:  'Use a text-based (digital) PDF from CIPC or request one from your client.',
        });
      }
      throw extractErr;
    }

    if (extracted.method === 'ocr') {
      warnings.push('This appears to be a scanned PDF. OCR extraction may be less accurate than text-based PDFs.');
    }

    if (extracted.text.length < 200) {
      warnings.push('Very little text was extracted from this PDF. Results may be incomplete.');
    }

    // ── Step 2: Parse document structure ──────────────────────────────────
    const parseResult = parseDocument(extracted.text, parserId);

    if (!parseResult.recognized) {
      warnings.push(
        'This document was not recognized as a standard CIPC registration document. ' +
        'Extraction is best-effort — please review all fields carefully.'
      );
    }

    // ── Step 3: Check for duplicates ──────────────────────────────────────
    let duplicates = null;
    try {
      const practiceIds = await getPracticeIds(req);
      const found = await findDuplicates(
        parseResult.fields.registration_number,
        parseResult.fields.company_name,
        practiceIds
      );
      if (found.length > 0) duplicates = found;
    } catch (dupErr) {
      console.warn('[pdfImport] duplicate check failed (non-fatal):', dupErr.message);
    }

    res.json({
      parserId:             parseResult.parserId,
      parserName:           parseResult.parserName,
      recognized:           parseResult.recognized,
      fields:               parseResult.fields,
      confidence:           parseResult.confidence,
      extractedTextLength:  extracted.text.length,
      extractionMethod:     extracted.method,
      pageCount:            extracted.pageCount || null,
      duplicate:            duplicates,
      warnings,
    });

  } catch (err) {
    console.error('[pdfImport] pdf-extract error:', err.message);
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

module.exports = router;
