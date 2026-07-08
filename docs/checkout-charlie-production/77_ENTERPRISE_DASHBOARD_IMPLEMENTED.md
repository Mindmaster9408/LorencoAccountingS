# Codebox 77 — Enterprise Dashboard Rebuild
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests with mocked API responses — see Verify section)
**Date:** 2026-07-07
**Scope:** `accounting-ecosystem/frontend-pos/index.html` — `dashboardLayout` HTML + `loadDashboard()`. No backend files changed.

---

## Audit — What Was There Before

The Enterprise Dashboard tab (`#dashboardLayout`, opened via the "Dashboard" nav button) called three endpoints:

| Call | Backend reality |
|---|---|
| `GET /api/analytics/dashboard` | Real route (`reports.js`), but only returns today's sale count/revenue/voided — no cost data, so Gross Profit was hardcoded to `"—"` with a code comment: *"Gross profit requires cost_price join — not in current API response"* |
| `GET /api/loss-prevention/alerts?status=open&limit=5` | **Hardcoded stub in `server.js`**: `res.json({ alerts: [] })` — unconditionally empty, always |
| `GET /api/locations` | **Hardcoded stub in `server.js`**: `res.json({ locations: [] })` — unconditionally empty, always |

Net effect: "Loss Prevention Alerts" could never show a real alert, "Location Performance" could never show a real location, "Gross Profit" and "Avg Basket" were permanent placeholders, and "Active Employees" was declared in the HTML but never populated by any code at all. The dashboard looked complete but was structurally incapable of being useful — exactly the "pretty but not operationally useful" problem this workstream was scoped to fix.

**Root cause insight:** by the time this workstream started, Workstream 71 had already built real, company-scoped, cost-aware report endpoints (`gross-profit`, `till-summary`, `negative-stock`, `recovery-sync`, `cashier-performance`, `audit-activity`) that cover almost the exact same ground the dashboard was trying (and failing) to show. The fix was not "build a new dashboard backend" — it was "stop calling three dead-end stubs and call the reports that already work."

---

## What Was Built

### Zero new backend routes

Every card, alert, and activity row on the rebuilt dashboard is sourced from endpoints that already existed and were already verified in Workstream 71:

| Dashboard data | Endpoint | Notes |
|---|---|---|
| Today's Sales, Gross Profit, Margin, Avg Transaction | `GET /api/reports/gross-profit?startDate=&endDate=` | Called with today's date range. Real cost-based profit — the old "—" placeholder is gone. |
| Active Employees | `GET /api/reports/cashier-performance?startDate=&endDate=` | Counts cashiers with `completed_sales > 0` today — not just "logged in," actually sold something. |
| Open Till Sessions, Cash Variance | `GET /api/reports/till-summary?startDate=&endDate=` | `summary.open_sessions`, `summary.total_sessions`, `summary.sessions_with_variance`. |
| Pending Cash-Ups, Offline/Sync Issues, stale sessions | `GET /api/reports/recovery-sync?startDate=&endDate=` | `summary.pending_cashup_sessions`, `summary.unresolved_count`, `summary.offline_conflicts`, `stale_sessions[]`. |
| Negative Stock | `GET /api/reports/negative-stock?startDate=&endDate=` | `currently_negative_count` — a live snapshot, not date-bounded (matches how the Reports section itself treats this field). |
| Recent Activity | `GET /api/reports/audit-activity?startDate=&endDate=` | Same `pos_audit_events` feed the Audit Activity report uses; trimmed to the newest 8 rows client-side for a dashboard-sized timeline. |
| Supplier Receives (today + recent list) | `GET /api/pos/inventory/receives` | No date-filter param exists on this endpoint, so "today" is derived client-side from its 30 most-recent rows. |
| "No till configured" alert | `GET /api/pos/tills` | `tills.length === 0`. |

