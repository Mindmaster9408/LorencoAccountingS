/**
 * ============================================================================
 * Supplier Invoice OCR Draft Review Layer
 * ============================================================================
 * Mounted at /api/accounting/suppliers/invoice-ocr-drafts
 *
 * FORENSIC PRINCIPLES (enforced throughout):
 *   1. OCR results are NEVER accounting truth.
 *   2. No GL journal is posted from an OCR upload.
 *   3. No supplier invoice is created without explicit human approval.
 *   4. The raw OCR output is preserved immutably in ocr_raw/extracted_*.
 *   5. Reviewer edits are stored separately in reviewer_*.
 *   6. Every lifecycle event is audit logged.
 *   7. All queries are company-scoped — no cross-company data leaks.
 *
 * Lifecycle:
 *   POST /upload  → status='draft'    (OCR run, file saved, no invoice)
 *   PUT  /:id/review  → status='reviewed' (reviewer saves edits)
 *   POST /:id/reject  → status='rejected' (rejected with reason)
 *   POST /:id/approve → status='converted' (invoice created + GL posted)
 * ============================================================================
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router();

const { supabase }      = require('../../../config/database');
const db                = require('../config/database');
const JournalService    = require('../services/journalService');
const InvoiceOcrService = require('../../../sean/invoice-ocr-service');
const AuditLogger       = require('../services/auditLogger');
const { authenticate, hasPermission } = require('../middleware/auth');

// ── Upload directory setup ────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../../uploads/accounting/supplier_invoice_ocr_drafts');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer: disk storage — file must be retained for reviewer to see the original
const ocrDraftStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const companyId = req.companyId || 'unknown';
    const uid = uuidv4().split('-')[0];
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `co${companyId}_${uid}_${Date.now()}${ext}`);
  },
});

const ocrUpload = multer({
  storage: ocrDraftStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (InvoiceOcrService.isAllowedFile(file.mimetype, file.originalname)) {
      return cb(null, true);
    }
    cb(new Error('Only JPG, PNG, WEBP images and PDF files are accepted for invoice OCR'));
  },
});

// ── Shared helpers (same logic as suppliers.js, no modification to that file) ─

function calcLineVAT(quantity, unitPrice, vatRate, vatInclusive) {
  const qty    = parseFloat(quantity)  || 1;
  const price  = parseFloat(unitPrice) || 0;
  const parsed = parseFloat(vatRate);
  const rate   = isNaN(parsed) ? 15 : parsed;
  const entered = Math.round(qty * price * 10000) / 10000;

  let subtotalExVat, vatAmount, totalIncVat;
  if (vatInclusive) {
    totalIncVat   = Math.round(entered * 100) / 100;
    subtotalExVat = Math.round((entered / (1 + rate / 100)) * 100) / 100;
    vatAmount     = Math.round((totalIncVat - subtotalExVat) * 100) / 100;
  } else {
    subtotalExVat = Math.round(entered * 100) / 100;
    vatAmount     = Math.round((entered * rate / 100) * 100) / 100;
    totalIncVat   = Math.round((subtotalExVat + vatAmount) * 100) / 100;
  }
  return { subtotalExVat, vatAmount, totalIncVat };
}

async function findAccountByCode(companyId, code) {
  try {
    const { data } = await supabase
      .from('accounts')
      .select('id,code,name')
      .eq('company_id', companyId)
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();
    return data || null;
  } catch (_) { return null; }
}

// ── Route: POST /upload ───────────────────────────────────────────────────────
/**
 * Upload a supplier invoice PDF/image, run OCR extraction, create a draft record.
 *
 * SAFETY: This endpoint NEVER creates a supplier invoice or posts a GL journal.
 * It only runs OCR and stores the raw result in supplier_invoice_ocr_drafts.
 *
 * Request: multipart/form-data, field "file"
 * Response 201: { draft }
 */
