'use strict';

/**
 * ============================================================================
 * Invoice OCR Service
 * ============================================================================
 * Extracts structured invoice data from image files and text-based PDFs.
 * Uses the existing OcrService (tesseract) for images and pdf-parse for PDFs.
 *
 * IMPORTANT: All extracted fields are tagged status='UNVERIFIED'.
 * This service NEVER writes to the database.
 * The caller receives the extraction result and the user must confirm all
 * fields before any invoice record is created.
 *
 * Designed for South African supplier invoices (ZAR, 15% VAT standard).
 * Patterns are heuristic-based — imperfect extraction is expected and
 * communicated via the `extraction_confidence` field in the result.
 *
 * Exports:
 *   parseInvoiceImage(buffer, filename, options) → InvoiceExtractionResult
 *   parseInvoicePdf(buffer, filename, options)   → InvoiceExtractionResult
 *
 * InvoiceExtractionResult:
 * {
 *   status:                'UNVERIFIED',
 *   extraction_confidence: number,          // 0–1 overall confidence
 *   supplier_name:         string|null,
 *   vat_number:            string|null,     // SARS format: 10 digits or 4xxxxxxxx
 *   invoice_number:        string|null,
 *   invoice_date:          string|null,     // YYYY-MM-DD or null
 *   due_date:              string|null,
 *   subtotal_ex_vat:       number|null,
 *   vat_amount:            number|null,
 *   total_inc_vat:         number|null,
 *   line_items:            LineItem[],
 *   raw_text_sample:       string,          // first 400 chars of OCR text (diagnostic)
 *   warnings:              string[],
 * }
 *
 * LineItem:
 * {
 *   description:  string,
 *   quantity:     number,
 *   unit_price:   number,
 *   line_total:   number,
 * }
 * ============================================================================
 */

const OcrService = require('./ocr-service');

// pdf-parse: same compat shim as PdfStatementImportService
const _pdfParseLib = require('pdf-parse');
const pdfParse = typeof _pdfParseLib === 'function'
  ? _pdfParseLib
  : (_pdfParseLib.default || _pdfParseLib.parse || null);

// ── Regex patterns ────────────────────────────────────────────────────────────

// VAT number: SARS format is 10 digits starting with 4 (e.g., 4190123456)
const RE_VAT_NUMBER = /(?:vat\s*(?:reg(?:istration)?|no\.?|number|#|:)\s*)(\d{10}|\d{4}[0-9]{6})/i;

// Invoice number: flexible — handles INV-0001, Invoice No: 12345, # 00123, etc.
const RE_INVOICE_NUMBER = /(?:invoice\s*(?:no\.?|num(?:ber)?|#)|inv\.?\s*(?:no\.?|#|:)\s*)([A-Z0-9\-\/]{3,30})/i;

// Tax invoice marker (confirms this is a tax invoice, not a quote/statement)
const RE_TAX_INVOICE = /tax\s+invoice/i;

// Date patterns — covers DD/MM/YYYY, DD-MM-YYYY, DD Month YYYY, YYYY-MM-DD
const RE_DATE_LABEL = /(?:invoice\s+)?date\s*[:\-]?\s*/i;
const RE_DUE_DATE_LABEL = /(?:due\s+date|payment\s+due|pay\s+by)\s*[:\-]?\s*/i;

const MONTH_NAMES = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Amount patterns: captures R 1,234.56 or 1234.56 or 1 234.56
const RE_CURRENCY = /(?:R\s*)?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?)/;

// Total line: matches "Total", "Total Due", "Amount Due", "Grand Total", "Invoice Total"
const RE_TOTAL_LABEL = /(?:grand\s+total|total\s+(?:due|inc\.?\s*vat|amount|payable)|amount\s+(?:due|payable)|invoice\s+total|total)\s*[:\-]?\s*/i;
const RE_SUBTOTAL_LABEL = /(?:sub\s*total|subtotal|total\s+ex\.?\s*vat|amount\s+ex\.?\s*vat|net\s+amount)\s*[:\-]?\s*/i;
const RE_VAT_AMOUNT_LABEL = /(?:vat\s*(?:\d+%)?|tax\s+amount)\s*[:\-]?\s*/i;


// ── Helper: parse a date string to YYYY-MM-DD ─────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD/MM/YYYY or DD-MM-YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

  // DD Month YYYY (e.g., 15 January 2024)
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mn = MONTH_NAMES[m[2].toLowerCase().slice(0,3)];
    if (mn) return `${m[3]}-${mn}-${m[1].padStart(2,'0')}`;
  }

  // Month DD, YYYY (e.g., January 15, 2024)
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mn = MONTH_NAMES[m[1].toLowerCase().slice(0,3)];
    if (mn) return `${m[3]}-${mn}-${m[2].padStart(2,'0')}`;
  }

  return null;
}


