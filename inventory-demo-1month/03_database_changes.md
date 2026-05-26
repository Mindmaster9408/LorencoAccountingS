# Database Changes

## Summary

No new inventory costing migration was required for this demo pass. The existing Phase 2A foundation already provides the required tables and cost-tracking fields.

## Existing Database Capabilities Reused

- `inventory_items.average_cost`
- `inventory_items.last_purchase_cost`
- `inventory_items.cost_updated_at`
- `stock_valuation_movements`
- `item_cost_history`
- `work_order_costs`
- `adjust_inventory_stock()` weighted-average RPC

## What The Demo Build Uses

- Quick stock receive updates stock atomically through `adjust_inventory_stock()`.
- Stock valuation uses backend cost records instead of frontend calculations.
- BOM cost summaries read the current component item costs from the database.
- Work order cost summaries read `work_order_costs` and issued component stock from the database.
- Item movement history combines `stock_movements` and `stock_valuation_movements` for forensic traceability.

## Migration Not Added

The requested fallback migration `018_inventory_demo_costing.sql` was not added because the required costing tables and columns already exist in the current schema.

## Demo Safety Notes

- All inventory data remains company-scoped.
- No browser storage was introduced for business data.
- No existing phase 1 stock protection was removed.
