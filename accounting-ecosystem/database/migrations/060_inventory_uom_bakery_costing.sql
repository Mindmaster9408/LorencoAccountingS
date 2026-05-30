-- ============================================================================
-- Migration 060: UOM, Pack Sizes & Bakery Batch Costing (Codebox 10)
-- Date: 2026-05-30
-- ============================================================================
-- Purpose:
--   Adds forensic-grade Unit of Measure (UOM) infrastructure to Lorenco
--   Storehouse. Enables purchase receiving in pack units with automatic
--   base-unit conversion, BOM/recipe lines entered in recipe units, and
--   bakery batch output costing (expected vs actual yield, cost per unit).
--
-- Architecture principles:
--   - base_unit on inventory_items = the canonical stock unit (source of truth)
--   - item_uom_conversions = per-item conversion factors (e.g. 1 bag = 25 kg)
--   - purchase_receipt_lines stores BOTH purchase qty/cost AND base qty/cost
--   - bom_lines stores BOTH input qty/unit AND base qty (for costing)
--   - production_batches stores expected vs actual output with cost_per_unit
--
-- Safety rules:
--   - All new columns: ADD COLUMN IF NOT EXISTS
--   - All new tables:  CREATE TABLE IF NOT EXISTS
--   - All new indexes: CREATE INDEX IF NOT EXISTS
--   - No existing data is modified.
--   - No existing columns are renamed or removed.
--   - Safe to re-run on a database that already has partial state.
-- ============================================================================

-- ─── A. unit_of_measure ──────────────────────────────────────────────────────
-- Company-scoped catalogue of units. Examples:
--   kg, g, L, ml, each, box, tray, pan, bag_25kg, bag_20kg
--
-- unit_type classifies the physical dimension:
--   weight, volume, count, package, production_output

CREATE TABLE IF NOT EXISTS unit_of_measure (
  id             BIGSERIAL    PRIMARY KEY,
  company_id     BIGINT       NOT NULL,
  unit_code      TEXT         NOT NULL,
  unit_name      TEXT         NOT NULL,
  unit_type      TEXT         NOT NULL DEFAULT 'count'
                   CHECK (unit_type IN ('weight','volume','count','package','production_output')),
  base_dimension TEXT,
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uom_company_code_unique UNIQUE (company_id, unit_code)
);

CREATE INDEX IF NOT EXISTS uom_company_idx ON unit_of_measure (company_id);

-- ─── B. item_uom_conversions ─────────────────────────────────────────────────
-- Item-specific conversion factors. Every row says:
--   "1 <from_unit> = conversion_factor <to_unit>"
--
-- Examples (for Flour item):
--   from_unit=bag_25kg,  to_unit=kg,  factor=25   → 1 bag_25kg = 25 kg
--   from_unit=bag_20kg,  to_unit=kg,  factor=20   → 1 bag_20kg = 20 kg
--
-- The from→to direction is always "purchase/recipe unit → base unit".
-- Reverse conversion (base → purchase) is derived by dividing.
--
-- is_purchase_unit: this from_unit is used when ordering/receiving
-- is_recipe_unit:   this from_unit is used in BOM lines
-- is_output_unit:   this from_unit is used for production output counting
--
-- CONSTRAINT: conversion_factor must be > 0 (no zero or negative factors).
-- CONSTRAINT: unique per (company, item, from_unit, to_unit).

CREATE TABLE IF NOT EXISTS item_uom_conversions (
  id                     BIGSERIAL     PRIMARY KEY,
  company_id             BIGINT        NOT NULL,
  item_id                BIGINT        NOT NULL,
  from_unit              TEXT          NOT NULL,
  to_unit                TEXT          NOT NULL,
  conversion_factor      NUMERIC(20,8) NOT NULL,
  conversion_description TEXT,
  is_purchase_unit       BOOLEAN       NOT NULL DEFAULT false,
  is_recipe_unit         BOOLEAN       NOT NULL DEFAULT false,
  is_output_unit         BOOLEAN       NOT NULL DEFAULT false,
  is_active              BOOLEAN       NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT iuc_company_item_from_to_unique
    UNIQUE (company_id, item_id, from_unit, to_unit),
  CONSTRAINT iuc_conversion_factor_positive
    CHECK (conversion_factor > 0)
);

