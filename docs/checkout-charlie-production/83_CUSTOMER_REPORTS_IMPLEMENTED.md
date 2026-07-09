# Workstream 83 — Sales by Customer + Customer Statement Reports
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests over a real local HTTP server, mocked API responses — see doc 84)
**Date:** 2026-07-09
**Scope:** Two new reports under Reports → Customers. No checkout changes, no sale RPC changes, no customer account posting logic changes, no Accounting integration.

---

## Routes Added

Both in `accounting-ecosystem/backend/modules/pos/routes/reports.js` (reachable at `/api/reports/*`, `/api/analytics/*`, and `/api/pos/reports/*` — same router, three mount points, unchanged), both gated `reportsViewGate` (`REPORTS.VIEW` = `SUPERVISOR_ROLES`, excludes cashier/senior_cashier/trainee), both `req.companyId`-scoped on every query.

- `GET /api/pos/reports/sales-by-customer` — filters: `startDate`/`endDate`, `customer_id` (a real id, or `'walkin'` for customerless sales, or omitted for the full summary), `cashier_id`, `till_id`, `payment_method`, `account_only`, `include_voids`, `search`. Returns either the per-customer summary list or, when `customer_id` is given, that customer's summary row plus a full `transactions` drill-down array.
- `GET /api/pos/reports/customer-statement` — `customer_id` required; `startDate`/`endDate`, `include_paid_sales`.

---

## A Real Data-Source Finding (investigated before writing either report)

Before touching anything, I checked what actually populates the customer account ledger, since the Customer Statement depends on it:

- `customer_account_transactions` exists but is **empty in production**, and the only code path that ever writes to it is the manual `POST /api/pos/customers/:id/account/payment` route (`type: 'payment'`). Nothing in `sales.js`, and nothing visibly in `create_sale_atomic` (an opaque Postgres RPC not checked into this repo, never touched per every prior ticket's explicit rule), provably posts a `'charge'` row there when a customer buys on ACCOUNT.
- Rather than assume the RPC does or doesn't post to the ledger, **both reports compute ACCOUNT-sale charges directly from `sales`** and de-duplicate against any ledger rows that do reference the same `sale_id`. This is correct either way: if the RPC turns out to post ledger rows, the de-dup check finds them and skips re-adding; if it doesn't (matches today's reality), the reports still show the true charge because it's read straight from `sales`, not silently dropped.
- This is a **read-only workaround in the reporting layer**, not a change to posting logic — nothing in `customers.js`/`sales.js`/the RPC was touched, per the ticket's explicit rule not to change account posting logic without a proven bug. Whether a bug actually exists in the RPC's ledger-posting is left an open question — documented, not assumed either way (see Limitations).

---

## Report 1 — Sales by Customer

**Filters:** date range, customer, cashier (sourced from the existing `cashier-performance` report response — no new endpoint needed), till, payment method, account-only toggle, include/exclude voids, customer name/code search.

**Summary columns:** customer name, code, sales count, gross sales, returns/refunds, net sales, average sale, last purchase date (within the selected period), account sales total, cash/card sales total.

**Walk-in handling:** any sale with `customer_id IS NULL` is grouped into a single `"Walk-in / No Customer"` row rather than being dropped or crashing the grouping logic — a real, explicit bucket, not an edge case left to chance.

**Drill-down:** clicking a customer row re-fetches the same endpoint with `customer_id` set, returning per-sale transaction rows: date, sale number, cashier, till, payment breakdown, gross, refund, net, status. Voided sales show a red "Voided" badge when `include_voids` is on; excluded entirely by default.

**Payment breakdown — `sale_payments`, not `sales.payment_method`:** every payment figure (the summary's Account/Cash-Card split, and the drill-down's per-sale breakdown) is computed from `sale_payments` rows, correctly handling split-tender sales. If a sale has zero `sale_payments` rows (older data predating that table), the code falls back to the sale's single `payment_method`/`total_amount` — an honest fallback, not a silent zero.

**Returns:** sourced from `pos_returns.refund_amount` joined on `original_sale_id`. This table is also empty in production today — the code path is real and will populate the moment returns start being recorded through it; nothing here is faked in the meantime, it just correctly shows R0.00 returns.

---

## Report 2 — Customer Statement

Explicitly labelled **"POS Account Statement"** everywhere it appears (on-screen banner and the printed statement header), with a boundary note stated in the API response itself and rendered to the user: *"This statement reflects Checkout Charlie POS account activity only. It is not a full Accounting-app debtor statement unless Accounting integration has been explicitly enabled for this company."* No Accounting-app data is read or referenced anywhere in this workstream.

**Balance math:** there is no separate "account opened" balance to seed from, so the statement replays every known balance-affecting entry — merged and de-duplicated `customer_account_transactions` rows, synthesized ACCOUNT-sale charges (see the finding above), and returns against ACCOUNT sales — in chronological order from the earliest one on record, running balance starting at 0. **Opening balance** for the requested period is the replayed balance immediately before the start date. **Closing balance** is the replayed balance as of the last entry within the period.

**Self-checking, not silently wrong:** the fully-replayed balance (as of the most recent entry on record, not just up to the statement's end date) is compared against the customer's live `current_balance`. If they don't match, the response sets `balance_mismatch: true` and the UI shows a clear warning rather than presenting a number that might not reflect reality. If there is genuinely no transaction history at all for a customer with a non-zero recorded balance, the response sets `opening_balance_unavailable: true` and the UI shows exactly the message the ticket specified: *"Opening balance unavailable — no account transaction history found."*

**Include paid sales toggle:** when on, non-ACCOUNT (cash/card) sales for the customer in the period are shown as reference-only rows — debit and credit both equal the sale amount, explicitly labelled *"Paid in full at time of sale — no effect on account balance"*, and excluded entirely from the running-balance replay. They inform the reader without corrupting the ledger math.

**Header/footer:** company context comes from the existing session; customer name, code, contact, address; statement period; generated timestamp; generated-by (`currentUser`). Footer shows closing balance.

---

## Print / Export

- **Print** reuses the app's existing receipt-printing mechanism (`#printReceiptArea`, the same hidden-except-during-`@media print` element already used for till receipts) — no new print pipeline invented. Builds a clean statement layout, calls `window.print()`, clears the area afterward.
- **CSV Export** — deliberately did **not** write a new export function. The existing "📥 Export CSV" button in the Reports header already works generically: it scrapes whatever `<table>` element is currently visible inside `#reportContainer` into CSV (`exportCurrentReport()`, pre-existing, unmodified). Both new reports render their data as a real `<table>`, so this button already works for both — for the Sales by Customer summary, the drill-down view, and the Customer Statement's transaction table, exporting whichever is currently on screen. Confirmed working, not assumed (see doc 84).
- **PDF** — not built, per the ticket's own "future PDF placeholder if not built" allowance. Print-to-PDF via the browser's print dialog is the current path.

---

## Security

- Both routes require `REPORTS.VIEW`, same gate as every other Reports-sidebar report (Workstream 71's audit finding — this permission category existed but wasn't applied anywhere until that workstream; these two new routes follow the now-established convention).
- Every query filters on `req.companyId` — no cross-company customer or sale data is reachable.
- The customer dropdown used by both reports' filter UI is populated from the existing, already company-scoped `GET /api/customers` — no new global customer list was introduced.
- No `localStorage`/`sessionStorage` writes anywhere in this workstream (verified via diff).

---

## Limitations (documented, not hidden)

- **Whether `create_sale_atomic` posts ACCOUNT-sale charges to `customer_account_transactions` is unconfirmed** — the RPC's source isn't in this repo and wasn't touched. Both reports are correct regardless of the answer (see the Finding section), but this is flagged as a genuine open question, not silently resolved.
- **"Last purchase date"** in the Sales by Customer summary reflects the last purchase *within the selected date range*, not all-time — a deliberate simplification to avoid an extra unbounded query; documented so it isn't mistaken for a CRM-style "last seen ever" figure.
- **A statement can only be as complete as the underlying data.** If a customer had account activity before this reporting existed and it was never captured anywhere (not in `customer_account_transactions`, not as an ACCOUNT sale), it cannot appear — this is why the self-check against `current_balance` exists, to surface exactly this kind of gap rather than hide it.
- Returns (`pos_returns`) and the payment ledger are both empty in the live database today — the code paths are real and correct, simply unexercised by production data yet.

FOLLOW-UP NOTE
- Area: `create_sale_atomic` RPC — customer account charge posting
- Dependency: RPC source not available in this repository
- Confirmed now: neither `sales.js` nor any visible code path writes a `'charge'` row to `customer_account_transactions` for an ACCOUNT sale; both new reports work correctly regardless
- Not yet confirmed: whether the RPC itself does this internally
- Risk if wrong: none to these reports (self-correcting by design); a real risk only if some *other* future feature assumes the ledger is complete without checking
- Recommended next review point: if/when the RPC is ever inspected or rebuilt, confirm whether it posts to `customer_account_transactions` and reconcile with this workstream's de-duplication logic accordingly