All eight calls fire in parallel (`Promise.all`), each wrapped in its own try/catch (`safeFetchJson`) so one failing endpoint doesn't blank the whole dashboard — the other cards still render with whatever data did come back.

### Overview Cards (10, up from 4)

Today's Sales, Gross Profit, Avg Transaction, Active Employees, Open Till Sessions, Pending Cash-Ups, Cash Variance, Negative Stock, Offline/Sync Issues, Supplier Receives (today). Reused the existing `.kpi-card`/`.dashboard-grid` CSS unchanged — no new styling framework, `grid-template-columns: repeat(auto-fit, minmax(250px, 1fr))` already handles the extra cards responsively.

### Operational Alerts — real conditions only

Every alert is a **derived condition from real data**, not a stored "alert" record:

- No till configured (`tills.length === 0`)
- N till session(s) open too long (from `recovery-sync.stale_sessions`, includes cashier name + hours)
- N session(s) pending cash-up
- N product(s) below zero stock
- N till session(s) with cash variance today
- N offline sync conflict(s)

**Deliberately not built as an alert** (per the "no fake coming soon metrics" rule): *"product import issues"* — `import.js` only has `POST /preview` and `POST /execute`; there is no persistent import-history/issue table to query, so inventing this alert would mean showing a permanently-empty or fabricated condition. Documented here as a real gap rather than faked.

If no condition is currently true, the panel shows the existing "No active alerts" empty state — verified directly (see Verify section), not just assumed.

### Recent Activity + Recent Supplier Receives