CREATE INDEX IF NOT EXISTS iuc_item_idx    ON item_uom_conversions (company_id, item_id);
CREATE INDEX IF NOT EXISTS iuc_company_idx ON item_uom_conversions (company_id);

-- ─── C. inventory_items extensions ───────────────────────────────────────────
-- base_unit: the canonical unit all stock quantities are expressed in.
--   When null, falls back to the existing 'unit' field for backward compat.
-- default_purchase_unit: the unit typically used when raising POs/quick receive.
-- default_recipe_unit:   the unit typically used in BOM ingredient lines.
-- default_output_unit:   the unit used to count production output (e.g. boxes).

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS base_unit             TEXT,
  ADD COLUMN IF NOT EXISTS default_purchase_unit TEXT,
  ADD COLUMN IF NOT EXISTS default_recipe_unit   TEXT,
  ADD COLUMN IF NOT EXISTS default_output_unit   TEXT;

-- ─── D. purchase_order_items extensions ──────────────────────────────────────
-- purchase_unit: the unit in which this PO line is ordered.
--   When null, falls back to item's base_unit/unit for backward compat.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS purchase_unit TEXT;

-- ─── E. purchase_receipt_lines extensions ────────────────────────────────────
-- Receiving must store BOTH the purchase-unit record (forensic — what was
-- physically delivered) AND the base-unit record (what went into stock).
--
-- purchase_unit:               unit as received from supplier (e.g. bag_25kg)
-- purchase_qty:                qty in purchase_unit (e.g. 2 bags)
-- base_qty:                    qty converted to item base_unit (e.g. 50 kg)
-- unit_cost_per_purchase_unit: cost the supplier charged per purchase_unit (e.g. R300/bag)
-- unit_cost_per_base_unit:     cost per base_unit used for weighted average (e.g. R12/kg)
--
-- When no UOM conversion applies, purchase_qty = qty_received and
-- unit_cost_per_base_unit = unit_cost (backward compatible).

ALTER TABLE purchase_receipt_lines
  ADD COLUMN IF NOT EXISTS purchase_unit               TEXT,
  ADD COLUMN IF NOT EXISTS purchase_qty                NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS base_qty                    NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS unit_cost_per_purchase_unit NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS unit_cost_per_base_unit     NUMERIC(20,8);

-- ─── F. bom_lines extensions ─────────────────────────────────────────────────
-- BOM recipes may be written in a different unit than the item's base_unit.
-- Example: recipe calls for flour 500g, but flour is stocked in kg.
--
-- input_unit: the unit the recipe ingredient is expressed in (e.g. 'g')
-- input_qty:  the recipe quantity in input_unit (e.g. 500)
-- base_qty:   quantity converted to item base_unit (e.g. 0.5 kg)
--
-- When input_unit is null, the existing 'quantity' field is in base_unit.
-- Cost summary always uses base_qty (when available) × item average_cost.

ALTER TABLE bom_lines
  ADD COLUMN IF NOT EXISTS input_unit TEXT,
  ADD COLUMN IF NOT EXISTS input_qty  NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS base_qty   NUMERIC(15,4);

-- ─── G. production_batches extensions ────────────────────────────────────────
-- Bakery/manufacturing batches may produce output in a different unit than
-- the work order's quantity_to_produce, and actual yield may differ from
-- expected yield. Cost per output unit is recalculated from actual yield.
--
-- expected_output_qty:   how many units were planned (from WO quantity_to_produce)
-- expected_output_unit:  the unit for expected output (e.g. 'tart_shell', 'box')
-- actual_output_qty:     how many units were actually produced (may differ)
-- actual_output_unit:    the unit for actual output
-- output_conversion_factor: multiplier if output_unit differs from WO item unit
--                          (e.g. WO is in 'each', output counted in 'boxes of 20' → factor=20)
-- cost_per_expected_unit: total_material_cost / expected_output_qty
-- cost_per_actual_unit:   total_material_cost / actual_output_qty (the true cost)

ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS expected_output_qty      NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS expected_output_unit     TEXT,
  ADD COLUMN IF NOT EXISTS actual_output_qty        NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS actual_output_unit       TEXT,
  ADD COLUMN IF NOT EXISTS output_conversion_factor NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS cost_per_expected_unit   NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS cost_per_actual_unit     NUMERIC(20,8);

-- ─── End of migration 060 ─────────────────────────────────────────────────────
