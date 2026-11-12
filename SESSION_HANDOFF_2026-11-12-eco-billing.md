# Session handoff — 2026-11-12 — Eco billing from Lorenco's own Leo + Leo bank fixes

**Status:** committed as one batch (Ruan: one big commit to save Render builds).
- **Migration 180 RUN 2026-11-12.** 11 rows excluded; 18 billing customers were created in company 40 (a second sync was idempotent). A draft-invoice E2E in sandbox company 51 passed 7/7 and was cleaned up.
- **Migration 181 NOT run.** The code is safe without it (fallbacks), but Link-a-company only works once it has run.

## A. Eco billing (Ruan's spec, 2026-11-12)
- Every company that uses the Eco becomes a customer in **Lorenco Ecosystum's Leo (company 40)**, filled from Eco company data and re-synced automatically.
- Who pays:
  - clients of The Infinite Legacy (company 1) are invoiced themselves;
  - any other practice (e.g. Kobus, 29 clients) gets ONE invoice with a line per client per app;
  - self-registered companies (Warmbaths, SJP) pay for themselves;
  - Lorenco's own companies are invoiced too.
- Test/demo/presentation/merged rows are hidden in Platform Control (behind "Show test/demo") and never invoiced.
- The "Invoice" button creates a **draft** in Leo. Nothing is emailed; Ruan checks the draft and posts it from Leo.

| File | Purpose |
|---|---|
| `backend/config/migrations/180_eco_billing_customers.sql` | `eco_clients.billing_excluded`; `customers.address_line_1/2`, `registration_number`, `eco_billing_company_id` (+ unique index); marks eco_clients 44,46,47,52,40,43,50,48,49,39,42 excluded. **NOT RUN.** |
| `backend/shared/services/ecoBilling.js` (new) | computePayers, customer sync (Eco wins when it has a value, Leo kept otherwise), preview, createDraftInvoice, 15-min sync scheduler (`ECO_BILLING_SYNC=off`), syncSoon. Env: `ECO_BILLING_COMPANY_ID` (40), `LORENCO_PRACTICE_COMPANY_ID` (1). Does NOT set customers.eco_client_id (that drives the client-links invoice push). |
| `backend/shared/routes/eco-billing.js` (new) | `/api/eco-billing` super admin: GET /preview, POST /sync, POST /invoice/:companyId |
| `backend/modules/accounting/services/customerInvoiceCore.js` | `createDraftCustomerInvoice()` (shared draft creator, skips taken INV numbers); invoice PDF loads the buyer's address (falls back if migration 180 has not run) |
| `backend/modules/accounting/services/invoicePdfService.js` | Bill-to box prints address, city, VAT and reg no., and grows to fit |
| `backend/config/app-pricing.js` | Optional `amount` / `perEmployee` per app + `amountsFor()`; empty = R0.00 on drafts |
| `backend/shared/routes/eco-clients.js` | `billing_excluded` is admin-only + updatable; syncSoon after create/update/adopt |
| `backend/server.js` | Mounts the routes, starts the sync (step 4i) |
| `frontend-ecosystem/admin.html` | "Show test/demo (n)" chip; Hide/Unhide per client; 🧾 Invoice on holder headers (practice/self/TIL own use) and on TIL client cards; ⚠ when VAT/address/email missing |
| `backend/tests/eco-billing.test.js` (new) | TEST-BILL-01..08 |

## B. Leo bank fixes (earlier the same day)
- Confirm All Visible no longer hangs.
- Transfer to Account now moves lines in bulk.
- Balances keep their minus sign.
- The running balance is correct when Date From is set.
- The opening balance can be edited.
- Files: `bankStagingService.js`, `routes/bank.js`, `frontend-accounting/bank.html`.

## Confirmed
- Full suite: 1348 passed, 8 skipped.
- Lint: 0 errors.
- Inline scripts in admin.html and bank.html parse.
- Invoice PDF renders with and without an address.
- Dry run of computePayers on live data (read-only): 18 payers. Kobus has 29 clients; TEST and demo rows are excluded.

