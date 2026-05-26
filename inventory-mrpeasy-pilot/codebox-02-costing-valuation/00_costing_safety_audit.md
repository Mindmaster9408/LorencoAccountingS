# Codebox 02 — Costing & Valuation Safety Audit

**Date:** May 2026  
**Auditor:** Claude (Principal Engineer)  
**Scope:** Full audit of costing, valuation, and data persistence before Codebox 02 implementation

---

## 1. TABLES INSPECTED

| Table | Purpose | Status |
|---|---|---|
| `inventory_items` | Item master + cost fields | Active |
| `stock_movements` | Movement audit trail | Active |
| `stock_valuation_movements` | Forensic cost ledger | Active |
| `inventory_cost_layers` | FIFO layer tracking | Active (layers recorded, not yet consumed) |
| `work_order_costs` | WO material cost accumulator | Active |
| `item_cost_history` | Cost change audit trail | Active |
| `work_order_materials` | BOM requirements + issued qty | Active |
| `purchase_order_items` | PO line items with unit_price | Active |
| `bom_headers` / `bom_lines` | Bill of Materials | Active |
| `work_orders` | Work order lifecycle | Active |
| `purchase_orders` | Purchase order lifecycle | Active |

---

## 2. CURRENT COSTING FIELDS (inventory_items)

| Column | Type | Source | Status |
|---|---|---|---|
| `cost_price` | NUMERIC | Legacy — original price field | Retained as fallback |
| `average_cost` | NUMERIC DEFAULT 0 | Migration 041 | PRIMARY — weighted average |
| `last_purchase_cost` | NUMERIC | Migration 041 | Informational |
| `standard_cost` | NUMERIC | Migration 041 | Optional/manual |
| `cost_updated_at` | TIMESTAMPTZ | Migration 041 | Tracks last cost event |
| `cost_source` | VARCHAR(50) | Migration 041 | Source of last cost change |
| `costing_method` | VARCHAR(20) DEFAULT 'average' | Migration 014 | Per-item method selector |

**Constraint gap found:**  
`costing_method` CHECK is `('average', 'fifo', 'standard')` — missing `'last_cost'`.  
**Fix:** Expand constraint in migration 051.

**Constraint gap found:**  
No non-negative CHECK constraints on `average_cost`, `last_purchase_cost`, `standard_cost`.  
Application code does validate, but DB-level enforcement is missing.  
**Fix:** Add NOT VALID constraints in migration 051.

**Missing fields (Codebox 02 additions):**  
- No accounting prep fields (`inventory_asset_account_id`, `cogs_account_id`, `wip_account_id`).  
- **Fix:** Add in migration 051 (nullable, no GL posting yet).

---

## 3. VALUATION GAPS

### Gap V1 — stock_valuation_movements missing BEFORE values
`stock_valuation_movements` stores `running_avg_cost` (new avg) and `running_qty` (new stock) but does NOT store:
- `previous_average_cost` — avg before this event
- `previous_stock` — qty before this event

**Impact:** Cannot reconstruct "before" state from the ledger without reading the prior row.  
**Fix:** Add columns + update RPC in migration 051.

