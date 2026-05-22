# Workstream 16 — Cashup History Reports + Universal Report Printing
**Status:** Implemented  
**Date:** 2026-05-22  
**Workstream:** 16

---

## What Was Built

### Part 1 — Cashup History Report

A new `Reports → Cash-Up History → Cashup History` section gives managers a complete historical view of every cashup ever performed.

**Backend endpoint added:**
```
GET /api/pos/reports/cashup-history
```

**Data source:** `pos_recon_snapshots` exclusively — all values are immutable, frozen at time of cashup. No recalculation occurs.

**Columns displayed:**
- Date (session opened)
- Till name/number
- Cashier name
- Session status (Cashed Up / Force Closed)
- Sale count
- Gross sales
- Cash payments
- Card/EFT combined
- Refunds (count × amount)
- Expected cash in drawer
- Counted cash
- Variance (color-coded: red = short, amber = over, green = exact)
- Actions: View (expand detail) | Print

**Filters supported:**
| Filter | Implementation |
|--------|----------------|
| Date range | Server-side via `session_opened_at` bounds |
| Variance only | Client-side checkbox — hides zero-variance rows |
| Force-closed only | Client-side checkbox |
| Cashier/till search | Client-side text filter across cashier name and till name |

**Inline detail expansion:**
Clicking "View" on any row expands a 4-column detail panel showing full session info, sales summary, payment breakdown, and cash reconciliation — all from the immutable snapshot.

---

### Part 2 — Cashup Print Format

Each cashup row has a `🖨 Print` button. Clicking it builds a full formal cashup printout document and opens it in a browser popup for printing.

**Print document sections:**
1. Company header + report title + badges (Force Closed / Manual Snapshot)
2. Session Details — till, session #, cashier, snapshot #, opened/closed times
3. Sales Summary — transactions, gross, discounts, VAT, voids, refunds, net sales
4. Payment Breakdown — cash, card, EFT, account, other
5. Cash Reconciliation — opening float → cash sales → cash refunds → expected → counted → variance
6. Operational Flags — integrity check result, force-close indicator, snapshot immutability notice
7. Footer — printed by, printed at, system name

**Immutability guarantee:**  
The print document is built from the `pos_recon_snapshots` row loaded at report time. Values are never recalculated from live sales data. The snapshot ID is printed on the document for audit reference.

**Popup blocker safe:**  
Uses the same popup + silent iframe fallback pattern as `printBrowserReceipt()`. If popup is blocked, the page prints via an invisible in-page iframe.

---

### Part 3 — Universal Report Print Button

A `🖨 Print` button was added to the report toolbar alongside "Generate Report" and "Export CSV". It works for every report in the system.

**Reports with Print support:**
- Gross Profit, Gross Profit by Person, Gross Profit by Product
- Sales Daily Summary
- Sales Audit Trail
- VAT Detail, VAT Summary
- Inventory Sync, Accounting Sync
- Till Summary
- Negative Stock Events
- Recovery Sync Log
- Audit Activity
- Stock Takes, Supplier Receives, Stock Transfers
- Cashup History

