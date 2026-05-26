# Session Handoff — Inventory Demo 1 Month

**Date:** 2026-05-26  
**Status: DEMO LOCKED — 20/20 TESTS PASS — READY FOR CLIENT PRESENTATION**

---

## Current Status

All 20 demo flow tests pass end-to-end against live Supabase. Test run: 2026-05-26.

```
TOTAL: 20  PASS: 20  FAIL: 0  BLOCKED: 0
```

The `/inventory-test` debug route has been removed. No debug or temp routes remain.  
The `/inventory` and `/inventory/` routes are working.  
No business data in browser storage.  
All inventory queries company-scoped via JWT `companyId`.

---

## Bugs Fixed This Session (testing + lockdown)

### Bug 1 — Auth credentials in test script
- **Root cause:** Test script used `admin@test.com` which does not exist in Supabase.
- **Fix:** Updated to `ruanvlog@lorenco.co.za` with correct password.

### Bug 2 — POS alias mutated `req.url` permanently
- **Root cause:** POS alias middleware in `server.js` overwrote `req.url`, blocking all inventory route matching.
- **Fix:** Saved and restored `req.url` around the POS sub-app call.

### Bug 3 — `POST /suppliers` schema mismatch
- **Root cause:** `supplier_code` and `supplier_name` are NOT NULL but the route wasn't providing them.
- **Fix:** Auto-generated `supplier_code` (timestamp-based); mapped `name → supplier_name`.

### Bug 4 — Broken `adjust_inventory_stock` Supabase RPC (root cause of 9 test failures)
- **Root cause:** Migration 041 deployed the RPC with wrong column names: `type` (should be `movement_type`) and `cost_price` (should be `unit_cost`).
- **Fix:** Created `adjustStock()` Node.js helper in `routes/stock-helpers.js` using correct column names. Replaced all RPC call sites.

### Bug 5 — Movement history always returned empty array
- **Root cause:** `GET /items/:id/movements` built history exclusively from `stock_valuation_movements`, which `adjustStock` does not populate.
- **Fix:** Added fallback in `index.js`: when `stock_valuation_movements` is empty, build history from `stock_movements` with computed running totals.

### Lockdown — removed `/inventory-test` debug route
- **What:** `server.js` line 530 had a `// TEMP DEBUG` route `/inventory-test` that served the same file as `/inventory`.
- **Fix:** Removed the route and its comment entirely.

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/run_storehouse_tests.mjs` | Fixed auth credentials |
| `accounting-ecosystem/backend/server.js` | Fixed POS `req.url` mutation; removed `/inventory-test` debug route |
| `accounting-ecosystem/backend/modules/inventory/routes/stock-helpers.js` | **NEW** — `adjustStock()` helper replacing broken Supabase RPC |
| `accounting-ecosystem/backend/modules/inventory/index.js` | Import `adjustStock`; fix column names in movements query; replace 2× RPC calls with `adjustStock`; add fallback in movement history builder |
| `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js` | Import `adjustStock`; replace 2× RPC calls (`complete`, `issue-materials`) with `adjustStock` |
| `inventory-demo-1month/02_demo_testing_report.md` | Fully updated with real PASS evidence from live test run |
| `inventory-demo-1month/05_client_demo_script.md` | Full client-facing demo walkthrough script |
| `inventory-demo-1month/06_remaining_after_demo.md` | Phase 2 hardening requirements and safe limitations |
| `inventory-demo-1month/SESSION_HANDOFF_inventory_demo_1month.md` | This file — updated to reflect final session state |

---

## Deployment State

- Server runs locally: `node backend/server.js` from `accounting-ecosystem/backend/`
- Hosted on Zeabur (production). Zeabur rules: see `CLAUDE.md` Part C. Do not add `zbpack.json`.
- No new migrations required for this demo session.
- No new environment variables required.

---

## How to Run the Demo

1. Start the server:
   ```
   cd accounting-ecosystem/backend
   node server.js
   ```
2. Open browser: `http://localhost:3000/inventory`
3. Log in as `ruanvlog@lorenco.co.za`
4. Pre-load demo data if needed (see `05_client_demo_script.md` — "Before the Demo" section)
5. Follow the click-by-click walkthrough in `05_client_demo_script.md`

---

## What NOT to Change Before the Demo

| Do NOT touch | Reason |
|---|---|
| `backend/modules/inventory/routes/stock-helpers.js` | This is the fix for the broken RPC — changing it will break all stock movements |
| `backend/modules/inventory/index.js` (movement history section) | Fallback logic required while `stock_valuation_movements` is not populated |
| `backend/server.js` POS alias section | The `req.url` save/restore fix is required for inventory routes to work |
| `backend/modules/inventory/routes/work-orders.js` | RPC replacement is live — do not reintroduce the old RPC calls |
| Any Supabase migration that touches `stock_movements` columns | The `adjustStock` helper depends on `movement_type` and `unit_cost` column names |

---

## What Was Confirmed Working (do not regress)

- `GET /api/inventory/status` — module active
- `POST /api/inventory/items` — raw material and finished good creation, company-scoped
- `POST /api/inventory/quick-receive` — receives stock, updates average cost, inserts movement
- `GET /api/inventory/items/:id` — item detail with current_stock, average_cost, last_purchase_cost
- `GET /api/inventory/reports/stock-valuation` — full + filtered by item_type
- `POST /api/inventory/boms` + activate — BOM creation and activation
- `GET /api/inventory/boms/:id/cost-summary` — recipe cost and unit cost from live avg costs
- Work order full lifecycle: create → release → start → issue (with over-issue guard) → complete guard → complete
- `GET /api/inventory/items/:id/movements` — movement history with running totals
- `GET /api/inventory/items/:id` returns 404 for non-existent IDs (company isolation enforced)
- `/inventory` page loads HTTP 200
- No localStorage / sessionStorage business data anywhere

---

## Next Recommended Phase (after demo)

See `06_remaining_after_demo.md` for the full phase plan.

Priority order for Phase 2:

1. **Replace `adjustStock` with atomic DB transaction** — most important for data integrity
2. **Populate `stock_valuation_movements`** — enables full costing ledger and running avg cost in history
3. **Stock reservations** — prevents concurrent-user stock conflicts
4. **Role-based permissions** — `INVENTORY.RECEIVE`, `INVENTORY.ISSUE`, `INVENTORY.ADMIN`
5. **Confirm FIFO vs weighted-avg** — weighted avg is currently implemented; FIFO is a schema addition

