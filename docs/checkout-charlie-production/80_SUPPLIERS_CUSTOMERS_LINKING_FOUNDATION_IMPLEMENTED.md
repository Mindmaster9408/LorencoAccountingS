# Workstream 80 — Suppliers + Customers + Inter-Company Linking Foundation
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium tests, real HTTP server, mocked API responses — see doc 81)
**Date:** 2026-07-08
**Scope:** Full supplier CRUD, and a company-linking foundation that reuses the existing accounting inter-company module rather than building a parallel system.

---

## Audit — What Was There Before

- Settings → Suppliers (built in Workstream 78) had a working list view and a "Manage Linked Products" flow, but supplier creation was a stub notification ("Supplier creation coming soon") and there was no edit or archive path at all — exactly the "coming soon" gap this ticket named.
- **A major reuse opportunity was found and used instead of building new infrastructure**: `accounting-ecosystem/backend/inter-company/` (network.js, routes.js, invoice-sender.js, invoice-receiver.js, payment-sync.js) already implements almost exactly what Part 4/5 of this ticket describes — company discovery by invitation code, a `pending → active` mutual-confirmation relationship model, and a `permissions` JSON column, all backed by a real, already-live table (`inter_company_relationships`, migration 001). It was built for accounting's inter-company invoice exchange (Turkstra ↔ Pennygrow invoicing), but the relationship *model* is identical to what this ticket asks for. Per the "shared > duplicated" standard, this workstream reuses that exact engine rather than creating a second, parallel relationship system — a future stock-transfer feature and today's supplier/customer linking both extend the same `permissions` JSON on the same table.
- `companies.invitation_code` and `companies.inter_company_enabled` already exist live and are exactly the "company/client code" fields the ticket asked to explore (Part 5) — confirmed via live schema query, not assumed.
- **Two real, pre-existing bugs were found in the reused module while integrating it**, and fixed as part of this work (both purely additive/corrective, no external contract change):
  1. `InterCompanyNetwork.confirmRelationship()` looked up the relationship via `getRelationships(companyId)`, which only returns rows with `status = 'active'` — meaning a still-*pending* relationship (the exact case this method exists to handle) could never be found. Fixed by adding `getRelationshipById()` and looking up by ID regardless of status.
  2. `confirmRelationship()` mutated an in-memory relationship object (`rel.status = 'active'`, etc.) but **never wrote it back to the database at all** — confirming a relationship silently did nothing to persisted state. Fixed by adding `updateRelationship()` and persisting the result. This also means the existing accounting `/api/inter-company/relationships/:id/confirm` endpoint now actually works, where previously it silently didn't.
  - Both fixes were necessary for this workstream's confirm/revoke flow to function at all, and are documented here because they touch shared, non-POS code (`accounting-ecosystem/backend/inter-company/network.js`, `accounting-ecosystem/backend/sean/supabase-store.js`).

---

## Schema Changes

`accounting-ecosystem/backend/config/pos-schema.js` (additive, applies automatically on next server start):

