# ACCOUNTING APP — FULL SYSTEM AUDIT REPORT
**Date:** April 15, 2026 | **Scope:** accounting-ecosystem — full-stack (DB → backend → frontend) | **Mode:** Analysis only — no code changed

---

## 1. AUDIT SUMMARY

The Lorenco Accounting app is a production-grade, multi-tenant double-entry accounting system built for the South African compliance framework (SARS VAT, PAYE, IRP5). It is architecturally sound in its core design, well-structured for a vanilla-JS+Node.js stack, and correctly isolates tenant data at multiple layers. However, several non-trivial risks exist that require attention before high-volume production use — specifically around transaction atomicity, report data integrity, and a few auth/permission edge cases.

**Overall Assessment:** Architecturally strong. Specific targeted remediations needed before scaling.

| Area | Status |
|---|---|
| Multi-tenant isolation | ✅ Sound — company_id enforced at DB + application + KV layer |
| Double-entry integrity | ✅ Balance validation present at every stage |
| VAT period logic | ✅ All SA filing frequencies handled correctly |
| Transaction atomicity | ⚠️ HIGH RISK — no DB transactions used anywhere in JournalService |
| Report data truncation | ⚠️ HIGH RISK — silent `.in()` limit on Supabase for companies with >1000 journals |
| FK enforcement on journal_lines | ⚠️ MEDIUM RISK — `account_id` FK constraint was dropped |
| Auth permission passthrough | ⚠️ MEDIUM RISK — unknown permission names allow all access |
| Cloud storage compliance | ✅ `safeLocalStorage` bridge correctly routes accounting data to Supabase |
| SEAN AI safety | ✅ Trusted sources only; no auto-promotion; Super Admin gate enforced |
| Audit trail | ✅ Present and non-throwing |

---

## 2. SYSTEM STRUCTURE BREAKDOWN

### 2.1 Technology Stack

| Layer | Technology |
|---|---|
| Database | Supabase (PostgreSQL) — service-role key, RLS enabled on core tables |
| Backend | Node.js / Express — modular, mounted at `/api/accounting/*` within ECO server |
| Frontend | Vanilla HTML / JavaScript — 30 pages, no framework |
| Auth | JWT via ECO ecosystem `authenticateToken`, adapted by local auth bridge |
| Storage | `safeLocalStorage` → `/api/accounting/kv` → Supabase `accounting_kv_store` |
| AI Layer | SEAN — `backend/sean/` — bank learning, PDF import, OCR |
| POS Integration | Checkout Charlie → `pos-bridge.js` |

### 2.2 Backend Module Structure

```
backend/modules/accounting/
├── index.js              — module aggregator; applies companyStatus middleware to ALL routes
├── middleware/
│   ├── auth.js           — ECO JWT adapter + PERMISSIONS map + role bridge
│   └── companyStatus.js  — READ_ONLY / INACTIVE / SUSPENDED enforcement
├── services/
│   ├── journalService.js         — core double-entry engine
│   ├── vatPeriodUtils.js         — SA VAT period derivation (pure utility)
│   ├── vatReconciliationService.js
│   └── auditLogger.js
└── routes/
    accounts, journals, bank, reports, suppliers, customer-invoices,
    segments, vat-settings, vat-recon, paye/config, paye/reconciliation,
    ai, audit, company, employees, integrations, kv, pos-bridge
```

### 2.3 Database Schema Overview

Two schema files exist — this is the most important structural fact in the codebase:

| File | Tables Created | Notes |
|---|---|---|
| `database/schema.sql` | `journal_entries`, `journal_lines`, `bank_accounts`, `bank_transactions` + shared ecosystem tables | Legacy shared schema. Has RLS policies. |
| `database/012_accounting_schema.sql` | `journals`, `accounts`, `bank_accounts` (duplicate), `vat_*`, `paye_*`, `suppliers`, `customer_invoices`, `accounting_kv_store`, `accounting_audit_log`, + 20 more | Accounting module's own schema migration |

**Critical structural note:** The accounting module uses `journals` (012 schema). The shared schema has `journal_entries` (legacy). `journal_lines` exists in both schemas. The 012 migration originally set up `journal_lines` FKs pointing to `journal_entries` and `chart_of_accounts` (legacy shared tables) — both FK constraints were explicitly `DROP CONSTRAINT`-ed in the 012 migration to allow the accounting module to operate. This means `journal_lines` has no live FK enforcement on `journal_id` or `account_id`.

**Full 012 table inventory (26+ tables):**

