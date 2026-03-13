# Lorenco Accounting App — Development TODO
> Generated from full audit — March 2026
> Priority order: CRITICAL → HIGH → MEDIUM → LOW
> Overall module completeness: **35%** — NOT production ready

---

## SPRINT 1 — Blocking Issues (Must fix before any real use)

### CRITICAL — Schema Fixes

- [ ] **Add `is_system` column to `accounts` table** in `accounting-schema.js`
  - Column queried in routes/accounts.js but never created → system account edit-protection silently broken
  - `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false`

- [ ] **Add `integrations` table to `accounting-schema.js`**
  - All `/api/accounting/integrations` endpoints query this table → currently crash with "relation not found"
  - Columns needed: `id, company_id, name, provider, api_key_hash, is_active, created_at, updated_at`

- [ ] **Add AI settings tables to `accounting-schema.js`**
  - Routes in `routes/ai.js` reference `ai_settings_company`, `ai_settings_capabilities`, `ai_settings_user_overrides`
  - All three missing → `ai-settings.html` crashes on every load
  - Add all three tables or stub them as a simple JSONB settings table per company

- [ ] **Add `accounting_kv_store` table to `accounting-schema.js`**
  - `routes/kv.js` docs say "create manually in Supabase SQL editor" — should be in auto-migration
  - Columns: `id, company_id, key, value (JSONB), updated_at`

- [ ] **Add `(company_id, period_key)` UNIQUE constraint to `vat_periods`**
  - Code assumes uniqueness but no DB-level constraint enforces it

---

### CRITICAL — Journal Posting and Reversal

- [ ] **Implement `POST /api/accounting/journals/:id/post`** in `routes/journals.js`
  - Without this, all journals are stuck in draft forever — trial balance only shows draft entries
  - Logic: validate journal is draft → set `status = 'posted'`, `posted_at = NOW()`, `posted_by_user_id = req.user.userId` → audit log

- [ ] **Implement `POST /api/accounting/journals/:id/reverse`** in `routes/journals.js`
  - Without this, posting errors cannot be corrected
  - Logic: create new journal with all lines flipped (debit↔credit) → set `reversal_of_journal_id` on new journal → set `reversed_by_journal_id` on original → post the new journal immediately

- [ ] **Implement `PUT /api/accounting/journals/:id`** in `routes/journals.js`
  - Update a draft journal (header + lines replace)
  - Must validate still in draft status before allowing edit

- [ ] **Implement `DELETE /api/accounting/journals/:id`** in `routes/journals.js`
  - Delete a draft journal only
  - Block deletion of posted journals

---

### CRITICAL — Reports (core accounting reports)

- [ ] **Implement `GET /api/accounting/reports/balance-sheet`** in `routes/reports.js`
  - `balance-sheet.html` exists but endpoint returns 404
  - Logic: sum all asset accounts (debit balance) vs liability + equity accounts (credit balance)
  - Must accept `?date=YYYY-MM-DD` parameter (point-in-time balance sheet)

- [ ] **Implement `GET /api/accounting/reports/profit-loss`** in `routes/reports.js`
  - No frontend page yet — create `profit-loss.html` and link from dashboard
  - Logic: sum income accounts (credits) minus expense accounts (debits) for a date range
  - Parameters: `?from=YYYY-MM-DD&to=YYYY-MM-DD`

---

### CRITICAL — Company Settings Save

- [ ] **Complete `PUT /api/accounting/company/:id`** in `routes/company.js`
  - Handler is cut off (implementation missing after function signature)
  - `company.html` can read company details but cannot save SA tax fields
  - Fields to save: `income_tax_number, paye_reference, uif_reference, sdl_reference, vat_period, bank_name, branch_code, account_number, account_type, account_holder`
  - Requires `admin` or `accountant` permission

---

## SPRINT 2 — Core Workflows

### HIGH — Bank Reconciliation

- [ ] **Complete bank transaction import** `POST /api/accounting/bank/transactions` in `routes/bank.js`
  - Logic stubs out at line ~200
  - Support: manual entry OR CSV import (OFX/CSV bank statement)
  - Each transaction: `date, description, amount, reference, bank_account_id`

- [ ] **Complete transaction matching** `PUT /api/accounting/bank/transactions/:id` in `routes/bank.js`
  - Match a bank transaction to a journal entry
  - Set `status = 'matched'`, `matched_entity_type = 'journal'`, `matched_entity_id = journalId`
  - Unmatched transactions remain visible for reconciliation

- [ ] **Add `PUT /api/accounting/bank/accounts/:id`** — currently missing entirely
  - Update bank account name, bank name, linked ledger account

---

### HIGH — PAYE Workflow Completion

- [ ] **Implement `POST /api/accounting/paye/reconciliation/approve/:reconId`** in `routes/payeReconciliation.js`
  - Stub handler exists, logic missing
  - Set `status = 'approved'`, `approved_by_user_id`, `approved_at` → audit log

