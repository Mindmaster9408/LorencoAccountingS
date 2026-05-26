# Codebox 02 — Implementation Report

**Date:** May 2026  
**Status:** Complete — awaiting migration 051 deployment

---

## Files Changed

### 1. `accounting-ecosystem/database/migrations/051_inventory_costing_finalization.sql` (NEW)

**What:** Full migration SQL for all Codebox 02 database changes.  
**Why:** Formalizes the database hardening required for forensic-grade costing.  
**Contains:** 7 steps — constraint expansion, non-negative guards, valuation ledger before/after columns, RPC update, issue_unit_cost column, accounting prep fields, performance indexes.  
**Risk:** Additive only (all ADD COLUMN IF NOT EXISTS, all CREATE OR REPLACE). Low risk.

---

### 2. `accounting-ecosystem/backend/modules/inventory/services/costingService.js` (MODIFIED)

**Root cause addressed:** Duplicate cost fallback chains existed independently in `boms.js`, `work-orders.js`, and `costingService.js`. Any change to fallback logic required updating three files.

**Changes:**

**Added import:**
```javascript
const { adjustStockTx } = require('./stockMutationService');
```
No circular dependency — `stockMutationService` does not import `costingService`.

**New function: `getIssueCostFromItemData(itemData)`**  
- Pure function (no DB call)  
- Takes an already-fetched item row  
- Dispatches by `costing_method`: average → `average_cost`; standard → `standard_cost`; last_cost → `last_purchase_cost`; fifo → `average_cost` proxy  
- Falls back to `cost_price` (legacy field) if primary method yields null/zero  
- Returns `{ issueCost, costingMethod, source }` for traceability

**New function: `getItemIssueCost(supabase, companyId, itemId)`**  
- Async version of the above — fetches the item then calls `getIssueCostFromItemData`  
- Used by callers that don't already have the item row

**New function: `recordValuationMovement()`**  
- Guard function that throws unconditionally  
- Prevents any future attempt to directly insert into `stock_valuation_movements`  
- Message explicitly directs callers to `adjustStockTx`

**New function: `updateAverageCostAfterReceipt(supabase, params)`**  
- Validated wrapper around `adjustStockTx` for stock-in events  
- Enforces: `receivedQty > 0`, `receivedUnitCost != null`, `receivedUnitCost >= 0`  
- Passes null rejection (must explicitly pass 0 for zero-cost receives — prevents accidental null costing)

**New function: `calculateWorkOrderCost(supabase, companyId, workOrderId)`**  
- Reporting function — reads accumulated totals from `work_order_costs`  
- Per-component breakdown uses `issue_unit_cost` (frozen) where available, falls back to current cost  
- Returns `cost_basis` per component: `'frozen_at_issue'` or `'current_estimate'`

**Updated: `module.exports`**  
All 5 new functions added to exports.

---

### 3. `accounting-ecosystem/backend/modules/inventory/routes/reports.js` (MODIFIED)

**Root cause addressed:** Stock valuation report totals did not include `consumables_value` or `sub_assembly_value`, leaving incomplete data for GL prep and financial analysis.

**Change:**  
Added two lines to the totals computation in `GET /reports/stock-valuation`:
```javascript
const consumablesValue = rows.filter(r => r.itemType === 'consumable').reduce(...);
const subAssemblyValue = rows.filter(r => r.itemType === 'sub_assembly').reduce(...);
```

Added to report response object:
```javascript
consumables_value:  consumablesValue,
sub_assembly_value: subAssemblyValue,
```

No other changes. Logic is identical to the existing `rawMaterialValue` and `finishedGoodsValue` computations.

---

### 4. `accounting-ecosystem/backend/modules/inventory/routes/boms.js` (MODIFIED)

**Root cause addressed:** BOM cost summary used an inline fallback chain duplicated from `work-orders.js` and `costingService.js`. Did not respect item-level `costing_method` — always defaulted to `average_cost`.

**Changes:**

**Import added:**
```javascript
const { getIssueCostFromItemData } = require('../services/costingService');
```

