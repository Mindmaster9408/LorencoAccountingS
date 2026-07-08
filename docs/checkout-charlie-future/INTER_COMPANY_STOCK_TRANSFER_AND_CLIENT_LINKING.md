# Checkout Charlie — Inter-Company Stock Transfer & Client Linking

**Status:** DESIGN ONLY — do not implement until explicitly instructed
**Date:** 2026-07-07
**Scope:** Future `accounting-ecosystem/backend/modules/pos/routes/transfers.js` (new) + extends the existing `accounting-ecosystem/backend/inter-company/` module. No code in this doc has been built.

---

## 1. Worked Example

Turkstra Hardware and Pennygrow Building Supplies are two separate companies on this platform, both running Checkout Charlie. They trade stock with each other regularly (Turkstra often has surplus of an item Pennygrow is short on, and vice versa).

1. Turkstra and Pennygrow **link** their accounts (mutual opt-in, see §2).
2. Turkstra sends 20 units of "Cement 50kg" to Pennygrow — a **transfer** is created, stock at Turkstra reduces immediately, Pennygrow sees it as **pending incoming**.
3. Pennygrow's stock does **not** increase yet — only once Pennygrow explicitly **receives/books it in** does their stock increase.
4. Turkstra's dashboard shows the transfer as "in transit" until Pennygrow confirms receipt, then "completed."
5. A week later, Pennygrow only used 15 of the 20 units and **returns** 5 back to Turkstra — a return transfer, same flow in reverse, fully audited.
6. If Pennygrow reports only 18 arrived (not 20), that's a **transfer exception** — flagged, not auto-resolved (see §7).

---

## 2. Client/Company Linking — Reuse, Don't Duplicate

**Do not build a new `linked_company_relationships` table.** A working, real, already-deployed table already exists for exactly this purpose:

`accounting-ecosystem/backend/inter-company/` (network.js, routes.js) writes to Supabase table **`inter_company_relationships`** via `sean/supabase-store.js`:

```
inter_company_relationships
├── id
├── company_a_id            -- e.g. Turkstra
├── company_b_id            -- e.g. Pennygrow
├── initiated_by            -- which company sent the request
├── status                  -- 'pending' | 'active' | 'suspended' | 'terminated'
├── company_a_confirmed     -- bool, mutual opt-in required
├── company_b_confirmed     -- bool
├── permissions             -- JSON: { send_invoices: true, receive_invoices: true, auto_match_payments: false }
└── created_at
```

This was built for Accounting's inter-company **invoice** exchange (`POST /api/inter-company/enable`, `/find`, `/relationships`, `/relationships/:id/confirm`). It is a company-discovery + mutual-confirmation + permission-flag system — precisely the "client code linking" concept described in the ticket, already live.

### Recommended extension (not built yet)

Add new keys to the existing `permissions` JSON rather than a new table:

```json
{
  "send_invoices": true,
  "receive_invoices": true,
  "auto_match_payments": false,
  "send_stock_transfers": false,
  "receive_stock_transfers": false
}
```

Both companies would need to separately enable `send_stock_transfers` / `receive_stock_transfers` on their side of an already-`active` relationship — a stock-transfer-specific opt-in layered on top of the existing invoice opt-in, not automatically inherited from it. A company that trusts a partner for invoices does not automatically trust them to move physical stock.

**Why reuse this table instead of a POS-specific one:** the relationship (who trusts whom, and for what) is a company-to-company fact that both Accounting and POS need to agree on. Two separate, un-synced "is Turkstra linked to Pennygrow" tables would drift and create exactly the kind of security/consistency risk the ticket's rules warn against. One relationship table, with per-feature permission flags, is the correct shape.

**Important scoping note:** the existing module lives at `accounting-ecosystem/backend/inter-company/`, uses a different data-access layer (`supabaseSeanStore`, not the plain `supabase` client `modules/pos/routes/*.js` use), and is currently wired for Accounting only. Extending it for POS stock transfers means either (a) POS routes call into `inter-company/network.js`'s existing methods directly, or (b) a thin POS-specific wrapper reads the same `inter_company_relationships` table via the standard `supabase` client. Option (b) is lower-risk (no cross-module runtime dependency) and is the recommended approach — read the same table, don't import Accounting's module into POS.

---

## 3. New Data Model Needed (Stock-Transfer-Specific)

None of this exists yet. All new, all POS-scoped, following this codebase's established conventions (`IDENTITY PRIMARY KEY`, plain-integer soft references — no FK constraints, per this repo's convention — `company_id` on every row, append-only event table for audit).

