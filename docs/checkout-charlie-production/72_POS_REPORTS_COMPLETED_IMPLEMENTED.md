# Codebox 72 — POS Reports Fixes Implemented
## Checkout Charlie

**Status:** Implemented
**Date:** 2026-07-06
**Depends on:** `71_POS_REPORTS_FULL_AUDIT.md`

---

## Reports Fixed / Built

| Report | Action | Endpoint |
|---|---|---|
| Gross Profit | Built | `GET /api/reports/gross-profit` |
| Gross Profit by Person | Built | `GET /api/reports/gross-profit-by-person` |
| Gross Profit by Product | Built | `GET /api/reports/gross-profit-by-product` |
| Sales Daily Summary | Built | `GET /api/reports/daily-summary` |
| Sales Audit Trail | Built | `GET /api/reports/audit-trail` |
| VAT Detail | Built | `GET /api/reports/vat-detail` |
| VAT Summary | Built | `GET /api/reports/vat-summary` |
| Payment Methods | Built | `GET /api/reports/payment-methods` (already reachable via `/api/pos/reports/payment-methods`, no frontend change needed) |
| Forensic Audit Log | Built (new, POS-scoped) + frontend URL fixed | `GET /api/reports/forensic-audit` |
| Suspicious Activity | Built (new, POS-scoped, replaces hardcoded stub) + frontend URL fixed | `GET /api/reports/suspicious-activity` |
| Till Summary | Unchanged, gate added | `GET /api/reports/till-summary` |
| Negative Stock Events | Unchanged, gate added | `GET /api/reports/negative-stock` |
| Recovery Sync Log | Unchanged, gate added | `GET /api/reports/recovery-sync` |
| Audit Activity | Unchanged, gate added | `GET /api/reports/audit-activity` |
| Stock Takes / Supplier Receives / Stock Transfers | Unchanged (already correct) | `/api/pos/inventory/{stock-takes,receives,transfers}` |
| Cashier Performance | Wired into the Reports sidebar (backend already existed) | `GET /api/reports/cashier-performance` |
| Inventory Sync / Accounting Sync | Hidden from the sidebar (not built — see audit doc) | n/a |

---

## Endpoints Added (`accounting-ecosystem/backend/modules/pos/routes/reports.js`)

All ten new routes are gated by the new `reportsViewGate` (see Permission Gates below), company-scoped via the existing `req.companyId`, and accept the same `startDate`/`endDate` (or `from`/`to`) query params as the existing reports for consistency.

- **`fetchSalesWithProfit(companyId, start, end)`** — shared helper (not a route) used by `gross-profit`, `gross-profit-by-person`, `gross-profit-by-product`, and `daily-summary`, so the cost-join/profit-calc logic exists in exactly one place. Fetches completed sales in range, their `sale_items`, and the current `cost_price` of every product involved, then computes `gross_profit = total_amount − Σ(quantity × current cost_price)` and `profit_margin = gross_profit / total_amount × 100` per sale.
- **`GET /gross-profit`** — per-sale listing + summary (`totalSales`, `totalProfit`, `profitMargin`, `transactionCount`).
- **`GET /gross-profit-by-person`** — same calculation grouped by cashier (`sales.user_id`).
- **`GET /gross-profit-by-product`** — grouped by `sale_items.product_id`, joined to `products` for code/name/category.
- **`GET /daily-summary`** — grouped by calendar day (`created_at` truncated to date).
- **`GET /audit-trail`** — per-sale listing with item/quantity aggregates and an honest payment-method label (see Root Cause 7 below — never trusts `sales.payment_method` directly).
- **`GET /vat-detail`** — line-item level VAT extraction (`vat_amount = line_total × (vat_rate / (100 + vat_rate))`), matching the exact formula `sales.js` itself uses at checkout.
- **`GET /vat-summary`** — same extraction, grouped by day, plus `effectiveVatRate`.
- **`GET /payment-methods`** — aggregates `sale_payments` directly (not `sales.payment_method`), grouped by method.
- **`GET /forensic-audit`** — filterable `pos_audit_events` query (action_type, entity_type, username via `user_email` ilike, date range), returns `{ entries: [...] }`.
- **`GET /suspicious-activity`** — real threshold-based detection over `pos_audit_events` (per-cashier counts of `SALE_VOIDED`, `NEGATIVE_STOCK_SALE_ALLOWED`, `SALE_RETURNED`, `MANAGER_OVERRIDE`, `SUPERVISOR_OVERRIDE_GRANTED` exceeding a fixed threshold), returns `{ alerts: [...] }`. Replaces the old hardcoded `{ activities: [] }` stub the frontend was actually calling.

