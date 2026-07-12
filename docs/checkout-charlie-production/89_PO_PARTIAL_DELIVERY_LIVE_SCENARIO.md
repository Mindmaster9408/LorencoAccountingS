# Workstream 89 — Live Purchase Order Partial Delivery Scenario (50 → 25+10+15 → One Invoice)

## Verdict: **FAIL — blocked before Phase 1 by a proven, pre-existing schema collision**

No part of the business scenario (PO creation, acceptance, delivery, receive, invoice) was executed. Every action taken in this workstream was a **read-only** diagnostic query against the live database — no purchase order, delivery, stock movement, or invoice was created, and no schema was altered. This finding was surfaced instead, per the ticket's own instruction: *"Do NOT build new features unless a real blocking bug is proven by the scenario."* A real, severe blocking bug was proven during test setup, before Phase 1 could even begin.

## Method

Connected read-only to the live database that backs the deployed Checkout Charlie app — confirmed via `accounting-ecosystem/backend/.env`: `DATABASE_URL` points to the Zeabur-hosted Postgres cluster (`sjc1.clusters.zeabur.com`) and `SUPABASE_URL` points to the live Supabase project (`glkndlzjkhwfsolueyhk.supabase.co`). This is the same database the deployed app uses — not a local or disposable test database. All queries in this workstream used the Supabase service-role client in `SELECT`-only form; no `.insert()`/`.update()`/`.delete()` call was ever made.

## Test Setup — Preconditions Checked

| Precondition (per ticket) | Found |
|---|---|
| Two companies exist (Pennygrow / Turkstra Bakkery) | ✅ Both exist. Pennygrow = company id 2, `inter_company_enabled: true`, invitation code `IC-FD73D000`. Turkstra Bakkery = company id 7, `inter_company_enabled: false`, no invitation code. |
| Relationship is active | ❌ **Zero rows in `inter_company_relationships` system-wide** — not just for these two companies, for the entire database. No relationship has ever been created between any two companies. |
| `purchase_orders` permission enabled | ❌ Cannot be enabled — no relationship exists to attach the flag to. |
| Product mapped between both companies | ❌ **Zero rows in `suppliers` for either company** — neither company has the other set up as a linked supplier record at all (the WS80 foundation `suppliers.linked_company_id` this depends on has never been used for this pair). |
| Supplier has sufficient source stock | Not reached — no product mapping exists yet to check against. |
| Invoice timing setting recorded | ❌ Cannot be recorded — see schema finding below, the column doesn't exist in the live database. |

None of the ticket's "confirm before starting" preconditions hold. Investigating *why* led directly to the blocking defect below.

## Root Cause — Two Distinct, Compounding Defects

### Defect 1 (contributing): WS87's schema migration has not run against the live database

`purchase-orders.js` (Workstream 87) depends on several columns added via `pos-schema.js`'s `ensurePosSchema()`, which `server.js` runs automatically on every boot. Direct read-only queries against the live database show these columns **do not exist**:

```
company_settings.po_invoice_timing        → ERROR 42703: column does not exist
pos_company_transfers.purchase_order_id   → ERROR 42703: column does not exist
inter_company_invoices.purchase_order_id  → ERROR 42703: column does not exist
```

`locations` and `pos_transfer_discrepancies` (Workstream 85) DO exist, confirming `ensurePosSchema()` has run successfully at some point in the past — just not since Workstream 87's additions were pushed (commit `0b5bd0e`). The most likely explanation is that the deployed Zeabur service has not redeployed/restarted since that push. This defect alone would very likely self-resolve on the next deploy — but it is not the real blocker.

### Defect 2 (root cause, NOT self-resolving): `purchase_orders` / `purchase_order_items` already exist as a different, already-shipped feature

This is the actual blocking bug. A live query of `purchase_orders` returns rows — but not Workstream 87's schema:

```json
{
  "id": 1, "company_id": 1, "supplier_id": 3, "po_number": "LPO-2026-1781788861070",
  "po_date": "2026-06-18", "vat_inclusive": false, "subtotal_ex_vat": 0,
  "vat_amount": 0, "total_inc_vat": 0, "status": "cancelled", "currency_code": "ZAR", ...
}
```

