# BANK → TRIAL BALANCE → BANK RECONCILIATION — FORENSIC AUDIT
**Accounting Ecosystem — Lorenco**  
**Audit Date:** 2026-05-28  
**Scope:** Bank import, staging, allocation/posting, Trial Balance, Bank Balance, Bank Reconciliation, VAT, Reporting Integrity  
**Audit Type:** AUDIT ONLY — No code changes permitted under this document  
**Status:** Complete

---

## IMPLEMENTATION RECORD — 2026-05-24

The following workstreams from Section 14 were implemented as part of the Bank Recon Sessions CODEBOX:

| Priority | Workstream | Gaps Fixed | Files Changed |
|---|---|---|---|
| P1 | Persist statement closing balance — `bank_recon_sessions` table + extended `POST /api/bank/reconcile` | R1, R4, G1, G2 | `047_bank_recon_sessions.sql`, `bank.js` |
| P2 | Formalise allocation columns in numbered SQL migration | R3, G3 | `047_bank_recon_sessions.sql` |
| P3 | Add "Unallocated Bank Transactions" report endpoint | G5 | `reports.js` |
| P5 | Add Bank Reconciliation History endpoints | G3 (partial), R4 | `reports.js` |
| P6 | Add "Needs Allocation" filter + badge in bank-reconciliation.html | G6 | `bank-reconciliation.html` |

### What was implemented

**`database/migrations/047_bank_recon_sessions.sql`:**
- Part A: Formalises `allocated_account_id`, `allocation_type`, `allocated_account_name`, `vat_setting_id` on `bank_transactions` with `ADD COLUMN IF NOT EXISTS` (safe on production — columns already exist via auto-migration)
- Part B: Creates `bank_recon_sessions` table — one row per completed reconciliation session with `statement_date`, `statement_closing_balance`, `cleared_balance`, `difference`, `transaction_count`, `created_by`
- Part C: Adds `recon_session_id FK` on `bank_transactions` — links each reconciled transaction back to its session; NULL for transactions reconciled before migration

**`POST /api/bank/reconcile` extended (bank.js):**
- Now accepts `bankAccountId`, `statementDate`, `statementClosingBalance`, `clearedBalance` in addition to `transactionIds`
- When all four optional fields are present, creates a `bank_recon_sessions` row BEFORE updating transactions (if session creation fails, nothing is reconciled)
- Sets `recon_session_id` on each reconciled transaction
- Backward compatible — if optional fields are omitted, behaviour is identical to previous version
- Returns `sessionId` in the response

**`GET /api/reports/unallocated-bank-transactions` (reports.js):**
- Lists `bank_transactions WHERE status = 'unmatched'` — confirmed but not yet allocated
- Optional filters: `bankAccountId`, `dateFrom`, `dateTo`
- Returns `{ transactions, count, totalAmount, filters }`
- Does NOT query journal_lines — TB source logic is completely unaffected

**`GET /api/reports/bank-recon-history` (reports.js):**
- Lists all `bank_recon_sessions` for the company with bank account and user details
- Optional filter: `bankAccountId`

**`GET /api/reports/bank-recon-history/:sessionId` (reports.js):**
- Returns one session + all linked `bank_transactions` for that session

**`bank-reconciliation.html`:**
- `finishReconciliation()` now sends full payload: `bankAccountId`, `statementDate`, `statementClosingBalance`, `clearedBalance` (computes clearedBal from bookOpening + sum of checked items)
- `loadTransactions()` now fetches unmatched (unallocated) transactions in parallel with matched and reconciled
- `renderTransactions()` shows unmatched transactions with disabled checkbox and red "Requires allocation first" badge
- New filter button "Needs Allocation" — filters to `status=unmatched` rows
- Summary panel "Pending Items" now shows unmatched count in parentheses when non-zero

### What was NOT changed
Per CODEBOX strict scope — these are confirmed unchanged:
- Bank import flow (staging, BankStagingService, DuplicateDetectionService, TransferDetection)
- Staging confirmation flow (regular and transfer)
- Duplicate detection
- Transfer detection
- Allocation journal creation (JournalService, 8-check post-posting guard)
- VAT split logic
- JournalService internals
- Trial Balance source logic (reads only from posted journal_lines)
- GL report source logic
- Opening balances
- Historical comparatives
- All-or-nothing reconciliation invariant preserved

