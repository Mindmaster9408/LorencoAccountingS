# Session Handoff — 2026-03-15 (Accounting Flow, GL Engine, Company Switcher Fix)

## Summary

Six-step session implementing the full accounting transaction → GL flow:
1. **Company switcher nav fix** — nav bar now shows real client name (not "Company")
2. **Bank allocation atomic auto-post** — allocation now posts journal in same DB transaction
3. **Supplier invoice GL posting** — AP invoices now create posted journal entries
4. **Supplier payment GL posting** — AP payments now post DR AP / CR Bank to GL
5. **Customer AR module** — full customer invoice + payment system with GL posting (new)
6. **invoices.html rewrite** — dead JS prototype replaced with real API integration

All changes committed and pushed.

---

## Commits This Session

| Commit | Description |
|---|---|
| TBD | feat: accounting GL engine — atomic posting for bank, AP, AR + company switcher nav fix |

---

## What Was Changed

### 1. `frontend-accounting/js/navigation.js`

**Bug fixed**: Nav bar showed "Company" instead of the actual client name.

- `initializeNavigation()` now reads `accounting_company_name` first (client-scoped), falls back to `eco_company_name` (practice name)
- Async-refreshes company name from `/api/accounting/company/:cid` API after page load
- `switchToClient()` now stores `accounting_company_name` (the new client-scoped key) — **no longer overwrites `eco_company_name`**
- `logout()` now clears `accounting_company_name`

---

### 2. `backend/modules/accounting/routes/bank.js`

**Bug fixed**: Bank allocation created a DRAFT journal. Frontend made a separate POST to `/journals/:id/post`. If the post call failed, the transaction showed "Allocated" in UI but journal stayed draft — never entered GL or reports.

- `POST /transactions/:id/allocate` now calls `JournalService.postJournal()` with the same pg client **before** COMMIT
- This is atomic: if post fails, entire transaction rolls back. No orphaned drafts possible
- Response message updated to confirm GL posting is included

**File**: `bank.html` — removed the separate second-step post call. Backend now handles this.

---

### 3. `backend/modules/accounting/routes/suppliers.js`

**New feature**: Supplier invoices and payments now create posted GL entries.

- Added `const JournalService = require('../services/journalService')` dependency
- Added `findAccountByCode(client, companyId, code)` helper — safe null-return, never throws
- `POST /invoices` — after inserting invoice + lines, attempts GL posting **in same transaction**:
  - DR each line's accountId (expense account), amount = lineSubtotalExVat
  - DR VAT Input (1400), amount = total VAT (if vatAmount > 0 and account found)
  - CR Accounts Payable (2000), amount = total_inc_vat
  - If AP account (2000) not found: skip GL with console warning (invoice still created)
  - If no DR lines (no accountIds on any line): skip GL (AP-only debit not valid)
  - Stores `journal_id` on `supplier_invoices` record
- `POST /payments` — after allocating to invoices, attempts GL posting:
  - DR Accounts Payable (2000), amount = payment
  - CR Bank Ledger Account (bankLedgerAccountId), amount = payment
  - GL only attempted if `bankLedgerAccountId` is provided in request
  - Stores `journal_id` on `supplier_payments` record
- Extended `POST /payments` body to accept `bankLedgerAccountId`

---

### 4. `frontend-accounting/suppliers.html`

- Added bank account selector (`#payBankAccount`) to the payment modal
- Added `loadBankAccountsForPayment()` — lazy-loads bank accounts from `/api/accounting/bank/accounts` on first modal open
- `openNewPaymentModal()` now calls `loadBankAccountsForPayment()`
- Payment payload now includes `bankLedgerAccountId`

---

### 5. `backend/config/accounting-schema.js`

**New tables added** (idempotent `CREATE TABLE IF NOT EXISTS`):
- `customer_invoices` — AR invoice header (status, journal_id, customer_name, totals)
- `customer_invoice_lines` — AR invoice lines (accountId, qty, price, vat_rate, amounts)
- `customer_payments` — AR payment receipt (bank_ledger_account_id, journal_id)
- `customer_payment_allocations` — links payments to invoices (amount_applied)

**New column on existing table:**
- `ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS bank_ledger_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL`

**Indexes added** for all 4 new customer AR tables.

---

### 6. `backend/modules/accounting/routes/customer-invoices.js` (NEW FILE)

Full AR module. Routes:
- `GET /customers` — customer list for dropdowns (from pos_customers + distinct names from invoices)
- `GET /` — invoice list (filters: status, customerId, fromDate, toDate)
- `GET /:id` — invoice detail with lines
- `POST /` — create draft invoice
- `PUT /:id` — update draft invoice
- `POST /:id/post` — post to GL: DR AR(1100) / CR Revenue(line.account_id) / CR VAT Output(2300) → status becomes 'sent'
- `POST /:id/void` — reverse posted journal, status becomes 'void'
- `POST /payments` — record payment + GL: DR Bank(bankLedgerAccountId) / CR AR(1100)

All routes: company-scoped, GL posting is best-effort (skips with warning if required accounts not found), atomic (same pg transaction).

---

### 7. `backend/modules/accounting/index.js`

- Added `router.use('/customer-invoices', require('./routes/customer-invoices'))`
- Added `accounts-payable` and `accounts-receivable` to the status features list

