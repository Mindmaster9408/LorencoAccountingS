# Ecosystem — Client Import from Registration PDF

## Overview

The PDF import feature allows accounting practice users to upload a CIPC / company registration document and have company details extracted and prefilled into the new client registration form, eliminating manual data entry.

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:       Ecosystem client onboarding (Add Client flow)
- Files/services involved:
    frontend-ecosystem/dashboard.html            — UI entry point, import modals, JS flow
    backend/shared/routes/pdfImport.js           — PDF upload, extract, duplicate check API
    backend/shared/routes/eco-clients.js         — duplicate check on POST, extra field passthrough
    backend/services/documentParsers/cipcParser.js — CIPC text extraction logic
    backend/services/documentParsers/index.js    — extensible parser registry
    backend/config/accounting-schema.js          — auto-applies new companies columns on startup
    backend/config/migrations/010_company_registration_import.sql — DB migration
    backend/server.js                            — mounts /api/import routes

- Current behaviour identified:
    Add Client button directly opens manual entry form.
    eco-clients POST has no duplicate registration number check.
    Auto-created company record receives only name + modules_enabled.

- Required behaviours to preserve:
    Manual client entry flow completely unchanged — same form, same saveNewClient().
    Practice-to-client linking (company_id / client_company_id) unchanged.
    All existing eco_client fields preserved.
    App sync (POS/Payroll) on creation unchanged.

- Duplicate/incorrect-data risk:
    LOW — import only prefills the form. User reviews before saving.
    Duplicate check added but bypass possible with user confirmation (force: true).
    Scanned PDF produces lower-quality extraction — user warned.

- Safe implementation plan:
    Import flow is purely additive — it just prefills the existing form.
    saveNewClient() unchanged except: (a) include extra fields if present,
    (b) handle 409 duplicate response gracefully.
    Parser returns null for fields it cannot find — never invents data.
```

---

## Current Onboarding Flow (Pre-Import)

1. User clicks "Add Client" → manual form opens
2. Fields: name, type, email, phone, ID/reg number, address, apps, notes
3. `POST /api/eco-clients` → creates eco_client + auto-creates isolated company
4. Syncs to selected apps (POS customers, Payroll employees)

---

## Import Flow Overview

```
Add Client clicked
        ↓
showImportChoice() — choice dialog
        ├── "Add Manually" → existing showAddClient() (unchanged)
        └── "Import from PDF"
                ↓
        importPdfModal — Step 1: Upload
                ↓
        POST /api/import/pdf-extract
                ↓
        importPdfModal — Step 2: Review extracted fields
                ↓  (user confirms)
        showAddClient() with prefilled form values
                ↓  (user reviews/edits, submits)
        saveNewClient() → POST /api/eco-clients (unchanged)
```

---

## Fields Extracted (v1)

| Field | Source | Confidence | Notes |
|-------|--------|------------|-------|
| `company_name` | Labeled field (`Enterprise Name:`, `Name of Company:`) | high / medium | High when reg number also found |
| `registration_number` | Pattern match `YYYY/NNNNNN/NN` | high | Very specific SA format |
| `company_type` | Labeled field OR inferred from text | medium / low | Inferred from (Pty) Ltd, CC, NPC etc. |
| `registration_date` | Labeled field (`Date of Registration:`) | medium | Normalized to ISO YYYY-MM-DD |
| `address` | Labeled field (`Registered Office:`, `Physical Address:`) | medium | Multi-line collapsed to single |
| `directors` | `Director N:`, `Member N:` patterns | low | Names only, no ID numbers |

**Confidence levels:**
- `high` — specific format matched, very reliable
- `medium` — labeled field found, but spelling/format may vary
- `low` — inferred or extracted from unlabeled text
- `not_found` — field absent or unparseable

---

## Review / Confirmation Rules

1. All extracted fields are shown with confidence badges
2. `not_found` fields are shown as "Not found — fill manually"
3. Duplicate warning shown if matching reg number exists in practice
4. User can accept all fields, then edit freely in the form
5. **No save happens until the user submits the standard form**
6. The import only prefills — it does not bypass any validation

---

## Duplicate Detection Rules

**On PDF extraction** (`POST /api/import/pdf-extract`):
- Checks `eco_clients.id_number` for current practice's clients
- Checks `eco_clients.name` (case-insensitive) if no reg-number duplicate found
- Returns `duplicate: [...]` array — shown as warning in review step
- Does NOT block the user

**On final save** (`POST /api/eco-clients`):
- Checks `id_number` against existing clients in practice
- Returns HTTP 409 `{ code: 'DUPLICATE_REG_NUMBER', duplicate: [...] }` if found
- Frontend shows confirm dialog — user can force-proceed with `force: true`
- Does NOT create silent duplicates

---

## PDF Extraction Pipeline

```
1. multer receives PDF buffer (memory storage — no disk write)
2. pdf-parse extracts text from digital/text-based PDF (fast)
3. If pdf-parse returns < 80 chars → fall back to OcrService (tesseract)
4. If OCR unavailable + text too short → return 422 SCANNED_PDF_UNSUPPORTED
5. parseDocument() dispatches to cipcParser
6. cipcParser runs regex patterns against text
7. Returns fields + confidence + isCipcDocument flag
8. Duplicate check against eco_clients
9. Return full result to frontend
```

---

## Parser Architecture

### Registry (`services/documentParsers/index.js`)

```javascript
// Auto-detect:
const result = parseDocument(text);

