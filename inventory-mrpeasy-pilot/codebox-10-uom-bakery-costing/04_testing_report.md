# Codebox 10 — Testing Report

**Date:** 2026-05-30  
**Status:** Tests specified; must be run against cloud app after migration 060 applied.

---

## Test Setup

Migration 060 must be applied to Supabase before running these tests.

Create a test company. Add a Flour item:
- Set `base_unit = 'kg'`
- Add conversion: `bag_25kg → kg, factor = 25, is_purchase_unit = true`
- Add conversion: `bag_20kg → kg, factor = 20, is_purchase_unit = true`
- Add conversion: `g → kg, factor = 0.001, is_recipe_unit = true`

---

## Test 1 — Create kg/g conversion

```
POST /api/inventory/items/:id/uom-conversions
{ from_unit: "g", to_unit: "kg", conversion_factor: 0.001, is_recipe_unit: true }
```
**Expected:** 201 Created, conversion stored with factor = 0.001

---

## Test 2 — Create bag_25kg conversion

```
POST /api/inventory/items/:id/uom-conversions
{ from_unit: "bag_25kg", to_unit: "kg", conversion_factor: 25, is_purchase_unit: true }
```
**Expected:** 201 Created, factor = 25

---

## Test 3 — Receive 1 × bag_25kg @ R300

```
POST /api/inventory/quick-receive
{ item_id: X, supplier_id: Y, quantity: 1, unit_cost: 300, purchase_unit: "bag_25kg", reference: "TEST-1" }
```
**Expected:**
- `base_qty = 25` (not 1)
- `unit_cost_per_base = 12` (not 300)
- `new_stock` increases by 25 kg
- `new_avg_cost ≈ 12.00`

---

## Test 4 — Receive 1 × bag_20kg @ R260, verify weighted average

```
POST /api/inventory/quick-receive
{ item_id: X, supplier_id: Y, quantity: 1, unit_cost: 260, purchase_unit: "bag_20kg", reference: "TEST-2" }
```
**Expected:**
- `base_qty = 20`
- `unit_cost_per_base = 13`
- `new_stock` increases by 20 → total 45 kg
- `new_avg_cost ≈ 12.44` [(25×12 + 20×13)/45]

---

## Test 5 — BOM line 500g flour converts to 0.5kg

```
POST /api/inventory/boms
{
  item_id: <tart_item>,
  name: "Mini Tart BOM",
  output_qty: 20,
  lines: [{ item_id: <flour>, quantity: 500, input_unit: "g" }]
}
```
**Expected:** BOM line stored with `input_qty = 500`, `input_unit = "g"`, `base_qty = 0.5`

---

## Test 6 — BOM cost summary correct

```
GET /api/inventory/boms/:id/cost-summary
```
**Expected:** Line estimated_cost = 0.5 kg × R12.44 = R6.22 (not 500 × R12.44 = R6,220)

---

## Test 7 — WO creation uses base_qty for required_qty

Create WO for 20 tart shells using the BOM from Test 5 (output_qty=20):
```
POST /api/inventory/work-orders
{ item_id: <tart>, bom_id: X, quantity_to_produce: 20 }
```
**Expected:** `work_order_materials.required_qty = 0.5 kg` (not 500 g)

---

## Test 8 — WO quantity scaling works

Create WO for 40 tart shells (2× the BOM output_qty of 20):
```
POST /api/inventory/work-orders
{ quantity_to_produce: 40 }
```
**Expected:** `required_qty = 1.0 kg` (0.5 × [40/20] = 1.0)

---

## Test 9 — Scrap % still applies after base_qty

BOM line with 500g flour, 10% scrap:
```
lines: [{ item_id: flour, quantity: 500, input_unit: "g", scrap_percent: 10 }]
```
WO for 20 tarts (output_qty=20):
**Expected:** `required_qty = 0.5 × 1 × 1.10 = 0.55 kg`

---

## Test 10 — Backward compat: non-UOM BOM line unchanged

BOM line with no input_unit:
```
lines: [{ item_id: X, quantity: 100, scrap_percent: 0 }]
```
WO for 1× output:
**Expected:** `required_qty = 100` (quantity used directly — no conversion)

---

## Test 11 — Production batch expected 20, actual 18

Complete a WO with:
```
{ quantity_produced: 18, actual_output_qty: 18, actual_output_unit: "tart_shell" }
```
**Expected in production_batches:**
- `produced_qty = 18`
- `yield_percent ≈ 90`
- `cost_per_expected_unit = total_cost / 20`
- `cost_per_actual_unit = total_cost / 18` (higher)

---

## Test 12 — Pan output to boxes

Complete a WO (quantity_to_produce=1 pan) with:
```
{ quantity_produced: 1, actual_output_qty: 11, actual_output_unit: "box", output_conversion_factor: 12 }
```
**Expected:**
- `actual_output_qty = 11`
- `expected_output_qty = 1`
- `cost_per_actual_unit = total_cost / 11`

---

## Test 13 — Invalid conversion rejected

```
POST /api/inventory/quick-receive
{ purchase_unit: "unknown_unit", ... }
```
**Expected:** 400 error mentioning "No active UOM conversion found". Stock NOT mutated.

---

## Test 14 — Company isolation preserved

Company B tries to use Company A's item_id or uom-conversions → 404 or empty results. All queries enforce `.eq('company_id', companyId)`.

---

## Test 15 — No localStorage business data

Open browser dev tools → Application → Local Storage. After receiving stock, creating BOM, running WO: no UOM data, no conversion data, no stock data stored in localStorage. Only session token permitted.

---

## Test 16 — /inventory cloud route still works

Navigate to `https://lorenco.zeabur.app/inventory`. Verify items load, dashboard loads, movements load. No JS console errors. No 500 responses from the UOM routes when no conversions exist (should return empty arrays).

---

## A7 Specific Tests

**A7-1:** BOM with `input_unit = 'g'`, `base_qty = 0.5`. WO quantity_to_produce = 20, BOM output_qty = 20. `required_qty = 0.5` ✓

**A7-2:** BOM with `base_qty = null` (legacy). WO creation. `required_qty = quantity × multiplier` ✓ (unchanged)

**A7-3:** BOM with `base_qty = 0.5`, scrap 10%, multiplier 2. `required_qty = 0.5 × 2 × 1.10 = 1.10` ✓
