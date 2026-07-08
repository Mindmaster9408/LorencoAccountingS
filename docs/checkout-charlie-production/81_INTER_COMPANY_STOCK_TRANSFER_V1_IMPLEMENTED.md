# Workstream 81 — Inter-Company Stock Transfer v1
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests over a real local HTTP server, mocked API responses — see doc 82)
**Date:** 2026-07-08
**Scope:** Send / receive / reject / cancel / return / confirm-return between two Checkout Charlie companies with an active, permissioned relationship. No accounting integration, no invoices, no auto-receive.

> **Note on doc numbering:** the ticket requested `81_...IMPLEMENTED.md` / `82_...VERIFIED.md`, which collides numerically with the previous workstream's `80_...`/`81_...` docs (Suppliers/Customers Linking Foundation). Filenames are exactly as requested in the ticket; the duplicate `81` prefix is a harmless naming collision, not a versioning error — both files are uniquely named in full.

---

## Architecture

Reuses everything Workstream 80 built — no second relationship system, no second permission model:

- **Relationship & permission gate:** every transfer action re-checks `inter_company_relationships.status === 'active'` and the specific `permissions.{stock_transfer|receive_transfer|return_transfer}` flag for that action, via a shared `getAuthorizedRelationship()` helper. These flags previously had no way to be turned on — this workstream adds `PATCH /api/pos/company-links/:id/permissions` (in the existing `company-links.js` router) plus a small UI in the Workstream 80 supplier-edit "Company Link" panel to toggle them.
- **Company discovery:** `GET /api/pos/company-transfers/transferable-companies` is the *only* source for the "Send To" dropdown — it returns exclusively companies with an active relationship **and** `stock_transfer: true`. No broader company list is ever reachable from this module, matching the absolute "no global company list" rule.
- **Stock movement:** every stock-affecting action in this workstream uses a shared `adjustStockCAS()` helper — read current `stock_quantity`, then `UPDATE ... WHERE stock_quantity = <value just read>`. If a concurrent write changed the row in between, the `WHERE` clause matches zero rows and the update is detected as failed (`concurrent_update`) rather than silently overwriting a concurrent change. This is the "atomic stock decrement" the ticket asked for on the send path, applied consistently to every action that touches stock (send, receive, reject, cancel, return, confirm-return) rather than introducing a one-off pattern just for send.
- **No new relationship table.** `pos_company_transfers`/`pos_company_transfer_items` are a transfer *ledger* that references the existing `inter_company_relationships.id` — exactly as instructed.

---

## Schema

`accounting-ecosystem/backend/config/pos-schema.js` (additive, applies automatically on next server start):

**`pos_company_transfers`** — one row per transfer. `company_id` is always the **sending** company.
`id, company_id, receiver_company_id, relationship_id, transfer_number, status, reference, notes, expected_receive_date, item_count, total_quantity_sent, sent_by/sent_at, received_by/received_at, rejected_by/rejected_at/rejection_reason, cancelled_by/cancelled_at, return_requested_by/return_requested_at, return_received_by/return_received_at, created_at, updated_at`.

`status` enum (exactly as specified): `draft → sent → partially_received | received | rejected | cancelled`, and separately `sent/received/partially_received → return_sent → return_received`. **v1 simplification**, documented not hidden: a transfer is created directly in `sent` status (no separate draft-then-send UI step — the ticket's Flow 1 describes one user action, "select company/products/quantities" then send). `return_requested` and `return_sent` are collapsed into a single `return_sent` status set by one user action (the receiving company's return submission), since v1 has no intermediate "prepare a return, then ship it separately" step — **both** `COMPANY_TRANSFER_RETURN_REQUESTED` and `COMPANY_TRANSFER_RETURN_SENT` audit events still fire (both things genuinely happened in that one action), so the audit trail is complete even though the persisted status set is simpler than the ticket's full 9-state list.

**`pos_company_transfer_items`** — one row per product line.
`id, transfer_id, company_id (sender), product_id (sender's product), receiver_product_id (nullable until matched), product_code, barcode, description (product_name snapshot at send time — survives the sender later renaming/deleting the product), quantity_sent, quantity_received, quantity_returned, unit_cost, selling_price, match_status ('unmatched'|'auto_matched'|'manually_matched'), return_reason, notes, created_at`.

No separate returns table — return quantity/reason live on the same item row (`quantity_returned`, `return_reason`), consistent with the ticket's own "DATA MODEL GUIDANCE" section, which lists only these two tables.

---

## Routes (`accounting-ecosystem/backend/modules/pos/routes/company-transfers.js`, mounted at `/api/pos/company-transfers`)

All writes require `INVENTORY.ADJUST` (management-only); reads require `INVENTORY.VIEW`. Every route is `req.companyId`-scoped and re-validates the relationship + permission server-side — **frontend visibility is never trusted alone**, per the ticket's explicit security rule.

