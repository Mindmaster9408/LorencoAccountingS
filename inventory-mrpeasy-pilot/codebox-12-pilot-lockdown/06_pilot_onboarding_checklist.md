# Codebox 12 — Pilot Onboarding Checklist

**For:** First-time pilot companies onboarding to Lorenco Storehouse

---

## Required Steps (must complete before live operation)

### Step 1 — Create at least one warehouse
**Where:** Warehouses tab → Add Warehouse
**Why:** All stock movements require a warehouse location. Without a warehouse, items cannot be received or tracked to a physical location.

### Step 2 — Set a default warehouse
**Where:** Warehouses tab → Edit your main warehouse → Enable "Default"
**Why:** The default warehouse pre-selects on all receiving and movement forms, preventing unassigned stock.

### Step 3 — Add at least one supplier
**Where:** Suppliers tab → Add Supplier
**Why:** Purchase orders and quick-receive require a supplier record. Without suppliers, procurement tracking is impossible.

### Step 4 — Create your inventory items
**Where:** Items tab → Add Item
**Why:** All stock operations require items to exist in the master list first.

### Step 5 — Receive opening stock
**Where:** Items tab → Receive Stock (Quick Receive) or raise a Purchase Order
**Why:** Opening stock establishes the initial on-hand quantity and cost basis (weighted average). Without this, valuation reports will show R0.

---

## Recommended Steps (strongly advised before pilot)

### Step 6 — Configure UOM for purchased items
**Where:** Items tab → UOM button next to each item → Add Conversions
**Why:** If items are purchased in pack sizes (bags, cases, boxes), UOM conversions ensure the correct per-unit cost is used in the weighted average. Without this, costing will be wrong by a factor of the pack size.

**Example:** Flour purchased in 25kg bags → Set base_unit=kg, add conversion bag_25kg=25.

---

## Optional Steps

### Step 7 — Create Bills of Materials
**Where:** BOMs tab → Create BOM
**Why:** If the company manufactures products, BOMs define the recipe. Without BOMs, work orders cannot auto-populate material requirements.

---

## Health Dashboard

The Storehouse dashboard automatically shows:
- **Getting Started** panel when required steps are incomplete
- **Operational Health** panel once setup is done

The Getting Started panel dismisses automatically when all required steps are complete.

---

## API: Check Onboarding Status

```
GET /api/inventory/onboarding
Authorization: Bearer <token>

Response:
{
  "steps": [...],
  "total": 7,
  "complete_count": 3,
  "required_complete": false,
  "ready_for_pilot": false
}
```

When `ready_for_pilot: true`, all required steps are done.
