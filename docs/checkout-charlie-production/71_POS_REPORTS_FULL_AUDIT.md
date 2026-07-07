# Codebox 71 — Complete POS Reports Audit + Build Plan
## Checkout Charlie

**Status:** Audit complete (Phase 1 + Phase 2)
**Date:** 2026-07-06
**Trigger:** Reports → Gross Profit → "Endpoint not found" live in production

This is the audit deliverable only. See `72_POS_REPORTS_COMPLETED_IMPLEMENTED.md` for what was fixed/built and `73_POS_REPORTS_COMPLETED_VERIFIED.md` for verification.

---

## PHASE 1 — Full Report Matrix

All 19 sidebar entries, plus two backend reports that exist but were never wired into the sidebar at all.

| Report Name | Sidebar Visible | Frontend Function | API Endpoint Called | Backend Route Existed | Response Shape Correct | CSV Export | Print | Permission Gate | Status (before fix) |
|---|---|---|---|---|---|---|---|---|---|
| Gross Profit | Yes | `renderGrossProfitReport` | `GET /api/reports/gross-profit` | **No** | N/A | Generic (works if a `<table>` renders) | None (see note) | None | **BACKEND_MISSING** |
| Gross Profit by Person | Yes | `renderGrossProfitByPersonReport` | `GET /api/reports/gross-profit-by-person` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Gross Profit by Product | Yes | `renderGrossProfitByProductReport` | `GET /api/reports/gross-profit-by-product` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Sales Daily Summary | Yes | `renderDailySummaryReport` | `GET /api/reports/daily-summary` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Sales Audit Trail | Yes | `renderAuditTrailReport` | `GET /api/reports/audit-trail` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Forensic Audit Log | Yes | `loadForensicAuditReport` / `fetchForensicAudit` | `GET /api/audit/forensic` | **No route** — `shared/routes/audit.js` has `/`, `/user-activity/:userId`, `/entity-history/:entityType/:entityId`, `/suspicious`, none named `/forensic` | N/A | Generic | None | Would've been `AUDIT.VIEW` on the wrong table anyway | **BROKEN_ENDPOINT + WRONG_DATA_SOURCE** |
| Payment Methods | Yes | `loadPaymentMethodsReport` | `GET /api/pos/reports/payment-methods` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Suspicious Activity | Yes | `loadSuspiciousActivityReport` | `GET /api/audit/suspicious-activity` | **Hardcoded stub in `server.js`**: `res.json({ activities: [] })` — always empty, unconditionally | **No** — frontend reads `data.alerts`, stub returns `activities` | N/A (cards, not a table) | None | `authenticateToken` only | **UI_PLACEHOLDER (dummy data, wrong field name)** |
| VAT Detail | Yes | `renderVatDetailReport` | `GET /api/reports/vat-detail` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| VAT Summary | Yes | `renderVatSummaryReport` | `GET /api/reports/vat-summary` | **No** | N/A | Generic | None | None | **BACKEND_MISSING** |
| Inventory Sync | Yes | `renderInventorySyncReport` | `GET /api/reports/inventory-sync` | **No**, and no real target system exists to sync to | N/A | Generic | None | None | **HIDE_UNTIL_IMPLEMENTED** |
| Accounting Sync | Yes | `renderAccountingSyncReport` | `GET /api/reports/accounting-sync` | **No**, same reason | N/A | Generic | None | None | **HIDE_UNTIL_IMPLEMENTED** |
| Till Summary | Yes | `renderTillSummaryReport` | `GET /api/reports/till-summary` | Yes | Yes, exact field match | Generic | None | **Missing** | PASS, but **PERMISSION_MISSING** |
| Negative Stock Events | Yes | `renderNegativeStockReport` | `GET /api/reports/negative-stock` | Yes | Yes, exact field match | Generic — response has 2 tables (currently-negative products, events-in-period); CSV export only grabs the first `<table>` on the page | None | **Missing** | PASS, but **PERMISSION_MISSING**; CSV export is partial (documented, not fixed — see below) |
| Recovery Sync Log | Yes | `renderRecoverySyncReport` | `GET /api/reports/recovery-sync` | Yes | Yes, exact field match | Generic — response has up to 3 tables; same partial-CSV limitation | None | **Missing** | PASS, but **PERMISSION_MISSING** |
| Audit Activity | Yes | `renderAuditActivityReport` | `GET /api/reports/audit-activity` | Yes | Yes, exact field match | Generic | None | **Missing** | PASS, but **PERMISSION_MISSING** |
| Stock Takes | Yes | `renderStockTakesReport` | `GET /api/pos/inventory/stock-takes` | Yes | Yes (`stock_takes`) | Generic | None | `INVENTORY.VIEW` already present | **PASS** |
| Supplier Receives | Yes | `renderStockReceivesReport` | `GET /api/pos/inventory/receives` | Yes | Yes (`receives`) | Generic | None | `INVENTORY.VIEW` already present | **PASS** |
| Stock Transfers | Yes | `renderStockTransfersReport` | `GET /api/pos/inventory/transfers` | Yes | Yes (`transfers`) | Generic | None | `INVENTORY.VIEW` already present | **PASS** |
| Cashier Performance | **No** — not in the sidebar at all | none existed | `GET /api/reports/cashier-performance` | Yes, but completely unused — built in an earlier codebox, never wired to any UI | No renderer existed | N/A | N/A | **Missing** | **EMPTY_STATE_ONLY** (backend fine, zero frontend) |
| "Cash-Up History" | Not a distinct sidebar item | — | — | — | — | — | — | — | Clarification, not a gap — see below |

