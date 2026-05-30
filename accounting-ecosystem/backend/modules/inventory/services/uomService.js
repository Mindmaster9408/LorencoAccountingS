'use strict';

/**
 * uomService — Unit of Measure Conversion Engine (Codebox 10)
 *
 * Provides forensic-grade unit conversion for inventory receiving, BOM costing,
 * and bakery batch output costing.
 *
 * Architecture:
 *   - All conversions are item-specific and company-scoped.
 *   - item_uom_conversions stores: 1 <from_unit> = conversion_factor <to_unit>
 *   - The from→to direction is always "purchase/recipe unit → base unit".
 *   - Reverse (base → purchase unit) is computed by dividing.
 *   - No silent 1:1 fallbacks for unknown conversions — unknown conversions throw.
 *   - If from_unit equals to_unit, qty is returned unchanged (no DB lookup needed).
 *
 * Hard rules:
 *   - Never return a conversion result without knowing the factor explicitly.
 *   - Never store UOM data in browser storage.
 *   - company_id is required on every lookup.
 */

/**
 * Resolve an item's effective base unit.
 * Returns base_unit if set, falls back to unit, falls back to 'each'.
 *
 * @param {object} itemRow  Row from inventory_items
 * @returns {string}
 */
function getEffectiveBaseUnit(itemRow) {
  return itemRow?.base_unit || itemRow?.unit || 'each';
}

/**
 * Fetch the conversion factor for a given item from fromUnit → toUnit.
 * Checks the direct direction first, then the reverse.
 *
 * Returns:
 *   { factor: number, direction: 'direct'|'reverse' }
 *
 * Throws if no active conversion is found.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @param {string} fromUnit
 * @param {string} toUnit
 * @returns {Promise<{factor: number, direction: string}>}
 */
async function getConversionFactor(supabase, companyId, itemId, fromUnit, toUnit) {
  if (!fromUnit || !toUnit) {
    throw new Error(`UOM conversion requires both fromUnit and toUnit (got: ${fromUnit} → ${toUnit})`);
  }
  if (fromUnit === toUnit) {
    return { factor: 1, direction: 'identity' };
  }

  const { data: conversions, error } = await supabase
    .from('item_uom_conversions')
    .select('from_unit, to_unit, conversion_factor')
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .eq('is_active', true)
    .in('from_unit', [fromUnit, toUnit])
    .in('to_unit', [fromUnit, toUnit]);

  if (error) throw new Error(`UOM lookup failed: ${error.message}`);

  // Direct: fromUnit → toUnit
  const direct = (conversions || []).find(
    c => c.from_unit === fromUnit && c.to_unit === toUnit
  );
  if (direct) {
    return { factor: parseFloat(direct.conversion_factor), direction: 'direct' };
  }

  // Reverse: toUnit → fromUnit stored, invert factor
  const reverse = (conversions || []).find(
    c => c.from_unit === toUnit && c.to_unit === fromUnit
  );
  if (reverse) {
    const inverted = 1 / parseFloat(reverse.conversion_factor);
    return { factor: inverted, direction: 'reverse' };
  }

  throw new Error(
    `No active UOM conversion found for item ${itemId}: ${fromUnit} → ${toUnit}. ` +
    `Define the conversion in item UOM settings first.`
  );
}

/**
 * Convert a quantity from any unit to the item's base unit.
 *
 * If fromUnit already equals the base unit, returns qty unchanged.
 * Throws if the conversion is not defined.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @param {number} qty
 * @param {string} fromUnit
 * @param {object} itemRow   Optional: row from inventory_items (avoids a second DB call)
 * @returns {Promise<{baseQty: number, factor: number, baseUnit: string}>}
 */
async function convertToBaseUnit(supabase, companyId, itemId, qty, fromUnit, itemRow = null) {
  if (!fromUnit) throw new Error('fromUnit is required for UOM conversion');
  if (typeof qty !== 'number' || isNaN(qty) || qty < 0) {
    throw new Error(`Invalid quantity for UOM conversion: ${qty}`);
  }

  let baseUnit;
  if (itemRow) {
    baseUnit = getEffectiveBaseUnit(itemRow);
  } else {
    const { data: item, error } = await supabase
      .from('inventory_items')
      .select('base_unit, unit')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .single();
    if (error || !item) throw new Error(`Item ${itemId} not found for UOM conversion`);
    baseUnit = getEffectiveBaseUnit(item);
  }

  if (fromUnit === baseUnit) {
    return { baseQty: qty, factor: 1, baseUnit };
  }

  const { factor } = await getConversionFactor(supabase, companyId, itemId, fromUnit, baseUnit);
  const baseQty = Math.round(qty * factor * 10000000) / 10000000;
  return { baseQty, factor, baseUnit };
}

/**
 * Convert a quantity from the item's base unit to a target unit.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @param {number} qty        Quantity in base unit
 * @param {string} targetUnit
 * @param {object} itemRow    Optional: row from inventory_items
 * @returns {Promise<{targetQty: number, factor: number, baseUnit: string}>}
 */
