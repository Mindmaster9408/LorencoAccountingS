# PDF Bank Statement Import — Architecture & Guide

> Created: March 2026
> Status: First version implemented (text-based PDFs, 5 SA banks)

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:    Bank Transactions import flow (Accounting app)
- Files/services involved:
    backend/modules/accounting/routes/bank.js      (new /import/pdf route)
    backend/sean/pdf-statement-import-service.js   (new PDF pipeline service)
    backend/sean/pdf-statement-parsers/            (new parser directory)
    frontend-accounting/bank.html                  (import modal extended)
    backend/package.json                           (pdf-parse added)
    backend/tests/pdf-statement-import.test.js     (new test file)
- Current behaviour identified:
    Import accepts CSV/Excel only. PDFs accepted as visual attachments only.
- Required behaviours to preserve:
    CSV import flow (3-step wizard) fully preserved and unchanged.
    Existing /api/bank/import endpoint unchanged — PDF import calls it for final save.
    Duplicate detection (external_id + fuzzy) preserved and extended to PDF.
    Status defaults (unmatched), reconciliation flow, and journal allocation unchanged.
- Risk of regression:     Low — PDF support added alongside CSV, not replacing it.
- Related dependencies:   /api/bank/accounts (for bank account selector in modal)
- Safe implementation approach:
    Parse-only endpoint returns structured data for review.
    User reviews + confirms before anything is written to the database.
    Actual write goes through the existing /api/bank/import endpoint.
```

---

## 1. Import Flow Overview

```
User clicks "Import Statement"
    └─ Modal opens (Step 1)
         ├─ [CSV mode]   → Column mapping (Step 2) → Confirm → /api/bank/import
         └─ [PDF mode]   → POST /api/bank/import/pdf (parse only)
                              └─ Review parsed transactions (Step 2 PDF)
                                   └─ Select / deselect rows (duplicates pre-flagged)
                                        └─ Confirm → /api/bank/import (existing endpoint)
```

The PDF route does **not** write to the database. It only parses and returns structured transactions for the user to review before confirming import.

---

## 2. Supported PDF Statement Types

| Bank           | Parser ID          | Date Format   | Amount Format        | Status       |
|----------------|--------------------|---------------|----------------------|--------------|
| FNB            | `fnb-v1`           | DD/MM/YYYY    | Single signed column | ✅ Supported  |
| ABSA           | `absa-v1`          | DD/MM/YYYY    | Debit / Credit cols  | ✅ Supported  |
| Standard Bank  | `standardbank-v1`  | YYYY/MM/DD    | Debit / Credit cols  | ✅ Supported  |
| Nedbank        | `nedbank-v1`       | DD/MM/YYYY    | Debit / Credit cols  | ✅ Supported  |
| Capitec        | `capitec-v1`       | YYYY-MM-DD    | Single signed column | ✅ Supported  |
| Unknown/Other  | `generic-v1`       | Any above     | Heuristic            | ⚠️ Limited   |

**Important limitations:**
- Text-based PDFs only. Scanned (image-based) PDFs are not supported.
- Bank auto-detection is based on the document header (first ~800 characters).
- Generic parser is a best-effort fallback — always review results before importing.
- Standard Bank debit/credit column assignment is heuristic-based for ambiguous rows.

---

## 3. Parser Architecture

### Directory structure

```
backend/sean/pdf-statement-parsers/
├── base-parser.js          Shared utilities (parseDate, parseAmount, isPageNoise, ...)
├── fnb-parser.js           FNB-specific parser
├── absa-parser.js          ABSA-specific parser
├── standard-bank-parser.js Standard Bank parser
├── nedbank-parser.js       Nedbank parser
├── capitec-parser.js       Capitec parser
├── generic-parser.js       Generic fallback parser
└── parser-registry.js      Central registry + selection logic