| Group | Tables |
|---|---|
| COA | `accounts`, `coa_templates`, `coa_template_accounts`, `company_template_assignments`, `coa_segments`, `coa_segment_values` |
| Journals | `journals`, `journal_lines` |
| Bank | `bank_accounts`, `bank_transactions`, `bank_transaction_attachments` |
| VAT | `vat_periods`, `vat_reconciliations`, `vat_reconciliation_lines`, `vat_submissions`, `vat_reports` |
| PAYE | `paye_config_income_types`, `paye_config_deduction_types`, `paye_reconciliations`, `paye_employee_lines`, `paye_employee_income_lines`, `paye_employee_deduction_lines` |
| AP | `suppliers`, `supplier_invoices`, `supplier_invoice_lines`, `purchase_orders`, `purchase_order_lines`, `supplier_payments`, `supplier_payment_allocations` |
| AR | `customer_invoices`, `customer_invoice_lines`, `customer_payments`, `customer_payment_allocations` |
| General | `accounting_periods`, `accounting_audit_log`, `accounting_kv_store`, `pos_reconciliations` |

**COA template:** 76-account SA Standard Base seeded. Always requires `company_id` — no shared/global template records in company data tables.

---

## 3. DATA FLOW ANALYSIS

### 3.1 Journal Creation Flow

```
Frontend form
  → POST /api/accounting/journals
    → authenticate (JWT validation + role bridge)
    → hasPermission('create_journal')
    → companyStatus check (READ_ONLY blocks this)
    → JournalService.createDraftJournal()
        → validateLines() — min 2 lines, no simultaneous debit+credit, no zeros
        → validateBalance() — |totalDebits - totalCredits| ≤ 0.01
        → period lock check (accounting_periods table)
        → INSERT into journals (header)        ← STEP 1 (non-atomic)
        → INSERT into journal_lines (bulk)     ← STEP 2 (non-atomic)
    → auditLogger.logUserAction()
    → 201 response
```

### 3.2 Journal Post Flow

```
POST /api/accounting/journals/:id/post
  → authenticate + hasPermission('post_journal')
  → JournalService.postJournal()
      → status guard (draft only)
      → validateBalance() re-run
      → UPDATE journals SET status='posted'
      → assignVatPeriod() called async (NON-BLOCKING — can fail silently)
          → isVatJournal() check
          → derivePeriodForDate() → period key
          → find or create vat_period
          → UPDATE journal SET vat_period_id, is_out_of_period
  → auditLogger
  → 200 response
```

### 3.3 Bank Allocation Flow

```
Bank transaction selected for allocation
  → PUT /api/accounting/bank/transactions/:id/allocate
    → resolve account IDs
    → JournalService.createDraftJournal() → postJournal() (immediate post)
    → UPDATE bank_transactions SET is_reconciled, allocated_journal_id
    → bankLearning.recordBankAllocationEvent()   ← SEAN learning trigger
    → safeLocalStorage.setItem('bank_allocations', ...) ← KV bridge
```

### 3.4 Cloud Storage Flow

```
Frontend: safeLocalStorage.setItem(key, value)
  → ledger.js intercepts
  → isLocalKey(key)? → native localStorage (auth/session tokens only)
  → else → PUT /api/accounting/kv { key, value }
              → authenticate + requireCompany
              → UPSERT accounting_kv_store (company_id, key, value)
              → 200
```

### 3.5 PDF Statement Import Flow

```
Upload PDF
  → POST /api/accounting/bank/import-pdf
    → multer memory storage (20MB limit, PDF-only)
    → PdfStatementImportService.importStatement()
        → extract text (pdfjs-dist)
        → detect bank format
        → parse transactions
        → validate (min 100 chars text, min 20 words)
        → deduplicate
        → return for preview (NO DB write)
  → Frontend: user reviews + confirms
  → importedTransactions saved via safeLocalStorage → KV
```

---

## 4. ACCOUNTING LOGIC ANALYSIS

### 4.1 Double-Entry Enforcement

**`validateBalance()`:** Compares `sum(debit_amount)` vs `sum(credit_amount)`. Tolerance is 0.01 ZAR. Runs on `createDraftJournal`, `updateDraftJournal`, and again inside `postJournal`. The double-validation on post is correct — it catches any mutation between draft and post.

**`validateLines()`:** Enforces:
- Minimum 2 lines (no single-sided entries)
- No line with both `debit_amount > 0` AND `credit_amount > 0`
- No purely zero lines

