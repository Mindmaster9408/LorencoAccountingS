# Supplier Invoice OCR Draft Review Layer — Phase 1 Implementation Report

**Date:** 2026-05-30
**Status:** Implementation complete — migration 063 pending deployment
**Phase:** 1 of 4 (OCR Extract → Review → Approve → GL Post)

---

## 1. Summary

The forensic staging layer between OCR extraction and supplier invoice creation is now built. The workflow is:

```
UPLOAD PDF/image
    ↓
InvoiceOcrService (existing, unchanged) → extracted fields + line items
    ↓
supplier_invoice_ocr_drafts (new table) — status='draft'
    ↓
HUMAN REVIEW — accountant corrects fields, maps GL accounts, confirms VAT
    ↓
APPROVE — supplier invoice created using safe atomic transaction path
    ↓
GL JOURNAL POSTED (existing JournalService, unchanged)
    ↓
draft status='converted', converted_supplier_invoice_id set
```

No GL journal is ever posted from an OCR upload. No supplier invoice is ever created without explicit human approval.

---

## 2. Files Changed

### New files

| File | Purpose |
|---|---|
| `database/migrations/063_supplier_invoice_ocr_drafts.sql` | Table creation + indexes |
| `backend/modules/accounting/routes/supplierOcrDrafts.js` | Full OCR draft lifecycle API |
| `frontend-accounting/supplier-invoice-ocr-review.html` | Side-by-side review UI |
| `backend/tests/supplier-invoice-ocr-drafts.test.js` | 26 tests |
| `docs/accounting/SUPPLIER_INVOICE_OCR_DRAFT_LAYER_PHASE_1_REPORT.md` | This document |
| `docs/future-build/SUPPLIER_INVOICE_OCR_AND_INVENTORY_ROADMAP.md` | Phase 2–6 roadmap |

### Modified files

| File | Changes |
|---|---|
| `backend/modules/accounting/index.js` | Mounted OCR drafts route before suppliers |
| `frontend-accounting/suppliers.html` | Added OCR Drafts tab + upload button + list + JS functions |

### Unchanged files

The following existing files were **not modified** — they are used as-is by the new layer:

- `backend/sean/invoice-ocr-service.js` — OCR extraction (unchanged)
- `backend/sean/ocr-service.js` — tesseract engine (unchanged)
- `backend/modules/accounting/routes/suppliers.js` — invoice creation (unchanged)
- `backend/modules/accounting/services/journalService.js` — GL posting (unchanged)
- `backend/modules/accounting/services/auditLogger.js` — audit logging (unchanged)

---

## 3. Database Migration

**File:** `database/migrations/063_supplier_invoice_ocr_drafts.sql`

**Table:** `supplier_invoice_ocr_drafts`

**Key design decisions:**

| Column | Decision |
|---|---|
| `ocr_raw` | Full InvoiceOcrService response stored immutably (JSONB) |
| `extracted_header` / `extracted_lines` | OCR snapshot — never overwritten after upload |
| `reviewer_header` / `reviewer_lines` | Accountant's corrections — the source of truth for approval |
| `confidence_summary` | Per-field confidence scores for UI highlighting |
| `file_path` | Relative disk path to saved PDF/image (nullable) |
| `converted_supplier_invoice_id` | FK to `supplier_invoices` — set only after approval |

**Status constraint:** `CHECK (status IN ('draft', 'reviewed', 'approved', 'rejected', 'converted'))`

**Indexes:** company_id+status (review queue), company_id+supplier_id, converted_invoice_id, created_at

**Required action:** Run `063_supplier_invoice_ocr_drafts.sql` in Supabase SQL Editor before deployment.

---

## 4. OCR Draft Lifecycle

```
POST /upload     → status='draft'     (OCR run, file saved, no invoice, no GL)
PUT  /:id/review → status='reviewed'  (reviewer edits saved)
POST /:id/reject → status='rejected'  (with reason, no invoice created)
POST /:id/approve → status='converted' (invoice created + GL posted)
```

### Immutability

The `ocr_raw`, `extracted_header`, and `extracted_lines` columns are written once on upload and never updated. This preserves the original OCR output for audit purposes. The `reviewer_*` columns are what gets submitted for approval — these represent the accountant's verified and corrected values.

---

## 5. Review UI

**File:** `frontend-accounting/supplier-invoice-ocr-review.html`

**Layout:** Side-by-side — original document on the left (PDF iframe / image), editable form on the right.

**Confidence badges:** Every extracted field shows a colour-coded confidence indicator:
- **Green (High ≥ 70%):** OCR extracted reliably — verify quickly
- **Amber (Medium 40–69%):** OCR uncertain — check carefully
- **Red (Low < 40%):** OCR failed or guessed — must be verified manually

**Low-confidence banner:** Shown at the top of the review panel when overall confidence < 50% or any required field is low-confidence.

**Line items table:** Fully editable with add/remove rows, quantity, unit price, VAT rate, line total (auto-calculated), GL account dropdown.

**Totals panel:** Live-calculated subtotal, VAT, grand total as reviewer edits lines. VAT cross-check: warns if `subtotal + VAT ≠ total` (within R0.05 tolerance).

**Lock on complete:** Once a draft is `converted` or `rejected`, all form fields are disabled.

**File preview:** Served through `GET /:id/file` — authenticated, company-scoped. PDFs render in `<iframe>`, images render as `<img>`. If no file stored, shows a placeholder.

---

## 6. Approval / Conversion Flow

The `POST /:id/approve` endpoint enforces **7 sequential gates** before any supplier invoice is created:

