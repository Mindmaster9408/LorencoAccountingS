# SESSION HANDOFF — 2026-07-31 — POS: per-product customer discounts + urgent fixes

## What was requested

Follow-on to the standard (flat) customer discount shipped earlier today
(commit `785c4ab`): some customers should get a discount on *specific*
products only, not everything.

## Two urgent, unrelated things fixed alongside this

1. **Dark-theme regression** in the customer picker shipped this morning —
   hardcoded light colors (`#f0f4ff`, `white`, `#ddd`, `#666`, `#f0f4ff`
   hover) were barely visible when the section only showed for Account
   payment; became glaring once it was made always-visible. Replaced with
   the existing `var(--surface)`/`var(--border)`/`var(--text)`/
   `var(--text-secondary)`/`var(--surface-hover)` tokens already used
   correctly elsewhere in this file.

2. **Daily Discount was never actually charged** — confirmed via grep:
   `GET /api/pos/products` attaches `discount_price` from
   `pos_daily_discounts` for on-screen display (`products.js`), but
   `sales.js` (both `POST /` and `POST /orders`) computed the charged price
   from raw `products.unit_price` only — zero references to
   `pos_daily_discounts` anywhere in that file. A cashier saw a discounted
   price in the cart; the customer was charged full price. Confirmed with
   Ruan to fix as part of this work (same code being touched anyway).

## Confirmed precedence rules (from Ruan)

- A customer's product-specific discount **replaces** their blanket
  discount for that line (never stacks) — other lines still get the
  blanket rate.
- Between a customer-specific discount and an active Daily Discount on the
  same product: **whichever gives the customer the lower price wins**.
- Extended the same "best price wins" principle (not separately asked, but
  the natural generalisation) to blanket-vs-Daily-Discount when there's no
  product-specific override.

## What was built

| File | Change |
|---|---|
| `accounting-ecosystem/backend/config/pos-schema.js` | New `customer_product_discounts` table (customer_id + product_id unique, `discount_type` 'fixed'/'percent' matching `pos_daily_discounts`' vocabulary) + index. |
| `accounting-ecosystem/backend/shared/routes/customers.js` | New `GET/POST/DELETE /:id/product-discounts` — the router the frontend actually calls (confirmed this morning). POST/DELETE gated by `CUSTOMERS.MANAGE_DISCOUNT`. |
| `accounting-ecosystem/backend/modules/pos/routes/customers.js` | Same three routes mirrored here too, per this morning's decision to keep the two parallel customer-route files in sync rather than resolve the duplication now. |
| `accounting-ecosystem/backend/modules/pos/routes/sales.js` | New `resolveEffectivePrices()` helper — reconciles Daily Discount, customer product-override, and blanket discount per line via `Math.min()` of all applicable candidates. **Replaces** this morning's whole-cart-percentage discount math (and its proportional VAT-scaling fix) in both `POST /` and `POST /orders` — the old approach couldn't express "this line is exempt from the blanket rate because it has its own override." VAT is now computed directly from each line's already-discounted price. `sale_items.discount_amount` (an existing but previously always-`0` column) is now populated with the real per-line saving. |
| `accounting-ecosystem/frontend-pos/index.html` | `calcCartTotals()` rewritten for per-line pricing (same `min()` logic, client-side preview only — backend is authoritative). New module-level `selectedCustomerProductDiscounts` Map, populated via `GET /customers/:id/product-discounts` in `selectAccountCustomer()`, cleared in `clearSelectedCustomer()`. New "Discounts" sub-tab on `showCustomerDetail()` (list/add/remove product-specific discounts; add-form only rendered for management roles client-side — server-enforced regardless). Cart summary's discount row label is now generic ("Discount:") since the figure can now come from three different sources, not just the flat customer rate. |

## Design note — why this supersedes this morning's discount math, not just adds to it

This morning's blanket-discount fix computed one flat `discount_percent`
off the whole cart subtotal, then proportionally scaled VAT to match. That
model has no way to say "this one line is exempt because it has its own
override." The new model prices each line independently
(`resolveEffectivePrices()`/`calcCartTotals()`), and VAT falls out
correctly per line with no proportional correction needed — simpler and
strictly more correct. Nothing from this morning's approach survives
inside `sales.js`'s item-enrichment block; it was fully replaced, not
layered on top.

## Confirmed working

- `node -c` on every edited backend file.
- Extracted and syntax-checked every inline `<script>` block in
  `frontend-pos/index.html`.
- Manually traced the precedence formula against both confirmed rules and
  the extended generalisation.

## What was NOT tested

No live Supabase/browser access this session (same constraint as this
morning's other two features). Not verified live:
- The full 3-way precedence scenario (Daily Discount + blanket + specific
  override on the same product) against real data.
- The new `customer_product_discounts` table migration actually running
  (auto-runs via `pos-schema.js` on next server boot).
- The Product Discounts admin tab rendering/working end-to-end in a browser.
- Whether fixing "Daily Discount now actually charges" changes totals on
  any *currently* active promotion in a way staff should be warned about
  before this deploys — worth a quick check of whether any Daily Discount
  is live right now before/immediately after this ships.

## FOLLOW-UP NOTE

- Area: POS discount engine (all three sources: Daily Discount, customer
  blanket, customer product-specific)
- Dependency: live verification — set up all three discount types
  overlapping on one product for one customer, ring up a sale, confirm the
  on-screen total, the receipt, and `sales.discount_amount`/`vat_amount`/
  `sale_items.discount_amount` all agree with the documented precedence
- Confirmed now: code paths traced, syntax-verified, precedence logic
  reviewed against Ruan's confirmed rules
- Not yet confirmed: live behaviour; whether any currently-active Daily
  Discount will show a different (now correct) charged total than before —
  worth flagging to staff so a sudden "the total changed" isn't alarming
- Risk if wrong: the Daily Discount fix could change what a promotion
  actually charges starting the moment this deploys — low risk of it being
  *wrong* (it now matches the price already shown on screen), but real risk
  of it being *surprising* if nobody expects the charged total to change
- Recommended next review point: first live sale after deploy, especially
  if a Daily Discount is currently active on any product