**Reversal logic:** `reverseJournal()` creates a mirror journal with debits↔credits swapped. Links via `reversal_of_journal_id`. Requires explicit `reason` field. The original journal's status stays `'posted'` — it is NOT changed to `'reversed'`. Reversal identification downstream relies entirely on the `reversal_of_journal_id` FK. This should be confirmed against report logic.

### 4.2 VAT Period Derivation

`vatPeriodUtils.js` is a pure, side-effect-free function. It correctly handles:

| Filing Frequency | Period Logic |
|---|---|
| Monthly | Period = month of transaction date |
| Bi-monthly (even cycle) | Feb / Apr / Jun / Aug / Oct / Dec |
| Bi-monthly (odd cycle) | Jan / Mar / May / Jul / Sep / Nov |
| Quarterly (SA March year-end) | Mar / Jun / Sep / Dec |
| Annually | Feb period end (SA tax year) |

The December→January year-boundary for odd-cycle bi-monthly is handled correctly.

**Out-of-period handling:** If a journal date falls in a locked VAT period, `assignVatPeriod()` routes the journal to the current open period and flags `is_out_of_period = true` + stores the original date in `out_of_period_original_date`. Correct SA VAT compliance behaviour.

### 4.3 Supplier Invoice Accounting

`calcLineVAT()` in `suppliers.js`:
- **VAT-inclusive mode:** `vatAmount = (lineTotal × vatRate) / (1 + vatRate)` — extract from gross
- **VAT-exclusive mode:** `vatAmount = lineTotal × vatRate` — add on top

Uses 4 decimal place intermediate precision, rounds to 2dp at output. Correct.

Auto-journal on supplier invoice post: Debit expense account → Credit Accounts Payable. Correct direction.

### 4.4 Report Calculation Logic

**`fetchAccountBalances()`** in `reports.js`:
1. Fetches posted journals within date range
2. Fetches all `journal_lines` for those journal IDs via `.in()`
3. Aggregates per `account_id` — separate debit/credit totals

**Balance Sheet:** BS accounts + `currentYearEarnings` (total P&L: income minus expenses) added to Equity. Correct GAAP behaviour.

**Profit & Loss sub-type routing:**
- Income: `operating_income`, `other_income`
- COGS: `cost_of_sales`
- Expenses: `operating_expense`, `depreciation_amort`, `finance_cost`

**General Ledger:** Calculates opening balance from all posted journals before `fromDate`, then shows running balance per line. Correct rolling-forward approach.

---

## 5. MULTI-TENANT SAFETY REVIEW

### 5.1 Database Level

All 26+ tables in `012_accounting_schema.sql` include `company_id` with a `NOT NULL` constraint and FK to `companies(id) ON DELETE CASCADE`. There is no table in the accounting schema that stores data without a company reference.

The `accounting_kv_store` table uses `PRIMARY KEY (company_id, key)` — database-level guarantee that no two companies can share a KV key. Strongest isolation pattern in the codebase.

### 5.2 Application Level

Every backend query includes `eq('company_id', companyId)`. Company ID is extracted from `req.company.id` (set by `authenticate` middleware from JWT). It is **never** taken from the request body.

`companyStatus.js` middleware is applied once at the module root (`index.js`) — applied to every route universally. There is no way to reach any accounting API without passing through company status enforcement.

### 5.3 Frontend Level

`storageKey()` in `bank.html` prefixes all KV keys with `{companyId}_`. Even if two companies are open in separate tabs in the same browser, their KV keys cannot collide.

`eco-api-interceptor.js` reads `selectedCompanyId` from localStorage and injects it as a request header on all API calls — correct company context flows to the backend on every request.

### 5.4 KV Route — Auth Inconsistency (Documented)

All other accounting routes use the local `auth.js` middleware (`authenticate`) with the full PERMISSIONS map. The `kv.js` route uses `authenticateToken` + `requireCompany` from the shared ECO middleware. Both resolve `companyId` correctly, but the KV route does not use the local role/permission map — it accepts any authenticated user with a valid company assignment. Acceptable for a KV preference store, but an architectural inconsistency worth tracking.

---

## 6. INTEGRATION REVIEW

### 6.1 External API Key Integration

- Keys generated as 32-byte cryptographically random hex
- Stored as SHA-256 hash only — plaintext never persisted in the database
- Key shown **once** on creation response — not retrievable after
- External auth: `X-Integration-Key` header → hash lookup → `req.integration` + `req.companyId`
- Security posture: correct

### 6.2 POS Bridge (Checkout Charlie)

- Reads from `sales` table (Checkout Charlie POS data)
- SA timezone handled in JavaScript via `saDateToUtcStart()` / `saDateToUtcEnd()` using hardcoded `+02:00` offset
- SA does not observe DST — UTC+2 hardcode is correct for ZAR — but this assumption is undocumented
- Creates `pos_reconciliations` with journals via `JournalService`

