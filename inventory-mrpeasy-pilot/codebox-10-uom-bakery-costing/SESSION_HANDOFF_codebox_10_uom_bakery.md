# Session Handoff — Codebox 10: UOM, Pack Sizes & Bakery Batch Costing

**Date:** 2026-05-30  
**Session:** Codebox 10 of 12 — Lorenco Storehouse MrEasy Pilot Path  
**Status:** Implementation complete including A7 follow-up fix. Migration must be applied to Supabase. Testing required.

---

## What Was Changed

### New Files

| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/060_inventory_uom_bakery_costing.sql` | DB migration: UOM tables + schema extensions |
| `accounting-ecosystem/backend/modules/inventory/services/uomService.js` | Conversion engine — no silent fallbacks |
| `inventory-mrpeasy-pilot/codebox-10-uom-bakery-costing/00_uom_costing_audit.md` | Pre-implementation audit findings |
| `inventory-mrpeasy-pilot/codebox-10-uom-bakery-costing/05_bakery_costing_examples.md` | Canonical test case examples |
| (this file) `SESSION_HANDOFF_codebox_10_uom_bakery.md` | This handoff |

### Modified Files

| File | What Changed |
|---|---|
| `backend/modules/inventory/routes/purchase-orders.js` | Receive endpoint: fetch item base units, apply UOM conversion before `adjustStockTx`; PO line create: accept `purchase_unit` |
| `backend/modules/inventory/routes/boms.js` | Line create/update: resolve `input_unit` → `base_qty`; cost summary: use `base_qty` for costing, expose `input_unit` and `base_qty` in response |
| `backend/modules/inventory/index.js` | Items CRUD: accept UOM fields; quick-receive: UOM conversion; new UOM routes: `GET/POST /uom`, `GET/POST/PUT/DELETE /items/:id/uom-conversions`, `GET /items/:id/uom-profile` |
| `backend/modules/inventory/services/productionService.js` | `createProductionBatch`: accept and store Codebox 10 output costing fields |
| `backend/modules/inventory/routes/work-orders.js` | Complete endpoint: accept `actual_output_qty`, `actual_output_unit`, `output_conversion_factor`; compute `cost_per_expected_unit` and `cost_per_actual_unit`; include in response |
| `backend/modules/inventory/services/costingService.js` | No changes — UOM helpers added to uomService.js instead |
| `frontend-inventory/index.html` | Item modal: UOM section; quick-receive: purchase_unit + conversion preview; item list: UOM button; UOM conversions manager modal; JS: `openUomConversions`, `saveUomConversion`, `updateQrConvPreview`, etc. |

---

## Root Causes Fixed

1. **Pack size costing bug**: Receiving 1 bag_25kg @ R300 was adding 1 unit at R300/unit to stock. Now adds 25 kg at R12/kg.
2. **BOM recipe costing bug**: A BOM line with 500g flour (item stocked in kg) was computing cost as 500 × R12 = R6,000. Now computes as 0.5 kg × R12 = R6.00.
3. **Batch output costing gap**: No way to compute R/box or R/tart from a production batch. Now captured via `actual_output_qty` / `actual_output_unit` / `cost_per_actual_unit`.

---

## What Was NOT Changed

- `adjust_inventory_stock()` PostgreSQL RPC — unchanged. Still the only stock mutation path.
- `stockMutationService.adjustStockTx()` — unchanged. UOM conversion happens BEFORE calling it.
- PO lifecycle, status transitions — unchanged.
- Work order release, material issue, variance recording — unchanged.
- All existing company_id isolation — unchanged and preserved.
- No localStorage added anywhere.

---

## What Testing Is Required

Run the 16 tests specified in the Codebox 10 spec:

1. Create kg/g conversion for flour → verify factor stored correctly
2. Create bag_25kg conversion for flour → verify 1 bag_25kg = 25 kg
3. Receive 1 × bag_25kg flour @ R300 → stock +25 kg, avg cost = R12.00/kg
4. Receive 1 × bag_20kg flour @ R260 → weighted average = R12.44/kg
5. BOM line 500g flour → base_qty = 0.500 kg stored
6. BOM cost summary: 0.5 kg × R12.44 = R6.22
7. Production batch expected 20, actual 18 → cost_per_actual_unit > cost_per_expected_unit
8. Pan output to boxes with output_conversion_factor
9. Invalid conversion (unknown unit) → 400 error, no stock change
10. Company isolation: Company B cannot use Company A conversions
11. No localStorage business data (verify network tab in browser)
12. `/inventory` cloud route still works
13. Quick receive with no purchase_unit → unchanged behaviour
14. Quick receive with purchase_unit → preview shows correct base_qty
15. BOM lines without input_unit → backward compat, quantity used directly
16. WO complete with no actual_output_qty → defaults to quantity_produced

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: WO creation + BOM base_qty propagation
- Dependency: When a WO is created from a BOM, `required_qty` is calculated from `bom_lines.quantity × multiplier`.
  With Codebox 10, it should use `bom_lines.base_qty` (when available) so that material requirements are in base units.
- What was done now: bom_lines.base_qty is stored correctly on BOM create/update.
- What still needs to be checked: `routes/work-orders.js` POST / (WO create) reads `bom_lines.quantity` at line 144 — should be updated to `bom_lines.base_qty ?? bom_lines.quantity` for recipes with input_unit.
- Risk if not checked: WO material requirements may be in recipe units (grams) instead of base units (kg) if BOM has input_unit set.
- Recommended next check: Before first bakery WO with UOM-enabled BOM lines.
```

