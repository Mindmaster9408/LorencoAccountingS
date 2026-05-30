# OFX Bank Import — Implementation Report

**Date:** 2026-05-30
**Scope:** OFX / QFX file import through the existing bank staging pipeline
**Status:** Implementation complete — migration pending deployment

---

## 1. Summary

OFX (Open Financial Exchange) import has been added as a fourth import channel alongside CSV, PDF, and Image. OFX files follow **the same forensic staging path** as all other imports:

```
OFX upload → parse (in-memory, no DB) → frontend review
    → POST /api/bank/import (importSource: 'ofx')
    → bank_transaction_staging
    → transfer detection
    → accountant confirms via Bank Staging
    → bank_transactions (status: unmatched)
    → allocation → journal → GL
```

No transaction touches the GL until the accountant explicitly allocates it after staging confirmation. This is identical to the PDF and CSV import guarantees.

---

## 2. Files Changed

### New files

| File | Purpose |
|---|---|
| `backend/modules/accounting/services/ofxParserService.js` | OFX 1.x / 2.x parser |
| `database/migrations/061_ofx_import_source.sql` | Add 'ofx' to staging import_source constraint |
| `backend/tests/ofx-bank-import.test.js` | 16 unit tests for parser + helpers |
| `docs/accounting/OFX_BANK_IMPORT_IMPLEMENTATION_REPORT.md` | This document |

### Modified files

| File | Changes |
|---|---|
| `backend/modules/accounting/routes/bank.js` | Added `ofxUpload` multer, `POST /import/ofx` route, 'ofx' to resolvedSource list |
| `frontend-accounting/bank.html` | OFX button + section HTML, OFX JS functions, switchImportMode/goToStep2/goBackToStep2/completeImport/resetImportWizard updated |

---

## 3. OFX Parser Behaviour

### Format support

| Format | Detection | Method |
|---|---|---|
| OFX 1.x (SGML) | No closing `</STMTTRN>` tags | Split on `<STMTTRN>` open tags |
| OFX 2.x (XML) | Closed `</STMTTRN>` tags present | Regex match `<STMTTRN>...</STMTTRN>` |
| QFX (Quicken) | `.qfx` extension; same structure as OFX | Same parser handles both |

OFX 1.x is attempted first if XML parsing yields no results. South African banks typically export OFX 1.x.

### Fields extracted per transaction

| OFX Field | Maps to | Notes |
|---|---|---|
| `<DTPOSTED>` | `date` (YYYY-MM-DD) | Strips timezone suffix `[-n:TZ]`, sub-second `.mmm` |
| `<TRNAMT>` | `amount` | Positive = money in, negative = money out |
| `<FITID>` | `externalId` | Used by staging deduplication (hard skip if same FITID already staged) |
| `<NAME>` | `description` (partial) | Combined with MEMO when both present and different |
| `<MEMO>` | `description` (partial) | Preferred when NAME absent or identical to NAME |
| `<CHECKNUM>` | `reference` | Optional cheque number |
| `<BALAMT>` (LEDGERBAL) | `closingBalance` | Statement-level only; per-transaction balance not standard |
| `<DTSTART>` / `<DTEND>` | `statementPeriod` | Informational display string |

### Description logic

```
NAME="WOOLWORTHS"  MEMO="PURCHASE"    → "WOOLWORTHS - PURCHASE"
NAME="DEBIT ORDER" MEMO="DEBIT ORDER" → "DEBIT ORDER"
NAME absent        MEMO="PARKING FEE" → "PARKING FEE"
NAME="SALARY"      MEMO absent        → "SALARY"
Both absent                           → FITID value, or "OFX Transaction"
```

### Date handling

All OFX date variants handled:
```
20240531            → 2024-05-31
20240531120000      → 2024-05-31
20240531120000.000  → 2024-05-31
20240531120000[-2:SAST] → 2024-05-31
```

---

## 4. Staging Integration

The OFX parse route (`POST /import/ofx`) is a **pure parse step** — no database writes. It returns structured JSON to the frontend for user review.

The user reviews the parsed transactions, selects which to import, then the frontend calls the **existing** `POST /api/bank/import` endpoint with `importSource: 'ofx'`. From that point, OFX transactions follow exactly the same path as PDF/CSV:

1. `BankStagingService.stageTransactions()` — inserts rows into `bank_transaction_staging` with `import_source='ofx'`
2. External ID deduplication — FITID values checked against staging and live `bank_transactions` (hard skip if duplicate)
3. Fuzzy duplicate detection — amount + date (±1 day) soft flag
4. Transfer detection — runs on the new batch

No code path exists for OFX to bypass staging or post directly to the GL.

---

## 5. Duplicate and Transfer Handling

