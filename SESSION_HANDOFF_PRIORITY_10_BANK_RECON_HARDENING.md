# SESSION HANDOFF — Priority 10: Bank Reconciliation Hardening
**Date:** 2026-05-xx  
**Status:** Phase complete — backend hardened, staging UI created, localStorage violation fixed  
**Next session must read this file before touching any bank-related code.**

---

## WHAT WAS CHANGED (per file, with purpose)

### 1. `database/migrations/031_bank_staging_hardening.sql` — CREATED
**Purpose:** Schema additions to support duplicate detection, transfer rejection/reversal, and audit trail.

Changes:
- `bank_transaction_staging.match_status` CHECK extended to include `'DUPLICATE_SUSPECTED'`
- `ADD COLUMN normalized_description TEXT` on `bank_transaction_staging` (for fuzzy duplicate matching)
- `ADD COLUMN duplicate_suspected BOOLEAN DEFAULT FALSE` on `bank_transaction_staging`
- `ADD COLUMN rejected BOOLEAN DEFAULT FALSE` on `bank_transfer_links`
- `ADD COLUMN rejected_by INTEGER` on `bank_transfer_links`
- `ADD COLUMN rejected_at TIMESTAMPTZ` on `bank_transfer_links`
- `CREATE TABLE bank_import_duplicate_log` — records suspected duplicates with match_type, similarity_score
- Indexes on all new columns

**Must run this migration against Supabase before deploying this session's changes.**

---

### 2. `backend/modules/accounting/services/bankStagingService.js` — MODIFIED
**Purpose:** Two new methods added; `listStaged` enhanced.

#### `listStaged` (enhanced)
Now accepts additional filter params and returns `{ staging: [], total: N }` instead of a bare array.
- Params added: `dateFrom`, `dateTo`, `search` (ILIKE on `description`), `sortBy`, `sortDir`
- Returns: `{ staging, total }` — callers that expected a bare array must be updated if not already
- The route handler already updated to use new shape.

#### `rejectTransferLink(companyId, linkId)` — NEW
- Fetches transfer link by `linkId`, verifies `company_id` match
- Checks link is not already confirmed (blocks rejection of posted journals)
- Updates `bank_transfer_links SET rejected=true, rejected_by, rejected_at`
- Resets both staging rows (via `staging_id_1`, `staging_id_2`) back to `match_status='UNMATCHED'`
- Returns `{ id, rejected: true }`

#### `reverseConfirmedTransfer(companyId, linkId, user, reason)` — NEW
- Fetches confirmed (and non-rejected) transfer link
- Calls `JournalService.reverseJournal(journalId, companyId, userId, reason)` to post counter-journal
- Deletes `bank_transactions` rows referenced by `confirmed_txn_id_1`, `confirmed_txn_id_2`
- Resets both staging rows to `match_status='TRANSFER_DETECTED'` (available for re-actioning)
- Resets link: `confirmed=false, journal_id=null, confirmed_at=null`
- Returns `{ reversed: true, journalId: <reversal journal id>, txnIdsDeleted: [id1, id2] }`

---

### 3. `backend/modules/accounting/routes/bankStaging.js` — MODIFIED
**Purpose:** Two new endpoints added; GET / handler updated to use new listStaged return shape.

#### `GET /api/accounting/bank/staging`
- Now passes `dateFrom`, `dateTo`, `search`, `sortBy`, `sortDir` to `bankStagingService.listStaged`
- Now reads `{ staging, total }` from service response and returns `{ staging, total }` to client

#### `PATCH /api/accounting/bank/staging/transfers/:linkId/reject` — NEW
- Permission: `bank.allocate`
- Calls `BankStagingService.rejectTransferLink(companyId, linkId)`
- Logs audit: `REJECT_TRANSFER_LINK`
- Returns `{ id, rejected: true }`

#### `POST /api/accounting/bank/staging/transfers/:linkId/reverse` — NEW
- Permission: `bank.manage`
- Body: `{ reason? }`
- Calls `BankStagingService.reverseConfirmedTransfer(companyId, linkId, user, reason)`
- Logs audit: `REVERSE_TRANSFER`
- Returns `{ reversed: true, journalId, txnIdsDeleted }`