**Note on Print:** there is no dedicated "Print" button anywhere in the Reports section — only a generic "📥 Export CSV" button next to "Generate Report". The only `window.print()` call in the entire file is in the receipt-printing code (`printBrowserReceipt`), unrelated to Reports. Browser-native print (Ctrl+P) works on any page but is not report-scoped — it would print the whole POS chrome (topbar, sidebar, filter bar), not a clean report. Building report-specific print styling was judged out of scope for this workstream ("do not rewrite the report UI framework unless absolutely required") and is listed as a future enhancement below rather than attempted.

**Note on "Cash-Up History":** there is no separate report by this name anywhere in the codebase. **Till Summary already is this report** — it lists every till session in the period with its `pos_recon_snapshots`-sourced cash-up figures (opening balance, payment breakdown, expected vs. counted cash, variance). No separate report was built; this is a naming clarification, not a gap.

---

## PHASE 2 — Root Cause Classification

### Root cause 1 — 7 sidebar reports call a REST convention (`/api/reports/<key>`) that was simply never built
Gross Profit, Gross Profit by Person, Gross Profit by Product, Sales Daily Summary, Sales Audit Trail, VAT Detail, VAT Summary. `reports.js` only ever had `sales-summary`, `top-products`, `cashier-performance`, `inventory-value`, `dashboard`, `till-summary`, `negative-stock`, `recovery-sync`, `audit-activity` — none of the 7 above. Every one of these produced Express's default "not found" response, matching the reported live symptom exactly.

### Root cause 2 — Payment Methods: same class of gap
`GET /api/pos/reports/payment-methods` resolves through the same router (see Route Mount Map below) and also has no matching route defined.

### Root cause 3 — Forensic Audit Log: wrong frontend URL AND wrong data source
The frontend calls `/api/audit/forensic`, which doesn't exist anywhere. Even if it did, `shared/routes/audit.js` reads from the generic ecosystem `audit_log` table (used by Payroll/Accounting via `logAudit()`), not `pos_audit_events` (where POS actions — voids, negative-stock sales, overrides, stock adjustments — are actually recorded via `posAuditFromReq`/`logPosEvent`). Pointing the frontend at the existing shared audit routes would have returned the wrong (or empty) data even after fixing the URL.

### Root cause 4 — Suspicious Activity: hardcoded dummy stub with a field-name mismatch on top
`server.js` has `app.get('/api/audit/suspicious-activity', authenticateToken, (req, res) => res.json({ activities: [] }));` — a literal, permanent, unconditional empty response. Two separate bugs stacked: (1) it's dummy data, not a real query, and (2) even if it returned real data under `activities`, the frontend reads `data.alerts`, so the UI would show "No Suspicious Activity Detected" regardless of what the backend ever returned. The existing real `/api/audit/suspicious` route in `shared/routes/audit.js` (built for AUDIT.VIEW-gated ecosystem-wide use) has the same wrong-data-source problem as Forensic Audit — it queries `audit_log`, not `pos_audit_events`.

### Root cause 5 — Inventory Sync / Accounting Sync: no backend, and none should be built yet
No `/inventory-sync` or `/accounting-sync` route exists, and there is no evidence anywhere in the codebase of an actual external Inventory Management System or Accounting System this POS is meant to push data to. The frontend's own "Sync" buttons already say `"Syncing... (Coming soon)"`. Building a backend that returns real POS sales data framed as "ready to sync" to a system that doesn't exist would itself be a form of dummy/misleading data. **Recommendation: hide, don't build.**