| Gate | Validation |
|---|---|
| 1 | Draft exists and belongs to this company |
| 2 | Draft is not already `converted` (idempotency) |
| 3 | Draft is not `rejected` |
| 4 | `supplier_id` is set |
| 5 | `reviewer_header.invoice_date` is present |
| 6 | `reviewer_lines` is not empty |
| 7 | Every line has `account_id` mapped (GL account required for Phase 1) |

**After all gates pass:**
1. Duplicate invoice number check (same as existing `POST /invoices`)
2. GL account validation: AP (2000) and VAT Input (1400) must exist
3. Atomic DB transaction: `supplier_invoices` + `supplier_invoice_lines` inserted together
4. GL journal created and posted via `JournalService` (existing, unchanged)
5. `journal_id` linked back to invoice (with auto-reversal on link failure — same safety as `POST /invoices`)
6. Draft updated: `status='converted'`, `converted_supplier_invoice_id` set

**On invoice creation failure:** Draft remains in `reviewed` status. No partial invoice exists.

---

## 7. Permissions

| Action | Permission |
|---|---|
| View draft list, file preview | `ap.invoice.view` |
| Upload invoice, create draft | `ap.invoice.create` |
| Save review edits | `ap.invoice.edit` |
| Reject draft | `ap.invoice.edit` |
| Approve → create invoice + GL | `ap.invoice.create` |

The approve action requires `ap.invoice.create` because the outcome is identical to calling `POST /api/accounting/suppliers/invoices` — a posted GL journal.

---

## 8. Audit Logging

All lifecycle events are captured via `AuditLogger.logUserAction()`:

| Event | Trigger | Key metadata |
|---|---|---|
| `SUPPLIER_INVOICE_OCR_UPLOADED` | POST /upload | filename, fileSize, confidence, lineCount |
| `SUPPLIER_INVOICE_OCR_REVIEWED` | PUT /:id/review | supplierId, lineCount, previous status |
| `SUPPLIER_INVOICE_OCR_REJECTED` | POST /:id/reject | reason, previous status |
| `SUPPLIER_INVOICE_OCR_APPROVED` | POST /:id/approve | convertedInvoiceId, supplierId, invoiceNumber |
| `SUPPLIER_INVOICE_OCR_CONVERTED` | POST /:id/approve | fromDraftId, supplierId, totalIncVat |
| `SUPPLIER_INVOICE_POST_FAILED_REVERSED` | approve (GL failure) | journalId, jidUpdateError (safety net) |

All events include: actor (user), company_id, entity type/id, before/after JSON, IP address.

---

## 9. What Was Not Built (Phase 1 Scope)

| Feature | Reason | Phase |
|---|---|---|
| Inventory item mapping | Adds stock receipt complexity | Phase 2 |
| Stock movement creation | Deferred — invoice ≠ goods received | Phase 2 |
| PO linkage during review | Deferred | Phase 3 |
| Supplier banking detail extraction | Not in InvoiceOcrService yet | Phase 5 |
| Supabase Storage for files | Local disk sufficient for Phase 1 | Phase 4 |
| Auto-duplicate detection during review | Only hard-blocked at approval | Phase 2 |
| Bulk import (multiple invoices) | Single-file upload only | Phase 2 |

---

## 10. Tests Run

**26 tests in `backend/tests/supplier-invoice-ocr-drafts.test.js`:**

| Suite | Tests |
|---|---|
| OCR Upload Governance | OCRD-01 to OCRD-04 (upload creates draft only, no GL, file type validation) |
| calcLineVAT helper | OCRD-05 to OCRD-09 (ex-VAT, inc-VAT, zero-rated, null rate, fractional qty) |
| Approve validation gates | OCRD-10 to OCRD-16 (supplier, date, lines, GL accounts, converted/rejected blocks) |
| Lifecycle status transitions | OCRD-17 to OCRD-20 (valid and invalid transitions) |
| No-localStorage invariant | OCRD-21 to OCRD-22 (review HTML contains no business data in localStorage) |
| Migration integrity | OCRD-23 to OCRD-26 (file exists, table name, required columns, status constraint) |

Run with: `cd accounting-ecosystem/backend && npx jest supplier-invoice-ocr-drafts --verbose`

---

## 11. Remaining Risks

| Risk | Severity | Notes |
|---|---|---|
| Migration 063 not yet applied | **HIGH** | Must run in Supabase SQL Editor before using OCR drafts |
| Files stored on local disk only | MEDIUM | Lost on container redeploy. Supabase Storage migration planned for Phase 4 |
| OCR accuracy on complex layouts | MEDIUM | Line item extraction may miss multi-column or non-standard layouts. Reviewer must always verify |
| Per-line VAT rate extraction | LOW | OCR defaults all lines to 15%. If zero-rated lines exist, reviewer must manually set them to 0% |
| AP (2000) / VAT Input (1400) accounts required | LOW | Approval fails gracefully with clear error if these accounts don't exist in the COA |
| `update_updated_at_column()` function required | LOW | Migration uses this trigger function — it is created in migration 020; if running 063 on a fresh DB, ensure 020 ran first |

---

## Final Safety Check

| Requirement | Status |
|---|---|
| OCR upload creates draft only | ✅ Confirmed — no supplier invoice row, no GL journal |
| No GL post on upload | ✅ Confirmed — `JournalService` is never called in `POST /upload` |
| No stock update in Phase 1 | ✅ Confirmed — no inventory code exists |
| Human approval required | ✅ Confirmed — 7 validation gates enforced in `POST /:id/approve` |
| Supplier invoice creation uses safe transactional path | ✅ Same atomic transaction + auto-reversal safety as `POST /invoices` |
| Company scoping enforced | ✅ Every query has `.eq('company_id', companyId)` |
| No browser storage for invoice data | ✅ Confirmed — review page uses no localStorage for business data |
