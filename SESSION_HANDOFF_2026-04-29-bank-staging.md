# SESSION HANDOFF — 2026-04-29: Bank + Document Processing System

**Session type:** Implementation  
**Status:** COMPLETE — all planned files created and validated

---

## WHAT WAS BUILT THIS SESSION

### Full bank + document processing pipeline implemented across 6 files:

---

### 1. `database/migrations/020_bank_staging.sql` — NEW
**Purpose:** Pre-confirmation staging tables for bank imports.

Tables created:
- `bank_transaction_staging` — holds imported transactions before user confirms them into `bank_transactions`. Fields: `id`, `company_id`, `bank_account_id` (nullable — allows import before account is known), `date`, `description`, `amount`, `reference`, `external_id`, `balance`, `detected_type` (TRANSFER/PAYMENT/RECEIPT/PETTY_CASH), `match_status` (UNMATCHED/TRANSFER_DETECTED/REVIEW_REQUIRED/CONFIRMED/REJECTED), `confidence_score`, `transfer_pair_staging_id` (self-ref), `import_batch_id`, `import_source`, `confirmed_txn_id` (no FK — references `bank_transactions`), timestamps.
- `bank_transfer_links` — pairing table for detected interbank transfers. Fields: `id`, `company_id`, `staging_id_from/to` (FKs into staging), `confidence`, `detection_layer` (1/2/3), `confirmed`, `confirmed_by`, `confirmed_at`, `journal_id` (no FK).
- Indexes on company_id, batch, bank_account, match_status, date, external_id.
- `update_updated_at_column()` trigger on staging table.

**IMPORTANT:** No FK constraints to `bank_transactions` or `journals` — deliberate to avoid cross-migration coupling.

**ACTION REQUIRED:** Run this SQL in the Supabase SQL Editor before testing.

---

### 2. `backend/modules/accounting/services/bankStagingService.js` — NEW
**Purpose:** Service layer for the full staging pipeline.

Key methods:
| Method | Purpose |
|---|---|
| `stageTransactions(companyId, bankAccountId, transactions, batchId, source)` | Insert rows into staging, skip already-staged by external_id |
| `detectTransfers(companyId, batchId)` | 3-layer transfer detection: keywords / exact opposite amount ±2 days / fuzzy ±$0.01 ±5 days |
| `confirmStaged(companyId, stagingIds, userId)` | Move CONFIRMED rows into `bank_transactions` (status='unmatched') — NO GL impact |
| `rejectStaged(companyId, stagingId)` | Set match_status='REJECTED' |
| `confirmTransfer(companyId, transferLinkId, user)` | Create transfer journal, insert both sides to bank_transactions (status='matched') |
| `getBatch(companyId, batchId)` | Fetch all staging rows + transfer links for a batch |
| `listBatches(companyId)` | Summary stats per batch |
| `listStaged(companyId, filters)` | Paginated listing with filters |

**Critical design rules:**
- Staging rows NEVER affect GL.
- Only `confirmTransfer()` creates a journal (after explicit user confirmation).
- Regular `confirmStaged()` creates `bank_transactions` with `status='unmatched'` — identical to current CSV import behaviour.

---

### 3. `backend/modules/accounting/routes/bankStaging.js` — NEW
**Purpose:** Express route handlers for the staging pipeline.  
**Mounted at:** `/api/accounting/bank/staging`

