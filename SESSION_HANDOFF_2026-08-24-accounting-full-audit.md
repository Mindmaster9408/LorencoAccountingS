# SESSION HANDOFF — 2026-08-24 — Lorenco Accounting (Ledger Leo) full-module audit

## What was changed

User asked for the entire Accounting module verified end-to-end — every
report, every setting, every page — after an earlier 6-item GL audit fix in
the same broader session. A 5-agent audit covered all 48 frontend pages
against their 33 backend routes and found ~29 distinct issues. User chose to
fix all of them in one pass ("Alle 24 in een groot plan"), then separately
confirmed two scope decisions: remove the redundant AI Settings page
entirely rather than build out its missing tables, and attempt real first
versions of Cash Flow / Sales Analysis / Purchase Analysis rather than leave
them as honest empty states.

**Tier 1 — mechanical field-name/endpoint fixes (15 items):** `suppliers.js`
PUT `/:id` patch semantics, `pos-bridge.js` customer SELECT missing columns,
`customer-list.html` field mapping, `bank-rules.html` camelCase reads,
`products-services.html`/`quotes.html` dead account-dropdown endpoint,
`vat.html` field name + submission-history race condition, `paye-config.html`
`is_default` mapper, `bank.html` VAT account code `2310→1400`,
`accounting-periods.html`/`audit-log.html` wrong API base paths,
`journals.js` real `total_debit`/`total_credit` aggregation, `customers.html`
field name, `pilotControls.js` missing `checklist_answers` column,
`auditEventNormalizer.js`/`audit.js` real user-name join, `journals.js`/
`bank.js` real counts + missing status filter, `bank-staging.html` broken
transfer-detail rendering.

