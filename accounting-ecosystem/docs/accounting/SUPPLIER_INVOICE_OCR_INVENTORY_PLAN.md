# Supplier Invoice PDF/OCR Extraction + Inventory Impact Plan

**Date:** 2026-05-30
**Type:** Architecture Plan — Audit Only — No Code Changes
**Status:** Design phase — awaiting Ruan's sign-off before Phase 1 build begins

---

## 1. Current OCR Capability

### What exists

The OCR infrastructure is **fully built and functional**. Three services are in production:

| File | Purpose |
|---|---|
| `backend/sean/ocr-service.js` | Core text extraction engine (tesseract + pdftoppm) |
| `backend/sean/invoice-ocr-service.js` | Structured invoice field + line item extraction |
| `backend/sean/image-statement-import-service.js` | Bank statement OCR pipeline (separate use case) |

### Invoice OCR capability in detail

`InvoiceOcrService` already handles both PDF and image input and extracts the following structured fields:

| Field | Extracted | Notes |
|---|---|---|
| Supplier name | ✅ | Heuristic: first uppercase line before "TAX INVOICE" |
| VAT number | ✅ | SARS format: 10-digit code pattern 4xxxxxxxx |
| Invoice number | ✅ | Labeled value regex |
| Invoice date | ✅ | Multiple SA date formats: DD/MM/YYYY, YYYY-MM-DD, text month |
| Due date | ✅ | Optional |
| Subtotal ex-VAT | ✅ | Cross-validated against VAT + total |
| VAT amount | ✅ | Cross-validated (within R0.02 tolerance) |
| Total inc-VAT | ✅ | Cross-validated |
| Line items | ✅ | description, quantity, unit_price, line_total |
| Banking / reference | ❌ | Not currently extracted (future) |

**Line item extraction:** YES — the service detects table-style layouts and extracts individual rows. If no structured line items are found, it creates a single fallback item from the invoice total with `description='Invoice Total'`.

**Confidence scoring:** 0–1 scale, based on which fields were successfully extracted:
- Invoice number: 2 pts
- Total amount: 2 pts
- Invoice date: 1.5 pts
- Supplier name: 1 pt
- VAT number: 0.5 pts
- 7 pts max

**Critical safety rule (already enforced):** Every extracted field is marked `status: 'UNVERIFIED'`. The service never writes to the database. It is a pure parse-and-return operation.

### What the OCR does NOT yet extract

- Supplier banking details (account number, branch code) — useful for payment setup
- Per-line VAT rates (extracts line total but not separate VAT rate per line)
- Discount per line
- Line-level account code suggestions (inventory item matching)

---

## 2. Existing Supplier Invoice Flow

### Current data model

```
suppliers                    (master supplier records)
  ↓
supplier_invoices            (invoice header — posts to GL immediately on creation)
  ↓
supplier_invoice_lines       (line items: description, qty, unit_price, VAT)
  ↓
accounting_audit_log         (full before/after audit trail)
```

Supporting tables:
- `supplier_payments` — payment records, posts to GL immediately
- `supplier_payment_allocations` — payment-to-invoice matching
- `purchase_orders` + `purchase_order_lines` — PO management
- `purchase_receipts` + `purchase_receipt_lines` — goods received (immutable ledger)
- `supplier_item_history` — learning table: supplier × item last cost, lead time

### Existing API

| Endpoint | Behaviour |
|---|---|
| `POST /api/accounting/suppliers/invoices/ocr` | Parse PDF/image, return extracted fields — NO DB write |
| `POST /api/accounting/suppliers/invoices` | Create invoice + lines + **post GL journal immediately** |
| `PUT /api/accounting/suppliers/invoices/:id` | Edit invoice + **reverse old GL + post corrected journal** |
| `GET /api/accounting/suppliers/orders/:id` | PO detail with lines |
| `PUT /api/accounting/suppliers/orders/:id/status` | PO status progression |

### The critical design gap

**The current `POST /api/accounting/suppliers/invoices` endpoint posts to GL immediately.** There is no draft stage. The proposed workflow requires a forensic review step between OCR extraction and GL posting — this is the primary design challenge for Phase 1.