- [ ] **Implement `POST /api/accounting/paye/reconciliation/lock/:reconId`** in `routes/payeReconciliation.js`
  - Stub handler exists, logic missing
  - Set `status = 'locked'` → prevent further edits → audit log

- [ ] **Implement `GET /api/accounting/paye/reconciliation/snapshot/:reconId`** in `routes/payeReconciliation.js`
  - View-only snapshot of a submitted/locked reconciliation
  - Returns full reconciliation with all employee lines, income breakdown, deduction breakdown

- [ ] **Complete `PUT /api/accounting/paye/config`** in `routes/payeConfig.js`
  - Service method exists but route is incomplete
  - Should allow adding/editing/deactivating custom income and deduction types per company

- [ ] **Seed default PAYE income and deduction types on first access**
  - New companies start with empty PAYE config — must manually add everything
  - Seed standard SA PAYE types: Basic Salary, Commission, Bonus, Overtime (income) + UIF, Medical Aid, Pension (deductions)
  - Trigger: on first `GET /api/accounting/paye/config` if no config exists yet

---

### HIGH — Cash Flow Report

- [ ] **Implement `GET /api/accounting/reports/cash-flow`** in `routes/reports.js`
  - `cashflow.html` exists but endpoint 404s
  - Minimum viable: direct method (operating, investing, financing classification by account type)
  - Parameters: `?from=YYYY-MM-DD&to=YYYY-MM-DD`

---

## SPRINT 3 — Customer / Supplier / AR / AP

### MEDIUM — Customer Master

- [ ] **Create `customers` table** in `accounting-schema.js`
  - Columns: `id, company_id, name, registration_number, vat_number, email, phone, address, is_active, created_at`

- [ ] **Implement CRUD routes for customers** — new file `routes/customers.js`
  - `GET /api/accounting/customers` — list (filter: is_active, search by name)
  - `GET /api/accounting/customers/:id` — single customer
  - `POST /api/accounting/customers` — create
  - `PUT /api/accounting/customers/:id` — update
  - `DELETE /api/accounting/customers/:id` — soft delete (is_active = false)

- [ ] **Wire `customers.html` and `customer-list.html`** to new endpoints

---

### MEDIUM — Supplier Master

- [ ] **Create `suppliers` table** in `accounting-schema.js`
  - Same structure as customers

- [ ] **Implement CRUD routes for suppliers** — new file `routes/suppliers.js`
  - Same pattern as customers

- [ ] **Wire `suppliers.html`** to new endpoints

---

### MEDIUM — Invoice Tracking

- [ ] **Create `invoices` table** in `accounting-schema.js`
  - Columns: `id, company_id, customer_id (FK), invoice_number, date, due_date, status (draft/sent/paid/overdue), total_amount, vat_amount, linked_journal_id, created_at`

- [ ] **Implement invoice routes** — new file `routes/invoices.js`
  - `GET /api/accounting/invoices` — list (filter: status, customer, date range)
  - `POST /api/accounting/invoices` — create + auto-create journal entry
  - `PUT /api/accounting/invoices/:id/mark-paid` — set paid + reconcile journal
  - `DELETE /api/accounting/invoices/:id` — void (not delete)

- [ ] **Wire `invoices.html`** to new endpoints

---

### MEDIUM — Analysis Reports

- [ ] **Implement `GET /api/accounting/reports/sales-analysis`**
  - Aggregate sales journal entries by customer → total per customer for period
  - Wire to `sales-analysis.html`

- [ ] **Implement `GET /api/accounting/reports/purchase-analysis`**
  - Aggregate purchase journal entries by supplier → total per supplier for period
  - Wire to `purchase-analysis.html`

- [ ] **Implement `GET /api/accounting/reports/aged-debtors`**
  - Outstanding invoices by customer bucketed: current / 30 days / 60 days / 90+ days
  - Wire to `aged-debtors.html`

- [ ] **Implement `GET /api/accounting/reports/aged-creditors`**
  - Outstanding payables by supplier, same buckets
  - Wire to `aged-creditors.html`

- [ ] **Implement `GET /api/accounting/reports/customer-receipts`**
  - Payments received by customer for a period
  - Wire to `customer-receipts.html`

---

## SPRINT 4 — SEAN AI Integration (per CLAUDE.md Part B)

### HIGH (per roadmap) — IRP5 Learning System

- [ ] **Implement learning event capture** — `services/seanLearning.js`
  - Record payroll item name + IRP5 code changes with full context (who, when, previous, new)
  - Per CLAUDE.md Rule B4: `source_app, client_id, item_name, item_category, old_code, new_code, set_by_user, user_id, timestamp, is_standardization_candidate`

- [ ] **Implement knowledge store** — table `sean_irp5_mappings`
  - Stores learned `item_meaning → IRP5 code` standard mappings
  - Per CLAUDE.md Rule B3: item meaning matters, not just item name ("Comm." = "Commission")

