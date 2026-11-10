/**
 * ============================================================================
 * Slips — slip reader (orchestrates the reading layers)
 * ============================================================================
 *   Layer 1  supplier memory (per company, human-confirmed)   supplierMemory.js
 *   Layer 2  Tesseract on our own server                      this file
 *              - text PDFs: read the text layer directly (no OCR needed)
 *              - photos: cleaned copy (imagePrep.js), several OCR passes,
 *                best-scoring pass wins (slipParser.js)
 *   Layer 3  external AI reader — DELIBERATELY NOT BUILT.
 *              Blocked until Ruan approves it and an API key exists.
 *              When it is added, it plugs in here and acts only on
 *              results where needsReview is true.
 *
 * The result is a SUGGESTION. Nothing here writes into a slip's fields.
 * ============================================================================
 */

'use strict';

const { parseSlipText, needsReview, ocrGoodEnough } = require('./slipParser');
const memory = require('./supplierMemory');

const OCR_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TIME_BUDGET_MS = 40000;

// Lazy so a missing native module / binary only disables reading, never the app.
function defaultDeps() {
  const ocrService = require('../../../sean/ocr-service');
  return {
    ocrAvailable: () => ocrService.isAvailable(),
    ocrImage: (buf, opts) => ocrService.extractTextFromImageDetailed(buf, opts),
    ocrScannedPdf: (buf) => ocrService.extractTextFromScannedPdf(buf, { psm: 4, maxPages: 3 }),
    prepareForOcr: (buf) => require('./imagePrep').prepareForOcr(buf),
    pdfText: async (buf) => {
      const pdfParse = require('pdf-parse');
      const res = await pdfParse(buf, { max: 3 });
      return res.text || '';
    },
    memoryLookup: memory.lookup,
  };
}

function result(status, extra = {}) {
  return {
    status,
    engine: extra.engine || 'tesseract',
    engine_detail: extra.engine_detail || null,
    raw_text: extra.raw_text || null,
    ocr_confidence: extra.ocr_confidence ?? null,
    suggestion: extra.suggestion || {},
    checks: extra.checks || [],
    needs_review: extra.needs_review ?? true,
    error: extra.error || null,
  };
}

/**
 * @param {{ buffer: Buffer, contentType: string, companyId: number }} input
 * @param {object} [deps]  injectable for tests
 */
async function readSlip({ buffer, contentType, companyId, vatRate }, deps = defaultDeps()) {
  const started = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started);
  let best = null; // { parsed, text, confidence, detail }
  let engine = 'tesseract';

  try {
    if (contentType === 'application/pdf') {
      const text = await deps.pdfText(buffer).catch(() => '');
      if (text.replace(/\s/g, '').length >= 30) {
        engine = 'pdf-text';
        best = { parsed: parseSlipText(text, { vatRate }), text, confidence: null, detail: 'pdf text layer' };
      } else {
        const avail = deps.ocrAvailable();
        if (!avail.pdfOcr) return withTime(result('unavailable', { engine: 'tesseract', error: 'PDF OCR is not available on this server' }), started);
        const out = await deps.ocrScannedPdf(buffer);
        best = { parsed: parseSlipText(out.text, { vatRate }), text: out.text, confidence: null, detail: 'scanned pdf psm4' };
      }
    } else if (OCR_IMAGE_TYPES.has(contentType)) {
      const avail = deps.ocrAvailable();
      if (!avail.imageOcr) return withTime(result('unavailable', { error: 'OCR is not available on this server' }), started);

      const prepared = await deps.prepareForOcr(buffer);
      // Pass order: likely-best first; stop as soon as total + date are confident.
      // psm 6 keeps right-aligned amounts on their line (psm 4 often drops them on slips).
      const passes = [
        { img: prepared.clean, psm: 6, detail: `clean${prepared.cropped ? '+crop' : ''} psm6` },
        { img: prepared.clean, psm: 4, detail: `clean${prepared.cropped ? '+crop' : ''} psm4` },
        { img: prepared.plain, psm: 6, detail: 'plain psm6' },
      ];
      for (const pass of passes) {
        if (best && ocrGoodEnough(best.parsed.fields)) break;
        if (best && timeLeft() < 12000) break;
        let out;
        try {
          out = await deps.ocrImage(pass.img, { psm: pass.psm, ext: '.png' });
        } catch (err) {
          if (!best) throw err;
          break;
        }
        const parsed = parseSlipText(out.text, { vatRate });
        const score = parsed.score + (out.confidence || 0) / 100;
        if (!best || score > best.score) best = { parsed, text: out.text, confidence: out.confidence, detail: pass.detail, score };
      }
    } else {
      return withTime(result('unsupported', { error: `Cannot read ${contentType} files yet` }), started);
    }

    // Layer 1: supplier memory, using whatever the OCR found.
    let fields = best.parsed.fields;
    const vatNo = fields.supplier_vat_number && fields.supplier_vat_number.value;
    const match = await deps.memoryLookup(companyId, best.text, vatNo || null);
    fields = memory.applyMemory(fields, match);

    return withTime(result('done', {
      engine,
      engine_detail: best.detail + (match ? ` + memory(${match.how})` : ''),
      raw_text: String(best.text || '').slice(0, 20000),
      ocr_confidence: best.confidence,
      suggestion: fields,
      checks: best.parsed.checks,
      needs_review: needsReview(fields),
    }), started);
  } catch (err) {
    return withTime(result('failed', { engine, error: String(err && err.message || err).slice(0, 500) }), started);
  }
}

function withTime(r, started) {
  r.duration_ms = Date.now() - started;
  return r;
}

module.exports = { readSlip, OCR_IMAGE_TYPES };
