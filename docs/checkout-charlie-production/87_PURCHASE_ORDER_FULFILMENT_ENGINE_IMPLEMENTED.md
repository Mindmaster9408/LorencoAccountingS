# Workstream 87 — Purchase Order + Delivery Fulfilment Engine (IMPLEMENTED)

## Business Problem

Pennygrow orders 50 boxes. Turkstra only has 25 today, 10 tomorrow, 15 next week. Pennygrow must receive ONE Purchase Order, ONE Invoice, and THREE Deliveries. The Purchase Order stays open until fully fulfilled; the Invoice belongs to the Order, never to an individual delivery.

## Architecture — Three Separate Objects, Never Merged

Per the ticket's explicit design principle, Commercial, Logistics, and Financial are kept as three distinct objects:

| Concept | Object | Ownership |
|---|---|---|
| Commercial (the Order) | `purchase_orders` / `purchase_order_items` | New in this workstream |
| Logistics (the Deliveries) | `pos_company_transfers` / `pos_company_transfer_items` / `pos_transfer_discrepancies` | **Reused** from Workstream 81/85 |
| Financial (the Invoice) | `inter_company_invoices` via `InvoiceSender` | **Reused** from the existing inter-company accounting module |

No new invoicing system and no parallel delivery engine were built. Both were audited first and extended.

## v1 Scope

