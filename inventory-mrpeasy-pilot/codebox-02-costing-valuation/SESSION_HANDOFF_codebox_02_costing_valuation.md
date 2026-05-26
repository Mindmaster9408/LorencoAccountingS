# Session Handoff — Codebox 02: Costing & Valuation Finalization

**Date:** May 2026  
**Session type:** Implementation + Documentation  
**Status:** CODE COMPLETE — Pending migration deployment and live testing

---

## What Was Changed

### New File — `accounting-ecosystem/database/migrations/051_inventory_costing_finalization.sql`

**Purpose:** Schema hardening for forensic-grade costing and valuation.

7 steps:
1. Expanded `costing_method` CHECK to include `'last_cost'`
2. Added NOT VALID non-negative cost constraints on 3 cost fields
3. Added `previous_average_cost` and `previous_stock` to `stock_valuation_movements`
4. Updated `adjust_inventory_stock()` RPC (CREATE OR REPLACE) to populate before-state columns
5. Added `issue_unit_cost` to `work_order_materials`
6. Added `inventory_asset_account_id`, `cogs_account_id`, `wip_account_id` to `inventory_items`
7. Added 5 performance indexes

---

### Modified — `backend/modules/inventory/services/costingService.js`

**Changes:**
- Added `const { adjustStockTx } = require('./stockMutationService');` at top
- Added 5 new functions before `module.exports`:
  1. `getIssueCostFromItemData(itemData)` — costing_method dispatch, pure, no DB call
  2. `getItemIssueCost(supabase, companyId, itemId)` — async version with DB fetch
  3. `recordValuationMovement()` — guard function that throws (prevents direct valuation insert)
  4. `updateAverageCostAfterReceipt(supabase, params)` — validated wrapper for stock-in
  5. `calculateWorkOrderCost(supabase, companyId, workOrderId)` — WO cost summary with frozen costs
- Updated `module.exports` to include all 5 new functions
- All existing exports preserved

---

### Modified — `backend/modules/inventory/routes/boms.js`

**Changes:**
- Added `const { getIssueCostFromItemData } = require('../services/costingService');`
- Extended `inventory_items` join SELECT to include `standard_cost, costing_method`
- Replaced inline 4-line fallback chain in `componentLines.map()` with `getIssueCostFromItemData(line.inventory_items)`

---

### Modified — `backend/modules/inventory/routes/work-orders.js`

**Changes:**
- Added `const { getIssueCostFromItemData } = costingService;` after existing require
- Extended inventory_items SELECT in Phase 1 of `issue-materials` to include `last_purchase_cost, standard_cost, costing_method`
- Replaced inline `issueCost` computation with `getIssueCostFromItemData(itemRow)`
- Added `issue_unit_cost: issueCost` to `work_order_materials` UPDATE
- Full replacement of cost-summary endpoint materials SELECT and computation:
  - Per-component: `issue_unit_cost` (frozen) preferred, current estimate as fallback
  - Totals: sourced from `work_order_costs.material_cost` (accumulated) when available
  - Response includes: `accumulated_material_cost`, `estimated_material_cost`, `cost_basis`

---

### Modified — `backend/modules/inventory/routes/reports.js`

**Changes:**
- Added `consumables_value` and `sub_assembly_value` to `GET /reports/stock-valuation` response
- Two new `.filter().reduce()` computations — same pattern as existing `raw_material_value`

---

## Root Causes Fixed

| Gap | Fix |
|---|---|
| V1: Valuation ledger had no before-state | `previous_average_cost`, `previous_stock` added + RPC updated |
| V2: WO issue cost not frozen | `issue_unit_cost` added to `work_order_materials`; persisted at issue time |
| V3: WO cost summary used current price | Cost summary now uses frozen cost; accumulated total from `work_order_costs` |
| V4: Valuation report missing item types | `consumables_value` + `sub_assembly_value` added |
| Duplicate fallback logic | Centralized to `getIssueCostFromItemData()` |
| Missing `'last_cost'` method support | Constraint expanded in migration 051 |
| No DB-level cost guards | NOT VALID constraints added |

---

## What Was Confirmed Working (Code Review Level)

- `getIssueCostFromItemData`: All 4 method branches and `cost_price` fallback logic verified by code review
- `recordValuationMovement()`: Guard throws unconditionally — confirmed
- `updateAverageCostAfterReceipt`: Three validation guards (qty <= 0, null cost, negative cost) confirmed correct
- BOM cost summary: centralized dispatch confirmed; existing `estimatedCost`, `cost_missing`, `totalRecipeCost` unchanged
- WO issue: `issue_unit_cost` only added to UPDATE — no other issue logic changed
- WO cost summary: backward-compat confirmed — NULL `issue_unit_cost` handled gracefully as `'current_estimate'`
- Reports: New totals use identical `.filter().reduce()` pattern as existing totals — clean

**All Codebox 01 stock mutation paths are unchanged.** No regression risk to quick-receive, PO-receive, stock guards, or concurrent receipt handling.

---

## What Was NOT Changed (and Why)