---

## 3. Required Extraction Fields

### Fields the extraction must return for review

| Category | Field | Source | Priority |
|---|---|---|---|
| **Header** | Supplier name | OCR | P1 |
| **Header** | VAT number | OCR | P1 |
| **Header** | Invoice number | OCR | P1 |
| **Header** | Invoice date | OCR | P1 |
| **Header** | Due date | OCR | P2 |
| **Header** | Subtotal ex-VAT | OCR | P1 |
| **Header** | VAT amount | OCR | P1 |
| **Header** | Total inc-VAT | OCR | P1 |
| **Header** | VAT inclusive flag | User judgement | P1 |
| **Lines** | Description (raw from invoice) | OCR | P1 |
| **Lines** | Quantity | OCR | P1 |
| **Lines** | Unit price | OCR | P1 |
| **Lines** | VAT rate per line | OCR (limited) / assumed 15% | P2 |
| **Lines** | Discount per line | OCR (limited) | P3 |
| **Lines** | Line total | OCR | P1 |
| **Mapping** | Matched inventory item | Human + system suggestion | P2 |
| **Mapping** | GL account for line | Human + system suggestion | P1 |
| **Banking** | Supplier bank account | OCR (future) | P3 |
| **Banking** | Payment reference | OCR (future) | P3 |

**Confidence indicator** must be shown for every extracted field so the reviewer knows which fields were clearly parsed vs guessed.

---

## 4. Review Workflow

### Proposed flow (no existing code for this — new build required)

```
UPLOAD (PDF or image)
    ↓
PARSE (InvoiceOcrService — existing, no changes needed)
    ↓
STORE as OCR Draft (new: supplier_invoice_ocr_drafts table)
    ↓
REVIEW SCREEN (new UI: accountant reviews all fields)
    ├── Correct errors
    ├── Select matched supplier (or create new)
    ├── Mark VAT inclusive / exclusive
    ├── Add/remove/edit line items
    └── Map lines to GL accounts and/or inventory items
    ↓
APPROVE (accountant clicks "Create Invoice")
    ↓
POST to supplier_invoices + supplier_invoice_lines (existing route, unchanged)
    ↓
GL JOURNAL posted (existing behaviour, unchanged)
    ↓
OPTIONAL: inventory stock receipt (new, separate step — see Section 6)
```

### Review screen requirements

1. **Side-by-side layout**: PDF/image preview on one side, editable form on the other
2. **Field-level confidence badges**: Green (high) / Amber (medium) / Red (low / not found)
3. **Supplier matcher**: type-ahead against existing suppliers; option to create new supplier inline
4. **Validation before approve**:
   - VAT cross-check: subtotal + VAT = total (within R0.02)
   - Invoice number duplicate check against existing invoices
   - At least one line item present
   - GL account mapped for each line
5. **Reject/discard**: Close draft without creating anything
6. **Save draft**: Return to review later (draft stays in OCR staging table)

---

## 5. Item Mapping Workflow

### The mapping challenge

OCR extracts line items as raw text: `"CAKE FLOUR 25KG"`, `"CANOLA OIL 5L"`. These must be linked to:
1. A **GL account** (e.g., 5100 - Cost of Sales, 6200 - Bakery Supplies)
2. Optionally, an **inventory item** in `inventory_items` (for stock updates)

The mapping is not automatic. Human judgement is always required.

### Proposed mapping approach

#### Step 1: System suggestions (non-binding)

Use `supplier_item_history` to suggest: "This supplier last delivered 'CAKE FLOUR 25KG' matched to item #47 (FLOUR CAKE 25KG) at R285/bag."

Use description similarity (normalised string matching) against:
- `inventory_items.name`
- `inventory_items.sku`
- `inventory_items.description`

Rank suggestions by similarity score. Show top 3 suggestions per line.

#### Step 2: Human mapping action

For each invoice line, the reviewer selects one of:
- **Map to inventory item** — link to an existing `inventory_items` record
- **GL only** — map to an expense account only (no stock impact)
- **Create new inventory item** — flag for later, set aside for Phase 2
- **Skip** — exclude this line from the invoice (edge case)