// ── Helper: parse a currency amount string to a number ───────────────────────

function parseAmount(raw) {
  if (!raw) return null;
  // Remove R, spaces, commas — keep digits and decimal point
  const cleaned = raw.replace(/[R\s,]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}


// ── Helper: extract a labeled value from text ─────────────────────────────────

function extractLabeledValue(text, labelRegex) {
  // Build a full regex that captures what follows the label on the same line
  const fullPattern = new RegExp(
    labelRegex.source + '([^\\n]{1,60})',
    'im'
  );
  const m = text.match(fullPattern);
  return m ? m[m.length - 1].trim() : null;
}


// ── Helper: extract amount after a label ─────────────────────────────────────

function extractAmountAfterLabel(text, labelRegex) {
  const raw = extractLabeledValue(text, labelRegex);
  if (!raw) return null;
  // Try to find a number in the captured string
  const m = raw.match(/R?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?)/);
  if (!m) return null;
  return parseAmount(m[0]);
}


// ── Helper: extract date after a label ───────────────────────────────────────

function extractDateAfterLabel(text, labelRegex) {
  const raw = extractLabeledValue(text, labelRegex);
  if (!raw) return null;
  // Try multiple date patterns
  const patterns = [
    /\d{4}-\d{2}-\d{2}/,
    /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/,
    /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/i,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return parseDate(m[0]);
  }
  return null;
}


// ── Helper: extract supplier name from text ───────────────────────────────────

function extractSupplierName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Heuristic: supplier name is usually in the first 5 non-empty lines,
  // before "TAX INVOICE" heading. Look for a line that is mostly uppercase
  // and is reasonably long (3-60 chars).
  for (const line of lines.slice(0, 8)) {
    if (RE_TAX_INVOICE.test(line)) break;
    // Skip lines that look like addresses (contain numbers+street patterns)
    if (/^\d+\s+\w/.test(line)) continue;
    // Skip lines that look like contact info
    if (/tel|fax|email|www\.|@/.test(line.toLowerCase())) continue;
    // Accept lines that look like a company name (letters + optional spaces/punctuation)
    if (/^[A-Z][A-Za-z\s&()\-\.,]{2,59}$/.test(line)) {
      return line;
    }
  }

  // Fallback: try explicit "From:" label
  const m = text.match(/from\s*:\s*([A-Za-z][A-Za-z\s&()\-\.,]{2,59})/i);
  return m ? m[1].trim() : null;
}


// ── Helper: extract line items from text ──────────────────────────────────────

function extractLineItems(text) {
  const items = [];

  // Strategy: find table rows that have: description + qty + price + total
  // Pattern: text followed by numbers at end of line
  // e.g.: "Professional Services  1  5,000.00  5,000.00"
  const linePattern = /^(.{3,50?})\s+(\d+(?:\.\d+)?)\s+R?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?)\s+R?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?)\s*$/gim;

  let m;
  while ((m = linePattern.exec(text)) !== null) {
    const qty       = parseFloat(m[2]);
    const unitPrice = parseAmount(m[3]);
    const lineTotal = parseAmount(m[4]);

    if (!isNaN(qty) && unitPrice !== null && lineTotal !== null) {
      // Sanity check: qty * unitPrice ≈ lineTotal (within 5%)
      const expected = Math.round(qty * unitPrice * 100) / 100;
      if (Math.abs(expected - lineTotal) / (lineTotal || 1) <= 0.05) {
        items.push({
          description: m[1].trim(),
          quantity:    qty,
          unit_price:  unitPrice,
          line_total:  lineTotal,
        });
      }
    }
  }

  // Fallback: if no structured items found, create a single item from total
  return items;
}


// ── Core extraction logic ─────────────────────────────────────────────────────

/**
 * Parse raw OCR/PDF text into structured invoice fields.
 * @param {string} text — raw extracted text
 * @returns {Partial<InvoiceExtractionResult>}
 */
