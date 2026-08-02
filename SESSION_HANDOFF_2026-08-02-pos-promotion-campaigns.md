# SESSION HANDOFF — 2026-08-02 — POS: Promotions replaced with named campaigns

## What was requested

Earlier today, a code-redeemed, Settings-hosted Promotions feature was built
and shipped (confirmed at the time: code required). After seeing it, Ruan
clarified this isn't what he wants:

1. No promo-code box on the till at all — speed matters, a running
   promotion should apply itself automatically, same as Daily Discount.
2. His real model is a **named campaign** (e.g. "Black Friday", with a date
   window) grouping one or more per-product price markdowns, plus a
   **consolidated performance report** (units sold, revenue, cost, profit)
   he can hand a manager: "here's what this promotion delivered for you."
3. It must live under **Loyalty → Promotions** (Programs/Members/Promotions
   sub-tabs), not Settings.

Both confirmed explicitly via AskUserQuestion. This is a replacement, not a
tweak — today's earlier Promotions work is fully removed.

## What was built

**Key design insight**: a campaign's per-product markdown is exactly what
`pos_daily_discounts` (Daily Discount) already is — per-product,
`percent`/`fixed`, date-windowed, automatic, no code — already correctly
priced by `sales.js`'s `resolveEffectivePrices()`, and already has a working
performance calculation in `discounts.js`. So a "Promotion Campaign" is a
**grouping + reporting layer on top of Daily Discount rows**, not a new
pricing mechanic. Checkout/pricing needed **zero changes**.

| File | Change |
|---|---|
| `backend/config/pos-schema.js` | Removed today's `pos_promotions`/`pos_promotion_redemptions` tables. New `pos_promotion_campaigns` (name, start_date, end_date, is_active — no pricing fields). `ALTER TABLE pos_daily_discounts ADD COLUMN IF NOT EXISTS campaign_id` (nullable FK) — a Daily Discount created directly via Settings is untagged as before; one added via a campaign tags itself here. |
| `backend/modules/pos/routes/promotionCampaigns.js` (new, replaces deleted `routes/promotions.js`) | `GET/POST/PUT/DELETE /promotion-campaigns` (CRUD, soft-delete), `GET /:id` (campaign + its items), `POST/DELETE /:id/items[/:discountId]` (add/remove a product markdown — each creates/deactivates a real `pos_daily_discounts` row with `valid_from`/`valid_until` mirroring the campaign's own dates), `GET /:id/performance` (adapts `discounts.js`'s exact per-discount units/revenue/cost/profit calculation, scoped to the campaign, summed into a total). |
| `backend/modules/pos/services/promotionService.js` | Deleted (no longer needed — no separate pricing mechanic). |
| `backend/modules/pos/index.js` | Mount changed from `/promotions` → `promotionsRoutes` to `/promotion-campaigns` → `promotionCampaignsRoutes`. |
| `backend/modules/pos/routes/sales.js` | Removed the "3d. Cart-level promotion code" block, the `promotion_code` field in `normaliseSaleBody()`, and the post-success `redeemPromotion()` call — back to its exact pre-Promotions shape. |
| `backend/server.js` | Updated a stale comment referencing the deleted `routes/promotions.js`. |
| `frontend-pos/index.html` | **Till screen**: `#promoCodeSection` and all its JS (`applyPromoCode()`, `clearPromoCode()`, the `calcCartTotals()` promo layer, the `promotionCode` checkout field) removed entirely. **Settings**: "Promotions" sidebar item, `#promotionsSection`, and all its CRUD JS removed. **Loyalty tab**: gained a third sub-tab, **Promotions**, alongside the existing (untouched, still-decorative) Programs/Members — campaign list (name, date window, product count, status), "+ New Campaign" modal, and a "Manage" modal (product search + add/remove markdowns, mirroring the Daily Discount product picker's debounce/barcode-scan pattern under new element IDs) with an inline "View Performance Report" panel (summary cards + per-product breakdown). |

### Confirmed working

- `node -c` + scoped ESLint on all touched/new backend files (`promotionCampaigns.js`, `index.js`, `sales.js`, `pos-schema.js`, `server.js`) — 0 errors.
- All 3 inline `<script>` blocks in `frontend-pos/index.html` syntax-checked via `new Function()` extraction — 0 errors.
- No duplicate static element IDs.
- Grep-confirmed zero remaining references to `promoCodeSection`, `applyPromoCode`, `promotionService`, or the deleted `routes/promotions.js` anywhere in the codebase.

### What was NOT tested

No live Supabase/browser access this session. Specifically untested:

- Creating a campaign and adding a product markdown — confirming the created `pos_daily_discounts` row actually applies at checkout (should, since it's the same mechanism Daily Discount already uses, unmodified — but never run against a real database).
- The performance report's numbers against real sales data.
- The product-search picker in the "Manage Campaign" modal on a real browser (barcode-scan fast path, debounced text search).
- Multiple campaigns' items don't collide (e.g. two campaigns both discounting the same product) — `resolveEffectivePrices()` already takes the lowest of all candidate prices regardless of source, so this should be safe by construction, but untested live.

## Deployment status

**Committed locally, NOT pushed yet** — per CLAUDE.md Rule G1, must be
freshly confirmed as quiet before pushing. Note: today's earlier Promotions
commit (code-based) was already pushed and deployed earlier — this change
supersedes it; once pushed, the promo-code box will disappear from the till
and Settings → Promotions will disappear, replaced by Loyalty → Promotions.

## FOLLOW-UP NOTE

- Area: Promotion Campaigns
- Dependency: real Supabase data (a company with a campaign + at least one tagged product) to verify the full round-trip.
- Not yet confirmed: create campaign → add product → real sale at that product's till-screen price reflects the markdown → performance report shows correct units/revenue/cost/profit.
- Risk if not checked: low for pricing correctness (checkout pricing logic itself is completely unchanged — a campaign item is just a normal Daily Discount row). Risk is mostly UI-only (the new Manage modal's product picker, on real browser/touch hardware).
- Recommended next check: once pushed, on the sandbox company (Infinite Legacy — TEST, per CLAUDE.md Part H), create a "Test Promo" campaign, add one product, confirm it prices correctly at checkout with zero code/prompt involved, then pull its performance report after a test sale.