#### Step 3: Lock after approval

Once the accountant approves, the mapping is locked and recorded. The `supplier_item_history` table is updated with the latest cost, enabling better future suggestions.

### Fields stored per mapped line

| Field | Source |
|---|---|
| `invoice_line_id` | From supplier_invoice_lines |
| `inventory_item_id` | Human selection |
| `quantity_received` | From invoice line (may differ from PO qty) |
| `unit_cost_ex_vat` | From invoice line (unit_price) |
| `po_line_id` | Optional: linked PO line for variance tracking |
| `mapped_by_user_id` | Who confirmed the mapping |
| `mapping_confidence` | Was it a system suggestion or manual? |

---

## 6. Inventory Impact Design

### Principle: stock only moves after human approval

```
Invoice Approved (GL posted)
    ↓
Reviewer clicks "Process Stock Receipt"  ← human gate
    ↓
System checks: is a PO linked?
    ├── YES: create purchase_receipt linked to PO
    └── NO: create standalone stock receipt (goods received without PO)
    ↓
stock_movements row inserted (type: 'purchase_receipt')
    ↓
inventory_items.quantity_on_hand updated
    ↓
supplier_item_history updated (last cost, last date, lead time)
    ↓
If PO linked: PO status updated (partial_receipt or fully_received)
```

### Stock receipt: with vs without a Purchase Order

| Scenario | Behaviour |
|---|---|
| **With PO** | Link `purchase_receipt` to `po_id`; check qty against ordered qty; flag overage/underage |
| **Without PO** | Standalone `purchase_receipt` with `po_id = NULL`; no variance check possible |
| **Partial delivery** | Receipt records only what was received; PO stays open for balance |
| **Overage** | Flag warning: "Received more than ordered" — accountant must confirm |

### Quantity and unit mismatch handling

This is the most complex edge case. The invoice may say "1 x FLOUR CASE (24 bags)" but the inventory item is tracked in individual bags.

Proposed approach:
- Add a **unit conversion field** to the mapping: `conversion_factor` (e.g., 1 case = 24 bags)
- The reviewer enters this on the review screen
- System multiplies `invoice_quantity × conversion_factor` to get `stock_units_received`
- If no conversion needed: conversion_factor = 1

If this becomes complex, defer unit conversion to Phase 3 and require invoice quantities to match inventory units in Phase 1.

### What triggers stock movement

| Action | Creates stock_movement? |
|---|---|
| OCR draft created | NO |
| Invoice approved (GL posted) | NO — invoice approval ≠ goods received |
| Accountant explicitly triggers "Process Stock Receipt" | YES |
| PO receipt already processed before invoice | No duplicate — system checks existing receipt for PO |

---

## 7. VAT Handling

### Current VAT model (in supplier_invoices)

```
vat_inclusive = false:
  unit_price is ex-VAT
  line_subtotal_ex_vat = qty × unit_price
  vat_amount = line_subtotal_ex_vat × (vat_rate / 100)
  line_total_inc_vat = line_subtotal_ex_vat + vat_amount

vat_inclusive = true:
  unit_price is gross (inc VAT)
  line_total_inc_vat = qty × unit_price
  line_subtotal_ex_vat = line_total_inc_vat / (1 + vat_rate/100)
  vat_amount = line_total_inc_vat - line_subtotal_ex_vat
```

GL posting (already working):
- DR Expense account(s) → `line_subtotal_ex_vat`
- DR VAT Input (1400) → `total vat_amount`
- CR Accounts Payable (2000) → `total_inc_vat`

### OCR VAT extraction challenges

OCR extracts `subtotal_ex_vat`, `vat_amount`, and `total_inc_vat` from the invoice document. However:

