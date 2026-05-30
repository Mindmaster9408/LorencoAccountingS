# SESSION HANDOFF — 2026-05-30

## What was built

### Supplier Invoice OCR Draft Layer — Phase 1

A forensic staging layer between OCR extraction and supplier invoice creation. The old flow posted to GL immediately on OCR upload; the new flow holds the extracted result in a draft table and requires explicit human approval before any invoice or GL journal is created.

#### New workflow

```
UPLOAD PDF/image
    ↓
InvoiceOcrService (existing, unchanged) → extracted fields + line items
    ↓
supplier_invoice_ocr_drafts (new table) — status='draft'
    ↓
HUMAN REVIEW — accountant corrects fields, maps GL accounts, confirms VAT
    ↓
APPROVE — supplier invoice created via safe atomic transaction path
    ↓
GL JOURNAL POSTED (existing JournalService, unchanged)
    ↓
draft status='converted', converted_supplier_invoice_id set
```

No GL journal is ever posted from an OCR upload. No supplier invoice is ever created without explicit human approval.

---

## Files changed this session

### New files

| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/063_supplier_invoice_ocr_drafts.sql` | Table + indexes for the draft staging layer |
| `accounting-ecosystem/backend/modules/accounting/routes/supplierOcrDrafts.js` | Full OCR draft lifecycle API (upload / review / reject / approve / file serve) |
| `accounting-ecosystem/frontend-accounting/supplier-invoice-ocr-review.html` | Side-by-side review UI: PDF/image on left, editable form on right |
| `accounting-ecosystem/backend/tests/supplier-invoice-ocr-drafts.test.js` | 26 unit tests covering governance invariants |
| `accounting-ecosystem/docs/accounting/SUPPLIER_INVOICE_OCR_DRAFT_LAYER_PHASE_1_REPORT.md` | Full implementation report for Phase 1 |
| `accounting-ecosystem/docs/accounting/SUPPLIER_INVOICE_OCR_INVENTORY_PLAN.md` | Architecture plan + Q&A that preceded Phase 1 build |
| `accounting-ecosystem/docs/future-build/SUPPLIER_INVOICE_OCR_AND_INVENTORY_ROADMAP.md` | Phase 2–6 roadmap |

### Modified files

| File | Changes |
|---|---|
| `accounting-ecosystem/backend/modules/accounting/index.js` | Mounted OCR drafts route before suppliers route |
| `accounting-ecosystem/frontend-accounting/suppliers.html` | Added OCR Drafts tab + upload button + pending review list + JS functions |

### Unchanged files (intentional)

The following existing files were NOT modified — they are used as-is by the new layer:

- `backend/sean/invoice-ocr-service.js` — OCR extraction (read-only by Phase 1)
- `backend/sean/ocr-service.js` — tesseract engine (untouched)
- `backend/modules/accounting/routes/suppliers.js` — invoice creation (called internally by approve endpoint)
- `backend/modules/accounting/services/journalService.js` — GL posting (called internally by approve endpoint)
- `backend/modules/accounting/services/auditLogger.js` — audit logging (used as-is)

---

## Root causes fixed / design decisions

### Why a staging table instead of calling the existing invoice route directly

The existing `POST /api/accounting/suppliers/invoices` posts to GL immediately. There was no draft state. The new `supplier_invoice_ocr_drafts` table provides the review holding area. The existing invoice creation route is called internally by the approve endpoint after all 7 validation gates pass.

### Why the OCR raw output is immutable

`ocr_raw`, `extracted_header`, and `extracted_lines` are written once on upload and never overwritten. This preserves the original OCR result for audit. The `reviewer_*` columns are what gets submitted for approval.

### Why approve requires 7 gates before creating an invoice

Gates enforce: draft exists + belongs to this company, not already converted, not rejected, supplier set, invoice date set, at least one line, every line has a GL account. Any missing field returns a clear 400 error — no partial invoice is ever created.

---

## Testing performed

**26 tests in `backend/tests/supplier-invoice-ocr-drafts.test.js`:**

| Suite | Tests |
|---|---|
| OCR Upload Governance | OCRD-01 to OCRD-04 |
| calcLineVAT helper | OCRD-05 to OCRD-09 |
| Approve validation gates | OCRD-10 to OCRD-16 |
| Lifecycle status transitions | OCRD-17 to OCRD-20 |
| No-localStorage invariant | OCRD-21 to OCRD-22 |
| Migration integrity | OCRD-23 to OCRD-26 |

Run: `cd accounting-ecosystem/backend && npx jest supplier-invoice-ocr-drafts --verbose`

---

## What was NOT changed (confirmed safe)

- Payroll module — untouched
- All existing supplier invoice routes — untouched
- Bank staging / OFX import — untouched
- Dashboard action queue — untouched
- Auth middleware — untouched
- Any existing migrations

---

## Mandatory action before deploying

**Migration 063 must be run in Supabase SQL Editor before this feature can be used.**

File: `accounting-ecosystem/database/migrations/063_supplier_invoice_ocr_drafts.sql`

Prerequisites: migrations 020 and 021 must already be applied (they define `update_updated_at_column()`).

---

## Follow-up notes and open risks

```
FOLLOW-UP NOTE
- Area: File storage for supplier invoice PDFs/images
- Dependency: Local disk path /backend/uploads/accounting/supplier_invoice_drafts/
- What was done now: Files stored on local disk consistent with bank attachments pattern
- What still needs to be checked: Files are lost on container redeploy (Zeabur)
- Risk if not checked: Reviewers lose the original invoice PDF when the container restarts
- Recommended next review point: Phase 4 — migrate to Supabase Storage bucket before production scale
```

```
FOLLOW-UP NOTE
- Area: Per-line VAT rate extraction
- Dependency: InvoiceOcrService
- What was done now: All lines default to 15% VAT rate
- What still needs to be checked: Zero-rated or exempt lines require manual override by reviewer
- Risk if not checked: VAT calculated incorrectly on invoices with mixed VAT rates
- Recommended next review point: When zero-rated invoices are reported as a real issue by pilot users
```

```
FOLLOW-UP NOTE
- Area: Inventory item mapping
- Dependency: inventory_items table, stock_movements table, purchase_receipts
- What was done now: Phase 1 is GL-account-only; no inventory impact from OCR drafts
- What still needs to be checked: Phase 2 design (see SUPPLIER_INVOICE_OCR_AND_INVENTORY_ROADMAP.md)
- Risk if not checked: Suppliers using invoices to update stock cannot do so yet
- Recommended next review point: After Phase 1 is stable in pilot
```

---

## Next recommended steps

1. Run migration 063 in Supabase SQL Editor
2. Smoke test upload → review → approve flow end-to-end against a real PDF
3. Confirm OCR Drafts tab is visible in suppliers.html after deployment
4. Plan Phase 2: inventory item mapping + stock receipt (see roadmap)
5. Plan Phase 4: Supabase Storage for persistent file retention

---

## Related documents

| Document | Location |
|---|---|
| Phase 1 implementation report | `docs/accounting/SUPPLIER_INVOICE_OCR_DRAFT_LAYER_PHASE_1_REPORT.md` |
| Architecture plan (pre-build) | `docs/accounting/SUPPLIER_INVOICE_OCR_INVENTORY_PLAN.md` |
| Phase 2–6 roadmap | `docs/future-build/SUPPLIER_INVOICE_OCR_AND_INVENTORY_ROADMAP.md` |
