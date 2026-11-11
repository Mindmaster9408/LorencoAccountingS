# Session Handoff — 2026-11-11 — Ledger Leo: annual / monthly billing

## What Ruan asked for
Quotes and invoices in Leo must be able to show a client "this is the annual amount, this is the monthly amount". It is opt-in per document, because not everyone will use it. Decisions Ruan made:
- When the client chooses monthly, Leo makes **recurring invoices** (12 months).
- Monthly amount = **annual ÷ 12**, worked out automatically.
- Available on **quotes and invoices**.
- Each monthly invoice is **created, posted to the GL and emailed automatically** until the plan is done.

## How it works
1. Switch on **"Offer the client an annual or monthly payment option"** on a quote or invoice. It is off by default.
2. The PDF shows a PAYMENT OPTIONS block: annual once-off, or monthly × 12.
3. In the invoice list, a draft that offers the option shows **Client chose Annual** and **Client chose Monthly** instead of *Post to GL*. Posting is blocked until a choice is recorded (`BILLING_CHOICE_REQUIRED`).
   - **Annual:** the invoice is posted as normal.
   - **Monthly:** a plan is created and the draft becomes instalment 1 (each line ÷ 12). Instalments 2–12 are created on the same day of each following month, clamped to month end. Each one is posted and emailed automatically.
4. The new **Monthly Plans** tab lists each plan with its progress, next date and last error. It has **Stop plan** (a reason is required) and **Run now**.

## Files
| File | Change |
|---|---|
| `backend/config/migrations/178_invoice_billing_options.sql` | NEW. Billing columns on `customer_invoices` / `customer_quotes`, new `customer_invoice_recurring_plans` table, unique (plan, instalment) index. |
| `backend/modules/accounting/services/customerInvoiceCore.js` | NEW. Helpers moved verbatim out of `customer-invoices.js`, plus `postCustomerInvoice` / `emailCustomerInvoice`, lifted verbatim out of the Post / Send routes so that user posts and automatic posts share one code path. Also adds the billing-choice post guard and `buildInvoicePdf`. |
| `backend/modules/accounting/services/recurringInvoiceService.js` | NEW. `chooseBilling`, `runPlan`, `runDuePlans` (advisory-locked), `cancelPlan`, hourly scheduler, pure split/date helpers. |
| `backend/modules/accounting/routes/customer-invoice-billing.js` | NEW. `POST /:id/billing-choice`, `GET /recurring-plans`, `POST /recurring-plans/run`, `POST /recurring-plans/:id/cancel`. |
| `backend/modules/accounting/routes/customer-invoices.js` | Post / Send are now thin wrappers around the core service. Create/update store `billingOptionEnabled`. Plan instalments cannot be edited. New `GET /:id/pdf`. |
| `backend/modules/accounting/routes/quotes.js` | **2 pre-existing bugs fixed** (see below). `billingOptionEnabled` added. New `GET /:id/pdf`. |
| `backend/modules/accounting/services/invoicePdfService.js` | Payment options block, "Monthly instalment n of 12" line, new `generateQuotePdf`. |
| `backend/modules/accounting/index.js` | Mounts the billing router. |
| `backend/server.js` | Starts the hourly scheduler. `RECURRING_INVOICES_SCHEDULER=off` disables it. |
| `frontend-accounting/invoices.html` | Toggle with preview, choice buttons, plan tags, PDF button, Monthly Plans tab. |
| `frontend-accounting/quotes.html` | Toggle with preview, PDF button. |
| `backend/tests/recurring-invoices.test.js` | NEW. 7 money/date tests. |

## Pre-existing bugs found and fixed (quotes were 100% broken)
1. `quotes.js` destructured `db` from `config/database`, which does not export it, so **every quote create, update and convert threw**. `customer_quotes` had 0 rows.
2. `convert-to-invoice` wrote to columns that do not exist on `customer_invoices` (`customer_name`, `reference`, `invoice_date`, `subtotal_ex_vat`, `total_inc_vat`, `created_by_user_id`, and line `subtotal_ex_vat`/`sort_order`). It is rewritten against the real schema, resolves or creates the customer, and takes a row lock against double conversion.

## Verified
- Lint is clean on all changed files.
- 7 new tests plus the AC-03 and AUTH-01 invoice suites pass (72 tests).
- Full suite: 1210 passed, 10 failed. The 10 failures are in 4 suites (payroll-employee-sync, teach-paytime, supplier-invoice-ocr-drafts, historical-comparatives-dashboard) and **fail identically on a clean checkout**, so this work did not cause them.
- PDFs rendered with fictional data and checked visually: invoice with options, instalment, quote.

