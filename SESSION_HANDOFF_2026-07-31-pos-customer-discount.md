# SESSION HANDOFF — 2026-07-31 — POS: standard customer discount

## What was requested

Some customers get a standard discount percentage across everything they
buy, regardless of payment method (cash, card, or account). Ruan wanted a
"Select Customer" step at checkout, decoupled from payment method — pick
who's buying first, then how they pay.

Per-product-per-customer discounts (a separate ask) is intentionally out of
scope — needs its own join table + admin UI, can follow this.

## Root state before this change

No per-customer discount mechanism existed at all. A customer was only ever
selected at checkout when paying by Account. The sales backend already had
a dormant, never-wired `discount_amount`/`discount_percent` field.

## What was built

| File | Change |
|---|---|
| `accounting-ecosystem/backend/config/pos-schema.js` | New idempotent `ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_percentage DECIMAL(5,2) DEFAULT 0`. |
| `accounting-ecosystem/backend/config/permissions.js` | New `CUSTOMERS.MANAGE_DISCOUNT` permission, `MANAGEMENT_ROLES` only — stricter than general `CUSTOMERS.EDIT` (which includes shift supervisors), since a discount is margin-affecting. |
| `accounting-ecosystem/backend/shared/routes/customers.js` | **The route actually used by the frontend** (`/api/customers`, mounted in `server.js`) — `POST /` and `PUT /:id` now validate and accept `discount_percentage`, gated by `CUSTOMERS.MANAGE_DISCOUNT`. `GET /search` now also selects `credit_limit, discount_percentage` (was missing both — see bugs below). |
| `accounting-ecosystem/backend/modules/pos/routes/customers.js` | Same validation/permission logic also added here for consistency — but see **duplication note** below, this router turned out to be unreachable from the frontend. |
| `accounting-ecosystem/backend/modules/pos/routes/sales.js` | Both `POST /` and `POST /orders`: server now looks up the customer's `discount_percentage` directly from the DB when `customer_id` is present and uses it (never trusts a client-supplied `discount_percent` for this — closes a pre-existing gap where that field was accepted with zero validation). Also fixes a VAT bug — see below. |
| `accounting-ecosystem/frontend-pos/index.html` | Customer picker (previously Account-payment-only) is now always visible above the payment method buttons; `selectPayment()` no longer clears the selected customer when switching methods; `calcCartTotals()` now accepts a discount percent and applies it (subtotal reduced, VAT scaled proportionally); a "Customer discount" row shows in the cart summary; `checkout()`'s offline `saleData` and `syncOfflineSales()` now carry `customerId` through (were missing it entirely — see bugs below); Customer add/edit form has a new "Standard Discount (%)" field, only sent to the server when actually changed. |

## Bugs found and fixed during this work (not separately scoped, but real)

1. **VAT not discount-adjusted** (`sales.js`, both routes) — `vat_total` was
   computed from full pre-discount prices and sent to `create_sale_atomic`
   unadjusted. Since discount was dormant, this never manifested before.
   Fixed: `vat_total_for_rpc = vat_total * (total_amount / subtotal)`.
2. **Offline sales never carried `customer_id`** (`checkout()`'s `saleData`,
   `syncOfflineSales()`) — pre-existing, affects Account-payment offline
   sales too, not just this feature. Fixed by adding `customerId` to both.
3. **`GET /customers/search` never returned `credit_limit`** — the existing
   Account-customer picker has always displayed "R 0.00" limit regardless
   of the real value. Fixed in passing (same `select()` this feature needed
   to touch anyway for `discount_percentage`).

## Known limitation — not in scope

`checkoutWithFeatures()` (Split payment) POSTs to
`${API_URL}/pos/sales/split-payment` — **confirmed this backend route does
not exist anywhere** in `sales.js` or any other POS route file. Split
payment checkout appears to already be broken (404), independent of this
work. Customer discount works correctly for Cash, Card, and Account
(everything routed through the working `POST /pos/sales`) — matching what
was asked for — but not Split. Worth its own follow-up session.

## Duplication note — needs a decision, not resolved this session

There are **two parallel customer route files**:
- `backend/shared/routes/customers.js`, mounted at `/api/customers` — what
  the frontend actually calls (search, list, create, edit). No
  `requirePermission()` gates at all on create/edit (auth-only) except the
  new discount-specific check just added.
- `backend/modules/pos/routes/customers.js`, mounted at `/api/pos/customers`
  — confirmed (grepped) that **nothing in `frontend-pos/index.html` calls
  this path** — appears unreachable from the POS frontend today. It does
  have proper `requirePermission('CUSTOMERS.EDIT')`-style gates the shared
  one lacks.

I added the same discount validation to both rather than deleting the
apparently-dead one, since I couldn't verify with certainty that no other
consumer calls the POS-specific path. Worth a deliberate decision later:
consolidate onto one, or confirm the POS-specific one really is dead and
remove it.

## Confirmed working

- `node -c` on every edited backend file.
- Extracted and syntax-checked every inline `<script>` block in
  `frontend-pos/index.html`.
- Traced every `customer_id`/`customerId` call site through both the online
  and offline checkout paths, and `POST /orders` (Place as Order).

## What was NOT tested

No live Supabase/browser access this session (same constraint as the
earlier cashup fix). Not verified live:
- Actual discount calculation end-to-end against real data.
- The `discount_percentage` column migration actually running (runs
  automatically via `pos-schema.js` on next server boot).
- The customer picker's new always-visible placement rendering correctly
  across screen sizes.

## FOLLOW-UP NOTE

- Area: POS customer discount
- Dependency: live verification (set a test customer's discount, complete a
  Cash/Card/Account sale, confirm on-screen total, receipt, and stored
  `sales.vat_amount`/`discount_amount` all agree)
- Confirmed now: code paths traced, syntax-verified, permission model
  reviewed
- Not yet confirmed: live behaviour; whether `backend/modules/pos/routes/
  customers.js` has any real caller anywhere in the ecosystem
- Risk if wrong: low for the discount feature itself (additive, only
  engages when `customer_id` present); the VAT proration fix and offline
  `customer_id` fix are corrections to previously-dormant/broken paths, so
  no existing working behaviour regresses
- Recommended next review point: first live customer-discount sale
