# Codebox 03 — Pre-Change Safety Audit
**Date:** June 2026  
**Module:** Lorenco Storehouse — Stock Counts & Variance Control

---

## 1. FILES INSPECTED BEFORE CHANGE

| File | Lines Reviewed | Outcome |
|---|---|---|
| `backend/modules/inventory/index.js` | Full | Understood sub-router mount pattern |
| `backend/modules/inventory/routes/reports.js` | Full | Understood endpoint structure |
| `backend/modules/inventory/services/stockMutationService.js` | Full | Confirmed `adjustStockTx()` signature |
| `backend/config/permissions.js` | Full | No INVENTORY_COUNTS — consistent, not yet added |
| `frontend-inventory/index.html` | ~600 lines (key sections) | Nav, sections, modals, switchTab, utilities |

---

## 2. EXISTING BEHAVIOUR CONFIRMED — MUST NOT REGRESS

### Backend
- All existing inventory routes (items, movements, warehouses, suppliers, POs, BOMs, work orders, reports) continue unchanged
- `stockMutationService.adjustStockTx()` signature unchanged: `(supabase, companyId, itemId, warehouseId, qty, movementType, notes, sourceType, sourceId, userId)` 
- `adjust_inventory_stock()` RPC is the single atomic path for all stock changes — no direct UPDATE to `current_stock` ever
- Company isolation: every existing query uses `.eq('company_id', companyId)` — Codebox 03 must do the same

### Frontend
- Auth token at `localStorage.getItem('token')` — **the only permitted localStorage use** — not changed
- `apiFetch()`, `switchTab()`, `openModal()`, `closeModal()`, `showToast()`, `statusBadge()`, `fmtR()`, `fmtQty()`, `fmtDate()`, `esc()` all reused without modification
- Existing tabs: dashboard, items, movements, warehouses, suppliers, orders, boms, workorders, reports — all preserved, no nav or section changes
- `.section` / `.section.active` visibility pattern — new stockcounts section follows same pattern

---

## 3. MUTATION RULE CONFIRMED

All stock adjustments for variances MUST route through:
```javascript
await adjustStockTx(supabase, companyId, itemId, warehouseId, qty, movementType, notes, sourceType, sourceId, userId)
```
- movementType: `'count_adjustment_in'` (gain) or `'count_adjustment_out'` (loss)
- sourceType: `'stock_count'`
- sourceId: `String(sessionId)`

No direct UPDATE to `inventory_items.current_stock` is permitted at any point.

---

## 4. COMPANY ISOLATION CONFIRMED

Every new table and query enforces `company_id`:
- `stock_count_sessions.company_id` — indexed, on every INSERT and SELECT
- `stock_count_lines.company_id` — indexed, on every INSERT and SELECT  
- `stock_count_approvals.company_id` — indexed, on every INSERT and SELECT
- All route handlers extract `const { companyId } = req;` before any DB call
- `generateCountLines()` scopes item snapshot to `company_id`

---

## 5. NO LOCALSTORAGE VIOLATIONS

- No count session state written to localStorage
- No line counted_quantity cached in localStorage
- No approval result cached in localStorage
- No variance value cached in localStorage
- All count state lives exclusively in Supabase tables

---

## 6. ZEABUR DEPLOYMENT SAFETY

- `accounting-ecosystem/zbpack.json` does NOT exist — not created during this session
- `accounting-ecosystem/Dockerfile` unchanged — build path unaffected
- `accounting-ecosystem/.dockerignore` unchanged

---

## 7. RISKS DEFERRED

| Risk | Decision |
|---|---|
| `freeze_inventory` enforcement across services | **DEFERRED** — field exists in DB and UI but logic not implemented. Too risky to add cross-service inventory freezing in Codebox 03. Documented only. |
| RBAC for `INVENTORY_COUNTS` | **DEFERRED** — no permission check yet, consistent with existing inventory routes. `06_permission_prep.md` documents future design. |
| `recount` flow (re-entering specific lines) | Supported via `count_type='recount'` but no dedicated "recount specific items" UI flow beyond editing lines in in_progress status. Sufficient for Codebox 03. |
