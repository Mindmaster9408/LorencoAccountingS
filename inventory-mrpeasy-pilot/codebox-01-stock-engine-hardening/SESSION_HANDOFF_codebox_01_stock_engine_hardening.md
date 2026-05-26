# Session Handoff — Codebox 01: Stock Engine Hardening
**Date:** May 2026  
**Branch:** main (local only — NOT committed, NOT pushed)

---

## What Was Changed

### New files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/database/migrations/050_inventory_stock_engine_hardening.sql` | Fixes `adjust_inventory_stock()` RPC column names (`type`→`movement_type`, `cost_price`→`unit_cost`). Validates `chk_current_stock_non_negative`. Adds `idx_sm_company_item_created` index. |
| `accounting-ecosystem/backend/modules/inventory/services/stockMutationService.js` | New single-entry-point for all stock mutations. Wraps the fixed RPC. Input validation + structured result. |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/00_safety_scan.md` | Pre-implementation safety scan |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/01_current_stock_engine_audit.md` | Full audit of existing code paths |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/02_database_changes.md` | DB change record |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/03_implementation_report.md` | Implementation report |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/04_testing_report.md` | Manual smoke tests + automated test plan |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/05_risk_register.md` | Risk register (R01–R09) |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/06_next_codebox_recommendation.md` | Codebox 02 options |
| `scripts/test_inventory_stock_concurrency.mjs` | 10-concurrent stock-out test |
| `scripts/test_inventory_company_isolation.mjs` | Cross-company isolation test |
| `scripts/test_inventory_no_local_storage.mjs` | Browser storage compliance scan |

### Modified files

| File | Change |
|------|--------|
| `accounting-ecosystem/backend/modules/inventory/index.js` | `adjustStock` import replaced with `adjustStockTx`. 3 call sites updated: `/movements`, `/quick-receive`, `/purchase-orders/:id/receive`. PO receive was calling BROKEN RPC directly — now uses service. |
| `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` | `adjustStock` import replaced with `adjustStockTx`. 2 call sites updated: `/:id/complete`, `/:id/issue-materials`. |
| `accounting-ecosystem/backend/modules/inventory/routes/stock-helpers.js` | `adjustStock()` now throws deprecation error instead of executing. |

---

## Root Causes Fixed

| Bug | Root cause | Fix |
|-----|-----------|-----|
| PO receive silently broken | `index.js` was calling `supabase.rpc('adjust_inventory_stock')` directly — never updated when stock-helpers was introduced | Replaced with `adjustStockTx()` service call |
| All RPC calls broken | `adjust_inventory_stock()` in migration 041 used `type` and `cost_price` in the `stock_movements` INSERT — wrong column names | Migration 050 corrects to `movement_type` and `unit_cost` |
| Race condition in stock mutations | Node.js helper did read-check-write without DB row lock | Fixed: RPC uses `SELECT ... FOR UPDATE`; Node helper deprecated |

---

## What Was Confirmed Working (Before This Session)

- Stock movements via the Node.js `adjustStock()` helper (manual in/out, quick-receive, WO complete, WO issue-materials)
- Movement history display (dual-path: `stock_valuation_movements` fallback to `stock_movements`)
- PO listing and creation
- Work order lifecycle (create → release → start → complete / issue-materials)

---

## What Was NOT Changed

- Frontend — no changes
- Auth middleware — no changes
- POS stock RPCs — no changes
- `costingService.js` — no changes
- Any other module (accounting, payroll, POS) — no changes

---

## Testing Required Before Commit/Push

1. Apply migration `050_inventory_stock_engine_hardening.sql` in Supabase
2. Run negative stock diagnostic first: `SELECT id, name, current_stock FROM inventory_items WHERE current_stock < 0`
3. Restart backend
4. Run manual smoke tests CBXTEST-01 through CBXTEST-07 (see `04_testing_report.md`)
5. Run automated test scripts (requires Supabase URL + service key)
6. Confirm `stock_valuation_movements` is populating after movements

---

## Open Risks

See `05_risk_register.md`. Critical open items:
- **R01**: Migration 050 not yet applied
- **R02**: Negative stock pre-check not yet run
- **R06**: Concurrency test not yet executed live

---

## Next Codebox

See `06_next_codebox_recommendation.md`.

Recommended: **Codebox 02 — Stock Valuation Reports** (uses the now-populated forensic tables to deliver cost visibility for the MRPeasy pilot).
