# Phase 2A — Safety Scan
**Scan Date:** 2026-05-22  
**Performed Before:** Any Phase 2A costing code written  
**Output Required By:** Phase 2A workstream spec, Step 0

---

## Scan Scope

Files scanned for:
1. `localStorage` / `sessionStorage` misuse (business data)
2. Frontend stock quantity calculations
3. Frontend costing calculations
4. Duplicate stock/cost sources
5. Direct `current_stock` updates outside approved RPC
6. `stock_movements` inserts outside approved path

---

## 1. Browser Storage Scan

### `accounting-ecosystem/frontend-inventory/index.html`

| Line | Pattern | Data Type | Safe? |
|------|---------|-----------|-------|
| 690 | `localStorage.getItem('token')` | Auth token | ✅ SAFE — auth token only |

**Result: CLEAN.** No business data (inventory quantities, costs, valuations) in browser storage. Auth token only.

### All other inventory frontend files
No additional inventory frontend files exist beyond `index.html`.

**Browser storage verdict: SAFE — no action required.**

---

## 2. Frontend Stock Quantity Calculations

Scanned `frontend-inventory/index.html` for:
- Arithmetic on `current_stock` outside display rendering
- Quantity accumulation in JS variables
- Any local stock-in/out calculations before API call

**Result: CLEAN.** Frontend only reads `current_stock` from API responses for display. No frontend-side stock arithmetic performed. All stock mutations go through the server.

---

## 3. Frontend Costing Calculations

Scanned for:
- `cost_price` arithmetic in frontend
- Weighted average formula in frontend
- FIFO layer computation in frontend
- Valuation totals computed frontend-side

**Result: CLEAN.** Frontend displays `cost_price` from backend (line 916 in index.html — table cell render only). No frontend costing math. No weighted average, FIFO, or standard cost formulas in frontend code.

---

## 4. Duplicate Stock / Cost Sources

| Source | Used For | Authoritative? |
|--------|---------|----------------|
| `inventory_items.current_stock` | Current on-hand quantity | ✅ DB authoritative |
| `inventory_items.cost_price` | Static last-set cost | ⚠️ Only field, no `average_cost` — not weighted |
| `stock_movements.cost_price` | Per-movement cost | ⚠️ Always NULL — never populated |
| `adjust_inventory_stock()` RPC | Stock mutation | ✅ Only approved mutation path |

**Findings:**
- `inventory_items.cost_price` is a static field — not a computed weighted average
- `stock_movements.cost_price` exists in schema but is never populated by any flow
- No secondary cost source exists — no duplication risk, but costing is essentially unimplemented

---

## 5. Direct `current_stock` Update Paths Outside RPC

Scanned all backend inventory code for:
- `supabase.from('inventory_items').update({ current_stock: ... })`
- Any direct write to `current_stock` column bypassing `adjust_inventory_stock()`

### `backend/modules/inventory/index.js`

| Line Range | Pattern | Safe? |
|------------|---------|-------|
| 499–509 | PO receive → `supabase.rpc('adjust_inventory_stock', ...)` | ✅ Approved path |
| 227–270 | Movements POST → `supabase.rpc('adjust_inventory_stock', ...)` for in/out | ✅ Approved path |
| 285–310 | Adjustment movement → direct insert to `stock_movements` only | ⚠️ See note below |

**Note on adjustment path (line 285):** The manual adjustment movement inserts directly to `stock_movements` without calling the RPC. This means `inventory_items.current_stock` is NOT updated for manual adjustments — only a movement record is written. This is a pre-existing architectural gap (not introduced by Phase 2A) but must be noted.

### `backend/modules/inventory/routes/work-orders.js`

| Line Range | Pattern | Safe? |
|------------|---------|-------|
| Issue materials | `supabase.rpc('adjust_inventory_stock', ...)` with `p_movement_type: 'out'` | ✅ Approved path |
| WO complete | `supabase.rpc('adjust_inventory_stock', ...)` with `p_movement_type: 'in'` for finished goods | ✅ Approved path |

**Result: No unauthorized direct `current_stock` updates found.** Only the pre-existing adjustment path gap (documented above, pre-Phase-2A).

---

## 6. `stock_movements` Insert Paths Outside Approved Path

Authorized insert paths (via `adjust_inventory_stock()` RPC which inserts internally):
- PO receive: line 499 in `index.js`
- Movements in/out: line 227 in `index.js`
- WO issue materials: `work-orders.js`
- WO complete: `work-orders.js`

Direct `stock_movements` insert (bypassing RPC):
- Manual adjustment: line ~285 in `index.js` — direct insert for adjustment type

**Note:** The direct adjustment insert predates Phase 2A. Phase 2A must not make it worse. Phase 2A costing hooks should be added to the RPC-path calls; the adjustment path is a separate tracked follow-up.

---

## 7. Summary

| Check | Result |
|-------|--------|
| localStorage business data | ✅ CLEAN |
| sessionStorage business data | ✅ CLEAN |
| Frontend stock calculations | ✅ CLEAN |
| Frontend costing calculations | ✅ CLEAN |
| Duplicate stock sources | ✅ CLEAN (single source: RPC → inventory_items.current_stock) |
| Unauthorized current_stock writes | ⚠️ Pre-existing adjustment gap (not Phase 2A introduced) |
| stock_movements inserts outside path | ⚠️ Same pre-existing adjustment gap |

**Phase 2A is SAFE TO PROCEED.** No safety violations introduced by proceeding. Pre-existing gaps are documented and not worsened.

---

## Follow-Up Note (Pre-existing Gap)

```
FOLLOW-UP NOTE
- Area: Manual adjustment stock movement
- Dependency: inventory/index.js ~line 285
- What was done now: Documented, not changed
- What still needs to be checked: Direct stock_movements insert for adjustment type does not 
  call adjust_inventory_stock() RPC — current_stock may not update for manual adjustments
- Risk if not checked: Manual adjustments may create movement records without updating 
  inventory_items.current_stock, causing stock balance discrepancy
- Recommended next review point: Phase 2B or dedicated inventory hardening workstream
```
