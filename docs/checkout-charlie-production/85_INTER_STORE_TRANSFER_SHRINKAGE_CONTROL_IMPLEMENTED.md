# Workstream 85 — Inter-Store Stock Transfers + Shrinkage Control (IMPLEMENTED)

## Summary

Built a forensic custody-and-variance transfer system for stock moving between **locations of the same company** (e.g. Factory → Retail Store). This is distinct from Workstream 81's inter-company transfers, which move stock between different companies over the `IC-` invitation-code relationship.

No `locations` concept existed anywhere in the schema before this workstream — confirmed via live 404s on `locations`/`stores`/`branches`/`sites` table names — and `products.stock_quantity` was a single company-wide number, not location-scoped. Foundational schema work was required before the transfer feature itself could be built.

## Architecture Decision — Extend, Don't Duplicate

Rather than building a parallel transfer engine, `pos_company_transfers` / `pos_company_transfer_items` (built in Workstream 81) were extended with a `transfer_type` discriminator column (`'inter_company'` default vs new `'inter_store'`), per the ticket's explicit instruction and the codebase's "shared > duplicated" standard. All existing inter-company rows are unaffected (`transfer_type` defaults to `'inter_company'`).

## Schema Changes

`accounting-ecosystem/backend/config/pos-schema.js`:

- **`locations`** (new) — per-company physical sites: `location_name`, `location_code`, `address`, `is_active`.
- **`product_location_stock`** (new) — per-location stock quantities, replacing the single company-wide `products.stock_quantity` for any product tracked at location level.
- **`user_locations`** (new) — explicit user → location assignments (non-management roles need a row here to access a location; management roles see all locations by default).
- **`pos_transfer_discrepancies`** (new) — one row per line-item variance on receive, carrying `discrepancy_type` (shortage/damage/rejection), `variance_quantity`, and a `resolution_reason` set only via the resolve-variance endpoint.
- **`pos_company_transfers`** — 18 new columns including `transfer_type`, `source_location_id`, `destination_location_id`, `blind_receive` (snapshotted at creation from `company_settings.blind_transfer_receiving`), `total_variance`, `investigation_required`.
- **`pos_company_transfer_items`** — 8 new columns including `quantity_damaged`, `quantity_rejected`, and stock-before/after snapshots for audit.
- **`company_settings.blind_transfer_receiving`** (new) — when enabled, a receiver cannot see the sender's claimed quantity until they submit their own count, preventing anchoring bias in shrinkage detection.

## Permissions

`accounting-ecosystem/backend/config/permissions.js` — new `TRANSFERS` block:

| Action | Roles |
|---|---|
| `CREATE`, `DISPATCH`, `RECEIVE`, `VIEW_REPORTS` | `SUPERVISOR_ROLES` |
| `APPROVE`, `RESOLVE_VARIANCE` | `MANAGEMENT_ROLES` |

Variance resolution is deliberately management-gated — a supervisor can report a shortage but cannot close it out themselves.

## Backend

**`accounting-ecosystem/backend/modules/pos/routes/locations.js`** (new) — exports `getAssignedLocationIds()` (management roles get all locations; others need explicit `user_locations` rows) alongside the router:

- `GET /` — list locations (management: all; others: assigned only)
- `GET /mine` — the caller's assigned locations
- `POST /` — create a location
- `PATCH /:id` — update / archive-restore a location
- `GET /:id/users` / `POST /:id/users` / `DELETE /:id/users/:userId` — assignment management

**`accounting-ecosystem/backend/modules/pos/routes/store-transfers.js`** (new, largest addition):

- `adjustLocationStockCAS()` — compare-and-swap stock mutation against `product_location_stock`, mirroring the pattern established in `company-transfers.js`: read current value, then `UPDATE ... WHERE quantity = <value read>` so a concurrent change causes a zero-row update instead of a silent overwrite.
- `getLocationStock()`, `assertLocationAccess()` — shared helpers.
- `GET /transferable-locations` — locations the caller may transfer between.
- `POST /` — create a draft transfer (source, destination, transport fields). Snapshots `blind_receive` from company settings at this point.
- `PUT /:id/items` — set line items for a draft.
- `POST /:id/dispatch` — locks the transfer, deducts source stock via CAS, sets status `in_transit`.
- `GET /outgoing` / `GET /incoming` / `GET /in-transit` — list views scoped to the caller's assigned locations.
- `GET /:id` — detail view; redacts `quantity_sent` per line when `blind_receive_active` and the caller has not yet submitted a receive count.
- `POST /:id/receive` — records `quantity_received`/`quantity_damaged`/`quantity_rejected` per line, computes variance, credits destination stock via CAS, auto-creates `pos_transfer_discrepancies` rows for any non-zero variance, flags `investigation_required` when thresholds are exceeded.
- `POST /:id/resolve-variance` — management-only; sets `resolution_reason`/`resolution_notes` on a discrepancy. Does not mutate stock further — the receive step already applied the actual counted quantities.
- `POST /:id/cancel` — cancels a draft/in-transit transfer, reverses any stock already deducted.

