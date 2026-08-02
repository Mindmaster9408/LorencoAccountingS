# SESSION HANDOFF — 2026-08-02 — POS: Loyalty full rebuild

## What was requested

"okay dan kom ons bou die loyalty page an alles onder dit" — build out the
Loyalty page and everything under it. Investigation found **three**
disconnected, broken implementations, none working end-to-end:

1. The Loyalty tab itself (Programs/Members/Promotions) — entirely
   decorative. Programs hit a hardcoded-empty stub, Members table was
   never populated, Promotions called `/api/promotions` which doesn't
   exist anywhere.
2. `backend/modules/pos/routes/loyalty.js` — a complete, correct,
   permission-gated, audited router (program config, earn, redeem,
   adjust, customer history) that the frontend never called at all.
3. A third, separate implementation in the Customer Detail modal, calling
   `backend/shared/routes/customers.js`'s three loyalty routes — the only
   one actually used by the UI, but broken: no permission gate, never
   recorded transactions, ignored the real program config (hardcoded "1
   point per R10" via `prompt()`), and had a response-shape bug so
   balance/tier always rendered 0/bronze even with real data.

No sale ever earned points; there was no way to redeem points at
checkout. Ruan confirmed via AskUserQuestion: full rebuild ("Alles — volle
heropbou").

## Design

`loyalty.js`'s correct-but-dead router became the single source of truth.
Its data model is **one program per company**, not a list — so config
moved to Settings (where every other company-wide config lives) instead
of staying a "Programs" tab. The Loyalty tab itself was repurposed as the
**operational** surface: member lookup, balance/history, manual
adjustment.

Earning and redeeming both happen **server-side inside `sales.js`**, not
via a separate frontend call after checkout — matches the existing
account-charge-posting pattern (fire after the atomic RPC succeeds,
non-blocking, logged loudly on failure, never rolls back a completed
sale). Redemption's rand-value discount must be known *before* the sale
is created (it affects the total), so it's two-phase: a pure
validate-and-compute pass runs before `create_sale_atomic` to size the
discount; the real point deduction runs after the sale succeeds, using
the real `sale_id`.

## What was built

| File | Change |
|---|---|
| `backend/modules/pos/services/loyaltyService.js` (new) | Extracted shared logic: `getTier()`, `previewRedemption()` (validate-only, no writes), `redeemPoints()`, `awardPoints()`. Single source of truth for point/tier math. |
| `backend/modules/pos/routes/loyalty.js` | `/earn` and `/redeem` now thin wrappers around the service — same request/response shape as before. `/program`, `/customers/:id`, `/adjust` unchanged (adjust now calls `loyaltyService.getTier()`). |
| `backend/modules/pos/routes/sales.js` | `normaliseSaleBody()` accepts `loyalty_redeem_points`. New "3d" block in `POST /` previews the redemption (rejects the whole sale before any write if invalid) and applies the rand value as a flat discount with the same proportional VAT-scaling as the manual discretionary discount. Post-success block (same region as account-charge-posting): unconditionally awards points on `total_amount` when a customer is set; if a redemption was validated, redeems it for real with the actual `sale_id`. Both non-blocking, logged loudly (`console.error`) on failure, never roll back the sale. `POST /orders` untouched — out of scope. |
| `backend/shared/routes/customers.js` | Removed the 3 now-fully-orphaned dead routes: `GET /:id/loyalty`, `POST /:id/loyalty/earn`, `POST /:id/loyalty/redeem`. Confirmed via grep no other caller exists anywhere in the codebase. `/:id/account` and everything else untouched. |
| `frontend-pos/index.html` | New `#loyaltySettingsSection` (Settings → Loyalty, management-tier gated via `manager-only`) — single form wired to the previously-dead `GET`/`PUT /pos/loyalty/program`. Loyalty tab rebuilt: removed Programs/Promotions sub-tabs and all their dead JS (`loadLoyaltyPrograms`, `showLoyaltyTab`, `loadPromotions`, `showNewProgramModal`, etc.); `#loyMembers` rebuilt as the only view — real customer search (reuses `/customers/search`), balance/tier/history detail panel via the previously-dead `GET /pos/loyalty/customers/:id`, management-tier-gated Manual Adjustment modal calling `POST /pos/loyalty/adjust`. Customer Detail modal's `loadCustomerLoyaltyHistory()` redirected to the real endpoint (fixed the response-shape bug: `data.customer.loyalty_points/.loyalty_tier`, `t.type`/`t.notes` not `t.transaction_type`/`t.reference`); `earnLoyaltyPoints()`/`redeemLoyaltyPoints()` redirected to `POST /pos/loyalty/adjust` with positive/negative points (manual-correction buttons on a customer record, not a purchase — a better fit than the purchase-shaped `/earn`/`/redeem`). New checkout-screen redeem control (points input + Apply, mirrors `manualDiscountSection`) shown once a customer is selected, with their live balance; feeds `loyaltyRedeemPoints` into `calcCartTotals()` as another proportional-VAT-scaled discount layer (same as manual discount) and into the checkout `POST` payload as `loyaltyRedeemPoints`. |

### Deliberate behavior changes (not regressions)

- `POST /pos/loyalty/earn` on an inactive program now returns 201 with
  `points_earned: 0` instead of a 400 — matches `awardPoints()`'s
  designed no-op-not-error posture (earning should never fail a sale).
  This endpoint has zero real callers today (grepped), so nothing
  observes the change.
- The Customer Detail modal's manual earn/redeem buttons now go through
  `POST /pos/loyalty/adjust`, which requires `PRODUCTS.EDIT`
  (management-tier). The old `customers.js` routes they used to call had
  **no permission gate at all** — this is a fix, not a regression: any
  logged-in cashier could previously fabricate loyalty points from a
  customer's record.

### Offline handling for redemption

Loyalty redemption needs a live, authoritative balance check, so it is
**never sent on the offline-sale path**. `calcCartTotals()` only applies
the redemption's rand-value discount while `isOnline` is true; the
`offline` network event listener drops any pending redemption
immediately so the on-screen total can never promise a discount the
eventual synced sale wouldn't actually apply.

## Confirmed working

- `node -c` on all 4 touched/new backend files — all pass.
- `npx eslint` (the scoped `no-undef`-as-error config) on all 4 — 0
  errors (4 pre-existing, unrelated warnings in `customers.js` untouched
  by this change).
- All 3 inline `<script>` blocks in `frontend-pos/index.html`
  syntax-checked via `new Function()` extraction — 0 errors.
- No duplicate element IDs introduced.
- Confirmed via grep: no remaining references anywhere to the removed
  functions/elements (`loadLoyaltyPrograms`, `showLoyaltyTab`,
  `loadPromotions`, `showNewProgramModal`, `showEnrollCustomerModal`,
  `showNewPromotionModal`, `#loyPrograms`, `#loyPromotions`,
  `loyaltyProgramsBody`, `promotionsTableBody`, `promoSearch`,
  `promoFilter`) and no remaining callers of the 3 removed
  `customers.js` routes.

## What was NOT tested

No live Supabase/browser access this session — nothing here has been
verified against a real database or a real browser session. Specifically
untested:

- A real checkout with a selected customer actually earning points, and
  the resulting `loyalty_transactions` row / `customers.loyalty_points`
  update.
- A real redemption end-to-end: preview sizing the discount correctly,
  the sale total reflecting it, and the post-success `redeemPoints()`
  call actually deducting the balance.
- The Settings → Loyalty form actually persisting via the upsert path in
  `PUT /program` (first real caller ever — was dead code until today).
- The rebuilt Loyalty tab's member search + detail panel + manual
  adjustment against real data.
- The Customer Detail modal's redirected loyalty history/earn/redeem
  buttons against real data.
- Tier threshold transitions (bronze/silver/gold/platinum) as a real
  balance crosses 500/2000/5000.

## Deployment status

**Committed locally, NOT pushed yet** — per CLAUDE.md Rule G1, the till
was last confirmed in active use this session ("Ja, wag totdat dit rustig
is"). Must be freshly re-confirmed as quiet before pushing this specific
change — that confirmation was for a different, already-completed piece
of work earlier in the session, not this one.

## FOLLOW-UP NOTE

- Area: Loyalty
- Dependency: real Supabase data (a company with `loyalty_programs.is_active = true` and at least one customer with points) to run any of the "What was NOT tested" items above.
- Not yet confirmed: full live round-trip (configure program → sale earns points → customer redeems on a later sale → balance/tier update correctly → Loyalty tab and Customer Detail modal both show consistent figures).
- Risk if not checked: a silent mismatch between the client-side redemption preview (`loadLoyaltyProgramConfigOnce()`/`applyLoyaltyRedemption()`) and the server's authoritative `previewRedemption()` would only surface as a checkout-time 400 — annoying but not a data-integrity risk, since the server is authoritative regardless.
- Recommended next check: once the till is quiet and this is pushed, configure a test company's loyalty program in Settings, run one real sale for a selected customer, and confirm the points/tier land correctly in both the Loyalty tab and the Customer Detail modal.