## Update (same day, second pass)
- **Migration 178 RUN** in Supabase (Ruan: "jy kan migrasie loop"); all columns, the table and the indexes were verified.
- **E2E in company 51 (Infinite Legacy — TEST), 23/23 PASS** via the real API on a local server: invoice with option → post blocked → PDF → choose Monthly (invoice dated 2 months back) → instalments 1–3 created and posted, R1 150 each, dated 11 Sep/Oct/Nov, journals balanced → email failure reported (test customer has no email) → instalment edit blocked → Run now creates no duplicates → plan list correct → stop plan, and a later run leaves it stopped → quote create/PDF/convert (previously broken) → double convert blocked → Annual then normal post → plain invoice without the option unchanged. The E2E data remains in company 51 (sandbox; safe to delete).
- **Found and fixed by the E2E:** a race where a run that started before "Stop plan" could still create or post a month after it. The engine now re-checks the plan status before each month and only updates ACTIVE plans. Also, `planId` came back as a string (node-pg BIGSERIAL); it is now a number.
- **The 10 pre-existing test failures are all fixed. Full suite: 1258 passed, 0 failed, 8 skipped.**
  - `sean/teach-paytime-service.js` (real bugs): a single-column "Item Name" header became an item, and free text with no payroll signal became a proposed item.
  - `tests/historical-comparatives-dashboard.test.js`: the mock was hoisted before `path` was defined and declared `virtual`, and it was never reset between tests (the code was correct).
  - `tests/supplier-invoice-ocr-drafts.test.js`: wrong relative mock paths.
  - `tests/payroll-employee-sync.test.js`: **it INSERTed and DELETEd rows on `DATABASE_URL` (production!)**. It now runs only with an explicit `DATABASE_URL_TEST` and is skipped otherwise. Companies 998/999 do not exist, so no real data was ever touched.
- **Local `.env` `DATABASE_URL` still points at the retired Zeabur Postgres**, so the accounting pg pool times out locally (coaching too). Fix the local `.env`, and make sure Render's `DATABASE_URL`/`ACCOUNTING_DATABASE_URL` point at Supabase.
- Minor, not fixed: invoice create and convert responses return `date` as a UTC timestamp (pg DATE → JS Date, e.g. `2026-11-10T22:00Z` for 11 Nov). The UI does not use it (the list reloads via Supabase), but an API consumer would see the day before.

## Configuration visibility (third pass)
New `backend/config/runtimeChecks.js`, plus `isEmailConfigured()` in `shared/services/email.js`. Nothing it reports contains a secret: values are yes/no, and the DB is described only by provider.
- **Startup:** Render logs show `🔎 Configuration check:` with ✅/❌ for the accounting Postgres pool (which env var it uses and the provider: supabase/zeabur/other) and ⚠️ if email is not configured.
- **`GET /api/health`** now has a `checks` block: `accountingDb` ok/failed (a real `SELECT 1`, cached 60s), `accountingDbProvider`, `email`, `recurringInvoiceScheduler`. **The HTTP status is unchanged**, so a Render health probe cannot start restart-looping.
- **Leo → Monthly Plans** shows a yellow banner when email is not configured.
- Verified locally: with the Supabase URL → `ok/supabase`; with the current local `.env` → `failed/zeabur, connection timeout`.

## NOT done / required before go-live
- Not committed or pushed.
- After the push, open `https://app.lorencoecosystem.com/api/health` and check that `checks.accountingDb` = `ok` and the provider = `supabase`.
- **Automatic email needs `RESEND_API_KEY` + `EMAIL_FROM`** (still not set locally). Until they are set, instalments still post, but the email fails. The plan shows the error and retries hourly, and the plan never shows as "completed" while emails are outstanding.

```
FOLLOW-UP NOTE
- Area: Monthly plan VAT rounding
- Confirmed now: 12 instalments' ex-VAT (EX mode) / gross (INC mode) sum to the annual amount exactly (tests RI-01/02/05/06)
- Not yet confirmed: total VAT over 12 invoices can differ from the annual quote's VAT by a few cents (each invoice's VAT is computed on its own lines, as a tax invoice must be)
- Risk if wrong: cents-level difference between quote and sum of invoices
- Recommended next check: Ruan to confirm this is acceptable

FOLLOW-UP NOTE
- Area: Plan length / renewals
- Confirmed now: fixed 12 monthly instalments, plan ends after 12; stopping a plan does not touch posted invoices
- Not yet confirmed: whether Ruan wants auto-renew, other lengths, or quarterly
- Risk if wrong: none for current use; schema already has instalments_total / frequency columns
- Recommended next check: ask Ruan after first real use

FOLLOW-UP NOTE
- Area: Invoice numbering
- Confirmed now: the engine skips taken numbers; the existing invoice/quote routes still use count+1 (pre-existing, can collide with the unique index after deletions)
- Risk if wrong: occasional 500 "duplicate key" on manual invoice create
- Recommended next check: move all three to one shared nextInvoiceNumber()
```