**Idempotent receive design**: rather than a dedicated idempotency-token table, a duplicate/retried receive submission is naturally rejected because each line's claimed quantity is checked against the item's currently-outstanding quantity at write time — a resubmission finds less (or zero) remaining and is rejected.

**`accounting-ecosystem/backend/modules/pos/routes/reports.js`**:

- `transfersViewGate` — `TRANSFERS.VIEW_REPORTS` permission check reused across both new endpoints.
- `GET /store-transfer-register` — Register / Variance / In-Transit / Overdue views via query params (`variance_only`, `in_transit_only`, `overdue_only`). Summary includes `awaitingReceiptCount`, `varianceCount`, `investigationCount` for dashboard use.
- `GET /store-transfer-risk` — Shortages-by-Source, Shortages-by-Destination, Variances-by-Sender, Variances-by-Receiver, Damage-in-Transit, Investigation-Risk via a `group_by` param. Threshold-based flags (`INCIDENT_THRESHOLD = 3`, `VARIANCE_PCT_THRESHOLD = 10%`) surface **risk indicators only** — every response is explicit that this is not an accusation, per the ticket's rule that no one may be automatically labeled as stealing.

**`accounting-ecosystem/backend/modules/pos/routes/settings.js`** — `PUT /blind-transfer-receiving` (management-gated toggle).

**`accounting-ecosystem/backend/modules/pos/index.js`** — wired `locationsRoutes` → `/locations`, `storeTransfersRoutes` → `/store-transfers`.

**`accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js`** — 12 new `STORE_TRANSFER_*` events (created, items set, dispatched, received, variance detected, variance resolved, cancelled, etc.) plus `LOCATION_CREATED`/`UPDATED`, `USER_LOCATION_ASSIGNED`/`REMOVED`.

## Frontend (`accounting-ecosystem/frontend-pos/index.html`)

- New "🔄 Inter-Store Transfers" button in the Stock toolbar, opening `storeTransfersModal` with tabs: Create / Outgoing / Incoming / In Transit / Variances / History.
- Create panel: location selects, transport fields (transported_by, vehicle, notes), barcode-driven item adding, Save Items + Dispatch actions.
- Shared detail panel for viewing a transfer's custody chain, items, and (if applicable) discrepancies.
- Receive flow: per-line quantity-received/damaged/rejected inputs; when `blind_receive_active`, the sender's claimed quantity is hidden until the receiver's own count is submitted.
- Variance resolution UI (management-gated) with `resolution_reason` and free-text notes.
- **Dead "Sites" Settings menu item repaired** — this menu entry existed with zero backing implementation before this workstream (same class of orphaned-scaffolding bug fixed for Suppliers in Workstream 78). Added `if (section === 'sites') { loadSettingsSites(); }` to `showSettings()`, and built the full `sitesSection`: blind-receive toggle, Add Site form, sites table with per-site assigned-user display and archive/restore/assign actions.
- New Enterprise Dashboard section `dashboardStoreTransferSection` — KPIs for In Transit, Awaiting Receipt, Overdue, With Variance, and Investigations Required, with an honest empty state when no transfers exist. Wired into `loadDashboard()`'s existing `Promise.all` fetch batch.

## Data Persistence Compliance (CLAUDE.md Part D)

All transfer, discrepancy, and location data is written exclusively to the SQL tables listed above via authenticated API endpoints. No transfer state, custody data, or variance data is written to `localStorage`/`sessionStorage`/`safeLocalStorage` at any point.

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: product_location_stock vs products.stock_quantity reconciliation
- Dependency: Products not yet assigned any product_location_stock row fall back to
  company-wide stock_quantity for non-transfer operations (sales, receiving from
  suppliers). This dual-source model was the minimum viable schema change to unblock
  WS85 without a full location-stock migration.
- Confirmed now: Inter-store transfers correctly read/write product_location_stock via CAS.
- Not yet confirmed: Whether sales/POS checkout should also become location-aware
  (i.e. deduct from product_location_stock instead of products.stock_quantity when a
  till is associated with a location). This was explicitly out of scope for WS85.
- Risk if wrong: A company using locations for transfers but not for sales could see
  product_location_stock and products.stock_quantity drift apart over time.
- Recommended next check: A dedicated workstream to decide whether till/session
  should carry a location_id and whether checkout should become location-scoped.
```
