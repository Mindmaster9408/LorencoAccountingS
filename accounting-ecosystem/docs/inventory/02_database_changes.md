# Codebox 07 — Database Changes

**Date:** 2026-05-29
**Module:** Storehouse Inventory — Reporting & Dashboard

---

## Summary

**No new database migrations were required for Codebox 07.**

All reporting queries read from tables created by Codeboxes 01–06:

| Table | Created by | Used by report |
|-------|-----------|----------------|
| `inventory_items` | Codebox 01 | Stock valuation, operational dashboard, alerts |
| `stock_movements` | Codebox 01 | Valuation movements |
| `stock_valuation_movements` | Codebox 02 | Valuation movements (forensic ledger) |
| `item_cost_history` | Codebox 02 | Cost history |
| `work_order_costs` | Codebox 02 | Work order cost summary |
| `stock_count_sessions` | Codebox 03 | Stock count report |
| `stock_count_lines` | Codebox 03 | Variance summary |
| `stock_reservations` | Codebox 04 | Reservation report, shortages, overcommitted |
| `purchase_orders` | Codebox 05 | PO report, overdue POs |
| `purchase_receipts` | Codebox 05 | PO report (receipt totals) |
| `suppliers` | Codebox 05 | Supplier history |
| `supplier_item_history` | Codebox 05 | Supplier history report |
| `production_batches` | Codebox 06 | Yield variance, production summary |
| `production_wastage` | Codebox 06 | Wastage log |
| `production_variances` | Codebox 06 | Yield variance |
| `work_orders` | Codebox 02/06 | Operational dashboard, production summary |

---

## No Schema Modifications

The reporting layer is read-only and required no schema changes. All columns referenced in the service functions were part of the Codebox 01–06 migration set.

---

## Notes for Future Work

- `AQ-10` (trend snapshots) in the dashboard roadmap would require a new `dashboard_action_queue_snapshots` table
- If supplier-history report needs per-item filtering at scale, an index on `supplier_item_history(company_id, item_id)` may help
- The `stock_valuation_movements` table grows with every stock movement — a periodic archive or partition strategy may be needed at high volume