### 6.3 SEAN AI Integration

**Bank Learning (`bank-learning.js`):**
- Only learns from `import_source IN ('pdf', 'api')` — CSV and manual entries never used as training data
- Normalises descriptions (strips digits, dates, amounts, punctuation) before learning
- Confidence formula: `frequency (30%) + clientDiversity (70%)`
- Patterns require ≥2 client companies + ≥55% confidence before becoming a proposal
- No automatic promotion — Super Admin authorisation gate enforced
- Sound design.

**PDF Import (`pdf-statement-import-service.js`):**
- Pipeline: text extraction → bank format detection → parse → deduplicate → return for review
- Does NOT write to DB — user confirmation required before any import
- Minimum quality thresholds (100 chars text, 20 words) prevent low-quality imports

### 6.4 ECO Ecosystem Auth Bridge

`eco-api-interceptor.js` monkey-patches `window.fetch` and `XMLHttpRequest`. All `/api/*` calls are rewritten to `/api/accounting/*`. SSO token bridge reads `eco_user` from localStorage and re-shapes it to the expected Lorenco user shape. This is functional but fragile — if the ECO user shape changes, the accounting app's auth bridge will silently break without error at the intercept layer (token stays valid, but role/email fields may resolve incorrectly).

---

## 7. RISK ANALYSIS

### RISK 1 — No Database Transactions in JournalService
**Severity: HIGH**

**Location:** `backend/modules/accounting/services/journalService.js`

`createDraftJournal()` does two separate database operations:
1. `INSERT INTO journals` (header)
2. bulk `INSERT INTO journal_lines`

If step 1 succeeds and step 2 fails (network blip, constraint violation, timeout), the database is left with an orphaned journal header that has no lines. This journal would appear in lists, fail to load detail, and would not balance. The same applies to `reverseJournal()`.

**Data integrity corruption is possible, not hypothetical.**

---

### RISK 2 — Silent Report Truncation at >1000 Journals
**Severity: HIGH**

**Location:** `backend/modules/accounting/routes/reports.js` — `fetchAccountBalances()`

The function collects all `journal_ids` from a date range, then does `.in('journal_id', journalIds)` to fetch lines. Supabase's PostgREST `.in()` filter has a practical URL-length limit (approximately 1000 IDs). Companies with more than ~1000 journals per reporting period will have report data silently truncated — no error, no warning, just incorrect financial figures.

**This grows in severity as companies age and accumulate journals.**

---

### RISK 3 — journal_lines FK Constraints Dropped
**Severity: MEDIUM**

**Location:** `database/012_accounting_schema.sql`

The `journal_lines.journal_id` FK to `journal_entries` and `journal_lines.account_id` FK to `chart_of_accounts` were both explicitly `DROP CONSTRAINT`-ed in the 012 migration to break coupling to legacy shared-schema tables. As a result, invalid account IDs or orphaned journal references can be inserted without any DB-level rejection. Application-level validation is the only guard.

---

### RISK 4 — Unknown Permission Name Passthrough
**Severity: MEDIUM**

**Location:** `backend/modules/accounting/middleware/auth.js` — `hasPermission()`

When a route calls `hasPermission('some_permission_name')` and that name is not in the `PERMISSIONS` map (e.g. a typo), the middleware logs a warning but **calls `next()`** — allowing the request through regardless of the user's role.

A typo in any route's permission string silently grants access to all authenticated users regardless of their role. Silent security bypass vector.

---

### RISK 5 — VAT Period Assignment is Non-Blocking
**Severity: MEDIUM**

**Location:** `journalService.js` — `postJournal()`

`assignVatPeriod()` is called after the journal status is set to `'posted'`, and it is not awaited — it runs asynchronously. If it fails (Supabase unreachable, derivePeriodForDate throws, period creation fails), the journal remains posted with `vat_period_id = null`. VAT reconciliations will silently miss this journal.

**Compliance impact: posted journals with null VAT period will not appear in VAT reconciliation line items.**

---

### RISK 6 — File Uploads on Disk, Not Cloud
**Severity: MEDIUM**

**Location:** `bank.js` route — `backend/uploads/accounting/bank_attachments/`

Bank transaction attachments are stored on the server filesystem using multer disk storage. In a Zeabur containerised deployment, the filesystem is ephemeral. Server restarts or container replacements will destroy all uploaded attachment files. The database rows referencing those files will remain, creating broken attachment links.