function extractInvoiceFields(text) {
  const warnings = [];
  let fieldCount = 0; // track how many fields were successfully extracted

  // Supplier name
  const supplierName = extractSupplierName(text);
  if (supplierName) fieldCount++;
  else warnings.push('Could not extract supplier name — first lines may not match expected pattern');

  // VAT number
  const vatM = text.match(RE_VAT_NUMBER);
  const vatNumber = vatM ? vatM[1].trim() : null;
  if (vatNumber) fieldCount++;

  // Invoice number
  const invM = text.match(RE_INVOICE_NUMBER);
  const invoiceNumber = invM ? invM[1].trim() : null;
  if (invoiceNumber) fieldCount++;
  else warnings.push('Could not extract invoice number');

  // Invoice date
  const invoiceDate = extractDateAfterLabel(text, RE_DATE_LABEL);
  if (invoiceDate) fieldCount++;
  else warnings.push('Could not extract invoice date');

  // Due date (optional)
  const dueDate = extractDateAfterLabel(text, RE_DUE_DATE_LABEL);

  // Amounts
  const total    = extractAmountAfterLabel(text, RE_TOTAL_LABEL);
  const subtotal = extractAmountAfterLabel(text, RE_SUBTOTAL_LABEL);
  const vatAmt   = extractAmountAfterLabel(text, RE_VAT_AMOUNT_LABEL);

  if (total !== null) fieldCount++;
  else warnings.push('Could not extract total amount');

  // Cross-validate: subtotal + VAT should ≈ total (if all three found)
  if (subtotal !== null && vatAmt !== null && total !== null) {
    const computed = Math.round((subtotal + vatAmt) * 100) / 100;
    if (Math.abs(computed - total) > 0.02) {
      warnings.push(
        `Amount cross-check failed: subtotal (${subtotal}) + VAT (${vatAmt}) = ${computed} ≠ total (${total}). ` +
        'Please verify amounts manually.'
      );
    }
  }

  // Line items
  const lineItems = extractLineItems(text);
  if (lineItems.length > 0) fieldCount += 2; // bonus for having structure

  // If no line items and total is known, create a single fallback item
  if (lineItems.length === 0 && total !== null) {
    const netAmount = subtotal !== null ? subtotal : (
      vatAmt !== null && total !== null
        ? Math.round((total - vatAmt) * 100) / 100
        : total
    );
    lineItems.push({
      description: supplierName ? `Invoice from ${supplierName}` : 'Invoice item (extracted)',
      quantity:    1,
      unit_price:  netAmount,
      line_total:  netAmount,
    });
    warnings.push('Line items could not be extracted — single fallback line created from invoice total');
  }

  // Confidence scoring: 0=nothing found, 1=everything found
  // Weight: invoiceNumber=2, total=2, date=1.5, supplier=1, vat=0.5 = max 7 points
  const maxPoints = 7;
  const points =
    (invoiceNumber ? 2 : 0) +
    (total !== null ? 2 : 0) +
    (invoiceDate ? 1.5 : 0) +
    (supplierName ? 1 : 0) +
    (vatNumber ? 0.5 : 0);
  const extractionConfidence = Math.min(Math.round((points / maxPoints) * 100) / 100, 1);

  return {
    status:                'UNVERIFIED',
    extraction_confidence: extractionConfidence,
    supplier_name:         supplierName,
    vat_number:            vatNumber,
    invoice_number:        invoiceNumber,
    invoice_date:          invoiceDate,
    due_date:              dueDate,
    subtotal_ex_vat:       subtotal,
    vat_amount:            vatAmt,
    total_inc_vat:         total,
    line_items:            lineItems,
    warnings,
  };
}


// ── Public API ────────────────────────────────────────────────────────────────