---

### 8. `frontend-accounting/invoices.html` (Complete Rewrite)

Replaced dead JS prototype (all data in local array, no DB) with real API integration:
- Stats: Total Invoiced, Outstanding AR, Overdue, Collected (Month)
- Tabs: All Invoices | Draft | Sent | Paid | Payments
- Invoice list with columns: Invoice # | Customer | Date | Due | Total | Paid | Balance | Status | Actions
- Overdue rows highlighted in red
- Actions: Post to GL (draft) | Pay | Void
- **Create/Edit Invoice modal**: customer selector (datalist), VAT mode toggle (EX/INC), multi-line items with revenue account selector, per-line VAT%, running totals
- **Record Payment modal**: customer, date, bank account (required for GL), allocation to open invoices
- Dark theme compatible (uses same CSS pattern as suppliers.html)

---

## Account Codes Used (Standard SA Chart)

| Code | Account | Used For |
|---|---|---|
| 1100 | Accounts Receivable | DR on customer invoice post |
| 2000 | Accounts Payable | CR on supplier invoice; DR on supplier payment |
| 1400 | VAT Input (Claimable) | DR on supplier invoice with VAT |
| 2300 | VAT Output (Payable) | CR on customer invoice with VAT |
| varies | Revenue accounts | CR on customer invoice (line.account_id from income accounts) |
| varies | Expense accounts | DR on supplier invoice (line.account_id) |
| varies | Bank ledger | CR on supplier payment / DR on customer payment / DR on bank allocation |

---

## GL Posting — Safety Rules (Applied Throughout)

- All journal creations include `company_id` — no cross-tenant risk
- `findAccountByCode()` always queries `WHERE company_id = $1` — company-scoped
- If required accounts not found in company's COA: GL posting SKIPPED (logged as warning). Source document (invoice/payment) is still created
- No retroactive GL for existing supplier invoices/payments
- Bank allocation: NEVER leaves bank_transaction.status='matched' with journal.status='draft' (atomic)
- Customer invoice void: cannot void if payments are applied (requires payment reversal first)

---

## What Was NOT Changed

- Other accounting routes (journals, accounts, reports, vatRecon, etc.) — still use pg Pool
- `reports.html` P&L — still uses flat income/expense arrays (doesn't show Gross Profit subtotals)
- Customer invoice detail view — clicking customer name shows a stub alert (full detail modal in next session)
- Customer payments list tab — shows placeholder text (full payment history list in next session)
- `seg reporting UI` — still schema-only, no tagging UI

---

## Testing Required

- [ ] Nav bar shows actual client company name after SSO login
- [ ] Switch company from dropdown → nav bar updates immediately
- [ ] Allocate bank transaction → verify journal.status = 'posted' in DB (NOT 'draft')
- [ ] Allocate bank transaction → verify Trial Balance updates immediately
- [ ] Create supplier invoice with account lines → check journal_lines created with DR expense / DR VAT Input / CR AP
- [ ] Record supplier payment with bank account selected → check DR AP / CR Bank in journal_lines
- [ ] Record supplier payment WITHOUT bank account → verify no GL posting, invoice still saved
- [ ] Create customer invoice → Post to GL → check DR AR(1100) / CR Revenue / CR VAT Output(2300)
- [ ] Record customer payment → check DR Bank / CR AR(1100) in journal_lines
- [ ] Trial Balance, P&L, Balance Sheet → verify all new postings appear correctly
- [ ] Create customer invoice with EX VAT toggle → verify VAT calculated correctly
- [ ] Create customer invoice with INC VAT toggle → verify VAT extracted correctly
- [ ] Void customer invoice → verify reversal journal created

---

## Follow-up Notes

```
FOLLOW-UP NOTE
- Area: reports.html P&L subtotals
- What was done: backend returns structured grossProfit/operatingProfit/netProfit sections
- What still needs to be checked: reports.html still uses flat income/expense arrays
- Risk if not checked: users don't see Gross Profit / Operating Profit subtotals
- Recommended next: update reports.html SA 3-tier P&L render

FOLLOW-UP NOTE
- Area: Customer invoice detail view
- What was done: invoices.html list + create + post + void implemented
- What still needs to be checked: clicking customer name shows stub alert, no detail modal
- Risk if not checked: users cannot view invoice detail inline
- Recommended next: add invoice detail modal or expand row

FOLLOW-UP NOTE
- Area: Customer payments list tab
- What was done: tab exists but shows placeholder text
- What still needs to be checked: need GET /customer-payments endpoint or join from existing data
- Recommended next: add GET /customer-payments route and render in payments tab

FOLLOW-UP NOTE
- Area: pg Pool DATABASE_URL in Zeabur
- What was done: no change — journals, accounts, bank, suppliers, reports still use pg Pool
- Risk if not checked: ALL those routes return 500 if DATABASE_URL not set in Zeabur
- Recommended next: add Supabase direct connection string (port 5432) as DATABASE_URL in Zeabur

FOLLOW-UP NOTE
- Area: Segment reporting UI
- What was done: schema ready (journal_lines.segment_value_id), no tagging UI or API filter
- Recommended next: add segment_value_id to journal entry UI + segmentValueId filter to /reports/profit-loss
```
