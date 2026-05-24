# CUSTOMERS / SUPPLIERS FORENSIC AUDIT
### Lorenco Ecosystem — Accounts Receivable + Accounts Payable Integrity Review
**Date:** 2026-05-29  
**Audit scope:** Customer AR flow, Supplier AP flow, GL posting, payment allocation, VAT, control account reconciliation, ageing, multi-tenancy, browser storage.  
**Constraint (strictly observed):** No code was changed. No migrations were run. No files were edited. Audit only.  
**Out of scope (per user instruction):** `bank_recon_sessions`, `bank_recon_sessions` table, `POST /api/bank/reconcile`, unallocated bank report.

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [Customer Master Data Flow](#2-customer-master-data-flow)
3. [Supplier Master Data Flow](#3-supplier-master-data-flow)
4. [Customer Invoice Posting Flow](#4-customer-invoice-posting-flow)
5. [Supplier Bill Posting Flow](#5-supplier-bill-posting-flow)
6. [Customer Payment Allocation Flow](#6-customer-payment-allocation-flow)
7. [Supplier Payment Allocation Flow](#7-supplier-payment-allocation-flow)
8. [VAT Impact](#8-vat-impact)
9. [Control Account Reconciliation](#9-control-account-reconciliation)
10. [Ageing Reports](#10-ageing-reports)
11. [Statements](#11-statements)
12. [Multi-Tenant Safety](#12-multi-tenant-safety)
13. [Parent / Non-Postable Account Protection](#13-parent--non-postable-account-protection)
14. [Audit Trail and Reversal Behaviour](#14-audit-trail-and-reversal-behaviour)
15. [What Is Working and Must Be Protected](#15-what-is-working-and-must-be-protected)
16. [Confirmed Risks](#16-confirmed-risks)
17. [Recommended Workstreams](#17-recommended-workstreams)
18. [Questions For Ruan Before Code Changes](#18-questions-for-ruan-before-code-changes)

---

## 1. EXECUTIVE SUMMARY

The Accounts Receivable (AR) and Accounts Payable (AP) subsystems are **architecturally sound** and **substantially correct**. The double-entry bookkeeping is correct at every posting point. Multi-tenancy is enforced consistently. The VAT period locking guard is applied to invoice void and invoice edit. The `JournalService` postability guard blocks parent/header accounts from receiving direct postings.

However, **six material risks** were identified that require workstreams before the modules can be considered production-grade for an accounting firm context:

1. **AR has no aged debtors API.** The `aged-debtors.html` page is a static stub with no live data. There is no backend endpoint for customer ageing — a critical omission for a practice management tool.
2. **Dual customer model is undocumented and confusing.** The `customers` table (POS) and the accounting AR customer model (free-text `customer_name` on `customer_invoices`) are different systems. No linkage is enforced.
3. **Customer payment GL failure is silent.** If the AR account (1100) is absent, the customer payment is inserted into `customer_payments` but **no GL journal is created**. The payment record exists but the ledger shows no clearing entry. No error is returned to the user.
4. **Supplier invoice is posted to GL immediately on creation.** Unlike customer invoices (which are created as DRAFT and explicitly posted), supplier invoices post to GL atomically during `POST /invoices`. There is no draft/review stage for AP.
5. **Control account balances are not cross-verified.** There is no backend function that compares the GL balance of account 1100 (AR control) against the sum of `(total_inc_vat - amount_paid)` on posted customer invoices, or the GL balance of account 2000 (AP control) against the sum of outstanding supplier invoices. If a journal is created outside the AR/AP module, the control account can diverge without detection.
6. **`database/schema.sql` contains legacy / drift definitions** for all four core tables (`customer_invoices`, `customer_invoice_lines`, `supplier_invoices`, `supplier_invoice_lines`). The schema file is misleading to developers and to any tooling that reads it.

---

## 2. CUSTOMER MASTER DATA FLOW

### 2.1 The Two Customer Systems

There are **two distinct customer concepts** in this ecosystem. This is the most important architectural fact to understand about the AR module.

#### System A — POS Customer (`pos_customers` table)
- Used by the retail/POS module.
- Contains `pos_customers` with retail-style fields (loyalty points, customer group, POS customer ID).
- The `customers` table (separate) is POS-style: has `current_balance DECIMAL(10,2) DEFAULT 0` as a denormalised field. Based on `database/schema.sql` line 194, this table has `current_balance`, `credit_limit`, `customer_type`, `eco_client_id`.
- The `current_balance` column on `customers` is a **denormalised, live-balance field**. This type of field is a known data integrity risk — it must be updated atomically with every transaction, otherwise the displayed balance diverges from reality.

#### System B — Accounting AR Customer (`customer_invoices.customer_name`)
- The accounting AR module does **not** use a formal customer master table.
- Customers are stored as free text in `customer_invoices.customer_name` (TEXT NOT NULL).
- An optional `customer_id` INTEGER column exists but it is not FK-constrained to any customers table in `accounting-schema.js`. It appears to be an informal link to `pos_customers`.
- The customer dropdown at `GET /api/accounting/customer-invoices/customers` queries `pos_customers` (not `customers`) and combines with distinct customer names already on existing invoices.

#### 2.2 Customer Dropdown Endpoint

**Route:** `GET /api/accounting/customer-invoices/customers`

**What it does:**
1. Queries `pos_customers` table filtered by `company_id` for `{id, customer_name}`.
2. Queries `customer_invoices` table for distinct `customer_name` values.
3. Merges both lists, deduplicating by lowercased name.
4. Returns a unified list with `{id, name, source: 'pos'|'invoice'}`.

**Risk:** POS customers and accounting AR customers are merged into a single dropdown with no formal FK relationship enforcing the link. A user can type a customer name that does not match any `pos_customers` row — the invoice will create successfully and the `customer_id` will be null.

#### 2.3 `customers.current_balance` — Denormalised Field Status

**Current state:** The `customers` table has `current_balance` but the AR module makes no effort to update it. All outstanding balance computation in the AR module is derived live from `customer_invoices.amount_paid` and `customer_invoices.total_inc_vat`. The `customers.current_balance` field appears to be exclusively managed by the POS module (if at all).

**Risk:** If anything reads `customers.current_balance` for an accounting purpose, it will return stale data. This must be verified (see Section 18).

---

## 3. SUPPLIER MASTER DATA FLOW

### 3.1 Supplier Master Table

Suppliers live in the `suppliers` table, which is a **proper accounting supplier master** (not POS-style):
- `company_id INTEGER NOT NULL REFERENCES companies(id)` — multi-tenant.
- `code VARCHAR(50) NOT NULL` — unique per company, auto-generated as `SUP001`, `SUP002`, etc. if not provided.
- `name` — required, trimmed.
- `vat_number`, `registration_number` — stored for compliance.
- `payment_terms INTEGER DEFAULT 30` — used for AP ageing calculations.
- `bank_name`, `bank_account_number`, `bank_branch_code` — EFT payment details.
- `default_account_id INTEGER REFERENCES accounts(id)` — an optional default GL expense account for this supplier.
- `is_active BOOLEAN` — soft delete flag.
- UNIQUE constraint on `(company_id, supplier_code)`.

### 3.2 Supplier Balance Derivation

Supplier balances are **not denormalised**. Every balance computation reads live from `supplier_invoices`:

```
balance_owing = SUM(total_inc_vat - amount_paid)
  WHERE status NOT IN ('paid', 'cancelled', 'draft')
  AND company_id = :companyId
  AND supplier_id = :supplierId
```

This is the correct pattern. No denormalised `current_balance` field exists on `suppliers`.

### 3.3 Supplier Code Auto-Generation

When `code` is not provided, the system generates `SUPNNN` by counting existing suppliers and incrementing. This is a **non-atomic** sequence that can produce duplicate codes under concurrent creation:

```javascript
const { count } = await supabase.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', companyId);
const n = (count || 0) + 1;
supplierCode = `SUP${String(n).padStart(3, '0')}`;
```

There is a UNIQUE constraint on `(company_id, code)` so a duplicate-code insert will fail with a database error — the failure mode is a 500 response, not a silent duplicate. This is an acceptable trade-off for a low-concurrent accounting system, but it is worth noting.

---

## 4. CUSTOMER INVOICE POSTING FLOW

### 4.1 Two-Stage Lifecycle

Customer invoices follow a **two-stage lifecycle**: DRAFT → SENT (posted).

| Stage | Status | GL Impact | DB Table |
|---|---|---|---|
| Create | `draft` | **None** | `customer_invoices`, `customer_invoice_lines` |
| Edit | `draft` only | **None** | `customer_invoices`, `customer_invoice_lines` |
| Post | `sent` | **Yes** | `journals`, `journal_lines` |
| Void | `void` | Reversal if journal exists | `journals` (reversal) |

### 4.2 Invoice Creation (`POST /`)

**File:** `backend/modules/accounting/routes/customer-invoices.js` line 178  
**Route:** `POST /api/accounting/customer-invoices`

- Validates: `invoice_number` must be unique among non-void/non-cancelled invoices for the company.
- Calculates line totals using `calcLineVAT()` (supports ex-VAT and inc-VAT modes — see Section 8).
- Inserts into `customer_invoices` with `status='draft'`, `amount_paid=0`, `journal_id=null`.
- Inserts into `customer_invoice_lines` with `account_id` referencing `accounts(id)`.
- **No GL journal is created at this stage.** The GL is entirely untouched.
- AuditLogger called: `CUSTOMER_INVOICE_CREATED`.

**Required fields on `customer_invoices` at creation:**

| Column | Value |
|---|---|
| `company_id` | from JWT |
| `customer_id` | optional (null if no POS link) |
| `customer_name` | TEXT NOT NULL |
| `invoice_number` | TEXT NOT NULL |
| `invoice_date` | DATE NOT NULL |
| `status` | `'draft'` |
| `subtotal_ex_vat` | computed |
| `vat_amount` | computed |
| `total_inc_vat` | computed |
| `amount_paid` | 0 |
| `journal_id` | NULL |

### 4.3 Invoice Edit (`PUT /:id`)

- Blocked if `status !== 'draft'` — returns 409.
- Deletes all existing lines, re-inserts fresh lines.
- Re-computes totals.
- **No GL impact** (no journal exists yet in draft state).
- AuditLogger called: `CUSTOMER_INVOICE_UPDATED`.

### 4.4 Invoice Posting (`POST /:id/post`)

**File:** `backend/modules/accounting/routes/customer-invoices.js` line 470  

**Pre-condition:** `status === 'draft'`

**GL Journal constructed:**

```
DR  accounts[1100]             = total_inc_vat          (Accounts Receivable)
CR  accounts[line.account_id]  = subtotal_ex_vat per line  (Revenue accounts)
CR  accounts[2300]             = total vat_amount         (VAT Output, only if vat_amount > 0)
```

**Sequence:**
1. Fetch invoice — 404 if not found, 409 if not draft.
2. Fetch invoice lines.
3. `findAccountByCode(companyId, '1100')` → 422 error if AR account absent.
4. Build `glLines[]`.
5. If `vat_amount > 0`: `findAccountByCode(companyId, '2300')` → VAT Output. If 2300 is absent, **VAT line is silently skipped** (no error thrown, no warning surfaced to the user).
6. `JournalService.createDraftJournal(...)` → atomic pg transaction for journal header + lines.
7. `JournalService.postJournal(...)` → resolves VAT period, updates journal to `status='posted'`.
8. Update invoice: `status='sent'`, `journal_id=glJournal.id`.
9. AuditLogger: `CUSTOMER_INVOICE_POSTED`.

**Critical finding — VAT account 2300 absent is silent:**  
If `findAccountByCode(companyId, '2300')` returns null, the VAT credit line is simply not added to `glLines`. The journal is then **unbalanced if the invoice has VAT** — however, because `createDraftJournal` calls `validateBalance()`, an unbalanced journal will **throw an error** and the entire post operation will fail with a 500. This is effectively a protection, but the error message will be confusing: it will say "Journal does not balance" rather than "VAT Output account (2300) not found". The user will not know why.

**Risk Assessment: MEDIUM-HIGH.** A company whose chart of accounts is missing account 2300 will be unable to post any VAT-bearing customer invoice. They will see a confusing "Journal does not balance" error.

### 4.5 Invoice Void (`POST /:id/void`)

- Blocked if already `void` (409).
- Blocked if `status === 'paid'` or `amount_paid > 0` (409) — message: "Cannot void an invoice that has payments applied. Reverse the payments first."
- Blocked if journal is in a locked VAT period — `JournalService.isVatPeriodLocked(invoice.journal_id)` returns 403.
- If `journal_id` is set: calls `JournalService.reverseJournal(journal_id, companyId, userId)`.
- Updates `status='void'`.
- AuditLogger: `CUSTOMER_INVOICE_VOIDED`.

**The reversal flow in JournalService is correct and atomic.** See Section 14.

---

## 5. SUPPLIER BILL POSTING FLOW

### 5.1 Single-Stage Creation with Immediate GL Post

Unlike customer invoices, supplier bills are **created and posted in a single operation**.

**Route:** `POST /api/accounting/suppliers/invoices`  
**Permission guard:** `hasPermission('ap.manage')` — only users with AP management permission can create supplier invoices.  
**File:** `backend/modules/accounting/routes/suppliers.js` line 324

**Initial `status` on creation:** `'unpaid'` (not `'draft'`).

**GL Journal constructed immediately on creation:**

```
DR  accounts[line.account_id]  = subtotal_ex_vat per line  (Expense accounts)
DR  accounts[1400]             = total vat_amount           (VAT Input, if VAT > 0 and 1400 exists)
CR  accounts[2000]             = total_inc_vat              (Accounts Payable)
```

**Sequence:**
1. Validate: supplier belongs to company, invoice_number duplicate check (same supplier, same company, non-cancelled status).
2. Calculate line totals with `calcLineVAT()`.
3. Insert `supplier_invoices` header with `status='unpaid'`, `amount_paid=0`, `journal_id=null`.
4. Insert `supplier_invoice_lines`.
5. `findAccountByCode(companyId, '2000')` — if AP account absent, GL posting is **silently skipped** with a `console.warn`. Invoice is still created. `journal_id` remains null.
6. If AP account found: build `glLines[]`. If VAT > 0, look for account 1400. If 1400 absent, VAT DR line is silently skipped. If no debit lines result, GL posting is also skipped.
7. `JournalService.createDraftJournal(...)` + `JournalService.postJournal(...)`.
8. Update `supplier_invoices.journal_id`.
9. AuditLogger: `SUPPLIER_INVOICE_CREATED`.

**Critical difference from AR:** On the AP side, the invoice is immediately "live" (status = `'unpaid'`) even if GL posting was skipped due to missing accounts. There is no DRAFT stage.

**Risk: HIGH.** If the AP account (2000) or VAT Input account (1400) is missing, a supplier invoice can be created with `journal_id=null`. The AP ageing report will show the invoice as outstanding, but the GL will show nothing. The TB and balance sheet will not reflect the liability. The mismatch is silent.

### 5.2 Supplier Invoice Edit (`PUT /invoices/:id`)

This is the **most sophisticated edit flow in the entire codebase**. It includes automatic GL correction.

**Edit is blocked if:**
- `status === 'paid'` (400).
- `invoice.journal_id` is in a locked VAT period (403).

**GL correction logic:**
The edit endpoint detects whether any accounting-impacting change occurred:
- `amountsChanged` — any of `subtotal_ex_vat`, `vat_amount`, `total_inc_vat` differs by > 0.005.
- `dateChanged` — `invoice_date` changed.
- `accountsChanged` — expense account IDs on lines changed.

If `needsGlCorrection = true` (journal exists AND accounting change detected):
1. Build new GL lines from edited data.
2. `createDraftJournal(...)` + `postJournal(...)` — replacement journal. If this fails, abort cleanly — invoice unchanged.
3. `reverseJournal(original_journal_id, ...)` — reverse original. If this fails, attempt cleanup reversal of the replacement. If cleanup also fails, returns an explicit "CRITICAL: inconsistent state" error with journal IDs for manual correction.
4. Update invoice row with new `journal_id`.
5. Replace invoice lines.
6. AuditLogger: `SUPPLIER_INVOICE_GL_CORRECTED` or `SUPPLIER_INVOICE_UPDATED`.

**Assessment:** This is a well-engineered, safe GL correction flow. It is more sophisticated than the customer invoice equivalent (which has no edit-after-post path).

---

## 6. CUSTOMER PAYMENT ALLOCATION FLOW

**Route:** `POST /api/accounting/customer-invoices/payments`  
**File:** `backend/modules/accounting/routes/customer-invoices.js` line 701

### 6.1 Payment Record Insert

```javascript
supabase.from('customer_payments').insert({
  company_id, customer_id, customer_name, payment_date,
  payment_method, reference, amount, bank_ledger_account_id,
  notes, created_by_user_id,
})
```

The `journal_id` column is **not set at insert time** — it is updated later after GL posting.

### 6.2 Allocation to Invoices

For each `alloc` in `allocations[]`:
1. Upserts into `customer_payment_allocations` (unique on `payment_id, invoice_id`).
2. Fetches current `amount_paid` and `total_inc_vat` from the invoice.
3. Computes `newAmountPaid = existing.amount_paid + alloc.amount`.
4. Updates invoice `amount_paid` and `status`:
   - `>= total_inc_vat` → `'paid'`
   - `> 0` → `'part_paid'`
   - else → unchanged

**Risk: NO VALIDATION that `alloc.amount` does not over-allocate.** If a user allocates more than the remaining balance of an invoice, `amount_paid` will exceed `total_inc_vat`. The status will be set to `'paid'` but the overpayment is not flagged. No error is returned.

### 6.3 GL Posting for Customer Payment

```
DR  accounts[bankLedgerAccountId]  = amount  (Bank receipt)
CR  accounts[1100]                 = amount  (AR cleared)
```

**Critical finding — silent GL failure:**
```javascript
const arAccountId = await findAccountByCode(companyId, '1100');
if (arAccountId) {
  try {
    // ... create and post journal ...
  } catch (glErr) {
    console.warn(`[CustomerAR] GL posting failed for payment ${payment.id} — payment still recorded:`, glErr.message);
  }
} else {
  console.warn(`[CustomerAR] AR account (1100) not found for company ${companyId} — GL posting skipped for payment ${payment.id}`);
}
```

If **either** the AR account (1100) is absent **or** `JournalService` throws, the payment is inserted into `customer_payments`, the invoice `amount_paid` is updated, but **no GL journal is created**. The system continues and returns 201 success to the caller.

The user sees a successful payment recording. The ledger sees nothing. Account 1100 is not credited. The bank account is not debited. The `customer_payments.journal_id` remains null.

**Risk Assessment: HIGH.** This is a silent data integrity failure. The payment record says one thing; the GL says another. Reports drawing from GL will not match reports drawing from `customer_payments`.

**Note:** The `bankLedgerAccountId` is **not validated** to be an actual bank-type account. Any account ID from the chart of accounts can be used. This could result in a non-bank account being debited.

---

## 7. SUPPLIER PAYMENT ALLOCATION FLOW

**Route:** `POST /api/accounting/suppliers/payments`  
**File:** `backend/modules/accounting/routes/suppliers.js` line 1182

### 7.1 Payment Record Insert

```javascript
supabase.from('supplier_payments').insert({
  company_id, supplier_id, payment_date, payment_method,
  reference, amount, notes, bank_ledger_account_id,
  created_by_user_id,
})
```

### 7.2 Allocation to Invoices

For each `alloc` in `allocations[]`:
1. Inserts into `supplier_payment_allocations` (not upsert — throws on duplicate).
2. Fetches invoice `total_inc_vat` and `amount_paid`.
3. Computes new `amount_paid` and `status` using `invoiceStatus()` helper.
4. Updates invoice.

**Difference from AR:** Supplier payment uses `insert` (not `upsert`) on allocations. A second payment allocation to the same invoice will fail with a DB unique constraint error and bubble up as a 500. The AR side used `upsert` which would silently overwrite.

### 7.3 GL Posting for Supplier Payment

```
DR  accounts[2000]                 = amount  (AP cleared)
CR  accounts[bankLedgerAccountId]  = amount  (Bank payment out)
```

**GL is only attempted if `bankLedgerAccountId` is provided.** If not provided, GL is skipped — no warning, no error.

**If AP account (2000) is absent:** `console.warn` and GL is skipped. Payment still recorded. Invoice `amount_paid` still updated. **Same silent failure mode as customer payments.**

**Risk Assessment: HIGH.** Same category as customer payment GL failure — silent mismatch between payment records and GL.

---

## 8. VAT IMPACT

### 8.1 VAT Calculation Helper

Both `customer-invoices.js` and `suppliers.js` implement the same `calcLineVAT(quantity, unitPrice, vatRate, vatInclusive)` function:

| Mode | `vatInclusive` | Calculation |
|---|---|---|
| EX VAT | `false` | `subtotalExVat = qty × price`; `vatAmount = subtotalExVat × rate/100`; `totalIncVat = subtotalExVat + vatAmount` |
| INC VAT | `true` | `totalIncVat = qty × price`; `subtotalExVat = totalIncVat / (1 + rate/100)`; `vatAmount = totalIncVat - subtotalExVat` |

All values are rounded to 2dp. The intermediate calculation uses 4dp to minimise rounding drift on large quantities.

`vatRate = 0` is **valid** and handled correctly (zero-rate supplies). The default is 15 (South African standard VAT rate).

### 8.2 VAT Journal Lines

**AR (Customer Invoice Post):**
- VAT Output → CR account 2300 (`findAccountByCode(companyId, '2300')`).
- If 2300 absent: VAT line not added → journal will be unbalanced → `validateBalance()` will throw → post operation fails with a confusing error.

**AP (Supplier Invoice Create):**
- VAT Input → DR account 1400 (`findAccountByCode(companyId, '1400')`).
- If 1400 absent: VAT line not added. If at least one expense DR line still exists, the journal will be unbalanced → `validateBalance()` throws → invoice creation fails.
- If ALL lines are zero-value (edge case), `hasDebits` check prevents GL posting entirely.

### 8.3 VAT Period Assignment

All AR and AP journals flow through `JournalService.postJournal()` which calls `_resolveVatPeriodForPost()`. This:
- Detects whether the journal contains VAT account lines.
- Looks up the company's VAT period settings.
- Finds or creates the correct `vat_periods` row.
- If the derived period is LOCKED: routes the journal to the current open period as `is_out_of_period=true`.
- Writes `vat_period_id`, `is_out_of_period`, `out_of_period_original_date` in a single atomic UPDATE.

This is correct. AR and AP journals receive VAT period assignment on the same path as bank allocation journals.

### 8.4 VAT Period Lock Guard

- **Customer Invoice Void:** Checks `JournalService.isVatPeriodLocked(invoice.journal_id)` before reversing. Returns 403 if locked.
- **Supplier Invoice Edit:** Checks `JournalService.isVatPeriodLocked(existing.journal_id)` before allowing edit. Returns 403 if locked.
- **Customer Invoice Edit:** No guard needed — edits only work on DRAFT invoices, which have no journal yet.
- **Supplier Invoice Void:** No void endpoint exists on the AP side. Cancellation can be done via status edit (to `'cancelled'`) but there is no explicit void-with-reversal flow for supplier invoices.

**Risk: MEDIUM.** Supplier invoices have no formal void/reversal path. An accountant wanting to void a supplier invoice must edit it to zero, change status to `'cancelled'`, and the GL correction logic will reverse and replace. This is indirect and confusing.

---

## 9. CONTROL ACCOUNT RECONCILIATION

### 9.1 AR Control Account (1100)

The AR control account balance in the GL is maintained by:
- **Debit (increases AR):** `POST /:id/post` — DR 1100 `total_inc_vat`.
- **Credit (decreases AR):** `POST /payments` — CR 1100 `amount`.
- **Reversal (removes AR):** `POST /:id/void` → `JournalService.reverseJournal()` — creates equal-and-opposite journal.

The **invoiced but unpaid balance per the invoice table** is:
```sql
SELECT SUM(total_inc_vat - amount_paid)
FROM customer_invoices
WHERE company_id = :id
AND status NOT IN ('draft', 'void')
```

**No backend function exists** that cross-checks the GL balance of account 1100 against this invoice-derived balance. If a manual journal is posted to account 1100 outside the AR module, or if a payment GL fails silently (see Section 6.3), the two figures will diverge without any detection mechanism.

### 9.2 AP Control Account (2000)

The AP control account balance in the GL is maintained by:
- **Credit (increases AP):** `POST /invoices` — CR 2000 `total_inc_vat`.
- **Debit (decreases AP):** `POST /payments` — DR 2000 `amount`.
- **GL correction:** `PUT /invoices/:id` with accounting changes — reverse original + replace.

The **outstanding AP per the invoice table** is:
```sql
SELECT SUM(total_inc_vat - amount_paid)
FROM supplier_invoices
WHERE company_id = :id
AND status NOT IN ('paid', 'cancelled', 'draft')
```

Same gap: no cross-check function exists.

### 9.3 The Trial Balance View of AR/AP

The Trial Balance (`GET /api/accounting/reports/trial-balance`) reads only `journal_lines` joined to `journals WHERE status = 'posted'`. It does NOT read `customer_invoices` or `supplier_invoices` at all. The AR and AP figures on the TB are entirely GL-derived.

The ageing reports (`GET /suppliers/aging`) read only `supplier_invoices`. They are entirely invoice-table-derived.

These two data sources can diverge if any of the silent GL failure modes occur (Sections 6.3 and 7.3).

---

## 10. AGEING REPORTS

### 10.1 Aged Creditors (Supplier Ageing)

**Route:** `GET /api/accounting/suppliers/aging`  
**File:** `backend/modules/accounting/routes/suppliers.js` line 1339  
**Status: IMPLEMENTED — reads live data from `supplier_invoices`**

**Logic:**
1. Fetches all supplier invoices where `status NOT IN ('paid', 'cancelled', 'draft')` and `company_id = :id`.
2. For each invoice with outstanding balance > 0:
   - Computes `daysOverdue = today - due_date`.
   - Buckets into: `current` (0 or future), `days30` (1-30), `days60` (31-60), `days90` (61-90), `days90plus` (91+).
3. Groups by supplier.
4. Returns per-supplier ageing with all five buckets and a total.

**Assessment:** Correct implementation. Reads from invoice table, not GL. Consistent with the AP payment tracking (which also uses `amount_paid` on the invoice). This is an internally consistent view.

**Note:** Ageing uses `due_date` for bucketing. Invoices with no `due_date` will have `dueDate = null` → `new Date(null)` = 1 January 1970 → `daysOverdue` will be a very large positive number → they will all appear in `days90plus`. This is probably undesirable.

### 10.2 Aged Debtors (Customer Ageing)

**Route:** None — **NO BACKEND ENDPOINT EXISTS.**  
**Frontend:** `aged-debtors.html` is a static stub. It shows a hardcoded "As at 14 January 2026" date. The entire page is non-functional:
```javascript
function generateReport() { alert('Generating report with selected parameters...'); }
function exportPDF() { alert('Exporting report to PDF...'); }
function exportExcel() { alert('Exporting report to Excel...'); }
```

There are no API calls. There is no real data.

**Risk: HIGH.** An accounting practice relies on aged debtors analysis. This report being a placeholder is a material gap.

---

## 11. STATEMENTS

### 11.1 Customer Statements

No customer statement endpoint exists in `customer-invoices.js` or in `reports.js`. The `reports.js` file contains only: trial balance, general ledger, bank reconciliation summary, balance sheet, P&L, and division P&L.

**Status: NOT IMPLEMENTED.**

### 11.2 Supplier Statements

No supplier statement endpoint exists.

**Status: NOT IMPLEMENTED.**

---

## 12. MULTI-TENANT SAFETY

### 12.1 Customer Invoice Routes

Every database query in `customer-invoices.js` is filtered by `req.companyId`:

| Query | Filter |
|---|---|
| `GET /customers` | `.eq('company_id', companyId)` on both `pos_customers` and `customer_invoices` |
| `GET /` | `.eq('company_id', companyId)` |
| `GET /:id` | `.eq('id', invoiceId).eq('company_id', companyId)` |
| `POST /` duplicate check | `.eq('company_id', companyId)` |
| `POST /` insert | `company_id: companyId` set explicitly |
| `PUT /:id` fetch | `.eq('company_id', companyId)` |
| `PUT /:id` update | `.eq('id', invoiceId)` — **NO `company_id` filter on the UPDATE call** |
| `POST /:id/post` | `.eq('company_id', companyId)` on fetch; update has no company filter |
| `POST /:id/void` | `.eq('company_id', companyId)` on fetch; update uses only `.eq('id', invoiceId)` |
| `POST /payments` | `company_id: companyId` on insert; allocation updates use `.eq('company_id', companyId)` on invoice fetch |

**Partial risk finding:** The `PUT /:id` update and `POST /:id/void` update calls use only `.eq('id', invoiceId)` without `.eq('company_id', companyId)`. In practice, since the preceding fetch includes the company filter and the invoice ownership is verified there, a cross-tenant write is not possible through normal flows. However, a defence-in-depth improvement would be to add `.eq('company_id', companyId)` to the update calls as well (as is done in the supplier invoice edit).

### 12.2 Supplier Routes

All supplier queries in `suppliers.js` include `.eq('company_id', companyId)` on reads. The supplier invoice `PUT /invoices/:id` update includes `.eq('company_id', companyId)` on the update call explicitly. This is stronger than the AR side.

Supplier creation, invoice creation, payment creation all set `company_id: companyId` explicitly from the JWT.

### 12.3 Assessment

Multi-tenant isolation is **substantially correct**. The minor gap on the AR side (update calls missing explicit company filter) is low-risk in practice but should be tightened.

---

## 13. PARENT / NON-POSTABLE ACCOUNT PROTECTION

### 13.1 JournalService Guard

**File:** `backend/modules/accounting/services/journalService.js` line 78

`JournalService.createDraftJournal()` calls `_assertAccountsPostable()` before the atomic pg transaction:

```javascript
const nonPostable = (data || []).filter(a => a.is_postable === false);
if (nonPostable.length > 0) {
  throw new Error(`The following account(s) are parent accounts and cannot be used for direct postings. Select a sub-account instead: ${list}`);
}
```

This guard applies to **all** journals created through JournalService — including AR invoice posting, AP invoice creation, AR payments, and AP payments.

### 13.2 Coverage

| Flow | Uses JournalService? | Protected? |
|---|---|---|
| Customer invoice post | Yes (`createDraftJournal` + `postJournal`) | ✅ Yes |
| Customer payment GL | Yes (`createDraftJournal` + `postJournal`) | ✅ Yes |
| Supplier invoice create (GL) | Yes | ✅ Yes |
| Supplier invoice edit (GL correction) | Yes | ✅ Yes |
| Supplier payment GL | Yes | ✅ Yes |
| `JournalService.reverseJournal()` | Uses `_insertLinesOnClient` directly — no `_assertAccountsPostable` call | ⚠️ Partial |

**Partial risk finding:** `reverseJournal()` does not call `_assertAccountsPostable()`. Reversals swap debit/credit from the original journal lines. Since the original journal lines were validated as postable when they were created, the reversal will target the same accounts — which are still postable. So in practice this is not a real risk. But it is worth noting that the check is absent on the reversal path.

### 13.3 `is_postable` Column Migration

The `is_postable` column was added by migration 044 (`044_coa_sub_accounts.sql`). The `accounting-schema.js` auto-migration does **not** add this column — it is in a standalone SQL migration file. If a company was set up before migration 044 was applied, all accounts will have `is_postable = null` (not `false`). The filter `a.is_postable === false` will not fire on null values. Pre-migration companies have no effective parent account guard.

---

## 14. AUDIT TRAIL AND REVERSAL BEHAVIOUR

### 14.1 AuditLogger Coverage

Every mutating operation in both `customer-invoices.js` and `suppliers.js` calls `AuditLogger.log()`:

| Action | AuditLogger Event |
|---|---|
| Customer invoice created | `CUSTOMER_INVOICE_CREATED` |
| Customer invoice updated | `CUSTOMER_INVOICE_UPDATED` |
| Customer invoice edit blocked | `CUSTOMER_INVOICE_EDIT_BLOCKED` |
| Customer invoice post blocked | `CUSTOMER_INVOICE_POST_BLOCKED` |
| Customer invoice posted | `CUSTOMER_INVOICE_POSTED` |
| Customer invoice void blocked | `CUSTOMER_INVOICE_VOID_BLOCKED` |
| Customer invoice voided | `CUSTOMER_INVOICE_VOIDED` |
| Customer payment recorded | `CUSTOMER_PAYMENT_RECORDED` |
| Supplier created | `SUPPLIER_CREATED` |
| Supplier updated | `SUPPLIER_UPDATED` |
| Supplier invoice created | `SUPPLIER_INVOICE_CREATED` |
| Supplier invoice updated | `SUPPLIER_INVOICE_UPDATED` |
| Supplier invoice GL corrected | `SUPPLIER_INVOICE_GL_CORRECTED` |
| Supplier invoice edit blocked | `SUPPLIER_INVOICE_EDIT_BLOCKED` |
| Supplier payment recorded | `SUPPLIER_PAYMENT_RECORDED` |

**Blocked actions are also audited** — this is correct and important for an accounting system (you need a record of attempted unauthorised actions).

### 14.2 JournalService Reversal Atomicity

`reverseJournal()` uses a pg transaction containing:
1. `INSERT INTO journals` (reversal header — includes VAT fields).
2. `_insertLinesOnClient` (reversed lines — DR/CR swapped).
3. `UPDATE journals SET status='reversed', reversed_by_journal_id=...` (mark original).

All three either commit together or roll back together. The reversal journal is never committed without the original being marked reversed.

### 14.3 Reversal Guard Checks

`reverseJournal()` blocks reversal if:
- Original journal is not `status='posted'` (cannot reverse draft or already-reversed).
- Original journal already has `reversed_by_journal_id` set (already reversed).
- Original journal's date is in a locked accounting period (`isPeriodLocked`).
- Today's date is in a locked accounting period (reversal journal cannot be dated today if period is locked).

### 14.4 Before/After JSON

The AuditLogger `beforeJson`/`afterJson` pattern is consistently populated for AR:
- `beforeJson` captures the pre-change state (invoice totals, status, journal ID).
- `afterJson` captures the new state plus relevant IDs.

This enables full reconstruction of what changed and when.

---

## 15. WHAT IS WORKING AND MUST BE PROTECTED

The following features are confirmed working and correct. Any future change to these areas must preserve this behaviour.

| # | Feature | Location | Why Protected |
|---|---|---|---|
| 1 | AR two-stage lifecycle (DRAFT → SENT) | `customer-invoices.js` POST, PUT, POST/:id/post | Prevents GL pollution from draft invoices |
| 2 | Duplicate invoice number guard | `customer-invoices.js` POST line ~195 | Prevents double-entry of same invoice |
| 3 | AR void blocked if payments applied | `customer-invoices.js` POST/:id/void | Core integrity: cannot void paid invoices |
| 4 | AR void blocked if VAT period locked | `customer-invoices.js` POST/:id/void | VAT compliance |
| 5 | AP edit VAT period lock guard | `suppliers.js` PUT/invoices/:id | VAT compliance |
| 6 | AP edit blocked if invoice paid | `suppliers.js` PUT/invoices/:id | Core integrity |
| 7 | AP GL correction (reverse + replace) | `suppliers.js` PUT/invoices/:id | Ensures GL matches edited invoice |
| 8 | AP GL correction safe rollback | `suppliers.js` PUT/invoices/:id | Prevents inconsistent GL state |
| 9 | Supplier balance derived live from invoices | `suppliers.js` GET/, GET/:id | No stale denormalised balance |
| 10 | VAT period assignment on all AR/AP journals | `JournalService._resolveVatPeriodForPost()` | VAT return accuracy |
| 11 | `is_postable` guard in JournalService | `journalService.js` `_assertAccountsPostable()` | Prevents posting to parent accounts |
| 12 | Journal balance validation | `JournalService.validateBalance()` | Double-entry integrity |
| 13 | Atomic pg transaction for journal creation | `JournalService.createDraftJournal()` | No orphaned journals |
| 14 | Atomic pg transaction for journal reversal | `JournalService.reverseJournal()` | No partial reversals |
| 15 | AuditLogger on all mutating operations | Both routes | Full audit trail |
| 16 | `company_id` scoping on all reads | Both routes | Multi-tenant isolation |
| 17 | `hasPermission('ap.manage')` on supplier invoice creation | `suppliers.js` POST /invoices | Role-based access control |
| 18 | Supplier duplicate invoice guard | `suppliers.js` POST /invoices | Prevents double-submission of supplier bills |

---

## 16. CONFIRMED RISKS

Risks are rated by impact to financial data integrity and compliance.

---

### RISK-AR-01 — Customer Payment GL Failure Is Silent
**Severity: HIGH**  
**Location:** `customer-invoices.js` POST /payments, lines ~790-820  
**Description:** If the AR account (1100) is absent from the chart of accounts, or if `JournalService` throws for any reason, the customer payment is recorded in `customer_payments` and the invoice `amount_paid` is updated — but no GL journal is created. The API returns 201 success. The user has no indication of failure. `customer_payments.journal_id` remains null.  
**Financial Impact:** AR GL balance (1100) understated. Cash/bank GL balance unaffected. TB shows wrong AR figure. Control account reconciliation will fail silently.

---

### RISK-AP-01 — Supplier Payment GL Failure Is Silent
**Severity: HIGH**  
**Location:** `suppliers.js` POST /payments, lines ~1290-1310  
**Description:** Identical pattern to RISK-AR-01. If AP account (2000) absent or GL throws: payment recorded, invoice updated, no GL journal, no user error, `journal_id=null`.  
**Financial Impact:** AP GL balance (2000) overstated (liability appears not cleared). Cash/bank unaffected.

---

### RISK-AP-02 — Supplier Invoice Created Without GL (Silent)
**Severity: HIGH**  
**Location:** `suppliers.js` POST /invoices  
**Description:** If AP account (2000) is absent, the supplier invoice is created with `status='unpaid'` but no GL journal. The invoice will appear on aged creditors and AP ageing but not in the TB or balance sheet as a liability.  
**Financial Impact:** AP understated on balance sheet. VAT Input not captured. Deductible expense not in GL.

---

### RISK-AR-02 — Customer Invoice Post: Missing VAT Account Gives Confusing Error
**Severity: MEDIUM-HIGH**  
**Location:** `customer-invoices.js` POST /:id/post  
**Description:** If account 2300 (VAT Output) is absent, the journal will be constructed without a VAT credit line, causing `validateBalance()` to throw "Journal does not balance" rather than a meaningful "VAT Output account (2300) not found" error.  
**Financial Impact:** Zero (post is blocked), but user experience is poor and root cause is not surfaced.

---

### RISK-AR-03 — No AR Aged Debtors API
**Severity: HIGH (business process gap)**  
**Location:** `aged-debtors.html` is a static stub; no backend endpoint  
**Description:** There is no API or backend logic for customer ageing by debtor. The frontend page is non-functional. An accounting practice needs this report.  
**Financial Impact:** Practice cannot produce debtor collection reports from this system.

---

### RISK-AR-04 — No AR Control Account Reconciliation Function
**Severity: MEDIUM**  
**Location:** Entire codebase — absent  
**Description:** There is no function that cross-checks: `GL balance of account 1100` vs `SUM(total_inc_vat - amount_paid) from customer_invoices WHERE status NOT IN ('draft', 'void')`. These two should always be equal. Silent payment GL failures (RISK-AR-01) or manual journal entries to 1100 will cause divergence with no detection.

---

### RISK-AP-03 — No AP Control Account Reconciliation Function
**Severity: MEDIUM**  
**Location:** Entire codebase — absent  
**Description:** Same gap as RISK-AR-04 but for AP (account 2000 vs `supplier_invoices` outstanding balances).

---

### RISK-AR-05 — Payment Over-Allocation Not Validated
**Severity: MEDIUM**  
**Location:** `customer-invoices.js` POST /payments, allocation loop  
**Description:** No validation prevents `alloc.amount` from exceeding the invoice's remaining balance. An over-allocation will set `amount_paid > total_inc_vat`. Status = `'paid'` with a negative effective balance. No error is returned.  
**Financial Impact:** Overpaid invoices will show as paid. Credit balance not tracked separately.

---

### RISK-AP-04 — Supplier Invoice Has No Void Path
**Severity: MEDIUM**  
**Location:** `suppliers.js` — no POST /invoices/:id/void  
**Description:** Customer invoices have a formal void endpoint with VAT period guard and GL reversal. Supplier invoices do not. To "cancel" a supplier invoice, the user must edit it to status `'cancelled'` and zero-value lines. The GL correction logic in `PUT /invoices/:id` will then reverse the original journal and post a zero-value replacement. This is indirect and error-prone.

---

### RISK-SCHEMA-01 — `database/schema.sql` Contains Legacy Column Definitions
**Severity: LOW (operational risk only)**  
**Location:** `database/schema.sql` lines 754-820  
**Description:** `customer_invoices`, `customer_invoice_lines`, `supplier_invoices`, `supplier_invoice_lines` in `schema.sql` use: `journal_id REFERENCES journal_entries(id)` (wrong — `journal_entries` does not exist, should be `journals`), legacy column names (`subtotal` instead of `subtotal_ex_vat`), and `account_id REFERENCES chart_of_accounts(id)` (wrong — should be `accounts(id)`). The actual deployed tables are defined correctly in `accounting-schema.js`. This is a documentation drift risk — any developer reading `schema.sql` for table structure will get incorrect information.

---

### RISK-MULTI-01 — AR Update Calls Missing Company Filter
**Severity: LOW**  
**Location:** `customer-invoices.js` PUT /:id (update call), POST /:id/post (status update), POST /:id/void (status update)  
**Description:** The `supabase.from('customer_invoices').update(...)` calls filter only by `.eq('id', invoiceId)` without `.eq('company_id', companyId)`. In practice, since the prior fetch verifies ownership, this is not exploitable through normal API use. It violates the defence-in-depth principle and should be corrected.

---

### RISK-AGING-01 — Null Due Date in AP Ageing Buckets to `days90plus`
**Severity: LOW**  
**Location:** `suppliers.js` GET /aging  
**Description:** `new Date(null)` evaluates to 1 January 1970. Supplier invoices with `due_date = null` will be computed as `daysOverdue = today - 1970-01-01` ≈ 20,000 days → bucketed into `days90plus`. This is misleading on the ageing report.

---

## 17. RECOMMENDED WORKSTREAMS

Listed in priority order based on financial data integrity risk.

### WS-01 — Fix Silent GL Failure: Customer and Supplier Payments
**Priority: CRITICAL**  
**Addresses:** RISK-AR-01, RISK-AP-01  
**What to do:** In both `POST /payments` endpoints, change the GL failure handling from a silent `console.warn` to:
1. Return a 422 or 500 error to the caller when GL posting fails, OR
2. Implement a transaction that rolls back the payment record if GL posting fails, OR
3. Log the GL failure with enough detail for the accountant to fix it, and add a `journal_posted = false` flag on the payment record that is surfaced in the UI.

Option 3 is safest for UX (the payment fact is preserved; the GL gap is surfaced). Options 1 or 2 are stricter but may cause data loss if the user had correctly entered a payment.

**Ruan must decide** which failure mode is preferable before code changes are made (see Section 18, Question 1).

---

### WS-02 — Fix Silent GL Failure: Supplier Invoice Creation
**Priority: CRITICAL**  
**Addresses:** RISK-AP-02  
**What to do:** If AP account (2000) is absent when creating a supplier invoice, the invoice should **not** be created. Return a clear 422 error: "Accounts Payable account (code 2000) not found. Please provision a base chart of accounts before creating supplier invoices." This is consistent with how the AR side handles missing account 1100 on invoice post.

---

### WS-03 — Build Aged Debtors API + Live Frontend
**Priority: HIGH**  
**Addresses:** RISK-AR-03  
**What to do:** Add `GET /api/accounting/customer-invoices/aging` following the same pattern as `GET /api/accounting/suppliers/aging`. Group by `customer_name` (or `customer_id` if set). Bucket by days overdue from `due_date`. Update `aged-debtors.html` to call this endpoint.

---

### WS-04 — Meaningful Error When VAT Account Missing on AR Invoice Post
**Priority: MEDIUM-HIGH**  
**Addresses:** RISK-AR-02  
**What to do:** Before building `glLines`, check for account 2300 when `vat_amount > 0`. If absent, return a clear 422: "VAT Output account (code 2300) not found. Please provision a base chart of accounts first." This prevents the confusing "Journal does not balance" error.

---

### WS-05 — AR Update Calls: Add Company Filter
**Priority: MEDIUM**  
**Addresses:** RISK-MULTI-01  
**What to do:** Add `.eq('company_id', companyId)` to the three `update(...)` calls in `customer-invoices.js` (PUT /:id update, POST /:id/post status update, POST /:id/void status update). This is a one-line change per call.

---

### WS-06 — Add Supplier Invoice Void Endpoint
**Priority: MEDIUM**  
**Addresses:** RISK-AP-04  
**What to do:** Add `POST /api/accounting/suppliers/invoices/:id/void` following the same pattern as the customer invoice void. Should: block if `status === 'paid'` or `amount_paid > 0`, check VAT period lock, call `JournalService.reverseJournal()` if `journal_id` exists, set `status = 'cancelled'`, audit log.

---

### WS-07 — Fix AP Ageing Null Due Date Handling
**Priority: LOW**  
**Addresses:** RISK-AGING-01  
**What to do:** In `GET /suppliers/aging`, skip or bucket separately invoices where `due_date` is null. Either exclude them with a note or add a "No due date" bucket.

---

### WS-08 — Update `database/schema.sql`
**Priority: LOW**  
**Addresses:** RISK-SCHEMA-01  
**What to do:** Align the `customer_invoices`, `customer_invoice_lines`, `supplier_invoices`, `supplier_invoice_lines` sections of `database/schema.sql` to match `accounting-schema.js` (correct column names, correct FK targets `journals(id)` and `accounts(id)`). This is a documentation fix only — no production behaviour changes.

---

### WS-09 — Build Customer Statement Endpoint
**Priority: LOW (future)**  
**Addresses:** No specific risk — capability gap  
**What to do:** Add `GET /api/accounting/customer-invoices/statement?customerId=&fromDate=&toDate=` that returns a time-ordered list of invoices and payments for a customer, with running balance.

---

### WS-10 — Control Account Reconciliation Report
**Priority: LOW (future)**  
**Addresses:** RISK-AR-04, RISK-AP-03  
**What to do:** Add a reconciliation check that compares `GL balance of account 1100` vs `sum of outstanding customer invoices` and `GL balance of account 2000` vs `sum of outstanding supplier invoices`. Surface any divergence to the accountant. This is the AR/AP equivalent of the bank reconciliation report.

---

## 18. QUESTIONS FOR RUAN BEFORE CODE CHANGES

These questions must be answered before any code changes are made to address the risks above.

**Question 1 (for WS-01 — Payment GL Failure):**
When a customer or supplier payment is recorded but the GL posting fails silently, what should the system do?
- (a) Return an error to the user and roll back the payment record entirely (strict — user must fix their chart of accounts first, then re-record the payment).
- (b) Save the payment record but mark it with a `journal_posted = false` flag, surface a visible warning in the UI, and let the accountant manually trigger GL posting later.
- (c) Current behaviour — save payment, log to console, return success. (This option should not be kept.)

**Question 2 (for WS-01 — Payment GL Failure on Supplier Side):**
Is `bankLedgerAccountId` optional on supplier payments by design? Currently, if no bank account is provided, GL is skipped without any warning at all. Should this be a required field for all supplier payments?

**Question 3 (for WS-03 — Aged Debtors):**
The AR module stores customers as free-text `customer_name`. The aged debtors report would group by name. Should the aged debtors report:
- (a) Group by `customer_name` only (simple, may have duplicates if names vary).
- (b) Group by `customer_id` when set, fall back to `customer_name` when null.
- (c) Require a formal customer master before the report is built?

**Question 4 (for AR customer model):**
The `customer_invoices.customer_id` column has no FK constraint in `accounting-schema.js`. It appears to be an informal link to `pos_customers`. Should this be formalised as a FK, or should AR customers remain a separate free-text concept with no enforced link to POS customers?

**Question 5 (for `customers.current_balance`):**
The `customers` table has a `current_balance` field. Is this field actively used by any frontend page for display purposes? If so, is it expected to reflect AR invoices from the accounting module, or only POS transactions?

**Question 6 (for Supplier Invoice Draft Stage):**
Unlike customer invoices, supplier invoices are live (status = `'unpaid'`) and posted to GL immediately on creation. Is this by design? Or should supplier invoices also have a DRAFT stage that allows review before GL posting?

**Question 7 (for WS-06 — Supplier Invoice Void):**
When voiding a supplier invoice that has partial payments applied, should:
- (a) The void be blocked until all payments are reversed (same as AR), or
- (b) A partial void be allowed, reducing the invoice to the amount already paid and marking it as `'paid'`?

**Question 8 (for WS-10 — Control Account Reconciliation):**
If the GL balance of account 1100 diverges from the sum of outstanding customer invoices, should the system:
- (a) Show an informational warning on the AR dashboard, or
- (b) Prevent further AR transactions until the divergence is resolved, or
- (c) Log the divergence and flag it only in a periodic reconciliation report?

---

*Audit completed: 2026-05-29*  
*Files inspected: `customer-invoices.js`, `suppliers.js`, `journalService.js`, `accounting-schema.js`, `database/schema.sql`, `reports.js`, `aged-debtors.html`, `accounts.js` (grep)*  
*No files were modified. No migrations were run.*
