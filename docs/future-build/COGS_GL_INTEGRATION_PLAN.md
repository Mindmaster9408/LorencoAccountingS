# COGS → GL Integration — Design Plan

Status: **Not started. Planning only.** Written 2026-08-29 after the inter-app "double work"
audit confirmed POS sales post revenue to Leo's GL with no matching cost side at all. Priority
#1, per Ruan, because it's a correctness defect (overstated gross profit/net income for every
POS-sourced sale in every client's books), not just a convenience gap.

## The Confirmed Problem

`accounting-ecosystem/backend/modules/accounting/routes/pos-bridge.js`'s daily till-invoice
generator (`gl-sync/generate-invoice`) builds a `customer_invoice` from `sale_items` grouped by
VAT rate and posts it to a single revenue account. There is no cost-of-goods-sold line anywhere
in that flow, nor in the per-sale account-invoice path (`createDraftAccountInvoice()` in
`backend/modules/pos/routes/sales.js`, shipped 2026-08-29). Stockton (`costingService.js`)
computes a weighted-average cost per item, but that figure never reaches Leo.

`database/migrations/051_inventory_costing_finalization.sql` already added
`inventory_items.cogs_account_id` with the comment *"FUTURE USE: GL account for COGS / material
issue postings. Null = use company default."* — this column has been sitting there unused. That
is almost certainly the intended landing spot for this work, not something to redesign from
scratch.

## Why This Touches Three Apps, Not One

- **Charlie (POS)** — the event that triggers a COGS obligation (a sale happens, an item is
  returned). Two separate posting paths already exist here and must BOTH get a COGS side,
  without ever double-posting for the same sale:
  1. The **daily aggregate** (cash/card sales, `pos-bridge.js`) — one journal per day.
  2. The **per-sale account invoice** (`createDraftAccountInvoice`) — one draft invoice per
     account-tender sale, created the moment the sale completes.
- **Stockton (Inventory)** — the only place that knows the unit cost of what was actually sold
  (`costingService.js`, weighted average). Leo cannot compute COGS without asking Stockton (or
  reading data Stockton already wrote) for a cost basis.
- **Leo (Accounting)** — where the COGS journal/invoice line actually lands, using (probably)
  `inventory_items.cogs_account_id` per item, falling back to a company-default COGS account
  when null.

## Hard Requirement: No Double-Entry, By Construction

Ruan flagged this as the thing to get right, not an afterthought. Principles for whoever builds
this:

1. **COGS must be created in the SAME function call that creates the revenue line, never a
   separate pass.** For the per-sale account invoice, that means inside
   `createDraftAccountInvoice()` itself — not a second job that queries "sales without COGS yet"
   and could double-run. For the daily aggregate, inside the same idempotency-guarded
   `generate-invoice` route that already refuses a second invoice for the same date
   (`ALREADY_GENERATED` check) — extend that one guard to cover COGS too, don't add a second one.
2. **The two posting paths must stay mutually exclusive on the same filter.** Revenue already
   splits on `payment_method != 'account'` (daily aggregate) vs `= 'account'` (per-sale). COGS
   must use the identical filter — if it doesn't, a sale could get COGS'd twice (once via each
   path) while only being revenue-recognised once, silently understating profit instead of
   overstating it.
3. **Returns/voids must reverse COGS symmetrically**, not just revenue. `restore_stock_for_return`
   already puts the stock back in Stockton — the matching GL side (credit COGS, debit inventory
   asset back) needs to happen through the same reversal mechanism Leo already uses elsewhere
   (`JournalService.reverseJournal()` / credit-note pattern), not a new one-off.
4. **Tag the source.** Every other cross-module posting in this codebase marks its origin
   (`journals.source_type`, `customer_invoices.source` seen in the company-link work). COGS
   journal lines/invoice lines should carry the same convention so a bookkeeper debugging a
   figure later can see immediately which mechanism posted it.

## Open Questions — Verify In Code Before Building, Don't Guess

- **Does anything capture the unit cost AT THE MOMENT OF SALE**, or does Stockton only expose a
  live/current weighted-average that drifts as later purchases come in? If costs move during a
  trading day, a daily-aggregate COGS journal computed at day-end using "current" average cost
  vs. one computed per-sale at the moment of sale will disagree slightly. Need to know which is
  actually available before deciding whether that's a real problem or immaterial.
- **Serial-tracked items** (see the POS Serial Number Tracking feature) likely have a known
  per-unit cost tied to a specific serial, not a pooled weighted average — does the COGS logic
  need a separate code path for these, or does Stockton already normalize both into one cost
  figure by the time POS reads it?
- **Where exactly does `inventory_items.cogs_account_id` get read today** — anywhere at all, or
  truly nowhere (matches the audit finding)? Confirm before assuming it's a clean drop-in target.
- **Multi-location/multi-warehouse costing** — does Stockton support more than one stock
  location per company, and if so, does that change which cost applies to a given sale?
- Interaction with the **not-yet-built Phase B** (customer/supplier account sync, till
  Pay-on-Account, `docs/charlie-leo-customer-account-integration.md`) — that work is unrelated in
  scope but touches the same account-invoice creation point; sequence/coordinate so they don't
  collide.

## Not Decided Yet

- Whether COGS posts to a **draft** invoice line (`account_id` left for a human to confirm, same
  pattern as revenue lines today) or is auto-posted straight through using
  `cogs_account_id`/company default without review. Leaning toward: same draft-then-review
  posture as everything else this session has built (VAT drafts, OCR drafts, company-link
  drafts) — a human should see and confirm the first few before this runs unattended — but not
  finalized.
- Whether the daily aggregate needs one COGS line per VAT-rate-group (mirroring revenue) or one
  lump sum per day — COGS itself has no VAT component, so probably just one lump sum, but not
  confirmed against how the existing revenue grouping code is structured.

## Related

- `accounting-ecosystem/docs/charlie-leo-customer-account-integration.md` — original POS↔Leo
  integration gap audit (customer accounts side)
- `database/migrations/051_inventory_costing_finalization.sql` — the unused `cogs_account_id` hook
- `accounting-ecosystem/backend/modules/inventory/services/costingService.js` — weighted-average
  costing logic (FIFO noted as an incomplete stub — average used as proxy)
