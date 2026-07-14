# Workstream 99 — Account Sale → Buyer Purchase Order Sync — Implemented + Live Verified

## Background

Grew out of a design conversation about how Purchase Orders and Sales Orders relate: they are the same document, viewed from two sides (already built — see Workstream 87's "Orders to Fulfill" tab). The follow-on question was the reverse direction: when a company makes a regular ACCOUNT sale (through the POS checkout, not the formal PO screen) to a customer that is itself a linked platform company, should that sale become visible on the buyer's side as a Purchase Order — automatically, without either side doing any extra paperwork?

Confirmed scope before building:
- Trigger: ACCOUNT-tender sales only, to a customer record specifically linked to another company.
- If the buyer already has an open PO against this seller: attach the sale as a delivery against it (reduce outstanding quantity), not a separate record.
- If not: auto-create a new PO, immediately marked accepted + fully delivered — the goods already physically left the store via the POS sale, so there is nothing left to approve.
- Auto-generate the inter-company invoice on completion, exactly like a normal manually-completed PO does.

## Architecture

**A new, self-contained module** (`modules/pos/services/accountSaleToPOSync.js`) rather than modifying the existing Purchase Order engine (`purchase-orders.js`, Workstreams 87-89, already live-verified and proven). The engine's own routes are untouched; the new module only imports its `generatePoInvoice()` helper (newly exported, additive — zero change to the router itself) and re-derives the small subset of item-matching / stock / status-rollup logic it needs, adapted for the one real difference: **stock has already moved**. The seller's stock was already decremented by the POS sale itself — this sync only ever increments the **buyer's** stock, matching cross-company products by barcode then product_code (the identical heuristic the manual delivery-dispatch code already uses).

**New prerequisite: customers can now be linked to a company, not just suppliers.** `suppliers.js` already had `/link-company` (Workstream 80); `customers.js` had nothing. Added `POST /api/pos/customers/:id/link-company`, mirroring the supplier version, with one improvement: it gracefully **reuses** an existing relationship between the two companies (e.g. one already established via a Supplier record) instead of erroring — the underlying relationship is a single, symmetric row per company pair, and a customer and a supplier record can legitimately point at the same one.

**Call sites** — three places already post an account charge; all three now also call the sync, awaited (best-effort — a sync failure is logged loudly but never rolls back or fails the already-completed sale, the same convention as `postAccountCharge`/`reverseAccountCharge` elsewhere in this file):
- `POST /` (regular sale) — synced immediately, since a regular sale is an instant pickup.
- `POST /:id/fulfill` (Workstream 96's Order pickup) — synced at **fulfillment**, not at order-creation/deposit time. An Order's deposit only reserves stock; the goods only actually change hands at pickup, so that is the correct moment for the buyer's PO/stock to reflect it. Triggers if *either* the deposit or the final settlement used account tender.
- `POST /orders` (Order creation) — **deliberately not wired here**, for the same reason.

## Critical Bug Found Along the Way

Building this surfaced a real, separate, pre-existing defect in `company-links.js` (Workstream 80) that this new feature depends on directly. `syncLinkedRecords()` — which is supposed to keep a supplier/customer record's denormalised `link_status` column in sync with the relationship's real status after confirm/revoke — scoped its update to `company_id = <whichever company called confirm/revoke>`. The **initiating** company's own supplier/customer record (which auto-confirms itself the moment the request is created) never got touched by the *other* company's confirm action, and so stayed on `link_status: 'pending'` **forever**, even though the relationship itself was genuinely `active` on both sides.

Confirmed live: after Company 2 requested a link and Company 1 confirmed it, the relationship was `active` — but Company 2's own supplier record still read `link_status: 'pending'`. This is not just cosmetic: this session's own Company Link UI, the Supplier/Customer edit screens' badges, and now this new sync feature's `buyerSupplier` lookup (which correctly, defensively checks `link_status = 'active'` before trusting a link) would all have silently misbehaved for the initiating side of every relationship ever created — the new PO-sync feature's "auto-create" path in particular would never have fired at all.

**Fixed at the root**: `relationship_id` is unique across the whole table regardless of which company's record it lives on, so `syncLinkedRecords(relationshipId, status)` now updates every supplier/customer row pointing at it — both sides — in one pass each, with no `company_id` filter at all. Confirmed live: after the fix, both companies' local records read `link_status: 'active'` immediately after confirmation.

## Live Verification

Two real companies (The Infinite Legacy, Pennygrow) with a dedicated dual-access test user, matching test products sharing a barcode across both companies' catalogs. 22 assertions, all passed:

| Check | Result |
|---|---|
| Relationship request created, confirmed, `purchase_orders` permission enabled | PASS |
| **Bug fix**: initiating company's own supplier record also flips to `active` (not stuck on `pending`) | PASS |
| Customer-side link reuses the existing relationship rather than erroring | PASS |
| **Scenario A** (no existing open PO): account sale auto-creates a new PO, immediately `completed`, buyer stock +5, invoice auto-generated | PASS |
| **Scenario B** (existing open 50-unit PO): a 10-unit account sale attaches as a delivery against the *existing* PO (not a new one), `partially_fulfilled`, buyer stock +10 | PASS |
| **Scenario C**: a further 40-unit sale completes the same PO (50/50), invoice auto-generated on completion | PASS |
| Unmatched product (no barcode/code match in buyer's catalog): sale still succeeds normally, sync silently skips that item | PASS |
| Account sale to a non-linked customer: sale succeeds normally, sync no-ops with no error | PASS |

## Security / Correctness Notes

- Every write remains scoped by the correct `company_id` on each side — the sync explicitly writes to the buyer's tables using `buyerCompanyId`, never the seller's `req.companyId`, for anything buyer-owned.
- The relationship must be `active` **and** have the `purchase_orders` permission flag enabled — the same authorization bar as manually raising a PO. A relationship without that flag causes the sync to skip silently (the sale itself is unaffected either way).
- Never allowed to fail or roll back a sale: every failure path returns `{ synced: false, reason }` or is caught and logged, never thrown back to the checkout response.
- Audit events (`PO_CREATED` / `PO_PARTIAL_DELIVERY` / `PO_FINAL_DELIVERY`) are logged against the **buyer's** company via a synthetic audit context, attributed to the real seller-side user who triggered the sale (there is no real buyer-side user in this automated flow) — traceable, not attributed to an anonymous "system" actor.

## Cleanup

Synthetic cross-company records (test POs, deliveries, invoices, relationship) fully deleted — these are fabricated test artifacts, not real business activity, and would otherwise pollute the real companies' PO/invoice history. Test customers/products/supplier/user deactivated (hard delete blocked by FK from the real sales rows now referencing them). The one deviation from the usual pattern: the test till session had to be closed by direct database update rather than the API, because the test user was deactivated (correctly blocking further API calls) before the session-close step ran in the cleanup script — a cleanup-script ordering issue, not an application defect.
