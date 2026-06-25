# Codebox 62 — Product Import Engine
## Checkout Charlie — Workstream 17

**Status:** Implemented  
**Date:** 2026-06-25  
**Scope:** Bulk product import (CSV + XLSX) for Checkout Charlie POS  
**Permission gate:** `PRODUCTS.CREATE` — management roles only  

---

## 1. Architecture

```
User uploads file
      │
      ▼
Frontend parses with XLSX.js
{ raw: true, defval: '' }           ← no date/type auto-conversion
      │
      ▼
Column mapping UI
Auto-map via alias table + user override
      │
      ▼
POST /api/pos/import/preview        ← read-only, classifies rows
  - Batch lookup: barcodes + codes against products table
  - Intra-file duplicate detection
  - Category / supplier resolution
  - Returns annotated rows: new | update | skip | error
      │
      ▼
User reviews preview + confirms
      │
      ▼
POST /api/pos/import/execute        ← writes to DB
  - Re-classifies server-side (never trusts client state)
  - Auto-creates categories / suppliers (if opted in)
  - Batch INSERT in chunks of 200
  - Parallel UPDATE in waves of 20
  - PRODUCT_IMPORT audit event (pos_audit_events + audit_log)
  - Returns: created / updated / skipped / failed + error list
      │
      ▼
Summary screen
  - Counts: Created / Updated / Skipped / Failed
  - Duration
  - Download failed rows as CSV
```

---

## 2. Files Created / Modified

| File | Type | Purpose |
|------|------|---------|
| `accounting-ecosystem/frontend-pos/product-import.html` | **NEW** | Full 5-step import wizard |
| `accounting-ecosystem/backend/modules/pos/routes/import.js` | **NEW** | Backend preview + execute API |
| `accounting-ecosystem/backend/modules/pos/index.js` | **MODIFIED** | Register `/import` route |
| `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js` | **MODIFIED** | Add `PRODUCT_IMPORT` event constant |
| `accounting-ecosystem/backend/config/pos-schema.js` | **MODIFIED** | Add `brand VARCHAR(100)` column via `ALTER TABLE IF NOT EXISTS` |

---

## 3. API Endpoints

### `POST /api/pos/import/preview`
**Permission:** `PRODUCTS.CREATE`  
**Body:**
```json
{
  "rows": [{ "product_name": "...", "barcode": "...", ... }],
  "options": {
    "mode": "create_only | update_existing | create_and_update",
    "auto_create_categories": false,
    "auto_create_suppliers": false
  }
}
```
**Response:**
```json
{
  "preview": { "new_count": 42, "update_count": 5, "skip_count": 3, "error_count": 1, "total": 51 },
  "rows": [{ "product_name": "...", "_status": "new", "_errors": [], "_matched_id": null, "_category_id": 7 }],
  "categories_to_create": ["Electronics", "Clothing"],
  "suppliers_to_create": ["Main Supplier"]
}
```

### `POST /api/pos/import/execute`
Same body as preview.  
**Response:**
```json
{
  "created": 42,
  "updated": 5,
  "skipped": 3,
  "failed": 1,
  "errors": [{ "row": 15, "product_name": "...", "product_code": "...", "reason": "..." }],
  "duration_ms": 1840,
  "categories_created": 2,
  "suppliers_created": 0
}
```

---

## 4. Import Flow (5 Steps)

### Step 1 — Upload
- Drag-and-drop or file browse
- CSV and XLSX both supported (XLSX preferred)
- XLSX parsed with `{ raw: true, defval: '' }` — no date serial conversion
- Row count validated (max 10,000)
- Template CSV download available

### Step 2 — Column Mapping
- 15 target fields with alias auto-detection (30+ aliases per field)
- User can override any mapping via dropdown
- Required field (`product_name`) highlighted
- "Not mapped" shown for unmapped optional fields

### Step 3 — Import Options
- **Mode:** Create only / Update existing / Create + Update
- **Auto-create categories:** creates unknown categories from file
- **Auto-create suppliers:** creates unknown suppliers from file
- If unchecked: products imported without category/supplier assignment

### Step 4 — Preview
- Calls `/preview` endpoint — no data written
- Count cards: New / Update / Skip / Error
- Filterable row grid (all / new / updates / skipped / errors)
- Colour-coded rows: green = new, blue = update, grey = skip, red = error
- Error details shown inline per row
- Import blocked if zero actionable rows

### Step 5 — Done
- Animated progress during execute
- Final counts: Created / Updated / Skipped / Failed
- Duration displayed
- Failed rows table with reason
- Download failed rows as CSV

---

## 5. Supported Import Fields

