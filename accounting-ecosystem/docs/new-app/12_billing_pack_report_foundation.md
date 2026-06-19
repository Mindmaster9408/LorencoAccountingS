# CODEBOX 12 — BILLING PACK PDF / CLIENT BILLING REPORT FOUNDATION

**App:** Lorenco Practice Management
**Codebox:** 12 of ±80
**Date:** June 2026
**Status:** Code complete — apply migration 063 in Supabase before using

---

## 1. Summary

Codebox 12 builds readable billing pack reports for internal partner review, available in three formats: structured JSON, printable HTML, and downloadable PDF. This is the layer between WIP management (Codebox 11) and future invoice generation (Codebox 13+).

**What was built:**
- Migration 063: 3 new tracking columns on `practice_billing_packs`
- `GET /api/practice/billing/packs/:id/report-data` — full structured JSON report
- `GET /api/practice/billing/packs/:id/report-html` — self-contained printable HTML
- `GET /api/practice/billing/packs/:id/report-pdf` — PDF via PDFKit (already installed)
- `buildReportData()` shared backend helper (used by all three report endpoints)
- Realization % stat in billing pack detail modal
- "View Report" and "Download PDF" buttons in pack detail modal
- `.realization-good/ok/low` CSS classes in practice.css

**What was NOT built (excluded by CLAUDE.md permanent rules):**
- Invoice generation (Codebox 13+)
- Accounting app integration
- Client-facing invoice delivery
- Sean AI
- Cross-app integrations

---

## 2. Database Changes (migration 063)

### `practice_billing_packs` — 3 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `report_generated_at` | TIMESTAMPTZ | NULL | When a report was last generated for this pack |
| `report_generated_by` | INTEGER | NULL | User ID who last generated a report |
| `report_version` | INTEGER | 1 (NOT NULL) | Version counter — incremented by recalculate; used as report watermark |

These columns are informational only. They do not affect the pack lifecycle or billing calculations.

---

## 3. Report Architecture

### `buildReportData(companyId, packId)`

Internal async helper function called by all three report endpoints. Returns a structured data object or `null` if the pack doesn't exist.

**Data fetched (parallel where safe):**
1. Pack lines (base columns only — manual JS join avoids PostgREST FK dependency)
2. Time entries `IN (line.time_entry_ids)` — filtered by `company_id`
3. Tasks `IN (line.task_ids)` — filtered by `company_id`
4. Workflow runs `IN (line.run_ids)` — filtered by `company_id`
5. Client from `practice_clients` — ownership verified via `company_id`
6. Practice profile from `practice_profiles`
7. Company name from `companies`
8. Team members `IN (user_ids from time entries)` — for display names

**Why manual JS join instead of Supabase embedded query:**
`practice_billing_pack_lines.time_entry_id` has no FK constraint defined. PostgREST cannot auto-resolve relationships without a FK. Fetching separately via `IN` queries and joining in JavaScript is safe and avoids silent join failures.

### Report data structure

```json
{
  "practice": { "name", "email", "phone", "address_line1", "address_city", ... },
  "client":   { "id", "name", "email", "vat_number", "registration_number", ... },
  "pack":     { "id", "pack_name", "pack_number", "period_start", "period_end", "status", "notes", "proposed_invoice_value", "report_version" },
  "lines":           [ /* all enriched lines */ ],
  "included_lines":  [ /* line_status = 'included' */ ],
  "written_off_lines": [ /* line_status = 'written_off' */ ],
  "excluded_lines":  [ /* line_status = 'excluded' */ ],
  "staff_breakdown": [ { "name", "hours", "recoverable_value", "billable_value", "entry_count" } ],
  "task_breakdown":  [ { "task", "hours", "billable_value", "entry_count" } ],
  "totals": {
    "total_hours", "billable_hours", "non_billable_hours",
    "total_lines", "included_count", "written_off_count", "excluded_count",
    "recoverable_value", "writeoff_value", "excluded_value", "billable_value",
    "proposed_invoice_value", "realization_percentage", "writeoff_percentage"
  }
}
```

### Realization calculation

```
realization_percentage = (billable_value / recoverable_value) * 100
writeoff_percentage    = (writeoff_value  / recoverable_value) * 100
excluded_value         = SUM(recoverable_value of excluded lines)
```

Edge case: if `recoverable_value = 0` and `billable_value > 0`, realization = 100%.
Edge case: if both are 0, realization = 0%.

---

## 4. Report Formats

### JSON (`/report-data`)

Returns the full structured report object for programmatic use. Used by the frontend stat display and for future integrations.

Stamps `report_generated_at` and `report_generated_by` on the pack.

### HTML (`/report-html`)

Returns a self-contained, printable HTML document:
- No external CSS or JS dependencies
- All styles inline via `<style>` block
- `@page { size: A4 }` for proper print sizing
- "Print / Save PDF" button visible on screen, hidden when printing (`@media print`)
- Light theme (professional, printable — opposite of the dark app UI)
- Sections: practice header, client + pack meta, 4 summary stat cards, included lines table, written-off table (if any), excluded table (if any), staff breakdown, task breakdown, notes, footer

The HTML report is opened in a new browser tab via `window.open()` with the HTML written directly — no external URL, no token in query string.

### PDF (`/report-pdf`)

Generated using PDFKit (already installed: `pdfkit@0.13.0`). Follows the same pattern established in `shared/routes/billing-report.js`.