Four real rows exist (ids 1–4, created 2026-06-18, two `cancelled`, two `fully_received`) against `company_id: 1`. Tracing the column shape (`vat_inclusive`, `subtotal_ex_vat`, `total_inc_vat`, `po_date`, `currency_code`) to source: **`accounting-ecosystem/backend/config/accounting-schema.js`, section "23c. Purchase Orders"** defines this exact table — a single-company, local-supplier, VAT-invoice-style Purchase Order feature belonging to the **Accounting/Inventory module** (`accounting-ecosystem/backend/modules/inventory/routes/purchase-orders.js`, with its own frontend at `frontend-inventory/index.html`), not to Checkout Charlie POS at all. This is an already-shipped, already-used feature that Workstream 87 never knew existed.

`pos-schema.js`'s `CREATE TABLE IF NOT EXISTS purchase_orders (...)` — Workstream 87's own commercial-PO schema, with an entirely different column set (`supplier_company_id`, `relationship_id`, `invoice_timing`, `total_ordered_qty`, `total_received_qty`, `invoice_id`) — **silently no-ops** every time it runs, because a table named `purchase_orders` already exists. The same applies to `purchase_order_items` vs. the pre-existing `purchase_order_lines`/line-item shape. **No amount of redeploying will ever create Workstream 87's tables under these names.** This is not a deployment-lag issue like Defect 1 — it is a permanent naming collision that requires a code fix.

**Process failure acknowledged:** Workstream 87's original audit (this session, prior turn) searched `modules/pos/`, `inter-company/`, and invoice-related accounting routes for anything named "invoice," but never searched for an existing `purchase_orders` table before choosing that name — a violation of CLAUDE.md Rule A1 (audit before change). Every other Workstream 87/85 table correctly used a `pos_` prefix specifically to avoid collisions with shared/other-module tables (`pos_company_transfers`, `pos_transfer_discrepancies`, etc.) — `purchase_orders`/`purchase_order_items` were the two exceptions, and that inconsistency is exactly why this went undetected until this live-verification pass caught it.

## What Was NOT Done

Per the ticket's explicit instructions, no fix was applied without confirmation:
- No table was renamed.
- No schema was altered.
- No code was changed.
- No purchase order, delivery, stock adjustment, or invoice was created against the live database.
- Nothing was committed or pushed.

## Recommended Fix (for approval, not yet applied)

Rename Workstream 87's two new tables to match the `pos_` prefix convention every other table in this feature set already uses — `pos_purchase_orders` / `pos_purchase_order_items` — and update the three files that reference them (`pos-schema.js`, `purchase-orders.js`, `reports.js`). This is a mechanical rename, not a redesign: no column, no route, no business logic changes. The pre-existing accounting-module `purchase_orders`/`purchase_order_lines` tables and their four real historical rows are left completely untouched.

```
FOLLOW-UP NOTE
- Area: Workstream 87 schema — table naming collision
- Dependency: accounting-schema.js "23c. Purchase Orders" (pre-existing, already-shipped,
  already has live data as of 2026-06-18)
- Confirmed now: purchase_orders/purchase_order_items as designed in Workstream 87 have never
  been created in the live database and structurally cannot be, under those names
- Not yet confirmed: whether renaming to pos_purchase_orders/pos_purchase_order_items is the
  right fix, or whether Workstream 87's inter-company PO feature should instead be unified
  with the existing single-company accounting/inventory PO feature — this is an architecture
  decision for the user, not something to decide unilaterally
- Risk if wrong: none yet — nothing has been written; this is purely a design/naming decision
- Recommended next step: user confirms the rename approach (or an alternative), then this
  workstream resumes from Phase 1 of the live scenario
```

## Next Step

This workstream is paused pending direction on the rename fix above. Once resolved, Phases 1–5, the invoice test, stock reconciliation, negative/edge tests, reports/dashboard checks, and audit trail verification from the original ticket will be executed against the live database exactly as specified, and this document will be updated with the actual results.
