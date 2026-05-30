# Codebox 07 — Reporting Safety Audit

**Date:** 2026-05-29
**Module:** Storehouse Inventory — Reporting & Dashboard
**Auditor:** Codebox 07 implementation review

---

## 1. Scope

Pre-implementation audit of the reporting layer before frontend was written. Covers: backend routes, service layer, data scoping, browser storage, and no-calculation guarantees.

---

## 2. Files Audited

| File | Role |
|------|------|
| `backend/modules/inventory/services/reportingService.js` | Aggregates all report queries |
| `backend/modules/inventory/routes/reports.js`            | Thin HTTP layer, delegates to service |
| `backend/modules/inventory/services/reservationService.js` | `getShortageReport` source |
| `backend/modules/inventory/services/costingService.js`   | Stock valuation queries |
| `backend/modules/inventory/services/procurementService.js` | Suggestion generation |
| `backend/modules/inventory/services/productionService.js`  | Production summary |
| `frontend-inventory/index.html`                          | Frontend reporting UI |

---

## 3. Findings — Backend

### FINDING-01: `getShortageReport` undefined in reportingService.js — CRITICAL (FIXED)

**Before:** `module.exports` listed `getShortageReport` but no function with that name was defined in the file. In strict mode this would throw `ReferenceError: getShortageReport is not defined` at module load time, breaking the entire inventory module.

**Fix:** Added proxy function before exports:
```javascript
async function getShortageReport(supabase, companyId) {
  return reservationService.getShortageReport(supabase, companyId);
}
```

**Impact:** Without this fix, all inventory routes would 500 on load. Fix is minimal — delegates to the already-correct `reservationService.getShortageReport`.

### FINDING-02: All queries company-scoped — PASS

Every function in `reportingService.js` receives `companyId` as a parameter and passes it to every Supabase query as `.eq('company_id', companyId)`. No cross-tenant queries possible.

### FINDING-03: All queries read-only — PASS

All 17 report functions use only SELECT queries. No INSERT, UPDATE, or DELETE in any reporting function. Calling a report cannot modify financial data.

### FINDING-04: No recalculation from live data — PASS

Reports read pre-computed values:
- `average_cost`, `cost_price` from `inventory_items`
- Completed values from `payroll_snapshots`-equivalent production tables
- Totals from `stock_valuation_movements`

No report triggers a new cost calculation.

### FINDING-05: `req.companyId` used in all routes — PASS

All route handlers pass `req.companyId` to the service layer. No route accepts `company_id` from query string or body.

---

## 4. Findings — Frontend

### FINDING-06: No business data in localStorage — PASS

`localStorage.getItem('token')` (line 1250) is the only localStorage read in the entire file. This is the JWT auth token, permitted by Rule D2. No report data is stored in browser storage.

### FINDING-07: `esc()` applied to all server-sourced strings — PASS

All new report rendering functions use `esc(r.fieldName)` before inserting server-sourced string values into the DOM. Numeric values (`fmtR()`, `fmtQty()`) are inherently safe.

### FINDING-08: apiFetch is the only data source — PASS

All 12 report loading functions call `apiFetch()` to get data. No totals, counts, or values are computed from static frontend data.

---

## 5. Summary

| Finding | Severity | Status |
|---------|----------|--------|
| FINDING-01: getShortageReport undefined | Critical | **Fixed** |
| FINDING-02: Company scoping | — | Pass |
| FINDING-03: Read-only | — | Pass |
| FINDING-04: No recalculation | — | Pass |
| FINDING-05: req.companyId in routes | — | Pass |
| FINDING-06: No business data in browser storage | — | Pass |
| FINDING-07: esc() applied | — | Pass |
| FINDING-08: Backend-only data source | — | Pass |

**Result: 1 critical bug fixed. All safety requirements met.**
