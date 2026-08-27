# SESSION HANDOFF — 2026-08-27 — Stockton (Inventory module) breadth audit

## What this is

Same methodology as the Accounting (`suppliers.js`) and Firmflow (Practice
module, 198 missing FKs) audits earlier this week, applied to Stockton
(Inventory module) — 27 backend route/service files in
`accounting-ecosystem/backend/modules/inventory/`. Two parallel agents
covered the whole module, cross-referencing every table/column reference
against the live PostgREST schema and live-reproducing every suspected
failure (not just reading code and assuming it's right).

Full per-file findings: `stockton_audit_core_stock.md` and
`stockton_audit_procurement_sales.md` in the scratchpad directory.

## Confirmed bugs

1. **Missing FK epidemic (same class as Firmflow's 198-FK bug).**
   `stock_count_lines.item_id`, `stock_reservations.item_id`,
   `inventory_stock_locations.item_id` → `inventory_items` have no FK;
   `warehouse_transfers` has no FK to `warehouses` (from/to) or to
   `warehouse_transfer_lines`. Breaks, live-confirmed: creating a stock
   count session, viewing/updating one, listing/reading reservations by
   source, warehouse stock/availability views, and — worst — **the entire
   warehouse-transfer ship/receive workflow 500s before any stock movement
   happens** (`shipTransfer`/`receiveTransfer`/`listTransfers`/
   `getTransferById`).
2. **`GET /api/inventory/stock-counts/:id/history` always 500s** —
   queries `stock_movements.source_type`/`source_id`, which don't exist on
   that table (they exist only on `stock_valuation_movements`).
3. **`atpService.js`'s "future demand" half is built against tables that
   don't exist at all** — `sales_order_lines`/`sales_orders` don't exist;
   `purchase_order_lines` has none of the assumed
   `quantity_ordered`/`quantity_received`/`expected_date`/`company_id`/
   `item_id` columns (it's a plain description/amount AP line with no item
   tracking). `getDemandDashboard()` swallows the error silently and
   reports "0 open sales orders" instead of failing — a silently-wrong
   answer, worse than a crash.
4. **The Sales Order feature has never worked at all.**
   `sales_orders`/`sales_order_lines`/`sales_order_status_history` don't
   exist in the database, confirmed via live `PGRST205` "table not found."
   Every endpoint in `routes/sales-orders.js`/`services/salesOrderService.js`,
   plus `reportingService.getOpenSalesOrdersReport`, throws.
5. **`procurementService.js` queries a `reservations` table that doesn't
   exist** — should be `stock_reservations`, and even the assumed column
   names (`quantity`/`status`) don't match the real netting model
   (`quantity_reserved`/`quantity_released`/`quantity_consumed` +
   `reservation_status`) used correctly everywhere else in the module.
6. **A broken PostgREST idiom — `.filter('current_stock', 'lte',
   'min_stock')` — copy-pasted in 3 places** (`index.js`,
   `procurementService.js`, `reportingService.js`). Live-reproduced as a
   `22P02 invalid input syntax` error (PostgREST can't compare two column
   names this way — needs a different filter construction or an RPC).
   Worst case: `reportingService.getOperationalDashboard` has no try/catch
   anywhere in its call chain, and combined with this codebase's Express
   4.18.2 (no automatic catch of rejected async route handlers),
   **`GET /reports/operational-dashboard` hangs indefinitely** instead of
   erroring.
7. **`reportingService.getWorkOrderCostSummary`** selects `reference_number`
   on `work_orders` — doesn't exist (real: `wo_number`). Live `42703` error.
8. **`procurementService.generateShortageRecommendations`** selects
   `quantity_required`/`quantity_issued` on `work_order_materials` — real
   columns are `required_qty`/`issued_qty`. Live `42703` error.
9. **Route-shadowing bug in `routes/sales-orders.js`**: `GET /:id` (line 59)
   registered before `GET /demand-dashboard` (line 121) — same bug class
   found twice in the Practice module audit — makes demand-dashboard
   permanently unreachable (moot until finding #4 is addressed, since the
   underlying tables don't exist yet either).
10. **PO-number sequence silently broken.** The RPC (`nextval`-style)
    generating purchase order numbers doesn't exist; the error is
    swallowed, so every purchase order number has always been a raw
    `Date.now()` timestamp instead of a real sequence.

## Confirmed clean

- **Zero** `req.userId`/`req.user.id`/`req.user?.id` occurrences anywhere
  in the module (all 27 files correctly use `req.user.userId`) — this
  module did not repeat the Practice module's attribution bug.
- No Express route-shadowing bugs found in any route file except #9 above.
- `uomService.js`, `stockMutationService.js`, `costingService.js`,
  `production-batches.js`, `work-orders.js`, `productionService.js`,
  `operationalHealthService.js` all came back fully schema-correct.

## Next step

Fixes in progress now, same order as the Accounting/Firmflow passes:
missing-FK migration first (schema-cache reload already proven unnecessary
— ruled out earlier this week in the same Supabase project), then the
distinct table/column-name code fixes, each live-verified and committed
separately. Sales Orders (#4) is the largest open question — the feature
has apparently never had its tables created at all, which is a bigger
decision (build the tables now vs. treat as a known gap) rather than a
one-line fix.
