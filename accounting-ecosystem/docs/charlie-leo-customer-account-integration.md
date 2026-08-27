# Charlie ↔ Leo: Customer/Account Sale Integration — Current State

> **Purpose of this document:** ground truth only. This describes exactly
> what exists in the code TODAY (2026-08-21) for how Checkout Charlie (POS)
> and Ledger Leo (Accounting) relate to each other on customers and account
> ("on account" / credit) sales. It does not propose or describe any future
> design — that comes later, once this baseline is agreed. Keep this
> updated as either side changes; it's meant to stay accurate over time,
> not be a one-off snapshot.
>
> **Explicitly out of scope for this document:** the daily till → draft
> invoice bridge that books cash+card takings against a dummy "Checkout
> Charlie - Sales" customer (`pos-bridge.js`'s `gl-sync/generate-invoice`).
> That's a separate, already-documented mechanism ([[project_pos_accounting_gl_sync]]
> memory, Phase A). It's mentioned once below only where it directly
> collides with real account-sale handling — not explained in full here.

---

## 1. The shared data model

Charlie and Leo are not two separate systems with a sync layer between
them — they read and write the **same `customers` table**, in the same
Supabase database, scoped by `company_id`. There is no separate "Leo
customer" vs "Charlie customer" — it's one row.

- `shared/routes/customers.js` (mounted at `/api/customers`) is the route
  Charlie's frontend actually calls for customer search/list/create/edit.
- `accounting/routes/customer-invoices.js` (Leo) reads/writes the same
  `customers` table directly by `customer_id` FK for every invoice.
- `accounting/routes/pos-bridge.js` explicitly documents this in its own
  header comment: *"POS tables (sales, customers) live in the same
  Supabase database as accounting tables."*

Two relevant columns already exist on `customers`:
- `credit_limit`
- `current_balance` — see section 2. This is the one column at the center
  of the current gap.

There is also a second, unrelated customer route file —
`modules/pos/routes/customers.js` (mounted at `/api/pos/customers`) — which
nothing in the actual frontend calls. Don't assume it's "the" API for
anything; it's effectively dead code today.

---

## 2. How Charlie handles an "Account" sale today

When a cashier completes a sale with `payment_method = 'account'`
(`modules/pos/routes/sales.js`), the customer must already exist in the
shared `customers` table. What happens next is entirely self-contained
inside POS:

- `postAccountCharge()` → `adjustCustomerAccountLedger()` runs a
  compare-and-swap update: reads `customers.current_balance`, adds the sale
  amount, writes it back (retrying if another concurrent write raced it),
  and appends one row to `customer_account_transactions` (`type: 'charge'`,
  `reference: saleNumber`, `balance_after`).
- Voiding the sale later calls `reverseAccountCharge()` — never edits the
  original charge row, appends an offsetting `'charge_reversal'` row
  instead (append-only ledger, idempotency-guarded per `sale_id`).
- A partial or full **return** against an account-tender sale calls
  `reverseAccountChargeForReturn()` — same ledger, `'return_reversal'`
  type, keyed per `pos_returns` row so multiple returns against one sale
  each post their own line without double-reversing.
- If the linked customer belongs to a company-linked partner (Workstream
  99/100 — see [[project_company_link_supplier_customer_mirroring]]),
  `syncAccountSaleToLinkedBuyerPO()` additionally tries to attach the sale
  to a Purchase Order on the OTHER company's side. That's the
  inter-company (two separate companies) case — not relevant to a single
  company's own Charlie/Leo relationship, which is what this document
  covers.

**What this does NOT do:** at no point does an account sale create a
`customer_invoices` row, post anything to `journals`/`journal_lines`, or
touch any GL account. `customer_account_transactions` and
`customers.current_balance` are the entire extent of it. Confirmed by
direct search: nothing under `modules/accounting/` references
`customer_account_transactions` anywhere in the codebase.

---

## 3. How this surfaces inside Leo today — read-only visibility, not integration

`accounting/routes/pos-bridge.js` exposes a few routes under
`/api/accounting/pos/...` that let a bookkeeper see POS data from inside
the Accounting app:

- `GET /api/accounting/pos/customers` — lists customers with POS sales
  aggregates (total sales, lifetime value, last account-sale date) merged
  in per row.
- `GET /api/accounting/pos/customers/:id` — customer detail, including
  `salesSummary.outstandingBalance`, which is read **directly from
  `customer.current_balance`** — i.e. the exact same POS ledger balance
  from section 2, not anything Leo computed itself.

This is explicitly a read-only window into POS data (the file's own header
comment: *"Provides accounting-side read access to POS data"*). It is not
a sync, not a reconciliation, and it does not feed anything else in Leo —
a bookkeeper looking at this screen sees the POS balance, full stop.

---

## 4. How Leo's own real AR (debtors) balance works — completely separate

Leo's actual accounts-receivable tracking lives entirely in
`customer_invoices` (+ `customer_invoice_lines`), independent of
`customers.current_balance`:

- Each invoice tracks its own `total_amount`, `amount_paid`, `balance_due`.
- `GET /aging` (customer-invoices.js) computes the real debtors aging
  buckets by summing `total_amount - amount_paid` **per invoice**, grouped
  by customer — it never reads `customers.current_balance`.
- The actual GL debtors control account only moves when
  `customer-invoices.js`'s `POST /:id/send` posts a journal
  (AR debit / Revenue + VAT Output credit) via `JournalService`.

So today, a single customer can simultaneously have:
- A `customers.current_balance` of, say, R500 (from Charlie account sales),
  and
- A completely different real AR balance in `customer_invoices`/aging
  (from however many actual invoices Leo has for them — possibly zero, if
  they've never had a manually-created accounting invoice).

**These two numbers have no relationship to each other and nothing
reconciles them.** A customer could owe R500 at the till and Leo's books
would show R0 receivable from them — or vice versa — indefinitely, with no
error, no warning, and no report that would surface the mismatch, because
each system has zero visibility into what the other one is doing.

---

## 5. Where this collides with the daily till bridge (Phase A) — a live double-count risk

Not the focus of this document (see the note at the top), but this one
interaction matters directly for account sales: `pos-bridge.js`'s
`POST /gl-sync/generate-invoice` (the daily "Checkout Charlie - Sales"
draft invoice, when a company has opted in) pulls **every** completed sale
for that SA calendar day into the aggregate — the query
(`sales.status = 'completed'`) has **no filter excluding
`payment_method = 'account'`**.

That means, on a company with GL sync enabled: an account sale's VAT/revenue
is already being swept into that day's lumped "Checkout Charlie - Sales"
invoice — separately from, and with zero awareness of, the
`customers.current_balance` charge the same sale also posted. If a future
mechanism ever posts a REAL customer_invoice for that same account sale (to
close the gap in section 4), the revenue for that one sale would be
recognised twice in the GL unless the daily till aggregate is changed to
exclude account-tender sales first.

---

## 6. Summary — the current state in one paragraph

Charlie and Leo share one `customers` table, but an "Account" sale at the
till only ever updates a POS-only ledger (`customers.current_balance` +
`customer_account_transactions`) — it never becomes a real Leo invoice,
never touches the GL, and is invisible to Leo's actual AR/aging, which is
built purely from `customer_invoices`. Leo can only ever *see* the POS
balance read-only (`pos-bridge.js`), never reconcile against it. Separately,
the existing daily till→invoice bridge already sweeps account-sale amounts
into its lumped total with no exclusion, which will double-count revenue
the moment account sales get their own real invoice path. No code changes
have been made as a result of this document — it exists purely to establish
agreed ground truth before any design work starts.