**BOM lines SELECT expanded:**  
Added `standard_cost, costing_method` to the `inventory_items` join so all methods have the fields they need.

**Inline chain replaced:**  
```javascript
// Before (3 lines, method-unaware):
const averageCost = parseFloat(line.inventory_items?.average_cost);
const lastPurchaseCost = ...;
const fallbackCost = ...;
const unitCost = Number.isFinite(averageCost) ? averageCost : ...;

// After (1 line, method-aware):
const { issueCost: unitCost } = getIssueCostFromItemData(line.inventory_items);
```

No other changes. The `estimatedCost`, `cost_missing`, and `totalRecipeCost` computations are unchanged.

---

### 5. `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` (MODIFIED)

**Root cause addressed (2 gaps):**

#### Gap 1 — Issue cost used inline fallback, not costing_method dispatch
The `POST /:id/issue-materials` endpoint computed `issueCost = parseFloat(itemRow.average_cost) || parseFloat(itemRow.cost_price) || null`. This ignored the item's `costing_method`. Standard-cost and last-cost items were costed at average_cost instead.

**Fix:** Replaced inline computation with `const { issueCost } = getIssueCostFromItemData(itemRow)`. The inventory_items SELECT in Phase 1 is also expanded to include `last_purchase_cost, standard_cost, costing_method` so all methods have the required fields.

#### Gap 2 — issue_unit_cost not persisted on work_order_materials
After stock-out, the update to `work_order_materials` only set `issued_qty`. The cost at issue time was not recorded on the row.

**Fix:** Updated the `work_order_materials` update to include:
```javascript
issue_unit_cost: issueCost  // frozen at issue time
```
This is a forward-only change — existing rows have `NULL` (interpreted as "issued before Codebox 02").

#### Gap 3 — Cost summary used current price instead of issue-time price
`GET /:id/cost-summary` re-queried current `average_cost` to compute `issued_cost` per component. For finalized WOs, the total cost was therefore wrong if any component's price had changed since issue.

**Fix:**
- Materials SELECT expanded to include `issue_unit_cost, standard_cost, costing_method`
- `work_order_costs` record now also fetched (accumulated totals)
- Per-component cost selection:
  - If `issue_unit_cost` is not null: use it (`cost_basis: 'frozen_at_issue'`)
  - Otherwise: use `getIssueCostFromItemData()` on current data (`cost_basis: 'current_estimate'`)
- Summary total: use `work_order_costs.material_cost` (accumulated, authoritative) if available, otherwise sum per-row estimates
- Response now includes: `accumulated_material_cost`, `estimated_material_cost`, `material_cost` (resolved), `cost_basis` for the totals

---

## What Was NOT Changed

| File | Reason |
|---|---|
| `stockMutationService.js` | Complete and correct. All stock mutation paths are already correct. |
| `index.js` (main inventory router) | Quick-receive and PO receive already call `adjustStockTx` with `unitCost`. No gaps. |
| `frontend-inventory/index.html` | No costing logic in frontend. Auth token localStorage (line 794) is the only storage use — compliant. |
| `stock-helpers.js` | Already deprecated — throws on call. No changes needed. |

---

## Scope Boundary

Codebox 02 covers: costing model hardening, forensic valuation ledger, centralized dispatch.

**Intentionally out of scope:**
- FIFO layer consumption algorithm (Codebox 05+)
- GL posting / accounting journal integration (future Codebox)
- WO labor cost and overhead cost capture (future Codebox)
- Frontend costing method UI (future Codebox)
- VALIDATE CONSTRAINT for NOT VALID constraints (maintenance window, after data check)

---

## Implementation Discipline Applied (CLAUDE.md)

- Rule A1: Full audit conducted before any change — see `00_costing_safety_audit.md`
- Rule A2: No existing required functionality removed — all existing exports preserved in costingService.js
- Rule A3: Change impact note produced for each file above
- Rule A4: No blind replacements — all changes are minimal targeted edits
- Rule A5: No required fields removed; cost fields explicitly expanded
- Rule D1–D7: No business data written to localStorage/sessionStorage in any change
- Rule C1–C6: No zbpack.json touched; Dockerfile structure unchanged
