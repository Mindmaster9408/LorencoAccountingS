# Codebox 01 — Implementation Report
**Date:** May 2026  
**Status:** Implemented locally — NOT committed, NOT pushed.

---

## 1. Summary

Hardened the inventory stock mutation layer by fixing the broken `adjust_inventory_stock()` PostgreSQL RPC and replacing all 5 non-atomic Node.js call sites with a single forensic-grade service.

The visible change to the running app is small: stock mutations continue to work exactly as before, but are now:
- Protected from concurrent race conditions (SELECT FOR UPDATE)
- Writing to the forensic cost ledger (stock_valuation_movements)
- Creating FIFO cost layer rows (inventory_cost_layers)
- Recording average_cost changes (item_cost_history)
- Protected by a validated non-negative stock constraint

---

## 2. Files Changed

### New files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/database/migrations/050_inventory_stock_engine_hardening.sql` | Fixes RPC column names, validates constraint, adds index |
| `accounting-ecosystem/backend/modules/inventory/services/stockMutationService.js` | New single-entry-point service for all stock mutations |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/00_safety_scan.md` | Pre-implementation safety scan |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/01_current_stock_engine_audit.md` | Full audit of existing code |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/02_database_changes.md` | Database change record |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/03_implementation_report.md` | This file |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/04_testing_report.md` | Testing plan and results |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/05_risk_register.md` | Risk register |
| `inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/06_next_codebox_recommendation.md` | What Codebox 02 should address |
| `scripts/test_inventory_stock_concurrency.mjs` | 10-concurrent-request concurrency test |
| `scripts/test_inventory_company_isolation.mjs` | Cross-company mutation rejection test |
| `scripts/test_inventory_no_local_storage.mjs` | Browser storage compliance scan |

### Modified files

| File | Change |
|------|--------|
| `accounting-ecosystem/backend/modules/inventory/index.js` | Import: `adjustStock` → `adjustStockTx`. 3 call sites replaced. |
| `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` | Import: `adjustStock` → `adjustStockTx`. 2 call sites replaced. |
| `accounting-ecosystem/backend/modules/inventory/routes/stock-helpers.js` | `adjustStock()` now throws deprecation error instead of running |

---

## 3. Call Site Changes

### index.js — 3 sites

**Site 1: `POST /movements`**
```javascript
// Before
const result = await adjustStock(supabase, { ..., costPrice: ..., ... });

// After
const result = await adjustStockTx(supabase, { ..., unitCost: ..., ... });
```

**Site 2: `POST /quick-receive`**
```javascript
// Before
const result = await adjustStock(supabase, { ..., costPrice: cost, ... });

// After
const result = await adjustStockTx(supabase, { ..., unitCost: cost, ... });
```

**Site 3: `POST /purchase-orders/:id/receive`** (was broken direct RPC call)
```javascript
// Before — BROKEN: called supabase.rpc() directly with wrong RPC
const { data: rpcResult, error: rpcErr } = await supabase.rpc('adjust_inventory_stock', { p_cost_price: ... });

// After — fixed via service
const rpcResult = await adjustStockTx(supabase, { ..., unitCost: poItem.unit_price, ... });
```

### work-orders.js — 2 sites

**Site 4: `POST /:id/complete`**
```javascript
// Before
const rpcResult = await adjustStock(supabase, { ..., costPrice: woUnitCost, ... });

// After
const rpcResult = await adjustStockTx(supabase, { ..., unitCost: woUnitCost, ... });
```

**Site 5: `POST /:id/issue-materials`**
```javascript
// Before
const issueResult = await adjustStock(supabase, { ..., costPrice: issueCost, ... });

// After
const issueResult = await adjustStockTx(supabase, { ..., unitCost: issueCost, ... });
```

---

## 4. Parameter Mapping

The `costPrice` parameter name (used in `adjustStock`) was renamed to `unitCost` (used in `adjustStockTx`) for consistency with the actual database column name.

Both map to `p_cost_price` in the RPC (the RPC parameter name was deliberately kept for backward compatibility since other callers might exist in scripts).

---

## 5. What Is NOT Changed (Preserved)

- All response shapes: `{ success, new_stock, new_avg_cost, error, available }` — identical
- All HTTP status codes at call sites — unchanged
- All audit trail calls (`auditFromReq`) — unchanged
- All company context checks — unchanged (`req.companyId` flows through unchanged)
- The `costingService.js` — not touched
- The frontend — not touched
- Any POS routes or RPCs — not touched
- Auth middleware — not touched

---

## 6. Required Step Before Going Live

Run migration `050_inventory_stock_engine_hardening.sql` in Supabase.

Until this migration is applied, the backend will call the fixed-name RPC but the DB still has the broken version. The migration is the critical gate.
