# Codebox 10 — Implementation Report

**Date:** 2026-05-30  
**Status:** Complete including A7 follow-up fix

---

## Files Changed

### New Files
| File | Purpose |
|---|---|
| `database/migrations/060_inventory_uom_bakery_costing.sql` | Creates `unit_of_measure`, `item_uom_conversions`; extends `inventory_items`, `purchase_order_items`, `purchase_receipt_lines`, `bom_lines`, `production_batches` |
| `backend/modules/inventory/services/uomService.js` | Conversion engine: `convertToBaseUnit`, `convertFromBaseUnit`, `convertItemQty`, `getItemUomProfile`, `computeCostPerBaseUnit`, `computeBatchOutputCost` |

### Modified Files
| File | Change |
|---|---|
| `backend/modules/inventory/routes/purchase-orders.js` | PO receive: fetches item base units, applies UOM conversion before `adjustStockTx`; stock delta always in base units; receipt lines store both purchase and base qty/cost. PO create: accepts `purchase_unit` on lines. |
| `backend/modules/inventory/routes/boms.js` | Line create/update: `resolveBomLineBaseQty` converts `input_unit` → `base_qty` before saving. Cost summary: uses `base_qty ?? quantity` for costing. |
| `backend/modules/inventory/routes/work-orders.js` | WO create: SELECT now includes `base_qty, input_unit`; material `required_qty` uses `effectiveQty = base_qty ?? quantity` (A7 fix). Complete endpoint: accepts `actual_output_qty`, `actual_output_unit`, `output_conversion_factor`; computes and stores `cost_per_expected_unit` and `cost_per_actual_unit`. |
| `backend/modules/inventory/index.js` | Items POST/PUT: accept `base_unit`, `default_purchase_unit`, `default_recipe_unit`, `default_output_unit`. Quick-receive: UOM conversion support. New routes: `GET/POST /uom`, `PUT /uom/:id`, `GET /items/:id/uom-profile`, `GET/POST/PUT/DELETE /items/:id/uom-conversions`. |
| `backend/modules/inventory/services/productionService.js` | `createProductionBatch`: stores `expected_output_qty`, `actual_output_qty`, `cost_per_expected_unit`, `cost_per_actual_unit`, `output_conversion_factor`. |
| `frontend-inventory/index.html` | Item modal: UOM section (base_unit, default units). Quick-receive: purchase_unit field + real-time base_qty/cost preview. Item list: UOM button. UOM conversions manager modal. JS: `openUomConversions`, `saveUomConversion`, `deactivateUomConv`, `updateQrConvPreview`, `onQuickReceiveItemChange`. |

---

## Core Logic Changes

### 1. Receive Path (purchase-orders.js + index.js quick-receive)
**Before:** `adjustStockTx(delta: qty_received, unitCost: unit_cost)` — always wrong for pack sizes  
**After:**
```
effectiveBaseUnit = item.base_unit || item.unit
if purchase_unit != effectiveBaseUnit:
  baseQty = convertToBaseUnit(qty, purchase_unit)
  costPerBase = unit_cost / conversionFactor
else:
  baseQty = qty
  costPerBase = unit_cost
adjustStockTx(delta: baseQty, unitCost: costPerBase)
```
Receipt line stores both: `qty_received`/`unit_cost` (purchase forensic) + `base_qty`/`unit_cost_per_base_unit` (valuation truth).

### 2. BOM Line (boms.js)
**Before:** `quantity` stored raw; cost summary = `quantity × unitCost`  
**After:** `input_unit` + `input_qty` stored; `base_qty = convertToBaseUnit(qty, input_unit)` stored; cost summary = `base_qty × unitCost`. Falls back to `quantity` if no `input_unit`.

### 3. WO Material Requirements (work-orders.js) — A7 Fix
**Before:** `required_qty = l.quantity × multiplier × (1 + scrap/100)`  
**After:** `effectiveQty = l.base_qty ?? l.quantity; required_qty = effectiveQty × multiplier × (1 + scrap/100)`  
Backward compatible: existing BOM lines with `base_qty = null` use `quantity` unchanged.

### 4. Batch Output Costing (work-orders.js + productionService.js)
**Before:** Only `unit_cost = total_cost / produced_qty`  
**After:** Also stores `cost_per_expected_unit = total_cost / expected_output_qty` and `cost_per_actual_unit = total_cost / actual_output_qty`. `actual_output_qty` can be in a different unit than WO qty (e.g. boxes vs shells).

---

## Hard Rules Preserved
- `adjustStockTx()` remains the only stock mutation path — unchanged
- No localStorage business data — none added
- company_id on every query — all new routes include company_id checks
- No valuation engine changes
- No Zeabur/Dockerfile changes