### Migration instructions
Run `database/migrations/047_bank_recon_sessions.sql` against the Supabase production database. All `ADD COLUMN IF NOT EXISTS` statements are safe on the existing production schema.

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [Current Bank Import Flow](#2-current-bank-import-flow)
3. [Current Staging vs Live Bank Transaction Flow](#3-current-staging-vs-live-bank-transaction-flow)
4. [Current Allocation / Posting Flow](#4-current-allocation--posting-flow)
5. [Current Trial Balance Behaviour](#5-current-trial-balance-behaviour)
6. [Current Bank Balance Behaviour](#6-current-bank-balance-behaviour)
7. [Current Bank Reconciliation Behaviour](#7-current-bank-reconciliation-behaviour)
8. [VAT Impact](#8-vat-impact)
9. [Reporting Impact](#9-reporting-impact)
10. [What Is Accounting-Correct](#10-what-is-accounting-correct)
11. [What Is Currently Working And Must Be Protected](#11-what-is-currently-working-and-must-be-protected)
12. [Confirmed Risks](#12-confirmed-risks)
13. [Recommended Safe Architecture](#13-recommended-safe-architecture)
14. [Recommended Next Workstreams](#14-recommended-next-workstreams)
15. [Questions For Ruan Before Any Code Changes](#15-questions-for-ruan-before-any-code-changes)

---

## 1. EXECUTIVE SUMMARY

The bank import → Trial Balance → Bank Reconciliation flow is **architecturally sound** at its core. The critical accounting invariants are correctly implemented:

- The Trial Balance is exclusively derived from **posted journal_lines** — unallocated bank transactions do not (and should not) appear in the TB, and this is correct accounting behaviour.
- Allocation creates a proper double-entry posted journal immediately — there is no deferred posting.
- Reconciliation requires allocation first and verifies a posted journal exists — this is correct and safe.
- The staging pipeline cleanly separates import from confirmation, preventing any GL impact at import time.
- Multi-tenant isolation is consistently enforced via `company_id` on all queries.

However, **six significant gaps** were identified that affect reconciliation auditability and operational completeness:

| # | Gap | Severity |
|---|---|---|
| G1 | No persisted statement closing balance — the user-entered balance on the reconciliation screen is never saved to the DB | HIGH |
| G2 | No `bank_recon_sessions` table — no audit trail of which period was reconciled, by whom, to what balance, on what date | HIGH |
| G3 | Allocation columns on `bank_transactions` (`allocation_type`, `allocated_account_name`, `vat_setting_id`) are only tracked in the server auto-migration (`accounting-schema.js`), not in the SQL migration files — schema drift risk | MEDIUM |
| G4 | Bank Recon Report uses the last imported `bank_transactions.balance` (running balance from statement) as the statement closing balance proxy — if the imported file had no balance column this falls back to the account opening balance, which will be wrong | MEDIUM |
| G5 | No "Imported Bank Movement" report — no view shows: total imported by period, allocated total, unallocated total, to allow management review of the completeness of the allocation process | MEDIUM |
| G6 | The Bank Recon screen only allows ticking `matched` (allocated) transactions — unmatched transactions appear in the list but cannot be ticked, meaning the reconciliation cannot balance if there are any unallocated transactions | LOW (by design, but must be communicated clearly) |

**Nothing in this audit requires emergency action.** The production system is functioning correctly within its current design. All gaps above are improvements to completeness and auditability, not fixes to broken functionality.

---

## 2. CURRENT BANK IMPORT FLOW

### Entry Points

All imports enter through the **Bank API routes** (`backend/modules/accounting/routes/bank.js`):

| Endpoint | Source | Parsing Service |
|---|---|---|
| `POST /api/bank/import-pdf` | PDF bank statement upload | `PdfStatementImportService` |
| `POST /api/bank/import-image` | Image/photo of statement (OCR) | `ImageStatementImportService` |
| `POST /api/bank/import` | CSV or manual entry | Direct parse in route |

### Critical Rule: No Direct GL Insertion at Import Time

**ALL import paths funnel through `BankStagingService.stageTransactions()` before anything is persisted.**

No bank transaction is written directly to `bank_transactions` (the live GL-linked table) at import time. 100% of imports land in `bank_transaction_staging` first.

### Duplicate Detection at Import Time

`DuplicateDetectionService` runs at staging time with two layers:

**Layer 1 — File-level batch dedup (SHA-256 hash):**
- `computeFileHash(buffer)` produces a SHA-256 hash of the imported file
- If the same file hash already exists in `bank_transaction_staging`, the entire batch is rejected as a duplicate

**Layer 2 — Transaction-level fuzzy dedup:**
- For each transaction in the batch: checks `bank_transaction_staging` (non-REJECTED rows) AND `bank_transactions` for a row with matching `external_id` (hard skip) OR amount ± 0.01 + date ± 1 day (soft flag → `duplicate_status = POSSIBLE_DUPLICATE`, staging status → `DUPLICATE_SUSPECTED`)
- Soft duplicates are flagged and shown to the user for review — they are not automatically rejected

### Transfer Detection at Import Time

`BankStagingService.detectTransfers()` runs after staging if `runDetection=true`:
- **Layer 1:** Keyword match in description (e.g., "transfer", "payment to", "received from") → `detected_type = TRANSFER`
- **Layer 2:** Exact amount match between two staging rows in opposite directions → high confidence link
- **Layer 3:** Fuzzy amount match (± small tolerance) + date proximity → lower confidence link
- Creates `bank_transfer_links` row with `confidence` score and `detection_layer`
- Updates both staging rows: `match_status = TRANSFER_DETECTED`, `transfer_pair_staging_id` = counterpart

### What Is Stored in Staging

```
bank_transaction_staging:
  id, company_id, bank_account_id, date, description, amount, reference,
  external_id (stable hash from parser — dedup key),
  balance (running balance from statement — informational only),
  detected_type, match_status, confidence_score, transfer_pair_staging_id,
  import_batch_id (UUID shared across all rows in one upload),
  import_source (pdf | image | csv | manual | api),
  confirmed_txn_id (set after confirmation — links back to bank_transactions)
```

### GL Impact at Import Time

**ZERO.** Staging rows have no connection to journals, journal_lines, or the accounts table. The GL is completely unaffected.

---

## 3. CURRENT STAGING VS LIVE BANK TRANSACTION FLOW

### Staging Pipeline States

`match_status` on `bank_transaction_staging` controls the workflow state:

| Status | Meaning | GL Impact |
|---|---|---|
| `UNMATCHED` | Freshly imported, not yet reviewed | None |
| `TRANSFER_DETECTED` | System found a probable counterpart | None |
| `REVIEW_REQUIRED` | Ambiguous — user must decide | None |
| `DUPLICATE_SUSPECTED` | Amount+date matches an existing row | None |
| `CONFIRMED` | Moved to bank_transactions | None (regular confirm) or YES (transfer confirm) |
| `REJECTED` | User dismissed — will not import | None |

### Path A: Regular Confirmation (No GL Impact)

**Endpoint:** `POST /api/accounting/bank/staging/confirm` → `BankStagingService.confirmStaged()`

1. Inserts confirmed rows into `bank_transactions` with `status = 'unmatched'`
2. Sets staging row `match_status = 'CONFIRMED'`, `confirmed_txn_id = new bank_transaction id`
3. **GL is NOT affected. No journal is created.**
4. The transaction sits in `bank_transactions` with `status = 'unmatched'` until the accountant allocates it

### Path B: Transfer Confirmation (GL IS Affected)

**Endpoint:** `POST /api/accounting/bank/staging/transfers/:linkId/confirm` → `BankStagingService.confirmTransfer()`

1. Validates both staging rows belong to this company
2. Creates a Dr/Cr journal via `JournalService` (Dr receiving bank account, Cr sending bank account)
3. Posts the journal immediately (`status = 'posted'`)
4. Moves BOTH staging rows to `bank_transactions` with `status = 'matched'`
5. Records `journal_id` on the `bank_transfer_links` row for audit trail
6. **GL IS affected: the transfer journal appears in journal_lines with status='posted'**

### Transfer Reversal Path

**Endpoint:** `POST /api/accounting/bank/staging/transfers/:linkId/reverse`

1. Reverses the posted transfer journal via `JournalService`
2. Deletes both `bank_transactions` rows
3. Resets both staging rows to `match_status = 'UNMATCHED'`
4. The transaction is back to the start of the workflow

### Key Invariant

> A transaction that has NOT gone through Path A or Path B does not exist in `bank_transactions`. It only exists in staging. The TB cannot see it at all. This is correct.

---

## 4. CURRENT ALLOCATION / POSTING FLOW

### The Allocation Endpoint

**Route:** `POST /api/bank/transactions/:id/allocate`  
**Permission required:** `bank.allocate`  
**Pre-condition:** Transaction must have `status = 'unmatched'` in `bank_transactions`

### Allocation Input Parameters

```json
{
  "lines": [
    {
      "accountId": 42,           // accounts.id — the COA account to debit/credit
      "amount": 1000.00,         // ex-VAT amount for this line
      "description": "Office supplies",
      "vatSettingId": 3          // optional — triggers VAT split
    }
  ],
  "description": "Allocation description",
  "reference": "INV-001"
}
```

Multiple lines are supported (split allocations across multiple accounts). Each line can have its own VAT setting.

### Journal Construction (What Actually Happens)

The allocation route constructs a double-entry journal:

**For a debit transaction (money IN — positive amount on bank_transactions):**
```
Dr Bank Ledger Account (bank_account.ledger_account_id)  +amount
Cr Allocation Account (lines[n].accountId)               -amount (ex-VAT per line)
[Cr VAT Output Account (2300)]                           -vatAmount (if VAT applies)
```

**For a credit transaction (money OUT — negative amount on bank_transactions):**
```
Cr Bank Ledger Account (bank_account.ledger_account_id)  -amount
Dr Allocation Account (lines[n].accountId)               +amount (ex-VAT per line)
[Dr VAT Input Account (1400)]                            +vatAmount (if VAT applies)
```

The journal is created via `JournalService.createJournal()` then immediately posted via `JournalService.postJournal()`. There is no draft state that persists — it is draft → posted in the same request.

### Post-Posting Safety Validation

`_validatePostedAllocationJournal()` runs after posting. This is a hard safety guard with 8 checks:

1. Journal exists in the DB
2. Journal belongs to this company
3. Journal has `status = 'posted'`
4. Journal `metadata.bankTransactionId` matches the bank transaction ID
5. Journal lines are balanced (sum of all debits = sum of all credits, tolerance < 0.01)
6. At least one line references the bank account's ledger account
7. At least one line references one of the allocation accounts
8. The bank-side line amount matches the bank transaction amount

If any of these checks fail: the journal is automatically reversed, and the bank transaction remains `status = 'unmatched'`. The endpoint returns an error. No partial state persists.

### On Successful Allocation

`bank_transactions` row is updated:
```sql
status               = 'matched'
matched_entity_type  = 'JOURNAL'
matched_entity_id    = journal.id
matched_by_user_id   = req.user.id
allocated_account_id = lines[0].accountId  (first line's account)
allocation_type      = lines[0].type       (or null)
allocated_account_name = lines[0].accountName
vat_setting_id       = lines[0].vatSettingId (or null)
```

### SEAN Learning Event (Async, Non-Blocking)

If `import_source IN ('pdf', 'api')`, a `sean_bank_learning_events` row is inserted asynchronously. This is fire-and-forget — failure does not roll back the allocation.

### Unallocate Path

**Route:** `DELETE /api/bank/transactions/:id/allocate`

1. Fetches the bank transaction, verifies status is `matched` or `reconciled`
2. If `reconciled`: sets back to `matched` first (unreconcile), then unallocates
3. Reverses the linked journal via `JournalService.reverseJournal()`
4. Resets `bank_transactions` to `status = 'unmatched'`, clears all allocation fields

---

## 5. CURRENT TRIAL BALANCE BEHAVIOUR

### How the TB is Built

**Route:** `GET /api/reports/trial-balance`  
**Core function:** `fetchAccountBalances(companyId, dateFrom, dateTo, options)`

The TB reads exclusively from:

```sql
SELECT
  a.id, a.account_code, a.account_name, a.account_type, a.account_subtype,
  jl.debit, jl.credit, jl.description,
  j.date, j.status, j.id AS journal_id
FROM accounts a
JOIN journal_lines jl ON jl.account_id = a.id
JOIN journals j ON j.id = jl.journal_id
WHERE a.company_id = $1
  AND j.status = 'posted'          -- ← ONLY POSTED JOURNALS
  AND j.company_id = $1
  [AND j.date >= $dateFrom]
  [AND j.date <= $dateTo]
ORDER BY a.account_code, j.date
```

The TB aggregates by account: for each account, sums all debit and credit lines from posted journals in the period. Returns: `account_code`, `account_name`, `account_type`, `total_debit`, `total_credit`, `net` (debit - credit).

### What the TB Does NOT Include

The TB does **not** query `bank_transactions` at all. It does not include:

- Transactions imported but not yet confirmed (staging rows)
- Transactions confirmed but not yet allocated (`status = 'unmatched'`)
- Transactions with draft journal (not possible by design — journals are posted immediately on allocation)

**This is correct accounting behaviour.** The TB is the General Ledger report. Only entries that have been formally journalised and posted belong in the GL.

### The "Missing Transactions" Misconception

If an accountant imports 50 bank transactions and allocates 30, the TB will show the 30 allocated ones. The other 20 (status = 'unmatched') are not missing from the TB — they simply have not yet been journalised. They belong in a separate "Unallocated Bank Transactions" view, not in the TB. The TB is correct.

### Opening Balance Integration

Opening balances (migration 046) are imported as posted journals via `JournalService`. Once posted, they appear in the TB identically to any other posted journal line. The TB is opening-balance-aware automatically.

### Historical Comparatives

The TB supports `dateFrom`/`dateTo` range filtering. Opening balance (pre-period) lines are computed separately in the GL report via a sub-query: this gives the correct opening balance for each account at the start of the period.

---

## 6. CURRENT BANK BALANCE BEHAVIOUR

### Two Separate Balance Concepts

There are **two independent balance values** for any bank account. These are commonly confused.

#### Balance 1: The GL Bank Balance (Ledger Balance)

Computed dynamically from posted journal_lines:

```
GL Bank Balance = bank_account.opening_balance
               + SUM(journal_lines.debit   WHERE account_id = ledger_account_id AND j.status = 'posted')
               - SUM(journal_lines.credit  WHERE account_id = ledger_account_id AND j.status = 'posted')
```

This is the authoritative accounting balance. It reflects only fully journalised and posted transactions.

**Source in code:** `reports.js → GET /bank-reconciliation → ledgerBalance`

#### Balance 2: The Statement Running Balance (Informational)

The `balance` column in `bank_transactions` is the **running balance column as imported from the bank statement**. It is whatever number was in the "balance" column of the PDF/CSV being imported. It is informational only — it is not computed from journal entries.

**Purpose:** Display in the bank transactions list so the accountant can verify the running balance matches what they see on the physical statement.

**Not used in any GL computation.**

### What the Bank Card Shows

The bank account card on `bank.html` shows the bank account's linked ledger account code and name. The displayed balance (if any) comes from the GL calculation above.

### Risk: Balance Column Nullability

The `balance` column in `bank_transactions` allows NULL. If a statement was imported without a balance column (e.g., a CSV without a running balance), all rows will have `balance = NULL`. The bank recon report falls back to `opening_balance` in this case. This creates a risk — see Section 12, Risk R2.

---

## 7. CURRENT BANK RECONCILIATION BEHAVIOUR

### There Are Two Separate Reconciliation Mechanisms

This is the most important distinction in this entire audit. The system has **two distinct reconciliation mechanisms** that serve different purposes.

---

### Mechanism 1: The Bank Reconciliation Report (API-driven)

**Route:** `GET /api/reports/bank-reconciliation?bankAccountId=X&date=YYYY-MM-DD`

**What it computes:**

```
statementBalance   = last bank_transactions.balance on or before the date
                   (falls back to bank_account.opening_balance if no transactions)

ledgerBalance      = bank_account.opening_balance
                   + SUM(posted journal_lines for ledger_account_id up to date)

unreconciledItems  = bank_transactions WHERE status IN ('unmatched', 'matched')
                     AND bank_account_id = X AND date <= end_date

unreconciledTotal  = SUM(unreconciledItems.amount)

reconciledBalance  = statementBalance - unreconciledTotal

difference         = ledgerBalance - reconciledBalance

isReconciled       = ABS(difference) < 0.01
```

**What this is actually doing:**  
This is a programmatic/automated reconciliation report. It computes whether the GL bank balance can be explained by: the last known statement balance minus items that haven't yet been ticked as reconciled (both unallocated and allocated-but-not-reconciled).

**Key limitation:** `statementBalance` here is NOT an accountant-entered statement closing balance. It is the `balance` column from the most recently imported statement row — which may be null, stale, or from a partial import.

**Where "unreconciled" = unmatched + matched:**  
Both `status='unmatched'` (no journal at all) and `status='matched'` (has a posted journal but not yet ticked as reconciled) are treated as "unreconciled" in this formula. This is technically correct — being allocated is not the same as being confirmed against the physical statement — but it is a strict definition.

---

### Mechanism 2: The Bank Reconciliation Screen (User-Driven)

**Route:** `bank-reconciliation.html` — interactive front-end screen

**How it works:**

1. Loads `bank_transactions` for the selected bank account, filtered to show both matched and unmatched transactions (including already-reconciled, shown as disabled)
2. Accountant manually enters the **Statement Closing Balance** in a text field (`id="statementBalance"`)
3. Accountant ticks (checks) each transaction that appears on the physical bank statement
4. **Ticking rule:** Only `matched` (allocated) transactions can be ticked — `unmatched` transactions are displayed but the checkbox is non-interactive (the `toggleCheck()` function enforces `_txnStatus === 'matched'`)
5. The screen computes: `clearedBalance = bookOpening + SUM(checked matched transactions)`
6. `difference = statementBalance - clearedBalance`
7. The "Finish" button is only enabled when `Math.abs(difference) < 0.005` AND at least one item is checked
8. On Finish: calls `POST /api/bank/reconcile` with the IDs of all checked transactions
9. The reconcile endpoint marks those `bank_transactions` rows as `status = 'reconciled'`, `reconciled_at = NOW()`

**What this is doing:**  
This is the **correct standard bank reconciliation** — the accountant physically compares the statement to the allocated transactions, enters the statement closing balance, ticks off items, and confirms the balance reconciles to zero difference.

**Critical gap:** The statement closing balance entered by the accountant is **never saved to the database**. It is used only for the local calculation in the browser. If the page is refreshed or closed, the balance is lost. No audit trail records: "on date X, account Y was reconciled to statement balance Z by user W."

---

### Full Status Lifecycle of a Bank Transaction

```
bank_transaction_staging (match_status):
  UNMATCHED → TRANSFER_DETECTED / REVIEW_REQUIRED / DUPLICATE_SUSPECTED
     ↓ (user action: confirm or reject)
  CONFIRMED | REJECTED

bank_transactions (status):
  unmatched     ← created here on regular staging confirmation
     ↓ (accountant allocates)
  matched       ← journal is posted, matched_entity_id = journal.id
     ↓ (accountant ticks and finishes recon)
  reconciled    ← reconciled_at is set

  Can reverse: reconciled → matched → unmatched (with journal reversal)
```

---

## 8. VAT IMPACT

### When VAT Appears

VAT is captured **at allocation time**, not at import time. This is correct.

### How VAT Split Works

When an allocation line includes a `vatSettingId`, the allocation route:

1. Fetches the `vat_settings` row for that ID to get `rate` (e.g., 15.00)
2. Splits the transaction amount: `exVatAmount = amount / (1 + rate/100)`; `vatAmount = amount - exVatAmount`
3. Posts the journal with three lines:
   - Bank line: full transaction amount
   - Allocation account line: ex-VAT amount only
   - VAT line: `vatAmount` to account 1400 (Input VAT, for expenses) or 2300 (Output VAT, for income)

### VAT Settings Table

`vat_settings` per company supports multiple rates (standard 15%, zero 0%, exempt, old rate 14%, capital items). Each is identified by `code` and has `effective_from` / `effective_to` dates. The correct rate for a transaction date is looked up dynamically.

### VAT and the TB

VAT amounts appear in the TB once allocated — specifically:
- Input VAT flows to the designated Input VAT account (1400-series)
- Output VAT flows to the designated Output VAT account (2300-series)
- These appear in the TB as any other posted journal line would

### VAT Reconciliation

A separate VAT reconciliation module exists (vatRecon.js). It is separate from the bank reconciliation and reads from posted journal_lines on VAT-category accounts for a given period. It does not depend on `bank_transactions.status` — it reads only from the GL.

### No VAT on Unallocated Transactions

If a transaction is confirmed (in `bank_transactions`) but not yet allocated (`status = 'unmatched'`), it generates no VAT entry. This is correct — VAT must be determined by the accountant, not inferred from the raw bank description.

---

## 9. REPORTING IMPACT

### Trial Balance

- Source: `journal_lines JOIN journals WHERE j.status = 'posted'`
- Includes: all posted journals (allocations, transfers, direct entries, opening balances, payroll journals, etc.)
- Excludes: unallocated bank transactions (correctly)
- Period filtering: `j.date BETWEEN dateFrom AND dateTo`
- Company isolation: `j.company_id = companyId`

### General Ledger

- Same source as TB
- Also computes opening balance per account (sum of posted lines pre-period)
- Provides drill-down to individual journal entries

### Balance Sheet / Profit & Loss

- Both use `fetchAccountBalances()` — same posted-journals-only source as TB
- Both are therefore only complete once all transactions are allocated
- Unallocated bank transactions create a "silent gap" in BS/P&L until allocated

### Bank Reconciliation Report (API)

- Uses `bank_transactions.balance` as proxy for statement closing balance — see Gap G4
- Computes automated diff between GL balance and imported statement balance minus unreconciled items
- Does NOT read from journal_lines directly for the statement side

### What Is Currently Missing From Reporting

1. **"Unallocated Bank Transactions" report** — shows transactions in `bank_transactions` with `status = 'unmatched'`, by account and period, with running totals. Allows management to see: how much unallocated money exists and how long it has been sitting unallocated.

2. **"Bank Statement Import History" report** — shows all import batches (from `bank_transaction_staging`), how many rows were imported per batch, how many were confirmed, how many were rejected, and when.

3. **"Bank Reconciliation History" report** — shows all completed reconciliations per account per period (when they happened, who did them, what balance was reconciled to). Does not exist yet because there is no `bank_recon_sessions` table.

4. **"Outstanding Items" report** — shows transactions that are `matched` (allocated and journalised) but not yet `reconciled` (not yet ticked on a bank statement) — i.e., the items that are in the GL but not yet confirmed against the physical statement.

---

## 10. WHAT IS ACCOUNTING-CORRECT

The following design decisions are **accounting-correct and must not be changed**:

### 10.1 TB Only Includes Posted Journals

This is the international accounting standard. The General Ledger and Trial Balance are computed from formal journal entries only. Bank transactions that have not been allocated have no journal entry and therefore correctly do not appear in the GL. Any change to this would break double-entry accounting.

### 10.2 Allocation Creates a Balanced Journal Immediately

The system does not allow partial or deferred posting. Every allocation creates and posts a complete double-entry journal in the same API request. The post-posting validation guard (8 checks) ensures the journal is balanced and references the correct bank account. This is architecturally sound.

### 10.3 Reconciliation Requires Allocation First

You cannot reconcile an unallocated transaction. The bank recon screen enforces this via `toggleCheck()` — only `matched` (allocated) transactions can be ticked. The reconcile endpoint enforces this with a status check: `status must be 'matched'`. This is correct — you cannot confirm against the GL what has not yet been journalised.

### 10.4 The Three-Status Lifecycle (unmatched → matched → reconciled)

This correctly models the three distinct accounting states:
- `unmatched` = imported, confirmed, but not journalised
- `matched` = journalised (allocated or transfer-confirmed), in the GL
- `reconciled` = confirmed against the physical bank statement

These are distinct states and must remain distinct.

### 10.5 Allocation Reversal Reverses the Journal

`DELETE /api/bank/transactions/:id/allocate` reverses the posted journal via `JournalService.reverseJournal()`. This is the correct accounting approach — a reversal creates counterpart journal entries rather than deleting the original. The GL remains complete and auditable.

### 10.6 Transfer Confirmation Creates a Dr/Cr Journal

When a staging transfer pair is confirmed, a proper double-entry journal is created (Dr receiving bank, Cr sending bank). This is correct — an interbank transfer is a real GL event and must be journalised.

### 10.7 VAT Is Split at Allocation

VAT is determined at allocation time, not at import time. The accountant selects the VAT category per allocation line. This is correct — the system cannot know whether a bank transaction contains VAT from the raw description alone.

### 10.8 Company Isolation on All Queries

Every API endpoint scopes all DB queries by `req.user.companyId`. The reconcile endpoint includes a double-guard (`eq('company_id', req.user.companyId)` at both fetch and update). This is correct and must be maintained.

---

## 11. WHAT IS CURRENTLY WORKING AND MUST BE PROTECTED

These features are confirmed working. No change may remove or weaken any of them.

| Feature | File | Notes |
|---|---|---|
| Bank import → staging (all sources) | `bank.js`, `bankStagingService.js` | GL-zero at import |
| Duplicate detection (file hash + fuzzy) | `duplicateDetectionService.js` | SHA-256 + amount/date fuzzy |
| Transfer detection in staging | `bankStagingService.js` | 3 layers: keyword, exact, fuzzy |
| Transfer confirmation creates journal | `bankStagingService.js` | Dr/Cr both bank accounts |
| Transfer reversal reverses journal + deletes transactions | `bankStaging.js` | Full rollback |
| Regular staging confirmation → bank_transactions | `bankStagingService.js` | GL-zero |
| Allocation creates immediate posted double-entry journal | `bank.js` | 8-check post-posting guard |
| VAT split at allocation | `bank.js` | input (1400) / output (2300) |
| Post-posting validation guard (8 checks) | `bank.js` | Hard safety gate |
| Auto-reversal on allocation failure | `bank.js` | No partial state |
| Allocation reversal (unallocate) | `bank.js` | Journal reversal + status reset |
| Reconcile endpoint: only matched + journal-verified transactions | `bank.js` | All-or-nothing batch |
| Unreconcile endpoint: reconciled → matched | `bank.js` | Clean rollback |
| TB reads only posted journals | `reports.js` | Core accounting invariant |
| GL report with opening balance (pre-period) | `reports.js` | Period-correct |
| Bank recon report (API): automated diff | `reports.js` | Informational |
| Bank recon screen: manual balance entry + tick-off + finish | `bank-reconciliation.html` | Interactive standard recon |
| SEAN learning events (async, non-blocking) | `bank.js`, `bank-learning.js` | Fire-and-forget — non-critical path |
| Company-scoped tenant isolation | All routes | `req.user.companyId` everywhere |
| Audit log on every mutating operation | `bank.js` | `AuditLogger.logUserAction()` |
| Auto-schema migration of `bank_transactions` columns | `accounting-schema.js` | Runs at server startup |

---

## 12. CONFIRMED RISKS

### RISK R1 — HIGH: No Persisted Statement Closing Balance

**What:** The bank reconciliation screen asks the accountant to type the statement closing balance. This value is used only in the browser's local calculation. It is never sent to the backend. It is never stored in the DB.

**Evidence:**  
`bank-reconciliation.html` line 731: `<input type="text" id="statementBalance">` — this value is read in `updateStatementBalance()` and used in `updateSummary()` to compute the difference. When `finishReconciliation()` is called, it sends only `transactionIds` to `POST /api/bank/reconcile`:
```js
const result = await apiPost('/bank/reconcile', { transactionIds: toReconcile });
```
No `statementBalance`, no `statementDate`, no `closingBalance` is sent to the backend.

**Impact:**
- No record of what statement balance was reconciled to
- Cannot verify after the fact whether the reconciliation was done correctly
- No "Bank Reconciliation Statement" printout is possible from the DB data alone
- A future audit question ("what balance did you reconcile to at 31 March?") cannot be answered from the system

**Current Workaround:** None in the system. Accountants would need to note this externally.

---

### RISK R2 — MEDIUM: Statement Balance Proxy May Be Wrong

**What:** The Bank Reconciliation Report (`GET /api/reports/bank-reconciliation`) derives `statementBalance` from the last `bank_transactions.balance` value on or before the date.

**Evidence (reports.js bank-reconciliation handler):**
```sql
SELECT balance FROM bank_transactions
WHERE bank_account_id = $1
  AND date <= $2
  AND balance IS NOT NULL
ORDER BY date DESC, id DESC
LIMIT 1
```
Falls back to `bank_account.opening_balance` if no non-null balance row exists.

**Impact scenarios where this is wrong:**
1. **Partial import:** Only some transactions were imported for the period. The last `balance` value is a mid-period balance, not the closing balance.
2. **No balance in source file:** A CSV import that had no "Balance" column results in all `balance = NULL`. The fallback to `opening_balance` will produce a completely wrong `statementBalance` in the report.
3. **Out-of-order imports:** If transactions from a later period are imported before an earlier period is reconciled, the last `balance` might be from the wrong period.

**Clarification:** This affects the API report only. The bank reconciliation screen uses a manually entered balance and is not affected by this issue.

---

### RISK R3 — MEDIUM: Schema Drift — Allocation Columns Not in SQL Migration Files

**What:** Four columns on `bank_transactions` are used by the allocation route but are not in any numbered SQL migration file (`database/migrations/`):
- `allocated_account_id`
- `allocation_type`
- `allocated_account_name`
- `vat_setting_id`

**Evidence:**
- `bank.js` lines 1311–1314 and 1482–1485: these four columns are SET and CLEARED on `bank_transactions`
- No `ALTER TABLE bank_transactions ADD COLUMN ... allocation_type` or similar in any file under `database/migrations/`
- These columns ARE added in `backend/config/accounting-schema.js` lines 690–700 (the server startup auto-migration)

**Additionally:** The original `database/schema.sql` has `allocated_account_id INTEGER REFERENCES chart_of_accounts(id)` — but `accounting-schema.js` adds `allocated_account_id INTEGER REFERENCES accounts(id)` (different FK target). These co-exist on the DB with only the last-applied winning. On production this is fine (the auto-schema runs), but on a fresh setup from SQL migrations alone it would use the wrong FK.

**Impact:** No production impact currently. The auto-schema runs at every server startup and adds the columns idempotently. Risk is:
- A developer setting up a new environment from SQL migration files alone (without running the server) would have an incomplete `bank_transactions` schema
- Allocation would fail on that environment until the server is started at least once
- The `schema.sql` FK for `allocated_account_id` points to `chart_of_accounts`, not `accounts` — schema inconsistency if both are applied

---

### RISK R4 — MEDIUM: No Reconciliation Session Audit Trail

**What:** There is no `bank_recon_sessions` (or equivalent) table. Once transactions are marked `reconciled`, there is no record of:
- The date of reconciliation
- The statement date being reconciled
- The closing balance entered
- Which batch of transactions was reconciled together
- Who performed the reconciliation

**Evidence:** The `POST /api/bank/reconcile` endpoint stores `reconciled_at = NOW()` on each individual `bank_transactions` row. But there is no session-level record grouping them.

**Impact:**
- Cannot produce a Bank Reconciliation Statement document (the formal accounting document that proves the bank was reconciled)
- Cannot see "the March reconciliation" as a single historic record
- For SARS/audit purposes, this is a gap — though it can be partially reconstructed from `reconciled_at` timestamps

---

### RISK R5 — LOW: Unmatched Transactions Block Reconciliation

**What:** The bank reconciliation screen can only finish reconciling if the difference between `statementBalance` and `bookOpening + sum(checked matched)` reaches zero. Unmatched (unallocated) transactions appear in the list but cannot be ticked (the checkbox is disabled for `status !== 'matched'` rows). If there are unallocated transactions in the period, the reconciliation difference will likely never reach zero because those transactions affect the statement balance but not the cleared balance.

**Impact:**
- Accountants must allocate 100% of transactions before completing the bank reconciliation
- This is accounting-correct by design: you cannot reconcile what has not been journalised
- But it may cause confusion for users who expect to be able to reconcile even if some transactions are pending

**Classification:** By design, not a bug. Must be clearly communicated to users.

---

### RISK R6 — LOW: `is_reconciled` Column in schema.sql Not Used

**What:** The original `database/schema.sql` creates `bank_transactions` with an `is_reconciled BOOLEAN DEFAULT false` column. The actual system uses a `status VARCHAR(20)` column with values `unmatched / matched / reconciled`. The `is_reconciled` column exists in the DB but is never read or written by any current route.

**Impact:** Stale column creates confusion during DB inspection. Not a functional risk. Candidate for cleanup in a future migration.

---

## 13. RECOMMENDED SAFE ARCHITECTURE

The following architectural additions would close the gaps identified in Section 12. These are recommendations only — implementation requires separate authorisation.

### 13.1 Add `bank_recon_sessions` Table

```sql
CREATE TABLE IF NOT EXISTS bank_recon_sessions (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id),
  bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts(id),
  statement_date      DATE NOT NULL,           -- date on the physical bank statement
  statement_closing_balance NUMERIC(15,2) NOT NULL,  -- balance entered by accountant
  cleared_balance     NUMERIC(15,2) NOT NULL,  -- bookOpening + sum(reconciled txns)
  difference          NUMERIC(15,2) NOT NULL,  -- statement_closing_balance - cleared_balance
  transaction_count   INTEGER NOT NULL,        -- number of transactions reconciled
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

And at reconciliation time: insert a session row, then link all reconciled `bank_transactions` rows to it via a `recon_session_id` FK.

### 13.2 Pass Statement Balance to the Reconcile Endpoint

Extend `POST /api/bank/reconcile` to accept:
```json
{
  "transactionIds": [...],
  "statementDate": "2026-03-31",
  "statementClosingBalance": 150000.00
}
```

Store in `bank_recon_sessions`. This one change fixes Risk R1 and R4 simultaneously.

### 13.3 Consolidate Allocation Columns Into a Numbered Migration

Create `database/migrations/047_bank_allocation_display_columns.sql`:
```sql
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocated_account_id   INTEGER REFERENCES accounts(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocation_type        VARCHAR(50);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocated_account_name TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS vat_setting_id         INTEGER REFERENCES vat_settings(id);
```

This makes the SQL migrations the single source of truth for schema, reducing Risk R3.

### 13.4 Add an "Unallocated Bank Transactions" View or Report

A simple API endpoint: `GET /api/reports/unallocated-bank-transactions?bankAccountId=X&dateFrom=X&dateTo=X`

Query: `SELECT * FROM bank_transactions WHERE company_id = ? AND status = 'unmatched' AND bank_account_id = ? AND date BETWEEN ? AND ?`

This closes the reporting gap (G5) without any schema change.

### 13.5 Fix the Statement Balance Proxy in the Recon Report

Rather than using the last `bank_transactions.balance` as the statement closing balance, the bank-reconciliation API report should either:
- Use the `bank_recon_sessions` table if 13.1 is implemented
- Or clearly document that `statementBalance` is an informational proxy and rename it in the API response to `lastImportedStatementBalance` to prevent confusion

---

## 14. RECOMMENDED NEXT WORKSTREAMS

In priority order, based on audit findings. None of these are emergency items.

| Priority | Workstream | Fixes Gaps | Estimated Complexity |
|---|---|---|---|
| P1 | Persist statement closing balance on reconcile — extend `POST /api/bank/reconcile` + create `bank_recon_sessions` table | R1, R4 | Medium |
| P2 | Consolidate allocation columns into a numbered SQL migration (047) | R3 | Low |
| P3 | Add "Unallocated Bank Transactions" report endpoint | G5 | Low |
| P4 | Rename `statementBalance` in bank-recon report to `lastImportedStatementBalance` for clarity | R2 (partial) | Very Low |
| P5 | Add Bank Reconciliation History view to frontend using `bank_recon_sessions` (after P1) | G3 (partially R4) | Medium |
| P6 | Clean up unused `is_reconciled` column from `bank_transactions` | R6 | Very Low |
| P7 | Resolve `allocated_account_id` FK conflict between schema.sql (→ chart_of_accounts) and accounting-schema.js (→ accounts) | R3 (extension) | Low |

---

## 15. QUESTIONS FOR RUAN BEFORE ANY CODE CHANGES

These questions must be answered before implementing any of the workstreams above. They affect design decisions.

---

**Q1 — Reconciliation Session Model:**  
When an accountant clicks "Finish Reconciliation," should the system:  
(a) Save the statement closing balance and date alongside the reconciled transaction IDs as a session record (creates a formal Bank Rec Statement in the DB), or  
(b) Continue as-is (each transaction gets its own `reconciled_at` but no session record)?  

This determines whether P1 is needed and how it is designed.

---

**Q2 — Partial Reconciliation:**  
Currently, the reconcile endpoint is all-or-nothing within a batch. If some transactions pass validation and some fail, nothing is reconciled. Is this the correct behaviour for the accounting practice? Or should partial reconciliation be allowed (reconcile what passes, report what failed)?

---

**Q3 — Unallocated Transactions in the Reconciliation Screen:**  
Currently, `unmatched` (unallocated) transactions appear in the reconciliation screen list but cannot be ticked. Should they:  
(a) Continue appearing but be clearly labelled "Requires allocation first"  
(b) Be hidden from the screen until they are allocated  
(c) Remain as-is  

This affects the UX of the reconciliation screen but not the backend logic.

---

**Q4 — Bank Reconciliation Report vs Screen:**  
The Bank Reconciliation Report (API) and the Bank Reconciliation Screen (frontend) use different approaches to determine the statement closing balance. The API uses the imported running balance; the screen uses a manually entered balance. Should these be unified? If so, which approach should become the standard?

---

**Q5 — `is_reconciled` Column Cleanup:**  
The original `database/schema.sql` creates `bank_transactions.is_reconciled BOOLEAN`. The current system uses `status VARCHAR(20)` instead. Should `is_reconciled` be dropped? Are there any external integrations or reports that still read this column?

---

**Q6 — Allocation Display Columns Migration:**  
The columns `allocated_account_id`, `allocation_type`, `allocated_account_name`, `vat_setting_id` on `bank_transactions` are only tracked in the server auto-migration. Should a formal SQL migration (047) be created to track them? This is a housekeeping task but ensures other developers can set up a fresh environment from SQL files alone.

---

**Q7 — Outstanding Items Report:**  
Do you need a report that shows transactions that are `matched` (allocated, in the GL) but not yet `reconciled` (not yet ticked against a statement)? This would show the "outstanding items" list that is required on a formal Bank Reconciliation Statement.

---

**Q8 — Frequency and Formality of Reconciliation:**  
Is the expectation that clients will do a formal monthly bank reconciliation (importing a full month statement, allocating everything, ticking everything, and saving a reconciliation statement)? Or is the reconciliation feature used more informally (ticking off selected items periodically)? The answer affects how important the session/audit trail gap (Risk R1, R4) actually is in practice.

---

*End of Forensic Audit.*  
*Prepared from code review of: bank.js, bankStaging.js, bankStagingService.js, duplicateDetectionService.js, reports.js, bank-reconciliation.html, accounting-schema.js, database/012_accounting_schema.sql, database/013_sean_learning.sql, database/schema.sql, database/migrations/020_bank_staging.sql, database/migrations/031_bank_staging_hardening.sql, database/migrations/034_vat_settings.sql, database/migrations/046_opening_balances.sql*