### Root cause 6 — Cross-cutting: no permission gate on any report, at all
`reports.js` imports `requirePermission` but never calls it — every route in the file (including the ones that already worked) was reachable by any authenticated POS user regardless of role, i.e. a cashier could load Gross Profit, VAT Summary, Cashier Performance (which shows colleagues' individual revenue figures), and the full audit trail. `config/permissions.js` already defines exactly the right permission for this — `REPORTS: { VIEW: SUPERVISOR_ROLES, EXPORT: MANAGEMENT_ROLES }` (line ~144) — it was simply never applied anywhere. The Reports nav-tab button also carries no visibility gate on the frontend; separately, the `manager-only` CSS class used elsewhere in this file (Daily Reset, Tills settings, Device Lock, Add Till) has **no matching CSS or JS anywhere in the app that actually hides those elements** — it's a vestigial marker, not a working mechanism. That's a broader, pre-existing gap outside this workstream's scope; noted here since a correct fix for Reports' permission gate must not pretend a working frontend-hide mechanism exists when it doesn't.

### Root cause 7 (data-source correctness, applies across several reports) — `sales.payment_method` vs `sale_payments`
The checkout flow supports split-tender sales (multiple `sale_payments` rows per sale). `sales.payment_method` is a single-value column set at sale creation and does not reflect split payments. Any report showing payment method **must** derive it from `sale_payments`, not the `sales` column. This affects Payment Methods (must aggregate `sale_payments` directly) and Sales Audit Trail (per-sale payment label must check for more than one `sale_payments` row/distinct method and show "split" rather than trusting `sales.payment_method`).

### Root cause 8 (schema understanding, not a bug) — `sale_items` has no cost-price snapshot
`create_sale_atomic` (the RPC — not touched, per instructions) writes `product_id, product_name, quantity, unit_price, vat_rate, line_total, discount_amount` per item. No cost price at time of sale is stored. Any gross-profit calculation must join to the product's **current** `cost_price` — meaning historical profit figures are an approximation using today's cost if a product's cost has changed since the sale. This is a real, permanent limitation of the current schema, not something fixable within this workstream's constraints (would require a schema + RPC change).

### Root cause 9 (schema understanding) — `unit_price`/`line_total` are VAT-inclusive
Confirmed directly in `sales.js`'s own checkout calculation: `"VAT is inclusive in unit_price — extract it"`, via `vat_total += linePrice * (vat_rate / (100 + vat_rate))`. Any new VAT report must use this exact extraction formula to stay consistent with what the sale itself actually charged, not a fresh `price * 0.15` calculation from scratch.

---

## Route Mount Map (for anyone auditing this again later)

`reports.js`'s router is mounted at **three** different paths, all resolving to the exact same file/routes:
- `server.js`: `app.use('/api/reports', authenticateToken, reportsRoutes)`
- `server.js`: `app.use('/api/analytics', authenticateToken, reportsRoutes)`
- `modules/pos/index.js`: `router.use('/reports', reportsRoutes)`, itself mounted at `/api/pos` in `server.js` → effectively `/api/pos/reports/*`

This is why `payment-methods` (called via `/api/pos/reports/payment-methods`) and everything else (called via `/api/reports/...`) can both be fixed by adding one route to the one file.

---

## Recommended Build/Fix Order (applied in this order — see doc 72)

1. Add the `REPORTS.VIEW` permission gate to every existing report route first (security fix, zero dependency on anything else).
2. Build the 7 missing sales/VAT reports (gross-profit, gross-profit-by-person, gross-profit-by-product, daily-summary, audit-trail, vat-detail, vat-summary) — these are the ones users are actively hitting "Endpoint not found" on.
3. Build `payment-methods` from `sale_payments`.
4. Build `forensic-audit` and `suspicious-activity` as real, POS-scoped (`pos_audit_events`-backed) routes, and repoint the two frontend calls at them.
5. Hide Inventory Sync / Accounting Sync from the sidebar (comment, not delete — code stays in place, unreachable).
6. Wire the already-existing `cashier-performance` backend into the sidebar with a new renderer.

## Pilot-Critical vs. Nice-to-Have

**Pilot-critical (must work before any external practice/store relies on Reports):** Gross Profit, Gross Profit by Person, Gross Profit by Product, Sales Daily Summary, VAT Detail, VAT Summary, Payment Methods, Till Summary, Negative Stock Events — these are the numbers an owner checks daily/monthly and the numbers a bookkeeper needs for VAT filing.

**Important but secondary:** Sales Audit Trail, Cashier Performance, Recovery Sync Log, Audit Activity, Forensic Audit Log, Suspicious Activity — operational/oversight tooling, not financial-close-blocking.

**Correctly hidden, not pilot-blocking:** Inventory Sync, Accounting Sync — no real target system exists; showing them as broken or fake would be worse than not showing them at all.