const InvoiceOcrService = {

  /**
   * Extract invoice data from an image file (JPG, PNG, WEBP).
   * Uses OcrService (tesseract) for text extraction.
   *
   * @param {Buffer} buffer     — image file buffer
   * @param {string} filename   — original filename
   * @param {object} [options]  — { psm: number (default 6) }
   * @returns {Promise<InvoiceExtractionResult>}
   */
  async parseInvoiceImage(buffer, filename, options = {}) {
    const caps = OcrService.isAvailable();
    if (!caps.tesseract) {
      return {
        status: 'ERROR',
        extraction_confidence: 0,
        error: 'OCR service (tesseract) is not available on this server. Contact support.',
        supplier_name: null, vat_number: null, invoice_number: null,
        invoice_date: null, due_date: null, subtotal_ex_vat: null,
        vat_amount: null, total_inc_vat: null, line_items: [], warnings: [],
        raw_text_sample: '',
      };
    }

    let ocrResult;
    try {
      ocrResult = await OcrService.extractTextFromImage(buffer, {
        psm: options.psm || 6,  // single uniform block — good for invoices
        oem: 1,                  // LSTM engine
      });
    } catch (err) {
      return {
        status: 'ERROR',
        extraction_confidence: 0,
        error: `OCR extraction failed: ${err.message}`,
        supplier_name: null, vat_number: null, invoice_number: null,
        invoice_date: null, due_date: null, subtotal_ex_vat: null,
        vat_amount: null, total_inc_vat: null, line_items: [],
        warnings: [`OCR error: ${err.message}`],
        raw_text_sample: '',
      };
    }

    const text = ocrResult.text || '';
    if (text.split(/\s+/).filter(w => w.length > 0).length < 5) {
      return {
        status: 'UNVERIFIED',
        extraction_confidence: 0,
        error: 'OCR produced insufficient text. The image may be low quality or not a valid invoice.',
        supplier_name: null, vat_number: null, invoice_number: null,
        invoice_date: null, due_date: null, subtotal_ex_vat: null,
        vat_amount: null, total_inc_vat: null, line_items: [],
        warnings: ['Insufficient OCR output — please ensure image is clear and well-lit'],
        raw_text_sample: text.slice(0, 400),
      };
    }

    const fields = extractInvoiceFields(text);
    return {
      ...fields,
      raw_text_sample: text.slice(0, 400),
    };
  },


  /**
   * Extract invoice data from a text-based PDF.
   * Uses pdf-parse for text extraction.
   * Falls back to OCR if text is insufficient (scanned PDF).
   *
   * @param {Buffer} buffer     — PDF file buffer
   * @param {string} filename   — original filename
   * @returns {Promise<InvoiceExtractionResult>}
   */
  async parseInvoicePdf(buffer, filename) {
    if (!pdfParse) {
      return {
        status: 'ERROR',
        extraction_confidence: 0,
        error: 'pdf-parse library is not available. Run npm install pdf-parse in backend/.',
        supplier_name: null, vat_number: null, invoice_number: null,
        invoice_date: null, due_date: null, subtotal_ex_vat: null,
        vat_amount: null, total_inc_vat: null, line_items: [], warnings: [],
        raw_text_sample: '',
      };
    }

    let pdfData;
    try {
      pdfData = await pdfParse(buffer, { pagerender: null });
    } catch (err) {
      return {
        status: 'ERROR',
        extraction_confidence: 0,
        error: `Failed to read PDF: ${err.message}. The file may be corrupted or password-protected.`,
        supplier_name: null, vat_number: null, invoice_number: null,
        invoice_date: null, due_date: null, subtotal_ex_vat: null,
        vat_amount: null, total_inc_vat: null, line_items: [], warnings: [],
        raw_text_sample: '',
      };
    }

    let text = (pdfData.text || '').trim();
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    // Scanned PDF — attempt OCR
    if (wordCount < 15) {
      const caps = OcrService.isAvailable();
      if (!caps.pdfOcr) {
        return {
          status: 'UNVERIFIED',
          extraction_confidence: 0,
          error: 'This appears to be a scanned PDF and OCR is not available. Please upload a JPG/PNG image instead.',
          supplier_name: null, vat_number: null, invoice_number: null,
          invoice_date: null, due_date: null, subtotal_ex_vat: null,
          vat_amount: null, total_inc_vat: null, line_items: [],
          warnings: ['Scanned PDF detected — OCR unavailable'],
          raw_text_sample: text.slice(0, 400),
        };
      }

      try {
        const ocrResult = await OcrService.extractTextFromScannedPdf(buffer, { dpi: 300, psm: 6 });
        text = ocrResult.text || '';
      } catch (err) {
        return {
          status: 'ERROR',
          extraction_confidence: 0,
          error: `Scanned PDF OCR failed: ${err.message}`,
          supplier_name: null, vat_number: null, invoice_number: null,
          invoice_date: null, due_date: null, subtotal_ex_vat: null,
          vat_amount: null, total_inc_vat: null, line_items: [], warnings: [],
          raw_text_sample: '',
        };
      }
    }

    const fields = extractInvoiceFields(text);
    return {
      ...fields,
      raw_text_sample: text.slice(0, 400),
    };
  },


  /**
   * Check if an uploaded file can be processed.
   * @param {string} mimetype
   * @param {string} filename
   * @returns {boolean}
   */
  isAllowedFile(mimetype, filename) {
    const allowedMimes = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
      'application/pdf',
    ]);
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
    const ext = (filename || '').toLowerCase().match(/\.[^.]+$/)?.[0];

    return allowedMimes.has(mimetype) || allowedExts.has(ext);
  },
};

module.exports = InvoiceOcrService;