Sections (same as HTML):
- Header with practice name and accent bar
- Client + pack meta grid
- 4 summary stat cards (Billable Value, Realization %, Written Off, Total Hours)
- Proposed invoice value callout (if set)
- Included lines table with totals footer
- Written-off lines table with totals footer (if any)
- Staff breakdown table
- Task breakdown table (if any)
- Notes block (if any)
- Page footer with generated timestamp and version

PDF is streamed directly to the response (`doc.pipe(res)`) — no temp files.

---

## 5. Backend API

| Method | Path | Description |
|---|---|---|
| GET | `/api/practice/billing/packs/:id/report-data` | Structured JSON report |
| GET | `/api/practice/billing/packs/:id/report-html` | Printable HTML document |
| GET | `/api/practice/billing/packs/:id/report-pdf` | PDF download via PDFKit |

### Multi-tenant safety
- `fetchPack(companyId, packId)` verifies pack ownership before any data is assembled
- All time entry / task / workflow run lookups additionally filter `company_id = req.companyId`
- Client lookup filters `company_id = req.companyId`
- No data from other companies is ever included in any section

### Audit logging
- `billing_report_viewed` — logged on `report-data`
- `billing_report_generated` — logged on `report-html` and `report-pdf`

---

## 6. Frontend Changes

### billing.html

Added:
- `.realization-good/ok/low` CSS classes (in page `<style>` block)
- `.report-action-row` and `.report-action-label` CSS classes
- `#packReportRow` — report action row between pack summary and edit fields
- `#pdViewReportBtn` — View Report button
- `#pdDownloadPdfBtn` — Download PDF button

### js/billing.js

Added:
- `statCls(value, label, cls)` — stat card variant with CSS class (for realization %)
- Realization % calculation in `renderPackDetail()`:
  - `realizPct = rv > 0 ? round(bv/rv*100) : ...`
  - `realizCls` set to `realization-good/ok/low` based on threshold (90%, 70%)
  - Displayed as 7th stat card in pack detail summary
- `viewReport()` — fetches `/report-html` with auth bearer token, opens new window, writes HTML
- `downloadPdf()` — fetches `/report-pdf` with auth bearer token, creates blob URL, triggers `<a>` download, revokes URL after 15s

**localStorage access in viewReport/downloadPdf:**
```javascript
var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
```
This reads the auth token only. Permitted by Rule D2 (auth tokens in browser storage are allowed). No business data is read from or written to browser storage.

### practice.css

Added `.realization-good/ok/low` to shared stylesheet so the classes are available to any future page that needs to display realization metrics.

---

## 7. HTML vs PDF Decision

| | HTML | PDF |
|---|---|---|
| Generation | Template literals in Node.js | PDFKit streaming |
| Dependencies | None (built-in) | PDFKit (already installed) |
| Best for | Quick review, browser print-to-PDF | Archival, email attachment |
| Print quality | Good (browser print) | Excellent (PDFKit layout control) |
| Implementation | 200 lines template | 150 lines PDFKit drawing |

Both are implemented. PDFKit was already installed (used in `shared/routes/billing-report.js`) so adding PDF generation added zero new dependencies.

---

## 8. localStorage / KV Audit Result

**CLEAN — no violations.**

| Location | Usage | Permitted? |
|---|---|---|
| `billing.js` `viewReport()` | `localStorage.getItem('token')` — auth token read | Yes (Rule D2) |
| `billing.js` `downloadPdf()` | `localStorage.getItem('token')` — auth token read | Yes (Rule D2) |
| `billing.js` `api.js` pattern | `localStorage.getItem('token')` — auth token read | Yes (Rule D2) |
| `layout.js` | `localStorage.getItem('company')` — company display name | Yes (UI preference) |

No report data, totals, client data, or billing pack data written to browser storage at any point.

---

## 9. Future Invoice Readiness

The report system provides a stable foundation for invoicing:

- `buildReportData()` returns all data needed to populate a tax invoice
- `totals.billable_value` or `totals.proposed_invoice_value` → invoice total (excl. VAT)
- `practice.vat_number` → invoice header
- `client.vat_number` → buyer section
- `included_lines` → line items
- `pack.period_start` / `pack.period_end` → invoice period
- The `locked` pack status + `report_generated_at` provide the audit trail

Codebox 13 (Billing Pack Numbering + Billing Controls) can build on top of this without changing any data structures from Codebox 12.

---

## 10. Manual Tests

1. Open a locked or approved billing pack → "View Report" and "Download PDF" buttons appear
2. Click "View Report" → new tab opens with professional HTML report
3. Verify: practice name, client name, pack name, all lines shown
4. Verify: totals match pack detail modal values
5. Verify: write-off section appears only if there are written-off lines
6. Click "Print / Save PDF" in the report tab → browser print dialog opens
7. Click "Download PDF" → `.pdf` file downloads
8. Open downloaded PDF → all sections rendered correctly
9. Verify realization % in pack detail modal (green ≥90%, amber ≥70%, red <70%)
10. Check Supabase: `practice_billing_packs.report_generated_at` updated after report view
11. Check audit log: `billing_report_viewed` and `billing_report_generated` entries exist
12. Cross-company: log in as different company → `/report-data` returns 404 for other company's packs
13. DevTools → Application → Local Storage → no report/billing data stored

---

## 11. Recommended Codebox 13

**Billing Pack Numbering + Billing Controls**

Before any invoice generation, the practice needs:
- Sequential billing pack numbering per company (`BILL-2026-001`, etc.)
- `pack_number` auto-assigned on pack creation or on approval
- Lock guard: prevent locking if billable_value = 0
- Minimum line count before approval
- Billing period validation (period_end >= period_start)
- Pack status history / change log
- Bulk approve multiple packs
