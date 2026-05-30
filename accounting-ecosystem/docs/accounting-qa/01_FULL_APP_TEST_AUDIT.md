# LORENCO ACCOUNTING — FULL APP QA AUDIT
## Read-Only Test & Audit Report

> **Date:** May 2026
> **Auditor:** Claude (Principal Engineer / QA Lead)
> **Scope:** Full read-only audit of Lorenco Accounting app
> **Instruction:** DO NOT CODE. DO NOT CHANGE FILES. DO NOT FIX BUGS. DO NOT COMMIT. DO NOT PUSH.
> **Output:** Comprehensive audit with final verdict: "Would you trust Lorenco Accounting to handle a real client's books today?"

---

## FINAL VERDICT

> ### YES WITH CONDITIONS
>
> **Score: 75 / 100**
>
> Lorenco Accounting has strong accounting foundations. The journal engine is atomic, VAT is correctly assigned, period locking is real, and the bank reconciliation workflow has post-posting validation that rivals production-grade fintech tooling. The financial reports are GL-backed, report data labelling is honest, and the year-end close is atomic.
>
> **Four conditions must be met before running a real client's books:**
> 1. **FIX AC-01 (HIGH)** — `hasPermission()` silently passes unknown permissions. Must return 403.
> 2. **FIX AC-02 (HIGH)** — `DELETE /journals/:id` is non-atomic. Journal lines can be orphaned.
> 3. **FIX AC-03 (HIGH)** — `POST /customer-invoices/:id/post` has a post-GL-posting status gap. If the invoice status update fails, the journal is posted but the invoice stays `draft` and can be re-posted — creating a double GL entry.
> 4. **FIX BNK-01 (HIGH)** — `bank.html` writes `bank_manual_transactions` to `safeLocalStorage` KV bridge. This is business data in browser storage — Rule D violation.

---

## TABLE OF CONTENTS