---

### 4. `frontend-accounting/bank-staging.html` — CREATED (new file)
**Purpose:** Full staging review UI for reviewing imported transactions before they enter the reconciliation queue. Replaces the need for manual localStorage "reviewed" tracking.

Features:
- Bank account + batch + date range + description search filters
- Status tab pills (All / To Review / Transfer Suggested / Needs Attention / Possible Duplicate / Confirmed / Rejected) with live counts
- Staged transactions table with status badges, money in/out columns, per-row actions
- Transfer suggestions panel (rendered when batch has TRANSFER_DETECTED rows with pending link)
- Confirm single row → `POST /bank/staging/confirm { stagingIds: [id] }`
- Reject single row → `PATCH /bank/staging/:id/reject`
- Confirm all visible → bulk `POST /bank/staging/confirm`
- Confirm transfer → `POST /bank/staging/transfers/:linkId/confirm` (with modal warning re: GL posting)
- Reject/dismiss transfer → `PATCH /bank/staging/transfers/:linkId/reject` (with optional reason textarea)
- Reverse transfer → `POST /bank/staging/transfers/:linkId/reverse` (with strong warning modal)
- All GL-posting actions gated behind confirmation modals
- No localStorage for business data — JWT token only
- Pagination (50 rows/page)

---

### 5. `frontend-accounting/bank.html` — MODIFIED (Rule D localStorage fix)
**Purpose:** Remove `safeLocalStorage`-based `reviewedTransactions` list (business data violation — Rule D).

**Root cause:** The "New" / "Reviewed" tabs used a client-side array stored in localStorage/KV to track which transactions had been manually flagged as reviewed. This was a business-data-in-browser-storage violation.

**Fix applied:**
- Removed `reviewedTransactions` array and its `safeLocalStorage` read
- Removed `markAsReviewed()` function (was writing to localStorage)
- Removed `moveBackToNew()` function (was writing to localStorage)
- Removed "Mark as Reviewed" and "Move Back to New" buttons from bulk actions bar
- Added `isReviewed(txn)` helper: returns `true` if `txn.is_reconciled || txn.allocated_account_id != null`
- Updated `switchTab()`: filters `_allTxnDataUnfiltered` using `isReviewed(txn)` (server-authoritative)
- Updated `updateCounts()`: counts from full dataset using `isReviewed(txn)` (no localStorage)
- Updated the loadTransactions filter at lines ~2291-2292 to use `isReviewed(txn)`

**Result:** "New" = unallocated + unreconciled. "Reviewed" = allocated or reconciled. Tab state derived from server data only. No localStorage dependency.

---

## WHAT WAS NOT CHANGED (and why)

| Item | Reason |
|---|---|
| `bank-reconciliation.html` | Low-priority improvement (staging widget). Functional as-is. |
| `stageTransactions()` in bankStagingService.js | Duplicate detection enhancement not yet built. See follow-up below. |
| `bank.html` import flow (POST /bank/import directly) | Scope limitation — rerouting import through staging is a larger refactor. See follow-up. |
| `bank_transactions.user_reviewed` column | Not needed — `is_reconciled` / `allocated_account_id` are sufficient proxies. |

---

## ROOT CAUSES FIXED

| # | Root Cause | Fix |
|---|---|---|
| 1 | No endpoint to reject a transfer suggestion | `PATCH /staging/transfers/:linkId/reject` + service method |
| 2 | No endpoint to reverse a confirmed transfer | `POST /staging/transfers/:linkId/reverse` + service method |
| 3 | No dedicated staging review UI | `bank-staging.html` created |
| 4 | `reviewedTransactions` in safeLocalStorage (Rule D violation) | Replaced with `isReviewed(txn)` derived from server data |
| 5 | `listStaged` returned bare array with no filtering | Enhanced with date/search/status/sort params + `total` count |

---

## TESTING REQUIRED

