# Codebox 10 — Pre-Implementation UOM & Costing Audit

**Date:** 2026-05-30  
**Module:** Lorenco Storehouse — backend/modules/inventory  

---

## 1. Current Unit Handling

### inventory_items.unit
- Single free-text field. Default: `'unit'`.
- Used for display only — not enforced for conversion.
- No hierarchy: no base_unit / purchase_unit / recipe_unit concept.
- All stock quantities are implicitly in this one unit.

### purchase_order_items
- `quantity` field: purchase qty in item's unit (no separate purchase_unit).
- `unit_cost`: cost per item unit — not per pack.
- **Gap:** if you buy flour in 25kg bags but stock in kg, the system has no way to track this.

### purchase_receipt_lines
- `qty_received`: same unit assumption as above.
- `unit_cost`: carried from PO line or overridden at receipt.
- **Gap:** `adjustStockTx()` receives `qty_received` directly as the stock delta, so buying 1 bag at R300 inflates stock by 1 (not 25 kg) and sets average cost to R300/unit (not R12/kg).

### bom_lines
- `quantity`: numeric — no unit field.
- Implicit assumption: quantity is in the component item's unit.
- **Gap:** recipe written in grams but item stocked in kg → 500g flour would require qty=500, but item.unit='kg' → costing calculates 500 kg × avg_cost → 100× inflation.

### work_order_materials
- `required_qty`, `issued_qty`: in item's single unit.
- `issue_unit_cost`: frozen at issue time — but assumes 1:1 unit.

### costingService
- `computeWeightedAverage(currentQty, currentAvg, incomingQty, incomingCost)`: pure math, no units.
- `getIssueCostFromItemData(itemData)`: returns average_cost per item unit — no conversion.
- No UOM awareness anywhere.

### productionService / production_batches
- `produced_qty`, `expected_qty`: in item's unit (WO quantity_to_produce unit).
- `unit_cost = total_cost / completed_qty`: per-item unit.
- **Gap:** if the WO is to produce 20 tart shells but output is counted in boxes of 4 → no way to track 5 boxes or compute R/box.

---

## 2. Where Pack Size Is Missing

| Location | Gap |
|---|---|
| `purchase_order_items` | No `purchase_unit` — no pack size on PO lines |
| `purchase_receipt_lines` | No `base_qty` — stock delta is wrong when purchase unit ≠ base unit |
| Quick receive | No `purchase_unit` — all receives assume 1:1 |
| `bom_lines` | No `input_unit` — recipe grams/ml cannot be linked to kg/L items |
| `production_batches` | No `actual_output_qty` in a different unit (e.g. boxes) |
| `item_uom_conversions` | Table does not exist |
| `unit_of_measure` | Table does not exist |

---

## 3. Where Costing Assumes 1 Unit = 1 Stock Unit

| File | Line / Function | Issue |
|---|---|---|
| `routes/purchase-orders.js` receive | `adjustStockTx(delta: qty_received, unitCost: unit_cost)` | delta = purchase qty, not base qty |
| `index.js` quick-receive | `adjustStockTx(delta: qty, unitCost: cost)` | same issue |
| `services/costingService.js` | `computeWeightedAverage` | no units — assumes caller converts correctly (they don't) |
| `routes/boms.js` cost summary | `estimatedCost = line.quantity × unitCost` | quantity may be in g, cost is per kg |
| `routes/work-orders.js` create | `required_qty = bom_line.quantity × multiplier` | in recipe unit, but material issue is in base unit |

---

## 4. Where Recipe Unit Conversion Is Missing

- `bom_lines` has no `input_unit` field.
- Cost summary `GET /boms/:id/cost-summary` multiplies raw `quantity` × `unitCost` — if quantity is in g and cost is per kg, result is off by 1000×.
- Work order creation: `required_qty = line.quantity × multiplier` — same issue propagated to `work_order_materials`.

---

## 5. Bakery Batch Costing Gaps

| Gap | Impact |
|---|---|
| No `actual_output_qty` in different unit | Cannot track "20 tart shells → 5 boxes" |
| No `cost_per_actual_unit` field | Cannot compare budgeted vs actual cost per box/tray |
| No `expected_output_unit` | All output costing is in WO item units only |
| No yield variance per output unit | Cannot say "expected 20 shells, got 18 → R2.50 cost variance per shell" |

---

## 6. Risks to Valuation Accuracy

| Risk | Severity | Mitigation |
|---|---|---|
| R01: Bag receive inflates stock by 1 (not 25) and avg cost to R300 (not R12) | CRITICAL | Codebox 10 base_qty conversion on receive |
| R02: BOM cost 100× wrong (500g flour costs 500 × avg_cost_per_kg) | HIGH | Codebox 10 bom_lines base_qty |
| R03: WO material requirements in wrong unit | MEDIUM | WO creation uses base_qty from BOM lines |
| R04: Production batch cost_per_unit in wrong unit | MEDIUM | New actual_output_qty + cost_per_actual_unit |
| R05: Historical data in wrong units if migrated without re-costing | LOW | New columns nullable — existing rows unaffected |

---

## 7. Planned Implementation

See `01_uom_architecture.md` and `02_database_changes.md`.

Summary:
1. `unit_of_measure` table — company UOM catalogue
2. `item_uom_conversions` table — per-item conversion factors
3. Extend `inventory_items` with base_unit, default_purchase/recipe/output_unit
4. Extend `purchase_order_items`, `purchase_receipt_lines` with purchase_unit, base_qty, unit_cost_per_base_unit
5. Extend `bom_lines` with input_unit, input_qty, base_qty
6. Extend `production_batches` with expected/actual output qty/unit and cost_per_unit
7. `uomService.js` — conversion engine (no silent fallbacks, no 1:1 assumptions)
8. Update receive path: all stock deltas in base units
9. Update BOM cost summary: use base_qty × avg_cost
10. Update WO completion: record actual output qty and cost_per_actual_unit
11. Frontend: item modal UOM fields, quick-receive pack preview, UOM conversion manager