### Gap V2 — work_order_materials missing issue-time cost
`work_order_materials` tracks `issued_qty` but not `issue_unit_cost` (the item's average cost AT TIME of issue). After the item's average cost changes, the WO cost summary endpoint re-calculates using current price, not issue-time price.

**Impact:** Historical WO cost summaries show incorrect per-component costs if item prices have changed since issue.  
**Fix:** Add `issue_unit_cost` column to `work_order_materials` in migration 051. Update issue-materials endpoint to persist it.

### Gap V3 — WO cost summary uses current price, not accumulated cost
`GET /work-orders/:id/cost-summary` recomputes `issued_cost` from current `average_cost`. For finalized WOs, the authoritative source is `work_order_costs.material_cost` (accumulated at issue time).  
**Fix:** Update endpoint to surface both the accumulated total from `work_order_costs` AND per-component breakdown using `issue_unit_cost`.

### Gap V4 — stock-valuation report missing consumables/sub-assembly totals
`GET /reports/stock-valuation` returns `raw_material_value` and `finished_goods_value` but not `consumables_value` or `sub_assembly_value`.  
**Fix:** Add these in reports.js.

---

## 4. DUPLICATED LOGIC

| Pattern | Location | Risk |
|---|---|---|
| Cost fallback chain (`average_cost || last_purchase_cost || cost_price`) | `costingService.js`, `boms.js`, `work-orders.js` | All three places must stay in sync if fallback logic changes |
| WO material cost computation | `work-orders.js` (inline) and `costingService.calculateWorkOrderCost()` (incomplete) | Divergence risk |

**Fix:** Add `getIssueCostFromItemData()` pure function to costingService.js. Update boms.js and work-orders.js to call it.

---

## 5. UNSAFE FRONTEND CALCULATIONS

**Scan result: No unsafe frontend costing calculations found.**

- `frontend-inventory/index.html` (794 lines inspected)
- Single localStorage use on line 794: `localStorage.getItem('token')` — **auth token only, COMPLIANT with Rule D2**
- No cost calculations performed in browser JavaScript
- No stock values derived in browser
- All values loaded from backend API responses
- No sessionStorage, no indexedDB, no costing truth in browser

---

## 6. COMPANY SCOPING AUDIT

Every table and every query reviewed:

| Table | company_id enforced | Route filter | RPC filter |
|---|---|---|---|
| `inventory_items` | ✓ | `.eq('company_id', req.companyId)` | `p_company_id` parameter |
| `stock_movements` | ✓ | `.eq('company_id', req.companyId)` | via RPC |
| `stock_valuation_movements` | ✓ | `.eq('company_id', req.companyId)` | via RPC |
| `inventory_cost_layers` | ✓ | via RPC | `p_company_id` parameter |
| `work_order_costs` | ✓ | `.eq('company_id', req.companyId)` | — |
| `item_cost_history` | ✓ | `.eq('company_id', req.companyId)` | via RPC |
| `work_order_materials` | Indirect (via `work_order_id`) | — | — |
| `bom_lines` | Indirect (via `bom_id`) | — | — |
| Reports | ✓ | All via `req.companyId` | — |

**Gap found:** `work_order_materials` and `bom_lines` are accessed only after validating the parent record belongs to the company. This is correct indirect scoping but there is no `company_id` column on these tables as a direct guard.  
**Risk:** Low — parent verification happens before child access in all routes.  
**Note:** No change required for Codebox 02; document for awareness.

---

## 7. CURRENT COST SOURCES

| Event | Cost Source | Handler |
|---|---|---|
| Quick Receive | `unit_cost` from request body | `adjustStockTx` → RPC |
| PO Receive | `unit_price` from PO line | `adjustStockTx` → RPC |
| WO Issue (material out) | `average_cost` at time of issue | `adjustStockTx` → RPC |
| WO Complete (finished good in) | `unit_cost` from finalized `work_order_costs` | `adjustStockTx` → RPC |
| Manual Adjustment | `cost_price` from request body (optional) | `adjustStockTx` → RPC |
| BOM cost summary | Current `average_cost` from DB | Inline in boms.js |

**All stock-changing cost events flow through the RPC — confirmed.**  
No direct INSERT into `stock_movements` or `stock_valuation_movements` exists in application code.

---

## 8. CURRENT WO COSTING BEHAVIOUR

1. `POST /work-orders/:id/issue-materials` — loops through issue list, calls `adjustStockTx` (stock-out), then calls `accumulateWorkOrderMaterialCost` to add `qty × average_cost` to `work_order_costs.material_cost`.
2. `POST /work-orders/:id/complete` — calls `finalizeWorkOrderCost` (sets `unit_cost = material / qty, status = finalized`), then calls `adjustStockTx` (stock-in) with `unit_cost = woUnitCost`.
3. `GET /work-orders/:id/cost-summary` — reads current `average_cost` per component and re-computes. **Does not use `work_order_costs.material_cost` as source of truth for finalized WOs.**

**Gap:** Issue-time cost is captured in `work_order_costs.material_cost` (accumulated) but NOT per component row. After Codebox 02 adds `issue_unit_cost` to `work_order_materials`, per-component forensic accuracy will be complete.

---

## 9. CURRENT VALUATION REPORT BEHAVIOUR

`GET /reports/stock-valuation`:
- Returns `qty × average_cost` per item ✓
- Falls back to `last_purchase_cost`, then `cost_price` if `average_cost` is null ✓
- Returns `grand_total`, `raw_material_value`, `finished_goods_value` ✓
- **Missing:** `consumables_value`, `sub_assembly_value` ✗
- **Missing:** `valuation_method` in item rows (uses `costingMethod` from `costing_method`) — field exists, just needs to be surfaced cleanly

---

## 10. RISKS FOUND

| ID | Risk | Severity | Fix |
|---|---|---|---|
| R01 | `costing_method` constraint missing 'last_cost' | Medium | Migration 051 Step 1 |
| R02 | No DB-level non-negative cost constraint | Medium | Migration 051 Step 2 |
| R03 | `stock_valuation_movements` missing before-values | High | Migration 051 Step 3 + RPC update |
| R04 | WO cost summary uses current price not issue-time price | High | Migration 051 Step 5 + work-orders.js update |
| R05 | Duplicate cost fallback chain in 3 files | Medium | `getIssueCostFromItemData()` centralization |
| R06 | Valuation report missing consumables/sub-assembly totals | Low | reports.js update |
| R07 | work_order_materials has no direct company_id column | Low | Accepted — indirect scoping |
| R08 | FIFO layers tracked but not consumed | Accepted | Known — documented, Codebox 05+ |

---

## 11. FIXES PLANNED (Codebox 02)

1. **Migration 051** — constraint expansion, non-negative guards, previous-value columns on valuation ledger, `issue_unit_cost` on `work_order_materials`, accounting prep fields, indexes
2. **RPC update** — `adjust_inventory_stock()` populates `previous_average_cost` and `previous_stock`
3. **costingService.js** — add `getIssueCostFromItemData()`, `getItemIssueCost()`, `recordValuationMovement()`, `updateAverageCostAfterReceipt()`, `calculateWorkOrderCost()`
4. **reports.js** — add `consumables_value`, `sub_assembly_value` to stock-valuation totals
5. **boms.js** — use `getIssueCostFromItemData()` instead of inline chain
6. **work-orders.js** — persist `issue_unit_cost` on issue; use accumulated cost for finalized WO summaries
7. **Documentation** — full Codebox 02 doc suite
