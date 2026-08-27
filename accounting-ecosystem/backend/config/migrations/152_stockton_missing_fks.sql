-- =============================================================================
-- Migration 152: Add 21 missing foreign keys across the Inventory (Stockton) module
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: the Stockton full-module breadth audit (2026-08-27, 2 parallel
-- agents covering all 27 backend route/service files) found the same class
-- of bug as the Firmflow audit's 198-missing-FK finding earlier this week —
-- a systematic scan of every `_id`-suffixed column across the 24 inventory-
-- related tables found 21 confirmed-missing FK constraints (verified live,
-- one PGRST200 "no relationship found" probe per relationship, not assumed
-- from reading code). This breaks every PostgREST embed built against these
-- relationships — confirmed live root cause of: the entire warehouse-transfer
-- ship/receive workflow (500s before any stock movement happens), creating
-- or viewing a stock count session, listing/reading reservations, and
-- several warehouse/location-scoped views across the module.
--
-- Fix: add all 21 confirmed-missing FK constraints, generated from live
-- probe results. All use NOT VALID — safe against any pre-existing
-- orphaned/bad data (same pattern as migrations 143/148/150/151). No ON
-- DELETE clause is specified (defaults to NO ACTION) — the same
-- conservative default used for migration 150's 198 FKs.
-- =============================================================================

ALTER TABLE inventory_stock_locations ADD CONSTRAINT inventory_stock_locations_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id) NOT VALID;
ALTER TABLE inventory_stock_locations ADD CONSTRAINT inventory_stock_locations_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) NOT VALID;
ALTER TABLE inventory_stock_locations ADD CONSTRAINT inventory_stock_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES warehouse_locations(id) NOT VALID;

ALTER TABLE stock_valuation_movements ADD CONSTRAINT stock_valuation_movements_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES stock_movements(id) NOT VALID;

ALTER TABLE warehouse_transfer_lines ADD CONSTRAINT warehouse_transfer_lines_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id) NOT VALID;
ALTER TABLE warehouse_transfer_lines ADD CONSTRAINT warehouse_transfer_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id) NOT VALID;
ALTER TABLE warehouse_transfer_lines ADD CONSTRAINT warehouse_transfer_lines_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES warehouse_locations(id) NOT VALID;
ALTER TABLE warehouse_transfer_lines ADD CONSTRAINT warehouse_transfer_lines_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES warehouse_locations(id) NOT VALID;

ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id) NOT VALID;
ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) NOT VALID;
ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_location_id_fkey FOREIGN KEY (location_id) REFERENCES warehouse_locations(id) NOT VALID;

ALTER TABLE warehouse_transfers ADD CONSTRAINT warehouse_transfers_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id) NOT VALID;
ALTER TABLE warehouse_transfers ADD CONSTRAINT warehouse_transfers_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id) NOT VALID;
ALTER TABLE warehouse_transfers ADD CONSTRAINT warehouse_transfers_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES warehouse_locations(id) NOT VALID;
ALTER TABLE warehouse_transfers ADD CONSTRAINT warehouse_transfers_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES warehouse_locations(id) NOT VALID;

ALTER TABLE warehouse_locations ADD CONSTRAINT warehouse_locations_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) NOT VALID;

ALTER TABLE production_batches ADD CONSTRAINT production_batches_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES stock_movements(id) NOT VALID;

ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items(id) NOT VALID;

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES warehouse_locations(id) NOT VALID;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES warehouse_locations(id) NOT VALID;

ALTER TABLE stock_count_sessions ADD CONSTRAINT stock_count_sessions_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) NOT VALID;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT count(*) AS total_fk_constraints_on_inventory_tables
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE c.contype = 'f'
  AND t.relname IN (
    'inventory_stock_locations','stock_valuation_movements','warehouse_transfer_lines',
    'stock_reservations','warehouse_transfers','warehouse_locations','production_batches',
    'stock_count_lines','stock_movements','stock_count_sessions'
  );
