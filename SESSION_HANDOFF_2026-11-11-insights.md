# Session handoff: 2026-11-11, Insights (owner reporting app, Phase 1)

## Decisions made by Ruan this session
- **Firmflow stays Firmflow.** It is his practice manager and must never be lost. "International" will maybe be built into Firmflow later; the separate Firmflow copy at `/commander` is left untouched for now.
- **The name "Commander" goes to the Syft-style reporting app later** ("the Commander move"). Until then the app is called **Insights** on its tile, with internal key `insights`.
- **Phase 1 = "both":** Leo financial cards on top, and a Charlie till-sales section below them (only when the company uses Charlie). Dashboard layout follows the reference image `docs/future-build/commander-dashboard-reference.jpg`.

## What changed (per file)

| File | Purpose |
|---|---|
| `backend/modules/accounting/services/glReportData.js` (new) | `fetchAccountBalances`, `aggregateLines`, `balanceOf` and `fetchFyStartMonth` moved **verbatim** out of Leo's `routes/reports.js`, so Insights reads the GL through the exact same SQL as Leo |
| `backend/modules/accounting/routes/reports.js` | Uses the moved helpers via require; there is no logic change (diff-verified identical) |
| `backend/modules/accounting/services/profitLossService.js` | Comments only (point to the new file) |
| `backend/modules/pos/services/salesAnalyticsService.js` (new) | SQL aggregates of Charlie sales using Charlie's definitions: completed only, `total_amount` incl. VAT, `line_total` for products, `sale_payments` for methods, and the endOfDay date rule |
| `backend/modules/insights/` (new) | `index.js` router (`/context`, `/overview`) and `services/overviewService.js` (assembly, comparison periods, access rules, max 3 parallel queries) |
| `backend/frontend-insights/` (new) | Dark-native single page: KPI cards with "how is this calculated" tips, trend charts, category donut, store bars, top products with YoY, slicers (store / category / payment method), latest sales table. Only the auth token is read from browser storage |
| `backend/config/modules.js` | `insights` module, active unless `MODULE_INSIGHTS_ENABLED=false` |
| `backend/server.js` | Mounts `/api/insights` (authenticateToken + requireModule + audit) and serves `/insights` |
| `backend/shared/routes/auth.js` | `'insights'` added to the sso-launch `validApps` list. This is a one-word change; the impact note is below |
| `frontend-ecosystem/dashboard.html` | Insights tile + colours |
| `backend/.eslintignore` | `frontend-insights` (browser code, like the other frontends) |
| `backend/tests/insights-overview.test.js` (new) | 17 unit tests |
| `docs/future-build/OWNER_REPORTING_APP_CONCEPT.md` | Name decision, dashboard mapping (section 7), what was built (section 8) |

```
CHANGE IMPACT NOTE — PAYROLL (shared file)
Area: backend/shared/routes/auth.js — sso-launch validApps
Change: added 'insights' to the allow-list; no logic touched
Payroll risk: LOW. Login, select-company, companyId in the JWT and eco_client resolution are unchanged
Tests: TEST-PAY-11 path (sso-launch for 'payroll') is unchanged; the full jest suite was run
Rollback: remove 'insights' from the array
```

## Verified
- **Leo report parity.** The old and new `reports.js` were run side by side on live data for 5 companies across P&L, trend, matrix, balance sheet, trial balance and cash flow: **30 comparisons, 0 differences**.
- **Charlie parity** for companies 51, 2 and 7. Till sales and orders match `/sales-summary`, the #1 product matches `/top-products`, and the payment total matches `/payment-methods`. For company 2, Charlie's own report failed (see the open risk below), so the payment total was checked with direct SQL instead. Category-filtered sales equal the category slice.
- **End-to-end on a local server.** sso-launch for `insights` and company 51 → `/context` → `/overview` all returned 200. Bad dates and bad ranges return 400, a bad token returns 403, and an unknown user is refused.
- **Access.** Cashiers and store managers get no sections. Super admins get everything. An empty company shows "no data", not an error.
- **Checks.** `npm run lint`: 0 errors. Jest: 1203 passed, 10 failed. The 10 failures are in 4 suites (payroll-employee-sync, teach-paytime, supplier-invoice-ocr-drafts, historical-comparatives-dashboard), and **the same 10 fail on clean `main`**, so they already existed before this change.

## NOT changed (on purpose)
- The Firmflow copy (`/commander`, `commander_*` tables) was not touched, per Ruan.
- `permissions.js` was not touched; existing permissions were reused.
- Charlie's own report routes were not touched.
- Test company 51 has **not** had `insights` added to `modules_enabled` / `eco_clients.apps` yet (Rule H2). This is a DB write that needs Ruan's "ja". Super admins can already use it without this.

## Testing still needed (Ruan)
1. Eco dashboard → select **Infinite Legacy — TEST** → Insights tile → check the look, then try the period presets and the filters.
2. Open a real client that uses both Leo and Charlie and compare one month's revenue with Leo's P&L, and till sales with Charlie's sales summary.
3. Check the layout on a phone.

## Follow-up notes / open risks

```
FOLLOW-UP NOTE
- Area: Checkout Charlie — GET /api/pos/reports/payment-methods
- Dependency: PostgREST .in('sale_id', [...]) with every sale id in the range
- What was done now: found while verifying Insights; not fixed (POS route, out of scope)
- What still needs to be checked: the report fails with "fetch failed" for a busy live store (company 2: 3,104 sales in 3 months)
  because the URL gets too long — the payment-methods report is broken for busy stores over longer ranges
- Risk if not checked: owners/managers can't see the payment-method split for longer periods
- Recommended next review point: next Charlie session; fix with a SQL join (same as salesAnalyticsService)
```

```
FOLLOW-UP NOTE
- Area: Ledger Leo — computeCashFlow (routes/reports.js)
- Dependency: bank_cash accounts with type 'liability' (overdraft accounts; 11 exist)
- What was done now: Insights counts cash as debit − credit across all bank_cash accounts (an overdraft lowers cash)
- What still needs to be checked: Leo's cash flow uses balanceOf(), which is credit-normal for liabilities, so an
  overdraft balance seems to ADD to opening/closing cash there. Possible sign bug; not changed
- Risk if not checked: wrong opening/closing cash on Leo's cash-flow statement for companies with an overdraft account
- Recommended next review point: next Leo session, with a real overdraft company as the test case
```

```
FOLLOW-UP NOTE
- Area: Insights performance
- What was done now: max 3 queries in flight per request (shares Leo's 15-connection pool). Local test: ~3–6 s per
  dashboard load from a PC in SA to the Supabase DB
- What still needs to be checked: load time on Render (should be faster, as it sits closer to the DB)
- Recommended next review point: after the first live use
```

- Store breakdown uses the till's free-text `tills.location` (falls back to the till name). The `locations` table is not linked to sales or tills.
- Amounts are formatted as ZAR. Per-jurisdiction currency comes with international rollout.
- Next phases are listed in the concept doc, section 8.