### Deduplication (three layers — identical to PDF)

| Layer | Mechanism | Outcome |
|---|---|---|
| Hard skip | FITID (`externalId`) already in staging or bank_transactions | Row NOT inserted |
| Soft flag | Amount + date (±1 day) fuzzy match | Row inserted, `duplicate_status=POSSIBLE`, user warned |
| Batch duplicate | SHA-256 of file buffer | Non-blocking warning only; user decides |

### Transfer detection

Runs automatically after staging, same as all other import sources. The 3-layer algorithm (keyword → exact amount → fuzzy) scans the new OFX batch against all unmatched staging rows and live transactions.

---

## 6. Security

- File size: limited to 10 MB by multer (OFX files are text, typically < 200 KB)
- File type: multer `fileFilter` rejects non-`.ofx`/`.qfx` by extension; `OFXParserService.isAllowedFile()` adds a second check
- Company scoping: `bankAccountId` verified against `req.user.companyId` before use in dedup queries
- No raw OFX stored in browser storage — parse result lives only in JS memory (`ofxParseResult`)
- No GL posting on import — staging only
- Auth: `authenticate` + `hasPermission('bank.import')` required on the OFX route

---

## 7. Tests

16 unit tests in `backend/tests/ofx-bank-import.test.js`:

| Test | What it verifies |
|---|---|
| TEST-OFX-01 | Valid OFX 1.x parses to correct transaction count |
| TEST-OFX-02 | Positive amount → moneyIn set, moneyOut null |
| TEST-OFX-03 | Negative amount → moneyOut set, moneyIn null |
| TEST-OFX-04 | FITID captured as externalId |
| TEST-OFX-05 | YYYYMMDDHHMMSS date → YYYY-MM-DD |
| TEST-OFX-06 | Timezone suffix on date stripped correctly |
| TEST-OFX-07 | NAME + MEMO combined when different |
| TEST-OFX-08 | MEMO used alone when NAME absent |
| TEST-OFX-09 | Identical NAME/MEMO not duplicated in description |
| TEST-OFX-10 | OFX 2.x XML closed-tag format parsed correctly |
| TEST-OFX-11 | Non-OFX file returns success=false with error string |
| TEST-OFX-12 | Transactions missing date or amount skipped with warning |
| TEST-OFX-13 | LEDGERBAL closing balance extracted |
| TEST-OFX-14 | computeFileHash returns consistent 64-char hex |
| TEST-OFX-15 | isAllowedFile accepts .ofx/.qfx, rejects .csv/.pdf |
| TEST-OFX-16 | Statement period returned from DTSTART/DTEND |

To run:
```
cd accounting-ecosystem/backend
npx jest ofx-bank-import --verbose
```

---

## 8. Remaining Risks and Follow-ups

| Risk | Severity | Status |
|---|---|---|
| Migration 061 not yet applied to production DB | HIGH | **Pending** — must be run in Supabase SQL Editor before OFX imports will stage correctly |
| Banks exporting OFX with non-UTF-8 encoding (e.g. CP1252) | MEDIUM | Parser uses `buffer.toString('utf8')` — most South African OFX is ASCII-safe. If encoding issues emerge, add `iconv-lite` conversion |
| OFX files with `<INVSTMTTRN>` (investment) instead of `<STMTTRN>` | LOW | Parser targets bank `<STMTTRN>` only. Investment transactions would return 0 results with a clear error message |
| Per-transaction running balance not in OFX standard | LOW | `balance` field is null per transaction; `closingBalance` from LEDGERBAL is surfaced separately |
| CHECKNUM used as `reference` (not FITID) | LOW | FITID is always the deduplication key; CHECKNUM is stored separately as `reference` |

### Required deployment step

**Before using OFX import in production, run migration 061:**

```sql
-- Run in Supabase SQL Editor
-- File: database/migrations/061_ofx_import_source.sql
```

This drops and recreates the `import_source` CHECK constraint to include 'ofx'. Without it, staging inserts for OFX files will fail with a constraint violation.

---

## 9. Final Safety Check

| Requirement | Status |
|---|---|
| OFX imports to staging only (not directly to bank_transactions) | ✅ Confirmed |
| No GL journals created by OFX import | ✅ Confirmed — only allocation creates journals |
| Company scoping enforced | ✅ bankAccountId verified against req.user.companyId |
| CSV/PDF/Image imports unaffected | ✅ Zero changes to their parse or staging paths |
| No business data in browser storage | ✅ ofxParseResult lives only in JS memory |
| FITID used as externalId for dedup hard-skip | ✅ Confirmed |
| Batch-level file hash duplicate check | ✅ Same DuplicateDetectionService.detectBatchDuplicate() call as PDF |