1. [Audit Scope and Methodology](#1-audit-scope-and-methodology)
2. [Architecture Overview](#2-architecture-overview)
3. [Journal Engine Integrity](#3-journal-engine-integrity)
4. [VAT Compliance](#4-vat-compliance)
5. [Bank Reconciliation Workflow](#5-bank-reconciliation-workflow)
6. [Customer Invoices (Accounts Receivable)](#6-customer-invoices-accounts-receivable)
7. [Supplier Invoices (Accounts Payable)](#7-supplier-invoices-accounts-payable)
8. [Financial Reporting](#8-financial-reporting)
9. [Period Management and Year-End Close](#9-period-management-and-year-end-close)
10. [Authentication, Permissions, and Multi-Tenant Safety](#10-authentication-permissions-and-multi-tenant-safety)
11. [Browser Storage Audit (Rule D Gate)](#11-browser-storage-audit-rule-d-gate)
12. [Audit Trail and Logging](#12-audit-trail-and-logging)
13. [Deployment and Infrastructure Risks](#13-deployment-and-infrastructure-risks)
14. [Risk Register](#14-risk-register)
15. [Pass/Fail Assessment by Area](#15-passfail-assessment-by-area)
16. [Recommended Fix Order](#16-recommended-fix-order)

---

## 1. AUDIT SCOPE AND METHODOLOGY

### Files Read

**Backend — routes:**
- `accounting/index.js` — route aggregator, middleware chain
- `accounting/routes/accounts.js` — COA management
- `accounting/routes/journals.js` — journal CRUD, idempotency
- `accounting/routes/bank.js` — bank accounts, transactions, import, allocate, reconcile (2224 lines)
- `accounting/routes/bankStaging.js` — import staging review
- `accounting/routes/accounting-periods.js` — period locking
- `accounting/routes/yearEnd.js` — year-end close, opening balances
- `accounting/routes/vat-report.js` — VAT report endpoint
- `accounting/routes/vatRecon.js` — VAT reconciliation periods
- `accounting/routes/customer-invoices.js` — AR invoices (988 lines)
- `accounting/routes/suppliers.js` — AP invoices (partial)
- `accounting/routes/reports.js` — financial reports (1052 lines)

**Backend — services:**
- `accounting/services/journalService.js` — core journal engine (754 lines)
- `accounting/services/vatReportService.js` — VAT report generation
- `accounting/services/reportTruthBadge.js` — report data quality labelling
- `accounting/services/auditLogger.js` — audit logging
- `accounting/middleware/auth.js` — authentication, role mapping, permission model
- `accounting/middleware/companyStatus.js` — company status enforcement

**Infrastructure:**
- `backend/server.js` — route mounting, global middleware chain

**Frontend:**
- localStorage grep across all `frontend-accounting/*.html` files

### Methodology

1. Read files without modifying anything
2. Identify architectural patterns: atomicity, validation, auth, business rule correctness
3. Test edge case handling: what happens when things fail mid-operation
4. Check browser storage compliance against Rule D
5. Identify double-accounting risks, data integrity gaps, and security weaknesses
6. Document findings with severity ratings

---

## 2. ARCHITECTURE OVERVIEW

### Routing and Authentication Chain

```
ECO server.js
  → app.use('/api/accounting', authenticateToken, requireModule('accounting'), accountingRoutes)
       │
       ↓
  accounting/index.js
  → router.use(enforceCompanyStatus) — global to all accounting routes
  → router.use('/accounts',  accounts.js)      ← calls accounting authenticate + hasPermission per-route
  → router.use('/journals',  journals.js)       ← calls accounting authenticate + hasPermission per-route
  → router.use('/bank',      bank.js)           ← calls accounting authenticate + hasPermission per-route
  → router.use('/customer-invoices', customer-invoices.js)  ← uses ECO-level auth only (req.companyId)
  → router.use('/suppliers', suppliers.js)      ← uses ECO-level auth only (req.companyId)
  → router.use('/vat',       vat-report.js)     ← inline permission check via PERMISSIONS constant
  → router.use('/vat-recon', vatRecon.js)       ← calls authenticate + authorize per-route
```

**Key finding:** Two authentication models co-exist:
- ECO-level: `authenticateToken` (shared, sets `req.companyId`, `req.user`)
- Accounting-level: `authenticate` (accounting-specific, maps ECO roles to accounting roles, adds `hasPermission()`)

Most routes use accounting-level auth. `customer-invoices.js` and `suppliers.js` use ECO-level auth only (no accounting role mapping, no `hasPermission()`).

### Data Architecture

```
accounts               — Chart of Accounts (per company)
journals               — Journal header (draft/posted/reversed)
journal_lines          — Double-entry lines (FK → journals)
bank_accounts          — Bank account registry
bank_transactions      — Bank statement rows (unmatched/matched/reconciled)
bank_transaction_staging — Pre-review staging area (all imports go here first)
bank_recon_sessions    — Reconciliation sessions
bank_allocation_rules  — Auto-allocation rules
accounting_periods     — Period lock registry
year_end_close_records — Year-end close records
vat_periods            — VAT period rows
customer_invoices      — AR invoice headers
customer_invoice_lines — AR invoice line items
supplier_invoices      — AP invoice headers
supplier_invoice_lines — AP invoice line items
accounting_audit_log   — Full audit trail
```

### Database Client Strategy

| Usage | Client | Why |
|---|---|---|
| Journal writes (create, post, reverse) | pg Pool direct (`db.getClient()`) | Atomic BEGIN/COMMIT/ROLLBACK required |
| Year-end close | pg Pool direct | Atomic: journal + lines + close record |
| VAT report | pg Pool direct (`db.query()`) | Complex JOINs, PostgREST URL-length limits |
| Financial reports (balances) | pg Pool direct | Same URL-length issue with `.in()` |
| Most reads, simple writes | Supabase JS client | PostgREST filter API sufficient |

This is a **correct architectural decision**. Using pg Pool directly for multi-statement operations that must be atomic is the right call. Supabase JS client does not support multi-statement transactions.

---

## 3. JOURNAL ENGINE INTEGRITY

**Verdict: PASS**

### journalService.js — Atomic Design

All journal mutations use `db.getClient()` for a pg Pool connection with explicit BEGIN/COMMIT/ROLLBACK:

```
createDraftJournal()   → BEGIN → INSERT journals → INSERT journal_lines → COMMIT
updateDraftJournal()   → BEGIN → DELETE old lines → INSERT new lines → UPDATE header → COMMIT
postJournal()          → resolves VAT period BEFORE status update → UPDATE in one query
reverseJournal()       → BEGIN → INSERT reversal journal → INSERT reversal lines → UPDATE original → COMMIT
```

**VAT Assignment (C4 Fix — 2026-04-17):**
`_resolveVatPeriodForPost()` is called before the status update. The single `UPDATE journals SET status='posted', vat_period_id=X, ...` is one SQL statement — VAT is never in a gap state between 'draft' and 'posted'.

**Period Lock Guard:**
`isPeriodLocked()` is called at the start of `createDraftJournal`, `updateDraftJournal`, `postJournal`, and `reverseJournal`. If any date falls in a locked period, the operation is rejected with a clear error.

**`_assertAccountsPostable()`:**
Validates that every line's account_id has `is_postable=true` (i.e., not a parent/header account). This prevents posting to structural accounts that should only have GL children.

**Reversal:**
`reverseJournal()` creates a new journal with negated lines. The original journal is marked `status='reversed'`. No deletion. Safe journal lifecycle.

### Risk: `DELETE /journals/:id` is Non-Atomic

```js
// journals.js — two separate Supabase calls:
await supabase.from('journal_lines').delete().eq('journal_id', id);
await supabase.from('journals').delete().eq('id', id);
```

If the header delete fails after lines are deleted, the journal row remains with zero lines. This is an orphaned journal header — it would appear in lists but have no entries. Any report or balance calculation that reads this journal header without requiring lines would silently produce incorrect totals.

**Severity: HIGH — AC-02**

Mitigating factor: this only applies to `draft` journals. Posted journals cannot be deleted (the route checks `status !== 'draft'`). So GL integrity is preserved — only draft journals are at risk.

---

## 4. VAT COMPLIANCE

**Verdict: PASS WITH NOTES**

### VAT Math

Both customer-invoices and suppliers implement the same `calcLineVAT()` function:

```js
// VAT-inclusive mode (INC): extract VAT from gross
totalIncVat   = round(entered, 2)
subtotalExVat = round(entered / (1 + rate/100), 2)
vatAmount     = round(totalIncVat - subtotalExVat, 2)

// VAT-exclusive mode (EX): add VAT to base
subtotalExVat = round(entered, 2)
vatAmount     = round(entered * rate / 100, 2)
totalIncVat   = round(subtotalExVat + vatAmount, 2)
```

Both modes are correctly implemented. Standard SA VAT rate defaults to 15% when rate is null/undefined.

### VAT Account Lookup

Before any VAT-bearing journal post, the system requires:
- Account code `1400` (VAT Input) — for purchases
- Account code `2300` (VAT Output) — for sales

If either is missing, the operation is **hard-blocked** with a 422 error and a clear message. No silent fallback to posting gross without VAT split.

### VAT Period Assignment

Handled in `journalService._resolveVatPeriodForPost()`:
- Looks up `vat_periods` table for the journal date
- If no period row exists, attempts `_findOrCreateVatPeriod()` — upsert-style creation
- VAT period is assigned in the same `UPDATE` statement that changes status to 'posted'
- Out-of-period transactions increment `oop_count` on the current period

**The C4 fix (2026-04-17) is correctly implemented.** There is no window between 'draft' and 'posted' where a journal exists without VAT assignment.

### VAT Report Service

`vatReportService.js` uses `db.query()` (pg Pool direct) for the VAT report. Handles:
- Legacy period key format (YYYY.MM → YYYY-MM normalization)
- Fallback date range when no `vat_periods` row exists (uses first/last of month)

**Risk:** The fallback date range assumes VAT periods align with calendar month boundaries. If a company's VAT period starts on a non-1st day (e.g., 5th), the auto-fallback would use 1st–last instead of the correct dates. This would cause wrong transactions to be included/excluded. Low frequency but a real data accuracy risk.

**Severity: LOW — VAT-01**

---

## 5. BANK RECONCILIATION WORKFLOW

**Verdict: PASS WITH ONE HIGH VIOLATION**

### Import Staging — Correct Design

All bank imports (CSV, PDF, image OCR, manual) go through staging first:
1. `POST /api/bank/import` → `BankStagingService.stageTransactions()` → `bank_transaction_staging` table
2. Accountant reviews staged transactions in Bank Staging page
3. Accountant confirms → confirmed rows move to `bank_transactions`

No transaction goes directly from file to live reconciliation table without review.

**Additional integrity checks on import:**
- Row-level duplicate detection via `DuplicateDetectionService`
- File hash batch-level duplicate detection (warns if same file re-imported)
- Inter-account transfer detection on each new batch

### Bank Allocation — Post-Posting Validation

`POST /transactions/:id/allocate` implements an 8-point post-posting integrity check (`_validatePostedAllocationJournal()`):

1. Journal exists and has `status='posted'`
2. Journal `company_id` matches allocating company (tenant safety)
3. `metadata.bankTransactionId` matches the bank transaction ID
4. Journal has at least 2 lines
5. Total debits === total credits (within 0.01)
6. At least one line uses the bank ledger account
7. At least one line is NOT the bank ledger account (allocation line present)
8. Bank-side line gross amount matches the bank transaction amount (within 0.01)

If any check fails: auto-reversal is attempted, result is audit-logged, caller gets a clear error.

If the journal is posted but the `bank_transactions` status update fails: auto-reversal is attempted.

This is production-grade defensiveness. Very well designed.

### Bank Reconciliation — All-or-Nothing

`POST /reconcile` validates ALL requested transactions before writing ANY:
1. Transaction exists and belongs to this company
2. Status is `matched`
3. `matched_entity_id` is not null
4. Linked journal exists and has `status='posted'`

If ANY transaction fails: entire batch is rejected with validation errors. Nothing is written.

Session creation is done BEFORE transaction updates — if session creation fails, no transactions are reconciled.

### CRITICAL VIOLATION — `bank_manual_transactions` in KV

**`bank.html` lines 4892–4896:**

```js
var stored = JSON.parse(safeLocalStorage.getItem(storageKey('bank_manual_transactions')) || '[]');
// ...
safeLocalStorage.setItem(storageKey('bank_manual_transactions'), JSON.stringify(stored));
```

Bank transaction data is written to `safeLocalStorage` (which routes through the KV bridge to `payroll_kv_store_eco`). This is business data — bank transactions — in browser storage.

**Rule D violation (Rule D3):** KV-backed storage for business data is not compliant. KV is a schemaless, unstructured blob store with no relational integrity, no audit trail, and no query capability.

**Risk:** If the KV store is cleared or browser storage is corrupted, user loses staged manual transaction entries silently. These entries may never make it to the DB.

**Severity: HIGH — BNK-01**

### Also in bank.html: `sean_learning` in KV

```js
let seanLearning = JSON.parse(safeLocalStorage.getItem(storageKey('sean_learning')) || '{}');
safeLocalStorage.setItem(storageKey('sean_learning'), JSON.stringify(seanLearning));
```

SEAN bank learning data is in KV. This is pattern data, not financial transaction data. Moderate Rule D concern — learning data loss is recoverable from DB activity, not from KV.

**Severity: LOW — SEAN-01**

---

## 6. CUSTOMER INVOICES (ACCOUNTS RECEIVABLE)

**Verdict: CONDITIONALLY PASS — Two HIGH conditions**

### VAT Calculation

`calcLineVAT()` is correctly implemented for both inclusive and exclusive modes. Standard 15% VAT rate default. Line-level VAT rates supported. Header totals are summed from lines.

### Invoice Number Uniqueness

Duplicate guard checks the same invoice number within a company before creation:

```js
if (invoiceNumber && invoiceNumber.trim()) {
  const { data: dup } = await supabase.from('customer_invoices')
    .select('id').eq('company_id', companyId)
    .eq('invoice_number', invoiceNumber.trim())
    .not('status', 'in', '("void","cancelled")')
    .maybeSingle();
  if (dup) return res.status(409).json({ error: '...' });
}
```

Auto-generated invoice numbers (`INV-0001`) use `count + 1` — not atomic (race condition on concurrent creation). Low risk for typical use. Explicit invoice numbers are protected.

### CRITICAL RISK: Non-Atomic GL Posting with Status Gap

**`POST /customer-invoices/:id/post` lines 554–575:**

```js
// 1. Create and post journal (JournalService — atomic)
const glJournal = await JournalService.createDraftJournal({ ... });
await JournalService.postJournal(glJournal.id, companyId, userId(req));

// 2. Update invoice status — SEPARATE Supabase call
const { error: updErr } = await supabase
  .from('customer_invoices')
  .update({ status: 'sent', journal_id: glJournal.id })
  .eq('id', invoiceId);

if (updErr) {
  console.warn(`... posted to GL but status update failed ...`);
  // ← NO REVERSAL. No error response. Returns success to caller.
}
```

**The gap:**
- Journal is posted to GL (irreversible without explicit reversal)
- Invoice status update fails
- `console.warn` only — the response **still returns 200 OK with `journalId`**
- On the next call, invoice is still `draft`
- The user or client re-posts — a **second journal is created for the same invoice**
- Result: **double GL posting** for one invoice

This directly corrupts the Accounts Receivable balance.

**Severity: HIGH — AC-03**

### Invoice Creation Non-Atomic

`POST /` creates the invoice header in one Supabase call, then inserts lines in a second call:

```js
const { data: invoice } = await supabase.from('customer_invoices').insert({ ... });
const { error: linesErr } = await supabase.from('customer_invoice_lines').insert(lineInserts);
if (linesErr) throw new Error(linesErr.message);
```

If lines insert fails: invoice header exists with no lines. The invoice is stranded in `draft` with zero amounts but a header record. It would appear in lists, in `count + 1` auto-numbering, and in control account reconciliation as an orphaned record.

**Severity: MEDIUM — AC-04**

### No Accounting-Specific Permissions

`customer-invoices.js` uses `req.companyId` from ECO-level `authenticateToken`. It does not call the accounting-specific `authenticate` or `hasPermission`.

Consequence: any authenticated ECO user (regardless of their accounting role) can create, post, void, and delete customer invoices. A `viewer` role in accounting can post invoices to the GL.

The accounting roles (`admin`, `accountant`, `bookkeeper`, `viewer`) are only enforced by routes that explicitly call `hasPermission()` (bank.js, accounts.js, journals.js, etc.). `customer-invoices.js` bypasses this.

**Severity: MEDIUM — AUTH-01**

---

## 7. SUPPLIER INVOICES (ACCOUNTS PAYABLE)

**Verdict: SAME ISSUES AS AR — CONDITIONALLY PASS**

Suppliers module has:
- Same `calcLineVAT()` with correct INC/EX VAT math
- Aggregated line totals with `sumLines()`
- `invoiceStatus()` helper deriving paid/part-paid/unpaid from amount_paid vs total_inc_vat
- OCR invoice scanning via `InvoiceOcrService` (in-memory, no disk write)

Same structural risks as customer-invoices:
- No accounting-specific permissions (`hasPermission()` not called)
- Invoice header + lines creation not atomic (separate Supabase calls)

The GL posting logic for supplier invoices (AP) follows the same pattern:
- `DR Expense accounts / CR AP (2000) / DR VAT Input (1400)` journal pattern
- Same post-status-update gap risk exists in suppliers `POST /:id/post`

**Severity of supplier-side AC-03 equivalent: HIGH — AC-03S**

---

## 8. FINANCIAL REPORTING

**Verdict: PASS**

### Report Infrastructure

All financial reports use `db.query()` (pg Pool) for balance aggregation. This avoids PostgREST URL-length limits from large `.in()` arrays (fixed in a prior session). Reports include:

- **Trial Balance** — balance check: `|totalDebit - totalCredit| < 0.01`
- **Profit & Loss** — sub_type bucketing (operating_income, cost_of_sales, other_income, etc.); defaults to type-based bucket if no sub_type set
- **Balance Sheet** — P&L accounts queried separately for current year earnings; `totalEquity = equity + netIncome`
- **Cash Flow Statement** — manual/system journal filter
- **Division P&L** — per-segment side-by-side using `coa_segment_values`; includes `untagged` + `total` columns
- **Aged Debtors/Creditors** — AR/AP sub-ledger views
- **Control Account Reconciliation** — compares GL account 1100 (AR) balance against `customer_invoices` sub-ledger, and GL 2000 (AP) against `supplier_invoices`; surfaces orphan invoices and orphan payments

### `reportTruthBadge`

Every report response includes:

```js
reportTruth: getBadge(reportType, { journalSourceMode })
```

Three badge types:
- `posted_gl_only` — based only on posted journal entries (green)
- `mixed_gl_operational` — combines GL + operational data (amber)
- `diagnostic_reconciliation` — compares two independent sources (blue)

This is an honest labelling system. Reports do not claim false accuracy — they state their source type.

### `journalSourceMode` Filter

Reports accept `journalSourceMode=manual|system|all` to filter by journal origin. All reports pass this filter to `fetchAccountBalances()`. Consistent application.

### Risk: Division P&L Segment Queries

Division P&L fetches per-segment journal line data. If a company has many segments or many journal lines, this query could be slow without proper indexing. Not audited — but a MEDIUM performance risk at scale.

**Severity: LOW — RPT-01**

---

## 9. PERIOD MANAGEMENT AND YEAR-END CLOSE

**Verdict: PASS**

### Accounting Period Management

- **Overlap check** on creation — new period may not share any day with an existing period
- **Lock** requires `accountant` role or above (`requirePeriodManager`)
- **Unlock** requires `admin` role (`requireAdmin`) — higher bar for a destructive operation
- **Delete** requires `admin` role — blocked on locked periods
- **Check endpoint** — `GET /periods/check?date=YYYY-MM-DD` for frontend early warning before any write form
- **Every action is audit-logged**

Enforced at service level by `JournalService.isPeriodLocked()` — period locking cannot be bypassed by calling the journal routes directly.

### Risk: Draft Journals Not Checked Before Lock

`POST /periods/:id/lock` immediately sets `is_locked=true` without checking for existing draft journals dated within the period. If an accountant locks a period with unposted drafts:
- The drafts remain in `draft` status indefinitely
- They cannot be posted (period lock blocks it)
- They cannot be deleted automatically
- The accountant must manually clean up those drafts

No warning is given. This is a usability gap, not a data integrity issue.

**Severity: LOW — PERIOD-01**

### Year-End Close

`POST /year-end/close` — atomic pg transaction:
1. Guard: blocks duplicate close for same (company, fromDate, toDate) — 409
2. Requires retained earnings account (`equity, sub_type='retained_earnings'`) — 422 if missing
3. Fetches all posted P&L journal lines in year range
4. Builds closing lines: income DR, expense CR, net to retained earnings
5. Pre-write balance safety check (math guarantees balance but explicit check adds safety)
6. `BEGIN` → INSERT journal header (posted directly) + INSERT all lines + INSERT close record → `COMMIT`

**Correctly bypasses `JournalService.postJournal()`** — closing entries are not VAT events. Running them through `postJournal` would attempt VAT assignment and fail. The direct insert correctly marks status='posted' without triggering VAT period logic.

The closing journal balance check before the `BEGIN` block prevents a failed partial transaction. If the math is wrong, the error surfaces before any DB write.

---

## 10. AUTHENTICATION, PERMISSIONS, AND MULTI-TENANT SAFETY

**Verdict: MOSTLY PASS — One HIGH risk**

### Server-Level Authentication

All accounting routes are wrapped at `server.js` level:
```js
app.use('/api/accounting', authenticateToken, requireModule('accounting'), accountingRoutes)
```

`authenticateToken` (ECO shared middleware) runs before any accounting handler. It sets:
- `req.user` (ECO user shape: id, companyId, role)
- `req.companyId`
- `req.userId`

No accounting route can be reached without ECO authentication.

### Accounting-Level Authentication

Many routes additionally call the accounting-specific `authenticate()` (from `accounting/middleware/auth.js`), which:
1. Re-validates the JWT
2. Maps ECO roles to accounting roles via `mapRole()`
3. Checks `GLOBAL_ADMIN_EMAILS` from env var (no hardcoded emails)
4. Sets an accounting-specific `req.user` shape

### CRITICAL RISK: `hasPermission()` Silent Pass-Through for Unknown Permissions

**`accounting/middleware/auth.js` — `hasPermission()` function:**

```js
return (req, res, next) => {
  if (!PERMISSIONS[permission]) {
    console.warn(`[accounting] Unknown permission: ${permission}`);
    return next();  // ← SILENTLY PASSES
  }
  // ...
}
```

If a route calls `hasPermission('vat.submit')` (for example) but `'vat.submit'` is not defined in the `PERMISSIONS` map, the middleware silently allows access and logs a warning.

This means:
- Any typo in a `hasPermission()` call becomes a security bypass
- Any new permission string added to a route but not to `PERMISSIONS` is silently permissive
- The codebase cannot detect this misconfiguration at startup — only at runtime

**Required fix:** Unknown permissions must return `403 Forbidden`, not `next()`.

**Severity: HIGH — AC-01**

### Multi-Tenant Safety

Every route that writes data includes `company_id` scoping on both the SELECT (ownership check) and the UPDATE/DELETE (write guard):

```js
// Correct pattern — both read and write are scoped
.eq('company_id', req.user.companyId)  // on read to verify ownership
.eq('company_id', req.user.companyId)  // on write to prevent cross-tenant overwrite
```

This pattern is consistently applied in bank.js, journals.js, accounts.js, and accounting-periods.js.

`customer-invoices.js` and `suppliers.js` use `req.companyId` (ECO-level) throughout all queries. Since ECO `authenticateToken` enforces this, the tenant isolation is preserved even without accounting-specific auth.

### Role Mapping

`mapRole()` in accounting auth.js:
```
super_admin / admin / business_owner / practice_manager / administrator / partner → 'admin'
accountant / manager → 'accountant'
bookkeeper / cashier → 'bookkeeper'
employee / readonly / viewer → 'viewer'
```

`'admin'` in accounting is the highest role. Only `admin` can unlock/delete periods. `accountant` can lock periods and post journals. `bookkeeper` can create draft journals and allocate bank transactions.

---

## 11. BROWSER STORAGE AUDIT (RULE D GATE)

**Verdict: CONDITIONAL FAIL — One HIGH violation, two LOW violations**

### Summary of All localStorage / sessionStorage / safeLocalStorage Writes

| Location | Key / Type | Assessment |
|---|---|---|
| `bank.html:4896` | `safeLocalStorage.setItem(storageKey('bank_manual_transactions'), ...)` | **VIOLATION — business data (bank transactions) in KV** |
| `bank.html:4013` | `safeLocalStorage.setItem(storageKey('sean_learning'), ...)` | LOW — learning pattern data, recoverable |
| `bank.html:1855` | `safeLocalStorage.setItem('seanAIEnabled', 'true')` | PERMITTED — UI preference |
| `company.html:779` | `localStorage.setItem('activeCompanyId', companyId)` | BORDERLINE — UI context, not financial data |
| `company.html:1017` | `safeLocalStorage.setItem(storageKey, JSON.stringify(seanKnowledge))` | LOW — Sean knowledge blob, not financial transaction data |
| `company.html:1257` | `safeLocalStorage.setItem(storageKey, JSON.stringify(integrations))` | LOW — integration config |
| All pages | `localStorage.getItem('token')` | PERMITTED — auth token |
| `aged-creditors.html` | `localStorage.getItem('accounting_company_name')` | PERMITTED — display name only, not business data |

### HIGH Violation

**`bank.html` — `bank_manual_transactions` in KV (BNK-01)**

```js
// bank.html:4892-4896
var stored = JSON.parse(safeLocalStorage.getItem(storageKey('bank_manual_transactions')) || '[]');
// ... adds to stored ...
safeLocalStorage.setItem(storageKey('bank_manual_transactions'), JSON.stringify(stored));
```

This stores bank transaction data in the KV bridge. Bank transactions are financial records. Their loss causes reconciliation gaps and requires manual reconstruction.

**Rule D3:** `safeLocalStorage` backed by KV is not a compliant storage mechanism for business data.

**Fix:** Remove the KV buffering. Manual transactions entered in the UI should be submitted directly to `POST /api/bank/transactions` (which already exists and works). No pre-submission buffering in storage should be needed.

### Token and Auth Key Reads

All `localStorage.getItem('token')` and related token reads across accounting HTML pages are in pattern with ECO ecosystem auth — these are PERMITTED under Rule D2 (session/auth tokens).

---

## 12. AUDIT TRAIL AND LOGGING

**Verdict: PASS**

### AuditLogger Service

`accounting/services/auditLogger.js` writes to `accounting_audit_log` table with:
- `company_id` (tenant scoping)
- `actor_type`: `USER`, `AI`, or `SYSTEM`
- `actor_id`: user ID or AI action ID
- `action_type`: string (CREATE, UPDATE, DELETE, LOCK, UNLOCK, ALLOCATE, RECONCILE, etc.)
- `entity_type` + `entity_id`: what was affected
- `before_json` / `after_json`: before/after state snapshots
- `reason`: human-readable description
- `ip_address` + `user_agent`: request context

**Audit logging does not throw on failure** — it logs the error and continues. This is correct design: audit log failure should not break the main operation. However, it means audit records can silently go missing.

### Coverage Assessment

| Operation | Audit logged? |
|---|---|
| Journal create/post/reverse | ✅ |
| Bank account create/update | ✅ |
| Bank transaction allocate/unallocate | ✅ |
| Bank transaction reconcile | ✅ |
| Bank import staging | ✅ |
| Period create/lock/unlock/delete | ✅ |
| Year-end close | ✅ |
| Customer invoice create/post/void | ✅ |
| COA account create/update | ✅ |
| Bank rule accepted | ✅ (async, non-blocking) |
| Failed GL post validation | ✅ (SYSTEM action) |
| Bank linkage failure auto-reversal | ✅ (SYSTEM action with danglingJournal flag) |

The SYSTEM-type audit entries for auto-reversal events are particularly valuable — they allow post-incident investigation of what the system did automatically.

---

## 13. DEPLOYMENT AND INFRASTRUCTURE RISKS

**Verdict: MEDIUM RISK — One persistent storage gap**

### Bank Attachment Files on Local Disk

`bank.js` uses `multer.diskStorage()` with:
```js
const uploadDir = path.join(__dirname, '../../../uploads/accounting/bank_attachments');
```

Files are stored on the Docker container's local filesystem. On Zeabur:
- Every deployment redeploys the container
- The local filesystem is ephemeral — **all attached files are lost on redeploy**

Users who upload bank statement PDFs or supporting documents as attachments will lose those files on the next deployment.

**Note:** The PDF import parser uses `multer.memoryStorage()` (in-memory only) — PDF files for parsing are never written to disk. Only the attachment feature (linking files to bank transactions) uses disk storage.

**Severity: MEDIUM — DEPLOY-01**

**Fix:** Move `bank_transaction_attachments` file storage to Supabase Storage. DB records can remain; replace `file_path` disk storage with Supabase Storage bucket paths.

### Concurrent-Safe Auto-Numbering

Invoice auto-number (`INV-0001`) uses a `count + 1` approach without a database sequence or row lock. Two concurrent invoice creations could produce the same auto-number. The duplicate guard would catch one of them (409 error), but the user experience would be confusing.

**Severity: LOW — DEPLOY-02**

**Fix:** Use a PostgreSQL sequence or a `SELECT max(invoice_number) FOR UPDATE` pattern.

---

## 14. RISK REGISTER

| ID | Area | Description | Severity | Status |
|---|---|---|---|---|
| **AC-01** | Permissions | `hasPermission()` silently passes unknown permissions — security bypass via typo | **HIGH** | Open |
| **AC-02** | Journal integrity | `DELETE /journals/:id` non-atomic — orphaned journal_lines if header delete fails | **HIGH** | Open |
| **AC-03** | AR Invoices | Post-to-GL status update gap — journal posted but invoice stays draft; re-posting creates double GL entry | **HIGH** | Open |
| **AC-03S** | AP Invoices | Same post-to-GL status update gap as AC-03 exists in suppliers `POST /:id/post` | **HIGH** | Open |
| **BNK-01** | Browser storage | `bank_manual_transactions` in `safeLocalStorage` KV — bank transaction business data in browser storage (Rule D violation) | **HIGH** | Open |
| **AUTH-01** | Permissions | `customer-invoices.js` and `suppliers.js` have no accounting-specific `hasPermission()` checks — any authenticated ECO user can post invoices to GL | **MEDIUM** | Open |
| **AC-04** | AR Invoices | Invoice creation non-atomic — header inserted then lines in separate Supabase calls; header-only orphan on lines failure | **MEDIUM** | Open |
| **DEPLOY-01** | Infrastructure | Bank attachment files on local disk — lost on Zeabur container redeploy | **MEDIUM** | Open |
| **PERIOD-01** | Period lock | Locking a period with unposted draft journals gives no warning — drafts become permanently unpostable | **LOW** | Open |
| **VAT-01** | VAT reporting | VAT period date fallback uses 1st of month; wrong if company's actual period starts on non-1st | **LOW** | Open |
| **SEAN-01** | Browser storage | SEAN bank learning data in `safeLocalStorage` KV — learning patterns, not financial data; recoverable | **LOW** | Open |
| **RPT-01** | Reports | Division P&L segment queries could be slow at scale — no index audit performed | **LOW** | Open |
| **DEPLOY-02** | Infrastructure | Invoice auto-number uses `count + 1` — concurrent creation race condition | **LOW** | Open |

---

## 15. PASS/FAIL ASSESSMENT BY AREA

| Area | Result | Notes |
|---|---|---|
| Journal Engine Atomicity | ✅ PASS | pg Pool transactions for all journal writes |
| VAT Assignment | ✅ PASS | C4 fix — pre-status-update, single UPDATE statement |
| Double-Entry Balance Validation | ✅ PASS | Enforced in JournalService before any write |
| Period Locking | ✅ PASS | Service-level enforcement, ADMIN required for unlock |
| Year-End Close | ✅ PASS | Atomic pg transaction, retained earnings required |
| Bank Staging Pipeline | ✅ PASS | All imports staged before live reconciliation |
| Bank Allocation Integrity | ✅ PASS | 8-point post-posting validation |
| Bank Reconciliation Workflow | ✅ PASS | All-or-nothing, journal verification required |
| Financial Reports (GL integrity) | ✅ PASS | pg Pool direct SQL, control account reconciliation |
| Report Data Labelling | ✅ PASS | reportTruthBadge on every response |
| Multi-Tenant Isolation | ✅ PASS | All routes scope by companyId on read and write |
| Audit Logging Coverage | ✅ PASS | USER/AI/SYSTEM types, before/after state, full coverage |
| VAT Account Validation | ✅ PASS | Hard-blocks VAT allocations if account missing |
| `hasPermission()` Security | ❌ FAIL | Unknown permissions silently pass (AC-01) |
| `DELETE /journals/:id` | ❌ FAIL | Non-atomic — line orphan risk (AC-02) |
| AR/AP Invoice GL Posting | ❌ FAIL | Post-GL status gap — double-posting risk (AC-03/AC-03S) |
| Browser Storage Compliance | ❌ FAIL | `bank_manual_transactions` in KV (BNK-01) |
| AR/AP Permissions | ⚠️ PARTIAL | No `hasPermission()` on invoices routes (AUTH-01) |
| Invoice Creation Atomicity | ⚠️ PARTIAL | Header + lines in separate Supabase calls (AC-04) |
| Bank Attachments | ⚠️ PARTIAL | Local disk — lost on container redeploy (DEPLOY-01) |

---

## 16. RECOMMENDED FIX ORDER

### Priority 1 — Fix Before Any Real Client Data

| # | Fix | File | Why |
|---|---|---|---|
| 1 | **AC-01** — `hasPermission()` unknown → 403 | `accounting/middleware/auth.js` | Any permission typo is a security bypass |
| 2 | **AC-02** — Wrap `DELETE /journals/:id` in pg transaction | `accounting/routes/journals.js` | Draft journal can corrupt on partial delete |
| 3 | **AC-03** — Add journal reversal on invoice status update failure | `accounting/routes/customer-invoices.js` | Double GL entry possible today |
| 4 | **AC-03S** — Same fix for supplier invoice posting | `accounting/routes/suppliers.js` | Same double GL entry risk |
| 5 | **BNK-01** — Remove `bank_manual_transactions` from KV | `accounting/frontend-accounting/bank.html` | Business data in browser storage |

### Priority 2 — Fix Before Sustained Use

| # | Fix | File | Why |
|---|---|---|---|
| 6 | **AUTH-01** — Add `authenticate + hasPermission` to invoices routes | `customer-invoices.js`, `suppliers.js` | Any authenticated user can post invoices to GL |
| 7 | **AC-04** — Make invoice creation atomic | `customer-invoices.js`, `suppliers.js` | Header-only orphan on lines failure |
| 8 | **DEPLOY-01** — Move attachments to Supabase Storage | `bank.js` | Files lost on redeploy |

### Priority 3 — Monitor / Low Priority

| # | Fix | Why |
|---|---|---|
| 9 | **PERIOD-01** — Warn on lock with draft journals | UX improvement, not data integrity |
| 10 | **DEPLOY-02** — DB sequence for invoice numbers | Prevents rare concurrent race |
| 11 | **VAT-01** — Fallback date range warning | Edge case for non-calendar VAT periods |
| 12 | **SEAN-01** — Move sean_learning to SQL | Rule D D3 migration path |

---

## APPENDIX: WHAT WAS NOT AUDITED

The following areas were noted but not fully audited in this session:

- `bankStaging.js` / `BankStagingService.js` — full staging review workflow (read partially)
- `bankRules.js` / auto-allocation rule evaluation — rule matching logic
- `diagnostics.js` / `diagnosticsService.js` — repair and diagnostic tooling
- `historicalComparatives.js` / `historicalComparativesService.js` — comparative period engine
- `openingBalances.js` — opening balance import workflow (the route was read; the service was not)
- `payeConfig.js` / `payeReconciliation.js` — PAYE config and reconciliation
- `integrations.js` — external integrations API
- `ai.js` — AI assistant endpoints
- `segments.js` — segment/division management
- All `frontend-accounting/*.html` pages (individual JS logic, not just localStorage grep)

---

*This audit was performed read-only. No files were modified. No migrations were run. No commits were made.*
*Report location: `accounting-ecosystem/docs/accounting-qa/01_FULL_APP_TEST_AUDIT.md`*
