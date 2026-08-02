# SESSION HANDOFF — 2026-08-02 — POS: Promotions (code-based cart discounts)

## What was requested

"okay ek dink jy kan daar die promotion gedeelte bou ek dink jy verstaan
hoe promotions werk en hoe dit uit eenstelling moet werk" — build the
Promotions feature, delegated to my judgment on how it should work.

Investigation found Promotions has never actually existed:

- `frontend-pos/index.html` had a decorative "Promotions" sub-tab under
  Loyalty (Name/Code/Type/Discount/Start/End/Usage/Status table), calling
  a hardcoded stub in `server.js`: `app.get('/api/promotions', ...) =>
  res.json({ promotions: [] })` — no table, no logic, ever.
- Two real, distinct discount mechanisms already existed and had to be
  kept separate: **Daily Discount** (`pos_daily_discounts`, per-product,
  automatic, no code) and **customer product discounts**
  (`customer_product_discounts`, per-customer-per-product, automatic) —
  both per-line pricing candidates in `sales.js`'s `resolveEffectivePrices()`.

Design decision confirmed with Ruan (AskUserQuestion): promotions are
**code-required** — a cashier enters a promo code at checkout, rather than
applying automatically. This makes Promotions a cart-level, code-redeemed
discount, the same architectural tier as the existing manual discretionary
discount (a final whole-sale reduction), not another per-line pricing
candidate — avoiding any overlap or ambiguity with Daily Discount.

## What was built

| File | Change |
|---|---|
| `backend/config/pos-schema.js` | Two new tables: `pos_promotions` (one row per code, company-scoped, `UNIQUE(company_id, code)`, `discount_type` percent/fixed, optional `min_purchase_amount`/`start_date`/`end_date`/`usage_limit`, denormalised `current_usage_count`, `is_active` toggle) and `pos_promotion_redemptions` (audit trail — one row per sale that redeemed a code, mirrors the `loyalty_points`+`loyalty_transactions` dual pattern). |
| `backend/modules/pos/services/promotionService.js` (new) | `previewPromotion({ companyId, code, cartSubtotal })` — validate-only, no writes: checks active/date-window/usage-limit/min-purchase, returns the computed discount amount or a specific error. `redeemPromotion({ companyId, promotionId, saleId, customerId, discountAmount })` — the real write: increments `current_usage_count` (re-checking the limit at write time), inserts a redemption row. |
| `backend/modules/pos/routes/promotions.js` (new) | `GET /` (list, `PRODUCTS.VIEW`), `POST /` (create, `PRODUCTS.EDIT`, validates type/value/duplicate-code), `PUT /:id` (update), `DELETE /:id` (soft deactivate — preserves the redemption audit trail), `GET /validate?code=&subtotal=` (`SALES.CREATE` — checkout-screen live preview, thin wrapper around `previewPromotion()`). Mounted at `/api/pos/promotions` in `modules/pos/index.js`. |
| `backend/modules/pos/routes/sales.js` | `normaliseSaleBody()` accepts `promotion_code`. New "3d" block in `POST /` (after the manual discretionary discount, before the final `discount` calc) previews the code and rejects the whole sale (400) before any write if invalid; if valid, applies the discount as a flat reduction with the same proportional VAT-scaling as the manual discount. Post-success block (same region as account-charge-posting): redeems the code for real with the actual `sale_id` — non-blocking, logged loudly (`console.error`) on failure, never rolls back the completed sale. `POST /orders` untouched — out of scope (deposit/balance-owing model doesn't fit a cart-discount code). |
| `backend/server.js` | Removed the dead `/api/promotions` stub (line 284) — confirmed via grep no other caller anywhere before removing. |
| `frontend-pos/index.html` | New Settings → Promotions section (`manager-only` gated sidebar item next to Brands), full CRUD table + Add/Edit modal (Name, Code auto-uppercased, Type, Value, optional Min Purchase/Start/End/Usage Limit, Active toggle on edit), client-computed status badge (Active/Scheduled/Expired/Limit Reached/Inactive). Removed the decorative Loyalty-tab Promotions sub-tab entirely (button, `#loyPromotions` div, `loadPromotions()`, the dead `showNewPromotionModal()` stub that had silently shadowed the new real one — same-name function declared twice, later one wins, so this was a real latent bug fixed in passing) — Loyalty Programs/Members sub-tabs left untouched per Ruan's earlier instruction to specify Loyalty separately. New checkout-screen `#promoCodeSection` (mirrors `manualDiscountSection`'s Apply/Clear pattern) — validates via `GET /pos/promotions/validate` for a live preview, feeds into `calcCartTotals()` as another proportional-VAT-scaled layer, sent as `promotionCode` in the **online-only** checkout payload (never on the offline path — a code needs a live usage-limit check; dropped automatically by the `offline` network event listener, same pattern already used for this class of discount). |