| Field | Required | Notes |
|-------|----------|-------|
| `product_name` | **Yes** | Max 255 chars |
| `product_code` | No | Auto-generated `PRD-...` if missing |
| `barcode` | No | EAN/UPC; used for duplicate matching |
| `category` | No | Matched by name; auto-created if opted in |
| `brand` | No | Stored in new `products.brand` column |
| `supplier` | No | Auto-created if opted in (no FK on products) |
| `selling_price` | No | Must be ≥ 0 if present |
| `cost_price` | No | Must be ≥ 0 if present |
| `vat_rate` | No | Default 15%; must be 0–100 |
| `stock_quantity` | No | Default 0; must be ≥ 0 |
| `reorder_level` | No | Default 10 |
| `unit` | No | Default 'each' |
| `description` | No | Free text |
| `active` | No | Default true; accepts yes/no/true/false/1/0 |
| `notes` | No | Free text |

---

## 6. Validation Rules

**Per-row (frontend + backend):**
- `product_name` is required and ≤ 255 chars
- `selling_price` ≥ 0 if present
- `cost_price` ≥ 0 if present
- `vat_rate` between 0 and 100
- `stock_quantity` ≥ 0

**Intra-file (backend):**
- Duplicate barcode within the same file → error on second occurrence
- Duplicate product_code within the same file → error on second occurrence

**Against database (backend):**
- Barcode already exists → classified as update or skip (depending on mode)
- Product code already exists → classified as update or skip (depending on mode)

---

## 7. Duplicate Strategy

| Mode | Row has DB match | Row has no DB match |
|------|-----------------|---------------------|
| `create_only` | Skip | Create |
| `update_existing` | Update | Skip |
| `create_and_update` | Update | Create |

Matching priority: **barcode first**, then **product_code**.

---

## 8. Performance

| Rows | Expected time |
|------|--------------|
| 100  | < 1 s        |
| 500  | < 3 s        |
| 1 000 | < 6 s      |
| 5 000 | < 25 s     |

**Why it's fast:**
- Preview: 2 batch queries (barcodes + codes) regardless of row count, plus 2 small queries (categories, suppliers)
- Execute: batch INSERT of 200 rows per round-trip; parallel UPDATE in waves of 20
- No per-row API calls

---

## 9. Security

- Permission gate: `PRODUCTS.CREATE` — enforced by middleware on every request
- Company isolation: all DB queries filtered by `req.companyId` (from JWT; never trusted from client)
- Max rows: 10,000 hard limit (server-side check)
- No business data in browser storage: all state lives in JS variables in the page session
- Token: read from `localStorage.getItem('token')` (auth token — permitted per CLAUDE.md)
- Classification re-runs server-side on execute — client-side preview result is never trusted

---

## 10. Audit Trail

Every completed import fires two audit events:

1. **`posAuditLogger`** → `pos_audit_events` table, category `product`
2. **`auditFromReq`** → `audit_log` table, action `PRODUCT_IMPORT`

Both include: `total_rows, created, updated, skipped, failed, duration_ms, mode, categories_created, suppliers_created`.

---

## 11. Frontend URL

```
/pos/product-import.html
```

Access from the POS management panel. Auth-gated: redirects to `/pos/index.html` if no token found.

---

## 12. Future Enhancements

| Enhancement | Notes |
|-------------|-------|
| Brand FK table | Currently `brand` is a free-text column on products. A dedicated `brands` table with FK would allow brand management and filtering |
| Supplier product linking | Currently supplier is stored as text on the import but not linked to `product_suppliers` FK table |
| Import history log | A dedicated import history page showing past imports, counts, and downloadable error reports |
| Progress streaming | Server-Sent Events or WebSocket for true row-by-row progress on very large files |
| Duplicate merge preview | Show side-by-side before/after comparison for update-mode rows |
| Image column | Import a product image URL and fetch/store during import |
| Multi-sheet XLSX | Currently only the first sheet is parsed |
| Undo import | Soft-rollback of a completed import within a time window |

---

## 13. Regression Checklist

- [ ] Permission gate blocks cashier role
- [ ] Super admin and store_manager can access
- [ ] CSV file parses correctly (period/dates not converted to serials)
- [ ] XLSX file parses correctly
- [ ] `product_name` required — row with missing name shows error
- [ ] Duplicate barcode within file → second occurrence errors
- [ ] Duplicate barcode in DB → classified as skip (create_only mode)
- [ ] Negative selling price → validation error
- [ ] Create mode: existing products skipped
- [ ] Update mode: new products skipped
- [ ] Create + Update: both created and updated
- [ ] Auto-create category: new category appears after import
- [ ] Unknown category without auto-create: product imported, category blank
- [ ] Money fields (R 15,000.00 format) parsed correctly
- [ ] 1,000-row file imports without UI freeze
- [ ] Audit event logged in pos_audit_events
- [ ] No `localStorage.setItem` for business data anywhere in page
- [ ] Error download CSV works correctly
- [ ] "Import another file" resets all state cleanly
