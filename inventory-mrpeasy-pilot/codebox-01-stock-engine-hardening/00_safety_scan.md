# Codebox 01 — Safety Scan
**Date:** May 2026  
**Status:** Complete — pre-implementation scan  

---

## 1. Scope of Change

Codebox 01 hardens the inventory stock mutation layer:
- Fixes a silent column-name bug in the `adjust_inventory_stock()` PostgreSQL RPC (wrong column names in `stock_movements` INSERT)
- Replaces the non-atomic Node.js `adjustStock()` helper with a DB-authoritative service
- Unifies all 5 stock-mutation call sites behind one `stockMutationService.adjustStockTx()` function
- Enables the forensic cost ledger (`stock_valuation_movements`) for all future movements
- Validates the `chk_current_stock_non_negative` constraint that was added as NOT VALID in migration 016

---

## 2. Files Scanned for Stock Mutations

### Direct stock mutation paths found (all 5):

| # | File | Location | Current mechanism | Status |
|---|------|----------|------------------|--------|
| 1 | `backend/modules/inventory/index.js` | `POST /movements` line ~393 | `adjustStock()` helper | Replace |
| 2 | `backend/modules/inventory/index.js` | `POST /quick-receive` line ~480 | `adjustStock()` helper | Replace |
| 3 | `backend/modules/inventory/index.js` | `POST /purchase-orders/:id/receive` line ~726 | **BROKEN RPC directly** | Replace (critical) |
| 4 | `backend/modules/inventory/routes/work-orders.js` | `POST /:id/complete` line ~302 | `adjustStock()` helper | Replace |
| 5 | `backend/modules/inventory/routes/work-orders.js` | `POST /:id/issue-materials` line ~410 | `adjustStock()` helper | Replace |

No other stock mutation paths found across the codebase.

### POS stock mutations (excluded from this codebox):

| File | Mechanism | Why excluded |
|------|-----------|-------------|
| `database/migrations/024_pos_decrement_stock_rpc.sql` | `pos_decrement_stock()` POS-specific RPC | Separate POS domain; correct column names; out of scope |
| `database/migrations/025_pos_create_sale_atomic.sql` | `pos_create_sale_atomic()` | Correct; POS domain |
| `database/migrations/027_pos_create_sale_atomic_idempotent.sql` | `pos_create_sale_atomic_idempotent()` | Correct; POS domain |

### localStorage scan — inventory business data:

Scanned `frontend-inventory/` for `localStorage.setItem`, `sessionStorage.setItem`, `safeLocalStorage.setItem`.

Result: **None found.** The inventory frontend is read/display only. All mutations go through backend API. Compliant with CLAUDE.md Part D.

---

## 3. Critical Bug Confirmed

**File:** `accounting-ecosystem/database/migrations/041_inventory_costing_foundation.sql`  
**Lines:** 269–275 (the `stock_movements` INSERT inside `adjust_inventory_stock()`)

```sql
-- WHAT IS IN THE RPC (BROKEN):
INSERT INTO stock_movements (
  company_id, item_id, warehouse_id, type, quantity,
  reference, notes, cost_price, created_by, created_at
) VALUES (...)

-- WHAT THE TABLE ACTUALLY HAS:
-- Column: movement_type  (not "type")
-- Column: unit_cost      (not "cost_price")
```

This causes every call to `adjust_inventory_stock()` to fail with a PostgreSQL column-not-found error. The Node.js `adjustStock()` helper was created as a workaround.

**Same bug exists in migration 016** (the original RPC). Migration 041 replaced the function but carried the bug forward.

---

## 4. Race Condition Confirmed

The Node.js `adjustStock()` helper does a read-check-write sequence in application code:

```javascript
// Step 1: SELECT current_stock
// Step 2: Check if delta would cause negative (in JS)
// Step 3: UPDATE current_stock
// Step 4: INSERT stock_movements
```

Between Step 1 and Step 3 there is no row-level lock. Two concurrent stock-out requests can both read the same `current_stock`, both pass the negativity check, and both write — resulting in stock going below zero.

The `adjust_inventory_stock()` RPC in migration 041 already includes `SELECT ... FOR UPDATE` to prevent this. Fixing the column names makes the RPC safe to use.

---

## 5. NOT VALID Constraint

`chk_current_stock_non_negative` was added in migration 016 as NOT VALID. This means:
- New/updated rows are checked
- Existing rows were never validated
- If any existing rows have `current_stock < 0`, the constraint would fail to validate

Migration 050 includes a pre-validation diagnostic query and conditionally validates the constraint.

---

## 6. Ecosystem Safety

| Area | Risk | Assessment |
|------|------|-----------|
| POS stock mutations | RPC change could break POS | Safe — POS uses different RPCs (`pos_decrement_stock`, etc.) |
| Accounting module | No stock mutations | Safe |
| Payroll module | No stock mutations | Safe |
| Historical comparatives | No stock mutations | Safe |
| Sean AI | No stock mutations | Safe |
| Company isolation | Every call site already passes `req.companyId` | Safe — service enforces it |

---

## 7. No Breaking Changes to API Contracts

The `stockMutationService.adjustStockTx()` returns the same shape as `adjustStock()`:
```javascript
{ success: boolean, new_stock?: number, new_avg_cost?: number, error?: string, available?: number }
```

All call sites check `result.success` and read `result.error` / `result.available` on failure — no contract changes needed.

---

## 8. Scan Conclusion

Safe to proceed. All 5 call sites identified. No POS overlap. No localStorage violations. Bug root cause confirmed. Fix is surgical: one `CREATE OR REPLACE FUNCTION` correcting two column names.