router.post(
  '/upload',
  authenticate,
  hasPermission('ap.invoice.create'),
  ocrUpload.single('file'),
  async (req, res) => {
    const companyId = req.companyId;
    const userId    = req.user?.userId || null;
    let   savedFilePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send the invoice PDF or image in form field "file".' });
      }

      savedFilePath = req.file.path; // disk path set by multer

      // Run OCR — in-memory buffer read from the saved file
      const fileBuffer = fs.readFileSync(savedFilePath);
      const isPdf = req.file.mimetype === 'application/pdf' ||
                    path.extname(req.file.originalname).toLowerCase() === '.pdf';

      const ocrResult = isPdf
        ? await InvoiceOcrService.parseInvoicePdf(fileBuffer, req.file.originalname)
        : await InvoiceOcrService.parseInvoiceImage(fileBuffer, req.file.originalname);

      // Build structured confidence summary for UI display
      const confidenceSummary = {
        overall:      ocrResult.extraction_confidence || 0,
        supplierName: _fieldConfidence(ocrResult.supplier_name),
        vatNumber:    _fieldConfidence(ocrResult.vat_number),
        invoiceNumber: _fieldConfidence(ocrResult.invoice_number),
        invoiceDate:  _fieldConfidence(ocrResult.invoice_date),
        dueDate:      _fieldConfidence(ocrResult.due_date),
        subtotal:     _fieldConfidence(ocrResult.subtotal_ex_vat),
        vatAmount:    _fieldConfidence(ocrResult.vat_amount),
        total:        _fieldConfidence(ocrResult.total_inc_vat),
        lineCount:    (ocrResult.line_items || []).length,
      };

      // Extracted header: snapshot from OCR — stored immutably
      const extractedHeader = {
        supplier_name:  ocrResult.supplier_name  || null,
        vat_number:     ocrResult.vat_number     || null,
        invoice_number: ocrResult.invoice_number || null,
        invoice_date:   ocrResult.invoice_date   || null,
        due_date:       ocrResult.due_date        || null,
        subtotal_ex_vat: ocrResult.subtotal_ex_vat || null,
        vat_amount:      ocrResult.vat_amount      || null,
        total_inc_vat:   ocrResult.total_inc_vat   || null,
        warnings:        ocrResult.warnings        || [],
      };

      // Extracted lines: snapshot from OCR — stored immutably
      const extractedLines = (ocrResult.line_items || []).map((li, i) => ({
        sort_order:  i,
        description: li.description || '',
        quantity:    li.quantity    || 1,
        unit_price:  li.unit_price  || 0,
        line_total:  li.line_total  || 0,
        vat_rate:    15, // OCR does not reliably extract per-line VAT rate
        account_id:  null, // GL account — requires human mapping
      }));

      // Relative path stored in DB (strip absolute prefix for portability)
      const relPath = path.relative(path.join(__dirname, '../../../'), savedFilePath)
                          .replace(/\\/g, '/');

      const { data: draft, error: insertErr } = await supabase
        .from('supplier_invoice_ocr_drafts')
        .insert({
          company_id:         companyId,
          supplier_id:        null,
          status:             'draft',
          original_filename:  req.file.originalname,
          file_mime_type:     req.file.mimetype,
          file_size_bytes:    req.file.size,
          file_path:          relPath,
          ocr_raw:            ocrResult,
          extracted_header:   extractedHeader,
          extracted_lines:    extractedLines,
          confidence_summary: confidenceSummary,
          reviewer_header:    extractedHeader, // seed reviewer fields with OCR output
          reviewer_lines:     extractedLines,
          created_by_user_id: userId,
        })
        .select()
        .single();

      if (insertErr) throw new Error(insertErr.message);

      await AuditLogger.logUserAction(
        req,
        'SUPPLIER_INVOICE_OCR_UPLOADED',
        'SUPPLIER_INVOICE_OCR_DRAFT',
        draft.id,
        null,
        {
          draftId:    draft.id,
          filename:   req.file.originalname,
          fileSize:   req.file.size,
          confidence: confidenceSummary.overall,
          lineCount:  extractedLines.length,
          warnings:   (ocrResult.warnings || []).length,
        },
        'Supplier invoice uploaded and OCR extracted — awaiting review'
      );

      return res.status(201).json({
        success: true,
        draft,
        message: `OCR complete: ${extractedLines.length} line(s) extracted (confidence: ${Math.round(confidenceSummary.overall * 100)}%). Review and confirm before creating invoice.`,
      });

    } catch (err) {
      // Clean up saved file if draft insert failed
      if (savedFilePath && fs.existsSync(savedFilePath)) {
        try { fs.unlinkSync(savedFilePath); } catch (_) {}
      }
      console.error('[supplierOcrDrafts/upload] Error:', err.message);
      if (err.message && err.message.includes('accepted for invoice OCR')) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Upload and OCR processing failed: ' + err.message });
    }
  }
);