// Specific parser:
const result = parseDocument(text, 'cipc');

// List parsers:
const parsers = listParsers(); // [{ id: 'cipc', name: 'CIPC / SA Company Registration' }]
```

### Adding a New Parser

1. Create `backend/services/documentParsers/myParser.js`
2. Export: `PARSER_ID`, `PARSER_NAME`, `parse(text) → { fields, confidence, isRecognized }`
3. Register in `index.js`:
   ```javascript
   const myParser = require('./myParser');
   const PARSERS = new Map([
     [cipcParser.PARSER_ID, cipcParser],
     [myParser.PARSER_ID, myParser],
   ]);
   ```

### Planned Future Parsers
- `bcirsRegNotice` — SARS registration notice (for tax ref numbers)
- `vatRegConfirmation` — SARS VAT registration letter
- `trustDeed` — Trust deed summary
- `bankLetter` — Bank confirmation letter (account details)

---

## API Endpoints

### `POST /api/import/pdf-extract`
Upload and parse a registration PDF.

**Request:** `multipart/form-data`, field name `pdf`
**Optional field:** `parser_id` (default: auto-detect)

**Response:**
```json
{
  "parserId": "cipc",
  "parserName": "CIPC / SA Company Registration",
  "recognized": true,
  "fields": {
    "company_name": "ACME TRADING (PTY) LTD",
    "registration_number": "2022/123456/07",
    "company_type": "Private Company (Pty) Ltd",
    "registration_date": "2022-03-15",
    "address": "123 Main Street, Sandton, 2196",
    "directors": ["JOHN SMITH", "JANE DOE"]
  },
  "confidence": {
    "company_name": "high",
    "registration_number": "high",
    "company_type": "medium",
    "registration_date": "medium",
    "address": "medium",
    "directors": "low"
  },
  "extractionMethod": "pdf-text",
  "extractedTextLength": 1245,
  "pageCount": 1,
  "duplicate": null,
  "warnings": []
}
```

### `GET /api/import/check-duplicate?reg_number=2022/123456/07&name=Acme`
Check for existing clients by registration number or name.

### `GET /api/import/parsers`
List available document parsers.

---

## Database Changes (Migration 010)

Run `backend/config/migrations/010_company_registration_import.sql` in Supabase SQL Editor:

```sql
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS registration_date DATE;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS directors JSONB DEFAULT '[]'::JSONB;

ALTER TABLE eco_clients
  ADD COLUMN IF NOT EXISTS import_source VARCHAR(50) DEFAULT NULL;
```

These columns are also auto-applied by `accounting-schema.js` on server startup when `DATABASE_URL` is set (companies columns only).

**What each stores:**
- `companies.registration_date` — date from CIPC certificate
- `companies.directors` — JSON array of extracted director names: `["John Smith", "Jane Doe"]`
- `eco_clients.import_source` — `'pdf-import'` | `'manual'` | `null` (legacy)

---

## Limitations (v1)

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Text-based PDFs only (reliable) | Scanned/image PDFs produce poor results | User warned; will fall back to OCR if tesseract available |
| English-only parsing | Afrikaans CIPC docs may have different field labels | Most CIPC official docs are bilingual or English |
| Director extraction is low-confidence | Names may include non-names or miss some directors | Always review before saving; directors field is review-only |
| No ID number extraction for directors | Director SA ID numbers not extracted | Manual entry needed |
| Registration date parsing is best-effort | Non-standard date formats may fail | User can correct in form |

---

## Testing

**Test file:** `backend/tests/documentParsers.test.js`

```bash
cd accounting-ecosystem/backend
npx jest tests/documentParsers.test.js
# 37 tests — all passing
```

Test coverage:
- Standard CoR14.3 CIPC document extraction
- Close Corporation (CK) document extraction
- Non-CIPC document (not recognized, graceful fallback)
- Minimal text (reg number only)
- Address extraction without labeled company name
- Field safety (empty text → all null, never invents data)
- Registration number format validation
- Parser registry auto-detection
- Confidence value validation

---

## Follow-up / Future Improvements

```
FOLLOW-UP NOTE
- Area: Director extraction accuracy
- What was done: Regex patterns for Director N: / Member N: labels
- What still needs checking: Some CIPC docs list directors in tables
  without "Director:" labels — these will miss
- Risk if not checked: Directors field stays empty for table-format docs
- Recommended next check: When a user reports missing directors, sample
  that PDF and add a new regex pattern to cipcParser.js

FOLLOW-UP NOTE
- Area: Scanned PDF support
- What was done: Falls back to OcrService (tesseract) if pdf-parse fails
- What still needs checking: Tesseract + pdftoppm must be installed in
  the Zeabur Docker image for scanned PDFs to work
- Risk if not checked: Scanned PDFs return 422 (handled gracefully)
- Recommended next check: Add to Dockerfile: apk add tesseract-ocr
  tesseract-ocr-data-eng poppler-utils (already in ocr-service docs)

FOLLOW-UP NOTE
- Area: eco_clients.import_source column
- What was done: Column added in migration 010, backend sends value
- Not yet confirmed: Migration 010 has been run in production Supabase
- Risk if not checked: Column may not exist → Supabase ignores unknown
  columns on insert (graceful), but import_source will not be stored
- Recommended next check: Run migration 010 in Supabase SQL Editor
```