1. **VAT rate per line** — OCR does not reliably extract per-line VAT rates. Default assumption: 15% SA standard rate.
2. **Zero-rated or exempt lines** — Some lines may be 0% VAT. If OCR total VAT doesn't match 15% × subtotal, the reviewer must manually assign rates.
3. **VAT inclusive invoices** — SA tax invoices should be exclusive (VAT shown separately), but some suppliers print inclusive. The reviewer must flag this.
4. **VAT cross-validation** — The service already validates: `subtotal + vat ≈ total` (within R0.02). If validation fails, a warning is surfaced to the reviewer.

### Proposed VAT review UI

- Show OCR-extracted totals prominently
- Auto-calculate expected VAT: `subtotal × 0.15`
- Highlight discrepancy if OCR VAT ≠ expected VAT
- Allow per-line VAT rate override (15% / 0% / other)
- Recalculate totals on any line change
- Final totals must balance before "Approve" is enabled

---

## 8. Storage and Security Requirements

### Current storage mechanism

All file uploads use local disk storage via multer. No Supabase Storage is used anywhere in the codebase.

```
Bank attachments: /backend/uploads/accounting/bank_attachments/
Invoice OCR:      In-memory buffer only — file is NOT saved after OCR
```

### What needs to change for the new workflow

The current OCR endpoint discards the file after extraction. For the new review workflow, the **original PDF/image must be retained** so the reviewer can see it alongside the extracted fields.

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **Local disk storage** (consistent with current) | Simple, fast, no external dependency | Files lost on container redeploy; not accessible from other instances |
| **Supabase Storage** (future-proof) | Persistent, URL accessible, access-controlled | Requires new Supabase bucket setup and signed URL logic |

**Recommendation:** For Phase 1, use local disk storage consistent with bank attachments pattern, with a clearly defined upload directory. Plan to migrate to Supabase Storage in Phase 2 when file persistence across deploys becomes a requirement.

**Proposed local path:** `/backend/uploads/accounting/supplier_invoice_drafts/`

**File naming:** `company_{companyId}_draft_{uuid}.{ext}` — prevents path traversal, unique per upload.

### Security requirements

| Requirement | Mechanism |
|---|---|
| Company scoping | All draft records have `company_id`; file path includes `company_{id}` prefix |
| File type validation | Multer fileFilter: PDF, JPG, PNG, WEBP only; reject all others |
| File size limit | 20 MB (matches existing PDF import limit) |
| No direct file URL exposure | Files served via authenticated endpoint only, not static path |
| No raw OCR text in browser storage | Review data lives on server; UI state is in-memory JS only |
| Delete on discard | When reviewer discards a draft, the uploaded file must be deleted from disk |

---

## 9. Audit Trail Requirements

### What must be logged

Using the existing `AuditLogger` (already supports supplier/invoice action types):

| Event | Action Type | Key Fields |
|---|---|---|
| OCR upload received | `SUPPLIER_INVOICE_OCR_UPLOADED` | filename, fileSize, companyId, uploadedBy |
| OCR extraction completed | `SUPPLIER_INVOICE_OCR_EXTRACTED` | confidence, fieldsFound, lineItemCount, warnings |
| Draft saved (reviewer edits) | `SUPPLIER_INVOICE_DRAFT_SAVED` | draftId, changes made |
| Draft discarded | `SUPPLIER_INVOICE_DRAFT_DISCARDED` | draftId, reason |
| Invoice created from draft | `SUPPLIER_INVOICE_CREATED` | draftId, invoiceId, supplierId, total (already logged by existing route) |
| Line mapped to inventory item | `SUPPLIER_INVOICE_LINE_MAPPED` | lineId, inventoryItemId, mappedBy |
| Stock receipt processed | `STOCK_RECEIPT_FROM_INVOICE` | invoiceId, receiptId, itemId, qtyReceived, unitCost |

### Existing audit fields (no changes needed)

The `AuditLogger.logUserAction(req, actionType, entityType, entityId, beforeData, afterData, reason)` interface is already in place and used by the supplier invoice routes. New events simply add new `actionType` constants.

---

## 10. Human Approval Gates

The strict principle: **no OCR result may auto-post to GL or auto-adjust stock without human review.**