**Tier 2 — real backend gaps (5 items):** `vatReportService.js` out-of-period
VAT sweep-forward inclusion, `vatReconciliationService.js` derived `status`
field (column didn't exist), `payeReconciliationService.js`/
`paye-reconciliation.html` fake-data injection removed + real period
selector + `getDraft` income/deduction-line joins + `emp201_data` persistence
(migration 145), `paye.html`/`payeReconciliationService.js` new
`getEmp201`/`GET /emp201/:periodId`, and `suppliers.js` new `GET /aging` +
`aged-creditors.html` rebuild.

**Tier 3 — removals and new builds:** deleted `ai-settings.html` + its nav
link; removed `settings.html`'s dead "Business Defaults"/"Report Display"
cards; rebuilt `system-health.html` to show only real `/api/health` data;
wired `profile.html` to the real `PUT /api/users/me`; added `/api/health` and
`/api/users` to `eco-api-interceptor.js`'s exclusion list; new
`customer-invoices.js` `GET /sales-analysis` route; fixed a real Express
route-ordering bug in the same file (`/:id` was shadowing the pre-existing
`/aging` and `/payments` literal routes — constrained to `/:id(\d+)`).

**Post-hoc bug found while implementing Tier 2 item 20:** a duplicate
`GET /aging` route had been added to `suppliers.js`, silently shadowing an
already-existing, differently-shaped one further down the file. The
duplicate was removed; `aged-creditors.html` was rewritten to match the real
route's response shape.

**New financial reports (Tier 3, built from scratch):**
- `GET /api/accounting/reports/cash-flow` (`reports.js`) — indirect method,
  built from the existing `accounts.sub_type`/`reporting_group`
  classification: net income + depreciation add-back + working-capital
  movement (operating), non-current-asset movement (investing),
  non-current-liability/short-term-loan/share-capital/drawings movement
  (financing). Includes an honest `isBalanced` cross-check against actual
  bank-account movement rather than silently showing a reconciled-looking
  number. `cashflow.html` rebuilt to consume it.
- `GET /api/accounting/suppliers/purchase-analysis` (mirror of
  `sales-analysis`) — spend by supplier, by expense account, monthly trend.
  `purchase-analysis.html` rebuilt to consume it.
- `sales-analysis.html` rebuilt to consume the already-existing
  `/sales-analysis` route (backend existed, frontend was still 100% fake).

**Live-testing fixes (2026-08-24, after logging into the "Infinite Legacy —
TEST" company, id 51, with the master admin account):** two real,
previously-undiscovered schema-name mismatches, confirmed against the live
PostgREST schema rather than assumed from reading application code:
- `supplier_invoices` actually has `date`/`subtotal`/`total_amount`/
  `balance_due` (same naming convention as `customer_invoices`), **not**
  `invoice_date`/`subtotal_ex_vat`/`total_inc_vat` as the pre-existing
  `/aging` route and the newly-written `/purchase-analysis` route both
  assumed.
- `suppliers` has `supplier_code`, **not** `code`.
- `supplier_invoice_lines` only has `line_total`, **not**
  `line_subtotal_ex_vat`.

Both routes were fixed to the real column names and re-verified live
(200 OK). This was caught specifically because the pre-existing `/aging`
route — which an earlier audit pass had rated "CORRECT" — had in fact **never
been exercised successfully**: there are 0 rows in `supplier_invoices` across
every company in the database, meaning the AP invoice-creation path has
likely never been used by a real client yet. See open risk below.

## Root cause addressed

Recurring bug class across the whole module: a frontend page (or, in two
cases, a backend route) reads/writes a field name the other side doesn't
actually have, so it silently shows blank/wrong data or 404s instead of
erroring loudly. Each instance was fixed at its precise source rather than
patched around. The Tier 3 "build for real" items replaced invented,
hardcoded mock figures with genuine posted-GL aggregation.

## Confirmed working

- Every touched backend `.js` file: `node -c` + `eslint` clean (only
  pre-existing, unrelated `no-unused-vars` warnings remain — zero `no-undef`
  errors anywhere in the pushed diff, per CLAUDE.md Rule G2).
- Every touched/rebuilt HTML file's inline script: `new Function()` parse
  check clean.
- Migrations 140, 141, 143, 144, 145 — all confirmed run successfully by the
  user in Supabase (verification `SELECT`s returned expected columns).
- Live-tested against **Infinite Legacy — TEST** (company id 51) with a real
  server instance and a real login:
  - `GET /api/accounting/suppliers/aging` → 200 OK (`{"aging":[]}` — correct,
    TEST company has no supplier invoices yet).
  - `GET /api/accounting/suppliers/purchase-analysis` → 200 OK (empty, same
    reason).
  - `GET /api/accounting/customer-invoices/sales-analysis` → 200 OK (empty).
- Pushed to `origin/main` in two commits (`82225cd`, `1d98b01`). No POS files
  touched, so CLAUDE.md Rule G1 (trading-hours push timing) did not apply;
  Rule G2's lint gate was run and passed before both pushes.

## What was NOT changed / not tested — explicit follow-ups

**FOLLOW-UP NOTE**
- Area: Sales Analysis (`sales-analysis.html` + `/sales-analysis`)
- Dependency: real posted `customer_invoices` data in a live company
- Confirmed now: endpoint returns 200 with correct empty-state shape against
  TEST company (which has no posted invoices yet)
- Not yet confirmed: real numbers against a company with actual invoice data
  — by-customer, by-account, and monthly-trend figures have not been
  eyeballed against known-correct totals
- Risk if wrong: revenue figures on this report could be silently wrong in a
  way that only shows up once real data flows through it
- Recommended next check: run it against a real client company (not TEST)
  with existing posted invoices, or post a handful of test invoices in TEST
  first, and manually verify the totals

**FOLLOW-UP NOTE**
- Area: PAYE Reconciliation (`paye-reconciliation.html` /
  `payeReconciliationService.js`, migration 145 / `emp201_data`)
- Dependency: the full draft → approve → lock workflow, plus the new
  `getDraft` income/deduction-line joins and `emp201Data` persistence
- Confirmed now: migration 145 ran successfully (`emp201_data` column
  exists, type `jsonb`); code lints clean
- Not yet confirmed: has not been clicked through in the browser at all this
  session — create/reopen a draft, confirm employee income/deduction lines
  reload correctly, confirm EMP201 data round-trips through save/reload,
  confirm an already-approved/locked period is still discoverable (the fix
  for the old `status='DRAFT'`-only lookup bug)
- Risk if wrong: this is SARS-compliance-adjacent data (PAYE/UIF/SDL
  reconciliation) — a silent bug here has real compliance consequence, not
  just a cosmetic one
- Recommended next check: full manual walkthrough in TEST company before
  relying on this for any real client's EMP201 submission

**FOLLOW-UP NOTE**
- Area: Cash Flow Statement, and by extension Profit & Loss / Balance Sheet
  (all three share `reports.js`'s `fetchAccountBalances` helper)
- Dependency: a direct Postgres connection (port 5432,
  `ACCOUNTING_DATABASE_URL`) — separate from the Supabase REST/JS client
  used everywhere else in this session's testing
- Confirmed now: code lints clean; the new Cash Flow route's logic mirrors
  the already-shipped `/profit-loss` route's pattern exactly
- Not yet confirmed: **could not be live-tested at all** — this sandbox
  environment cannot reach direct Postgres (confirmed by testing the
  pre-existing, untouched `/profit-loss` route, which failed with the
  identical "Connection terminated due to connection timeout" error). This
  is an environment limitation, not evidence of a code defect, but it also
  means Cash Flow's actual arithmetic (in particular the `isBalanced`
  cross-check) has never been run against real numbers by anyone yet.
- Risk if wrong: could show plausible-looking but incorrect cash-flow
  figures, or a false "not balanced" warning
- Recommended next check: open Cash Flow Statement in a real browser session
  against a company with real posted transactions across a date range, and
  manually verify the `isBalanced` check actually reconciles for a period
  with no uncategorized accounts

**FOLLOW-UP NOTE — bigger, out-of-original-scope finding**
- Area: Accounts Payable / Supplier Invoice creation (`POST /invoices` in
  `suppliers.js`), not something this audit set out to check
- Dependency: discovered only because live-testing the Aged Creditors fix
  required checking real column names
- Confirmed now: `supplier_invoices` has **zero rows across every company in
  the entire database** — the AP invoice-creation feature appears to have
  never successfully run for any real client. The `POST /invoices` route's
  raw-SQL `INSERT INTO supplier_invoice_lines (...)` statement references
  `line_subtotal_ex_vat`/`vat_amount`/`line_total_inc_vat`/`sort_order` —
  none of which exist on the real `supplier_invoice_lines` table (confirmed
  via the live PostgREST schema; only `line_total` exists). If this
  statement has ever actually executed, it would fail with a Postgres
  "column does not exist" error.
- Not yet confirmed: whether `POST /invoices` (and any other AP write path
  in `suppliers.js` beyond the two read-only routes fixed today) is
  currently broken end-to-end
- Risk if wrong: the whole Accounts Payable module may be non-functional for
  creating real supplier invoices — this is a much larger fix than today's
  audit scope and was **not** attempted this session
- Recommended next check: **explicitly confirm with the user before touching
  this** — it needs its own audit of every write path in `suppliers.js`
  against the real schema, not a quick patch, per CLAUDE.md Rule A1 (audit
  before change)