**Data loss on redeploy is certain unless a persistent volume is mounted.**

---

### RISK 7 — Dual Schema / Table Name Ambiguity
**Severity: LOW-MEDIUM**

**Location:** `database/schema.sql` (legacy) vs `database/012_accounting_schema.sql` (accounting module)

The shared ecosystem schema contains `journal_entries`, `journal_lines`, `bank_accounts`, `bank_transactions`. The accounting module's 012 schema creates overlapping table names (`journals`, `journal_lines`, `bank_accounts`). If both migrations were applied to the same Supabase instance, `bank_accounts` exists twice (or conflicts). Likely handled by `CREATE TABLE IF NOT EXISTS`, but the dual-schema is architecturally unclean and a future maintenance hazard.

---

### RISK 8 — Raw localStorage Write in bank.html
**Severity: LOW**

**Location:** `frontend-accounting/bank.html` approximately line 1800

`localStorage.setItem('seanAIEnabled', 'true')` is a direct raw `localStorage` write — not routed through `safeLocalStorage`. The SEAN AI enabled/disabled preference is stored in the browser only — not in Supabase. The preference resets on new browser, new device, or cleared storage. Minor violation of the no-raw-localStorage standard. Not a financial integrity issue.

---

### RISK 9 — GLOBAL_ADMIN_EMAILS Hardcoded Fallback
**Severity: LOW**

**Location:** `backend/modules/accounting/middleware/auth.js`

If `process.env.ADMIN_EMAILS` is not set, two hardcoded email addresses become global admins and bypass all company status restrictions. If the env variable is omitted in a new deployment, the intended admins may not have bypass access, or the hardcoded defaults may remain unintentionally effective.

---

### RISK 10 — No Explicit Currency Handling
**Severity: LOW**

**Location:** All accounting tables

All monetary amounts are `NUMERIC(15,2)` with no `currency` column. System is de facto ZAR-only. No architectural barrier prevents multi-currency amounts being entered via the API integration layer, which would corrupt financials silently.

Valid for current business scope. Becomes critical if any client operates in multiple currencies.

---

## 8. PROTECTED AREAS — DO NOT BREAK

The following are confirmed-working, business-critical components. Nothing may change these without a full audit and explicit justification.

### 8.1 JournalService Validation Layer
`validateBalance()` and `validateLines()` in `journalService.js`. These are the only thing preventing unbalanced journals from being stored. Their tolerance (0.01), double-debit check, and minimum line count must never be weakened.

### 8.2 vatPeriodUtils.js — `derivePeriodForDate()`
Pure function. Correctly implements all 5 SA VAT filing frequencies including the December→January year-boundary for odd-cycle bi-monthly. Any change must pass exhaustive edge-case testing across all frequencies and boundary dates.

### 8.3 SEAN Trusted Source Filter
`bank-learning.js` filters learning to `['pdf', 'api']` only. Prevents bad manual data from poisoning learning patterns. Never expand this list without deliberate review.

### 8.4 accounting_kv_store PRIMARY KEY
`PRIMARY KEY (company_id, key)` is the DB-level tenant isolation guarantee for the cloud storage bridge. Never change this to a single-column key.

### 8.5 companyStatus Middleware Placement
`enforceCompanyStatus` is applied in `index.js` before any route is mounted — applies to every single accounting API call. Never move it inside individual routes.

### 8.6 Audit Logger Non-Throwing Pattern
`auditLogger.js` wraps all writes in `try/catch` and swallows errors. Intentional — audit failures must never interrupt main operations. Do not change this to throw.

### 8.7 ON DELETE CASCADE Chains
All accounting tables cascade delete on `company_id`. Allows a company to be fully removed from the ecosystem without orphaned accounting records. Never remove these cascade constraints.

### 8.8 PDF Import Non-Write Design
`PdfStatementImportService` returns parsed data for user review — it does not write to the database. This user-confirmation gate is a compliance and trust requirement. Never add auto-import bypass logic.

### 8.9 SEAN Global Propagation Gate
Per CLAUDE.md Rule B2/B6: Sean must never auto-propagate global patterns. The `≥2 companies + ≥55% confidence` threshold and the Super Admin authorisation requirement in `bank-learning.js` must not be removed or bypassed.

### 8.10 API Key Storage (Hash Only)
`integrations.js` stores SHA-256 hash only — never the plaintext key. No GET endpoint returns the key after creation. Never add a "retrieve key" endpoint.

---

*Audit completed: April 15, 2026. No code was modified during this audit. All findings are documented for planning purposes only. Await instruction before any remediation work begins.*