```
pos_transfer_headers
├── id
├── sending_company_id        -- Turkstra
├── receiving_company_id      -- Pennygrow
├── relationship_id           -- FK-by-convention to inter_company_relationships.id
├── transfer_number           -- human-readable, e.g. XFR-2026-0001
├── direction                 -- 'outgoing' | 'return'  (a return is its own header, referencing the original)
├── original_transfer_id      -- null unless direction = 'return'
├── status                    -- 'draft' | 'sent' | 'in_transit' | 'partially_received' | 'received' | 'exception' | 'cancelled'
├── initiated_by_user_id
├── initiated_at
├── received_by_user_id       -- null until receiving company books it in
├── received_at
├── notes
└── company_id                -- ALWAYS the sending company for the header row's own scoping

pos_transfer_items
├── id
├── transfer_id
├── product_id                -- sending company's product
├── matched_product_id        -- receiving company's product, once matched (product catalogs are NOT
│                                 assumed to share IDs across companies — see §6)
├── quantity_sent
├── quantity_received         -- filled in by the receiving company; may differ from quantity_sent
├── unit_cost_at_send         -- snapshot, for the sending company's own stock valuation
└── notes

pos_transfer_events            -- append-only, mirrors the existing pos_audit_events pattern exactly
├── id
├── transfer_id
├── company_id                -- whichever company generated this event
├── user_id
├── event_type                -- TRANSFER_CREATED | TRANSFER_SENT | TRANSFER_RECEIVED |
│                                 TRANSFER_PARTIALLY_RECEIVED | TRANSFER_EXCEPTION_RAISED |
│                                 TRANSFER_RETURN_CREATED | TRANSFER_CANCELLED
├── before_snapshot
├── after_snapshot
├── metadata
└── created_at
```

---

## 4. Send Stock Flow (Turkstra → Pennygrow)

1. Turkstra staff selects products + quantities to send to a linked, `send_stock_transfers`-enabled company.
2. Backend validates: relationship is `active` and both `_confirmed`; sending company has `send_stock_transfers: true`; receiving company has `receive_stock_transfers: true`; each product has sufficient stock (same stock-guard logic already used at checkout — reuse, do not reimplement).
3. `pos_transfer_headers` row created (`status: 'sent'`), `pos_transfer_items` rows created.
4. Turkstra's stock decrements **immediately** using the **existing** `decrement_stock_v2` mechanism (do not write a second stock-decrement code path — this is the same non-negotiable "one authoritative decrement function" principle already enforced for sales).
5. `pos_transfer_events` row: `TRANSFER_SENT`, audited on Turkstra's side.
6. Pennygrow sees it appear under "Incoming Transfers — Pending Acceptance" (their dashboard Transfer Readiness panel, once built).

## 5. Receive Stock Flow (Pennygrow books it in)

