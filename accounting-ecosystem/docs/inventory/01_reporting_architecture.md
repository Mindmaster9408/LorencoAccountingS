# Codebox 07 — Reporting Architecture

**Date:** 2026-05-29
**Module:** Storehouse Inventory — Reporting & Dashboard

---

## 1. Overview

The reporting layer is a read-only, company-scoped aggregation system on top of the existing inventory tables. It does not recalculate, does not write, and does not store report data in the browser.

---

## 2. Layer Diagram

```
Browser (frontend-inventory/index.html)
  └── apiFetch('/api/inventory/reports/<endpoint>')
        └── JWT auth (Bearer token from localStorage — permitted)
              └── authenticateToken → requireCompany → req.companyId

Backend (backend/modules/inventory/routes/reports.js)
  └── Thin route handler: validates req.companyId, delegates to service

Service (backend/modules/inventory/services/reportingService.js)
  ├── costingService.getStockValuation()         — stock value per item
  ├── reservationService.getShortageReport()     — shortage/overcommit
  ├── procurementService.generate*()             — reorder/shortage recs
  └── productionService.getProductionSummary()   — batch/wastage stats

Database (Supabase PostgreSQL)
  All queries use .eq('company_id', companyId) — no cross-tenant possible
```

---

## 3. Report Endpoints

| Endpoint | Service Function | Notes |
|----------|-----------------|-------|
| `GET /reports/operational-dashboard` | `getOperationalDashboard` | 8 parallel queries, top 5 alerts |
| `GET /reports/stock-valuation` | `getStockValuationReport` | Filterable by type/low_stock/missing_cost |
| `GET /reports/valuation-movements` | `getValuationMovements` | Requires from/to dates |
| `GET /reports/work-order-cost-summary` | `getWorkOrderCostSummary` | Material/labor/overhead breakdown |
| `GET /reports/stock-counts` | `getStockCountSessionsReport` | Session-level count report |
| `GET /reports/variance-summary` | `getVarianceSummaryReport` | By reason and item type |
| `GET /reports/reservation-report` | `getReservationReport` | Filterable by status/source |
| `GET /reports/shortages` | `getShortageReport` | Proxy → reservationService |
| `GET /reports/overcommitted` | `getOvercommittedReport` | Filters has_shortage=true |
| `GET /reports/purchase-order-report` | `getPurchaseOrderReport` | With receipt totals joined |
| `GET /reports/overdue-purchase-orders` | `getOverduePurchaseOrdersReport` | expected_date < today |
| `GET /reports/supplier-history` | `getSupplierHistoryReport` | supplier_item_history table |
| `GET /reports/procurement-suggestions` | `getProcurementSuggestionsReport` | Merged reorder + shortage recs |
| `GET /reports/production-summary` | `getProductionSummaryReport` | Summary counts only |
| `GET /reports/wastage` | `getWastageReport` | With by_reason breakdown |
| `GET /reports/yield-variance` | `getYieldVarianceReport` | Batches + variance records |
| `GET /reports/alerts` | `getAlertsPanel` | 4 alert categories, top 5 each |

---

## 4. Frontend Report UI

The Reports tab (`tab-reports`) uses a dropdown selector pattern:

- **Dropdown (`reportType`)**: Grouped into Dashboard / Stock / Reservations / Procurement / Production
- **Filter bars**: Conditionally visible per report type
  - `reportDateBar`: date range (valuation-movements, work-order-costs, purchase-orders, wastage, yield-variance)
  - `reportFilterBar`: item type/low-stock/missing-cost (stock-valuation)
  - `reportPoFilterBar`: PO status (purchase-orders)
  - `reportResvFilterBar`: reservation status/source (reservations)
  - `reportYieldFilterBar`: yield direction (yield-variance)
- **`reportSummary`**: Summary stat bar, shown after data loads
- **`reportContainer`**: Table or dashboard grid output

Auto-load on tab switch: the `switchTab('reports')` handler calls `onReportTypeChange()` + `loadSelectedReport()`, so the Operational Dashboard loads automatically on first open.

---

## 5. Data Flow — No Frontend Computation

The frontend:
1. Calls an API endpoint with filters
2. Receives a JSON response with `report` (summary) and `items`/`rows` (detail)
3. Renders the data directly — no totals, no averages computed in the browser
4. `escHtml` (`esc()`) applied to all server-sourced strings before DOM insertion

The backend:
1. All aggregation (sums, counts, averages) computed in the service layer
2. All queries company-scoped via `.eq('company_id', companyId)`
3. No recalculation from raw sales or production data — reads pre-computed values

---

## 6. Security Properties

| Property | Implementation |
|----------|----------------|
| Multi-tenant isolation | `req.companyId` from JWT, passed to every query |
| XSS prevention | `esc()` applied to all server-sourced strings |
| No business data in browser storage | Only `localStorage.getItem('token')` (auth token) |
| Read-only guarantee | No INSERT/UPDATE/DELETE in any report function |
| Auth required | All `/reports/*` routes require `authenticateToken` + `requireCompany` |