async function convertFromBaseUnit(supabase, companyId, itemId, qty, targetUnit, itemRow = null) {
  if (!targetUnit) throw new Error('targetUnit is required for UOM conversion');

  let baseUnit;
  if (itemRow) {
    baseUnit = getEffectiveBaseUnit(itemRow);
  } else {
    const { data: item, error } = await supabase
      .from('inventory_items')
      .select('base_unit, unit')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .single();
    if (error || !item) throw new Error(`Item ${itemId} not found for UOM conversion`);
    baseUnit = getEffectiveBaseUnit(item);
  }

  if (targetUnit === baseUnit) {
    return { targetQty: qty, factor: 1, baseUnit };
  }

  const { factor } = await getConversionFactor(supabase, companyId, itemId, baseUnit, targetUnit);
  const targetQty = Math.round(qty * factor * 10000000) / 10000000;
  return { targetQty, factor, baseUnit };
}

/**
 * Convert between any two units for an item (not necessarily through base unit).
 * Uses the conversion table; if no direct path exists, tries via base unit.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @param {number} qty
 * @param {string} fromUnit
 * @param {string} toUnit
 * @returns {Promise<{resultQty: number, factor: number}>}
 */
async function convertItemQty(supabase, companyId, itemId, qty, fromUnit, toUnit) {
  if (fromUnit === toUnit) return { resultQty: qty, factor: 1 };

  try {
    const { factor } = await getConversionFactor(supabase, companyId, itemId, fromUnit, toUnit);
    const resultQty = Math.round(qty * factor * 10000000) / 10000000;
    return { resultQty, factor };
  } catch {
    // No direct path — try via base unit (fromUnit → baseUnit → toUnit)
    const { data: item } = await supabase
      .from('inventory_items')
      .select('base_unit, unit')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .single();
    const baseUnit = getEffectiveBaseUnit(item);

    const { factor: f1 } = await getConversionFactor(supabase, companyId, itemId, fromUnit, baseUnit);
    const { factor: f2 } = await getConversionFactor(supabase, companyId, itemId, baseUnit, toUnit);
    const combinedFactor = f1 * f2;
    const resultQty = Math.round(qty * combinedFactor * 10000000) / 10000000;
    return { resultQty, factor: combinedFactor };
  }
}

/**
 * Return the full UOM profile for an item:
 *   - base_unit
 *   - default_purchase_unit
 *   - default_recipe_unit
 *   - default_output_unit
 *   - all active conversions
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {number} itemId
 * @returns {Promise<object>}
 */
async function getItemUomProfile(supabase, companyId, itemId) {
  const [itemRes, convRes] = await Promise.all([
    supabase
      .from('inventory_items')
      .select('id, name, unit, base_unit, default_purchase_unit, default_recipe_unit, default_output_unit')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('item_uom_conversions')
      .select('id, from_unit, to_unit, conversion_factor, conversion_description, is_purchase_unit, is_recipe_unit, is_output_unit, is_active')
      .eq('company_id', companyId)
      .eq('item_id', itemId)
      .order('from_unit')
  ]);

  if (itemRes.error || !itemRes.data) {
    throw new Error(`Item ${itemId} not found`);
  }

  const item = itemRes.data;
  const baseUnit = getEffectiveBaseUnit(item);

  return {
    item_id:               item.id,
    item_name:             item.name,
    base_unit:             baseUnit,
    default_purchase_unit: item.default_purchase_unit || baseUnit,
    default_recipe_unit:   item.default_recipe_unit   || baseUnit,
    default_output_unit:   item.default_output_unit   || baseUnit,
    conversions:           convRes.data || []
  };
}

/**
 * Compute the cost_per_base_unit from a purchase receipt line.
 *
 * If purchaseUnit equals the item's base unit (or no purchaseUnit provided),
 * returns the unitCostPurchase unchanged.
 *
 * Otherwise divides by the conversion factor to get cost per base unit.
 *
 * @param {number} unitCostPurchase  Cost per purchase unit (e.g. R300 per bag_25kg)
 * @param {number} conversionFactor  How many base units in one purchase unit (e.g. 25)
 * @returns {number}
 */
function computeCostPerBaseUnit(unitCostPurchase, conversionFactor) {
  if (!conversionFactor || conversionFactor === 1) return unitCostPurchase;
  if (conversionFactor <= 0) throw new Error('conversionFactor must be > 0');
  return unitCostPurchase / conversionFactor;
}

/**
 * Compute bakery batch output costing.
 *
 * Returns cost_per_expected_unit and cost_per_actual_unit.
 * If actual_output_qty is zero, cost_per_actual_unit is null (no division by zero).
 *
 * @param {number} totalMaterialCost
 * @param {number} expectedOutputQty
 * @param {number} actualOutputQty
 * @returns {{costPerExpected: number|null, costPerActual: number|null, yieldVariancePct: number|null}}
 */
function computeBatchOutputCost(totalMaterialCost, expectedOutputQty, actualOutputQty) {
  const costPerExpected = expectedOutputQty > 0
    ? totalMaterialCost / expectedOutputQty
    : null;

  const costPerActual = actualOutputQty > 0
    ? totalMaterialCost / actualOutputQty
    : null;

  const yieldVariancePct = (expectedOutputQty > 0 && actualOutputQty != null)
    ? ((actualOutputQty - expectedOutputQty) / expectedOutputQty) * 100
    : null;

  return { costPerExpected, costPerActual, yieldVariancePct };
}

module.exports = {
  getEffectiveBaseUnit,
  getConversionFactor,
  convertToBaseUnit,
  convertFromBaseUnit,
  convertItemQty,
  getItemUomProfile,
  computeCostPerBaseUnit,
  computeBatchOutputCost
};