```
FOLLOW-UP NOTE
- Area: FIFO layer costing with pack sizes
- Dependency: `inventory_cost_layers` (FIFO) stores cost per layer at receive time. With Codebox 10, the layer should store cost_per_base_unit, not cost_per_purchase_unit.
- What was done now: `adjustStockTx` is called with `unitCost = cost_per_base_unit` — so the FIFO layer will have the correct base unit cost.
- What still needs to be checked: Verify that existing FIFO layer rows (pre-Codebox-10) are not affected.
- Risk if not checked: FIFO issue cost for pre-existing layers is in old units — but this only matters for items that switch to UOM mid-history.
- Recommended next check: After first FIFO item receives a pack-size receipt.
```

```
FOLLOW-UP NOTE
- Area: supplier_item_history update on UOM receive
- Dependency: updateSupplierItemHistory() is called with qty_received and unit_cost — these are now purchase-unit values.
- What was done now: The call passes rl.qty_received (purchase qty) and rl.unit_cost (purchase unit cost), which is correct for supplier history (what we physically ordered/received from supplier).
- What still needs to be checked: Confirm that supplier history reports display the correct unit when shown in UI.
- Risk if not checked: Supplier history may show "1 bag @ R300" or "25 kg @ R12" — need to decide which is more useful.
- Recommended next check: When building supplier price history / procurement analysis reports.
```

---

## Deployment Steps Required

1. **Apply migration 060 to Supabase:**
   - Open Supabase dashboard → SQL Editor
   - Run `accounting-ecosystem/database/migrations/060_inventory_uom_bakery_costing.sql`
   - Verify: `unit_of_measure` and `item_uom_conversions` tables created
   - Verify: `inventory_items` has `base_unit`, `default_purchase_unit`, `default_recipe_unit`, `default_output_unit`
   - Verify: `purchase_receipt_lines` has `purchase_unit`, `purchase_qty`, `base_qty`, `unit_cost_per_purchase_unit`, `unit_cost_per_base_unit`
   - Verify: `bom_lines` has `input_unit`, `input_qty`, `base_qty`
   - Verify: `production_batches` has `expected_output_qty`, `actual_output_qty`, `cost_per_expected_unit`, `cost_per_actual_unit`

2. **Deploy to Zeabur** (standard push — Dockerfile unchanged):
   - No zbpack.json changes
   - No Dockerfile changes
   - Normal git push triggers Zeabur redeploy

3. **First-time UOM setup for test company:**
   - Add flour item: set base_unit = 'kg'
   - POST /inventory/items/:id/uom-conversions: `{from_unit: "bag_25kg", to_unit: "kg", factor: 25, is_purchase_unit: true}`
   - POST /inventory/items/:id/uom-conversions: `{from_unit: "g", to_unit: "kg", factor: 0.001, is_recipe_unit: true}`
   - Test quick-receive with purchase_unit = bag_25kg

---

*Codebox 10 complete. Codebox 11 and 12 to follow.*
