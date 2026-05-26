# Codebox 02 — Costing Architecture

**Date:** May 2026  
**Status:** Production-ready after Codebox 02

---

## 1. Costing Model Overview

The Lorenco Storehouse uses **weighted average cost** as its standard costing method.

Every item has a `costing_method` column. Supported values:

| Method | Value | Cost Used For Issue |
|---|---|---|
| Weighted Average | `average` | `average_cost` from inventory_items |
| FIFO | `fifo` | `average_cost` proxy (FIFO consumption deferred to Codebox 05+) |
| Standard Cost | `standard` | `standard_cost` from inventory_items |
| Last Purchase Cost | `last_cost` | `last_purchase_cost` from inventory_items |

Default: `average`.

**FIFO note:** FIFO cost layers are recorded in `inventory_cost_layers` on every receipt. The layer consumption algorithm (FIFO issue matching) is intentionally deferred to Codebox 05+. Until then, FIFO-method items use `average_cost` as a proxy. This is documented in the risk register (R08).

---

## 2. Single Stock Mutation Path

**All stock changes must flow through one path:**

```
Application code
    ↓
stockMutationService.adjustStockTx()
    ↓
adjust_inventory_stock() PostgreSQL RPC (atomic)
    ↓
  ┌────────────────────────────────┐
  │ 1. SELECT ... FOR UPDATE       │  ← row lock
  │ 2. Validate stock (no negatives)│
  │ 3. Compute weighted average    │
  │ 4. UPDATE inventory_items      │
  │ 5. INSERT stock_movements      │
  │ 6. INSERT stock_valuation_     │
  │    movements (with before/after│
  │    values from Codebox 02)     │
  │ 7. INSERT inventory_cost_layers│
  │    (stock-in with cost only)   │
  │ 8. INSERT item_cost_history    │
  │    (only when avg changes)     │
  └────────────────────────────────┘
```

No other path is permitted. `recordValuationMovement()` in costingService throws an error if any caller attempts to bypass this.

---

## 3. Weighted Average Formula

When stock is received with a known cost:

$$\text{new\_avg} = \frac{(\text{old\_qty} \times \text{old\_avg}) + (\text{in\_qty} \times \text{in\_cost})}{\text{old\_qty} + \text{in\_qty}}$$

Edge case: if `old_qty <= 0`, the new avg = `in_cost` (reset, no division by zero).

Stored as NUMERIC, rounded to 6 decimal places in the RPC.

---

## 4. Valuation Ledger (stock_valuation_movements)

The ledger is an immutable append-only forensic record. Every stock event produces exactly one row.

**From Codebox 02**, each row contains:

| Column | Purpose |
|---|---|
| `previous_average_cost` | Weighted average BEFORE this event |
| `previous_stock` | On-hand quantity BEFORE this event |
| `running_avg_cost` | Weighted average AFTER this event |
| `running_qty` | On-hand quantity AFTER this event |
| `unit_cost` | Cost per unit for this movement |
| `total_cost` | `qty × unit_cost` |
| `source_type` | Origin: `po_receive`, `wo_issue`, `wo_complete`, `manual`, etc. |
| `source_id` | ID of the originating document |

**Before Codebox 02:** `previous_average_cost` and `previous_stock` columns did not exist. Rows inserted before migration 051 will have NULL in these columns. After 051, all new rows are fully self-describing.

---

## 5. Cost Sources Per Event Type

| Event | Movement Type | Unit Cost Source |
|---|---|---|
| PO Receive | `in` | `unit_price` from PO line |
| Quick Receive | `in` | `unit_cost` from request body |
| WO Issue | `out` | Item's `costing_method` dispatch (via `getIssueCostFromItemData`) |
| WO Complete | `in` | `unit_cost` from finalized `work_order_costs` |
| Manual Adjustment IN | `adjustment_in` | `cost_price` from request (optional) |
| Manual Adjustment OUT | `adjustment_out` | Current `average_cost` |

---

## 6. Work Order Costing Flow

```
POST /work-orders/:id/issue-materials
    ↓ for each material:
    getIssueCostFromItemData(itemRow)   ← costing_method dispatch
    adjustStockTx(delta: -qty, unitCost: issueCost)
    work_order_materials.issue_unit_cost = issueCost   ← frozen (Codebox 02)
    accumulateWorkOrderMaterialCost(qty × issueCost)   → work_order_costs.material_cost

POST /work-orders/:id/complete
    ↓
    finalizeWorkOrderCost()
      → unitCost = (material + labor + overhead) / completedQty
      → work_order_costs.status = 'finalized'
      → work_order_costs.unit_cost = unitCost
    adjustStockTx(delta: +completedQty, unitCost: unitCost)
      → finished good's average_cost updated
```

**Why `issue_unit_cost` on `work_order_materials`?**  
The accumulated total in `work_order_costs.material_cost` is authoritative, but it's a single number. The per-component breakdown in the cost summary shows what each component contributed. Without `issue_unit_cost`, if a component's `average_cost` changes between issue and WO completion, the breakdown shows wrong figures. `issue_unit_cost` freezes the per-component reference at issue time.

---

## 7. getIssueCostFromItemData() — Centralized Dispatch

**File:** `costingService.js`  
**Purpose:** Single place where `costing_method` → cost value is resolved.

```javascript
// Usage:
const { issueCost, costingMethod, source } = getIssueCostFromItemData(itemData);
```

All routes that need a "what is this item worth to issue" value must call this function instead of writing their own fallback chain.

**Before Codebox 02:** Three separate inline fallback chains existed in `boms.js`, `work-orders.js`, and `costingService.js`. These are now all centralized.

---

## 8. Accounting Integration Prep Fields

Added to `inventory_items` in migration 051 (nullable, not yet used):

| Column | GL Role |
|---|---|
| `inventory_asset_account_id` | Asset account credited on stock issue / debited on receipt |
| `cogs_account_id` | COGS account debited when material is issued to production or sale |
| `wip_account_id` | WIP account debited during active work orders |

These fields are intentionally wired up in a future Codebox. No GL posting logic exists in Codebox 02. This architecture note documents the intended integration shape.