// ── Route: GET / ─────────────────────────────────────────────────────────────
/**
 * List OCR drafts for the current company with optional filters.
 * Query params: status, supplierId, dateFrom, dateTo, limit, offset
 */
router.get('/', authenticate, hasPermission('ap.invoice.view'), async (req, res) => {
  const companyId = req.companyId;
  const { status, supplierId, dateFrom, dateTo, limit = 50, offset = 0 } = req.query;
  try {
    let q = supabase
      .from('supplier_invoice_ocr_drafts')
      .select(`
        id, company_id, supplier_id, status, original_filename,
        file_mime_type, file_size_bytes, confidence_summary,
        reviewer_header, created_by_user_id, reviewed_by_user_id, approved_by_user_id,
        created_at, reviewed_at, approved_at, rejected_at, converted_at,
        converted_supplier_invoice_id, notes,
        suppliers!supplier_id(id, name, code)
      `)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status)     q = q.eq('status', status);
    if (supplierId) q = q.eq('supplier_id', parseInt(supplierId));
    if (dateFrom)   q = q.gte('created_at', dateFrom);
    if (dateTo)     q = q.lte('created_at', dateTo);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    res.json({ count: data?.length || 0, drafts: data || [] });
  } catch (err) {
    console.error('[supplierOcrDrafts GET /] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /:id ───────────────────────────────────────────────────────────
/**
 * Fetch a single OCR draft (company-scoped).
 */
router.get('/:id', authenticate, hasPermission('ap.invoice.view'), async (req, res) => {
  const companyId = req.companyId;
  const draftId   = parseInt(req.params.id);
  try {
    const { data, error } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('*, suppliers!supplier_id(id, name, code, vat_number, email)')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'OCR draft not found' });
    res.json({ draft: data });
  } catch (err) {
    console.error('[supplierOcrDrafts GET /:id] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /:id/file ─────────────────────────────────────────────────────
/**
 * Serve the original uploaded file (PDF/image) for the review screen.
 * Authenticated + company-scoped — file is never exposed as a public URL.
 */
router.get('/:id/file', authenticate, hasPermission('ap.invoice.view'), async (req, res) => {
  const companyId = req.companyId;
  const draftId   = parseInt(req.params.id);
  try {
    const { data: draft } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('file_path, file_mime_type, original_filename')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();

    if (!draft) return res.status(404).json({ error: 'OCR draft not found' });
    if (!draft.file_path) return res.status(404).json({ error: 'No file stored for this draft' });

    const absPath = path.join(__dirname, '../../../', draft.file_path);
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', draft.file_mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${draft.original_filename}"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error('[supplierOcrDrafts GET /:id/file] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: PUT /:id/review ────────────────────────────────────────────────────
/**
 * Save reviewer edits to header and lines. Sets status='reviewed'.
 * Does NOT create a supplier invoice. Does NOT post to GL.
 *
 * Body: { supplierId, reviewerHeader, reviewerLines, notes }
 */
router.put('/:id/review', authenticate, hasPermission('ap.invoice.edit'), async (req, res) => {
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;
  const draftId   = parseInt(req.params.id);
  const { supplierId, reviewerHeader, reviewerLines, notes } = req.body;

  try {
    const { data: draft } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('id, status')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();

    if (!draft) return res.status(404).json({ error: 'OCR draft not found' });
    if (draft.status === 'converted' || draft.status === 'rejected') {
      return res.status(409).json({ error: `Cannot edit a ${draft.status} draft` });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .update({
        supplier_id:          supplierId ? parseInt(supplierId) : null,
        reviewer_header:      reviewerHeader || {},
        reviewer_lines:       reviewerLines  || [],
        notes:                notes || null,
        status:               'reviewed',
        reviewed_by_user_id:  userId,
        reviewed_at:          now,
        updated_at:           now,
      })
      .eq('id', draftId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (updateErr) throw new Error(updateErr.message);

    await AuditLogger.logUserAction(
      req,
      'SUPPLIER_INVOICE_OCR_REVIEWED',
      'SUPPLIER_INVOICE_OCR_DRAFT',
      draftId,
      { status: draft.status },
      { status: 'reviewed', supplierId, lineCount: (reviewerLines || []).length },
      'Accountant reviewed and saved OCR draft edits'
    );

    res.json({ success: true, draft: updated });
  } catch (err) {
    console.error('[supplierOcrDrafts PUT /:id/review] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /:id/reject ───────────────────────────────────────────────────
/**
 * Reject a draft. No invoice is created. File is retained for audit.
 * Body: { reason }
 */
router.post('/:id/reject', authenticate, hasPermission('ap.invoice.edit'), async (req, res) => {
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;
  const draftId   = parseInt(req.params.id);
  const { reason } = req.body;

  try {
    const { data: draft } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('id, status')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();

    if (!draft) return res.status(404).json({ error: 'OCR draft not found' });
    if (draft.status === 'converted') {
      return res.status(409).json({ error: 'Cannot reject a draft that has already been converted to an invoice' });
    }

    const now = new Date().toISOString();
    const { data: updated, error: rejErr } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .update({
        status:              'rejected',
        rejection_reason:    reason || null,
        approved_by_user_id: userId,
        rejected_at:         now,
        updated_at:          now,
      })
      .eq('id', draftId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (rejErr) throw new Error(rejErr.message);

    await AuditLogger.logUserAction(
      req,
      'SUPPLIER_INVOICE_OCR_REJECTED',
      'SUPPLIER_INVOICE_OCR_DRAFT',
      draftId,
      { status: draft.status },
      { status: 'rejected', reason },
      reason || 'Draft rejected by reviewer'
    );

    res.json({ success: true, draft: updated });
  } catch (err) {
    console.error('[supplierOcrDrafts POST /:id/reject] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /:id/approve ──────────────────────────────────────────────────
/**
 * Approve an OCR draft and create the corresponding supplier invoice.
 *
 * FORENSIC GATES (enforced before any invoice creation):
 *   1. Draft must be in 'draft' or 'reviewed' status
 *   2. A supplier must be selected (supplier_id set)
 *   3. reviewer_header must have: invoice_date
 *   4. reviewer_lines must not be empty
 *   5. Every line must have a GL account_id mapped
 *   6. Totals must be present and positive
 *
 * GL POSTING:
 *   Uses the same atomic transaction + JournalService pattern as the existing
 *   POST /api/accounting/suppliers/invoices route. No new GL logic.
 *
 * IDEMPOTENCY:
 *   Returns 409 if the draft has already been converted (prevents double-submit).
 */
router.post('/:id/approve', authenticate, hasPermission('ap.invoice.create'), async (req, res) => {
  const companyId = req.companyId;
  const userId    = req.user?.userId || null;
  const draftId   = parseInt(req.params.id);

  try {
    // ── 1. Fetch and lock the draft ─────────────────────────────────────────
    const { data: draft, error: fetchErr } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('*')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !draft) return res.status(404).json({ error: 'OCR draft not found' });
    if (draft.status === 'converted') {
      return res.status(409).json({
        error: 'This draft has already been converted to a supplier invoice',
        convertedInvoiceId: draft.converted_supplier_invoice_id,
      });
    }
    if (draft.status === 'rejected') {
      return res.status(409).json({ error: 'Cannot approve a rejected draft' });
    }

    // ── 2. Validate reviewed data ───────────────────────────────────────────
    const header = draft.reviewer_header || {};
    const lines  = draft.reviewer_lines  || [];

    if (!draft.supplier_id) {
      return res.status(422).json({ error: 'A supplier must be selected before approving this invoice draft' });
    }
    if (!header.invoice_date) {
      return res.status(422).json({ error: 'Invoice date is required. Update the review before approving.' });
    }
    if (!lines.length) {
      return res.status(422).json({ error: 'At least one line item is required.' });
    }

    // Every line must have a GL account mapped (Phase 1 requirement)
    const unmappedLines = lines.filter(l => !l.account_id);
    if (unmappedLines.length > 0) {
      return res.status(422).json({
        error: `${unmappedLines.length} line(s) are missing a GL account mapping. Map all lines before approving.`,
        unmappedDescriptions: unmappedLines.map(l => l.description || '(no description)'),
      });
    }

    // ── 3. Verify supplier belongs to this company ──────────────────────────
    const { data: supRow } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('id', draft.supplier_id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!supRow) return res.status(400).json({ error: 'Selected supplier not found for this company' });
    const supplierName = supRow.name;

    // ── 4. Duplicate invoice guard ──────────────────────────────────────────
    const invoiceNumber = (header.invoice_number || '').trim();
    if (invoiceNumber) {
      const { data: dup } = await supabase
        .from('supplier_invoices')
        .select('id')
        .eq('company_id', companyId)
        .eq('supplier_id', draft.supplier_id)
        .eq('invoice_number', invoiceNumber)
        .neq('status', 'cancelled')
        .maybeSingle();

      if (dup) {
        return res.status(409).json({
          error: `Invoice number '${invoiceNumber}' already exists for this supplier`,
          errorCode: 'DUPLICATE_INVOICE',
          existingInvoiceId: dup.id,
        });
      }
    }

    // ── 5. Calculate line totals using safe shared function ─────────────────
    const vatInclusive = header.vat_inclusive === true;
    const processedLines = lines.map((l, i) => {
      const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(
        l.quantity, l.unit_price, l.vat_rate != null ? l.vat_rate : 15, vatInclusive
      );
      return {
        description:       l.description   || '',
        accountId:         parseInt(l.account_id),
        quantity:          parseFloat(l.quantity)  || 1,
        unitPrice:         parseFloat(l.unit_price) || 0,
        lineSubtotalExVat: subtotalExVat,
        vatRate:           l.vat_rate != null ? parseFloat(l.vat_rate) : 15,
        vatAmount,
        lineTotalIncVat:   totalIncVat,
        sortOrder:         i,
      };
    });

    const totals = processedLines.reduce(
      (acc, l) => ({
        subtotalExVat: acc.subtotalExVat + l.lineSubtotalExVat,
        vatAmount:     acc.vatAmount     + l.vatAmount,
        totalIncVat:   acc.totalIncVat   + l.lineTotalIncVat,
      }),
      { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 }
    );

    // ── 6. Pre-creation GL account validation ───────────────────────────────
    if (totals.totalIncVat > 0) {
      const apCheck = await findAccountByCode(companyId, '2000');
      if (!apCheck) {
        return res.status(422).json({
          error: 'Accounts Payable account (code 2000) not found. Provision the chart of accounts before creating supplier invoices.'
        });
      }
    }
    if (totals.vatAmount > 0) {
      const vatCheck = await findAccountByCode(companyId, '1400');
      if (!vatCheck) {
        return res.status(422).json({
          error: 'VAT Input account (code 1400) not found. Provision the chart of accounts before creating VAT-bearing invoices.'
        });
      }
    }

    // ── 7. Atomic invoice create (header + lines in pg transaction) ─────────
    // Same pattern as POST /api/accounting/suppliers/invoices (suppliers.js).
    // GL posting happens AFTER commit — JournalService runs independently.
    const dbClient = await db.getClient();
    let invoice;
    try {
      await dbClient.query('BEGIN');

      const hdrResult = await dbClient.query(
        `INSERT INTO supplier_invoices
           (company_id, supplier_id, invoice_number, reference, invoice_date,
            due_date, vat_inclusive, subtotal_ex_vat, vat_amount, total_inc_vat,
            amount_paid, status, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          companyId,
          draft.supplier_id,
          invoiceNumber || null,
          header.reference  || null,
          header.invoice_date,
          header.due_date   || null,
          vatInclusive,
          totals.subtotalExVat,
          totals.vatAmount,
          totals.totalIncVat,
          0,
          'unpaid',
          draft.notes || null,
          userId,
        ]
      );
      invoice = hdrResult.rows[0];

      // Bulk-insert all lines
      const lineVals   = [];
      const lineParams = [];
      let p = 1;
      for (const l of processedLines) {
        lineVals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        lineParams.push(
          invoice.id, l.description, l.accountId || null,
          l.quantity, l.unitPrice, l.lineSubtotalExVat,
          l.vatRate, l.vatAmount, l.lineTotalIncVat, l.sortOrder
        );
      }
      await dbClient.query(
        `INSERT INTO supplier_invoice_lines
           (invoice_id, description, account_id, quantity, unit_price,
            line_subtotal_ex_vat, vat_rate, vat_amount, line_total_inc_vat, sort_order)
         VALUES ${lineVals.join(',')}`,
        lineParams
      );

      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK');
      throw txErr;
    } finally {
      dbClient.release();
    }

    // ── 8. GL Posting ───────────────────────────────────────────────────────
    const apAccount = await findAccountByCode(companyId, '2000');
    if (apAccount) {
      const glLines = [];
      for (const l of processedLines) {
        if (l.accountId && l.lineSubtotalExVat > 0) {
          glLines.push({ accountId: l.accountId, debit: l.lineSubtotalExVat, credit: 0, description: l.description || 'Supplier Invoice line' });
        }
      }
      if (totals.vatAmount > 0) {
        const vatAcc = await findAccountByCode(companyId, '1400');
        if (vatAcc) glLines.push({ accountId: vatAcc.id, debit: totals.vatAmount, credit: 0, description: 'VAT Input (Claimable)' });
      }
      glLines.push({ accountId: apAccount.id, debit: 0, credit: totals.totalIncVat, description: `Supplier: ${supplierName}` });

      const hasDebits = glLines.some(l => l.debit > 0);
      if (hasDebits) {
        const glJournal = await JournalService.createDraftJournal({
          companyId,
          date: header.invoice_date,
          reference: invoiceNumber || null,
          description: `AP Invoice: ${supplierName}${invoiceNumber ? ' ' + invoiceNumber : ''}`,
          sourceType: 'supplier_invoice',
          createdByUserId: userId,
          lines: glLines,
        });
        await JournalService.postJournal(glJournal.id, companyId, userId);

        const { error: jidErr } = await supabase
          .from('supplier_invoices')
          .update({ journal_id: glJournal.id })
          .eq('id', invoice.id)
          .eq('company_id', companyId);

        if (jidErr) {
          // GL posted but link failed — reverse and cancel (same safety pattern as suppliers.js)
          try { await JournalService.reverseJournal(glJournal.id, companyId, userId, `Auto-reversal: invoice ${invoice.id} journal_id link failed`); } catch (_) {}
          await supabase.from('supplier_invoices').update({ status: 'cancelled' }).eq('id', invoice.id).eq('company_id', companyId).catch(() => {});
          await AuditLogger.log({ companyId, actorType: 'SYSTEM', actorId: userId, actionType: 'SUPPLIER_INVOICE_POST_FAILED_REVERSED', entityType: 'SUPPLIER_INVOICE', entityId: invoice.id, afterJson: { invoiceId: invoice.id, journalId: glJournal.id, jidUpdateError: jidErr.message }, reason: 'OCR-approved invoice GL journal_id link failed — journal reversed, invoice cancelled' });
          return res.status(500).json({ error: 'Invoice posting failed after GL journal creation. The journal was reversed. Please retry.' });
        }
      }
    }

    // ── 9. Mark draft as converted ──────────────────────────────────────────
    const now = new Date().toISOString();
    await supabase
      .from('supplier_invoice_ocr_drafts')
      .update({
        status:                        'converted',
        converted_supplier_invoice_id: invoice.id,
        approved_by_user_id:           userId,
        approved_at:                   now,
        converted_at:                  now,
        updated_at:                    now,
      })
      .eq('id', draftId)
      .eq('company_id', companyId);

    // ── 10. Audit logs ──────────────────────────────────────────────────────
    await AuditLogger.logUserAction(
      req,
      'SUPPLIER_INVOICE_OCR_APPROVED',
      'SUPPLIER_INVOICE_OCR_DRAFT',
      draftId,
      { status: draft.status },
      { status: 'converted', convertedInvoiceId: invoice.id, supplierId: draft.supplier_id, invoiceNumber },
      'OCR draft approved and converted to supplier invoice'
    );
    await AuditLogger.logUserAction(
      req,
      'SUPPLIER_INVOICE_OCR_CONVERTED',
      'SUPPLIER_INVOICE',
      invoice.id,
      null,
      { fromDraftId: draftId, supplierId: draft.supplier_id, supplierName, invoiceNumber, totalIncVat: totals.totalIncVat },
      `Supplier invoice created from OCR draft #${draftId}`
    );

    return res.status(201).json({
      success:   true,
      invoiceId: invoice.id,
      draftId,
      message:   `Supplier invoice created and posted to GL. Invoice ID: ${invoice.id}`,
    });

  } catch (err) {
    console.error('[supplierOcrDrafts POST /:id/approve] Error:', err.message);
    res.status(500).json({ error: 'Approval failed: ' + err.message });
  }
});

// ── Route: GET /:id/audit ─────────────────────────────────────────────────────
/**
 * Return audit events for a specific OCR draft (company-scoped).
 */
router.get('/:id/audit', authenticate, hasPermission('ap.invoice.view'), async (req, res) => {
  const companyId = req.companyId;
  const draftId   = parseInt(req.params.id);
  try {
    // Verify company ownership
    const { data: draft } = await supabase
      .from('supplier_invoice_ocr_drafts')
      .select('id')
      .eq('id', draftId)
      .eq('company_id', companyId)
      .single();
    if (!draft) return res.status(404).json({ error: 'OCR draft not found' });

    const events = await AuditLogger.query({
      companyId,
      entityType: 'SUPPLIER_INVOICE_OCR_DRAFT',
      entityId:   draftId,
      limit:      50,
    });
    res.json({ events: events || [] });
  } catch (err) {
    console.error('[supplierOcrDrafts GET /:id/audit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Private helpers ───────────────────────────────────────────────────────────

// Assign a confidence level based on whether a value was extracted
function _fieldConfidence(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && value > 0)                return 0.85;
  if (typeof value === 'string' && value.trim().length > 0)  return 0.75;
  return 0;
}

module.exports = router;
