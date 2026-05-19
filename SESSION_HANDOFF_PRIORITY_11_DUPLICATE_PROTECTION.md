# SESSION HANDOFF — Priority 11: Duplicate Protection + Mandatory Staging Flow
**Date:** 2026-05  
**Priority:** 11  
**Status:** COMPLETE — all implementation done, syntax clean, ready for migration run + integration test

---

## WHAT WAS BUILT

### Root cause fixed

`POST /api/accounting/bank/import` previously inserted directly into `bank_transactions`, bypassing the entire staging pipeline. This meant:
- No reviewer approval before transactions entered reconciliation
- No duplicate detection
- No transfer detection
- No audit trail at the staging level

**This bypass is now eliminated.** Every bank import — PDF and CSV — goes through staging.

---

## FILES CHANGED

### NEW FILES CREATED

| File | Purpose |
|---|---|
| `database/migrations/032_duplicate_protection.sql` | Adds duplicate detection columns to `bank_transaction_staging`: `normalized_description`, `duplicate_status`, `duplicate_confidence`, `duplicate_reason`, `duplicate_group_id`, `source_file_hash`, `override_*` |
| `backend/modules/accounting/services/duplicateDetectionService.js` | Pure utility class (static methods, no DB writes). Computes file hashes (SHA-256), normalizes descriptions, detects batch-level duplicates (same file re-imported), detects transaction-level fuzzy duplicates (amount+date match) |

### MODIFIED FILES

#### `backend/modules/accounting/services/bankStagingService.js`
- Added `require('./duplicateDetectionService')` import
- `stageTransactions` signature extended with `options = {}` 6th parameter (`options.fileHash`)
- ExternalId dedup now checks BOTH `bank_transaction_staging` (non-REJECTED) AND `bank_transactions` — previously only checked staging
- Calls `DuplicateDetectionService.detectTransactionDuplicates()` to flag fuzzy amount+date matches before insert
- Each row now stores: `normalized_description`, `source_file_hash`, `duplicate_status` ('NONE'|'POSSIBLE'), `duplicate_confidence`, `duplicate_reason`
- Returns `{ staged, skipped, duplicatesSuspected, batchId }` (adds `duplicatesSuspected` count)
- Graceful fallback: if migration 032 columns are absent, retries insert without new fields (no staging failure on old deployments)
- `listStaged` now accepts `duplicateStatus` filter and passes it to Supabase query

#### `backend/modules/accounting/routes/bank.js`
- Added `require('../services/bankStagingService')`, `require('../services/duplicateDetectionService')`, `require('uuid')` imports
- `POST /import` completely rewritten — no longer inserts into `bank_transactions`:
  - Validates bank account ownership (multi-tenant safe)
  - Runs batch-level file hash duplicate check (warns, does NOT block)
  - Calls `BankStagingService.stageTransactions()` with `fileHash` option
  - Calls `BankStagingService.detectTransfers()` (best-effort, non-fatal)
  - Writes full audit log: `STAGE_IMPORT` action
  - Returns `{ requiresReview: true, batchId, staged, skipped, duplicatesSuspected, transfersDetected, batchDuplicateWarning, message }`
- `POST /import/pdf`:
  - Now computes `fileHash = DuplicateDetectionService.computeFileHash(req.file.buffer)` before parsing
  - Runs `DuplicateDetectionService.detectBatchDuplicate()` early (so UI can warn user before review step)
  - Response now includes `fileHash` and `batchDuplicateWarning` fields

#### `backend/modules/accounting/routes/bankStaging.js`
- `GET /` (list staged) now accepts `duplicateStatus` query param and forwards to `listStaged`
- JSDoc updated

#### `frontend-accounting/bank.html`
- `completePdfImport()`:
  - If `pdfParseResult.batchDuplicateWarning` exists, shows a confirm dialog before proceeding (user can cancel)
  - Passes `fileHash: result.fileHash` in request body to `POST /import`
  - Handles new `{ requiresReview: true, staged, skipped, duplicatesSuspected, transfersDetected }` response format
  - After staging: shows summary alert + offers to navigate to `bank-staging.html` (no longer calls `loadTransactions()` since nothing has landed in `bank_transactions` yet)
- `completeImport()` (CSV):
  - Same staging response handling pattern
  - No `loadTransactions()` call (staging only)
  - Offers to navigate to `bank-staging.html`

#### `frontend-accounting/bank-staging.html`
- Row rendering (`buildRow`): adds amber `⚠ Possible dup.` badge when `row.duplicate_status === 'POSSIBLE'` with `duplicate_reason` as tooltip
- `updateCounts()`: now also queries `?duplicateStatus=POSSIBLE` count and renders a warning banner above the tab bar if any possible duplicates exist