backend/sean/pdf-statement-import-service.js   Pipeline orchestrator
```

### Parser contract (base-parser.js)

Every parser must implement:

```javascript
static canParse(text: string): { confidence: number (0–1), details: object }
static parse(text: string, filename: string): ParseResult
```

`ParseResult`:
```javascript
{
  bank: string,
  parserId: string,
  accountNumber: string|null,
  statementPeriod: { from: string|null, to: string|null },
  transactions: [{ date, description, reference, amount, balance, rawLine }],
  warnings: string[],
  skippedLines: number
}
```

### Parser selection (registry)

1. `canParse()` is called on all registered parsers
2. Only the **header section (first 800 chars)** is used for bank identification — prevents false positives from transaction descriptions
3. Parser with highest confidence ≥ 0.40 wins
4. Below 0.40, the generic fallback parser is used

---

## 4. Text Extraction Strategy

The system uses **`pdf-parse`** (npm) for direct text extraction from PDF binary.

- Returns full text of all pages as a single string
- Text lines correspond roughly to table rows in well-formed bank PDFs
- Columns are not positionally preserved — parsers use regex patterns on each line

### Scanned PDF detection

If the extracted text has < 100 characters or < 20 words, the PDF is considered
a scanned (image-based) document. The user receives a clear error message directing
them to export as CSV or contact their bank for a text-based PDF.

OCR support is **not** in scope for first version. The architecture supports adding
it later by plugging in a pre-processing step that converts scanned images to text
before parser selection.

---

## 5. Data Extraction Rules

The following lines are **always skipped** (not imported as transactions):
- Opening balance lines
- Closing balance lines
- Balance brought/carried forward lines
- Totals, subtotals, fee summaries
- Page headers and footers (Page X of Y)
- Column header rows (Date, Description, Amount, Balance)

Amount sign convention (matches `bank_transactions.amount`):
- **Positive** = money in (credit / deposit)
- **Negative** = money out (debit / payment)

---

## 6. Duplicate Detection

Two layers of duplicate checking:

| Layer         | Method                                                        | When checked         |
|---------------|---------------------------------------------------------------|----------------------|
| Exact match   | `external_id` = `pdf-{date}-{amount_cents}-{desc_prefix_20}` | At parse time        |
| Fuzzy match   | Same date + amount within R0.01 + same first 30 chars of desc | At parse time        |

Rows flagged as duplicates are:
- Shown in the review table with an orange **DUPLICATE** badge
- Highlighted in yellow
- Pre-deselected (checkbox unchecked) by default

The user can override and include duplicates by re-checking the checkbox before confirming.

---

## 7. Review / Import Process

1. User selects PDF and bank account → clicks "Parse PDF →"
2. Frontend POSTs to `POST /api/bank/import/pdf` (multipart)
3. Backend returns parsed transaction list (no DB write yet)
4. User sees a review table with:
   - Date, Description, Money In, Money Out, Balance
   - Duplicate indicators
   - Parser warnings if any
   - Bank detection confidence
5. User checks/unchecks rows → clicks "Next: Confirm Import →"
6. Summary shown (count, totals, net)
7. User clicks "Import Transactions"
8. Frontend POSTs to `POST /api/bank/import` (existing endpoint)
9. Transactions saved with `status = 'unmatched'` and `external_id` for future dedup

---

## 8. API Reference

### `POST /api/bank/import/pdf`

Parse a PDF bank statement. Returns structured transactions for review.

**Request:** `multipart/form-data`
| Field          | Type    | Required | Description                                             |
|----------------|---------|----------|---------------------------------------------------------|
| `file`         | File    | Yes      | PDF bank statement (max 20 MB)                          |
| `bankAccountId`| Number  | No       | If provided, enables duplicate detection against DB     |

**Response 200:**
```json
{
  "success": true,
  "bank": "FNB",
  "parserId": "fnb-v1",
  "parserConfidence": 0.75,
  "isGenericFallback": false,
  "accountNumber": "62012345678",
  "statementPeriod": { "from": "2026-01-01", "to": "2026-01-31" },
  "transactions": [
    {
      "date": "2026-01-02",
      "description": "PAYMENT RECEIVED JOHN DOE",
      "reference": null,
      "amount": 5000.00,
      "moneyIn": 5000.00,
      "moneyOut": null,
      "balance": 10000.00,
      "isDuplicate": false,
      "duplicateId": null,
      "externalId": "pdf-2026-01-02-500000-paymentreceivedj"
    }
  ],
  "duplicateCount": 0,
  "warnings": [],
  "skippedLines": 2,
  "importedAt": "2026-03-13T09:15:00.000Z"
}
```

**Response 422 (parse failure / scanned PDF):**
```json
{
  "error": "This appears to be a scanned (image-based) PDF...",
  "isPdfScanned": true,
  "warnings": []
}
```

---

## 9. Limitations of First Version

| Limitation                            | Impact                                      | Future path                              |
|---------------------------------------|---------------------------------------------|------------------------------------------|
| Text-based PDFs only                  | Scanned statements unsupported              | Add tesseract.js OCR pre-processor       |
| 5 SA banks (+ generic)                | Other banks use generic fallback            | Add parser module per bank               |
| Debit/credit heuristic for Std Bank   | Sign may be wrong for ambiguous rows        | Use PDF column positions via pdfjs-dist  |
| No multi-page amount pagination       | Large statements work but pages merged      | No action needed (pdf-parse handles it)  |
| Generic parser accuracy is lower      | User must review carefully                  | Train layout detector on real samples    |

---

## 10. How to Add a New Bank Statement Parser

1. Create `backend/sean/pdf-statement-parsers/{bank-name}-parser.js`
2. Extend `BaseParser`:

```javascript
const BaseParser = require('./base-parser');

class MyBankParser extends BaseParser {
  static get PARSER_ID() { return 'mybank-v1'; }
  static get BANK_NAME() { return 'My Bank'; }

  static canParse(text) {
    const header = text.slice(0, 800).toLowerCase();
    let score = 0;
    if (header.includes('my bank')) score += 0.6;
    return { confidence: score, details: {} };
  }

  static parse(text, filename) {
    const result = this.emptyResult(this.BANK_NAME, this.PARSER_ID);
    // ... parse logic ...
    return result;
  }
}

module.exports = MyBankParser;
```

3. Register in `parser-registry.js`:
```javascript
const MyBankParser = require('./mybank-parser');
const PARSERS = [
  // ... existing parsers ...
  MyBankParser,
  GenericParser  // always last
];
```

No other files need to change.

---

## 11. Testing

Tests are in `backend/tests/pdf-statement-import.test.js`.

Coverage:
- BaseParser utility methods (parseDate, parseAmount, isPageNoise, startsWithDate)
- All 5 bank parsers: detection + parse (date normalisation, amount signs, skipped lines)
- Generic parser fallback
- Parser registry selection logic
- PdfStatementImportService enrichment (moneyIn/moneyOut split, externalId, duplicate count)
- Scanned PDF / non-PDF error handling

Run: `npx jest tests/pdf-statement-import.test.js --runInBand`