1. Pennygrow opens the pending transfer, reviews line items.
2. **Product matching required before receipt if the two companies' catalogs don't share product IDs** (they almost certainly won't — see §6). Pennygrow maps each incoming line to one of their own products (or creates a new one, via the existing product-create flow — no new product-creation logic needed).
3. Pennygrow confirms received quantities per line (may differ from sent — see §7 for exceptions).
4. On confirm: Pennygrow's stock **increases** using the existing supplier-receive-style stock-increment path (mirrors `POST /api/pos/inventory/receive`'s existing pattern — reuse that code shape rather than inventing a third way to add stock).
5. `pos_transfer_headers.status` → `'received'` (or `'partially_received'` if any line's `quantity_received < quantity_sent` without an explicit exception being raised).
6. `pos_transfer_events`: `TRANSFER_RECEIVED` on Pennygrow's side.
7. Turkstra's dashboard transfer status updates to reflect completion (their own read of the shared `pos_transfer_headers` row, scoped by `sending_company_id = their company`).

## 6. Return Stock Flow (Pennygrow → Turkstra)

A return is **its own transfer header** with `direction: 'return'` and `original_transfer_id` pointing back at the original — not a mutation of the original transfer. This preserves a clean, append-only audit trail: the original transfer's record never changes after the fact, and the return is independently auditable (who returned what, when, why).

1. Pennygrow initiates a return referencing the original transfer (pre-fills product/quantity from the original for convenience, but is still a fresh, independently-validated transfer).
2. Same send/receive mechanics as §4–5, direction reversed: Pennygrow's stock decrements now, Turkstra's stock increments once Turkstra books it in.
3. Turkstra's dashboard shows this as an incoming return, distinct from a fresh outgoing send.

## 7. Transfer Exceptions — Must NOT Be Auto-Resolved

If `quantity_received != quantity_sent` on any line, or a receiving company reports damage/shortage, the header status becomes `'exception'` and a `TRANSFER_EXCEPTION_RAISED` event is written with both quantities in `metadata`. **This must require a human decision on both sides** — the system must never silently:
- adjust the sending company's stock to match what the receiver claims arrived,
- auto-write off the difference as shrinkage,
- or auto-close the transfer as "received" when quantities don't match.

This mirrors the same "no auto-overwrite of intentional differences" principle already established elsewhere in this ecosystem's governance (CLAUDE.md Rule B9, for a different feature) — a discrepancy is a fact requiring review, not an error to paper over.

## 8. Dashboard Visibility (extends Codebox 77's Transfer Readiness panel)

Once built, the static "not active yet" panel becomes real, still company-scoped exactly like every other Codebox 77 card:

- **Outgoing Transfers** — `pos_transfer_headers` where `sending_company_id = current company`, grouped by status.
- **Incoming Transfers (Pending Acceptance)** — `receiving_company_id = current company AND status IN ('sent', 'in_transit')`.
- **Returned Stock** — `direction = 'return'` rows involving the current company, either side.
- **Transfer Exceptions** — `status = 'exception'` involving the current company — surfaced as a dashboard Operational Alert too, same pattern as the existing negative-stock/cash-variance alerts.

**Never shown:** any transfer between two OTHER companies. Every query filters by `sending_company_id = req.companyId OR receiving_company_id = req.companyId` — never a bare `SELECT *` across the table. This is the same absolute company-isolation standard already applied to every endpoint built in Workstream 71 and Codebox 77.

## 9. Security Model

- A transfer can only be created if `inter_company_relationships.status = 'active'` AND both `_confirmed = true` AND the sender's `permissions.send_stock_transfers = true` AND the receiver's `permissions.receive_stock_transfers = true`. All four conditions, checked server-side, every time — never trust a client-supplied "this relationship is fine" flag.
- Both companies' own existing role/permission systems still apply on top: e.g. only a role with `INVENTORY.ADJUST`-equivalent standing should be able to *initiate* a send (stock leaving the building is a high-trust action, same tier as a manual stock adjustment), while `INVENTORY.VIEW` is enough to *see* pending incoming transfers.
- A relationship being `active` for invoices does **not** imply stock-transfer trust — the separate `send_stock_transfers`/`receive_stock_transfers` flags (§2) are the actual gate, so a company can safely trade invoices with a partner without being forced to also expose stock-transfer capability.
- No transfer data is ever visible to a company that isn't `sending_company_id` or `receiving_company_id` on that specific row — not even to a `super_admin`, unless they are explicitly on a global admin dashboard outside the POS client context (mirrors this ticket's existing rule for the Enterprise Dashboard).

## 10. Audit Requirements

`pos_transfer_events` is append-only (same convention as `pos_audit_events`, `practice_*_events` elsewhere in this ecosystem) — every state change writes a new row, nothing is ever updated or deleted. At minimum: creation, send, receive (full or partial), exception raised, exception resolved (a *new* event, referencing the exception it resolves — not an edit to the original), return created, cancellation. Each event carries `before_snapshot`/`after_snapshot` for the affected quantities/status, matching the exact shape `posAuditLogger.js` already uses.

## 11. What Must NOT Be Automated Without Explicit Confirmation

- **Enabling a relationship** — always requires both companies to separately opt in (already enforced by the existing `inter_company_relationships` mutual-confirm design; do not add an "auto-accept" mode).
- **Enabling stock-transfer permissions on an existing relationship** — a company that already trusts a partner for invoices must still take a separate, explicit action to allow stock transfers. Never inherited automatically.
- **Stock quantity adjustments on receipt discrepancies** — see §7. A human on the receiving side confirms what arrived; a human on the sending side reviews and resolves any mismatch. No automatic reconciliation.
- **Product matching** — the system may *suggest* a likely match (e.g. by matching product name/barcode if the receiving company happens to stock the same item under the same code), but the receiving company must confirm the match before stock increments. Never silently create or merge product records across companies.
- **Cancelling an in-transit transfer** — if Turkstra wants to cancel after Pennygrow has already partially received it, this must be a reviewed action on both sides, not a unilateral stock-reversal.
- **Relationship suspension/termination** — should immediately block *new* transfers but must never retroactively alter or hide the history of already-completed ones (audit trail integrity).

---

## 12. Explicitly Out of Scope for the First Build (when this is eventually built)

- Automatic replenishment ("Pennygrow is low on X, auto-request from Turkstra") — a manual trigger only, at least initially.
- Pricing/costing differences between companies on a transfer (e.g. transfer-price vs. retail-price) — first version should transfer at cost, no markup, to keep the accounting implications simple; anything beyond that needs its own design pass with Accounting's involvement (and therefore its own explicit authorization, per this ecosystem's standing rules on cross-module changes).
- More than two companies in a single transfer — always company-to-company, never a multi-party batch.
