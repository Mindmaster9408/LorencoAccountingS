# H01 — Scope and Environment

**Date:** 2026-05-30
**Hardening Phase:** H01 — Full Smoke Tests, Integrity Checks & Pilot Stability Audit
**Tested by:** Code-level forensic audit (static analysis + route/logic review)

---

## Deployed Target

| Field | Value |
|---|---|
| Deployed URL | https://lorenco.zeabur.app/inventory |
| Backend | accounting-ecosystem/backend/modules/inventory |
| Database | Supabase PostgreSQL |
| Deployment | Zeabur — auto-deploy on push to main |

## Migration State (at time of audit)

Migrations applied through **060_inventory_uom_bakery_costing.sql** (confirmed by file presence and integration into route logic).

| Migration | Feature |
|---|---|
| 014 | Inventory + manufacturing base |
| 050 | Stock engine hardening (RPC) |
| 051 | Costing finalization |
| 052 | Stock count sessions |
| 053 | Reservations |
| 054 | Procurement |
| 055 | WO enhancements |
| 056 | Manufacturing execution |
| 057 | Practice workflow templates |
| 058 | Warehouse structure (CB-08) |
| 059 | Sales orders |
| 060 | UOM + bakery batch costing |

**Note:** Migrations 060 adds columns using `ADD COLUMN IF NOT EXISTS` — safe to apply to existing databases.

## Audit Method

This H01 audit was conducted as **static code analysis** since direct browser access to the cloud app is not available from this toolchain.

**What was verified by code:**
- Permission gate coverage across all route files
- Company isolation (`.eq('company_id', ...)`) in all mutation paths
- localStorage usage in frontend
- Business logic correctness (over-receive guard, stock negativity guard, double-apply protection)
- Error handling completeness
- Race condition risks
- Response shape consistency

**What requires live testing (documented as BLOCKED where applicable):**
- Actual HTTP response codes from deployed Zeabur instance
- Browser UI rendering
- Network error recovery behavior
- Concurrent operation behaviour under real load

## Route Files Audited

| File | Routes | Permission Coverage (after H01 fixes) |
|---|---|---|
| `index.js` | 26 | ✓ All gated |
| `purchase-orders.js` | 10 | ✓ All gated |
| `work-orders.js` | 13 | ✓ All gated |
| `stock-counts.js` | 9 | ✓ All gated |
| `reports.js` | 26 | ✓ All gated |
| `boms.js` | 7 | ✓ All gated |
| `warehouse-transfers.js` | 7 | ✓ All gated |
| `sales-orders.js` | 7 | ✓ All gated |
| `production-batches.js` | 8 | ✓ All gated |
| `procurement.js` | 4 | ✓ Fixed in H01 |
| `reservations.js` | 7 | ✓ Fixed in H01 |
| `warehouse-locations.js` | 5 | ✓ Fixed in H01 |
| `stock-helpers.js` | 0 (deprecated stub) | N/A |
| **Total** | **129** | **✓ 100% coverage after H01** |
