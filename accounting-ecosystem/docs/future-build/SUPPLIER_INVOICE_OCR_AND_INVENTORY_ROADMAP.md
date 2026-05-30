# Supplier Invoice OCR + Inventory Integration Roadmap

**Date:** 2026-05-30
**Phase 1 status:** Complete (see SUPPLIER_INVOICE_OCR_DRAFT_LAYER_PHASE_1_REPORT.md)
**Governs:** Future phases of the forensic invoice extraction → inventory update pipeline

---

## Phase 1 — Complete ✅

**OCR Extract → Review → Approve → GL Post**

- `supplier_invoice_ocr_drafts` table + lifecycle API
- Side-by-side review UI with confidence badges
- GL-account-only line mapping
- Approval creates supplier invoice via safe transactional path
- 26 tests, full audit trail

---

## Phase 2 — Inventory Item Mapping + Stock Receipt

**Trigger:** When supplier invoices are commonly used to update stock levels.

### What to build

**Inventory item matching on review screen:**
- Add an "Inventory Item" column to the review line table (alongside GL account)
- System suggests matches from `inventory_items` based on description similarity + `supplier_item_history`
- Top 3 suggestions shown per line; reviewer selects or skips
- Mapping is optional — GL account remains required, inventory item is optional

**"Process Stock Receipt" on approved invoices:**
- After an invoice is approved, a new button appears: "Process Stock Receipt"
- This is a SEPARATE, EXPLICIT human action — invoice approval ≠ goods received
- Reviewer sees quantity and item confirmation before proceeding

**New backend:**
- `POST /api/accounting/suppliers/invoices/:id/stock-receipt` — creates `purchase_receipts` + `purchase_receipt_lines` + `stock_movements`
- Validates inventory item IDs, quantities, and warehouse selection
- Updates `supplier_item_history` (last cost, lead time)

**Schema additions:**
- `supplier_invoice_lines.inventory_item_id` — FK to `inventory_items` (nullable)
- No new tables needed — uses existing `purchase_receipts`, `purchase_receipt_lines`, `stock_movements`

**Unit conversion:**
- Add `unit_conversion_factor` field to line review: how many stock units per invoice quantity
- Example: 1 case (invoice) = 24 bags (stock unit)
- If no conversion: factor = 1

**Decisions needed from Ruan:**
- Should stock movement happen at invoice approval or stock receipt confirmation?
- What happens when received qty > ordered qty (if PO linked)?
- Should unit conversion be mandatory or optional?

---

## Phase 3 — PO Matching (Three-Way Match)

**Trigger:** When formal purchase orders are in use and three-way matching is required for payment approval.

### What to build

**PO linkage on review screen:**
- Type-ahead to link invoice draft to an open PO (by supplier + approximate date/amount)
- Shows PO lines alongside invoice lines for comparison

**Three-way match engine:**
- PO → Goods Received → Supplier Invoice
- Variance report: PO price vs invoice price, PO qty vs received qty
- Match status: full match / price variance / qty variance / quantity shortfall

**Payment gate:**
- Optionally block payment until three-way match is confirmed (configurable per company)

**Schema additions:**
- `supplier_invoice_ocr_drafts.po_id` — optional link to `purchase_orders`
- `supplier_invoice_lines.po_line_id` — optional link to `purchase_order_lines`

---

## Phase 4 — Supabase Storage File Retention

**Trigger:** When multi-instance deployment or 7-year tax compliance retention is required.

### What to build

**Supabase Storage bucket:** `supplier-invoice-documents`

**Migration:**
- New column: `supplier_invoice_ocr_drafts.storage_object_path` (Supabase Storage key)
- Upload to Supabase Storage instead of local disk
- Serve via signed URL (time-limited, company-scoped, authenticated)

**File lifecycle:**
- Retention: 7 years minimum (SARS requirement for tax records)
- Deletion policy: only after retention period expires; rejected drafts kept for 1 year

**Fallback:**
- Existing drafts with `file_path` (local disk) continue to work until migrated

---

## Phase 5 — Supplier Banking Detail Extraction

**Trigger:** When suppliers frequently change banking details and manual capture is error-prone.

### What to build

**OCR extraction additions:**
- Extend `InvoiceOcrService` to extract: bank name, account number, branch code from invoice footer
- Confidence scored separately from invoice header fields

**Review UI additions:**
- New "Banking Details" section on review screen (shown when extracted)
- Pre-populate supplier banking fields with extracted values
- Human confirmation required before updating supplier record

**Governance:**
- Cannot auto-update supplier banking — requires explicit reviewer confirmation
- Banking updates are audit logged with before/after values
- Only updates `suppliers.bank_name`, `bank_account_number`, `bank_branch_code`

---

## Phase 6 — Sean OCR Confidence Assistant + Recurring Supplier Recognition

**Trigger:** When OCR failure rates are tracked and Sean can improve extraction accuracy over time.

### What to build

**Sean learning from OCR drafts:**
- Record: supplier name → VAT number → common GL accounts (per company)
- Learn: invoice number format patterns per supplier
- Learn: which OCR fields are reliably extracted vs frequently corrected

**Recurring supplier recognition:**
- When a draft's extracted supplier name matches an existing `suppliers` record, auto-select it
- Show confidence: "98% match: ABC Suppliers (SUP001)"
- Reviewer can override

**Price variance detection:**
- Compare invoice line unit prices against `supplier_item_history.last_purchase_cost`
- Flag if price increased > 10% since last purchase
- Show: "⚠️ Flour 25kg: R310/bag — last purchased at R285 (+8.8%)"

**Sean Paytime/Accounting knowledge link:**
- Sean can answer: "What GL account does flour go to for this company?"
- Answer based on: past invoice line mappings, COA description matching

---

## Key Design Principles (all phases)

These principles apply to every future phase:

1. **No auto-post.** Every GL posting requires human approval — no matter how high the OCR confidence.
2. **No auto-stock-update.** Stock movements require a separate explicit "Process Stock Receipt" action.
3. **No cross-company data.** All queries scoped to `company_id`.
4. **Immutable OCR output.** The original extracted fields are never overwritten — only `reviewer_*` fields change.
5. **Audit everything.** Every lifecycle action is captured in `accounting_audit_log`.
6. **No localStorage for business data.** All persistent data is backend/database-driven.
7. **Graceful failure.** If GL posting fails, the journal is reversed and the draft remains unconverted.