Routes:
| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/import` | bank.import | Stage a batch of transactions, optionally run detection |
| GET | `/` | bank.view | List staged rows (paginated, filterable) |
| GET | `/batches` | bank.view | List batch summaries |
| GET | `/batch/:batchId` | bank.view | Full batch details + links |
| POST | `/detect-transfers` | bank.import | Re-run detection on a batch |
| POST | `/confirm` | bank.import | Confirm staged rows → bank_transactions |
| PATCH | `/:id/reject` | bank.import | Reject a staging row |
| POST | `/transfers/:linkId/confirm` | bank.allocate | Confirm transfer pair, create journal |

---

### 4. `backend/sean/invoice-ocr-service.js` — NEW
**Purpose:** Extract structured invoice data from supplier invoice images and PDFs.

Key methods:
- `parseInvoiceImage(buffer, filename, options)` — uses OcrService (tesseract) for images (JPG/PNG/WEBP)
- `parseInvoicePdf(buffer, filename)` — uses pdf-parse for text PDFs, falls back to OcrService.extractTextFromScannedPdf() for scanned PDFs
- `isAllowedFile(mimetype, filename)` — validates file type for upload middleware

Return shape (all fields tagged `status: 'UNVERIFIED'`):
```javascript
{
  status: 'UNVERIFIED',
  extraction_confidence: 0–1,
  supplier_name, vat_number, invoice_number, invoice_date,
  due_date, subtotal_ex_vat, vat_amount, total_inc_vat,
  line_items: [{ description, quantity, unit_price, line_total }],
  raw_text_sample, warnings
}
```

**South African patterns implemented:** VAT number (10-digit SARS), invoice number, SA date formats (DD/MM/YYYY, DD Month YYYY, YYYY-MM-DD), R-prefixed amounts, total/subtotal/VAT amount labels.

**IMPORTANT:** This service NEVER writes to the database. It is a pure extraction service.

---

### 5. `backend/modules/accounting/routes/bank.js` — MODIFIED
**What changed:** Enhanced `POST /import/pdf` to return bank account matching in the response.

After `PdfStatementImportService.parsePdf()` returns, the endpoint now:
1. Extracts the last 4 digits from `result.accountNumber`
2. Queries `bank_accounts` table for this company where `account_number_masked ILIKE %{last4}`
3. Returns `accountMatch` in the JSON response:
   - `{ found: true, bankAccountId, bankAccountName, bankName, accountNumberMasked, extracted }` — if 1 match
   - `{ found: false, multipleMatches: true, candidates: [...], extracted }` — if multiple matches
   - `{ found: false, extracted: { accountNumber, bank } }` — if no match (frontend should offer account creation)

No other routes changed. reports.js and GL logic untouched.

---

### 6. `backend/modules/accounting/routes/suppliers.js` — MODIFIED
**What changed:**
1. Added `multer`, `path`, and `InvoiceOcrService` imports at top of file.
2. Added `invoiceUpload` multer config (15MB, memory storage, JPG/PNG/WEBP/PDF only).
3. Added `POST /invoices/ocr` route — upload invoice file, extract via OCR, return UNVERIFIED data. No DB writes.

---

### 7. `backend/modules/accounting/index.js` — MODIFIED
**What changed:** Added route mount:
```javascript
router.use('/bank/staging', require('./routes/bankStaging'));
```
Placed immediately after the existing `/bank` mount.

---

## CONFIRMED WORKING (Syntax Validated)

All 6 files passed `node --check` with zero errors:
- `backend/modules/accounting/services/bankStagingService.js`
- `backend/modules/accounting/routes/bankStaging.js`
- `backend/sean/invoice-ocr-service.js`
- `backend/modules/accounting/routes/bank.js`
- `backend/modules/accounting/routes/suppliers.js`
- `backend/modules/accounting/index.js`

Runtime dependency check passed: `multer`, `uuid`, `pdf-parse` all present in backend node_modules.

---

## WHAT WAS NOT CHANGED (Confirmed Preserved)

- `reports.js` — NOT touched
- `fetchAccountBalances()` — NOT touched
- Trial balance, GL, P&L, balance sheet queries — NOT touched
- `.in('journal_id', ...)` reporting logic — NOT touched
- `journalService.js` — NOT modified
- `auditLogger.js` — NOT modified
- All existing `bank_transactions` insert/update paths — NOT changed
- Priority 10 idempotency guards (journals.js, suppliers.js existing routes, customer-invoices.js) — NOT removed

---

## REQUIRED TESTING

### Test 1: Import wrong bank PDF → account not found
1. Upload a bank statement PDF for an account NOT yet in `bank_accounts`
2. Expected: `accountMatch: { found: false, extracted: { accountNumber: '...', bank: '...' } }`
3. Frontend should offer: "Create a new bank account for this statement"

### Test 2: Import bank PDF → account found
1. Upload PDF where extracted last-4 matches one `bank_accounts.account_number_masked`
2. Expected: `accountMatch: { found: true, bankAccountId: '...', bankAccountName: '...' }`

### Test 3: Stage transactions + interbank transfer detection
1. `POST /api/accounting/bank/staging/import` with two transactions:
   - Account A: description "Transfer to FNB", amount -10000, date 2024-01-15
   - Account B: description "Transfer from Nedbank", amount +10000, date 2024-01-15
2. Run `POST /detect-transfers` on the batch
3. Expected: Layer 2 or Layer 3 detection fires, both rows → `TRANSFER_DETECTED`, confidence ≥ 0.90, a `bank_transfer_links` record created

### Test 4: Confirm transfer → creates journal
1. `POST /api/accounting/bank/staging/transfers/:linkId/confirm`
2. Expected: journal created in `journals` table (Dr receiving account, Cr sending account), both staging rows `CONFIRMED`, both `bank_transactions` created with `status='matched'`
3. Verify GL reports still work after this

### Test 5: Same amount, unrelated transactions → REVIEW_REQUIRED
1. Stage two transactions at different companies or >5 days apart
2. Expected: Layer 2/3 detection does NOT fire, `match_status` remains `UNMATCHED`

### Test 6: Invoice OCR — image upload
1. `POST /api/accounting/suppliers/invoices/ocr` with a clear JPG of a tax invoice
2. Expected: `supplier_name`, `invoice_number`, `total_inc_vat`, `vat_number` extracted with `status: 'UNVERIFIED'`

### Test 7: Invoice OCR — text PDF upload
1. Same as Test 6 but with a PDF invoice
2. Expected: Higher extraction_confidence than image scan; all key fields populated

### Test 8: Anti-duplication (bank + invoice)
1. Stage a bank transaction via the staging pipeline (not yet confirmed)
2. Create a supplier invoice via `POST /api/accounting/suppliers/invoices`
3. Confirm the bank transaction via `POST /staging/confirm`
4. Expected: bank_transaction created with `status='unmatched'`, invoice exists as separate draft — NO automatic linking, NO automatic duplicate
5. Reconciliation is a manual step — by design

### Test 9: Petty cash staging
1. Stage a transaction with `detected_type: 'PETTY_CASH'` override (via bankAccountId pointing to petty cash account)
2. Expected: row appears in staging with `detected_type='PETTY_CASH'`, `match_status='UNMATCHED'`
3. Confirm it → creates `bank_transactions` entry, requires manual GL allocation

---

## FOLLOW-UP NOTES

### F1 — Petty cash dedicated flow
- Area: Petty cash invoice payment flow
- Not yet built: A `POST /bank/staging/petty-cash` route that accepts an invoice reference + amount and auto-stages a cash payment entry against the petty cash bank account
- Risk: Accountants may not know to manually stage cash entries
- Recommended next: Add a petty cash staging convenience route

### F2 — Invoice OCR → invoice creation link
- Area: suppliers.js `POST /invoices/ocr`
- The OCR endpoint returns UNVERIFIED data. Frontend must then call `POST /invoices` to create the invoice.
- Not yet built: A combined `POST /invoices/ocr/confirm` that accepts the UNVERIFIED result + user overrides and creates the invoice in one call
- Risk: Low — current two-step flow is safe and explicit

### F3 — Bank account detection edge cases
- Area: bank.js `POST /import/pdf` account matching
- Currently matches on last-4 digits of masked account number
- Edge case: two accounts at same bank with same last 4 digits → `multipleMatches: true`
- Frontend must handle this case with a bank selector modal

### F4 — Transfer detection Layer 1 keyword list
- Area: `bankStagingService.js` `TRANSFER_KEYWORDS` array
- Currently has a reasonable list of SA bank transfer keywords
- May need to expand once real bank imports are tested (PayShap, etc.)
- Low risk — Layer 2/3 (amount + date matching) is the primary detection mechanism

### F5 — Migration 020 must be run in Supabase
- The migration file `database/migrations/020_bank_staging.sql` has been created
- IT HAS NOT BEEN APPLIED to the database yet
- ACTION: Copy and run in Supabase SQL Editor before testing any staging features

---

## ZEABUR DEPLOYMENT CHECKLIST
- [ ] `accounting-ecosystem/zbpack.json` does NOT exist  
- [ ] `accounting-ecosystem/Dockerfile` exists  
- [ ] `accounting-ecosystem/.dockerignore` exists  
- [ ] `WORKDIR /app` in Dockerfile  
- [ ] `CMD ["node", "backend/server.js"]` in Dockerfile  

---

*Session completed: 2026-04-29*  
*No GL, reports, or trial balance logic was modified.*