```
Gate 1: Upload → Parse
  - System: extract fields, score confidence
  - Human: nothing yet (automatic)

Gate 2: Review → Approve
  ✋ HUMAN REQUIRED
  - Reviewer inspects all extracted fields
  - Corrects errors
  - Selects/confirms supplier
  - Maps line items to GL accounts
  - Optionally maps lines to inventory items
  - Confirms VAT treatment
  - Clicks "Create Invoice" (explicit confirmation)
  → ONLY AFTER THIS: GL journal posted

Gate 3: Invoice Approved → Stock Receipt
  ✋ HUMAN REQUIRED (separate action)
  - After invoice is approved, reviewer sees "Process Stock Receipt" button
  - Reviews quantities and item mappings
  - Confirms unit conversions if any
  - Clicks "Confirm Receipt"
  → ONLY AFTER THIS: stock_movements created, on-hand updated

Gate 4: PO Variance (if PO linked)
  ✋ HUMAN REQUIRED if variance exists
  - If received qty ≠ ordered qty: show variance warning
  - Human must explicitly acknowledge overage/underage
  - Cannot confirm receipt until variance is acknowledged
```

### What is explicitly NOT allowed

- Auto-creating supplier invoice from OCR without reviewer opening and confirming
- Auto-matching inventory items without reviewer seeing and confirming the match
- Auto-creating stock movements when an invoice is approved
- Auto-posting GL based on OCR confidence score, regardless of how high it is
- Saving OCR-extracted data to any permanent table before reviewer confirmation

---

## 11. Recommended Phase 1 Build

### Scope: OCR Extract → Forensic Review → Create Invoice Draft

Phase 1 adds the review layer between OCR and invoice creation. It deliberately does **not** include inventory stock receipts (Phase 2).

#### New database table required

```sql
supplier_invoice_ocr_drafts (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL,
  created_by_user_id INTEGER,
  status             VARCHAR(20) DEFAULT 'pending_review'
                     CHECK (status IN ('pending_review','draft_saved','approved','discarded')),

  -- Uploaded file reference
  file_path          TEXT,           -- local disk path
  file_name          TEXT,           -- original filename
  file_size          INTEGER,
  file_mime          VARCHAR(50),    -- application/pdf | image/jpeg | etc.

  -- OCR extraction output (stored as JSONB for flexibility)
  ocr_raw_result     JSONB,          -- full InvoiceOcrService response
  ocr_confidence     NUMERIC(4,3),   -- 0.0–1.0
  ocr_warnings       TEXT[],

  -- Reviewer-confirmed header fields (populated after review)
  supplier_id        INTEGER REFERENCES suppliers(id),
  invoice_number     TEXT,
  invoice_date       DATE,
  due_date           DATE,
  vat_inclusive      BOOLEAN DEFAULT false,
  subtotal_ex_vat    NUMERIC(15,2),
  vat_amount         NUMERIC(15,2),
  total_inc_vat      NUMERIC(15,2),
  notes              TEXT,

  -- Reviewer-confirmed line items (JSONB array)
  confirmed_lines    JSONB,   -- [{description, qty, unit_price, vat_rate, account_id, inventory_item_id}]

  -- Outcome
  approved_invoice_id INTEGER REFERENCES supplier_invoices(id),
  discarded_reason   TEXT,
  discarded_at       TIMESTAMPTZ,

  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
)
```