| File | Reason |
|---|---|
| `stockMutationService.js` | Complete and correct. No gaps found. |
| Inventory router `index.js` | Quick-receive and PO receive already correct. |
| `frontend-inventory/index.html` | No costing logic in frontend. Not in scope. |
| `stock-helpers.js` | Already deprecated with guard throws. No changes needed. |
| All accounting module files | No GL posting in Codebox 02 — accounting prep is fields-only. |
| `Dockerfile` / `zbpack.json` | No deployment structure changes. zbpack.json must never exist. |

---

## Testing Required Before Going Live

### Step 1 — Deploy Migration 050 (if not yet done)

Migration 050 must be deployed first. Verify with:
```sql
SELECT proname FROM pg_proc WHERE proname = 'adjust_inventory_stock';
```

### Step 2 — Deploy Migration 051

Run `051_inventory_costing_finalization.sql` against production Supabase.

Run all 6 verification queries from `02_database_changes.md` to confirm successful application.

### Step 3 — Redeploy Zeabur

Push updated code to trigger Zeabur build. Confirm `accounting-ecosystem/zbpack.json` does NOT exist.

### Step 4 — Smoke Tests

Minimum tests before sign-off:

1. Issue materials to a work order → confirm `issue_unit_cost` populated on `work_order_materials` row
2. GET work order cost summary → confirm `cost_basis` and `accumulated_material_cost` in response
3. GET BOM cost summary for a BOM with a standard-cost item → confirm `unit_cost` reflects `standard_cost`
4. GET stock valuation report → confirm `consumables_value` and `sub_assembly_value` in response
5. Insert item with `costing_method = 'last_cost'` → confirm accepted (no constraint error)
6. Receive stock → confirm new `stock_valuation_movements` row has `previous_average_cost` populated

### Step 5 — Validate NOT VALID Constraints (Maintenance Window)

```sql
-- First confirm zero negatives
SELECT id FROM inventory_items
WHERE average_cost < 0 OR last_purchase_cost < 0 OR standard_cost < 0;

-- Then validate all three
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_average_cost_non_negative;
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_last_purchase_cost_non_negative;
ALTER TABLE inventory_items VALIDATE CONSTRAINT chk_standard_cost_non_negative;
```

---

## Open Items / Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Multi-batch issue to work order
- Dependency: Future WO multi-batch issue UI
- What was done now: issue_unit_cost set on each issue (overwrites previous if re-issued)
- What still needs to be checked: Whether multi-batch issues occur in actual usage
- Risk if not checked: Per-component display cost may show last batch cost, not weighted avg of all batches
- Recommended next review: When multi-batch issue is enabled in WO UI
```

```
FOLLOW-UP NOTE
- Area: FIFO layer consumption
- Dependency: Codebox 05+
- What was done now: FIFO layers recorded in inventory_cost_layers on every stock-in
- What still needs to be checked: Layer consumption algorithm
- Risk if not checked: FIFO items silently priced at average_cost (proxy) — financial impact if FIFO items are material
- Recommended next review: Codebox 05 planning session
```

```
FOLLOW-UP NOTE
- Area: FK constraints on accounting prep fields
- Dependency: Chart of accounts table
- What was done now: Fields added as nullable INTEGER, no FK
- What still needs to be checked: account_id space and FK definition when accounting integration Codebox begins
- Risk if not checked: Invalid account IDs accepted silently at DB level
- Recommended next review: Start of accounting integration Codebox
```

```
FOLLOW-UP NOTE
- Area: Migration 050 deployment
- Dependency: None (standalone)
- What was done now: 050 written and reviewed, not yet applied
- Risk if not checked: 051 applied over wrong RPC base version
- Recommended next review: IMMEDIATE — deploy 050 before 051
```

---

## Deployment Order

1. Run `050_inventory_stock_engine_hardening.sql` against Supabase
2. Run `051_inventory_costing_finalization.sql` against Supabase
3. Run verification queries (in `02_database_changes.md`)
4. Push code to git → Zeabur auto-redeploys
5. Confirm Zeabur build successful (Dockerfile path, no zbpack.json)
6. Run smoke tests above
7. Sign off Codebox 02

---

## Codebox 02 Sign-Off Criteria

- [ ] Migration 050 deployed
- [ ] Migration 051 deployed + all 6 verification queries pass
- [ ] `issue_unit_cost` populated on new issues
- [ ] WO cost summary returns frozen cost with correct `cost_basis`
- [ ] Stock valuation report includes consumables and sub_assembly totals
- [ ] BOM cost summary respects `costing_method`
- [ ] Zeabur build green
- [ ] NOT VALID constraints validated (maintenance window)

---

## Document Index

| File | Contents |
|---|---|
| `00_costing_safety_audit.md` | Pre-implementation audit — gaps, risks, findings |
| `01_costing_architecture.md` | Costing model, method table, mutation path, formulas |
| `02_database_changes.md` | Migration 051 step-by-step, rollback, verification queries |
| `03_implementation_report.md` | Per-file change notes, root causes, scope boundary |
| `04_testing_report.md` | 24-test table with status, test execution instructions |
| `05_risk_register.md` | 10 risks with severity, status, mitigation notes |
| `06_accounting_integration_prep.md` | GL fields, intended journal entries, prerequisites |
| `SESSION_HANDOFF_codebox_02_costing_valuation.md` | This file |