| Route | Purpose |
|---|---|
| `GET /transferable-companies` | Only active + `stock_transfer`-enabled companies — the dropdown's exclusive source |
| `POST /send` | Validates relationship+permission, pre-validates stock (all lines, same guarded pattern as Workstream 78's return route), creates header+items, decrements sender stock via CAS per line |
| `GET /outgoing` / `GET /incoming` | Transfers this company sent / is receiving, enriched with the counterparty's name only |
| `GET /:id` | Full detail; for the receiving side, attempts barcode→product_code auto-match against the receiver's own catalogue per unmapped item (suggestion only, never persisted until receive/map), and redacts `unit_cost`/`selling_price`/`reference` unless the relationship grants `pricing_visible`/`invoice_reference_visible` |
| `POST /:id/items/:itemId/map` | Manual product mapping fallback when auto-match fails |
| `POST /:id/receive` | Full or partial receive; **blocks** any line with no resolvable product mapping (per-request map, existing map, or live auto-match) rather than silently creating a product; increases receiver stock via CAS; header status becomes `received` only once every line is fully received, else `partially_received` |
| `POST /:id/reject` | Receiver-only, only before any receive — restores sender's stock (see "Judgment Calls" below) |
| `POST /:id/cancel` | Sender-only, only before any receive — restores sender's stock; explicitly skips any item with `quantity_received > 0` as a hard safety check |
| `POST /:id/return` | Receiver-only, only on received/partially-received items, decreases **receiver's own** stock immediately, sets `return_sent` |
| `POST /:id/confirm-return` | Sender-only, only on `return_sent` — the **only** place sender stock increases from a return |

---

## Product Matching

Exactly the priority order specified:
1. **Barcode match** against the receiver's own `products` table.
2. **Product code match** (if barcode didn't resolve).
3. *(Linked company product mapping — not built; no such mapping table exists yet. Documented as a gap, not silently skipped.)*
4. **Manual match fallback** — `receiver_product_id` supplied per-line in the receive request, or set ahead of time via `POST /:id/items/:itemId/map`.

If none of the above resolve for a line the receiver is trying to receive, the whole receive request is rejected with a clear `unmapped` list — **receiving is blocked, not defaulted to silently creating a new product.**

---

## Stock Movement Rules — Verified Against the Ticket's Exact Requirements

| Rule | Where enforced |
|---|---|
| Sender stock decreases only on send, not on create-without-send | `/send` is the only route that ever decreases sender stock at creation time (there is no separate "create draft" stock-affecting step) |
| Receiver stock does not increase until receiver confirms | `/receive` is the only route that increases receiver stock; nothing else does |
| Block transfer if insufficient stock unless policy/override allows | `/send` pre-validates every line against current stock (reusing `getStockPolicy()` — the same negative-stock policy sales already respect — or an explicit `override` flag), all-or-nothing |
| Receiver reduces own stock on return-send | `/return` decreases receiver stock immediately |
| Sender stock increases only after sender confirms return receipt | `/confirm-return` is the **only** route that increases sender stock for a return — `/return` never touches sender stock |
| Rejecting before any receive restores sender stock | `/reject` restores it, gated to `status === 'sent'` only (never after any partial receive) |

---

## Audit Events

All 10 requested events implemented (`COMPANY_TRANSFER_CREATED`, `_SENT`, `_RECEIVED`, `_PARTIALLY_RECEIVED`, `_REJECTED`, `_RETURN_REQUESTED`, `_RETURN_SENT`, `_RETURN_RECEIVED`, `_CANCELLED`, `_PRODUCT_MAPPED`), new `company_transfer` audit category. Each carries acting user (automatic via `posAuditFromReq`), transfer id/number, sender/receiver company id, item count, and — for stock-affecting events — before/after stock snapshots via the existing `STOCK_ADJUSTED` event (fired alongside the transfer-specific event for every line, consistent with every other stock-affecting flow in this codebase). No sensitive data (cost prices, banking, contact info) is ever logged.

---

## Judgment Calls (documented per CLAUDE.md's "mark anything needing future review")

- **Reject restores sender stock automatically.** Not explicitly specified either way by the ticket, but the alternative (sender's stock permanently vanishing on an outright reject, before the receiver ever touched anything) is clearly wrong. This is a direct, deterministic consequence of the receiver's own explicit reject action — not "automatic receiving," which the ticket forbids.
- **`return_requested`/`return_sent` collapsed to one persisted status**, both audit events still fired. Documented above.
- **Transfer created directly as `sent`**, no separate draft-save step. The ticket's Flow 1 doesn't describe a distinct "save draft, then send later" UI action; `status = 'draft'` remains a supported value in the schema for a future workstream if that's wanted.

## What Was Deliberately Not Built (v1 limitations, per the ticket's own "acceptable for v1" list)

- No accounting entries, no invoice creation, no VAT treatment — this workstream is stock movement + audit trail only.
- No purchase order workflow.
- "Linked company product mapping" (a persistent cross-company SKU-to-SKU table) does not exist — matching falls through to manual mapping when barcode/product_code don't resolve. A future workstream could persist successful manual matches so the same pair of companies doesn't have to re-map the same product every time.
- Partial receive is supported (per-line, not all-or-nothing), but a transfer can only be returned **once** in v1 — the return route doesn't prevent a second return submission being rejected outright, but there's no dedicated "multiple separate return batches over time" UI; a second return on the same transfer would work at the API level (it re-validates `quantity_received - quantity_returned` per line) but the UI's Returns tab is built around one return action per transfer being the common case.

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/backend/config/pos-schema.js` | +`pos_company_transfers`, +`pos_company_transfer_items` |
| `accounting-ecosystem/backend/modules/pos/routes/company-transfers.js` | new file — all 10 transfer routes |
| `accounting-ecosystem/backend/modules/pos/routes/company-links.js` | +`PATCH /:id/permissions` |
| `accounting-ecosystem/backend/modules/pos/index.js` | mounts `company-transfers` router |
| `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js` | +10 transfer events |
| `accounting-ecosystem/frontend-pos/index.html` | Send Stock modal, Company Transfers modal (Incoming/Outgoing/Returns tabs + detail/action panel), permission toggle UI in the Workstream 80 supplier-link section, real dashboard transfer KPIs |

---

## Related Documentation

- `docs/checkout-charlie-future/INTER_COMPANY_CUSTOMER_SUPPLIER_LINKING.md` (Workstream 80) — the Turkstra↔Pennygrow architecture this workstream implements the receive/send half of.
- `docs/checkout-charlie-production/82_INTER_COMPANY_STOCK_TRANSFER_V1_VERIFIED.md` — verification results.