#### New API endpoints required

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/accounting/suppliers/invoices/ocr-draft` | Upload file, run OCR, create draft record, return draft ID + extraction |
| `GET` | `/api/accounting/suppliers/invoices/ocr-drafts` | List pending OCR drafts for review |
| `GET` | `/api/accounting/suppliers/invoices/ocr-drafts/:id` | Get draft detail + serve file URL |
| `PATCH` | `/api/accounting/suppliers/invoices/ocr-drafts/:id` | Save reviewer edits (status stays pending_review) |
| `POST` | `/api/accounting/suppliers/invoices/ocr-drafts/:id/approve` | Approve → calls existing POST /invoices internally |
| `POST` | `/api/accounting/suppliers/invoices/ocr-drafts/:id/discard` | Discard draft, delete file, audit log |
| `GET` | `/api/accounting/suppliers/invoices/ocr-drafts/:id/file` | Serve the PDF/image (authenticated, company-scoped) |

#### New frontend components required

- **Upload modal**: drag-and-drop or file picker; shows upload progress
- **OCR drafts list**: pending review queue showing supplier name, date, total, confidence, uploaded by, date
- **Review screen**: side-by-side — PDF viewer (left) + editable form (right)
  - Header fields with confidence badges
  - Line items table (editable, add/remove rows)
  - Supplier type-ahead
  - VAT cross-check panel
  - GL account selector per line
  - "Save Draft" + "Approve → Create Invoice" buttons
- **Confirmation dialog**: "Create this supplier invoice? This action posts to the GL." (explicit confirm)

#### What Phase 1 does NOT include

- Inventory item mapping (GL account only in Phase 1)
- Stock receipt creation
- PO linkage during OCR review
- Banking detail extraction
- Bulk import of multiple invoices in one upload

#### Reuse from existing code

- `InvoiceOcrService.parseInvoiceImage()` and `.parseInvoicePdf()` — unchanged
- `POST /api/accounting/suppliers/invoices` — called internally by the approve endpoint
- `AuditLogger` — used throughout
- `hasPermission('ap.invoice.create')` — same permission for OCR draft creation
- Multer configuration pattern — matches bank attachment pattern

---

## 12. Future Phases

### Phase 2: Inventory item mapping + stock receipt

- Add `inventory_item_id` mapping to line items in the review screen
- Add `supplier_item_history` suggestion engine (match by description similarity)
- Add "Process Stock Receipt" button on approved invoices with inventory lines
- Create `purchase_receipts` and `purchase_receipt_lines` from the mapping
- Update `inventory_items.quantity_on_hand` via `stock_movements`
- Handle unit conversion (case-to-units, pallet-to-cases, etc.)
- Handle PO linkage: match invoice to an open PO for variance tracking

### Phase 3: PO matching and three-way matching

- Three-way match: PO → Goods Received → Supplier Invoice
- Variance report: PO price vs invoice price, PO qty vs received qty
- Auto-suggest PO lines when supplier + items match
- Block payment until three-way match is complete (configurable)

### Phase 4: Supabase Storage migration

- Move PDF/image storage from local disk to Supabase Storage bucket
- Signed URLs for file access (time-limited, company-scoped)
- File retention policy (e.g., 7 years for tax compliance)
- Cloud-accessible for multi-instance deployments

### Phase 5: Supplier banking detail extraction

- Extract bank name, account number, branch code from invoice
- Pre-populate supplier banking details on first invoice from that supplier
- Human confirmation before updating supplier record

### Phase 6: AI-enhanced extraction

- Use Claude API to supplement tesseract OCR for complex layouts
- Better per-line VAT rate detection
- Structured table extraction for complex multi-column layouts
- Confidence-weighted averaging of OCR + LLM extraction results

---

## 13. Questions for Ruan Before Implementation

The following decisions require Ruan's input before Phase 1 can be built:

### Q1: File storage location
> Should supplier invoice PDFs/images be stored on local disk (consistent with current bank attachments) or in Supabase Storage?

**Recommendation:** Local disk for Phase 1, Supabase Storage from Phase 2 onward.

---

### Q2: Draft permission model
> Who should be allowed to upload and review invoice OCR drafts?

Options:
- A. Same as `ap.invoice.create` (accountants and above) — most permissive
- B. New permission `ap.invoice.ocr.review` — allows separating upload from final approval
- C. Upload open to `ap.invoice.create`; approval requires `ap.invoice.edit` or higher

**Recommendation:** Option A for Phase 1. Separate upload/approval permissions in Phase 2 if needed.

---

### Q3: What happens when OCR confidence is very low?
> If the OCR extraction scores below 0.4 confidence (e.g., a blurry photo), should the system:

- A. Reject the file with a clear error message
- B. Accept it and mark all fields as "unverified — requires full manual entry"
- C. Offer to export raw text so the user can copy-paste into a manual entry form

**Recommendation:** Option B — accept all uploads, mark low-confidence fields clearly so the reviewer can fix them. Never auto-reject based on confidence alone.

---

### Q4: Inventory item mapping in Phase 1
> Should Phase 1 include inventory item mapping, or should it be GL account only?

**Recommendation:** Phase 1 = GL account only. Inventory mapping adds significant complexity (unit conversion, PO matching, stock movements) and can safely be Phase 2.

---

### Q5: Stock receipt trigger
> When should inventory stock movement occur?

Options:
- A. When invoice is approved (invoice approval = goods received)
- B. When accountant explicitly triggers "Process Stock Receipt" (separate action)
- C. When goods are physically received at warehouse (separate goods received workflow)

**Recommendation:** Option B — invoice approval and stock receipt are separate, explicit actions. Many invoices arrive before or after goods — they should not be conflated.

---

### Q6: Unmatched items — create or queue?
> If an invoice line item cannot be matched to any existing inventory item, should the system:

- A. Force GL-only for that line (no inventory impact)
- B. Queue a "new inventory item" request for the warehouse team to review
- C. Allow the reviewer to create a new inventory item inline on the review screen

**Recommendation:** Option A for Phase 1. Option C is a Phase 2 feature. Avoid creating inventory items from invoice reviews without warehouse team input.

---

### Q7: Quantity / unit mismatch — block or warn?
> If an invoice quantity unit doesn't match the inventory item's unit of measure:

- A. Block stock receipt and require manual correction
- B. Warn but allow the reviewer to enter a conversion factor and proceed
- C. Ignore and record as-is (let the reviewer reconcile manually)

**Recommendation:** Option B in Phase 2 when this feature is built. Phase 1 (GL-only) is not affected.

---

### Q8: VAT inclusive invoices
> How common are VAT-inclusive supplier invoices in this business?

This determines how much attention to give to the VAT inclusive/exclusive toggle in the review UI. If always exclusive (standard SA tax invoices), the toggle is a safety net. If inclusive is common (e.g., retail suppliers), it needs prominent placement.

**Answer needed from Ruan.**

---

### Q9: How should existing POs surface in the review screen?
> When reviewing an OCR draft, should the system:

- A. Not show POs at all in Phase 1 (deferred to Phase 2)
- B. Show a type-ahead to optionally link to an open PO (informational only, no automatic matching)
- C. Auto-detect PO based on supplier + invoice number or reference

**Recommendation:** Option A for Phase 1. Option B in Phase 2.

---

### Q10: Duplicate invoice detection
> The existing invoice creation route already rejects duplicates (same supplier + same invoice number). Should the OCR draft system surface this warning:

- A. Only at the point of final approval (current behaviour)
- B. At the OCR review stage (before the reviewer does any work)
- C. Both — soft warning at review stage, hard block at approval

**Recommendation:** Option C — surface the duplicate warning early in the review screen, but only hard-block at approval.

---

## Summary

| Area | Status | Gap |
|---|---|---|
| OCR engine (tesseract) | ✅ Built | None |
| Invoice field extraction | ✅ Built | Banking details not extracted |
| Line item extraction | ✅ Built | Per-line VAT rate unreliable |
| Supplier invoice table | ✅ Built | No draft stage |
| Supplier invoice lines table | ✅ Built | No inventory_item_id link |
| GL posting | ✅ Built | Posts immediately — no review gate |
| Purchase orders | ✅ Built | Not linked to invoice review yet |
| Stock receipt flow | ✅ Built | Not triggered from invoices |
| File storage | ✅ Built (disk) | No persistent draft storage |
| Audit logging | ✅ Built | New OCR event types needed |
| OCR draft table | ❌ Missing | **Phase 1 new build** |
| OCR draft review UI | ❌ Missing | **Phase 1 new build** |
| Draft-to-invoice approve flow | ❌ Missing | **Phase 1 new build** |
| Inventory item mapping | ❌ Missing | Phase 2 |
| Stock receipt from invoice | ❌ Missing | Phase 2 |
| Supabase Storage | ❌ Not used | Phase 4 |
