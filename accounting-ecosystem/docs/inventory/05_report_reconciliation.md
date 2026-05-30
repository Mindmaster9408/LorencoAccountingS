# Codebox 07 — Report Reconciliation

**Date:** 2026-05-29
**Module:** Storehouse Inventory — Reporting & Dashboard

---

## Purpose

This document reconciles each frontend report panel against its backend service function, confirming that every field displayed in the UI has a corresponding server-side source. No frontend-computed totals.

---

## 1. Operational Dashboard

**Endpoint:** `GET /reports/operational-dashboard`
**Service:** `getOperationalDashboard()`

| Displayed value | Source field | Query |
|-----------------|-------------|-------|
| Active Items | `report.total_items` | `COUNT(inventory_items WHERE is_active=true)` |
| Total Stock Value | `report.total_stock_value` | Sum of `costingService.getStockValuation()` |
| Open Work Orders | `report.open_work_orders` | `COUNT(work_orders WHERE status IN ('released','in_progress'))` |
| POs Awaiting Receipt | `report.purchase_orders_awaiting_receipt` | `COUNT(purchase_orders WHERE status IN ('approved','ordered','partial_receipt'))` |
| Overdue POs | `report.overdue_purchase_orders` | `COUNT(purchase_orders WHERE expected_date < today AND status NOT terminal)` |
| Active Reservations | `report.active_reservations` | `COUNT(stock_reservations rows WHERE status IN ('active','partially_released'))` |
| Reserved Value | `report.total_reserved_value` | Net reserved qty × average_cost per item |
| Low Stock Items | `report.low_stock_count` | `COUNT(inventory_items WHERE current_stock <= min_stock)` |
| Shortage Items | `report.shortage_item_count` | Items where reserved > current_stock |
| Top Low-Stock table | `top_low_stock_items` | Sorted by (currentStock - minStock), top 5 |
| Top Shortage table | `top_shortage_items` | Sorted by shortage_qty desc, top 5 |

---

## 2. Alerts Panel

**Endpoint:** `GET /reports/alerts`
**Service:** `getAlertsPanel()`

All 4 alert lists are sliced to top 5 server-side. No client-side filtering.

---

## 3. Stock Valuation

**Endpoint:** `GET /reports/stock-valuation`
**Service:** `getStockValuationReport()` → `costingService.getStockValuation()`

| Displayed value | Source field |
|-----------------|-------------|
| Total Stock Value | `report.grand_total` = Σ `totalValue` |
| Items | `report.total_items` |
| Zero-Cost Items | `report.zero_cost_items` |
| Raw Material Value | `report.raw_material_value` |
| Finished Goods Value | `report.finished_goods_value` |
| Avg Cost per item | `items[].averageCost` = `average_cost || cost_price` |
| Total Value per item | `items[].totalValue` = `qty × unitCost` |

---

## 4. Reservation Report

**Endpoint:** `GET /reports/reservation-report`
**Service:** `getReservationReport()`

| Displayed value | Source field |
|-----------------|-------------|
| Summary counts | `report.active / partially_released / released / consumed` |
| Item name | `reservation.inventory_items.name` (joined) |
| Source type + ID | `r.source_type`, `r.source_id` |
| Quantities | `r.quantity_reserved / quantity_released / quantity_consumed` |

---

## 5. Purchase Orders

**Endpoint:** `GET /reports/purchase-order-report`
**Service:** `getPurchaseOrderReport()`

| Displayed value | Source field |
|-----------------|-------------|
| Total Orders | `report.total_purchase_orders` |
| Total Amount | `report.total_amount` = Σ `po.total_amount` |
| Overdue count | `report.overdue_count` |
| Total Received | `po.total_received_value` = Σ `purchase_receipts.total_value` for that PO |
| Is Overdue badge | `po.is_overdue` = `expected_date < now && status not terminal` |

---

## 6. Wastage Log

**Endpoint:** `GET /reports/wastage`
**Service:** `getWastageReport()`

| Displayed value | Source field |
|-----------------|-------------|
| Total Qty | `report.total_qty` = Σ `wastage_qty` |
| Total Value | `report.total_value` = Σ `estimated_value` |
| By Reason | `by_reason[]` = grouped by `wastage_reason` |
| Item name | `r.inventory_items.name` (joined) |
| Batch / WO | `r.production_batches.batch_number / work_orders.wo_number` (joined) |

---

## 7. Yield Variance

**Endpoint:** `GET /reports/yield-variance`
**Service:** `getYieldVarianceReport()`

| Displayed value | Source field |
|-----------------|-------------|
| Avg Yield % | `report.average_yield` = mean of `batch.yield_percent` |
| Over/Under count | `report.over_yield_count / under_yield_count` |
| Total Variance Value | `report.total_variance_value` = Σ `variance.variance_value` |
| Batch Yield % | `batch.yield_percent` from `production_batches` |
| Variance direction | `variance.variance_direction` from `production_variances` |

---

## Reconciliation Status

All displayed values trace directly to backend-computed fields. No frontend math. All currency values formatted via `fmtR()`. All quantity values via `fmtQty()`. All string fields escaped via `esc()`.