Both reuse the existing `.alert-row` row styling (background overridden inline to a neutral grey so they don't read as alerts) rather than introducing new CSS. Recent Activity shows the newest 8 `pos_audit_events`; Recent Supplier Receives shows the newest 5 `pos_supplier_receives`.

### Current Company Banner

A new banner at the top of the dashboard (`#dashboardCompanyBanner`) shows `currentCompanyName` explicitly — "📍 Showing data for: **{company}**" with a note that figures never include other companies. This directly addresses the ticket's Multi-Store/Multi-Company Awareness requirement: the active company is always visible, and since every data source is a `req.companyId`-scoped query (inherited from the Workstream 71 endpoints, not re-verified here since it was already verified there), there is no cross-company aggregation happening anywhere on this page.

### Transfer Readiness Panel — honest, static, no fake data

`#dashboardTransferSection` makes **zero network calls**. There is no `transfer_headers`/`transfer_items` table or route in this codebase (confirmed by search — see the future roadmap doc). Rather than show a fabricated "0 pending transfers" or a fake-looking empty table, the panel is a plain static message: *"Inter-company stock transfer is not active yet for this company"* plus a short description of what it will show once built. This satisfies "do not fake data" and "create dashboard placeholders only if useful" literally — it's a placeholder, and it's honest about being one.

---

## Security / Company Isolation Notes

- Every one of the 8 endpoints called requires `requireCompany` (sets `req.companyId` from the authenticated JWT) and `reportsViewGate`/`INVENTORY.VIEW` permission gates — both already in place from Workstream 71, not modified here.
- No endpoint accepts or uses a `companyId` parameter from the client — company scope comes only from the server-verified token, same as every other report.
- The dashboard makes **no call** to `/api/companies`, `/api/inter-company/*`, or any other cross-company/global endpoint. It was audited specifically for this (see below) and confirmed clean.
- `super_admin` users viewing the POS Dashboard tab still only see the currently-selected company's data — the dashboard never branches on `isSuperAdmin` to show more.
- The Transfer Readiness panel does not call the existing `inter-company` module (used by Accounting for invoice exchange) at all — see the roadmap doc for why, and for how a real implementation should extend rather than duplicate that module.

---

## Transfer-Readiness Architecture Notes (summary — full detail in the future roadmap doc)

While auditing what a stock-transfer panel could plug into, a **real, already-existing** `inter_company_relationships` table and module (`accounting-ecosystem/backend/inter-company/`) was found — built for Accounting's inter-company invoice exchange (Turkstra can send an invoice to Pennygrow once both companies confirm a relationship). It already has exactly the shape a future stock-transfer feature needs: `company_a_id`/`company_b_id`, mutual `_confirmed` flags, a `status` lifecycle (`pending → active → suspended → terminated`), and a `permissions` JSON column (currently `send_invoices`/`receive_invoices`/`auto_match_payments`).

This module was **not touched or called** by this workstream (ticket rule: "no accounting integration"). It's documented here and in the roadmap doc purely so a future stock-transfer build extends this table's `permissions` with new flags (e.g. `send_stock_transfers`) instead of creating a second, parallel company-linking system.

---

## Remaining Roadmap Items

- Report-specific date-range picker on the dashboard itself (currently hardcoded to "today" for speed/simplicity — the underlying report endpoints already support custom ranges if this is wanted later).
- A real import-history table so "product import issues" can become a genuine alert instead of being omitted.
- Full inter-company stock transfer engine — see `docs/checkout-charlie-future/INTER_COMPANY_STOCK_TRANSFER_AND_CLIENT_LINKING.md`.
- Multi-company aggregate view for users with access to more than one store — explicitly out of scope for this workstream per the security rules ("if a summary across companies is shown, it must be explicitly authorised and clearly labelled"); today the dashboard only ever shows the single active company, which is the safe default.

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | `#dashboardLayout` HTML rebuilt (company banner, 10 KPI cards, Operational Alerts, Recent Activity, Recent Supplier Receives, static Transfer Readiness panel); `loadDashboard()` rewritten to fetch the 8 real endpoints above instead of the 3 dead stub endpoints |

No backend files changed. No new tables, routes, or migrations.

---

## Verify Results (real headless-Chromium tests, mocked API responses)

Two scenarios tested against the actual extracted HTML/JS from the file (not a re-implementation):

**Scenario 1 — realistic mixed data (some alerts, some activity):**

| Check | Result |
|---|---|
| Company banner shows the active company | ✅ "Turkstra Hardware" |
| Today's Sales / Transactions | ✅ R 12500.50 / 42 transactions |
| Gross Profit / Margin (previously hardcoded "—") | ✅ R 3200.75 / 25.61% margin — real data |
| Avg Transaction (computed) | ✅ R 297.63 |
| Active Employees excludes a cashier with 0 sales | ✅ 2 (not 3) |
| Open Sessions / of-total sub-label | ✅ 2 / "of 3 today" |
| Cash Variance | ✅ 1 |
| Pending Cash-Ups | ✅ 1 |
| Sync Issues | ✅ 2 |
| Negative Stock | ✅ 4 |
| Supplier Receives (today) | ✅ 1 |
| All 5 real alert conditions render with correct text | ✅ stale session, pending cash-up, negative stock, variance, offline conflict |
| Recent Activity shows 2 rows | ✅ |
| Recent Supplier Receives shows 1 row | ✅ |
| Transfer panel shows honest "not active yet" text | ✅ |
| Console/page errors | ✅ none |

**Scenario 2 — all-clear data (zero of every condition) + isolated "no till" case:**

| Check | Result |
|---|---|
| Zero alert rows when no condition is true | ✅ |
| "No active alerts" empty state shown | ✅ |
| Recent Activity empty state shown | ✅ |
| Recent Supplier Receives empty state shown | ✅ |
| "No till configured" alert appears when `tills: []`, and *only* that alert | ✅ confirmed in isolation |
| Console/page errors | ✅ none |

**Not independently re-tested in this environment** (no live server/database): the actual company-scoping of the 8 underlying report endpoints — this was already verified when those endpoints were built in Workstream 71 and is inherited unchanged here, not re-verified from scratch. Live cross-company leakage testing against a real multi-tenant database is recommended before this ships to two companies that both use the platform.

localStorage/sessionStorage: confirmed via diff — zero new browser storage calls introduced.
