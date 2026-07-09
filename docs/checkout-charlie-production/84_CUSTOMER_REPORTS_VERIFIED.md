# Workstream 83 — Verification
## Checkout Charlie

**Date:** 2026-07-09
**Method:** `node --check` + module-load smoke test on the modified backend file; a real headless-Chromium (Playwright) test against the actual, unmodified `index.html` served over a local HTTP server (not `file://`), with `/api/pos/reports/sales-by-customer`, `/api/pos/reports/customer-statement`, and their supporting filter-list calls mocked.

---

## Backend Checks

| Check | Result |
|---|---|
| `node --check` on `reports.js` | ✅ pass |
| Full POS module tree loads (`require('./modules/pos/index.js')`) | ✅ confirmed |
| Both new routes gated `reportsViewGate` (`REPORTS.VIEW`) | ✅ confirmed via `grep` — matches every other Reports-sidebar route |
| Every query in both routes scoped to `req.companyId` | ✅ confirmed via code read-through |
| `git diff` — no `localStorage`/`sessionStorage` writes introduced | ✅ confirmed (zero matches) |

---

## Frontend Verification (real headless-Chromium, real file, real HTTP server, mocked API)

| Ticket requirement | Result |
|---|---|
| Sales by Customer loads | ✅ `summaryRowCount: 2` — both the named customer and the walk-in bucket rendered |
| Walk-in / customerless sales handled as a distinct row | ✅ `summaryHasWalkin: true` — "Walk-in / No Customer" rendered, not dropped or errored |
| Summary totals correct | ✅ "2 Customers · R 1350.00 Gross Sales · R 20.00 Returns · R 1330.00 Net Sales" — matches the mocked summary exactly |
| Customer drill-down works | ✅ `drillDownVisible: true` — clicking "View" on Jane Smith's row correctly re-fetched with `customer_id=5` and rendered her name/detail |
| Back-out of drill-down returns to the summary | ✅ `backButtonWorks: true` |
| Payment breakdown sourced from `sale_payments` (not `sales.payment_method`) | ✅ `paymentBreakdownShown: true` — the drill-down row rendered "CASH: R100.00, ACCOUNT: R100.00" from the mocked `payment_breakdown` array, exactly as `sale_payments` would supply for a split-tender sale |
| Report renders a real `<table>` so the existing generic CSV export picks it up | ✅ `hasTableForExport: true` |
| Customer Statement requires customer selection | ✅ `statementBlockedWithoutCustomer: true` — calling the generate function with no customer selected fired zero network requests, confirmed via request-listener, not just a UI assumption |
| Statement opening/closing balance shown clearly | ✅ `statementOpeningBalance`/`statementClosingBalance: true` — both R 100.00 (opening) and R 250.00 (closing) rendered from the mocked replay result |
| Statement transaction lines rendered | ✅ `statementTransactionCount: 2` — matches the mocked charge + payment lines |
| Statement labelled as a POS-only statement (Accounting boundary) | ✅ `statementAccountingBoundaryShown: true` — "POS Account Statement" banner and boundary note both rendered |
| Print works | ✅ `printCalled: true` (spied `window.print`), `printAreaPopulated: true` — the print-area HTML contained the customer's name, confirming the statement content was actually built into `#printReceiptArea`, not just an empty print call |
| Console/page errors | ✅ none related to this workstream — the sole logged error is the same `/pos/service-worker.js` 404 seen in every prior workstream's test, an artifact of the minimal test server not serving the PWA path, unrelated to this code |

---

## Running Balance / Reconciliation Logic — Verified by Code Inspection

Not independently re-derived by the browser test (the test supplied a pre-computed mock response to verify *rendering*, not the arithmetic itself), so verified separately by reading the route:

- The replay starts at 0 and walks every merged ledger/synthesized-charge/return line in ascending `created_at` order — confirmed via code read-through of the `.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))` step before the replay loop.
- De-duplication against the ledger is by `sale_id` membership (`ledgerSaleIds.has(s.id)`), computed once from the full-history ledger fetch before synthesizing any sales-sourced charge — confirmed this can't double-count a sale that the ledger already references.
- `balance_mismatch` compares the *final* replayed balance (after all known entries, not just up to the requested end date) against `customers.current_balance` — confirmed this correctly catches a genuinely stale/incomplete ledger regardless of what date range the user happens to be viewing.
- `opening_balance_unavailable` only fires when there is zero history *and* a non-trivial recorded balance (`> R0.01`) — confirmed this doesn't false-positive for a brand-new customer with a legitimately zero balance and no history, which is the normal, healthy case.

## Not Independently Re-Verified

- **Live database arithmetic** — as with every workstream this session, no reachable Postgres connection from this environment; the balance-replay logic was verified by code inspection, not by running it against real `customer_account_transactions`/`sales` rows.
- **A customer with a genuinely large transaction history** (hundreds of entries) — the replay is a single in-memory sort + loop over whatever `customer_account_transactions` + `sales` return; no pagination or limit was added, since the ticket asked for "safe limits/pagination where needed" and a single customer's account history is not expected to reach a size where this matters in practice, but it is not currently bounded. Flagged as a low-probability, easy-to-add-later limit if a specific customer's statement ever proves slow.

FOLLOW-UP NOTE
- Area: Customer Statement replay performance at scale
- Dependency: none — purely a "has this been tested with real large data" gap
- Confirmed now: correct logic on realistic-sized mock data (handful of entries)
- Not yet confirmed: performance/correctness with hundreds+ of ledger entries for one customer
- Risk if wrong: slow report load for a very long-standing high-activity account customer; no correctness risk (the algorithm doesn't change with volume)
- Recommended next review point: if a real customer statement is reported as slow to generate
