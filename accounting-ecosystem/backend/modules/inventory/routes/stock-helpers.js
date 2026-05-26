/**
 * stock-helpers.js — DEPRECATED
 * ─────────────────────────────────────────────────────────────────────────────
 * This file was a temporary workaround for a column-name bug in the
 * adjust_inventory_stock() PostgreSQL RPC (migration 041 used "type" and
 * "cost_price" instead of "movement_type" and "unit_cost").
 *
 * Migration 050 fixes the RPC. All call sites now use:
 *   stockMutationService.adjustStockTx()
 *
 * This file is kept to produce a clear error if any path still references it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

function adjustStock() {
  throw new Error(
    'adjustStock() is deprecated. Use stockMutationService.adjustStockTx() instead. ' +
    'See inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/03_implementation_report.md'
  );
}

module.exports = { adjustStock };