Purchase Orders may only be raised against a **linked supplier** — a row in `suppliers` with `linked_company_id` set (Workstream 80's cross-company linking) and an ACTIVE `inter_company_relationships` row with the new `purchase_orders` permission flag enabled. "Supplier accepts" is a real digital action taken by a real user on the other side, which is only meaningful when the supplier is itself a Checkout Charlie company — matching the ticket's own Pennygrow/Turkstra example and the explicit instruction to reuse the transfer engine (which is inherently inter-company).

Raising a PO against a manual/unlinked supplier (paper-only fulfilment, using `pos_supplier_receives` as the delivery backend instead) is a natural v2 extension — see the FOLLOW-UP NOTE below.

## Database Model

`accounting-ecosystem/backend/config/pos-schema.js`:

- **`purchase_orders`** (new) — `company_id` (customer/orderer), `supplier_id`, `supplier_company_id` (resolved from `suppliers.linked_company_id` at creation — denormalized and immutable even if the underlying link later changes), `relationship_id`, `po_number`, `status`, `invoice_timing` (snapshotted from `company_settings.po_invoice_timing` at creation), `item_count`, `total_ordered_qty`, `total_received_qty` (rollup), `invoice_id`.
- **`purchase_order_items`** (new) — `product_id` (customer's own product), `supplier_product_id` (resolved once at first dispatch, reused for later deliveries of the same item), `quantity_ordered` (**never changes after submission**), `quantity_received` (rollup maintained by the delivery engine).
- **`pos_company_transfers`** — extended with `purchase_order_id` and `delivery_number` (nullable; existing `inter_company` and `inter_store` rows are completely unaffected). A third `transfer_type` value, `'po_delivery'`, joins the existing `'inter_company'` (Workstream 81) and `'inter_store'` (Workstream 85) values.
- **`company_settings.po_invoice_timing`** (new) — company-wide default (`'immediate'` | `'after_final_delivery'`), snapshotted onto each new PO at creation so a later settings change never alters an in-flight order's behaviour.
- **`inter_company_invoices.purchase_order_id`** (new) — traces a generated invoice back to the PO that produced it. No other change was made to the existing invoice tables or `InvoiceSender`/`InvoiceReceiver` classes.

## Purchase Order Lifecycle

```
draft → submitted → accepted → [deliveries...] → partially_fulfilled → awaiting_final_delivery → completed
                  ↘ rejected                                                                    ↗
                                          → cancelled (guarded — see below)     force-close ────┘
```

- **draft**: customer builds the order (`POST /`, `PUT /:id/items`) — no counterpart visibility yet.
- **submitted**: customer submits (`POST /:id/submit`) — now visible to the supplier.
- **accepted**: supplier accepts (`POST /:id/accept`, supplier-side, `PURCHASE_ORDERS.APPROVE`) or **rejected** (`POST /:id/reject`, terminal). If `invoice_timing = 'immediate'`, the invoice is generated here for the full ordered value (Option B).
- **awaiting_final_delivery**: set automatically the moment a dispatched delivery, if fully received, would clear all remaining outstanding quantity — this is a dispatch-time signal ("the last delivery is on its way"), distinct from...
- **partially_fulfilled**: set on RECEIVE, whenever some but not all ordered quantity has been received — matches the ticket's own worked example, where status changes are described purely in terms of Received/Outstanding after each delivery.
- **completed**: set the moment total received quantity reaches total ordered quantity across all items. If `invoice_timing = 'after_final_delivery'`, the invoice is generated here (Option A), for the actually-delivered quantities.
- **cancelled**: draft/submitted may be cancelled freely by the customer (`PURCHASE_ORDERS.CREATE`). Accepted-or-later requires `PURCHASE_ORDERS.APPROVE` **and** no delivery currently in transit — mirrors the safety guard already established in `company-transfers.js`'s own cancel route.
- **Force-close** (`POST /:id/close`, `PURCHASE_ORDERS.CLOSE`, management-only): a customer-side escape hatch for a partially fulfilled order that will never receive its full outstanding quantity — marks `completed`, writing off the remainder, and generates an invoice for only what was actually delivered if `invoice_timing = 'after_final_delivery'` and none exists yet.

The **Purchase Order itself never changes** — `quantity_ordered` is immutable after submission. Only the fulfilment rollup (`quantity_received`, status) changes, exactly as the ticket specifies.

## Delivery Lifecycle — Reusing the Transfer Engine

Every delivery is one row in `pos_company_transfers` (`transfer_type = 'po_delivery'`). Deliberately atomic — `POST /:id/deliveries` creates AND dispatches in one call, mirroring `company-transfers.js`'s existing `POST /send` pattern (a delivery only exists once it has actually been sent; there is no "draft delivery" state).

**Stock movement reuse**: `adjustStockCAS()` — the compare-and-swap primitive that decrements/increments `products.stock_quantity` — was extracted from `company-transfers.js` into a new shared module, `modules/pos/services/stockCAS.js`. `company-transfers.js` now imports it from there (mechanical, behaviour-preserving extraction — the function body is byte-identical to what it replaces) and the new PO delivery dispatch/receive logic imports the exact same function. This is the concrete answer to the ticket's "do not duplicate stock movement logic" instruction.

**Dispatch** (`POST /:id/deliveries`, supplier-side, `PURCHASE_ORDERS.DISPATCH`):
1. Resolves each `purchase_order_item_id` to a supplier-side product — explicit `supplier_product_id`, else the mapping already stored from a prior delivery of the same PO item, else barcode/product_code auto-match against the supplier's own catalog (mirrors the auto-match pattern already proven in `company-transfers.js`'s receive route).
2. Validates the requested quantity does not exceed what remains outstanding on that PO item.
3. Decrements supplier stock via `adjustStockCAS`, inserts the delivery header + items into `pos_company_transfers`/`pos_company_transfer_items`.
4. Flags the PO `awaiting_final_delivery` if this delivery, once received, would clear all remaining outstanding quantity.

**Receive** (`POST /:id/deliveries/:deliveryId/receive`, customer-side, `PURCHASE_ORDERS.RECEIVE`):
1. Accepts `quantity_received` / `quantity_damaged` / `quantity_rejected` per line — richer than `company-transfers.js`'s original receive route, matching the model already built in `store-transfers.js` (Workstream 85).
2. Credits customer stock via `adjustStockCAS` for the successfully received quantity only (damaged/rejected units never reach usable stock).
3. Any non-zero variance (damaged + rejected) creates a `pos_transfer_discrepancies` row, flagged `investigation_required` above the same 10%-of-quantity-sent threshold established in Workstream 85 — risk indicator only, never an accusation.
4. Rolls the received quantity up onto the authoritative `purchase_order_items.quantity_received`, recomputes the PO's overall status, and triggers invoice generation on completion if applicable.

**Variance resolution** (`POST /:id/deliveries/:deliveryId/resolve-variance`, customer management, `PURCHASE_ORDERS.APPROVE`): sets `resolution_reason`/`resolution_notes` once — never mutates stock further, since the receive step already applied the actually-counted quantities. Deliberately stricter than dispatch/receive, matching the Workstream 85 precedent that the person who reported a discrepancy should not normally be the one who closes it out.

## Invoice Relationship

The Invoice belongs to the Purchase Order, never to a delivery. Both timing options reuse the existing `InvoiceSender.send()` unmodified:

- **Option A — `after_final_delivery`**: invoice raised the moment the PO reaches `completed`, billing the quantities actually received (`purchase_order_items.quantity_received`).
- **Option B — `immediate`**: invoice raised the moment the supplier accepts, billing the full ordered quantities (`purchase_order_items.quantity_ordered`) regardless of delivery progress. The PO detail response (`GET /:id`) surfaces `invoice.ordered / invoice.delivered / invoice.outstanding` computed live from the PO's items, satisfying the ticket's "Invoice always shows Ordered / Delivered / Outstanding" requirement for Option B — without needing to modify the invoice record itself, since delivery progress changes after the invoice already exists.

The company-wide default is configurable at Settings → Suppliers → "Purchase Order invoice timing", snapshotted per-PO at creation.

## Permissions

New `PURCHASE_ORDERS` namespace in `config/permissions.js` — deliberately separate from the pre-existing but unused `INVENTORY.PO_CREATE`/`PO_APPROVE` pair (reserved for a different, unbuilt future Storehouse/Inventory module), matching the same "deliberately separate namespace" reasoning already documented for `TRANSFERS` vs `INVENTORY.TRANSFER`:

| Action | Roles |
|---|---|
| `CREATE`, `DISPATCH`, `RECEIVE`, `VIEW` | `SUPERVISOR_ROLES` |
| `APPROVE`, `CLOSE` | `MANAGEMENT_ROLES` |

A new relationship-level permission flag, `purchase_orders`, was added to `company-links.js`'s existing `POS_PERMISSION_KEYS` whitelist (alongside `stock_transfer`/`receive_transfer`/`return_transfer`/etc.) — a company must explicitly enable this per-relationship before a PO can be raised against it, toggled from the same Settings → Suppliers → linked-company permissions panel used for stock transfers.

## Reports

Ten named reports from the ticket, served by three flexible endpoints (the same consolidation pattern established in Workstream 85):

- `GET /purchase-order-register` — Purchase Order Register / Open Purchase Orders / Partially Fulfilled Orders / Outstanding Deliveries, via `status`/`open_only`/`outstanding_deliveries_only` query params.
- `GET /delivery-register` — Delivery Register / Late Deliveries, plus Average Fulfilment Time in the summary.
- `GET /supplier-performance` — Average Delivery Time, Average Partial Deliveries, Average Delay, On-Time %, Average Variance, Damage %, Cancelled Orders, grouped by supplier.

## Dashboard

New Enterprise Dashboard section, `dashboardPurchaseOrderSection`: KPIs for Purchase Orders Awaiting Delivery, Partially Fulfilled Orders, Outstanding Deliveries (units), and Late Deliveries, plus a compact Supplier Delivery Performance table — wired into the existing `loadDashboard()` `Promise.all` fetch batch alongside the Workstream 85 Inter-Store Transfers section, with an honest empty state when there is no PO activity yet.

## Audit

13 new `PO_*` events in `posAuditLogger.js`: `PO_CREATED`, `PO_SUBMITTED`, `PO_ACCEPTED`, `PO_REJECTED`, `PO_CANCELLED`, `PO_DELIVERY_CREATED`, `PO_DELIVERY_DISPATCHED`, `PO_DELIVERY_RECEIVED`, `PO_PARTIAL_DELIVERY`, `PO_FINAL_DELIVERY`, `PO_VARIANCE_DETECTED`, `PO_VARIANCE_RESOLVED`, `PO_INVOICE_GENERATED`, `PO_CLOSED`.

## Security

Company isolation is enforced on every route via `req.companyId`, mirroring the existing pattern — a company only ever sees POs where it is `company_id` (customer) or `supplier_company_id` (supplier). No PO, delivery, or invoice data is written to `localStorage`/`sessionStorage` at any point; all business truth is server-authoritative SQL.

## Future Extensibility

The three-object separation (Commercial / Logistics / Financial) and the reused delivery engine were deliberately kept generic enough to support, without redesigning the architecture:

- **Customer sales orders** — same `purchase_orders`-shaped header, with company_id/supplier_company_id roles reversed.
- **Inter-store replenishment** — already proven: `transfer_type = 'inter_store'` (Workstream 85) uses the identical header+items+discrepancies triad.
- **Manufacturing orders / drop shipments** — would introduce new `transfer_type` values and a different stock-adjuster (e.g. consuming raw materials, producing finished goods) while reusing the same dispatch/receive/variance orchestration shape.

```
FOLLOW-UP NOTE
- Area: Purchase Orders against unlinked/manual suppliers
- Dependency: v1 requires suppliers.linked_company_id + an active inter_company_relationships
  row with the purchase_orders permission flag — a supplier with no platform presence cannot
  digitally "accept" an order.
- Confirmed now: Linked-supplier POs work end-to-end (create → submit → accept/reject →
  dispatch → receive → invoice).
- Not yet confirmed: Whether/how a paper-only PO against a manual supplier should work —
  likely by making the existing pos_supplier_receives flow (Workstream 78) the delivery
  backend instead of pos_company_transfers, with a human manually marking deliveries as
  received rather than a counterpart digitally dispatching them.
- Risk if wrong: None currently — v1 does not touch manual-supplier receiving at all.
- Recommended next check: A dedicated workstream if/when manual-supplier POs are requested.
```

```
FOLLOW-UP NOTE
- Area: product_location_stock (Workstream 85) vs company-level products.stock_quantity
  used by this workstream's dispatch/receive
- Dependency: PO deliveries move stock via adjustStockCAS against products.stock_quantity
  (company-level), the same as inter-company transfers — NOT against product_location_stock
  (Workstream 85's location-level stock), since a PO's two parties are different companies,
  not different locations of the same company.
- Confirmed now: This is the correct choice — PO deliveries and inter-store transfers are
  genuinely different stock dimensions (company vs location) and must not be conflated.
- Not yet confirmed: How a company that also uses locations should reconcile a received PO
  delivery landing in company-level stock with which location physically holds it.
- Risk if wrong: A company using both inter-store transfers and purchase orders could see
  received PO stock not reflected at the correct location until a follow-up inter-store
  transfer moves it there manually.
- Recommended next check: Out of scope for this workstream; revisit if/when locations and
  purchase orders are used together in the same company.
```
