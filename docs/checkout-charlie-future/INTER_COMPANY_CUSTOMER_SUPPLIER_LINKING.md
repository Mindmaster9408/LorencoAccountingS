# Inter-Company Customer/Supplier Linking — Architecture & Roadmap
## Checkout Charlie

**Status:** Foundation implemented (Workstream 80). Stock transfer engine itself NOT built.
**Last updated:** 2026-07-08

This document is the reference model for how two Checkout Charlie companies link to each other as trading partners, and what a future stock-transfer feature must build on top of the foundation that already exists.

---

## The Turkstra ↔ Pennygrow Example

Turkstra sells stock to Pennygrow. In today's (Workstream 80) system:

1. **Pennygrow** opens Settings → Suppliers, edits (or creates) a supplier record named "Turkstra", and enters Turkstra's invitation code in the Company Link section.
2. The system looks up the code via the shared `InterCompanyNetwork` engine, finds Turkstra's company record, and creates a **pending** relationship. Pennygrow's supplier row is stamped with `linked_company_id`, `linked_relationship_id`, and `link_status = 'pending'`.
3. **Nothing is shared yet.** Turkstra does not see any of Pennygrow's data, and Pennygrow does not see any of Turkstra's data beyond the company name.
4. Turkstra must separately confirm the relationship (via `POST /api/pos/company-links/:id/confirm`, or the equivalent accounting-side confirm — same table, same relationship). Once confirmed, `link_status` becomes `active` on both sides.
5. Today, an active link means only this: *the two companies have a confirmed trading relationship, recorded and auditable.* No stock, pricing, or invoice data flows automatically — the `permissions` JSON flags for that (`stock_transfer`, `receive_transfer`, `return_transfer`, `pricing_visible`, `invoice_reference_visible`) all default to `false` and are not yet read anywhere.

### What a future stock-transfer feature adds on top

Once built, the intended flow is:

- Turkstra creates an outgoing transfer against the active relationship (references `inter_company_relationships.id`, not a raw company ID — keeps the transfer scoped to an explicitly-confirmed relationship, never an arbitrary company).
- Pennygrow sees it as a **pending incoming transfer** on their Enterprise Dashboard (the `dashboardCompanyLinksSummary` line built in Workstream 80 is the first small piece of this — real relationship counts, no transfer numbers yet since there's nothing to count).
- Pennygrow receives it into stock via a flow that reuses the *existing* Workstream 78 receive machinery (`POST /api/pos/inventory/receive`) rather than inventing a second stock-increase code path — the only new part is where the receive's `supplier_id`/pricing data comes from (the transfer record) instead of manual entry.
- Turkstra sees the transfer's status update (sent → received) once Pennygrow confirms receipt.
- Returns flow the same way in reverse, reusing the existing Workstream 78 return machinery (`POST /api/pos/inventory/return`).

This is why Workstream 80 built the receive/return machinery to be supplier-relationship-aware in the first place (Workstream 78's `product_suppliers.last_purchase_price` tracking, this workstream's `linked_relationship_id` on the supplier row) — a transfer feature extends existing, already-tested code paths instead of duplicating them.

---

## Data Model

**No new relationship table.** Everything reuses `inter_company_relationships` (accounting's existing table, migration 001):

```
inter_company_relationships
  id
  company_a_id, company_b_id      -- the two companies
  initiated_by                     -- which company sent the request
  status                           -- 'pending' | 'active' | 'revoked'
  company_a_confirmed, company_b_confirmed  -- BOOLEAN, both must be true for 'active'
  permissions                      -- JSONB, see below
  created_at, updated_at
```

`permissions` JSONB — accounting's original flags plus Workstream 80's POS flags, all POS flags default `false`:

```json
{
  "send_invoices": true,
  "receive_invoices": true,
  "auto_match_payments": false,

  "stock_transfer": false,
  "receive_transfer": false,
  "return_transfer": false,
  "pricing_visible": false,
  "invoice_reference_visible": false
}
```

**Supplier/customer side (Workstream 80, additive columns on existing tables):**

```
suppliers / customers
  linked_company_id       -- INTEGER REFERENCES companies(id), nullable
  linked_relationship_id  -- INTEGER, soft-references inter_company_relationships.id, nullable
  link_status              -- 'none' | 'pending' | 'active' | 'revoked', denormalised cache
```

`link_status` is a cheap, list-view-friendly cache of the relationship's real status. It is kept in sync by `POST /api/pos/company-links/:id/confirm` and `/:id/revoke` (both update every supplier/customer row pointing at that relationship id, scoped to the confirming/revoking company). It is never the source of truth — `inter_company_relationships.status` is.

**Why one supplier row = one relationship (not many):** the `/:id/link-company` route rejects a second link attempt while an existing one is pending or active. A company that trades with the same partner as both buyer and seller would need two records today (one supplier row, one customer row) rather than a single unified "trading partner" entity — kept simple deliberately; a unified entity is a bigger modeling decision better made once real usage shows whether it's actually needed.

---

## Client/Company Code Linking

Reuses `companies.invitation_code` (already live, already generated by `InterCompanyNetwork.generateInviteCode()` as `IC-XXXXXXXX`) and `companies.inter_company_enabled` (a company must opt in before its code is discoverable at all — `findCompanies()` filters out any company with this flag false).

**Lookup is exact-match only.** `POST /api/pos/company-links/lookup` and `POST /api/pos/suppliers/:id/link-company` both require the literal invitation code; there is no fuzzy search, no name-based browsing, and no way to enumerate companies from the POS client. This is a deliberate, narrower surface than accounting's own `/api/inter-company/find` (which also supports name/tax-number/VAT-number/email-domain fuzzy matching) — POS only needs the "I have a code, find that one company" case, and the narrower the search surface, the smaller the cross-company data-leakage risk.

---

## Approval Flow

```
Pennygrow                                    Turkstra
    |                                            |
    | POST /suppliers/:id/link-company            |
    | { invitationCode: "IC-TURKSTRA1" }          |
    |--------------------------------------------->
    |   relationship created, status='pending'    |
    |   company_a_confirmed=true (Pennygrow)      |
    |   company_b_confirmed=false (Turkstra)      |
    |                                            |
    |          <-- Turkstra sees the pending -->  |
    |              relationship via their own     |
    |              GET /api/pos/company-links     |
    |                                            |
    |                          POST /company-links/:id/confirm
    |                          <---------------------
    |   status='active' (both confirmed)          |
    |<---------------------------------------------
```

- Either company can **revoke** at any time (`POST /company-links/:id/revoke`) — immediate, one-directional, no counter-confirmation required. The other side simply sees `status='revoked'` next time they list their relationships.
- A revoked relationship cannot be un-revoked; a fresh link request creates a new relationship row.
- **Nothing about who initiated is hidden** — `initiated_by` is visible to both sides once the relationship exists (post-request), but the searching company cannot see anything about the target company beyond name/city/industry *before* the request is sent.

---

## Receive Flow (once a real transfer exists — not built yet)

Planned, not implemented:

1. Turkstra creates a transfer against the active relationship, listing products + quantities (their own `product_suppliers`-tracked SKUs, reusing Workstream 78's price-tracking data as the transfer's line-item pricing).
2. Pennygrow's dashboard shows it as a pending incoming transfer (extends the `dashboardCompanyLinksSummary` line from a count into an actionable list).
3. Pennygrow reviews and receives it — internally this becomes a normal `POST /api/pos/inventory/receive` call with `supplier_id` set to the linked supplier row and `reference` set to the transfer ID, so it shows up in the existing Supplier Receives report with zero new reporting code needed.
4. Stock increases exactly as any other supplier receive does today; the transfer's status flips to "received" and Turkstra sees that reflected on their side.

## Return Flow (once a real transfer exists — not built yet)

Symmetric: Pennygrow returns stock to Turkstra via a normal `POST /api/pos/inventory/return` call (Workstream 78 machinery, unchanged), tagged with the transfer reference. Turkstra sees the return on their side once Pennygrow submits it.

---

## Dashboard Visibility

**Built now (Workstream 80):** Enterprise Dashboard shows a real, honest count — *"N active company(ies) linked, N pending approval"* — sourced from `GET /api/pos/company-links`, only rendered when at least one relationship exists. No fabricated transfer numbers.

**Future, once transfers exist:**
- Incoming Transfers (pending receive)
- Outgoing Transfers (sent, awaiting the other side's receive confirmation)
- Returns Pending
- Relationship Pending Approval (already partially covered by today's pending-count line)

Each of these must remain scoped to relationships with `status = 'active'` and the specific `permissions` flag enabled for that capability (e.g. a transfer count must not appear for a relationship that only has `send_invoices` enabled and `stock_transfer` still `false`).

---

## Security Rules (apply to every future extension of this model)

- **Company isolation is absolute.** Every query is scoped to `req.companyId`; a relationship row is only ever readable by the two companies it names.
- **No global company list in POS client context.** Lookup requires an exact invitation code — confirmed in this workstream's implementation, must hold for every future addition (a transfer-creation UI must not gain a "browse partners" list beyond the company's own confirmed relationships).
- **No cross-company data without an active, explicit relationship.** Even with an active relationship, each capability (`stock_transfer`, `pricing_visible`, etc.) is a separate flag — "linked" does not mean "everything visible."
- **No automatic receive.** A transfer, once built, must require an explicit receive action from the receiving company — never auto-applied to stock on creation.
- **No accounting integration from POS.** This workstream does not touch invoicing; `send_invoices`/`receive_invoices`/`auto_match_payments` remain accounting's exclusive concern, POS only adds its own flags to the same JSON.
- **No BOM/manufacturing.**
- **No localStorage/sessionStorage for any of this.** Relationship state, link status, and everything in this document is backend-authoritative, exactly as required for all POS business data.

## What Must NOT Be Automated (explicit, permanent)

- A relationship must never auto-activate without both sides confirming.
- A permission flag must never default to `true` for a new capability without an explicit, deliberate decision documented in a future workstream (mirrors the ecosystem-wide Sean-learning propagation rules in `CLAUDE.md` Part B — global/cross-entity changes require explicit authorization, never silent default-on).
- A transfer must never auto-apply to stock without the receiving company's explicit receive action.
- A company must never be able to discover another company's existence, name, or any detail through this system without already holding that company's invitation code.
