# Codebox 07 — Dashboard & Reports User Guide

**Date:** 2026-05-29
**Module:** Lorenco Storehouse — Reports & Dashboard

---

## How to Access Reports

1. Open Lorenco Storehouse (📦 icon in ECO Hub)
2. Click the **📊 Reports** tab in the navigation bar
3. The **Operational Dashboard** loads automatically

---

## Report Selector

Use the dropdown at the top right to switch between reports:

### Dashboard Group
| Report | Description |
|--------|-------------|
| 🗂 Operational Dashboard | High-level snapshot: stock value, WOs, POs, reservations, shortages |
| ⚠ Alerts Panel | 4-panel alert view: low stock, overdue POs, shortages, under-yield batches |

### Stock Group
| Report | Description |
|--------|-------------|
| Stock Valuation | Current qty × average cost per item. Filterable by type, low-stock, missing-cost |
| Valuation Movements | Forensic cost ledger: every cost-impacting movement in a date range |
| Shortages | Items where net reserved quantity exceeds on-hand stock |
| Overcommitted Items | Same as shortages, filtered to items with confirmed shortage qty > 0 |

### Reservations Group
| Report | Description |
|--------|-------------|
| Reservation Report | All reservations with status breakdown. Filter by status or source |

### Procurement Group
| Report | Description |
|--------|-------------|
| Purchase Orders | All POs with receipt totals. Filter by status and/or date range |
| Overdue POs | POs past their expected delivery date |
| Supplier History | Per-item supplier purchase history with lead times |
| Procurement Suggestions | AI-generated reorder and shortage recommendations |

### Production Group
| Report | Description |
|--------|-------------|
| Production Summary | Today's/month's batch counts, active WOs, wastage totals |
| Wastage Log | All wastage records with reason breakdown. Filterable by date range |
| Yield Variance | Batch yield percentages and variance records. Filter by date and direction |
| Work Order Costs | Material, labor, and overhead cost per WO |

---

## Filter Bars

Filters appear automatically for reports that need them:

| Filter | Appears for |
|--------|-------------|
| Date range (From / To) | Valuation Movements, WO Costs, Purchase Orders, Wastage, Yield Variance |
| Item Type / Low Stock / Missing Cost | Stock Valuation |
| PO Status | Purchase Orders |
| Reservation Status + Source | Reservation Report |
| Yield Direction | Yield Variance |

---

## Reading the Summary Bar

Every report shows a summary bar at the top with key metrics. These are computed on the server — they reflect the current state of your database.

- **Currency values** are in South African Rand (R)
- **Red values** indicate issues requiring attention
- **Green values** indicate healthy state
- **Gold/Yellow** indicates caution or pending items

---

## Refreshing Data

- Click **↺ Refresh** or **Generate** to reload the current report
- Data is not cached in the browser — each click hits the server
- Reports reflect the database state at time of generation

---

## Notes for Accountants and Managers

- **Operational Dashboard** is the recommended starting point each morning
- **Alerts Panel** surfaces the 5 highest-priority items in each alert category
- **Stock Valuation** shows items with missing cost (zero-cost items in red) — these should be investigated
- **Procurement Suggestions** merges reorder-point triggers and shortage triggers into one actionable list
- **Yield Variance** batches highlighted in red have yield < 98% — investigate for quality or process issues