### Regression tests (Rule E3 — not payroll, but equivalent discipline required)
1. ✅ Existing bank import still works (POST /bank/import → bank_transactions)
2. ✅ bank.html New/Reviewed tabs still render correctly with server data
3. New: Navigate to bank-staging.html → page loads, filter bar works, status tabs show counts
4. New: Load a batch with TRANSFER_DETECTED rows → Transfer Suggestions panel appears
5. New: Confirm a single staging row → row disappears from "To Review" tab, appears in "Confirmed"
6. New: Reject a staging row → row moves to "Rejected" tab
7. New: Dismiss a transfer suggestion → both rows return to "To Review"
8. New: Confirm a transfer → modal warns about GL posting → journal posted → rows move to Confirmed
9. New: Reverse a confirmed transfer → counter-journal posted → bank transactions deleted → rows back to Transfer Detected
10. New: bank.html "Reviewed" tab shows allocated/reconciled transactions, "New" shows the rest

### Migration prerequisite
Run `031_bank_staging_hardening.sql` in Supabase SQL editor before deployment.

---

## OPEN FOLLOW-UP ITEMS

### FOLLOW-UP 1 — Duplicate Detection in stageTransactions
```
FOLLOW-UP NOTE
- Area: bankStagingService.stageTransactions
- Dependency: 031 migration (adds normalized_description, duplicate_suspected columns)
- What was done now: Columns added in 031 migration. Detection logic NOT yet written.
- What still needs to be checked:
    a) After staging insert, query for same company/account rows with same amount ±0.001,
       same date, AND normalized_description similarity > 0.8 (pg_trgm or levenshtein)
    b) If match found: UPDATE SET match_status='DUPLICATE_SUSPECTED', duplicate_suspected=TRUE
    c) INSERT into bank_import_duplicate_log
- Risk if not implemented: Duplicate transactions can enter reconciliation queue silently
- Recommended next review point: Next bank hardening session
```

### FOLLOW-UP 2 — Reroute bank.html import through staging
```
FOLLOW-UP NOTE
- Area: bank.html wizard final step
- Current: POST /bank/import → directly writes to bank_transactions
- Required: POST /bank/staging/stage → staging review → confirm → bank_transactions
- What was done now: Nothing — too large a UX change for this session
- Risk if not done: Users can bypass the staging review entirely
- Recommended next review point: When bank.html is next scheduled for work
- Scope note: Requires reworking the import wizard final step + removing the POST /bank/import
  direct endpoint (or keeping it for manual single-entry only)
```

### FOLLOW-UP 3 — bank-staging.html transfer link detail rendering
```
FOLLOW-UP NOTE
- Area: bank-staging.html loadTransferRowDetails()
- Current: Transfer pair cards show "Loading…" for from/to details (placeholder)
- Required: Populate from/to rows with actual staging row description, date, amount
- How to fix: When fetchin batch data (GET /staging/batch/:batchId), transferLinks include
  staging_id_1, staging_id_2. Join staging rows to get description/date/amount.
  The service's getBatch method should include staging row details in its transferLinks response.
- Risk: UX only — functional correctness not affected
- Recommended next review point: Before presenting to users
```

### FOLLOW-UP 4 — bank-reconciliation.html staging pending widget
```
FOLLOW-UP NOTE
- Area: bank-reconciliation.html header
- Required: Add a small info banner: "X transactions pending staging review" with link to bank-staging.html
- Risk: Users may not know to visit staging review before reconciling
- Recommended next review point: Low priority — can add in next UI pass
```

---

## DEPLOYMENT CHECKLIST

- [ ] Run `031_bank_staging_hardening.sql` in Supabase dashboard (SQL editor)
- [ ] Verify `zbpack.json` does NOT exist in `accounting-ecosystem/`
- [ ] `Dockerfile` and `.dockerignore` present and unchanged
- [ ] Test POST /bank/staging/transfers/:linkId/reject with a real confirmed link
- [ ] Test POST /bank/staging/transfers/:linkId/reverse with a real confirmed transfer
- [ ] Navigate bank-staging.html — verify no console errors on load
- [ ] Verify bank.html Reviewed tab shows allocated transactions (not random)
- [ ] Verify bank.html New tab shows only unallocated, unreconciled transactions

---

*End of session handoff.*