### Design notes

- **Code required, not automatic** — confirmed with Ruan via AskUserQuestion before building, specifically to avoid ambiguity with Daily Discount's existing automatic per-product model.
- **Two-phase validate/redeem**, same pattern proven out earlier this session for the (since-reverted) Loyalty redemption work: a pure preview before the sale is created sizes the discount; the real write (usage-limit increment + audit row) happens after `create_sale_atomic` succeeds, using the real `sale_id`, non-blocking and logged loudly on failure.
- **Soft delete** — deactivating a promotion (`is_active: false`) preserves its `pos_promotion_redemptions` rows for audit/reporting; management list already surfaces `current_usage_count`/`usage_limit` per promotion, so no separate reporting surface was built (kept in scope per the plan).
- **Found and fixed in passing**: the pre-existing dead `function showNewPromotionModal() { showNotification('Promotion creation coming soon', 'info'); }` stub was declared *after* my new real implementation in source order — JS function-declaration semantics mean the later one wins, so the dead stub would have silently shadowed the real modal-opener had it not been removed as part of deleting the decorative Loyalty-tab block.

## Confirmed working

- `node -c` on all 6 touched/new backend files — all pass.
- `npx eslint` (scoped `no-undef`-as-error config) on all 6 — 0 errors, 0 warnings.
- All 3 inline `<script>` blocks in `frontend-pos/index.html` syntax-checked via `new Function()` extraction — 0 errors.
- No duplicate static element IDs introduced (only dynamic template-literal placeholders like `${p.id}` flagged, which are expected/harmless).
- Grep-confirmed no remaining caller of `/api/promotions` anywhere in the codebase (only comments referencing the old stub for context).

## What was NOT tested

No live Supabase/browser access this session — nothing here has been
verified against a real database or a real browser session. Specifically
untested:

- Creating a promotion via Settings and confirming it actually persists (`UNIQUE(company_id, code)` constraint, `POST /pos/promotions` upsert path).
- A real checkout with a valid code: correct discount sizing, correct VAT scaling, and the resulting `pos_promotion_redemptions` row / `current_usage_count` increment.
- Rejection paths at real checkout: unknown code, not-yet-started, expired, usage-limit-reached, minimum-purchase-not-met — each should 400 before any write.
- The Settings list's computed status badges against real dates/usage data.
- The checkout screen's promo-code Apply/Clear control against a real backend response.

## Deployment status

**Committed locally, NOT pushed yet** — per CLAUDE.md Rule G1, must be
freshly confirmed as quiet before pushing.

## FOLLOW-UP NOTE

- Area: Promotions
- Dependency: real Supabase data (a company with at least one promotion configured) to run any of the "What was NOT tested" items above.
- Not yet confirmed: full live round-trip (create promotion in Settings → apply code at checkout → sale total reflects discount correctly → usage count increments → code correctly rejected once limit/expiry is reached).
- Risk if not checked: a mismatch between the client-side preview (`GET /validate`) and the server's authoritative re-check in `sales.js` would only surface as a checkout-time 400 — annoying but not a data-integrity risk, since the server is authoritative regardless (same posture as every other discount this session).
- Recommended next check: once the till is quiet and this is pushed, create a test promotion in the sandbox company (Infinite Legacy — TEST, per CLAUDE.md Part H), run one real sale with the code applied, and confirm the discount, VAT, and usage count all land correctly.