| Table | New columns | Purpose |
|---|---|---|
| `suppliers` | `linked_company_id INTEGER REFERENCES companies(id)`, `linked_relationship_id INTEGER`, `link_status VARCHAR(20) DEFAULT 'none'` | Points a supplier row at a real platform company + the shared relationship record; `link_status` is a denormalised cache (`none`/`pending`/`active`/`revoked`) for cheap list-view display without a join |
| `customers` | Same three columns | Symmetric, for the future case where *this* company is the seller and the other company is tracked as a customer (Turkstra's side of the Turkstra↔Pennygrow example) |
| `inter_company_relationships` | `updated_at TIMESTAMPTZ DEFAULT NOW()` | Was missing entirely; needed so confirm/revoke can record when status last changed. Wrapped in `.catch(() => {})` since this table belongs to the `sean` migration set, not pos-schema.js — defensive if that migration hasn't run in some environment. |

No new relationship table. `inter_company_relationships.permissions` (existing JSONB column) now defaults to a superset covering both accounting's existing flags and the new POS ones:
```json
{
  "send_invoices": true, "receive_invoices": true, "auto_match_payments": false,
  "stock_transfer": false, "receive_transfer": false, "return_transfer": false,
  "pricing_visible": false, "invoice_reference_visible": false
}
```
Every new POS flag defaults to `false` — a relationship existing (even active) never itself grants access to anything; each capability must be explicitly turned on later (deliberately not built in this workstream — see Part 6 / future doc).

---

## Backend Changes

### `accounting-ecosystem/backend/inter-company/network.js` (shared module — additive)
- `createRelationship(companyAId, companyBId, initiatedBy, extraPermissions = {})` — new 4th parameter, merged into the default permissions object. Existing accounting callers (which don't pass it) are unaffected.
- `confirmRelationship()` — rewritten internals (lookup-by-ID + persist), same external contract (`{success, relationship, message}`); now also rejects with a clear error if the requester isn't part of the relationship, and if the relationship was revoked.
- `revokeRelationship(relationshipId, companyId)` — new method, mirrors `confirmRelationship`'s authorization pattern.
- `getAllRelationships(companyId)` — new method returning every status (pending/active/revoked), since the existing `getRelationships()` intentionally only returns active ones.

### `accounting-ecosystem/backend/sean/supabase-store.js` (shared module — additive)
- `getRelationshipById(relationshipId)`, `updateRelationship(relationshipId, updates)`, `getAllRelationships(companyId)` — new methods backing the above.

### `accounting-ecosystem/backend/modules/pos/routes/suppliers.js`
New routes, all `INVENTORY.ADJUST` (management-only) for writes / `INVENTORY.VIEW` for reads, all `req.companyId`-scoped:
- `GET /` — extended with `?search=` (name/code/contact, case-insensitive) and `?include_inactive=true`.
- `POST /` — create supplier. `supplier_code` auto-generated (`SUP-` + random hex) if omitted.
- `PUT /:id` — edit supplier fields (not product links — unchanged `/:id/products` route from Workstream 78 handles that).
- `PATCH /:id/deactivate` / `PATCH /:id/activate` — archive/restore (soft delete via `is_active`). Product links, receive/return history, and any company link are left untouched by archiving.
- `POST /:id/link-company` — request a cross-company link by invitation code. Looks the code up via `InterCompanyNetwork.findCompanies()` (exact match only, no company enumeration), creates a `pending` relationship via `createRelationship()` with all new permission flags defaulted `false`, and stores the result on the supplier row. Rejects if the supplier already has a pending/active link.

### `accounting-ecosystem/backend/modules/pos/routes/company-links.js` (new file)
A thin, POS-permissioned wrapper around the shared `InterCompanyNetwork` — **not** a call to `/api/inter-company/*` directly, because that route is gated on `requireModule('sean')` with no company-scoped permission check at all, the wrong boundary for POS. These routes apply POS's own `requireCompany` + `INVENTORY.*` gates while writing to the exact same shared table.
- `POST /lookup` — find a company by exact invitation code, returns only safe preview info (id, name, city, industry) — never financial/contact details, never a browsable company list.
- `GET /` — list this company's relationships (any status), enriched with only the counterparty's display name (one extra `companies` query, name only).
- `POST /:id/confirm` — confirm this company's side; syncs any supplier/customer rows pointing at the relationship to the resulting status; fires `COMPANY_RELATIONSHIP_APPROVED` only when the relationship actually becomes `active`.
- `POST /:id/revoke` — revoke; syncs linked records to `revoked`; fires `COMPANY_RELATIONSHIP_REVOKED`.

Mounted at `/api/pos/company-links` in `modules/pos/index.js`.

### `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js`
New events: `SUPPLIER_CREATED`, `SUPPLIER_UPDATED`, `SUPPLIER_DEACTIVATED`, `SUPPLIER_REACTIVATED` (category `inventory`), `COMPANY_RELATIONSHIP_REQUESTED`, `COMPANY_RELATIONSHIP_APPROVED`, `COMPANY_RELATIONSHIP_REVOKED` (new category `company_link`). No sensitive data logged — relationship events carry only the relationship ID and company name, never financial/contact details.

---

## Frontend Changes (`accounting-ecosystem/frontend-pos/index.html`)

### Settings → Suppliers
- Search box (`oninput` re-queries `GET /suppliers?search=`) and a "Show archived" toggle — real Part 1 search/filter, not a placeholder.
- Table gained **Company Link** and **Status** columns; Actions now has Edit / Linked Products / Archive-or-Restore per row.
- New `supplierEditModal` (replaces the old stub) used for both create and edit: name, code, payment terms, contact name/phone/email, address, notes.

### Company Link section (inside the edit modal, Workstream 80)
- Hidden entirely for a brand-new (unsaved) supplier — a relationship needs a real supplier ID to attach to.
- For an unlinked supplier: invitation-code input + "Link" button → `POST /:id/link-company`.
- For a pending/active link: shows the counterparty's ID and status badge, a plain-language note ("waiting for approval" vs. "confirmed — no data is shared automatically, this only records that a relationship exists"), and a "Revoke" button → `POST /company-links/:id/revoke`.
- For a revoked link: shows "Revoked" and re-offers the invitation-code input to request a new link.

### Enterprise Dashboard — Part 6 readiness
- Added a **real** (not fabricated) company-link summary line inside the existing Transfer Readiness panel, sourced from `GET /api/pos/company-links`: *"N active company(ies) linked, N pending approval"* — only rendered if at least one relationship exists. The actual stock-transfer-movement message stays exactly as the honest "not active yet" static text from Workstream 77 — that mechanism genuinely isn't built. This satisfies "no fake transfer numbers" by only ever showing counts backed by a real endpoint call, never inventing a number when there's nothing to show.

---

## What Was Deliberately Not Built (Part 5/6 scope discipline)

- **No automatic linking.** A link request always creates a `pending` relationship; nothing is shared, and no stock/pricing/invoice data becomes visible, until the counterparty explicitly confirms via their own side.
- **No cross-company data exposure beyond name + status.** `POST /lookup` and `POST /:id/link-company` return only `{id, name, preview:{city, industry}}` for the matched company — no tax numbers, banking details, contact info, or catalogue data, matching the existing `InterCompanyNetwork.findCompanies()` redaction behaviour it reuses.
- **No global company list.** Every lookup requires an exact invitation code; there is no "browse all companies" endpoint reachable from POS.
- **No stock transfer engine.** `stock_transfer` / `receive_transfer` / `return_transfer` permission flags exist on the relationship (defaulted `false`) as the foundation a future feature will read, but no transfer UI, route, or table was built — consistent with "Do NOT build the full inter-company stock transfer engine yet."
- **No customer-side linking UI.** The `customers` table got the same three columns for symmetry and future-readiness, but no customer-side "link this customer to a company" screen was built in this workstream — only suppliers got the UI, since that's what Parts 1–3 asked for. Documented as a gap, not hidden.

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/backend/config/pos-schema.js` | +suppliers/customers linking columns, +inter_company_relationships.updated_at |
| `accounting-ecosystem/backend/inter-company/network.js` | createRelationship extraPermissions param; confirmRelationship persistence fix; new revokeRelationship, getAllRelationships |
| `accounting-ecosystem/backend/sean/supabase-store.js` | +getRelationshipById, +updateRelationship, +getAllRelationships |
| `accounting-ecosystem/backend/modules/pos/routes/suppliers.js` | +full CRUD, +link-company route |
| `accounting-ecosystem/backend/modules/pos/routes/company-links.js` | new file — lookup/list/confirm/revoke |
| `accounting-ecosystem/backend/modules/pos/index.js` | mounts company-links router |
| `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js` | +7 new events |
| `accounting-ecosystem/frontend-pos/index.html` | Suppliers search/filter/CRUD UI, company-link UI, dashboard readiness line |

---

## Related Documentation

- `docs/checkout-charlie-future/INTER_COMPANY_CUSTOMER_SUPPLIER_LINKING.md` — full model, Turkstra↔Pennygrow example, approval flow, security rules, what must not be automated.
- `docs/checkout-charlie-future/INTER_COMPANY_STOCK_TRANSFER_AND_CLIENT_LINKING.md` (Workstream 77) — the original roadmap doc that first identified `inter_company_relationships` as the reuse target; superseded in scope by the new doc above but left in place as historical record.
- `docs/checkout-charlie-production/81_SUPPLIERS_CUSTOMERS_LINKING_FOUNDATION_VERIFIED.md` — verification results.