- [ ] **Implement proposal engine** — `services/seanProposalEngine.js`
  - Identify clients with blank IRP5 codes matching a learned mapping
  - Identify clients with conflicting codes (per Rule B9 — never overwrite)

- [ ] **Implement approval workflow endpoint** — `POST /api/accounting/sean/irp5/approve`
  - Authorized user reviews proposal → approves propagation to missing-code clients only
  - Conflicting-code clients excluded and listed in exception report
  - Per CLAUDE.md Rule B6: ONLY blank/null/missing codes may be updated after approval

- [ ] **Implement propagation engine** — runs after approval
  - Applies approved standard mapping to eligible clients only
  - Full audit trail: who approved, what changed, when

- [ ] **Wire to accounting AI settings page**
  - Show SEAN learning events, pending proposals, propagation history

---

## SPRINT 5 — Polish and Production Hardening

### MEDIUM — Error Handling

- [ ] **Return specific validation errors** from all routes
  - Currently many routes return generic "Failed to X"
  - Should return field-level validation errors, FK violation messages, constraint failures

- [ ] **Add request validation middleware** to accounting routes
  - Validate required fields before hitting DB
  - e.g. journal create: `date`, `reference`, `lines` array with at least 2 entries, balanced debits/credits

### MEDIUM — Security Hardening

- [ ] **Mask sensitive fields in audit log `before_json` / `after_json`**
  - Bank account numbers, tax reference numbers should be masked before logging
  - e.g. `account_number: "****1234"` in audit trail

- [ ] **Add rate limiting to accounting API**
  - Use `express-rate-limit` (already in package.json) on bulk report endpoints
  - Prevent scraping of all customers, suppliers, or full trial balance data

- [ ] **Harden `frontend-accounting` XSS**
  - Audit all `innerHTML` uses in frontend JS
  - Replace with `textContent` where data is user input
  - Consider adding DOMPurify for any rich-text display

### LOW — Code Quality

- [ ] **Add pagination to `GET /api/accounting/accounts`**
  - Returns all accounts with no limit — performance risk for large COA
  - Add `?limit=100&offset=0` support

- [ ] **Soft delete bank accounts**
  - Currently no `is_active` on bank accounts — hard delete loses history
  - Add `is_active BOOLEAN DEFAULT true`, use soft delete

- [ ] **Add soft delete to journals (drafts only)**
  - Currently no DELETE handler — add one for draft-only journals
  - Block delete of posted journals

- [ ] **Remove `index.html.bak`** from `frontend-accounting/`
  - Backup file should not be in the deployed codebase

- [ ] **Document manual Supabase steps**
  - If any tables still require manual SQL (none should after Sprint 1 schema fixes)
  - All tables must be in `accounting-schema.js` auto-migration

---

## Reference: File Locations

| Area | Backend | Frontend |
|------|---------|----------|
| Schema | `backend/config/accounting-schema.js` | — |
| Routes | `backend/modules/accounting/routes/` | — |
| Services | `backend/modules/accounting/services/` | — |
| DB config | `backend/modules/accounting/config/database.js` | — |
| Auth middleware | `backend/modules/accounting/middleware/auth.js` | — |
| Pages | — | `frontend-accounting/*.html` |
| Shared JS | — | `frontend-accounting/js/` |
| API interceptor | — | `frontend-accounting/js/eco-api-interceptor.js` |

---

## Completeness Tracker

| Feature Area | Status | Sprint |
|---|---|---|
| Chart of Accounts | ✅ 90% complete | — |
| Journal draft creation | ✅ Done | — |
| Journal posting/reversal | ❌ Not started | 1 |
| Trial Balance | ✅ Done | — |
| General Ledger | ✅ Done | — |
| Balance Sheet | ❌ Not started | 1 |
| P&L Report | ❌ Not started | 1 |
| Cash Flow Report | ❌ Not started | 2 |
| Bank Accounts | ⚠️ 60% (no update) | 2 |
| Bank Reconciliation | ⚠️ 30% (matching missing) | 2 |
| VAT Compliance | ✅ 80% complete | — |
| PAYE Config | ⚠️ 60% (save broken) | 2 |
| PAYE Reconciliation | ⚠️ 50% (approve/lock missing) | 2 |
| Company Details Save | ❌ Handler cut off | 1 |
| Customer Master | ❌ Not started | 3 |
| Supplier Master | ❌ Not started | 3 |
| Invoices / AR | ❌ Not started | 3 |
| Sales/Purchase Analysis | ❌ Not started | 3 |
| Aged Debtors/Creditors | ❌ Not started | 3 |
| SEAN IRP5 Learning | ❌ Not started | 4 |
| AI Settings (tables) | ❌ Tables missing | 1 |
| Integrations (tables) | ❌ Tables missing | 1 |
| Audit Trail | ✅ Done | — |
| Auth / Company Isolation | ✅ Done | — |