## Frontend Mappings Fixed (`accounting-ecosystem/frontend-pos/index.html`)

- `fetchForensicAudit()`: URL changed from `${API_URL}/audit/forensic` → `${API_URL}/reports/forensic-audit`.
- `loadSuspiciousActivityReport()`: URL changed from `${API_URL}/audit/suspicious-activity` → `${API_URL}/reports/suspicious-activity`.
- Sidebar: removed the "Inventory Sync" / "Accounting Sync" menu items (their loader functions and `renderReport()` switch cases are left in place, unreachable, so nothing needs rewiring if a real target system is built later).
- Sidebar: added "Cashier Performance" under Operational.
- `renderReport()`: added the `cashier-performance` case.
- New function `renderCashierPerformanceReport()` — table of cashier, sessions worked, sales, revenue, avg transaction, voids, refunds, negative-stock sales allowed, manager overrides.

## Permission Gates Added

`config/permissions.js` already defined `REPORTS: { VIEW: SUPERVISOR_ROLES, EXPORT: MANAGEMENT_ROLES }` — it was never applied anywhere. Added `const reportsViewGate = requirePermission('REPORTS.VIEW');` in `reports.js` and applied it **per-route** (not router-wide) to every report the Reports sidebar actually uses:

`cashier-performance`, `till-summary`, `negative-stock`, `recovery-sync`, `audit-activity`, and all 10 newly-built routes.

**Deliberately left ungated** (out of scope — not part of the Reports sidebar): `/dashboard` (backs the separate Enterprise "Dashboard" tab, which has its own pre-existing, unrelated visibility gap — see Remaining Reports Not Implemented below), `/top-products`, `/inventory-value` (neither is called from anywhere in the frontend today).

`SUPERVISOR_ROLES` excludes `cashier`, `senior_cashier`, and `trainee` — a cashier hitting any gated report endpoint now receives `403 { error: 'Insufficient permissions', required: 'REPORTS.VIEW', userRole: 'cashier' }`, which the existing `loadCurrentReport()` error-display path already renders cleanly (`Error: Insufficient permissions`) — no frontend change was needed to handle this gracefully.

## Print / CSV Status

- **CSV**: unchanged — `exportCurrentReport()` is generic (scrapes the first `<table>` in `#reportContainer`) and works automatically for every report that renders a table, including all 10 new ones. Two pre-existing reports (Negative Stock Events, Recovery Sync Log) render more than one `<table>`; CSV export only captures the first. Documented as a known limitation in the audit doc, not fixed here (would require a UI change beyond this workstream's "don't rewrite the report framework" constraint).
- **Print**: no dedicated report-print feature exists anywhere in this app (confirmed in the audit) — not built here, per "do not rewrite the report UI framework unless absolutely required." Browser-native Ctrl+P remains available but unstyled for reports.

## What Was NOT Touched

- `create_sale_atomic` RPC, stock decrement logic, checkout flow — untouched.
- Paytime, Accounting modules — untouched.
- `shared/routes/audit.js` — untouched (new forensic/suspicious-activity logic was built as new POS-scoped routes in `reports.js` instead, specifically to avoid touching a file shared with other modules and to source from the correct table, `pos_audit_events`, rather than the shared `audit_log`).
- The hardcoded `/api/audit/suspicious-activity` stub in `server.js` — left in place untouched; the POS frontend simply no longer calls it. (It may still be relied on elsewhere; removing it was out of scope for a POS-only workstream.)
- `INVENTORY.VIEW`-gated inventory routes (`stock-takes`/`receives`/`transfers`) — already correct, not modified.

## Remaining Reports Not Implemented

- **Inventory Sync / Accounting Sync** — intentionally hidden, not built. No real external system to sync to exists yet; would require actual integration work in a future, dedicated workstream.
- **Enterprise Dashboard tab** (`/api/analytics/dashboard`, the "Dashboard" nav-tab, separate from Reports) — audit surfaced that this tab is marked with a non-functional `enterprise-tab` CSS class (no matching hide logic exists, same as the broader `manager-only` gap). Left untouched — out of scope for a Reports-sidebar workstream, but flagged for a future access-control pass.
- **Report-specific Print** — not built; documented as a future enhancement.
- **Multi-table CSV export** (Negative Stock Events, Recovery Sync Log) — only the first table on the page exports; not fixed here.
