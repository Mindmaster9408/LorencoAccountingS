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

## Final status — all 10 findings fixed

| # | Finding | Fix | Commit |
|---|---|---|---|
| 1 | Missing FK epidemic (21 relationships) | Migration 152 — 21 `ADD CONSTRAINT ... NOT VALID` FKs across `stock_count_lines`, `stock_reservations`, `inventory_stock_locations`, `warehouse_transfers`, `warehouse_transfer_lines`, `warehouse_locations`, `production_batches`, `stock_movements`, `stock_count_sessions`, `stock_valuation_movements` | `8fcf59f` |
| 2 | `stock-counts.js` `/:id/history` 500s | `stock_movements` → `stock_valuation_movements` (real `source_type`/`source_id` columns) | `b93050a` |
| 3 | `atpService.js` future-demand built on nonexistent/wrong columns | `purchase_order_lines` → `purchase_order_items` (real PO-item table), remapped `quantity`/`received_qty` → `quantity_ordered`/`quantity_received` in a post-fetch `.map()`, company scoped via joined `purchase_orders.company_id` | `12648d4` |
| 4 | Sales Order tables never existed | Migration 153 — created `sales_orders`, `sales_order_lines` (generated `line_total` column), `sales_order_status_history`, reverse-engineered from the already-complete `salesOrderService.js`/`routes/sales-orders.js` code. User confirmed: build now. | `0efe044` |
| 5 | `procurementService.js` wrong `reservations` table/columns | `.from('reservations')` → `.from('stock_reservations')` with real netting columns (`quantity_reserved`/`quantity_released`/`quantity_consumed`, `reservation_status`) | `57b93b3` |
| 6 | Broken `.filter('current_stock','lte','min_stock')` idiom (3 places) + `getOperationalDashboard` hangs forever | Replaced with client-side filter after broader fetch in all 3 files (`index.js`, `procurementService.js`, `reportingService.js`); wrapped `getOperationalDashboard` in try/catch via new internal `_getOperationalDashboardInner` | `79ab6bc`, `57b93b3` |
| 7 | `getWorkOrderCostSummary` selects nonexistent `reference_number` | Aliased in `.select()`: `reference_number:wo_number` (no frontend change needed — confirmed frontend already expects `reference_number` key) | `79ab6bc` |
| 8 | `generateShortageRecommendations` wrong `work_order_materials` columns | `quantity_required`/`quantity_issued` → real `required_qty`/`issued_qty` | `57b93b3` |
| 9 | Route-shadowing in `sales-orders.js` | `GET /:id` → `GET /:id(\\d+)`, digit-only constraint, registered before `/demand-dashboard` | `0efe044` |
| 10 | PO-number sequence silently broken | Root cause: `po_number_seq` sequence already existed (migration 055) but the `nextval(seq_name)` RPC PostgREST needs to call it was never created — every PO number has been `Date.now()`, never the real sequence. Migration 154 creates the allowlisted RPC wrapper (`SECURITY DEFINER`, restricted to known sequence names). Route now also logs (rather than silently swallows) `seqErr` if the RPC ever fails, keeping the `Date.now()` fallback only as a visible last resort. | migration 154 + inline fix (this commit) |

**Migrations 152, 153, and 154 have all been run and confirmed by the user
in Supabase (2026-08-27):**
- 152 — verified: 30 total FK constraints across the Stockton tables (up
  21 from the pre-migration baseline).
- 153 — verified: `sales_orders`/`sales_order_lines`/
  `sales_order_status_history` all created with every column exactly as
  designed (including the generated `line_total` column).
- 154 — first run hit `54001: stack depth limit exceeded` (an unqualified
  `nextval('po_number_seq')` call inside the function resolved back to its
  own `text` signature instead of the built-in `nextval(regclass)`,
  recursing forever — fixed by calling `pg_catalog.nextval(seq_name::regclass)`
  directly, schema-qualified). Corrected version confirmed: returns `1000`,
  matching `po_number_seq START 1000`.

All schema-level dependencies for this module's fixes are now live.

## Follow-up note

```
FOLLOW-UP NOTE
- Area: Stockton (Inventory module) — full breadth audit
- Dependency: Migrations 152 (21 FKs), 153 (Sales Order tables), 154
  (po_number_seq RPC) — all confirmed run in Supabase 2026-08-27.
- What was done now: all 10 confirmed findings fixed, committed, and
  pushed; all three dependent migrations run and verified by the user.
- What still needs to be checked: after migrations run, live-verify (a)
  the 21 previously-broken embeds/queries now resolve, (b) full Sales
  Order lifecycle (create → confirm → allocate → fulfill → cancel) works
  end-to-end against real stock in company 51 (Infinite Legacy — TEST),
  (c) a new PO's `po_number` is a real incrementing `LPO-2026-NNNN` value,
  not a timestamp.
- Risk if not checked: Sales Orders and 21 FK-dependent code paths will
  continue failing live in production despite the code fixes being correct,
  because the schema they depend on doesn't exist yet.
- Recommended next review point: immediately after the user confirms all
  three migrations have been run.
```