## Ruan must do
1. Say "ja" for migration 180, which must run BEFORE the deploy.
2. Company 40 has an **empty chart of accounts**. Pick a template on its Accounts page; otherwise drafts can't be posted. (Walkerpark, company 3, has the same issue.)
3. Fill in the company details: only 4 of 18 billable companies have a VAT number, 2 an address and 1 an email.
4. Prices are still empty in app-pricing.js, so draft lines show R0.00.
5. Practices' own modules (Kobus, Hein, MD: pos/payroll/accounting/sean) appear as lines. These may just be default modules, so delete them on the draft if they aren't really used.

## C. Link an existing company (built later the same day)
- Add Client → "🔗 Link an existing company".
- The practice finds the company by its client code (CLT-…) or email, ticks the apps it wants, and sends the request.
- The company's managers get an email, plus a card on their ECO Hub dashboard with yes/no per app.
- On approval an `eco_clients` row is created under the practice with `access_link = true` and the approved apps.
- That row is an access grant only. It never changes the company's modules or details, and it is never invoiced, because the company pays for itself.
- The practice cannot edit the row (PUT returns 409 `LINKED_COMPANY_READ_ONLY`; app requests return 409). It can switch the link off.
- A super admin can NOT approve on the company's behalf, because consent is the company's.

| File | Purpose |
|---|---|
| `backend/config/migrations/181_company_link_requests.sql` | `eco_clients.access_link` + `company_link_requests`. **NOT RUN: the run was blocked by the permission filter. Ruan must run it or allow it.** |
| `backend/shared/services/linkRequests.js`, `shared/routes/link-requests.js` (new) | `/api/link-requests`: lookup, request, outgoing, withdraw, incoming, decide |
| `backend/shared/routes/auth.js` (HIGH, shared) | sso-launch: an access_link row only opens approved apps. Additive; falls back to the old lookup if the column is missing |
| `backend/shared/routes/eco-clients.js`, `app-subscriptions.js` | Linked rows read-only (only is_active; admin also billing_excluded) |
| `backend/shared/services/ecoBilling.js` | Skips access_link rows; falls back if the column is missing |
| `frontend-ecosystem/dashboard.html` | Link modal, incoming-requests banner, 🔗 Linked badge, Edit Apps blocked on linked rows |
| `frontend-ecosystem/admin.html` | Linked rows are not treated as data silos, so the company's own holder group stays visible |
| `backend/tests/link-requests.test.js` (new) | TEST-LINK-01..06 |

```
CHANGE IMPACT NOTE — PAYROLL (shared auth.js)
- Area: sso-launch eco_client branch
- Change: also selects access_link, apps; refuses targetApp not in apps ONLY when access_link = true
- Paytime risk: LOW — existing eco_client rows have access_link = false (default), so the path is unchanged; if the column is missing the original select runs
- Confirmed safe: payroll-engine.js, PayrollCalculationService, snapshot read path, company context, PAYE/UIF/SDL not touched
- Regression: full backend suite incl. golden tests: 1354 passed

FOLLOW-UP NOTE
- Area: per-app restriction for linked companies
- What was done now: enforced at sso-launch (the ECO Hub app-launch path); dashboard shows only approved app buttons
- What still needs to be checked: select-company has no per-app gate (it is app-agnostic), and middleware/auth.js requires a direct user_company_access row for non-super-admins, so cross-company work is already limited; review whether linked access needs a server-side per-module check
- Risk if not checked: a practice user who reaches the company via another path might see an unapproved app
```

```
FOLLOW-UP NOTE
- Area: invoice creation
- Dependency: POST /customer-invoices + recurringInvoiceService have their own insert copies
- What was done now: new shared createDraftCustomerInvoice used only by Eco billing
- What still needs to be checked: fold the other two onto it when next touched
- Risk if not checked: three copies drift
- Recommended next review point: next change to invoice creation

FOLLOW-UP NOTE
- Area: customer sync timing
- Dependency: company details are edited via shared/routes/companies.js (Paytime HIGH file, not touched)
- What was done now: sync on eco-client create/update/adopt + every 15 min + right before invoicing
- What still needs to be checked: whether a 15-min lag is acceptable
- Risk if not checked: none for invoices (they always sync first); the Leo customer list lags briefly

FOLLOW-UP NOTE
- Area: Leo running balance
- What still needs to be checked: running balance is still wrong with the Status filter (rows of other statuses missing from the chain)
```