---

## WHAT WAS NOT CHANGED (AND WHY)

| Not changed | Reason |
|---|---|
| `POST /import/pdf` parse logic | Parse only — no DB write. Only added hash + early duplicate check to response. |
| `POST /import/image` | OCR parse only — no DB write. Not changed. |
| `bankStaging.js` confirm/reject endpoints | Already correct. No changes needed. |
| `bank.html` allocation/reconcile logic | Unrelated to import. Not touched. |
| Payroll, POS, accounting GL engine | Out of scope. Not touched. |
| `confirmStaged`, `confirmTransfer` in bankStagingService | Already correct staging → bank_transactions flows. Not touched. |

---

## DATABASE MIGRATION REQUIRED

**Before deploying to production, run:**
```sql
-- accounting-ecosystem/database/migrations/032_duplicate_protection.sql
```

This migration is additive (ALTER TABLE ADD COLUMN IF NOT EXISTS) — safe to run on a live database. Existing staging rows will get default values: `duplicate_status = 'NONE'`, other new columns `NULL`.

**Migration already runs without issue on fresh schema.** If columns exist already (re-run case), `IF NOT EXISTS` prevents error.

---

## DEPLOYMENT CHECKLIST

- [ ] Run migration 032 on production Supabase
- [ ] Verify `bank_transaction_staging` has new columns
- [ ] Deploy backend (Zeabur — confirm no `zbpack.json` in `accounting-ecosystem/`)
- [ ] Test PDF import end-to-end (verify staging response, redirect to bank-staging.html)
- [ ] Test CSV import end-to-end
- [ ] Re-import the same file — verify `batchDuplicateWarning` triggers
- [ ] Verify possible duplicate badge appears on staging page for fuzzy matches
- [ ] Verify `duplicate_status = 'POSSIBLE'` warning banner shows on bank-staging.html

---

## MANUAL TEST SCENARIOS

| # | Scenario | Expected |
|---|---|---|
| T1 | Import new PDF | `staged > 0`, redirected to staging, transactions in `bank_transaction_staging` |
| T2 | Re-import same PDF | `batchDuplicateWarning` in PDF parse response, confirm dialog shown before staging |
| T3 | Import CSV with same-amount+date rows already staged | Those rows get `duplicate_status = 'POSSIBLE'`, amber badge shows |
| T4 | Import CSV with externalIds that already exist in `bank_transactions` | Those rows skipped (counted in `skipped`) |
| T5 | Import triggers transfer detection | `transfersDetected > 0` in response |
| T6 | bank-staging.html — POSSIBLE dup rows | Amber `⚠ Possible dup.` badge visible with tooltip |
| T7 | bank-staging.html with POSSIBLE dups — top banner | Yellow warning banner appears above tabs |
| T8 | Confirm staging row with POSSIBLE status | Goes through normally (duplicate detection is informational only) |
| T9 | Allocate transaction via existing path | Not affected — unrelated path |
| T10 | Run payroll | Not affected — completely separate module |

---

## FOLLOW-UP NOTES

```
FOLLOW-UP NOTE
- Area: Duplicate override workflow
- What was done now: duplicate_status = 'POSSIBLE' is flagged and displayed, with override_user_id / override_reason / override_at columns added in migration 032
- What still needs: a UI action button for the accountant to mark a POSSIBLE duplicate as "Reviewed — Not a Duplicate" (sets duplicate_status = 'OVERRIDDEN'), and a backend PATCH endpoint to support that action
- Risk if not done: Accountants will see the warning badge on every possible duplicate without a clean "dismiss" path. They can still confirm normally, but the badge persists.
- Recommended next: Priority 12 task — add override endpoint + UI action
```

```
FOLLOW-UP NOTE
- Area: safeLocalStorage violations in bank.html (NOT related to Priority 11)
- What still exists: bank_allocations (~line 3390), sean_learning (~line 3805), bank_manual_transactions (~line 4526) still use safeLocalStorage
- Risk: These are tracked follow-ups from the May 2026 LocalStorage audit — NOT Priority 11 scope
- Recommended next: Separate migration task per Data Persistence Policy (Part D)
```

---

## SYNTAX CHECK RESULTS (pre-handoff)

All 4 modified/created backend files passed `node --check`:
- ✅ `bankStagingService.js`
- ✅ `duplicateDetectionService.js`
- ✅ `bank.js`
- ✅ `bankStaging.js`
