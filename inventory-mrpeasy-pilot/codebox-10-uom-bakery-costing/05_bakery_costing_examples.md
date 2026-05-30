# Codebox 10 — Bakery Costing Examples

**These are the canonical test cases for verifying Codebox 10 correctness.**

---

## Example 1: Flour — Two Bag Sizes, Correct Weighted Average

### Setup
- Item: Flour
- Base unit: `kg`
- Conversions:
  - `bag_25kg` → `kg`, factor = 25
  - `bag_20kg` → `kg`, factor = 20

### Receipt 1
```
purchase_qty   = 1
purchase_unit  = bag_25kg
unit_cost      = R300 (per bag)
```
Expected results:
```
base_qty = 25 kg
unit_cost_per_base_unit = R300 / 25 = R12.00/kg
stock delta = +25 kg
new average cost = R12.00/kg
```

### Receipt 2 (after Receipt 1)
Previous state: 25 kg @ R12.00/kg
```
purchase_qty   = 1
purchase_unit  = bag_20kg
unit_cost      = R260 (per bag)
```
Expected results:
```
base_qty = 20 kg
unit_cost_per_base_unit = R260 / 20 = R13.00/kg
stock delta = +20 kg
new average cost = (25×12 + 20×13) / (25+20) = (300+260) / 45 = R12.44/kg
```

### Verification
- Total stock: 45 kg ✓
- Average cost: R12.44/kg ✓ (NOT R300 or R260 — no raw bag cost in stock valuation)

---

## Example 2: BOM Recipe in Grams, Item Stocked in kg

### Setup
- Flour item: base_unit = `kg`, average_cost = R12.44/kg
- BOM for "Mini Tart Shell" (batch of 20):
  - Flour: 500 g per batch

### BOM Line Storage
```
input_unit = 'g'
input_qty  = 500
base_qty   = 0.500  (kg)
quantity   = 500
```
Conversion: 1 g → 1/1000 kg (from item_uom_conversions: from_unit=g, to_unit=kg, factor=0.001)

### BOM Cost Summary
```
estimated_cost = 0.500 kg × R12.44/kg = R6.22 per batch (20 tart shells)
estimated_cost_per_unit = R6.22 / 20 = R0.311 per tart shell
```

**Without UOM (old behaviour):**
```
estimated_cost = 500 (raw qty) × R12.44/kg = R6,220 per batch → 1000× wrong
```

---

## Example 3: Production Batch — Expected vs Actual Yield

### Setup
- Work Order: produce 20 tart shells
- Total material cost: R45.00

### Complete with actual output
```json
POST /work-orders/:id/complete
{
  "quantity_produced": 18,
  "actual_output_qty": 18,
  "actual_output_unit": "tart_shell",
  "wastage_qty": 2,
  "wastage_reason": "trimming_loss"
}
```

### Stored in production_batches
```
expected_qty             = 20
produced_qty             = 18
expected_output_qty      = 20
actual_output_qty        = 18
cost_per_expected_unit   = R45.00 / 20 = R2.25 per expected shell
cost_per_actual_unit     = R45.00 / 18 = R2.50 per actual shell
yield_percent            = 18/20 × 100 = 90%
```

### Meaning
The planned cost was R2.25/shell. Actual yield loss pushed the real cost to R2.50/shell.
The R0.25 variance per shell (R4.50 total) is the cost of the 2 trimming-loss shells.

---

## Example 4: Pan Output → Boxes (Multi-Unit Output)

### Setup
- Work Order: produce 1 pan = 12 boxes of mini tarts
- WO item unit: `pan`
- Output counted in: `box`
- Conversion: 1 pan = 12 boxes (output_conversion_factor = 12)
- Total material cost: R240.00

### Complete
```json
POST /work-orders/:id/complete
{
  "quantity_produced": 1,
  "actual_output_qty": 11,
  "actual_output_unit": "box",
  "output_conversion_factor": 12
}
```

### Stored
```
expected_output_qty      = 1 (pan = WO qty)
actual_output_qty        = 11 boxes
output_conversion_factor = 12
cost_per_expected_unit   = R240 / 1 pan = R240/pan
cost_per_actual_unit     = R240 / 11 boxes = R21.82/box
```

### Meaning
Expected: 12 boxes × R20/box = R240. Actual: 11 boxes × R21.82/box = R240. Same total, different per-unit cost due to yield shortfall.

---

## Example 5: Company Isolation Verification

Company A sets up flour conversions: 1 bag_25kg = 25 kg.
Company B has no flour conversions.

- Company B receives 1 bag_25kg of flour:
  - System looks up conversions for Company B, item flour → none found
  - System returns error: "No active UOM conversion found for item X: bag_25kg → kg. Define the conversion in item UOM settings first."
  - Stock is NOT mutated — no silent 1:1 fallback.
  - Company B must set up their own conversion before using bag_25kg as a purchase unit.

This is the correct behaviour. Company A's conversions are never used for Company B.

---

## Example 6: No Conversion Defined — Graceful Rejection

```
POST /quick-receive
{
  item_id: 42,
  purchase_unit: "bag_25kg",
  quantity: 1,
  unit_cost: 300
}
```
Item 42 has base_unit = kg but NO conversion for bag_25kg.

Response:
```json
400 Bad Request
{
  "error": "UOM conversion failed: No active UOM conversion found for item 42: bag_25kg → kg. Define the conversion in item UOM settings first."
}
```

Stock is NOT mutated. The caller must first add the conversion via:
```
POST /items/42/uom-conversions
{
  "from_unit": "bag_25kg",
  "to_unit": "kg",
  "conversion_factor": 25,
  "is_purchase_unit": true
}
```
Then retry the receive.