**Print behaviour:**
- Extracts current DOM content of `#reportContainer`
- Wraps it in a clean A4-format standalone HTML document
- Company name, report title, date range, generated timestamp included
- All buttons hidden via `display: none`
- Dark backgrounds overridden to white — all text forced to black
- Table headers rendered as dark (#333) on white for legibility
- Opens in popup window; user sees the page and can choose their printer
- Popup blocked fallback: silent iframe print

---

### Part 4 — Report Data Safety Preserved

- All cashup history data sourced from `pos_recon_snapshots` — never from live recalculation
- All endpoints remain company-scoped via `req.companyId`
- No business data written to browser storage
- `window._cashupSnapshots` is a session-only in-memory map (lost on page reload) — not persisted to localStorage or sessionStorage
- Snapshot values cannot be modified — append-only table architecture preserved

---

### Part 5 — Performance

- Cashup history report uses `SELECT *` from `pos_recon_snapshots` (bounded by date range, limit 500)
- Two enrichment queries (tills + users) run in parallel via `Promise.all`
- No recalculation — snapshot values are read directly, zero computational overhead
- Print function reuses already-loaded DOM content — no duplicate API calls
- Client-side filters (search, variance-only, force-close-only) run in-memory on the loaded row set — no re-fetch

---

## Files Modified

| File | Change |
|------|--------|
| `accounting-ecosystem/backend/modules/pos/routes/reports.js` | Added `GET /cashup-history` endpoint with enrichment |
| `accounting-ecosystem/frontend-pos/index.html` | Added sidebar nav item, Print button, renderCashupHistoryReport, buildCashupDetailHTML, toggleCashupDetail, filterCashupTable, printCashupRow, buildCashupPrintHTML, printCurrentReport, printBrowserPage |

---

## Immutable Snapshot Trust Guarantees

The cashup history report makes the following guarantees:

1. **Source:** `pos_recon_snapshots` only. The live `sales`, `sale_payments`, `pos_returns` tables are not queried for historical cashup display.
2. **Frozen values:** Snapshot columns (`gross_sales`, `payment_cash`, `expected_cash_in_drawer`, `cash_variance`, etc.) were computed at cashup time and stored. They do not change.
3. **Multiple snapshots:** A session may have more than one snapshot (if manually triggered). Each snapshot is displayed as a separate row — no deduplication occurs. This gives the full audit trail.
4. **Print identity:** The snapshot ID is printed on every cashup document, making it traceable.
5. **No overwrite:** The `pos_recon_snapshots` table is append-only. No update or delete path exists in the application.

---

## Remaining Report Limitations

| Limitation | Notes |
|------------|-------|
| Force-close sessions may have no snapshot | If a session was force-closed without a cashup, no snapshot exists — the session won't appear in cashup history |
| COGS in profit reports uses current cost_price | `sale_items` has no `cost_price` column — COGS is computed from `products.cost_price` at report time, not historical cost |
| Payment split detail not on audit trail report | Audit trail uses `sales.payment_method` (primary only); split payment detail requires joining `sale_payments` |
| VAT per item is approximated | VAT is stored at sale level; per-item VAT is distributed proportionally — not exact per-item tax coding |

---

## Future Roadmap

| Feature | Status |
|---------|--------|
| Export PDF (cashup) | Placeholder in UI — requires headless PDF generation or print-to-PDF instruction |
| Till/cashier filter dropdowns (server-side) | Currently client-side text search; dropdown population is a future enhancement |
| Cashup history API pagination | Currently capped at 500 rows; pagination needed for high-volume stores |
| Email cashup report | Future — requires email integration |

---

## Test Checklist

- [ ] Cashup History appears under `Reports → Cash-Up History`
- [ ] Selecting it generates the report from `pos_recon_snapshots`
- [ ] Summary cards show correct totals
- [ ] All columns display correctly
- [ ] Variance column color-codes correctly (red/amber/green)
- [ ] "View" button expands inline detail row
- [ ] "View" again collapses it
- [ ] Search box filters by cashier and till name
- [ ] "Variance only" checkbox hides zero-variance rows
- [ ] "Force-closed only" shows only force-closed sessions
- [ ] Per-row "🖨 Print" opens cashup print document
- [ ] Cashup print document shows correct values from snapshot (not recalculated)
- [ ] Cashup print includes snapshot ID, printed-by, printed-at
- [ ] "🖨 Print" toolbar button works for all reports
- [ ] Universal print output is readable on A4 (white background, black text)
- [ ] Buttons are hidden in print output
- [ ] Popup blocker fallback works (iframe print)
- [ ] No console errors
- [ ] No `localStorage`/`sessionStorage` business data written
- [ ] Company context is preserved (data scoped to current company only)
